#!/usr/bin/env node
// tools/meili-index.mjs —— 把已上架游戏灌进 Meilisearch 索引（零依赖，只用 node: 内置模块）。
//
// 背景：src/search.js 是「主后端 + 兜底 + 熔断」适配层，设了 MEILI_HOST 就走 Meili、超时或报错
// 自动退回 SQL LIKE + 拼音；但索引里得先有文档。本脚本负责那一步：
//   读本地库 data/games.db（status=1 的全部游戏）→ 分批 POST /indexes/<idx>/documents?primaryKey=slug。
//
// 字段口径与 src/search.js / src/data.js 对齐：
//   · 下游只认 slug（src/search.js normalizeHit 只留 slug/title/score，server.js 再按 slug 回库取整行），
//     所以 slug 必须与库里一致、且作为 primaryKey 保证重复跑幂等（覆盖而非追加）。
//   · 可搜文本（对照 src/data.js searchPlan 的本地 LIKE 命中字段）：
//     title > subtitle > tags > category > pinyin(=search_pinyin) > description。
//     tags 在库里是 JSON 数组字符串，文档里发**数组**：本地 tags LIKE 能命中子串，
//     数组在 Meili 里同样按元素分词命中，且不会把中文标签拼成一整串。
//   · category 发 slug 文本（puzzle/action/...），显示用的中文名交给回库渲染，索引只负责能搜到。
//
// 用法：node tools/meili-index.mjs [选项]
//   --dry-run      只打印将要推送的文档数与样本，不发任何 HTTP 请求
//   --settings     先 PUT .../settings 配 searchableAttributes / filterableAttributes / sortableAttributes
//   --limit=N      只推送前 N 条（0=全部，默认全部）
//   --batch=N      每批文档数（默认 100）
//   --host=URL     Meilisearch 地址（默认 env MEILI_HOST，例 http://127.0.0.1:7700）
//   --key=KEY      API Key（默认 env MEILI_API_KEY；无鉴权的本地实例可留空）
//   --index=NAME   索引名（默认 env MEILI_INDEX，再默认 games）
//   --db=PATH      源库路径（默认 data/games.db；自测用）
//   --timeout=MS   单次请求超时（默认 env MEILI_TIMEOUT_MS，再默认 10000）
//   -h, --help     打印帮助
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = join(ROOT, 'data', 'games.db');
const DEFAULT_INDEX = 'games';
const DEFAULT_BATCH = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_SNIPPET = 200;

/** 服务端要的属性配置（--settings 用），字段与站点实际检索/排序口径对齐 */
export const SITE_SEARCHABLE = ['title', 'subtitle', 'tags', 'category', 'pinyin', 'description'];
export const SITE_FILTERABLE = ['category', 'tags'];
export const SITE_SORTABLE = ['plays', 'rating', 'id'];

const USAGE = [
  '把 game-site 已上架游戏灌进 Meilisearch 索引（零依赖）',
  '',
  '用法：node tools/meili-index.mjs [选项]',
  '',
  '选项：',
  '  --dry-run       只打印将要推送的文档数与样本，不发任何 HTTP 请求',
  '  --settings      先 PUT /indexes/<idx>/settings 配置可搜/可过滤/可排序属性',
  '  --limit=N       只推送前 N 条（0 = 全部，默认全部）',
  '  --batch=N       每批推送文档数（默认 ' + DEFAULT_BATCH + '）',
  '  --host=URL      Meilisearch 地址（默认 env MEILI_HOST，例 http://127.0.0.1:7700）',
  '  --key=KEY       API Key（默认 env MEILI_API_KEY；本地无鉴权实例可留空）',
  '  --index=NAME    索引名（默认 env MEILI_INDEX，再默认 ' + DEFAULT_INDEX + '）',
  '  --db=PATH       源库路径（默认 data/games.db）',
  '  --timeout=MS    单次请求超时毫秒（默认 env MEILI_TIMEOUT_MS，再默认 ' + DEFAULT_TIMEOUT_MS + '）',
  '  -h, --help      打印本帮助',
  '',
  '示例：',
  '  node tools/meili-index.mjs --dry-run',
  '  MEILI_HOST=http://127.0.0.1:7700 node tools/meili-index.mjs --settings',
  '  node tools/meili-index.mjs --host=http://127.0.0.1:7700 --key=masterKey --batch=50',
].join('\n');

