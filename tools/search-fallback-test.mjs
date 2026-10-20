/**
 * 集成测试：搜索主后端（Meilisearch）+ SQL 兜底降级 + 榜单缓存（TTL / 单飞）。
 *
 * 全流程真进程：
 *   ① 假 Meilisearch（node:http，监听 127.0.0.1 私有端口，记录收到的请求体，按模式返回 Meili 形状 hits / 500 / 挂住）
 *   ② 用 spawn 起自己的 server.js 实例（PORT=313x、MEILI_HOST 指向假 Meili）
 *   ③ 假 Meili 挂了（500 / 连接被拒 / 超时 / 熔断）后照样 200，回落 SQL 且与「直接打 SQL」逐字段一致，日志出现 [search] fallback
 *   ④ 榜单缓存的单飞与 TTL：由本文件 --rank-child 模式在子进程里 import ../server.js，
 *      直接观察 app.locals.rankCache.stats()（RANK_CACHE_TTL_MS=400 加速，不真等 30 秒）
 *
 * 只杀自己 spawn 的进程（记录 pid），绝不按名字杀；端口全部落在 313x 私有段。
 * 运行：node tools/search-fallback-test.mjs
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as data from '../src/data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 断言累加器（与 tools/adapters-test.mjs 同风格） ==================== */
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? '  [' + extra + ']' : ''));
    console.log('  \u2717 ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}
function is(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

/* ==================== 端口与进程工具 ==================== */
/**
 * 端口探活：先 connect 再 bind。
 * 只 bind 是不够的——Windows 上别人的进程绑在 ::（双栈）时，127.0.0.1 的 bind 居然还能成功，
 * 于是「已经被占的端口」被当成空闲，测试就会打到那个陌生进程上去（第一版就栽在这里）。
 */
async function portFree(port) {
  const busy = await new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(300);
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => res(false));
    sock.once('timeout', () => { sock.destroy(); res(false); });
  });
  if (busy) return false;
  const srv = net.createServer();
  const canBind = await new Promise((res) => {
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => res(true));
  });
  if (canBind) await new Promise((r) => srv.close(r));
  return canBind;
}

async function freePort(...candidates) {
  for (const port of candidates) if (await portFree(port)) return port;
  throw new Error('313x 私有段没有空闲端口了');
}

/** 起自己的 server 实例；日志收集起来给降级断言用 */
function startSite(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SITE_ORIGIN: 'http://127.0.0.1:' + port, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log.push(line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return { child, log, port, base: 'http://127.0.0.1:' + port };
}

/**
 * 就绪判定：不光要 /api/games 通，还要在自己孩子的日志里看到本轮端口的启动横幅——
 * 否则「端口被别的进程占着、请求打到了陌生人身上」会被误判成就绪。
 */
async function siteReady(site, ms = 25000) {
  const banner = 'http://localhost:' + site.port;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (site.child.exitCode !== null) return { ok: false, reason: 'exited' };
    if (site.log.some((l) => l.includes(banner))) {
      try {
        const r = await fetch(site.base + '/api/games?limit=1');
        if (r.ok) return { ok: true };
      } catch {}
    }
    await sleep(120);
  }
  return { ok: false, reason: 'timeout' };
}

/**
 * 在候选端口上起实例：
 *   - 日志里出现 EADDRINUSE → 这个端口有人，换下一个候选；
 *   - database is locked（Lead 的 3000 正在写库，环境噪声）→ 原地重试；
 *   - 其它起不来 → 返回 null，让断言去报错。
 */
async function startSiteOn(ports, extraEnv, tries = 3) {
  for (const port of ports) {
    for (let i = 1; i <= tries; i++) {
      const site = startSite(port, extraEnv);
      const ready = await siteReady(site);
      if (ready.ok) return site;
      const log = site.log.join('\n');
      await stopSite(site);
      if (/EADDRINUSE/.test(log)) break;
      if (/database is locked/i.test(log)) {
        console.log('  (database is locked，第 ' + i + ' 次重试起实例)');
        continue;
      }
      console.log('  (实例起不来 port=' + port + ' reason=' + ready.reason + ')：' +
        log.split('\n').slice(-4).join(' | '));
      return null;
    }
  }
  return null;
}

