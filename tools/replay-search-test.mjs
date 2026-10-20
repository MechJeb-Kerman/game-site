#!/usr/bin/env node
/**
 * 棋谱检索 / 导出（第九批）自测：/replays 筛选页 + GET /api/replays + GET /replays/export.json。
 * 两条线跑同一套断言：
 *   Express = 整树复制到 %TEMP% 下私有目录 + 真 server.js + 私有端口（默认 3320）+ 真 sid cookie；
 *   Worker  = tools/d1-local.mjs 的 LocalD1 + worker/app.js 的 default.fetch。
 * 用法：node tools/replay-search-test.mjs [--express|--worker]，KEEP_TMP=1 保留临时目录。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP_BASE = join(ROOT, '..', '.tmp-ver');
const KEEP = process.env.KEEP_TMP === '1';

let PASS = 0;
let FAIL = 0;
let cur = null;
const SECTIONS = [];
function section(name) { cur = { name: name, pass: 0, fail: 0 }; SECTIONS.push(cur); console.log('\n== ' + name + ' =='); }
function ok(name, cond, extra) {
  if (cond) { cur.pass++; PASS++; console.log('  ok   ' + name); }
  else { cur.fail++; FAIL++; console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : '   → ' + extra)); }
}
/** 对象比较：键排序后再 stringify，字段顺序不同不算差异（值必须逐项相同） */
function canon(v) {
  return JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]])) : val));
}
function eq(name, got, want) { const a = canon(got); const b = canon(want); ok(a === b ? name : name + '   got=' + a + ' want=' + b, a === b); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 脚手架（与 tools/feed-test.mjs 同一套） ---------- */

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split('\\').join('/');
      if (!rel) return true;
      if (rel === 'node_modules' || rel.indexOf('node_modules/') === 0) return false;
      if (rel === '.git' || rel.indexOf('.git/') === 0) return false;
      if (rel === 'dist' || rel.indexOf('dist/') === 0) return false;
      if (/^data\/.*\.db-(wal|shm)$/.test(rel)) return false;
      if (/^data\/(worker|probe|feed|smoke)/.test(rel)) return false;
      return true;
    }
  });
  try { symlinkSync(join(ROOT, 'node_modules'), join(to, 'node_modules'), 'junction'); } catch (e) { /* 已存在就算了 */ }
}

async function freePort(start) {
  for (let p = start; p < start + 60; p++) {
    const free = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error('从 ' + start + ' 起找不到空闲端口');
}

function startSite(cwd, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: cwd,
    env: Object.assign({}, process.env, { PORT: String(port), SITE_ORIGIN: 'http://127.0.0.1:' + port }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const site = { child: child, port: port, base: 'http://127.0.0.1:' + port, log: [] };
  const push = (buf) => { site.log.push(String(buf)); if (site.log.length > 400) site.log.shift(); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => site.log.push('spawn error: ' + e.message));
  return site;
}

async function waitReady(site, ms) {
  const banner = 'http://localhost:' + site.port;
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 25000)) {
    if (site.child.exitCode !== null) return { ok: false, reason: 'server 提前退出：' + site.log.join('').slice(-300) };
    if (site.log.join('').indexOf(banner) >= 0) {
      try { const r = await fetch(site.base + '/api/games?limit=1'); if (r.ok) return { ok: true, reason: '' }; } catch (e) { /* 还没起来 */ }
    }
    await sleep(120);
  }
  return { ok: false, reason: '等不到启动横幅：' + site.log.join('').slice(-300) };
}

