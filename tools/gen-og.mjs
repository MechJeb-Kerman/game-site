#!/usr/bin/env node
/**
 * 离线预生成 OG 位图：public/og/*.png + public/og/manifest.json。
 *
 * 用法：
 *   node tools/gen-og.mjs                    按数据源现状生成（已有的文件会被覆盖）
 *   node tools/gen-og.mjs --check            只核对清单与磁盘是否一致，什么都不写
 *   node tools/gen-og.mjs --limit 5          每个来源最多 5 条（--limit replay=5 --limit daily=3 也行）
 *   node tools/gen-og.mjs --kinds replay,daily
 *   node tools/gen-og.mjs --dry-run          只列目标，不渲染不写盘
 *   node tools/gen-og.mjs --browser <路径>    只用这个浏览器，不猜候选表（便于确定性地测 SKIP）
 *   node tools/gen-og.mjs --quiet / --help
 *
 * 退出码（照 tools/gen-precache.mjs 的口径，多一个 3）：
 *   0  生成成功（或 --check 一致）
 *   1  --check 发现差异；或生成时有目标没出来（其余照常落盘）
 *   2  用法错误（认不出的参数 / --limit 非法），或清单结构坏了（不是 JSON / 不是对象 / 读不了）
 *   3  没有无头浏览器：SKIP，什么都没写，也不假装成功
 *
 * 数据源（都要读库，所以是懒加载的；只 import 本文件的纯函数不会碰库）：
 *   棋谱  src/play-store.js 的 replayList() 取最近 N 条，再逐条 replay(id) 拿 moves
 *   每日  src/social.js 的 dailySlug(day) + src/daily.js 的 dayKey/shiftDay，最近 N 天
 *   榜单  src/play-store.js 的 ratingBoard() 六款裁判棋的天梯，合并去重后取前 N 名玩家
 *
 * 刻意的取舍：
 *   - 每日卡用**游客视角**（stats 传 null）：OG 图本来就是给爬虫和未登录访客看的；
 *   - 来源指纹 revision 只取那份 SVG 的哈希，所以卡片模板或棋谱没变时重跑不会改动文件；
 *   - 渲染失败不会删掉旧图（旧图还在，只是这轮没进清单，--check 会报出来，下次补上）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createRasterizer, ogPregenKey, ogFileName, buildOgManifest, diffOgManifest,
  readOgManifest, warmOgPregen, OG_MANIFEST_NAME, OG_WIDTH, OG_HEIGHT
} from '../src/og.js';
import { browserEntries } from './og-detect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OG_DIR = path.join(PUBLIC_DIR, 'og');
const MANIFEST_FILE = path.join(OG_DIR, OG_MANIFEST_NAME);

export const KINDS = ['replay', 'daily', 'profile'];
export const DEFAULT_LIMITS = { replay: 24, daily: 7, profile: 12 };
export const MAX_LIMIT = 200;
export const EXIT = Object.freeze({ OK: 0, DIFF: 1, USAGE: 2, NO_BROWSER: 3 });
// 只清理自己产出的那三类文件，别的一律不碰（public/og 里放别的东西是别人的自由）
const ORPHAN_RE = /^(replay|daily|profile)-.*\.png$/;
const USAGE = [
  '用法：node tools/gen-og.mjs [--check] [--limit N] [--kinds replay,daily,profile]',
  '                         [--browser <路径>] [--dry-run] [--quiet] [--help]',
  '',
  '  --check         只核对 public/og/manifest.json 与磁盘是否一致（不写任何文件）',
  '  --limit N       每个来源最多 N 条；也可 --limit replay=5（可重复，多个种类分开给）',
  '  --kinds a,b     只生成这几类（replay / daily / profile，默认全要）',
  '  --browser <路径> 只用这个浏览器，不猜候选表',
  '  --dry-run       只列目标，不渲染不写盘',
  '  --quiet         少打点',
  '  --help          看这段',
  '',
  '退出码：0 成功/一致 · 1 --check 有差异或有个别失败 · 2 用法或清单结构错误 · 3 没有无头浏览器'
].join('\n');

/* ============================== 小工具 ============================== */

