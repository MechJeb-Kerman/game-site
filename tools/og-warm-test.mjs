#!/usr/bin/env node
/**
 * tools/og-warm-test.mjs — OG 图预生成（public/og）+ 缓存预热的验收测试。
 *
 * 测试纪律（写死在代码里，别改）：
 *   1. 整棵 src/ 复制到 %TEMP% 副本里跑，副本自带 data/；绝不打开真仓库的 data/games.db
 *      （末尾有 size+mtime 哨兵复核，真库被动过就会红）。
 *   2. 子进程只用 process.execPath，且显式带 ELECTRON_RUN_AS_NODE=1，避免启动 Electron GUI 假通过。
 *   3. 不依赖任何真实无头浏览器：现场栅格化一律用 driver:'browser' + 注入的 fetch 假渲染。
 *   4. 不开服务器、不占端口。
 *
 * 覆盖：清单读写 / 预生成优先读取 / 缺失回落 / 损坏回落 / 尺寸不符回落 /
 *      无浏览器 SKIP / 生成与幂等 / 预热统计 / --check 三种退出码。
 *
 * 用法: node tools/og-warm-test.mjs
 * 退出码: 0 全通过 / 1 有断言失败 / 4 环境准备失败
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

/* ============================ 断言骨架 ============================ */
let PASS = 0, FAIL = 0, GROUP = '';
const FAILED = [];
function group(name) {
  GROUP = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(2, 66 - name.length)));
}
function ok(cond, name, detail) {
  if (cond) { PASS++; console.log('  ✓ ' + name); }
  else {
    FAIL++; FAILED.push(GROUP + ' / ' + name);
    console.log('  ✗ ' + name + (detail === undefined ? '' : '\n      ' + String(detail).replace(/\n/g, '\n      ')));
  }
  return !!cond;
}
function is(name, actual, expected) {
  return ok(JSON.stringify(actual) === JSON.stringify(expected), name,
    'actual   = ' + JSON.stringify(actual) + '\nexpected = ' + JSON.stringify(expected));
}
function has(list, needle, name) {
  const arr = Array.isArray(list) ? list : [];
  return ok(arr.some((s) => String(s).indexOf(needle) >= 0), name,
    '找不到「' + needle + '」，实际：\n      ' + arr.join('\n      '));
}

/* ============================ PNG 构造（零依赖） ============================ */
const CRC = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 造一张真 PNG（宽高写进 IHDR，方便 pngSize 解析） */
function makePng(w, h, rgb) {
  const c = rgb || [40, 90, 200];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const base = y * stride;
    for (let x = 0; x < w; x++) { const p = base + 1 + x * 3; raw[p] = c[0]; raw[p + 1] = c[1]; raw[p + 2] = c[2]; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================ 路径与副本 ============================ */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const REAL_DB = join(REPO, 'data', 'games.db');
const TMP = mkdtempSync(join(tmpdir(), 'og-warm-'));
const SITE = join(TMP, 'site');
const FIX = join(TMP, 'fix');
const OG_DIR = join(SITE, 'public', 'og');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#112233"/></svg>';

function mkdirp(d) { mkdirSync(d, { recursive: true }); return d; }
let fixSeq = 0;
function fixDir(tag) { fixSeq++; return mkdirp(join(FIX, String(fixSeq).padStart(2, '0') + '-' + tag)); }
function pngsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
}
function listAll(dir) { return existsSync(dir) ? readdirSync(dir).sort() : []; }

function stage() {
  mkdirp(join(SITE, 'tools')); mkdirp(join(SITE, 'data')); mkdirp(join(SITE, 'public'));
  cpSync(join(REPO, 'src'), join(SITE, 'src'), { recursive: true });
  cpSync(join(REPO, 'tools'), join(SITE, 'tools'), { recursive: true });
  writeFileSync(join(SITE, 'package.json'),
    '{\n  "name": "og-warm-fixture",\n  "private": true,\n  "type": "module"\n}\n');
}

let og = null, gen = null, dbmod = null, elo = null, rules = null;
function childEnv(extra) {
  return Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', CHROME_PATH: '', EDGE_PATH: '' }, extra || {});
}
function runCli(args, site) {
  const at = site || SITE;
  const r = spawnSync(process.execPath, [join(at, 'tools', 'gen-og.mjs')].concat(args), {
    cwd: at, env: childEnv(), encoding: 'utf8', timeout: 180000
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), error: r.error, signal: r.signal };
}
function runNode(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd: cwd || SITE, env: childEnv(), encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), error: r.error };
}