/** 只杀自己 spawn 出来的 pid（必要时按记录的 pid 用 taskkill /T /F，绝不通配） */
async function stopSite(site) {
  if (!site || !site.child || site.child.exitCode !== null) return;
  try { site.child.kill(); } catch {}
  for (let i = 0; i < 40 && site.child.exitCode === null; i++) await sleep(50);
  if (site.child.exitCode === null && process.platform === 'win32' && site.child.pid) {
    try { spawn('taskkill', ['/PID', String(site.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(300);
  }
}

const countLog = (site, re) => site.log.filter((l) => re.test(l)).length;
async function waitLogGrow(site, re, before, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (countLog(site, re) > before) return true;
    await sleep(60);
  }
  return false;
}

/* ==================== 假 Meilisearch ==================== */
function makeFakeMeili(port) {
  const ctl = {
    port, mode: 'ok', hits: [], requests: [], server: null,
    url: 'http://127.0.0.1:' + port,
    searchRequests: () => ctl.requests.filter((r) => r.method === 'POST' && r.url === '/indexes/games/search')
  };
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body || '{}'); } catch {}
      ctl.requests.push({ method: req.method, url: req.url, body: json });
      if (ctl.mode === 'hang') {
        // 模拟主后端卡死：不回复，等客户端自己的 SEARCH_TIMEOUT_MS 放弃
        const t = setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch {} }, 5000);
        if (t.unref) t.unref();
        return;
      }
      if (ctl.mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'fake meili boom' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/indexes/games/search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          hits: ctl.hits.map((h) => ({ slug: h.slug, title: h.title, _rankingScore: 1 })),
          estimatedTotalHits: ctl.hits.length,
          query: json && json.q,
          processingTimeMs: 0
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  };
  ctl.start = () => new Promise((res) => {
    ctl.server = http.createServer(handler);
    ctl.server.listen(port, '127.0.0.1', () => res());
  });
  ctl.stop = () => new Promise((res) => {
    const s = ctl.server;
    ctl.server = null;
    if (!s) return res();
    try { s.closeAllConnections(); } catch {} // keep-alive 连接不掐掉的话，close 之后 fetch 还能打进来
    s.close(() => res());
  });
  return ctl;
}