function errText(err) {
  if (!err) return '';
  return String((err && err.message) || err);
}

export function shortHash(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

// 来源指纹：同一份 SVG 永远同一个 revision，--check 靠它发现「源变了，该重新生成」。
export function svgRevision(svg) {
  return 'svg:' + shortHash(svg);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function kbytes(n) {
  return (Number(n || 0) / 1024).toFixed(1) + ' KB';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 目录里的 *.png（非递归，按名排序）；目录不存在回空数组。
export function listPngs(dir) {
  let rows = [];
  try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return []; }
  return rows.filter(function (d) { return d.isFile() && d.name.endsWith('.png'); })
    .map(function (d) { return d.name; })
    .sort();
}

// 目录现状：文件名数组 + { 文件名: 字节数 }（readdir 有空位就当文件不在）。
export function readDisk(dir) {
  const files = listPngs(dir);
  const sizes = {};
  for (let i = 0; i < files.length; i++) {
    try { sizes[files[i]] = fs.statSync(path.join(dir, files[i])).size; }
    catch (err) { /* 读不到就当它不在 */ }
  }
  return { files: files, sizes: sizes };
}

// 清掉清单外、而且是本工具产出的那三类 png；返回被删的文件名数组。
export function removeOrphans(dir, keep) {
  const kept = keep instanceof Set ? keep : new Set(keep || []);
  const removed = [];
  const files = listPngs(dir);
  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    if (!ORPHAN_RE.test(name) || kept.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed.push(name); }
    catch (err) { /* 删不掉就算了，不该因此让整轮失败 */ }
  }
  return removed;
}

/* ============================== 参数 ============================== */

export function usage() {
  return USAGE;
}

function clampLimit(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, MAX_LIMIT);
}

function applyLimit(out, raw) {
  const errs = [];
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const eq = text.indexOf('=');
  if (eq >= 0) {
    const kind = text.slice(0, eq).trim().toLowerCase();
    const num = text.slice(eq + 1).trim();
    if (KINDS.indexOf(kind) < 0) {
      errs.push('--limit 的种类认不出：' + kind + '（只能是 ' + KINDS.join(' / ') + '）');
      return errs;
    }
    if (!/^\d+$/.test(num)) {
      errs.push('--limit ' + text + ' 的数量不对（要 0..' + MAX_LIMIT + ' 的整数）');
      return errs;
    }
    out[kind] = clampLimit(num);
    return errs;
  }
  if (!/^\d+$/.test(text)) {
    errs.push('--limit ' + text + ' 不对（要 0..' + MAX_LIMIT + ' 的整数，或 replay=5 这种写法）');
    return errs;
  }
  for (let i = 0; i < KINDS.length; i++) out[KINDS[i]] = clampLimit(text);
  return errs;
}

function applyKinds(out, raw) {
  const parts = String(raw === undefined || raw === null ? '' : raw)
    .split(',').map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return !!s; });
  if (!parts.length) return ['--kinds 至少要给一个种类（' + KINDS.join(' / ') + '）'];
  const bad = parts.filter(function (k) { return KINDS.indexOf(k) < 0; });
  if (bad.length) return ['--kinds 里有认不出的种类：' + bad.join(', ') + '（只能是 ' + KINDS.join(' / ') + '）'];
  out.length = 0;
  for (let i = 0; i < parts.length; i++) if (out.indexOf(parts[i]) < 0) out.push(parts[i]);
  return [];
}

/**
 * 解析命令行。回 { check, quiet, help, dryRun, limit:{kind:number}, kinds:[...], browser, errors:[...] }。
 * 有问题只记进 errors（不 throw），由 main 统一打用法并回 2。
 */