function rmTree(dir) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true; }
    catch (e) {
      if (i === 7) { console.log('  （临时目录没删干净：' + e.message + '）'); return false; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return false;
}

function killSite(site) {
  if (!site || !site.child) return;
  try { spawnSync('taskkill', ['/pid', String(site.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  try { site.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
}

function sqlLine(line, db) {
  return async (sql, params) => {
    const a = params || [];
    if (line === 'express') return db.prepare(sql).run(...a);
    const st = db.prepare(sql);
    return await (a.length ? st.bind(...a) : st).run();
  };
}

/* ---------- 造数（id 9001xx / 9002xx..9008xx 段，避开真库与其它测试） ---------- */

const UID = 900007;
const UNAME = 'replay-probe-me';
const DNAME = '检索测试甲';
const W_TOKEN = 'f0'.repeat(32);
const BULK = 600;
const BULK_ID0 = 900201;
const NEWEST_ID = BULK_ID0 + BULK - 1;
const TOTAL_BASE = 17;
const TOTAL_ALL = TOTAL_BASE + BULK;

function at(y, m, d, h, mi) { return new Date(y, m - 1, d, h || 0, mi || 0, 0, 0).getTime(); }

const BULK_AT = at(2025, 1, 1, 0, 0);   // 全部早于 2026 的基础棋谱：任何 2026 日期窗口都筛不到它们

const REPLAY_SQL = 'INSERT INTO play_replays (id, game, room_code, host_name, guest_name, result, move_count, plays, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

const BASE_ROWS = [
  [900101, 'connect4', 'R001', 'Alpha', 'Beta', 'host', 12, 3, at(2026, 3, 1, 10, 0)],
  [900102, 'connect4', 'R002', 'alpha', 'Gamma', 'guest', 20, 0, at(2026, 3, 5, 10, 0)],
  [900103, 'connect4', 'R003', 'Delta', 'BETA', 'draw', 30, 1, at(2026, 3, 10, 10, 0)],
  [900104, 'reversi', 'R004', 'Epsilon', 'Alpha', 'host', 8, 5, at(2026, 3, 12, 10, 0)],
  [900105, 'reversi', 'R005', 'Alpha', 'zeta', 'guest', 44, 2, at(2026, 4, 1, 10, 0)],
  [900106, 'gomoku', 'R006', 'Eta', 'Theta', 'draw', 60, 0, at(2026, 4, 15, 10, 0)],
  [900107, 'gomoku', 'R007', DNAME, 'Iota', 'host', 9, 7, at(2026, 4, 20, 10, 0)],
  [900108, 'gomoku', 'R008', 'Kappa', DNAME, 'guest', 11, 1, at(2026, 4, 25, 10, 0)],
  [900109, 'connect4', 'R009', UNAME, 'Lambda', 'draw', 15, 0, at(2026, 5, 1, 10, 0)],
  [900110, 'reversi', 'R010', 'Mu', 'Nu', 'host', 5, 0, at(2026, 5, 2, 10, 0)],
  [900111, 'connect4', 'R011', 'P1', 'Q1', 'host', 6, 0, at(2026, 5, 3, 10, 0)],
  [900112, 'connect4', 'R012', 'P2', 'Q2', 'guest', 7, 0, at(2026, 5, 4, 10, 0)],
  [900113, 'connect4', 'R013', 'P3', 'Q3', 'draw', 8, 0, at(2026, 5, 5, 10, 0)],
  [900114, 'connect4', 'R014', 'P4', 'Q4', 'host', 9, 0, at(2026, 5, 6, 10, 0)],
  [900115, 'connect4', 'R015', 'Wild%Card', 'x_y', 'host', 10, 0, at(2026, 5, 7, 10, 0)],
  [900116, 'chess', 'R016', ' ' + DNAME, 'Sigma', 'host', 13, 0, at(2026, 5, 8, 10, 0)],
  [900117, 'bogus-game', 'R017', 'Page', 'Route', 'host', 14, 0, at(2026, 5, 9, 10, 0)]
];

async function seedAll(run) {
  await run('DELETE FROM play_replays');
  for (const row of BASE_ROWS) await run(REPLAY_SQL, row);
  for (let i = 0; i < BULK; i++) {
    const id = BULK_ID0 + i;
    await run(REPLAY_SQL, [id, 'chess', 'B' + id, 'Bulk', 'BulkTarget', 'host', 1, 0, BULK_AT + i]);
  }
}

/** 种一个真用户（sessions.user_id 有外键，必须先有 users 行才能建会话） */
async function seedUser(run) {
  await run('DELETE FROM sessions WHERE user_id = ?', [UID]);
  try { await run('DELETE FROM users WHERE id = ? OR username = ?', [UID, UNAME]); }
  catch (e) { console.log('  （清同 id/同名的旧用户失败，忽略：' + e.message + '）'); }
  await run('INSERT INTO users (id, username, display_name, pass_hash, pass_salt) VALUES (?, ?, ?, ?, ?)', [UID, UNAME, DNAME, 'x', 'y']);
}

/* ---------- 改前的 replayList（基线：与本批新实现在无筛选时逐项比对） ---------- */

function baselineRow(row) {
  return {
    id: Number(row.id), game: row.game, hostName: row.host_name || '黑方', guestName: row.guest_name || '白方',
    result: row.result || '', winner: baselineWinner(row), moveCount: Number(row.move_count || 0),
    plays: Number(row.plays || 0), createdAt: Number(row.created_at || 0)
  };
}
function baselineWinner(row) {
  const res = String((row && row.result) || '');
  if (res === 'host') return row.host_name || '房主';
  if (res === 'guest') return row.guest_name || '挑战者';
  if (res === 'draw') return '和棋';
  return '';
}
async function baselineReplayList(read, cleanGame, opts) {
  const o = opts || {};
  const g = cleanGame(o.game);
  const lim = Math.min(Math.max(Number(o.limit) || 12, 1), 50);
  const off = Math.max(Number(o.offset) || 0, 0);
  const cols = 'id, game, host_name, guest_name, result, move_count, plays, created_at';
  const rows = g
    ? await read('SELECT ' + cols + ' FROM play_replays WHERE game = ? ORDER BY id DESC LIMIT ? OFFSET ?', [g, lim, off])
    : await read('SELECT ' + cols + ' FROM play_replays ORDER BY id DESC LIMIT ? OFFSET ?', [lim, off]);
  const cnt = g
    ? await read('SELECT COUNT(*) AS n FROM play_replays WHERE game = ?', [g])
    : await read('SELECT COUNT(*) AS n FROM play_replays', []);
  return { total: Number((cnt[0] && cnt[0].n) || 0), items: rows.map(baselineRow) };
}

/* ---------- 数据层断言（两条线共用） ---------- */

async function checkData(tag, ctx) {
  const replayList = ctx.replayList;
  const read = ctx.read;
  const cleanGame = ctx.cleanGame;
  const list = async (o) => await replayList(o);
  const ids = (r) => r.items.map((x) => x.id);

  section(tag + '：数据层 — 无参 / 旧参数与改前基线逐项一致');
  const cases = [{}, { game: 'connect4' }, { game: '' }, { game: 'bogus-game' }, { limit: 5 }, { limit: 0 },
    { limit: 'abc' }, { limit: 999 }, { offset: -3 }, { game: 'gomoku', limit: 3, offset: 2 }, { game: 'nosuch', limit: 4 }];
  for (const c of cases) {
    const got = await list(c);
    const want = await baselineReplayList(read, cleanGame, c);
    eq(tag + ' ' + JSON.stringify(c) + ' = 改前实现', got, want);
  }
  eq(tag + ' 无参 total = ' + TOTAL_ALL, (await list({})).total, TOTAL_ALL);

  section(tag + '：数据层 — game / player / result 过滤');
  eq(tag + ' game=connect4', (await list({ game: 'connect4' })).total, 9);
  eq(tag + ' game=reversi', (await list({ game: 'reversi' })).total, 3);
  eq(tag + ' game=gomoku', (await list({ game: 'gomoku' })).total, 3);
  eq(tag + ' game=chess（含 600 条批量）', (await list({ game: 'chess' })).total, 601);
  eq(tag + ' game=bogus-game（数据层认任意合法 slug）', (await list({ game: 'bogus-game' })).total, 1);
  eq(tag + ' player=alpha（不区分大小写子串）', (await list({ player: 'alpha' })).total, 4);
  eq(tag + ' player=ALPHA（同上，大写）', (await list({ player: 'ALPHA' })).total, 4);
  eq(tag + ' player=BETA', (await list({ player: 'BETA' })).total, 2);
  eq(tag + ' player=%（LIKE 通配符按字面）', (await list({ player: '%' })).total, 1);
  eq(tag + ' player=_（LIKE 通配符按字面）', (await list({ player: '_' })).total, 1);
  eq(tag + ' player=nobody-xyz', (await list({ player: 'nobody-xyz' })).total, 0);
  eq(tag + ' player=BulkTarget', (await list({ player: 'BulkTarget' })).total, BULK);
  eq(tag + ' player 与 game 同时生效', (await list({ game: 'connect4', player: 'alpha' })).total, 2);
  eq(tag + ' result=host', (await list({ result: 'host' })).total, 9 + BULK);
  eq(tag + ' result=guest', (await list({ result: 'guest' })).total, 4);
  eq(tag + ' result=draw', (await list({ result: 'draw' })).total, 4);
  eq(tag + ' result=bogus（非法值忽略，不报错）', (await list({ result: 'bogus' })).total, TOTAL_ALL);

  section(tag + '：数据层 — 日期区间（闭区间）');
  eq(tag + ' from=2026-04-01 to=2026-04-30', (await list({ from: '2026-04-01', to: '2026-04-30' })).total, 4);
  eq(tag + ' from=to=2026-04-01（当天含 10:00 那条）', (await list({ from: '2026-04-01', to: '2026-04-01' })).total, 1);
  eq(tag + ' to=2026-04-01（闭区间含当天最后一毫秒）', (await list({ to: '2026-04-01', player: 'Alpha' })).total, 4);
  eq(tag + ' to=2026-03-31（4/1 那条被排除）', (await list({ to: '2026-03-31', player: 'Alpha' })).total, 3);
  eq(tag + ' from=2026-05-01', (await list({ from: '2026-05-01' })).total, 9);
  eq(tag + ' from=毫秒时间戳', (await list({ from: String(at(2026, 5, 1, 0, 0)) })).total, 9);
  eq(tag + ' to=毫秒（正好等于那条的毫秒，含边界）', (await list({ to: String(at(2026, 4, 1, 10, 0)), player: 'Alpha' })).total, 4);
  eq(tag + ' to=毫秒（早一分钟，排除）', (await list({ to: String(at(2026, 4, 1, 9, 59)), player: 'Alpha' })).total, 3);
  eq(tag + ' from=秒级时间戳（自动 ×1000）', (await list({ from: String(Math.floor(at(2026, 5, 1, 0, 0) / 1000)) })).total, 9);
  eq(tag + ' from=2026-02-31（非法日期忽略）', (await list({ from: '2026-02-31' })).total, TOTAL_ALL);
  eq(tag + ' to=xx（无法解析忽略）', (await list({ to: 'xx' })).total, TOTAL_ALL);
  eq(tag + ' from>to（空结果，不报错）', (await list({ from: '2026-04-01', to: '2026-03-01' })).total, 0);

  section(tag + '：数据层 — 只看我的（按昵称精确匹配 / TRIM / 大小写不敏感）');
  eq(tag + ' mine=[' + DNAME + ',' + UNAME + ']', (await list({ mine: [DNAME, UNAME] })).total, 4);
  eq(tag + ' mine 命中 id 倒序', ids(await list({ mine: [DNAME, UNAME] })), [900116, 900109, 900108, 900107]);
  eq(tag + ' mine=[' + DNAME + ']（含前后空格的昵称也命中）', (await list({ mine: [DNAME] })).total, 3);
  eq(tag + ' mine=[检索] 不是子串匹配', (await list({ mine: ['检索'] })).total, 0);
  eq(tag + ' mine=[]（空列表 = 不筛）', (await list({ mine: [] })).total, TOTAL_ALL);
  eq(tag + ' mine=[nobody]', (await list({ mine: ['nobody'] })).total, 0);
  eq(tag + ' mine 与 player 同时生效', (await list({ mine: [DNAME], player: 'Iota' })).total, 1);

  section(tag + '：数据层 — total 是过滤后总数 / 分页不重叠 / 参数夹紧');
  const f2 = await list({ player: 'alpha', limit: 2 });
  eq(tag + ' limit=2 时 total 仍是过滤后总数', f2.total, 4);
  eq(tag + ' limit=2 时 items 只回 2 条', f2.items.length, 2);
  const pg1 = await list({ limit: 5, offset: 0 });
  const pg2 = await list({ limit: 5, offset: 5 });
  eq(tag + ' 第 1 页 5 条', pg1.items.length, 5);
  eq(tag + ' 第 2 页 5 条', pg2.items.length, 5);
  eq(tag + ' 两页无重叠', pg1.items.filter((x) => pg2.items.some((y) => y.id === x.id)).length, 0);
  eq(tag + ' 第 1 页首条是最新棋谱', pg1.items[0].id, NEWEST_ID);
  eq(tag + ' 第 2 页首条紧接其后', pg2.items[0].id, NEWEST_ID - 5);
  const b1 = await list({ player: 'BulkTarget', limit: 20, offset: 0 });
  const b2 = await list({ player: 'BulkTarget', limit: 20, offset: 20 });
  eq(tag + ' 600 条筛选后分页无重叠', b1.items.filter((x) => b2.items.some((y) => y.id === x.id)).length, 0);
  eq(tag + ' 末尾页 20 条', (await list({ player: 'BulkTarget', limit: 20, offset: 580 })).items.length, 20);
  eq(tag + ' 越界页 0 条', (await list({ player: 'BulkTarget', limit: 20, offset: 600 })).items.length, 0);
  eq(tag + ' 翻页时 total 不变', (await list({ player: 'BulkTarget', limit: 20, offset: 580 })).total, BULK);
  eq(tag + ' limit=99999 默认夹到 50', (await list({ limit: 99999 })).items.length, 50);
  eq(tag + ' limit=99999 maxLimit=500 夹到 500', (await list({ limit: 99999, maxLimit: 500 })).items.length, 500);
  eq(tag + ' maxLimit 超过 REPLAY_MAX_LIMIT 仍夹到 500', (await list({ limit: 99999, maxLimit: 5000 })).items.length, 500);
  eq(tag + ' maxLimit=0 回落成 50', (await list({ limit: 99999, maxLimit: 0 })).items.length, 50);
  eq(tag + ' limit=0 回落成默认 12（旧口径，与改前实现一致）', (await list({ limit: 0 })).items.length, 12);
  eq(tag + ' limit=-5 夹到 1', (await list({ limit: -5 })).items.length, 1);
  eq(tag + ' offset=-9 夹到 0', (await list({ offset: -9 })).items[0].id, NEWEST_ID);
  eq(tag + ' REPLAY_MAX_LIMIT=500', ctx.REPLAY_MAX_LIMIT, 500);
  eq(tag + ' replayFilters：mine=on → true', ctx.replayFilters({ mine: 'on' }).mine, true);
  eq(tag + ' replayFilters：mine=TRUE → true', ctx.replayFilters({ mine: 'TRUE' }).mine, true);
  eq(tag + ' replayFilters：mine=no → false', ctx.replayFilters({ mine: 'no' }).mine, false);
  eq(tag + ' replayFilters：非法日期 fromMs=null', ctx.replayFilters({ from: '2026-02-31' }).fromMs, null);
  eq(tag + ' replayFilters：to=2026-04-01 是当天 23:59:59.999', ctx.replayFilters({ to: '2026-04-01' }).toMs, at(2026, 4, 2, 0, 0) - 1);
  eq(tag + ' replayFilters：fromDay 回填', ctx.replayFilters({ from: '2026-04-01' }).fromDay, '2026-04-01');
  eq(tag + ' replayFilters：player 去空格', ctx.replayFilters({ player: '  abc  ' }).player, 'abc');
  eq(tag + ' replayFilters：player 截断到 32 字', ctx.replayFilters({ player: 'x'.repeat(40) }).player.length, 32);
  eq(tag + ' replayFilters：result 只认三种', ctx.replayFilters({ result: 'bogus' }).result, '');
  eq(tag + ' replayFilters：game 非法 → 空串', ctx.replayFilters({ game: '!!' }).game, '');
}

/* ---------- HTTP 断言（两条线共用） ---------- */

async function checkHttp(tag, ctx) {
  const call = ctx.call;
  const auth = ctx.auth;
  const spoof = ctx.spoof;
  const stamp = ctx.stamp();
  const get = async (p, init) => {
    const r = await call(p, init);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: r.status, text: text, body: body, ct: r.headers.get('content-type'), cc: r.headers.get('cache-control'), cd: r.headers.get('content-disposition') };
  };
  const has = (h, s) => h.text.indexOf(s) >= 0;

  section(tag + '：/replays 页面');
  const anon = await get('/replays');
  ok(tag + ' 未登录 /replays 200', anon.status === 200, 'status=' + anon.status);
  ok(tag + ' 有筛选表单', has(anon, '<form class="filters" method="get" action="/replays"'));
  ok(tag + ' 表单五件套 + 提交', has(anon, 'name="game"') && has(anon, 'name="player"') && has(anon, 'name="result"') && has(anon, 'name="from"') && has(anon, 'name="to"') && has(anon, '>筛选</button>'));
  ok(tag + ' 六个游戏 chip + 下拉选项', ['connect4', 'reversi', 'draughts', 'gomoku', 'xiangqi', 'chess'].every((s) => has(anon, '/replays?game=' + s)) && has(anon, 'value="chess"'));
  ok(tag + ' 导出入口指向 /replays/export.json', has(anon, '/replays/export.json'));
  ok(tag + ' 未登录不渲染「只看我的」勾选', !has(anon, 'name="mine"'));
  ok(tag + ' 未登录给出登录提示', has(anon, '/login?next=%2Freplays') && has(anon, '只看我的'));
  ok(tag + ' 未登录也能看列表（共 ' + TOTAL_ALL + ' 条）', has(anon, '共 ' + TOTAL_ALL + ' 条'));
  ok(tag + ' 首屏是最新的棋谱', has(anon, '/replay/' + NEWEST_ID));
  const anonMine = await get('/replays?mine=1');
  ok(tag + ' 未登录 ?mine=1 不生效', has(anonMine, '共 ' + TOTAL_ALL + ' 条'));
  const me = await get('/replays', { headers: auth });
  ok(tag + ' 登录后渲染「只看我的」勾选', has(me, 'name="mine"') && has(me, '只看我的'));
  const mine = await get('/replays?mine=1', { headers: auth });
  ok(tag + ' ?mine=1 只看我的 = 4 条', has(mine, '共 4 条'));
  ok(tag + ' ?mine=1 命中自己名下的棋谱', myRowOk(mine.text));
  ok(tag + ' ?mine=1 不出现别人的棋谱', !has(mine, '/replay/900117'));
  ok(tag + ' 勾选状态回填 checked', has(mine, 'name="mine" value="1" checked'));
  const filt = await get('/replays?player=Alpha&result=host');
  ok(tag + ' 组合筛选 = 2 条', has(filt, '共 2 条'));
  ok(tag + ' 组合筛选只列命中的行', has(filt, '/replay/900104') && has(filt, '/replay/900101') && !has(filt, '/replay/900102'));
  ok(tag + ' 导出链接保留筛选条件', has(filt, '/replays/export.json?player=Alpha&result=host') || has(filt, '/replays/export.json?player=Alpha&amp;result=host'));
  const dater = await get('/replays?from=2026-04-01&to=2026-04-30');
  ok(tag + ' 日期筛选 = 4 条', has(dater, '共 4 条'));
  ok(tag + ' 日期回填到 input value', has(dater, 'name="from" value="2026-04-01"') && has(dater, 'name="to" value="2026-04-30"'));
  const page1 = await get('/replays?player=BulkTarget');
  ok(tag + ' 600 条筛选页 = 共 600 条', has(page1, '共 600 条'));
  ok(tag + ' 翻页链接保留筛选条件', has(page1, '/replays?player=BulkTarget&page=2'));
  const page2 = await get('/replays?player=BulkTarget&page=2');
  ok(tag + ' 第 2 页文案', has(page2, '第 2 / 30 页'));
  ok(tag + ' 第 2 页有上一页且带筛选', has(page2, '/replays?player=BulkTarget&page=1'));
  ok(tag + ' page=999 夹到最后一页', has(await get('/replays?player=BulkTarget&page=999'), '第 30 / 30 页'));
  ok(tag + ' page=abc 不 500', (await get('/replays?page=abc')).status === 200);
  const bad = await get('/replays?game=bogus-game&from=2026-02-31&to=xx&limit=abc&page=-3&result=zzz');
  ok(tag + ' 非法参数页面 200', bad.status === 200, 'status=' + bad.status);
  ok(tag + ' 非法 game 当没填（不是空结果）', has(bad, '共 ' + TOTAL_ALL + ' 条'));
  ok(tag + ' player=%25 按字面匹配', has(await get('/replays?player=%25'), '共 1 条'));
  const none = await get('/replays?player=nobody-here-xyz');
  ok(tag + ' 空结果 200 + 专属文案', none.status === 200 && has(none, '没有符合条件的棋谱'));
  ok(tag + ' 空结果带「看全部棋谱」链接', has(none, '<a href="/replays">看全部棋谱</a>'));
  const evil = await get('/replays?player=' + encodeURIComponent('<script>alert(1)</script>'));
  ok(tag + ' 玩家名被 esc()（无裸标签）', has(evil, '&lt;script&gt;') && !has(evil, '<script>alert(1)'));

  section(tag + '：JSON 导出接口');
  const e1 = await get('/api/replays');
  ok(tag + ' /api/replays 200', e1.status === 200, 'status=' + e1.status);
  eq(tag + ' content-type', e1.ct, 'application/json; charset=utf-8');
  eq(tag + ' cache-control', e1.cc, 'no-store');
  eq(tag + ' 非附件版没有 content-disposition', e1.cd, null);
  ok(tag + ' 形状 { ok, total, count, items }', e1.body && e1.body.ok === true && e1.body.total === TOTAL_ALL && e1.body.count === 200 && Array.isArray(e1.body.items) && e1.body.items.length === 200);
  ok(tag + ' 默认上限 200', e1.body && e1.body.count === 200, 'count=' + (e1.body && e1.body.count));
  ok(tag + ' id 倒序 + 字段齐全', e1.body && e1.body.items[0].id === NEWEST_ID && typeof e1.body.items[0].createdAt === 'number' && typeof e1.body.items[0].hostName === 'string' && e1.body.items[0].game === 'chess');
  eq(tag + ' ?limit=250 → 250 条', (await get('/api/replays?limit=250')).body.count, 250);
  eq(tag + ' ?limit=500 → 正好是上限 500 条', (await get('/api/replays?limit=500')).body.count, 500);
  eq(tag + ' ?limit=99999 → 夹到 500', (await get('/api/replays?limit=99999')).body.count, 500);
  eq(tag + ' ?limit=0 → 夹到 1', (await get('/api/replays?limit=0')).body.count, 1);
  eq(tag + ' ?limit=-5 → 夹到 1', (await get('/api/replays?limit=-5')).body.count, 1);
  eq(tag + ' ?limit=abc → 默认 200', (await get('/api/replays?limit=abc')).body.count, 200);
  const e7 = (await get('/api/replays?game=connect4&result=draw')).body;
  eq(tag + ' 筛选后的 total/count', [e7.total, e7.count], [3, 3]);
  eq(tag + ' 筛选后的 id 顺序', e7.items.map((x) => x.id), [900113, 900109, 900103]);
  const e8 = await get('/replays/export.json');
  ok(tag + ' /replays/export.json 200', e8.status === 200, 'status=' + e8.status);
  eq(tag + ' 附件 Content-Disposition 用当天日期', e8.cd, 'attachment; filename=replays-' + stamp + '.json');
  eq(tag + ' 附件版 content-type', e8.ct, 'application/json; charset=utf-8');
  eq(tag + ' 附件版 cache-control', e8.cc, 'no-store');
  ok(tag + ' 附件版形状', e8.body && e8.body.ok === true && e8.body.total === TOTAL_ALL && e8.body.count === 200 && e8.body.items.length === 200);
  const e9 = (await get('/replays/export.json?player=BulkTarget&limit=3')).body;
  eq(tag + ' 附件版带筛选 + limit', [e9.total, e9.count], [BULK, 3]);
  ok(tag + ' 未登录也能导出（上面就是匿名请求）', e8.status === 200 && e9.count === 3);

  section(tag + '：导出限流（60 次 / 60 秒 / IP）');
  const IP = '10.9.9.9';
  const pageStatus = [];
  for (let i = 0; i < 5; i++) pageStatus.push((await call('/replays', { headers: spoof(IP) })).status);
  eq(tag + ' HTML 页面不计入导出配额（5 次都 200）', pageStatus, [200, 200, 200, 200, 200]);
  const sts = [];
  let last = null;
  for (let i = 0; i < 61; i++) {
    const r = await call('/api/replays?limit=1&player=Alpha', { headers: spoof(IP) });
    sts.push(r.status);
    if (i === 60) { try { last = JSON.parse(await r.text()); } catch (e) { last = null; } } else { await r.text(); }
  }
  eq(tag + ' 前 60 次都是 200（页面请求没算进去）', sts.slice(0, 60), new Array(60).fill(200));
  eq(tag + ' 第 61 次 429', sts[60], 429);
  ok(tag + ' 429 响应体是 busy', last && last.ok === false && last.error === 'busy', JSON.stringify(last));
  const after = await get('/api/replays?limit=1');
  ok(tag + ' 限流按 IP 隔离（默认 IP 仍 200）', after.status === 200, 'status=' + after.status);
}

function myRowOk(html) {
  return html.indexOf('/replay/900107') >= 0 && html.indexOf('/replay/900108') >= 0 &&
    html.indexOf('/replay/900109') >= 0 && html.indexOf('/replay/900116') >= 0;
}

/* ---------- Express 线 ---------- */

async function runExpress() {
  mkdirSync(TMP_BASE, { recursive: true });
  const tmp = mkdtempSync(join(TMP_BASE, 'replay-express-'));
  let site = null;
  let closeDb = null;
  try {
    copyTree(ROOT, tmp);
    const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
    closeDb = () => { try { dbmod.db.close(); } catch (e) { /* 忽略 */ } };
    if (typeof dbmod.migrate === 'function') dbmod.migrate();
    const PS = await import(pathToFileURL(join(tmp, 'src', 'play-store.js')).href);
    const PJ = await import(pathToFileURL(join(tmp, 'src', 'play.js')).href);
    const AUTH = await import(pathToFileURL(join(tmp, 'src', 'auth.js')).href);
    const DAILY = await import(pathToFileURL(join(tmp, 'src', 'daily.js')).href);
    const run = sqlLine('express', dbmod.db);
    await seedAll(run);
    await seedUser(run);
    const read = async (sql, params) => dbmod.db.prepare(sql).all(...(params || []));
    await checkData('express', {
      replayList: (o) => PS.replayList(o), replayFilters: (r) => PS.replayFilters(r), read: read,
      cleanGame: PJ.cleanGame, REPLAY_MAX_LIMIT: PS.REPLAY_MAX_LIMIT
    });

    const port = await freePort(3320);
    site = startSite(tmp, port);
    const ready = await waitReady(site);
    ok('express：私有端口 ' + port + ' 起来并回了 /api/games', ready.ok, ready.reason);
    if (!ready.ok) return;

    const token = AUTH.createSession(UID);
    eq('express SESSION_COOKIE', AUTH.SESSION_COOKIE, 'sid');
    ok('express createSession 返回 64 位 token', /^[a-f0-9]{64}$/.test(String(token)), String(token));
    await checkHttp('express', {
      call: (p, init) => fetch(site.base + p, init),
      auth: { cookie: 'sid=' + token },
      spoof: (ip) => ({ 'x-forwarded-for': ip }),
      stamp: () => DAILY.dayKey().replace(/-/g, '')
    });
  } finally {
    killSite(site);
    if (closeDb) closeDb();
    if (KEEP) console.log('  （保留临时目录 ' + tmp + '）'); else rmTree(tmp);
  }
}

/* ---------- Worker 线 ---------- */

async function runWorker() {
  mkdirSync(TMP_BASE, { recursive: true });
  const file = join(TMP_BASE, 'replay-worker-' + Date.now() + '.db');
  let db = null;
  try {
    const D1 = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
    db = new D1.LocalD1(file);
    const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
    await schema.migrate(db);
    if (typeof schema.ensureColumns === 'function') await schema.ensureColumns(db);
    const WPS = await import(pathToFileURL(join(ROOT, 'worker', 'play-store.js')).href);
    const PJ = await import(pathToFileURL(join(ROOT, 'src', 'play.js')).href);
    const DAILY = await import(pathToFileURL(join(ROOT, 'src', 'daily.js')).href);
    const app = (await import(pathToFileURL(join(ROOT, 'worker', 'app.js')).href)).default;
    const run = sqlLine('worker', db);
    await seedAll(run);
    const read = async (sql, params) => {
      const st = db.prepare(sql);
      const r = await (params && params.length ? st.bind(...params) : st).all();
      return (r && r.results) || [];
    };
    await checkData('worker', {
      replayList: (o) => WPS.replayList(db, o), replayFilters: (r) => WPS.replayFilters(r), read: read,
      cleanGame: PJ.cleanGame, REPLAY_MAX_LIMIT: WPS.REPLAY_MAX_LIMIT
    });

    await seedUser(run);
    await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime(\'now\',\'localtime\',\'+30 days\'))', [W_TOKEN, UID]);
    const env = { DB: db, SITE_ORIGIN: 'http://replay.test', MAIL_TICK: '0' };
    await checkHttp('worker', {
      call: (p, init) => app.fetch(new Request('http://replay.test' + p, init), env),
      auth: { cookie: 'sid=' + W_TOKEN },
      spoof: (ip) => ({ 'cf-connecting-ip': ip }),
      stamp: () => DAILY.dayKey().replace(/-/g, '')
    });
  } finally {
    try { if (db) db.close(); } catch (e) { /* 忽略 */ }
    for (const f of [file, file + '-wal', file + '-shm']) { try { rmSync(f, { force: true }); } catch (e) { /* 忽略 */ } }
  }
}

/* ---------- 入口 ---------- */

const argv = process.argv.slice(2);
const only = argv.indexOf('--express') >= 0 ? 'express' : (argv.indexOf('--worker') >= 0 ? 'worker' : 'both');
try {
  if (only === 'express' || only === 'both') await runExpress();
  if (only === 'worker' || only === 'both') await runWorker();
} catch (e) {
  FAIL++;
  console.log('\n!! 抛异常：' + (e && e.stack ? e.stack : e));
}
console.log('');
for (const s of SECTIONS) console.log(s.name + '：' + s.pass + ' 通过 / ' + s.fail + ' 失败');
console.log('合计：' + PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
