/**
 * tools/worker-search-test.mjs —— Worker 线「搜索适配层 + 榜单缓存」接线集成测试（零依赖）
 *
 *   node tools/worker-search-test.mjs
 *   WORKER_SEARCH_BASELINE=D:/CODE/.tmp-ver/pre-wiring-worker-app.js node tools/worker-search-test.mjs
 *
 * 注入方式：worker/app.js 导出 appFetch(request, env)，测试直接
 *     await mod.default.fetch(new Request(BASE + path), env)
 * 调它，env 里放 LocalD1（tools/d1-local.mjs，node:sqlite 假 D1）、ASSETS 桩，以及假的
 * MEILI_HOST / MEILI_API_KEY / MEILI_INDEX。局限：appFetch 只有 (request, env) 两个形参，
 * 没有 ExecutionContext，所以可选的 Cloudflare Cache API 层没法用 waitUntil（见 worker/app.js 注释）；
 * 测试里用 globalThis.caches 假对象覆盖「有 / 坏 / 抛错」三种情况。
 *
 * 断言三件事：
 *   ① 配了 MEILI_HOST：/search 与 /api/search/suggest 用 Meili 命中渲染（假 Meili 收到 POST + Bearer），
 *      渲染字段仍来自 D1（映射层按 slug 回库取整行）；
 *   ② 假 Meili 500 / 端口关掉 / 一直不回（超时）：请求仍 200、用 D1 兜底渲染，且只打一行 [search] fallback；
 *      连续失败 3 次后熔断，第 4 次不再打网络；
 *   ③ 未配 MEILI_HOST：输出与「照原路径自己渲染」逐字节一致，并与改前基线模块
 *      （WORKER_SEARCH_BASELINE，默认 D:/CODE/.tmp-ver/pre-wiring-worker-app.js）逐字节一致；
 *      假 Meili 收到 0 个请求。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalD1 } from './d1-local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = process.env.WORKER_SEARCH_TMP || 'D:/CODE/.tmp-ver';
const BASE = 'http://127.0.0.1:4477';           // 固定 origin：逐字节对比要求两边同一个 origin
const DB_FILE = join(ROOT, 'data', 'worker-search-test.db');
const APP_URL = pathToFileURL(join(ROOT, 'worker', 'app.js')).href;
const BASELINE = process.env.WORKER_SEARCH_BASELINE || join(TMP, 'pre-wiring-worker-app.js');

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); return true; }
  fail++; failures.push(name);
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + extra));
  return false;
}
function is(name, got, want) { return ok(name + '（' + JSON.stringify(got) + '）', got === want, 'want ' + JSON.stringify(want)); }
function skip(name, why) { skipped++; console.log('  skip ' + name + ' —— ' + why); }
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const has = (hay, needle) => String(hay).indexOf(needle) >= 0;

/* ---------- 假 Meilisearch ---------- */
function startFakeMeili(opts) {
  const o = opts || {};
  const state = { requests: [], mode: o.mode || 'ok', hits: (o.hits || []).slice(), hang: !!o.hang, estimated: null, sockets: new Set() };
  const server = createServer(function (req, res) {
    if (state.hang) {
      // 永远不回：验证 SEARCH_TIMEOUT_MS 超时后走兜底（客户端会 abort，这里吞掉 socket 错误）
      state.sockets.add(res.socket);
      res.socket.on('error', function () {});
      res.socket.on('close', function () { state.sockets.delete(res.socket); });
      return;
    }
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = { __bad: String(e) }; }
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body });
      if (state.mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'fake meili boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        hits: state.hits,
        estimatedTotalHits: state.estimated === null ? state.hits.length : state.estimated,
        query: body && body.q
      }));
    });
    req.on('error', function () {});
  });
  return new Promise(function (done) {
    server.on('error', function () {});
    server.listen(0, '127.0.0.1', function () {
      done({
        state: state,
        url: 'http://127.0.0.1:' + server.address().port,
        close: function () {
          for (const s of state.sockets) { try { s.destroy(); } catch (e) { /* 已关 */ } }
          state.sockets.clear();
          try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) { /* 老 Node */ }
          return new Promise(function (r) { server.close(function () { r(); }); });
        }
      });
    });
  });
}