export function parseArgs(argv) {
  const out = {
    check: false, quiet: false, help: false, dryRun: false,
    limit: {}, kinds: KINDS.slice(), browser: '', errors: []
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a === '--check') out.check = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '--dryRun') out.dryRun = true;
    else if (a === '--browser') {
      const v = list[i + 1];
      if (v === undefined || String(v).startsWith('--')) out.errors.push('--browser 后面要跟浏览器路径');
      else { out.browser = String(v); i++; }
    } else if (a.indexOf('--browser=') === 0) {
      const v = a.slice('--browser='.length).trim();
      if (!v) out.errors.push('--browser= 后面要跟浏览器路径'); else out.browser = v;
    } else if (a === '--limit') {
      const v = list[i + 1];
      if (v === undefined || String(v).startsWith('--')) out.errors.push('--limit 后面要跟数量');
      else { out.errors.push.apply(out.errors, applyLimit(out.limit, v)); i++; }
    } else if (a.indexOf('--limit=') === 0) {
      out.errors.push.apply(out.errors, applyLimit(out.limit, a.slice('--limit='.length)));
    } else if (a === '--kinds') {
      const v = list[i + 1];
      if (v === undefined || String(v).startsWith('--')) out.errors.push('--kinds 后面要跟种类');
      else { out.errors.push.apply(out.errors, applyKinds(out.kinds, v)); i++; }
    } else if (a.indexOf('--kinds=') === 0) {
      out.errors.push.apply(out.errors, applyKinds(out.kinds, a.slice('--kinds='.length)));
    } else {
      out.errors.push('认不出的参数：' + a);
    }
  }
  return out;
}

/** ============================ 数据源 ============================ */

// 真数据源：都在这里动态 import —— 这几个模块 import 时就会打开 data/games.db，
// 所以只有真正要连库的路径才会碰它们（纯函数测试 import 本文件不会建库 / 开库）。
export async function loadDeps() {
  const mods = await Promise.all([
    import('../src/play-store.js'),
    import('../src/social.js'),
    import('../src/data.js'),
    import('../src/cards.js'),
    import('../src/daily.js'),
    import('../src/elo.js'),
    import('../src/rules/index.js'),
    import('../src/db.js')
  ]);
  const play = mods[0], social = mods[1], data = mods[2], cards = mods[3];
  const daily = mods[4], elo = mods[5], rules = mods[6], dbmod = mods[7];
  return {
    replayList: function (n) { return play.replayList({ limit: n, maxLimit: Math.max(50, n) }); },
    replay: function (id) { return play.replay(id); },
    getGame: function (slug) { return data.getGame(slug); },
    profileByName: function (name) { return social.profileByName(name); },
    profileOf: function (id) { return social.profileOf(id); },
    ratingBoard: function (slug, season, n) { return play.ratingBoard(dbmod.db, slug, season, n); },
    seasonOf: function (ts) { return elo.seasonOf(ts); },
    dailySlug: function (day) { return social.dailySlug(day) || ''; },
    dayKey: function (now) { return daily.dayKey(now); },
    shiftDay: function (day, n) { return daily.shiftDay(day, n); },
    slugs: rules.SLUGS,
    cards: { replay: cards.replayCardSvg, profile: cards.profileCardSvg, daily: cards.dailyCardSvg }
  };
}

function normalizeKinds(kinds) {
  const list = Array.isArray(kinds) ? kinds : (kinds ? String(kinds).split(',') : KINDS);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const k = String(list[i]).trim().toLowerCase();
    if (KINDS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  }
  return out.length ? out : KINDS.slice();
}

function normalizeLimits(limit) {
  const out = { replay: DEFAULT_LIMITS.replay, daily: DEFAULT_LIMITS.daily, profile: DEFAULT_LIMITS.profile };
  if (typeof limit === 'number') {
    for (let i = 0; i < KINDS.length; i++) out[KINDS[i]] = clampLimit(limit);
  } else if (limit && typeof limit === 'object') {
    for (let i = 0; i < KINDS.length; i++) {
      const k = KINDS[i];
      if (limit[k] !== undefined) out[k] = clampLimit(limit[k]);
    }
  }
  return out;
}