/** 解析命令行；recognized=false 表示遇到了不认识的选项 */
export function parseArgs(argv) {
  const o = {
    help: false, dryRun: false, settings: false,
    limit: null, batch: null,
    host: null, key: null, index: null, db: null, timeout: null, recognized: true,
  };
  for (const a of argv) {
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--settings') { o.settings = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { o.recognized = false; o.badArg = a; continue; }
    const [, name, raw] = m;
    const val = raw === undefined ? '' : raw;
    switch (name) {
      case 'host': o.host = val; break;
      case 'key': o.key = val; break;
      case 'index': o.index = val; break;
      case 'db': o.db = val; break;
      case 'limit': o.limit = raw; break;
      case 'batch': o.batch = raw; break;
      case 'timeout': o.timeout = raw; break;
      default: o.recognized = false; o.badArg = a;
    }
  }
  return o;
}

const isNum = (v) => v !== null && v !== undefined && /^[0-9]+$/.test(String(v).trim());

/** 解析出运行配置；出错时返回 { error }，不抛异常 */
export function resolveConfig(argv, env = process.env) {
  const o = parseArgs(argv);
  if (!o.recognized) return { error: '无法识别的选项：' + (o.badArg || '(空)') };
  if (o.help) return { help: true };
  const cfg = {
    dryRun: o.dryRun,
    setSettings: o.settings,
    host: String(o.host ?? env.MEILI_HOST ?? '').trim().replace(/\/+$/, ''),
    key: o.key ?? env.MEILI_API_KEY ?? '',
    index: String(o.index ?? env.MEILI_INDEX ?? DEFAULT_INDEX).trim() || DEFAULT_INDEX,
    db: resolve(o.db || env.GAMES_DB || DEFAULT_DB),
    batch: DEFAULT_BATCH,
    limit: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  if (o.batch !== null) {
    if (!isNum(o.batch)) return { error: '--batch 需要一个正整数，收到：' + JSON.stringify(String(o.batch)) };
    cfg.batch = Number(o.batch);
    if (cfg.batch < 1) return { error: '--batch 至少为 1' };
  }
  if (o.limit !== null) {
    if (!isNum(o.limit)) return { error: '--limit 需要一个非负整数，收到：' + JSON.stringify(String(o.limit)) };
    cfg.limit = Number(o.limit);
  }
  const t = o.timeout ?? env.MEILI_TIMEOUT_MS;
  if (t !== null && t !== undefined && String(t).trim() !== '') {
    if (!isNum(t)) return { error: '--timeout 需要一个正整数毫秒值，收到：' + JSON.stringify(String(t)) };
    cfg.timeoutMs = Number(t);
  }
  if (!cfg.dryRun) {
    if (!cfg.host) return { error: '没有 Meilisearch 地址：请设 MEILI_HOST 或传 --host=http://127.0.0.1:7700' };
    let u = null;
    try { u = new URL(cfg.host); } catch { u = null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      return { error: 'Meilisearch 地址必须是 http/https URL，收到：' + JSON.stringify(cfg.host) };
    }
  }
  return { cfg };
}

/** 把一行库记录映射成索引文档（slug 必填；缺 search_pinyin 列时不发 pinyin） */
export function gameDoc(row) {
  const slug = String(row.slug ?? '').trim();
  if (!slug) return null;
  const doc = {
    slug,
    title: String(row.title ?? ''),
    subtitle: String(row.subtitle ?? ''),
    category: String(row.category ?? ''),
    tags: normalizeTags(row.tags),
  };
  if (row.search_pinyin !== undefined && row.search_pinyin !== null) {
    doc.pinyin = String(row.search_pinyin);
  }
  const day = Number(row.created_at);
  if (Number.isInteger(day) && day > 0) doc.releasedAt = day;
  return doc;
}

/** tags 在库里是 JSON 数组字符串；解析失败就按逗号/空白拆，永远是字符串数组 */
export function normalizeTags(v) {
  if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((t) => String(t).trim()).filter(Boolean);
    } catch { /* 落回分隔符拆分 */ }
  }
  return s.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
}