/* ============================ 假渲染（不碰真浏览器） ============================ */
function fakeFetch(bytes, net) {
  return async function (url, init) {
    net.calls++;
    net.lastUrl = String(url);
    net.lastBody = init && init.body ? String(init.body) : '';
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
  };
}
function mkRz(dir, opts) {
  return og.createRasterizer(Object.assign({
    driver: 'browser',
    endpoint: 'https://og-fake.test/render',
    pregen: { dir: dir },
    browserCandidates: []
  }, opts || {}));
}
async function render(rz, kind, key, w, h) {
  return await rz.png({ kind: kind, key: key, svg: SVG, width: w || 1200, height: h || 630 });
}

/* ============================ 主流程 ============================ */
async function main() {
  const sentinel = existsSync(REAL_DB)
    ? { size: statSync(REAL_DB).size, mtime: statSync(REAL_DB).mtimeMs, wal: existsSync(REAL_DB + '-wal') }
    : null;

  /* ---------- §1 环境与纪律 ---------- */
  group('§1 临时副本与纪律');
  try { stage(); } catch (err) { console.error('✗ 副本准备失败：' + (err && err.stack || err)); process.exitCode = 4; return 4; }
  ok(existsSync(join(SITE, 'src', 'og.js')) && existsSync(join(SITE, 'tools', 'gen-og.mjs')), '副本里有 src/ 整树与 tools/gen-og.mjs');
  ok(existsSync(join(SITE, 'package.json')), '副本自带 package.json（type:module，副本里的 src/*.js 才是 ESM）');
  ok(resolve(SITE) !== resolve(REPO) && !join(SITE, '').startsWith(join(REPO, '')), '跑在 %TEMP% 副本里，不是真仓库：' + SITE);
  const help = runCli(['--help']);
  ok(help.code === 0 && /用法/.test(help.out) && !help.error, '子进程真的跑起来并输出了 --help（process.execPath + ELECTRON_RUN_AS_NODE，不是 Electron GUI 假通过）',
    'code=' + help.code + ' err=' + (help.error && help.error.message) + ' out=' + help.out.slice(0, 120));
  ok(!/electron/i.test(process.execPath), 'process.execPath 是 node 而不是 electron：' + process.execPath);

  og = await import(pathToFileURL(join(SITE, 'src', 'og.js')).href);
  gen = await import(pathToFileURL(join(SITE, 'tools', 'gen-og.mjs')).href);
  dbmod = await import(pathToFileURL(join(SITE, 'src', 'db.js')).href);
  elo = await import(pathToFileURL(join(SITE, 'src', 'elo.js')).href);
  rules = await import(pathToFileURL(join(SITE, 'src', 'rules', 'index.js')).href);
  ok(typeof og.createRasterizer === 'function' && typeof og.warmOgPregen === 'function' && typeof gen.main === 'function',
    'src/og.js 与 tools/gen-og.mjs 的导出形状对得上（createRasterizer / warmOgPregen / main）');

  /* ---------- §2 清单读写 ---------- */
  group('§2 清单读写（key / 文件名 / build / read / diff）');
  is('ogPregenKey(kind,key) 稳定键', og.ogPregenKey('replay', 12), 'replay:12');
  is('ogFileName 与 key 一一对应', og.ogFileName('replay', 12), 'replay-12.png');
  is('kind 别名 play → replay', og.ogFileName('play', '12'), 'replay-12.png');
  is('daily 的文件名带日期', og.ogFileName('daily', '2026-01-02'), 'daily-2026-01-02.png');

  const genAt = '2026-01-02T03:04:05.000Z';
  const e1 = { kind: 'replay', id: '12', revision: 'svg:aaa', source: 'replay:12', bytes: 100 };
  const e2 = { kind: 'daily', id: '2026-01-02', revision: 'svg:bbb', source: 'daily:2026-01-02', bytes: 20 };
  const man = og.buildOgManifest([e1, e2], { generatedAt: genAt, dir: 'public/og' });
  is('manifest.count', man.count, 2);
  is('manifest.bytes = 逐条 bytes 之和', man.bytes, 120);
  is('manifest.width/height 缺省 1200x630', [man.width, man.height], [1200, 630]);
  is('manifest.entries 按 key 升序', man.entries.map((e) => e.key), ['daily:2026-01-02', 'replay:12']);
  is('entry.file 由 kind+id 推出', man.entries.map((e) => e.file), ['daily-2026-01-02.png', 'replay-12.png']);
  is('manifest.generatedAt 原样记录', man.generatedAt, genAt);
  ok(typeof man.fingerprint === 'string' && man.fingerprint.length > 0, 'manifest 带来源指纹 fingerprint：' + man.fingerprint);
  is('同源两次生成的指纹一致（幂等的判据）', og.buildOgManifest([e1, e2], { generatedAt: '2026-07-07T00:00:00.000Z', dir: 'public/og' }).fingerprint, man.fingerprint);

  const mdir = fixDir('manifest');
  writeFileSync(join(mdir, 'manifest.json'), JSON.stringify(man, null, 2));
  const read = await og.readOgManifest({ dir: mdir });
  ok(read.ok === true && read.manifest.count === 2, 'readOgManifest 读回清单');
  ok(String(read.file).endsWith('manifest.json') && String(read.file).indexOf(mdir) === 0, 'readOgManifest 回绝对 file 路径：' + read.file);
  const emptyDir = fixDir('no-manifest');
  is('没生成过 → no_manifest', (await og.readOgManifest({ dir: emptyDir })).error, 'no_manifest');
  const badDir = fixDir('bad-json');
  writeFileSync(join(badDir, 'manifest.json'), '{oops');
  is('清单不是 JSON → bad_json', (await og.readOgManifest({ dir: badDir })).error, 'bad_json');
  const shapeDir = fixDir('bad-shape');
  writeFileSync(join(shapeDir, 'manifest.json'), JSON.stringify({ version: 1 }));
  is('清单没有 entries → bad_shape', (await og.readOgManifest({ dir: shapeDir })).error, 'bad_shape');

  const disk = { 'replay-12.png': 100, 'daily-2026-01-02.png': 20 };
  const files = ['daily-2026-01-02.png', 'replay-12.png'];
  // diff 的第二个参数是「现在应该有的条目」数组（不是清单对象）
  const freshOf = function (list) {
    return list.map(function (e) { return { key: e.key, kind: e.kind, id: e.id, file: e.file, revision: e.revision }; });
  };
  const cur = freshOf(man.entries);
  is('清单与磁盘一致 → 空问题数组', og.diffOgManifest(man, cur, { disk: disk, files: files }), []);
  has(og.diffOgManifest(null, cur, { disk: disk, files: files }), '清单不存在', '清单缺失判为「差异」而不是「结构坏了」');
  has(og.diffOgManifest({}, cur, { disk: disk, files: files }), 'entries', '缺 entries 的清单被点出来');
  has(og.diffOgManifest(man, cur, { disk: { 'daily-2026-01-02.png': 20 }, files: files }), '文件缺失：replay-12.png', '磁盘缺文件');
  has(og.diffOgManifest(man, cur, { disk: { 'replay-12.png': 99, 'daily-2026-01-02.png': 20 }, files: files }), '文件字节数不符：replay-12.png', '字节数不符');
  has(og.diffOgManifest(man, cur, { disk: disk, files: files.concat(['stray.png']) }), '多余文件（清单里没有）：stray.png', '清单外的野图');
  has(og.diffOgManifest(man, freshOf(man.entries.concat([{ kind: 'profile', id: 'neo', revision: 'svg:ccc', file: 'profile-neo.png' }])), { disk: disk, files: files }),
    '新增条目', '源里多出来的目标');
  has(og.diffOgManifest(man, freshOf(man.entries.filter(function (e) { return e.kind === 'daily'; })), { disk: disk, files: files }),
    '多余条目（源里已经没有了）：replay:12', '源里已经没有的目标');
  has(og.diffOgManifest(man, freshOf(man.entries.map(function (e) { return e.kind === 'replay' ? Object.assign({}, e, { revision: 'svg:zzz' }) : e; })), { disk: disk, files: files }),
    '来源已变（要重新生成）：replay:12', '来源变了要重新生成');
  has(og.diffOgManifest(Object.assign({}, man, { version: 999 }), cur, { disk: disk, files: files }), 'version 不一致', '清单版本对不上');

  /* ---------- §3 预生成优先读取 ---------- */
  group('§3 预生成优先读取（文件在就用它，不落浏览器）');
  const hitDir = fixDir('hit');
  const hitPng = makePng(1200, 630, [10, 120, 240]);
  writeFileSync(join(hitDir, 'replay-7.png'), hitPng);
  const netHit = { calls: 0 };
  const rzHit = mkRz(hitDir, { fetch: fakeFetch(makePng(1200, 630), netHit) });
  const rHit = await render(rzHit, 'replay', 7);
  ok(rHit.ok === true && rHit.source === 'pregen' && rHit.pregen === true && rHit.driver === 'pregen',
    '命中预生成文件：source/driver = pregen', JSON.stringify(rHit).slice(0, 200));
  ok(Buffer.compare(Buffer.from(rHit.bytes), hitPng) === 0, '读回来就是磁盘上那份字节（文件是唯一真相）');
  is('命中时一次都没走浏览器', netHit.calls, 0);
  ok(rzHit.stats().pregenHits === 1 && rzHit.stats().renders === 0, 'stats().pregenHits=1 / renders=0');
  is('命中不写缓存也不影响既有字段', rHit.cached, false);

  /* ---------- §4 回落 ---------- */
  group('§4 缺失 / 损坏 / 尺寸不符 → 回落现场栅格化');
  const missDir = fixDir('miss');
  const livePng = makePng(1200, 630, [200, 40, 40]);
  const netMiss = { calls: 0 };
  const rzMiss = mkRz(missDir, { fetch: fakeFetch(livePng, netMiss) });
  const rMiss = await render(rzMiss, 'replay', 8);
  ok(rMiss.ok === true && rMiss.driver === 'browser', '文件缺失 → 回落现场栅格化并出图', JSON.stringify(rMiss).slice(0, 200));
  ok(rzMiss.stats().pregenMisses === 1 && rzMiss.stats().renders === 1 && netMiss.calls === 1, 'stats().pregenMisses=1、renders=1、浏览器被调用 1 次');

  const junkDir = fixDir('junk');
  writeFileSync(join(junkDir, 'replay-9.png'), Buffer.from('这不是 PNG，只是一段垃圾字节'));
  const netJunk = { calls: 0 };
  const rzJunk = mkRz(junkDir, { fetch: fakeFetch(livePng, netJunk) });
  const rJunk = await render(rzJunk, 'replay', 9);
  ok(rJunk.ok === true && rJunk.driver === 'browser', '损坏文件 → 不抛异常，回落现场栅格化');
  ok(rzJunk.stats().pregenInvalid === 1 && rzJunk.stats().renders === 1, 'stats().pregenInvalid=1（损坏只计数）');

  const sizeDir = fixDir('size');
  writeFileSync(join(sizeDir, 'replay-11.png'), makePng(100, 100, [9, 9, 9]));
  const netSize = { calls: 0 };
  const rzSize = mkRz(sizeDir, { fetch: fakeFetch(livePng, netSize) });
  const rSize = await render(rzSize, 'replay', 11);
  ok(rSize.ok === true && rSize.driver === 'browser' && rzSize.stats().pregenSizeSkip === 1,
    '尺寸不符 → 跳过预生成文件，回落现场栅格化');
  const rSizeOk = await render(rzSize, 'replay', 11, 100, 100);
  ok(rSizeOk.ok === true && rSizeOk.source === 'pregen', '同一份文件在请求尺寸相符时命中（尺寸是判据的一部分）');

  const netDead = { calls: 0 };
  const rzDead = mkRz(missDir, { fetch: async function () { netDead.calls++; throw new Error('渲染服务炸了'); } });
  const rDead = await render(rzDead, 'replay', 13);
  ok(rDead.ok === false && typeof rDead.error === 'string', '连现场栅格化也失败 → 回 {ok:false,error}（路由层据此回落原样 SVG）：' + JSON.stringify(rDead));

  /* ---------- §5 前置：播种（CLI 会读库，库没表就收集不了目标） ---------- */
  group('§5a 给副本库播种（棋谱 2 条 / 游戏 3 个 / 天梯 2 人）');
  dbmod.migrate();
  const db = dbmod.db;
  const NOW = Date.now();
  const season = elo.seasonOf(NOW);
  const slugs = rules.SLUGS || [];
  ok(slugs.length > 0, 'rules.SLUGS 非空（天梯按这些 slug 查）：' + JSON.stringify(slugs.slice(0, 4)));
  const slugA = slugs[0];

  db.exec("INSERT INTO categories (slug,name,icon,sort) VALUES ('ogtest','OG 测试','🧪',1)");
  const catId = Number(db.prepare("SELECT id FROM categories WHERE slug='ogtest'").get().id);
  const insGame = db.prepare('INSERT INTO games (slug,title,category_id,game_url,status,accent,accent2) VALUES (?,?,?,?,1,?,?)');
  const gameSlugs = [slugA, slugs[1] || slugA, 'og-extra'];
  for (let i = 0; i < gameSlugs.length; i++) insGame.run(gameSlugs[i], 'OG 测试游戏 ' + (i + 1), catId, '/g/' + gameSlugs[i], '#123456', '#654321');

  const moves = JSON.stringify([{ seq: 1, seat: 0, move: 'a1' }, { seq: 2, seat: 1, move: 'b2' }]);
  const insReplay = db.prepare('INSERT INTO play_replays (game,room_code,host_name,guest_name,result,move_count,moves,plays,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  insReplay.run(slugA, 'OGA001', 'OG甲', 'OG乙', 'host', 2, moves, 3, NOW - 1000);
  insReplay.run(slugA, 'OGB002', 'OG丙', 'OG丁', 'guest', 2, moves, 4, NOW - 9000);
  const replayIds = db.prepare('SELECT id FROM play_replays ORDER BY id ASC').all().map((r) => Number(r.id));

  const insUser = db.prepare('INSERT INTO users (username,display_name,pass_hash,pass_salt) VALUES (?,?,?,?)');
  const r1 = insUser.run('ogwarm1', '预热一号', 'x', 'y');
  const r2 = insUser.run('ogwarm2', '预热二号', 'x', 'y');
  const u1 = Number(r1.lastInsertRowid), u2 = Number(r2.lastInsertRowid);
  const insRating = db.prepare('INSERT INTO player_ratings (user_id,game,season,rating,games,wins,losses,draws,peak,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insRating.run(String(u1), slugA, season, 1500, 10, 7, 3, 0, 1550, NOW);
  insRating.run(String(u2), slugA, season, 1400, 8, 4, 4, 0, 1450, NOW);

  ok(db.prepare('SELECT COUNT(*) AS n FROM play_replays').get().n === 2, '副本库里确实有 2 条棋谱');

  /* ---------- §5b 无浏览器 SKIP ---------- */
  group('§5b 没有无头浏览器 → 明确 SKIP，不假装成功');
  const before = listAll(OG_DIR);
  const skip = runCli(['--browser', join(SITE, 'no', 'such', 'chrome.exe'), '--kinds', 'replay', '--limit', '2']);
  ok(skip.code === 3, 'CLI 退出码 3（NO_BROWSER）', 'code=' + skip.code + ' out=' + skip.out + ' err=' + skip.err);
  ok(/SKIP/.test(skip.out) && /无头浏览器/.test(skip.out), '明确打出 SKIP：' + skip.out.trim().split('\n')[0]);
  is('SKIP 时一个文件都没写（目录仍为空）', listAll(OG_DIR), before);
  is('SKIP 时没写清单', existsSync(join(OG_DIR, 'manifest.json')), false);

  /* ---------- §5c 库读不了 → 明确报错，不甩 SQLite 原始栈 ---------- */
  const bare = join(TMP, 'bare');
  cpSync(SITE, bare, {
    recursive: true,
    filter: function (src) { return !/[\\/]data([\\/]|$)/.test(src) && !/[\\/]public[\\/]og([\\/]|$)/.test(src); }
  });
  const dead = runCli(['--limit', '1'], bare);
  ok(dead.code === 2, '库读不了 → 退出码 2（结构问题）', 'code=' + dead.code + ' err=' + dead.err.slice(0, 300));
  ok(/数据源读不了/.test(dead.err), '明确说「数据源读不了」并给出修法', dead.err.slice(0, 300));
  ok(!/跑挂了/.test(dead.err) && !/\n\s+at\s/.test(dead.err), '不把未捕获异常的栈甩给用户（原始原因可以提，栈不行）', dead.err.slice(0, 300));
  is('这条路径同样一个文件都没写', listAll(OG_DIR), before);
  const bareCheck = runCli(['--check'], bare);
  ok(bareCheck.code === 1 && /清单不存在/.test(bareCheck.err), 'bare 副本 --check（没清单）→ 1 而不是 2（「有差异」与「跑不起来」分开）',
    'code=' + bareCheck.code + ' err=' + bareCheck.err.slice(0, 200));

  /* ---------- §6 生成 ---------- */
  group('§6 生成 public/og + manifest.json（注入假渲染，不需要浏览器）');
  const flags = ['--limit', '2', '--kinds', 'replay,daily,profile'];
  const logs = [], errs = [];
  const fakeRender = async function () { return { ok: true, bytes: makePng(1200, 630, [30, 60, 120]) }; };
  const code = await gen.main(flags, {
    renderPng: fakeRender, dir: OG_DIR,
    log: function (l) { logs.push(String(l)); }, logError: function (l) { errs.push(String(l)); }
  });
  ok(code === 0, 'main() 成功退出 0', 'code=' + code + '\n' + logs.join('\n') + '\n' + errs.join('\n'));
  ok(logs.some((l) => /已生成/.test(l)), '打出生成摘要：' + (logs.find((l) => /已生成/.test(l)) || '').trim());

  const manFile = join(OG_DIR, 'manifest.json');
  const manOnDisk = existsSync(manFile) ? JSON.parse(readFileSync(manFile, 'utf8')) : null;
  ok(!!manOnDisk && Array.isArray(manOnDisk.entries), '清单落到 public/og/manifest.json');
  const keys = manOnDisk ? manOnDisk.entries.map((e) => e.key) : [];
  is('replay 条目 = 库里那两条', keys.filter((k) => k.startsWith('replay:')).sort(), replayIds.map((id) => 'replay:' + id).sort());
  is('profile 条目 = 天梯上那两个人', keys.filter((k) => k.startsWith('profile:')).sort(), ['profile:ogwarm1', 'profile:ogwarm2']);
  ok(keys.filter((k) => /^daily:\d{4}-\d{2}-\d{2}$/.test(k)).length === 2, 'daily 条目 = 今天与昨天：' + JSON.stringify(keys.filter((k) => k.startsWith('daily:'))));
  is('清单 count 与条目数一致', manOnDisk.count, keys.length);
  is('磁盘上的 png 数 = 清单条目数', pngsIn(OG_DIR), manOnDisk.entries.map((e) => e.file).sort());
  const bytesOk = manOnDisk.entries.every((e) => existsSync(join(OG_DIR, e.file)) && statSync(join(OG_DIR, e.file)).size === e.bytes);
  ok(bytesOk, '每条记录的 bytes 与磁盘实际字节数一致');
  ok(manOnDisk.entries.every((e) => typeof e.revision === 'string' && e.revision.length > 0), '每条都带来源指纹 revision（--check 靠它判断要不要重生成）');
  ok(manOnDisk.entries.filter((e) => e.kind === 'replay').every((e) => String(e.source).indexOf('replay:') === 0)
    && manOnDisk.entries.filter((e) => e.kind === 'profile').every((e) => String(e.source).indexOf('ladder:') === 0),
    '来源标注可读：replay:<id> / ladder:<slug>#<rank>');
  ok(typeof manOnDisk.fingerprint === 'string' && manOnDisk.fingerprint.length > 0, '清单一并写了整体指纹：' + manOnDisk.fingerprint);

  const before2 = pngsIn(OG_DIR).map((f) => [f, statSync(join(OG_DIR, f)).size, readFileSync(join(OG_DIR, f)).toString('base64')].join(':'));
  const code2 = await gen.main(flags, { renderPng: fakeRender, dir: OG_DIR, quiet: true, log: function () {}, logError: function () {} });
  const manOnDisk2 = JSON.parse(readFileSync(manFile, 'utf8'));
  const after2 = pngsIn(OG_DIR).map((f) => [f, statSync(join(OG_DIR, f)).size, readFileSync(join(OG_DIR, f)).toString('base64')].join(':'));
  ok(code2 === 0, '第二遍生成同样退出 0（连跑两遍不炸）');
  is('第二遍后文件集合与字节完全一致（幂等）', after2, before2);
  is('第二遍后指纹不变', manOnDisk2.fingerprint, manOnDisk.fingerprint);
  is('第二遍后条目不变（key/file/bytes/revision）', manOnDisk2.entries.map((e) => [e.key, e.file, e.bytes, e.revision]), manOnDisk.entries.map((e) => [e.key, e.file, e.bytes, e.revision]));

  /* ---------- §7 预热统计 ---------- */
  group('§7 预热统计 warmOgPregen / rasterizer.warm');
  const warm = await og.warmOgPregen({ dir: OG_DIR });
  ok(warm.total === manOnDisk.count && warm.ok === warm.total && warm.failed === 0,
    '清单里的 key 依次读一遍：total=' + warm.total + ' ok=' + warm.ok + ' failed=' + warm.failed, JSON.stringify(warm).slice(0, 300));
  ok(warm.bytes > 0 && warm.version === manOnDisk.version, '字节合计与清单版本一并返回：bytes=' + warm.bytes + ' version=' + warm.version);
  ok(Array.isArray(warm.entries) && warm.entries.every((e) => e.ok === true && e.error === undefined), '逐条预热明细都是 ok');

  const warmNone = await og.warmOgPregen({ dir: fixDir('warm-none') });
  is('没清单时 total/ok/failed 都 0 并给出原因', [warmNone.total, warmNone.ok, warmNone.failed, warmNone.error], [0, 0, 0, 'no_manifest']);

  const partialDir = fixDir('warm-partial');
  const good = makePng(1200, 630, [1, 2, 3]);
  writeFileSync(join(partialDir, 'replay-1.png'), good);
  writeFileSync(join(partialDir, 'daily-2026-01-02.png'), Buffer.from('坏文件'));
  writeFileSync(join(partialDir, 'manifest.json'), JSON.stringify(og.buildOgManifest([
    { kind: 'replay', id: '1', revision: 'svg:a', bytes: good.length },
    { kind: 'daily', id: '2026-01-02', revision: 'svg:b', bytes: 999 },
    { kind: 'profile', id: 'ghost', revision: 'svg:c', bytes: 7 }
  ], { generatedAt: '2026-01-02T00:00:00.000Z', dir: partialDir }), null, 2));
  const warmPart = await og.warmOgPregen({ dir: partialDir });
  is('1 好 + 1 坏 + 1 缺 → total/ok/failed', [warmPart.total, warmPart.ok, warmPart.failed], [3, 1, 2]);
  is('失败原因分得清：坏文件 bad_png / 缺文件 missing',
    warmPart.entries.filter((e) => !e.ok).map((e) => [e.file, e.error]).sort(), [['daily-2026-01-02.png', 'bad_png'], ['profile-ghost.png', 'missing']].sort());

  const sizeFixture = fixDir('warm-size');
  const small = makePng(100, 100, [5, 5, 5]);
  writeFileSync(join(sizeFixture, 'replay-2.png'), small);
  writeFileSync(join(sizeFixture, 'manifest.json'), JSON.stringify(og.buildOgManifest([
    { kind: 'replay', id: '2', revision: 'svg:d', bytes: small.length }
  ], { generatedAt: '2026-01-02T00:00:00.000Z', dir: sizeFixture }), null, 2));
  const warmSize = await og.warmOgPregen({ dir: sizeFixture });
  is('清单声明的尺寸与文件不符 → size_mismatch', [warmSize.total, warmSize.ok, warmSize.failed, warmSize.entries[0].error], [1, 0, 1, 'size_mismatch']);

  const rzWarm = mkRz(OG_DIR, { fetch: async function () { throw new Error('预热不该走浏览器'); } });
  const rzWarmOut = await rzWarm.warm();
  ok(rzWarmOut.ok === rzWarmOut.total && rzWarmOut.failed === 0 && rzWarmOut.total === manOnDisk.count,
    'rasterizer.warm() 与 warmOgPregen 同口径：' + rzWarmOut.total + ' ok');
  const rzOff = og.createRasterizer({ driver: 'browser', endpoint: 'https://og-fake.test/render', pregen: false });
  const off = await rzOff.warm();
  is('pregen 关掉时预热明确回 pregen_disabled', [off.total, off.ok, off.error], [0, 0, 'pregen_disabled']);

  /* ---------- §8 --check 三种退出码 ---------- */
  group('§8 --check 的 0 / 1 / 2');
  const checkArgs = ['--check'].concat(flags);
  const c0 = runCli(checkArgs);
  ok(c0.code === 0 && /一致/.test(c0.out), '一致 → 0：' + c0.out.trim().split('\n')[0], 'code=' + c0.code + ' err=' + c0.err);
  ok(c0.err === '', '一致时不往 stderr 写东西');

  const victim = manOnDisk.entries.find((e) => e.kind === 'replay');
  const victimBytes = readFileSync(join(OG_DIR, victim.file));
  rmSync(join(OG_DIR, victim.file));
  const c1 = runCli(checkArgs);
  ok(c1.code === 1, '缺一个文件 → 1（有差异）', 'code=' + c1.code);
  has(c1.err.split('\n'), '文件缺失：' + victim.file, '差异点名了缺哪个文件');
  ok(!/SKIP/.test(c1.out + c1.err), '--check 不会因为没浏览器而 SKIP（它只读磁盘与源）');
  writeFileSync(join(OG_DIR, victim.file), victimBytes);
  const c1b = runCli(checkArgs);
  ok(c1b.code === 0, '把文件放回去 → 又回 0（证明刚才的 1 是缺文件引起的，不是别的漂移）', 'code=' + c1b.code + c1b.err);

  const manText = readFileSync(manFile, 'utf8');
  writeFileSync(manFile, '{ 这不是 JSON');
  const c2 = runCli(checkArgs);
  ok(c2.code === 2, '清单坏了 → 2（结构问题，不是「有差异」）', 'code=' + c2.code);
  has(c2.err.split('\n'), '清单读不了', '2 的提示说的是「清单读不了」');
  writeFileSync(manFile, manText);
  is('清单还原后 --check 回 0', runCli(checkArgs).code, 0);
  rmSync(manFile);
  const c3 = runCli(checkArgs);
  ok(c3.code === 1, '压根没生成过（没清单）→ 1，也属于「有差异」', 'code=' + c3.code + ' err=' + c3.err);
  writeFileSync(manFile, manText);
  is('清单一并还原（收尾）', runCli(checkArgs).code, 0);

  /* ---------- §9 纪律复核 ---------- */
  group('§9 纪律复核');
  if (sentinel) {
    const after = statSync(REAL_DB);
    ok(after.size === sentinel.size && after.mtimeMs === sentinel.mtime,
      '真仓库的 data/games.db 一次都没被碰过（size+mtime 未变）');
  } else {
    ok(true, '真仓库没有 data/games.db（跳过哨兵）');
  }
  ok(JSON.stringify(logs).indexOf(REPO.replace(/\\/g, '\\\\')) < 0, '生成的日志里没有出现真仓库路径');
  ok(SITE.indexOf(tmpdir()) === 0, '全部产物都落在 %TEMP% 副本内：' + TMP);
  if (db && typeof db.close === 'function') { try { db.close(); } catch (err) { /* 收尾失败不影响判定 */ } }

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(70));
  console.log('通过 ' + PASS + ' / 失败 ' + FAIL + '（断言总数 ' + (PASS + FAIL) + '）');
  if (FAIL) {
    console.log('\n失败清单：');
    for (let i = 0; i < FAILED.length; i++) console.log('  ' + (i + 1) + '. ' + FAILED[i]);
    console.log('\n临时副本保留待排查：' + TMP);
    return 1;
  }
  console.log('临时副本：' + TMP + '（全部通过，已清理）');
  try { rmSync(TMP, { recursive: true, force: true }); } catch (err) { console.log('  （副本清理失败：' + (err && err.message) + '，可手动删）'); }
  return 0;
}

main().then(function (code) { process.exitCode = code; }, function (err) {
  console.error('✗ 测试自己跑挂了：' + ((err && err.stack) || err));
  console.error('临时副本：' + TMP);
  process.exitCode = 1;
});