/**
 * 收集「该有哪些预生成图」（纯读，不写盘、不渲染）。
 *
 * opts: { limit（数字或 {kind:数字}）、kinds、now、origin、width、height、deps }
 *   deps 不给就用 loadDeps()（会开库）；测试可以塞一份假 deps，形状见 loadDeps() 的返回。
 * 回 { entries, skipped, counts, limits, kinds, now, width, height }
 *   entries: [{ kind, id, key, file, revision, svg, source, width, height }]
 *   skipped: [{ kind, id, reason }]   reason = replay_gone / game_missing / profile_missing / no_svg
 * 注意 getGame() 回 null 的棋谱会跳过：cards.js 的三张卡都直接取 g.accent，g 为 null 会抛。
 */
export async function collectTargets(opts) {
  const o = opts || {};
  const kinds = normalizeKinds(o.kinds);
  const limits = normalizeLimits(o.limit);
  const width = o.width || OG_WIDTH;
  const height = o.height || OG_HEIGHT;
  const origin = o.origin || '';
  const now = o.now === undefined ? Date.now() : o.now;
  const deps = o.deps || await loadDeps();
  const entries = [];
  const skipped = [];

  function push(kind, id, svg, source) {
    if (!svg) { skipped.push({ kind: kind, id: String(id), reason: 'no_svg' }); return; }
    entries.push({
      kind: kind, id: String(id), key: ogPregenKey(kind, id), file: ogFileName(kind, id),
      revision: svgRevision(svg), svg: svg, source: source, width: width, height: height
    });
  }

  if (kinds.indexOf('replay') >= 0 && limits.replay > 0) {
    const list = await deps.replayList(limits.replay);
    const items = (list && list.items) || [];
    for (let i = 0; i < items.length; i++) {
      const row = items[i] || {};
      const id = row.id;
      const full = await deps.replay(id);
      if (!full) { skipped.push({ kind: 'replay', id: String(id), reason: 'replay_gone' }); continue; }
      const game = deps.getGame(full.game);
      if (!game) { skipped.push({ kind: 'replay', id: String(id), reason: 'game_missing' }); continue; }
      push('replay', id, deps.cards.replay({ replay: full, game: game, origin: origin, width: width, height: height }), 'replay:' + id);
    }
  }

  if (kinds.indexOf('daily') >= 0 && limits.daily > 0) {
    const today = deps.dayKey(now);
    for (let i = 0; i < limits.daily; i++) {
      const day = i === 0 ? today : deps.shiftDay(today, -i);
      const slug = deps.dailySlug(day);
      const game = slug ? deps.getGame(slug) : null;
      if (!game) { skipped.push({ kind: 'daily', id: String(day), reason: 'game_missing' }); continue; }
      // 游客视角：stats 传 null（OG 图给爬虫和未登录访客看，不该带上某个人的打卡统计）
      push('daily', day, deps.cards.daily({ day: day, game: game, stats: null, origin: origin, width: width, height: height }), 'daily:' + day);
    }
  }

  if (kinds.indexOf('profile') >= 0 && limits.profile > 0) {
    const season = deps.seasonOf(now);
    const rows = [];
    const slugs = deps.slugs || [];
    for (let i = 0; i < slugs.length; i++) {
      const board = await deps.ratingBoard(slugs[i], season, limits.profile);
      const items = (board && board.items) || [];
      for (let j = 0; j < items.length; j++) rows.push({ slug: slugs[i], row: items[j] || {} });
    }
    rows.sort(function (a, b) { return (Number(b.row.rating) || 0) - (Number(a.row.rating) || 0); });
    const seen = new Set();
    let taken = 0;
    for (let i = 0; i < rows.length && taken < limits.profile; i++) {
      const row = rows[i].row;
      const name = String(row.username || '');
      const dedupe = name.toLowerCase() || String(row.userId || '');
      if (!dedupe || seen.has(dedupe)) continue;
      seen.add(dedupe);
      let profile = name ? deps.profileByName(name) : null;
      if (!profile && /^\d+$/.test(String(row.userId || ''))) profile = deps.profileOf(Number(row.userId));
      if (!profile) { skipped.push({ kind: 'profile', id: name || String(row.userId || ''), reason: 'profile_missing' }); continue; }
      const id = String(profile.username || name || row.userId || '');
      push('profile', id, deps.cards.profile({ profile: profile, origin: origin, width: width, height: height }),
        'ladder:' + rows[i].slug + '#' + (row.rank || i + 1));
      taken++;
    }
  }

  const counts = { replay: 0, daily: 0, profile: 0 };
  for (let i = 0; i < entries.length; i++) counts[entries[i].kind] = (counts[entries[i].kind] || 0) + 1;
  return { entries: entries, skipped: skipped, counts: counts, limits: limits, kinds: kinds, now: now, width: width, height: height };
}