/* ---------- 调 worker ---------- */
async function call(mod, p, env) {
  const res = await mod.default.fetch(new Request(BASE + p), env);
  return { status: res.status, body: await res.text() };
}
async function withLogs(fn) {
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = function () { lines.push(Array.prototype.map.call(arguments, String).join(' ')); };
  console.error = console.log;
  let value;
  try { value = await fn(); } finally { console.log = origLog; console.error = origErr; }
  return { value: value, lines: lines };
}
const fbLines = (lines) => lines.filter((l) => l.indexOf('[search] fallback') === 0);

function makeEnv(db, extra) {
  return Object.assign({
    DB: db,
    ASSETS: { fetch: async function () { return new Response('nope', { status: 404 }); } },
    SITE_ORIGIN: BASE,
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'admin-12345678'
  }, extra || {});
}

/* ---------- 基线模块（改前原文）导入：把相对 import 改写成绝对 file:// URL ---------- */
function importBaseline(file) {
  const raw = readFileSync(file, 'utf8');
  const rewritten = raw.replace(/from\s+(['"])(\.[^'"]+)\1/g, function (m, q, spec) {
    return 'from ' + q + pathToFileURL(resolve(join(ROOT, 'worker'), spec)).href + q;
  });
  const tmpFile = join(TMP, 'baseline-rewritten-' + sha(raw).slice(0, 8) + '.mjs');
  writeFileSync(tmpFile, rewritten, 'utf8');
  return import(pathToFileURL(tmpFile).href);
}

/* ================= 主流程 ================= */
const evidence = [];
const servers = [];
let db = null;

async function main() {
  mkdirSync(TMP, { recursive: true });
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  db = new LocalD1(DB_FILE);
  const mod = await import(APP_URL);

  // 预热：ensureReady 建表 + 种子数据（23 款）
  const plainEnv = makeEnv(db);
  const warm = await withLogs(() => call(mod, '/', plainEnv));
  ok('预热首页 200（ensureReady 建表 + 种子）', warm.value.status === 200, 'status=' + warm.value.status);

  console.log('');
  console.log('【1】配了 MEILI_HOST：Meili 当主后端');
  const meili = await startFakeMeili({ hits: [{ slug: 'tetris', title: 'TETRIS-FAKE', _rankingScore: 0.91 }] });
  servers.push(meili);
  const envMeili = makeEnv(db, { MEILI_HOST: meili.url, MEILI_API_KEY: 'test-key-123', MEILI_INDEX: 'games' });

  const r1 = await withLogs(() => call(mod, '/search?q=zzzqqq', envMeili));
  is('/search?q=zzzqqq → 200', r1.value.status, 200);
  ok('页面按 Meili 命中渲染（D1 里的 tetris 行）', has(r1.value.body, 'data-slug="tetris"'), '没看到 tetris 卡片');
  ok('渲染字段取自 D1（不是 Meili 返回的标题）', has(r1.value.body, '俄罗斯方块') && !has(r1.value.body, 'TETRIS-FAKE'));
  ok('总数用 Meili 的 estimatedTotalHits（1）', has(r1.value.body, '共找到 <b>1</b> 款游戏'));
  ok('没有打降级日志', fbLines(r1.lines).length === 0, JSON.stringify(fbLines(r1.lines)));
  is('假 Meili 收到 1 个请求', meili.state.requests.length, 1);
  const q1 = meili.state.requests[0] || { headers: {}, body: {} };
  is('请求方法 POST', q1.method, 'POST');
  is('请求路径 /indexes/games/search', q1.url, '/indexes/games/search');
  is('带 Bearer 鉴权', q1.headers.authorization, 'Bearer test-key-123');
  is('body.q 透传查询串', q1.body.q, 'zzzqqq');
  is('body.limit 用调用方的 60', q1.body.limit, 60);
  is('body.showRankingScore', q1.body.showRankingScore, true);

  const s1 = await withLogs(() => call(mod, '/api/search/suggest?q=zzzqqq', envMeili));
  is('/api/search/suggest?q=zzzqqq → 200', s1.value.status, 200);
  let s1json = null;
  try { s1json = JSON.parse(s1.value.body); } catch (e) { s1json = null; }
  ok('suggest 走 Meili 命中（items[0]=tetris，字段取 D1）',
    !!s1json && s1json.items.length === 1 && s1json.items[0].slug === 'tetris' &&
    s1json.items[0].title === '俄罗斯方块' && s1json.items[0].emoji !== undefined,
    JSON.stringify(s1json));
  is('假 Meili 又收到 1 个请求（共 2）', meili.state.requests.length, 2);
  is('suggest 那条请求 limit=6', meili.state.requests[1].body.limit, 6);

  const envIdx = makeEnv(db, { MEILI_HOST: meili.url, MEILI_INDEX: 'qw-idx' });
  await withLogs(() => call(mod, '/search?q=zzzqqq', envIdx));
  is('MEILI_INDEX 生效', meili.state.requests[2].url, '/indexes/qw-idx/search');

  const envNoKey = makeEnv(db, { MEILI_HOST: meili.url });
  await withLogs(() => call(mod, '/search?q=zzzqqq', envNoKey));
  is('未设 MEILI_INDEX → 默认 games', meili.state.requests[3].url, '/indexes/games/search');
  is('没配 MEILI_API_KEY → 不带 authorization', meili.state.requests[3].headers.authorization, undefined);

  // 映射层：重复 slug / 库里没有的 slug / 下架行
  meili.state.hits = [{ slug: 'tetris', title: 'x', _rankingScore: 1 }, { slug: 'tetris', title: 'x', _rankingScore: 0.9 }, { slug: 'no-such-game-xyz', title: 'x', _rankingScore: 0.8 }, { slug: 'snake', title: 'x', _rankingScore: 0.7 }];
  meili.state.estimated = 4;
  const r2 = await withLogs(() => call(mod, '/search?q=zzzqqq', envMeili));
  const cards = (r2.value.body.match(/data-slug="/g) || []).length;
  is('去重 + 丢掉库中不存在的 slug：只剩 2 张卡', cards, 2);
  ok('保留的是 tetris 与 snake', has(r2.value.body, 'data-slug="tetris"') && has(r2.value.body, 'data-slug="snake"'));
  ok('不存在的 slug 不出现在页面上', !has(r2.value.body, 'no-such-game-xyz'));

  console.log('');
  console.log('【2】降级：失败 / 关掉 / 超时 / 熔断，请求仍 200 且用 D1 兜底');
  const failSrv = await startFakeMeili({ mode: 'fail' });
  servers.push(failSrv);
  const envFail = makeEnv(db, { MEILI_HOST: failSrv.url });
  const f1 = await withLogs(() => call(mod, '/search?q=2048', envFail));
  is('假 Meili 500 → 仍 200', f1.value.status, 200);
  ok('用 D1 兜底渲染出 2048', has(f1.value.body, 'data-slug="2048"'), '没看到兜底结果');
  ok('打了且只打了 1 行 [search] fallback', fbLines(f1.lines).length === 1, JSON.stringify(fbLines(f1.lines)));
  ok('降级日志带 source=fallback / backend=sql / 原始错误',
    has(fbLines(f1.lines)[0] || '', 'source=fallback') && has(fbLines(f1.lines)[0] || '', 'backend=sql') &&
    has(fbLines(f1.lines)[0] || '', 'meili_http_500'), (fbLines(f1.lines)[0] || ''));
  is('假 Meili 收到第 1 次失败请求', failSrv.state.requests.length, 1);
  await withLogs(() => call(mod, '/search?q=2048', envFail));
  await withLogs(() => call(mod, '/search?q=2048', envFail));
  is('连续 3 次失败（每次都真打了网络）', failSrv.state.requests.length, 3);
  const f4 = await withLogs(() => call(mod, '/search?q=2048', envFail));
  is('第 4 次仍 200（熔断后直接走兜底）', f4.value.status, 200);
  is('熔断打开后不再打网络', failSrv.state.requests.length, 3);
  ok('熔断那次也仍然渲染出兜底结果', has(f4.value.body, 'data-slug="2048"'));
  const f5 = await withLogs(() => call(mod, '/api/search/suggest?q=2048', envFail));
  let f5json = null;
  try { f5json = JSON.parse(f5.value.body); } catch (e) { f5json = null; }
  ok('降级后 /api/search/suggest 也 200 且给兜底结果',
    f5.value.status === 200 && !!f5json && f5json.items.length > 0 && f5json.items[0].slug === '2048', JSON.stringify(f5json));

  const dead = await startFakeMeili({});
  servers.push(dead);
  const deadUrl = dead.url;
  await dead.close();
  servers.pop();
  const d1r = await withLogs(() => call(mod, '/search?q=2048', makeEnv(db, { MEILI_HOST: deadUrl })));
  is('MEILI_HOST 指向关掉的端口 → 仍 200', d1r.value.status, 200);
  ok('连接被拒也走 D1 兜底', has(d1r.value.body, 'data-slug="2048"') && fbLines(d1r.lines).length === 1, JSON.stringify(fbLines(d1r.lines)));

  const hang = await startFakeMeili({ hang: true });
  servers.push(hang);
  const envSlow = makeEnv(db, { MEILI_HOST: hang.url, SEARCH_TIMEOUT_MS: '150' });
  const t0 = Date.now();
  const slow = await withLogs(() => call(mod, '/search?q=2048', envSlow));
  const elapsed = Date.now() - t0;
  is('主后端一直不回（超时 150ms）→ 仍 200', slow.value.status, 200);
  ok('超时后走 D1 兜底', has(slow.value.body, 'data-slug="2048"'));
  ok('确实是超时而不是瞬间失败：耗时 ' + elapsed + 'ms（>=120 且 <1500）', elapsed >= 120 && elapsed < 1500);
  ok('超时也打了一行 fallback', fbLines(slow.lines).length === 1, JSON.stringify(fbLines(slow.lines)));

  console.log('');
  console.log('【3】未配 MEILI_HOST：与改前逐字节一致');
  const reqBefore = meili.state.requests.length + failSrv.state.requests.length;
  const URLS = ['/search?q=2048', '/search?q=', '/search?q=%E8%B4%AA%E5%90%83', '/search?q=zzzqqq', '/search?sort=new&q=2048',
    '/api/search/suggest?q=2048', '/api/search/suggest?q=', '/api/search/suggest?q=zzzqqq',
    '/rank', '/rank?kind=week', '/rank?kind=bogus', '/rank?kind=all', '/games?q=2048', '/games', '/game/2048', '/'];
  const cur = [];
  for (const u of URLS) cur.push(await call(mod, u, plainEnv));
  is('未配置下假 Meili 一个请求都没收到', meili.state.requests.length + failSrv.state.requests.length, reqBefore);

  // 3a 自包含等价：直接照原路径渲染，与响应逐字节比对
  const ui = await import(pathToFileURL(join(ROOT, 'src', 'views.js')).href);
  const dataMod = await import(pathToFileURL(join(ROOT, 'worker', 'data.js')).href);
  const q2048 = '2048';
  const opts2048 = { q: q2048, sort: 'hot', limit: 60 };
  const expSearch = ui.listPage({
    origin: BASE, user: null, path: '/search?q=' + encodeURIComponent(q2048),
    heading: '「' + q2048 + '」的搜索结果', sub: '输入游戏名、类型或标签进行搜索',
    list: await dataMod.listGames(db, opts2048), total: await dataMod.countGames(db, opts2048),
    query: q2048, sort: 'hot', base: '/search'
  });
  ok('/search?q=2048 逐字节等于原路径渲染', cur[0].body === expSearch);
  is('/search?q=2048 状态码 200', cur[0].status, 200);
  const board = await dataMod.leaderboard(db, dataMod.boardKind(null), 20);
  const expRank = ui.rankPage({
    origin: BASE, user: null, kind: board.kind, label: board.label, metric: board.metric, rows: board.rows,
    boards: Object.entries(dataMod.BOARD_KINDS).map(function (e) { return { kind: e[0], label: e[1].label }; })
  });
  ok('/rank 逐字节等于原路径渲染', cur[8].body === expRank);
  const suggList = await dataMod.listGames(db, { q: q2048, limit: 6 });
  const expSugg = JSON.stringify({
    q: q2048,
    items: suggList.map(function (g) {
      return {
        slug: g.slug, title: g.title, emoji: g.emoji,
        category: g.category ? g.category.name : '', plays: g.plays, rating: g.rating
      };
    })
  });
  is('/api/search/suggest?q=2048 逐字节等于原路径渲染', cur[5].body, expSugg);

  // 3b 与改前基线模块逐字节比对
  if (!existsSync(BASELINE)) {
    skip('与改前基线模块逐字节比对', '找不到基线文件 ' + BASELINE + '（用 WORKER_SEARCH_BASELINE 指定）');
  } else {
    const baseMod = await importBaseline(BASELINE);
    const bwarm = await call(baseMod, '/', plainEnv);
    is('基线模块预热 200', bwarm.status, 200);
    let same = 0;
    for (let i = 0; i < URLS.length; i++) {
      const b = await call(baseMod, URLS[i], plainEnv);
      const eq = b.status === cur[i].status && b.body === cur[i].body;
      if (eq) same++;
      evidence.push([URLS[i], cur[i].status, b.status, sha(cur[i].body), sha(b.body), eq ? 'SAME' : 'DIFF'].join('\t'));
      if (!eq) ok('基线比对 ' + URLS[i], false, 'status ' + cur[i].status + '/' + b.status + ' sha ' + sha(cur[i].body).slice(0, 12) + '/' + sha(b.body).slice(0, 12));
    }
    is(URLS.length + ' 个 URL 与改前基线逐字节一致（含状态码）', same, URLS.length);
    const evFile = join(TMP, 'wsearch-byteid.txt');
    writeFileSync(evFile, 'url\tstatus_cur\tstatus_base\tsha256_cur\tsha256_base\tverdict\n' + evidence.join('\n') + '\n', 'utf8');
    console.log('  取证：' + evFile + '（' + BASELINE + '）');
  }

  console.log('');
  console.log('【4】榜单缓存：TTL 命中、键含参数、远程适配器接缝、Cache API 层可跳过');
  const stats0 = mod.rankCacheStats();
  const p1 = await call(mod, '/rank?kind=rating', plainEnv);
  const stats1 = mod.rankCacheStats();
  const p2 = await call(mod, '/rank?kind=rating', plainEnv);
  const stats2 = mod.rankCacheStats();
  is('两次 /rank?kind=rating 都 200', p1.status + '/' + p2.status, '200/200');
  ok('两次输出逐字节一致（缓存命中不影响渲染）', p1.body === p2.body);
  is('首次：loads +1', stats1.loads - stats0.loads, 1);
  is('命中一次：hits +1', stats2.hits - stats1.hits, 1);
  is('第二次不再加载', stats2.loads - stats1.loads, 0);
  await call(mod, '/rank?kind=fav', plainEnv);
  is('换 kind → 键不同，重新加载', mod.rankCacheStats().loads - stats2.loads, 1);
  ok('rankCacheStats 暴露 size/hits/misses/loads', typeof stats0.size === 'number' && typeof stats0.evictions === 'number');

  const calls = [];
  mod.setRankStore({
    getOrLoad: async function (key, loader) { calls.push(key); return loader(); },
    invalidate: function () {}, clear: function () {}, stats: function () { return { backend: 'test' }; }
  });
  const inj = await call(mod, '/rank?kind=month', plainEnv);
  is('setRankStore 注入的 store 真的被用上（1 次）', calls.length, 1);
  ok('缓存键形如 rank:<scope>:<kind>:<limit>，含 kind 与 limit',
    typeof calls[0] === 'string' && calls[0].indexOf('rank:') === 0 && has(calls[0], ':month:20'), calls[0]);
  is('注入 store 下 /rank 仍 200', inj.status, 200);
  mod.setRankStore(null);
  is('setRankStore(null) 恢复默认（仍能取数）', (await call(mod, '/rank?kind=month', plainEnv)).status, 200);

  // 远程缓存接缝：globalThis.__QW_REDIS__（要有 get/set/del）→ redisLikeAdapter（本仓零依赖，默认不接）
  const rk = [];
  globalThis.__QW_REDIS__ = {
    get: async function (k) { rk.push(['get', k]); return null; },
    set: async function (k, v, o) { rk.push(['set', k, o && o.EX]); return 'OK'; },
    del: async function (k) { rk.push(['del', k]); return 1; },
    keys: async function (p) { rk.push(['keys', p]); return []; }
  };
  mod.setRankStore(null);
  is('挂上 __QW_REDIS__ 后 rankStore 走 redisLikeAdapter', (mod.rankCacheStats() || {}).backend, 'redis');
  const z1 = await call(mod, '/rank?kind=fav', plainEnv);
  is('远程缓存接缝下 /rank 仍 200', z1.status, 200);
  ok('远端 get/set 的键带 qw:rank:rank: 前缀',
    rk.some(function (r) { return r[0] === 'get' && has(r[1], 'qw:rank:rank:'); }) &&
    rk.some(function (r) { return r[0] === 'set' && has(r[1], 'qw:rank:rank:'); }), JSON.stringify(rk));
  ok('远端 set 带 EX=30（与 30s TTL 对齐）', rk.some(function (r) { return r[0] === 'set' && r[2] === 30; }), JSON.stringify(rk));
  globalThis.__QW_REDIS__.get = async function () { throw new Error('redis down'); };
  mod.setRankStore(null);
  const z2 = await call(mod, '/rank?kind=week', plainEnv);
  is('远端抛错时 /rank 仍 200', z2.status, 200);
  is('远端抛错 → 退化成 memory（页面不受影响）', (mod.rankCacheStats() || {}).backend, 'memory');
  delete globalThis.__QW_REDIS__;
  mod.setRankStore(null);
  const rsAfter = mod.rankCacheStats() || {};
  ok('撤掉 __QW_REDIS__ 后回到默认内存缓存（createCache 形状：size/hits/loads 齐全、没有 backend 字段）',
    typeof rsAfter.size === 'number' && typeof rsAfter.hits === 'number' && typeof rsAfter.loads === 'number' && rsAfter.backend === undefined,
    JSON.stringify(rsAfter));

  // 可选 Cache API 层：node 里默认没有 caches → 必须安全跳过
  is('Node 环境没有 caches 全局对象（测的正是「本地 dev 跳过」这条路）', typeof globalThis.caches, 'undefined');
  const puts = [];
  let c3body = '';
  globalThis.caches = { default: {
    match: async function () { return null; },
    put: async function (req, res) { puts.push({ url: String(req && req.url), cc: res && res.headers.get('cache-control') }); }
  } };
  try {
    const c1 = await call(mod, '/rank?kind=new', plainEnv);
    is('有 caches.default 时 /rank 仍 200', c1.status, 200);
    is('写了 1 次边缘缓存', puts.length, 1);
    ok('缓存键是行数据专用 URL（带 __rows=1）且 TTL=max-age=30',
      has(puts[0] && puts[0].url, '/rank?kind=new') && has(puts[0] && puts[0].url, '__rows=1') && puts[0].cc === 'max-age=30',
      JSON.stringify(puts[0]));
    globalThis.caches.default.match = async function () {
      return new Response(JSON.stringify([{ rank: 1, slug: 'tetris', title: '缓存里的毒榜', emoji: '🎮', accent: '#111', accent2: '#222', category: null, value: 99, plays: 99, rating: 0, rating_count: 0, hasPrev: false, prevRank: null, move: 0 }]), { headers: { 'content-type': 'application/json' } });
    };
    const c2 = await call(mod, '/rank?kind=new', plainEnv);
    ok('命中这层缓存时用的是缓存里的行（页面出现「缓存里的毒榜」）', has(c2.body, '缓存里的毒榜'));
    globalThis.caches.default.match = function () { throw new Error('cache blow up'); };
    globalThis.caches.default.put = function () { throw new Error('cache put blow up'); };
    const c3 = await call(mod, '/rank?kind=new', plainEnv);
    is('caches 抛错时 /rank 仍 200（异常被吞掉）', c3.status, 200);
    c3body = c3.body;
    ok('抛错时渲染的仍是榜单行数据（rk-row 卡片）', has(c3.body, 'rk-row'), 'no row');
  } finally {
    delete globalThis.caches;
  }
  const d1x = await call(mod, '/rank?kind=new', plainEnv);
  ok('删掉 caches 后 /rank 回到直接查库（不再出现毒榜）', d1x.status === 200 && !has(d1x.body, '缓存里的毒榜'));
  const nc = await call(mod, '/rank?kind=new', plainEnv);
  ok('caches 抛错时的输出与没有 cache 层时逐字节一致', nc.status === 200 && nc.body === c3body, 'diff');
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
} finally {
  for (const s of servers) { try { await s.close(); } catch (e) { /* 已关 */ } }
  if (db) { try { db.close(); } catch (e) { /* 已关 */ } }
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    try { if (existsSync(f)) rmSync(f, { force: true }); } catch (e) { /* 留给下次 */ }
  }
}
if (fatal) {
  fail++;
  console.log('');
  console.log('未捕获异常：' + (fatal && fatal.stack ? fatal.stack : fatal));
}
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (skipped ? '，跳过 ' + skipped + ' 项' : ''));
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