/** 读全部上架游戏（status=1），稳定按 id 排序 */
export function loadGames(dbPath, { limit = null } = {}) {
  if (!existsSync(dbPath)) {
    return { error: '找不到数据库：' + dbPath + '\n先跑一次 node src/seed.js 生成并填充游戏数据。' };
  }
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
    if (!cols.includes('slug')) return { error: dbPath + ' 里没有 games 表（或表结构不对）：先跑 node src/seed.js。' };
    const sel = [
      'g.slug', 'g.title', 'g.subtitle', 'g.description', 'g.tags',
      cols.includes('created_at') ? 'g.created_at' : 'NULL AS created_at',
      cols.includes('search_pinyin') ? 'g.search_pinyin' : 'NULL AS search_pinyin',
      'c.slug AS category',
    ];
    const sql = 'SELECT ' + sel.join(', ') + ' FROM games g LEFT JOIN categories c ON c.id = g.category_id'
      + ' WHERE g.status = 1 ORDER BY g.id';
    const rows = db.prepare(sql).all();
    let docs = rows.map(gameDoc).filter(Boolean);
    if (limit !== null) docs = docs.slice(0, limit);
    return { docs, totalInDb: rows.length };
  } catch (e) {
    return { error: '读取数据库失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    try { if (db) db.close(); } catch { /* 关不掉也无所谓 */ }
  }
}

/** 把数组切成 n 个一块 */
export function chunk(arr, n) {
  const size = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 响应体前 max 字，用于报错 */
export function snippet(text, max = BODY_SNIPPET) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 发一个 JSON 请求。永不抛异常——网络不可达、超时、非法响应都折成 { ok:false, error }。
 */
export async function requestJson(method, url, { body = null, key = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = {};
  if (body !== null) headers['content-type'] = 'application/json';
  if (key) headers.authorization = 'Bearer ' + key;
  let res = null;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    const name = e && e.name ? e.name : '';
    if (name === 'TimeoutError' || /timed out|timeout/i.test(raw)) {
      return { ok: false, error: method + ' ' + url + ' 超时（' + timeoutMs + 'ms）：Meilisearch 无响应，先确认它起来了。' };
    }
    const causeCode = e && e.cause && e.cause.code ? String(e.cause.code) : '';
    return {
      ok: false,
      error: method + ' ' + url + ' 连不上：' + snippet(raw, 160) + (causeCode ? '（' + causeCode + '）' : '')
        + '\n检查 MEILI_HOST / --host 是否指向正在运行的 Meilisearch（本机默认 http://127.0.0.1:7700）。',
    };
  }
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      detail: snippet(text),
      error: method + ' ' + url + ' 失败：HTTP ' + res.status + ' ' + (res.statusText || '') + '\n响应体（前 ' + BODY_SNIPPET + ' 字）：' + snippet(text),
    };
  }
  if (text && json === null) {
    return { ok: false, status: res.status, error: method + ' ' + url + ' 返回的不是 JSON（HTTP ' + res.status + '）：' + snippet(text) };
  }
  return { ok: true, status: res.status, json, text };
}

/** 索引设置负载：三组属性与站点口径一致 */
export function settingsPayload() {
  return {
    searchableAttributes: [...SITE_SEARCHABLE],
    filterableAttributes: [...SITE_FILTERABLE],
    sortableAttributes: [...SITE_SORTABLE],
  };
}

/**
 * 跑完整流程。永不抛异常，返回 { code, out, err }，由调用方决定怎么落地。
 * dryRun 时一次 HTTP 都不会发。
 */