/* ============================ 生成 / 核对 ============================ */

function stripSvg(entry) {
  return {
    kind: entry.kind, id: entry.id, key: entry.key, file: entry.file,
    revision: entry.revision, source: entry.source, width: entry.width, height: entry.height
  };
}

function makeRenderer(opts) {
  if (typeof opts.renderPng === 'function') return { png: opts.renderPng, browser: 'injected' };
  const rz = opts.rasterizer || createRasterizer({
    driver: 'chrome',
    chromePath: opts.browser || undefined,
    browserCandidates: opts.browser ? [] : undefined,
    pregen: false
  });
  return { png: function (req) { return rz.png(req); }, browserPath: function () { return rz.browserPath(); }, rasterizer: rz };
}

/**
 * 生成一轮。什么都不 throw（除 fs 真写不进去，那也该由调用方看见）。
 *
 * opts: { limit, kinds, now, origin, width, height, deps, dir,
 *         renderPng（注入的渲染函数，测试用）、rasterizer、browser（只用这个浏览器）、
 *         dryRun、removeOrphans（默认 true）、force }
 * 回 { exitCode, rendered, failed, skipped, removed, wroteManifest, changedManifest, entries,
 *      failures, skippedList, skipReason, browser, dir, manifest, verify, counts }
 *   exitCode 2 = 数据源读不了（skipReason='source_error'，一个文件都没写）；
 *   exitCode 3 = 没有无头浏览器（一个文件都没写）；skipReason = 'no_browser' | 'no_targets' | 'source_error'
 */