/* ==================== ④ 榜单缓存：--rank-child 模式 ==================== */
async function rankChild(port) {
  process.env.PORT = String(port);
  process.env.SITE_ORIGIN = 'http://127.0.0.1:' + port;
  process.env.RANK_CACHE_TTL_MS = '400'; // 测试加速旋钮：别真等 30 秒
  process.env.MEILI_HOST = '';
  const out = { pass: 0, fail: 0, lines: [] };
  const A = (name, cond, extra) => {
    out.lines.push((cond ? '\u2713 ' : '\u2717 ') + name + (cond || !extra ? '' : '  [' + extra + ']'));
    if (cond) out.pass++; else out.fail++;
  };
  const base = 'http://127.0.0.1:' + port;
  const mod = await import(pathToFileURL(join(ROOT, 'server.js')).href);
  const rankCache = mod.rankCache;
  const server = mod.server;
  try {
    // 单飞：同一 key 并发 3 次，loader 只跑一次
    let loads = 0;
    const s0 = rankCache.stats();
    const slow = async () => { loads++; await sleep(60); return { v: loads }; };
    const [a, b, c] = await Promise.all([
      rankCache.getOrLoad('test:sf', slow),
      rankCache.getOrLoad('test:sf', slow),
      rankCache.getOrLoad('test:sf', slow)
    ]);
    const s1 = rankCache.stats();
    A('单飞：并发 3 次只跑了一次 loader', loads === 1, 'loads=' + loads);
    A('单飞：三个调用拿到同一份结果', a === b && b === c && a.v === 1);
    A('单飞：stats.loads 只 +1', s1.loads - s0.loads === 1, 'delta=' + (s1.loads - s0.loads));
    A('单飞：伴随 3 次 miss（跟随者不重复加载）', s1.misses - s0.misses === 3, 'delta=' + (s1.misses - s0.misses));
    A('单飞：结束后 inflight 归零', s1.inflight === 0, 'inflight=' + s1.inflight);

    // TTL：过期前命中，过期后重跑
    let n = 0;
    const load = async () => ({ n: ++n });
    A('TTL：首次取值跑了 loader', (await rankCache.getOrLoad('test:ttl', load)).n === 1 && n === 1);
    A('TTL：立刻再取走缓存，loader 没再跑', (await rankCache.getOrLoad('test:ttl', load)).n === 1 && n === 1);
    await sleep(450);
    A('TTL：过期后重跑 loader', (await rankCache.getOrLoad('test:ttl', load)).n === 2 && n === 2);

    // loader 抛错不写缓存（负缓存会把一次抖动钉死一整个 TTL）
    let errRuns = 0;
    let thrown = '';
    try {
      await rankCache.getOrLoad('test:boom', async () => { errRuns++; throw new Error('boom'); });
    } catch (e) { thrown = String(e && e.message); }
    A('loader 抛错：错误原样向上抛', thrown === 'boom', 'thrown=' + thrown);
    A('loader 抛错：不写缓存，下次仍会调 loader',
      (await rankCache.getOrLoad('test:boom', async () => { errRuns++; return 7; })) === 7 && errRuns === 2, 'errRuns=' + errRuns);

    // HTTP 面：第二次请求命中缓存（没再打库）
    const h0 = rankCache.stats().loads;
    const r1 = await fetch(base + '/rank');
    const t1 = await r1.text();
    const r2 = await fetch(base + '/rank');
    const t2 = await r2.text();
    A('HTTP /rank 两次都 200', r1.status === 200 && r2.status === 200, 'status=' + r1.status + '/' + r2.status);
    A('HTTP /rank 两次页面一致', t1 === t2 && t1.length > 1000);
    A('HTTP /rank 第二次没再打库（loads 只 +1）', rankCache.stats().loads - h0 === 1, 'delta=' + (rankCache.stats().loads - h0));

    // 不同 kind 是不同的 key
    const h1 = rankCache.stats().loads;
    await (await fetch(base + '/rank?kind=week')).text();
    await (await fetch(base + '/rank?kind=all')).text();
    A('HTTP 不同 kind 是不同 key（各打一次库）', rankCache.stats().loads - h1 === 2, 'delta=' + (rankCache.stats().loads - h1));

    // 过期后 HTTP 重新打库
    const h2 = rankCache.stats().loads;
    await sleep(450);
    await (await fetch(base + '/rank')).text();
    A('HTTP 缓存过期后重新打库', rankCache.stats().loads - h2 === 1, 'delta=' + (rankCache.stats().loads - h2));
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log('RANKCHILD_JSON ' + JSON.stringify(out));
  process.exit(out.fail ? 1 : 0);
}

/* ==================== 主流程 ==================== */
async function main() {
  console.log('搜索主后端 + SQL 兜底 + 榜单缓存 集成测试');
  const fakePort = await freePort(3130, 3131, 3132, 3133, 3134);
  const sitePorts = [3136, 3137, 3138, 3139, 3140, 3141, 3142, 3143];
  const rankPort = await freePort(3144, 3145, 3146);
  const fake = makeFakeMeili(fakePort);
  await fake.start();

  let site = null;
  try {
    console.log('\n--- ① 主后端可用：/search 与建议接口走 Meili');
    site = await startSiteOn(sitePorts, {
      MEILI_HOST: fake.url, MEILI_INDEX: 'games', MEILI_API_KEY: '', SEARCH_TIMEOUT_MS: '800'
    });
    if (!site) {
      ok('spawn 的 server 实例能起来（/api/games 200）', false, '启动失败，见上方日志');
      cleanupAndReport(null, fake, null);
      return;
    }
    ok('spawn 的 server 实例能起来（/api/games 200）', true);
    ok('连的是自己 spawn 的这个实例（日志里有本轮端口的启动横幅）',
      site.log.some((l) => l.includes('http://localhost:' + site.port)), site.log.slice(0, 2).join(' | '));

    const ref = await (await fetch(site.base + '/api/games?sort=new&limit=2')).json();
    ok('本站至少有两款游戏可供对照', Array.isArray(ref.items) && ref.items.length >= 2, 'items=' + (ref.items || []).length);
    const gA = ref.items[0] || { slug: '', title: '\u0000A' };
    const gB = ref.items[1] || { slug: '', title: '\u0000B' };
    // Meili 故意按「与 SQL 相反的顺序」返回：SQL 搜 'zzzquux' 一条不中，只有 Meili 命中，顺序还能验证相关度保序
    fake.hits = [{ slug: gB.slug, title: gB.title }, { slug: gA.slug, title: gA.title }];

    const q1 = 'zzzquux';
    const page = await (await fetch(site.base + '/search?q=' + q1)).text();
    ok('Meili 命中：/search 渲染出了 Meili 返回的两款游戏（SQL 搜不到 ' + q1 + '）',
      page.includes(gA.title) && page.includes(gB.title));
    ok('Meili 命中：没有出现兜底日志', countLog(site, /\[search\] fallback/) === 0);
    ok('后端是首次搜索时才惰性建的，并打印了主后端配置',
      site.log.some((l) => l.includes('主后端 meilisearch ' + fake.url)), site.log.slice(-3).join(' | '));

    const reqs = fake.searchRequests();
    ok('假 Meili 真收到了 POST /indexes/games/search', reqs.length >= 1 && reqs[0].method === 'POST' && reqs[0].url === '/indexes/games/search',
      'requests=' + JSON.stringify(fake.requests.map((r) => r.method + ' ' + r.url)));
    ok('POST body 带了 q 与 limit', reqs[0] && reqs[0].body.q === q1 && reqs[0].body.limit === 60, JSON.stringify(reqs[0] && reqs[0].body));

    const sugg = await (await fetch(site.base + '/api/search/suggest?q=' + q1)).json();
    is('建议接口按 Meili 的相关度顺序返回（保序，不重排）', sugg.items.map((i) => i.slug), [gB.slug, gA.slug]);
    ok('建议接口用的是本站库里的完整字段（slug 回库补全）',
      !!sugg.items[0] && sugg.items[0].title === gB.title && sugg.items[0].plays === gB.plays && typeof sugg.items[0].emoji === 'string',
      JSON.stringify(sugg.items[0]));
    const reqs2 = fake.searchRequests();
    ok('建议接口的 limit 是 6', reqs2[reqs2.length - 1].body.limit === 6, JSON.stringify(reqs2[reqs2.length - 1].body));

    console.log('\n--- ② 主后端 500：仍 200、回落 SQL、日志出现 [search] fallback');
    const sqlExpect = (q) => data.listGames({ q, sort: 'hot', limit: 6 }).map((g) => ({
      slug: g.slug, title: g.title, emoji: g.emoji,
      category: g.category ? g.category.name : '', plays: g.plays, rating: g.rating
    }));
    fake.mode = 'error';
    const c0 = countLog(site, /\[search\] fallback/);
    const p1 = await fetch(site.base + '/search?q=' + q1);
    const b1 = await p1.text();
    const p2 = await fetch(site.base + '/search?q=' + q1);
    const b2 = await p2.text();
    ok('主后端 500：/search 两次都 200', p1.status === 200 && p2.status === 200, 'status=' + p1.status + '/' + p2.status);
    ok('主后端 500：页面里不再有 Meili 独有的那两款（已回落 SQL 空结果）',
      !b1.includes(gA.title) && !b1.includes(gB.title) && !b2.includes(gA.title));
    ok('主后端 500：服务端打了一行 [search] fallback', await waitLogGrow(site, /\[search\] fallback/, c0),
      'log tail=' + site.log.slice(-3).join(' | '));
    const s500 = await (await fetch(site.base + '/api/search/suggest?q=chess')).json();
    is('主后端 500：兜底结果与「直接打 SQL」逐字段一致', s500, { q: 'chess', items: sqlExpect('chess') });

    console.log('\n--- ③ 主后端进程整个没了（连接被拒）：仍 200 + fallback 日志');
    await fake.stop();
    const c1 = countLog(site, /\[search\] fallback/);
    const r3 = await fetch(site.base + '/search?q=chess');
    const b3 = await r3.text();
    ok('连接被拒：/search 仍 200', r3.status === 200, 'status=' + r3.status);
    ok('连接被拒：页面照常渲染兜底结果', b3.includes('chess') || b3.length > 1000);
    ok('连接被拒：日志继续打 [search] fallback', await waitLogGrow(site, /\[search\] fallback/, c1));

    console.log('\n--- ④ 主后端挂住不回：按 SEARCH_TIMEOUT_MS 超时回落');
    fake.mode = 'hang';
    await fake.start();
    const c2 = countLog(site, /\[search\] fallback/);
    const t0 = Date.now();
    const r4 = await fetch(site.base + '/api/search/suggest?q=chess');
    const j4 = await r4.json();
    const dt = Date.now() - t0;
    ok('超时：接口仍 200 且在 SEARCH_TIMEOUT_MS(800ms) 量级内返回', r4.status === 200 && dt < 4000, 'dt=' + dt + 'ms');
    is('超时：回落结果仍是 SQL 结果', j4, { q: 'chess', items: sqlExpect('chess') });
    ok('超时：日志打了 [search] fallback', await waitLogGrow(site, /\[search\] fallback/, c2));
    const tStart = Date.now();
    await (await fetch(site.base + '/api/search/suggest?q=chess')).json();
    const dt2 = Date.now() - tStart;
    ok('熔断：连续失败后不再等主后端，直接短路回落（<300ms）', dt2 < 300, 'dt=' + dt2 + 'ms');

    console.log('\n--- ⑤ 榜单缓存（--rank-child 子进程，TTL 缩到 400ms）');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--rank-child', String(rankPort)], {
      cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let childOut = '';
    child.stdout.on('data', (b) => { childOut += String(b); });
    child.stderr.on('data', (b) => { childOut += String(b); });
    const childCode = await new Promise((res) => child.on('exit', (code) => res(code)));
    const line = childOut.split(/\r?\n/).find((l) => l.startsWith('RANKCHILD_JSON '));
    if (!line) {
      ok('榜单缓存的子进程断言跑完', false, 'exit=' + childCode + ' out=' + childOut.slice(-400));
    } else {
      const rep = JSON.parse(line.slice('RANKCHILD_JSON '.length));
      for (const l of rep.lines) console.log('    ' + l);
      pass += rep.pass;
      fail += rep.fail;
      if (rep.fail) failures.push('榜单缓存子进程断言 ' + rep.fail + ' 项失败');
      ok('榜单缓存的子进程断言跑完（' + rep.pass + ' 通过 / ' + rep.fail + ' 失败）', rep.pass > 0 && rep.fail === 0 && childCode === 0);
    }
  } catch (e) {
    ok('测试过程未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    await stopSite(site);
    await fake.stop();
  }

  console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log(fail === 0 ? 'ALL OK' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv[2] === '--rank-child') {
  await rankChild(Number(process.argv[3]));
} else {
  await main();
}