export async function run(cfg, { log = () => {}, logErr = () => {} } = {}) {
  const indexUrl = cfg.host + '/indexes/' + encodeURIComponent(cfg.index);
  const loaded = loadGames(cfg.db, { limit: cfg.limit });
  if (loaded.error) {
    logErr(loaded.error);
    return { code: 1, out: [], err: [loaded.error] };
  }
  const docs = loaded.docs;
  const batches = chunk(docs, cfg.batch);

  if (cfg.dryRun) {
    const bytes = Buffer.byteLength(JSON.stringify(docs));
    log('[dry-run] 不会发任何 HTTP 请求');
    log('[dry-run] 源库：' + cfg.db + '（status=1 共 ' + loaded.totalInDb + ' 条）');
    log('[dry-run] 索引：' + (cfg.host || '(未设 MEILI_HOST/--host)') + '/indexes/' + cfg.index);
    log('[dry-run] 待推送文档：' + docs.length + ' 条，按 batch=' + cfg.batch + ' 分 ' + batches.length + ' 批（约 ' + bytes + ' 字节）');
    log('[dry-run] 请求形态：POST ' + indexUrl + '/documents?primaryKey=slug');
    if (cfg.setSettings) {
      log('[dry-run] --settings 会先 PUT ' + indexUrl + '/settings：'
        + 'searchableAttributes=' + SITE_SEARCHABLE.join(',') + ' / filterableAttributes='
        + SITE_FILTERABLE.join(',') + ' / sortableAttributes=' + SITE_SORTABLE.join(','));
    }
    for (let i = 0; i < Math.min(2, batches.length); i++) {
      log('[dry-run] 第 ' + (i + 1) + ' 批样本（' + batches[i].length + ' 条）：');
      for (const d of batches[i].slice(0, 3)) log('[dry-run]   ' + JSON.stringify(d));
    }
    log('DRY_RUN_JSON ' + JSON.stringify({
      dryRun: true, count: docs.length, totalInDb: loaded.totalInDb, batches: batches.length,
      batch: cfg.batch, index: cfg.index, host: cfg.host, settings: cfg.setSettings, sample: docs.slice(0, 3),
    }));
    return { code: 0, out: docs, err: [] };
  }

  if (!docs.length) {
    log('库里没有 status=1 的游戏，索引无需更新。');
    return { code: 0, out: [], err: [] };
  }

  log('源库：' + cfg.db + ' → 索引 ' + cfg.index + '（' + (cfg.host || '') + '）');
  log('待推送 ' + docs.length + ' 条，按 batch=' + cfg.batch + ' 分 ' + batches.length + ' 批');

  if (cfg.setSettings) {
    const r = await requestJson('PUT', indexUrl + '/settings', {
      body: settingsPayload(), key: cfg.key, timeoutMs: cfg.timeoutMs,
    });
    if (!r.ok) { logErr(r.error); return { code: 1, out: docs, err: [r.error] }; }
    const task = r.json && (r.json.taskUid ?? r.json.uid);
    log('索引设置已更新（' + (r.status === 202 ? '已受理' : 'HTTP ' + r.status) + '：searchableAttributes/'
      + 'filterableAttributes/sortableAttributes' + (task !== undefined ? '，task ' + task : '') + '）');
  }

  let pushed = 0;
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const r = await requestJson('POST', indexUrl + '/documents?primaryKey=slug', {
      body: b, key: cfg.key, timeoutMs: cfg.timeoutMs,
    });
    if (!r.ok) {
      logErr('第 ' + (i + 1) + '/' + batches.length + ' 批失败（已推送 ' + pushed + ' 条）：' + r.error);
      return { code: 1, out: docs, err: [r.error] };
    }
    pushed += b.length;
    const task = r.json && (r.json.taskUid ?? r.json.uid);
    log('第 ' + (i + 1) + '/' + batches.length + ' 批：推送 ' + b.length + ' 条 → ok（累计 ' + pushed + '/' + docs.length
      + (task !== undefined ? '，task ' + task : '') + '）');
  }
  log('完成：' + pushed + ' 条文档已提交到 ' + indexUrl + '（primaryKey=slug，重复运行覆盖同一批 slug，不会产生重复文档）');
  return { code: 0, out: docs, err: [] };
}

/** 进程入口：跑完按 code 设置退出码（不抛栈） */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = resolveConfig(argv, env);
  if (parsed.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (parsed.error) {
    process.stderr.write('错误：' + parsed.error + '\n\n' + USAGE + '\n');
    return 1;
  }
  const r = await run(parsed.cfg, {
    log: (s) => process.stdout.write(String(s) + '\n'),
    logErr: (s) => process.stderr.write(String(s) + '\n'),
  });
  return r.code;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write('未预期的错误：' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exitCode = 1;
  });
}