export async function generate(opts) {
  const o = opts || {};
  const dir = o.dir || OG_DIR;
  let target = null;
  try { target = await collectTargets(o); }
  catch (err) {
    // 库读不了（还没建表 / 打不开）：回 USAGE，而不是把 SQLite 的原始报错甩给用户
    return {
      exitCode: EXIT.USAGE, rendered: 0, failed: 0, skipped: 0, removed: [], wroteManifest: false,
      changedManifest: false, entries: [], failures: [], skippedList: [], skipReason: 'source_error',
      sourceError: errText(err), browser: '', dir: dir, manifest: null, verify: null, counts: null
    };
  }
  const entries = target.entries;
  const result = {
    exitCode: EXIT.OK, rendered: 0, failed: 0, skipped: target.skipped.length,
    removed: [], wroteManifest: false, changedManifest: false, entries: [], failures: [],
    skippedList: target.skipped, skipReason: '', browser: '', dir: dir, manifest: null,
    verify: null, counts: target.counts
  };
  if (o.dryRun) {
    result.entries = entries.map(stripSvg);
    return result;
  }
  if (!entries.length && !o.force) {
    // 源里一条都没有（库是空的？）：不写空清单 —— 空清单会让 --check 把「暂时没数据」误判成一致
    result.skipReason = 'no_targets';
    return result;
  }

  const renderer = makeRenderer(o);
  if (renderer.browserPath) {
    const bin = await renderer.browserPath();
    if (!bin) {
      result.exitCode = EXIT.NO_BROWSER;
      result.skipReason = 'no_browser';
      return result;
    }
    result.browser = bin;
  }

  ensureDir(dir);
  const at = new Date(o.now === undefined ? Date.now() : o.now).toISOString();
  const written = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let r = null;
    try { r = await renderer.png({ kind: e.kind, key: e.id, svg: e.svg, width: e.width, height: e.height }); }
    catch (err) { r = { ok: false, error: 'threw:' + errText(err) }; }
    if (!r || !r.ok) {
      result.failed++;
      result.failures.push({ key: e.key, file: e.file, error: String((r && r.error) || 'unknown') });
      continue;
    }
    const bytes = Buffer.from(r.bytes);
    try { fs.writeFileSync(path.join(dir, e.file), bytes); }
    catch (err) {
      result.failed++;
      result.failures.push({ key: e.key, file: e.file, error: 'write_failed:' + errText(err) });
      continue;
    }
    written.push({
      key: e.key, kind: e.kind, id: e.id, file: e.file, bytes: bytes.length,
      width: r.pngWidth || e.width, height: r.pngHeight || e.height,
      revision: e.revision, source: e.source, generatedAt: at
    });
    result.rendered++;
  }

  // 一张都没出来、而且都说没浏览器 —— 当 SKIP，别留下半份清单
  if (result.rendered === 0 && result.failures.length === entries.length && entries.length > 0) {
    const allNoBrowser = result.failures.every(function (f) {
      return f.error === 'no_browser' || f.error === 'not_configured';
    });
    if (allNoBrowser) {
      result.exitCode = EXIT.NO_BROWSER;
      result.skipReason = 'no_browser';
      return result;
    }
  }

  const manifest = buildOgManifest(written, { generatedAt: at, dir: rel(dir), width: target.width, height: target.height });
  const manifestFile = path.join(dir, OG_MANIFEST_NAME);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  let before = '';
  try { before = fs.readFileSync(manifestFile, 'utf8'); } catch (err) { before = ''; }
  if (before !== text) {
    fs.writeFileSync(manifestFile, text);
    result.changedManifest = true;
  }
  result.wroteManifest = true;
  result.manifest = manifest;

  // 写完自检一遍：读回来验 PNG 魔数与清单尺寸（warmOgPregen 是只读的）
  const verify = await warmOgPregen({ dir: dir, fs: fs, path: path });
  result.verify = { total: verify.total, ok: verify.ok, failed: verify.failed, error: verify.error || '' };

  if (o.removeOrphans !== false) {
    const keep = new Set();
    for (let i = 0; i < entries.length; i++) keep.add(entries[i].file);
    result.removed = removeOrphans(dir, keep);
  }
  if (result.failed > 0 || verify.failed > 0) result.exitCode = EXIT.DIFF;
  result.entries = written;
  return result;
}

/**
 * --check：把「现在应该有的」（collectTargets）与清单 + 磁盘三方比一遍，什么都不写。
 * 回 { exitCode, problems, manifestFile, manifest, fresh, disk, report }
 *   exitCode 0 = 一致；1 = 有差异（含清单不存在）；2 = 清单结构坏了 / 目标都收集不了
 */
export async function checkOgPregen(opts) {
  const o = opts || {};
  const dir = o.dir || OG_DIR;
  const info = await readOgManifest({ dir: dir, fs: fs, path: path });
  if (!info.ok) {
    if (info.error === 'no_manifest') {
      return {
        exitCode: EXIT.DIFF, manifestFile: info.file, manifest: null, fresh: null, disk: null,
        problems: ['清单不存在（还没生成过）：' + rel(info.file)]
      };
    }
    return {
      exitCode: EXIT.USAGE, manifestFile: info.file, manifest: null, fresh: null, disk: null,
      problems: ['清单读不了（' + info.error + '）：' + rel(info.file) + (info.detail ? ' —— ' + info.detail : '')]
    };
  }
  let target = null;
  try { target = await collectTargets(o); }
  catch (err) {
    return {
      exitCode: EXIT.USAGE, manifestFile: info.file, manifest: info.manifest, fresh: null, disk: null,
      problems: ['收集目标失败（库读不了？）：' + errText(err)]
    };
  }
  const disk = readDisk(dir);
  const problems = diffOgManifest(info.manifest, target.entries, { disk: disk.sizes, files: disk.files });
  return {
    exitCode: problems.length ? EXIT.DIFF : EXIT.OK,
    problems: problems, manifestFile: info.file, manifest: info.manifest,
    fresh: target, disk: disk, report: target.skipped
  };
}

function printSummary(manifest, write) {
  if (!manifest) return;
  const counts = { replay: 0, daily: 0, profile: 0 };
  let max = 0, maxFile = '';
  for (let i = 0; i < manifest.entries.length; i++) {
    const e = manifest.entries[i];
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    if (e.bytes > max) { max = e.bytes; maxFile = e.file; }
  }
  write('  版本：' + manifest.version);
  write('  条目：' + manifest.count + '（replay ' + (counts.replay || 0) + ' / daily ' + (counts.daily || 0) + ' / profile ' + (counts.profile || 0) + '）');
  write('  体积：' + kbytes(manifest.bytes) + '（' + manifest.count + ' 个文件）· 最大单文件 ' + kbytes(max) + (maxFile ? '（' + maxFile + '）' : ''));
  write('  指纹：' + manifest.fingerprint);
  const top = manifest.entries.slice().sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 5);
  if (top.length) {
    write('  最大的 5 个：');
    for (let i = 0; i < top.length; i++) write('    ' + kbytes(top[i].bytes).padStart(9) + '  ' + top[i].file);
  }
}

function printSkips(skipped, write) {
  if (!skipped || !skipped.length) return;
  const byReason = new Map();
  for (let i = 0; i < skipped.length; i++) {
    const s = skipped[i];
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason).push(s.kind + ':' + s.id);
  }
  write('  跳过的 ' + skipped.length + ' 条：');
  for (const pair of byReason) {
    const list = pair[1];
    const head = list.slice(0, 3).join('、');
    write('    · ' + pair[0] + ' × ' + list.length + '（' + head + (list.length > 3 ? ' …' : '') + '）');
  }
}

function printBrowserHint(write) {
  let entries = [];
  try { entries = browserEntries(); } catch (err) { entries = []; }
  write('  探测过的路径（tools/og-detect.mjs 可以打印全部候选）：');
  for (let i = 0; i < entries.length && i < 6; i++) {
    write('    · [' + (entries[i].exists ? '有' : '没') + '] ' + entries[i].path + '（' + entries[i].source + '）');
  }
  write('  修法：装 Chrome / Edge，或 node tools/gen-og.mjs --browser "<可执行文件的绝对路径>"；');
  write('        想先看看会生成哪些目标，可以加 --dry-run（不碰浏览器）。');
}

/**
 * CLI 入口：回退出码（0/1/2/3）。给 opts 可以注入 deps / renderPng / dir / now / log（测试用）。
 */
export async function main(argv, opts) {
  const o = opts || {};
  const args = parseArgs(argv === undefined ? process.argv.slice(2) : argv);
  const write = typeof o.log === 'function' ? o.log : function (line) { console.log(line); };
  const writeErr = typeof o.logError === 'function' ? o.logError : function (line) { console.error(line); };
  const quiet = args.quiet || !!o.quiet;

  if (args.help) { write(usage()); return EXIT.OK; }
  if (args.errors.length) {
    writeErr('✗ 参数不对：');
    for (let i = 0; i < args.errors.length; i++) writeErr('  · ' + args.errors[i]);
    writeErr(usage());
    return EXIT.USAGE;
  }

  const common = {
    limit: args.limit, kinds: args.kinds, dir: o.dir || OG_DIR, now: o.now,
    deps: o.deps, renderPng: o.renderPng, rasterizer: o.rasterizer, browser: args.browser
  };

  if (args.check) {
    const r = await checkOgPregen(common);
    if (r.exitCode === EXIT.OK) {
      write('✓ 预生成清单与磁盘一致：' + rel(r.manifestFile) + '（' + (r.manifest ? r.manifest.count : 0) + ' 条）');
      if (!quiet) {
        printSummary(r.manifest, write);
        if (r.report && r.report.length) printSkips(r.report, write);
      }
      return EXIT.OK;
    }
    if (r.exitCode === EXIT.USAGE) {
      const sourceBad = r.problems.some(function (p) { return String(p).indexOf('收集目标失败') === 0; });
      writeErr('✗ --check 跑不起来（这是结构问题，不是「有差异」）：');
      for (let i = 0; i < r.problems.length; i++) writeErr('  · ' + r.problems[i]);
      writeErr(sourceBad
        ? '  修法：先让 data/games.db 能读（跑过一次服务 / migrate 之后再 --check）'
        : '  修法：确认 public/og/manifest.json 是 JSON；坏了就删掉它重跑 node tools/gen-og.mjs');
      return EXIT.USAGE;
    }
    writeErr('✗ 预生成清单与磁盘不一致（' + r.problems.length + ' 处）：');
    for (let i = 0; i < r.problems.length && i < 20; i++) writeErr('  · ' + r.problems[i]);
    if (r.problems.length > 20) writeErr('  · …还有 ' + (r.problems.length - 20) + ' 处');
    writeErr('  修法：node tools/gen-og.mjs');
    return EXIT.DIFF;
  }

  const r = await generate(common);
  if (r.exitCode === EXIT.USAGE && r.skipReason === 'source_error') {
    writeErr('✗ 数据源读不了（库还没建表 / 打不开？）：' + (r.sourceError || '未知原因'));
    writeErr('  修法：先让 data/games.db 能读（跑过一次服务 / migrate 之后再生成）；什么都没写');
    return EXIT.USAGE;
  }
  if (r.exitCode === EXIT.NO_BROWSER) {
    write('⏭ SKIP 没找到可用的无头浏览器，什么都没写（也不假装成功）');
    if (!quiet) printBrowserHint(write);
    return EXIT.NO_BROWSER;
  }
  if (r.skipReason === 'no_targets') {
    write('⏭ SKIP 数据源里没有可预生成的目标（棋谱 / 每日题 / 天梯都是空的？）——什么都没写');
    return EXIT.OK;
  }
  write((r.failed ? '✗' : '✓') + ' 已生成 ' + r.rendered + ' 张 OG 位图' + (r.failed ? '（还有 ' + r.failed + ' 张没出来）' : '') +
    '：' + rel(r.dir) + '（浏览器：' + (r.browser ? r.browser : '注入的渲染函数') + '）');
  if (!quiet) {
    printSummary(r.manifest, write);
    if (r.verify) write('  自检：' + r.verify.ok + '/' + r.verify.total + ' 张读回来是合法 PNG' + (r.verify.failed ? '（' + r.verify.failed + ' 张有问题）' : ''));
    if (r.removed.length) write('  清掉 ' + r.removed.length + ' 个清单外的旧图：' + r.removed.slice(0, 3).join('、') + (r.removed.length > 3 ? ' …' : ''));
    if (r.changedManifest) write('  清单已更新：' + rel(path.join(r.dir, OG_MANIFEST_NAME)));
    else write('  清单无变化：' + rel(path.join(r.dir, OG_MANIFEST_NAME)));
    printSkips(r.skippedList, write);
  }
  if (r.failed) {
    writeErr('✗ 有 ' + r.failed + ' 个目标没生成出来（其余已落盘）：');
    for (let i = 0; i < r.failures.length && i < 20; i++) writeErr('  · ' + r.failures[i].key + '：' + r.failures[i].error);
    if (r.failures.length > 20) writeErr('  · …还有 ' + (r.failures.length - 20) + ' 个');
    if (r.failures.every(function (f) { return f.error === 'no_browser' || f.error === 'not_configured'; })) {
      writeErr('  看起来是浏览器的问题，可以加 --browser 指定路径，或先跑 node tools/og-detect.mjs 看看。');
    }
  }
  return r.exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(function (code) { process.exitCode = code; }, function (err) {
    console.error('✗ gen-og 跑挂了：' + ((err && err.stack) || err));
    process.exitCode = EXIT.USAGE;
  });
}
