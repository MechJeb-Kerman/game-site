/**
 * 适配器自测：src/search.js（搜索后端 + 熔断）与 src/rank-cache.js（TTL 缓存 + 单飞 + Redis 适配）。
 *
 *   node tools/adapters-test.mjs
 *
 * 零依赖、零外网、零数据库：搜索后端 / 计时器 / Redis 客户端全是假实现，
 * 所有等待都在几十毫秒内（假时钟 + 一个 50ms 超时用例），整轮 1 秒内跑完。
 * 全过退出码 0，任何一项 FAIL 退出码 1。
 */
import { MEILI_UNCONFIGURED, makeSearchBackend, meiliBackend, normalizeQuery, sqlBackend } from '../src/search.js';
import { createCache, redisLikeAdapter } from '../src/rank-cache.js';

const startedAt = Date.now();
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra));
  }
}

function is(name, got, want) {
  ok(name, Object.is(got, want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 Redis：内存 Map + 记录 set 的选项，行为对齐 node-redis v4 的最小面 */
function fakeRedis() {
  const kv = new Map();
  const setOpts = [];
  return {
    kv: kv,
    setOpts: setOpts,
    client: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async set(k, v, o) {
        kv.set(k, v);
        setOpts.push(o);
        return 'OK';
      },
      async del(k) {
        const keys = Array.isArray(k) ? k : [k];
        let n = 0;
        for (const one of keys) if (kv.delete(one)) n++;
        return n;
      },
      async keys(pattern) {
        const p = String(pattern).replace(/\*+$/, '');
        return Array.from(kv.keys()).filter((x) => x.startsWith(p));
      }
    }
  };
}

async function main() {
  // ---------------------------------------------------------------- 搜索：归一化
  console.log('--- src/search.js：normalizeQuery ---');
  is('去首尾空白', normalizeQuery('  hot ').text, 'hot');
  is('折叠内部空白', normalizeQuery('a   b' + String.fromCharCode(9) + 'c').text, 'a b c');
  is('全角空格也是空白', normalizeQuery(String.fromCharCode(12288) + '热' + String.fromCharCode(12288) + '门').text, '热 门');
  is('限长 64', normalizeQuery('x'.repeat(100)).text.length, 64);
  is('raw 保留原串', normalizeQuery('  Hot Game ').raw, '  Hot Game ');
  is('比较键小写', normalizeQuery('  Hot Game ').key, 'hot game');
  is('全角字母与半角等价', normalizeQuery(String.fromCharCode(65320, 65327, 65332)).key, 'hot');
  is('空输入不炸', normalizeQuery(undefined).text, '');

  // ---------------------------------------------------------------- 搜索：主后端正常
  console.log('--- makeSearchBackend：primary 正常 ---');
  {
    let seen = null;
    const be = makeSearchBackend({
      primary: async (q, o) => {
        seen = { q: q, o: o };
        return { items: [{ slug: 'a' }], total: 1, source: 'meili' };
      },
      fallback: async () => ({ items: [{ slug: 'b' }], total: 1, source: 'sql' })
    });
    const r = await be.search('  Hot  Game ', { limit: 5 });
    is('source 是 primary', r.source, 'primary');
    is('backend 用提供方自报的名字', r.backend, 'meili');
    is('items 原样透传', r.items[0].slug, 'a');
    is('total 透传', r.total, 1);
    is('查询串先归一化再交给后端', seen.q, 'Hot Game');
    is('opts 透传', seen.o.limit, 5);
    is('结果带回 queryKey', r.queryKey, 'hot game');
    const s = be.stats();
    is('primaryCalls', s.primaryCalls, 1);
    is('primaryFailures', s.primaryFailures, 0);
    is('fallbackCalls', s.fallbackCalls, 0);
    is('熔断器关着', s.breakerOpen, false);
    ok('记录了耗时', Number.isFinite(s.lastLatencyMs) && s.lastLatencyMs >= 0, String(s.lastLatencyMs));
  }

  // ---------------------------------------------------------------- 搜索：primary 抛错 → 兜底
  console.log('--- makeSearchBackend：primary 抛错回退 ---');
  {
    const be = makeSearchBackend({
      primary: async () => {
        throw new Error('meili_down');
      },
      fallback: async () => ({ items: [{ slug: 'b' }], total: 1, source: 'sql' })
    });
    const r = await be.search('hot');
    is('source 标成 fallback', r.source, 'fallback');
    is('backend 是 sql', r.backend, 'sql');
    is('拿到兜底结果', r.items[0].slug, 'b');
    const s = be.stats();
    is('primaryFailures = 1', s.primaryFailures, 1);
    is('fallbackCalls = 1', s.fallbackCalls, 1);
    is('fallbackHits = 1', s.fallbackHits, 1);
    is('lastError 是错误原文', s.lastError, 'meili_down');
    is('lastErrorLeg 记了是哪条腿', s.lastErrorLeg, 'primary');
    is('一次失败还不到阈值', s.breakerOpen, false);
  }

  // ---------------------------------------------------------------- 搜索：primary 挂起 → 超时回退
  console.log('--- makeSearchBackend：primary 超时回退 ---');
  {
    const be = makeSearchBackend({
      timeoutMs: 50,
      primary: () => new Promise(() => {}), // 永远不落地
      fallback: async () => ({ items: [], total: 0 })
    });
    const t = Date.now();
    const r = await be.search('hot');
    const spent = Date.now() - t;
    is('超时后退回 fallback', r.source, 'fallback');
    is('lastError 记成 search_timeout', be.stats().lastError, 'search_timeout');
    ok('确实等到了超时点（40~1000ms）', spent >= 40 && spent < 1000, spent + 'ms');
    is('超时也算一次 primary 失败', be.stats().primaryFailures, 1);
  }

  // ---------------------------------------------------------------- 搜索：熔断 → 冷却 → 半开
  console.log('--- makeSearchBackend：熔断与半开 ---');
  {
    let clock = 1000000; // 假时钟：冷却不用真等
    let calls = 0;
    let primaryOk = false;
    const be = makeSearchBackend({
      now: () => clock,
      breaker: { failures: 3, cooldownMs: 60000 },
      primary: async () => {
        calls++;
        if (!primaryOk) throw new Error('boom');
        return { items: [{ slug: 'ok' }], total: 1, source: 'meili' };
      },
      fallback: async () => ({ items: [], total: 0, source: 'sql' })
    });
    for (let i = 0; i < 3; i++) await be.search('hot');
    is('连续 3 次失败后熔断打开', be.stats().breakerOpen, true);
    is('状态是 open', be.stats().breakerState, 'open');
    is('enabledBackend 退到 fallback', be.enabledBackend(), 'fallback');
    const before = calls;
    const r = await be.search('hot');
    is('冷却期内不再请求 primary', calls, before);
    is('冷却期内结果标 fallback', r.source, 'fallback');
    clock += 60001;
    is('冷却结束进入半开', be.stats().breakerState, 'half-open');
    is('半开时 enabledBackend 回到 primary', be.enabledBackend(), 'primary');
    primaryOk = true;
    const r2 = await be.search('hot');
    is('半开重试走 primary', r2.source, 'primary');
    is('成功后熔断复位', be.stats().breakerOpen, false);
    is('状态回到 closed', be.stats().breakerState, 'closed');
  }
  {
    let clock = 0;
    const be = makeSearchBackend({
      now: () => clock,
      breaker: { failures: 2, cooldownMs: 1000 },
      primary: async () => {
        throw new Error('nope');
      },
      fallback: async () => ({ items: [], total: 0 })
    });
    await be.search('a');
    await be.search('a');
    is('两次失败即打开', be.stats().breakerOpen, true);
    clock += 1001;
    await be.search('a'); // 半开探测，还是失败
    is('半开探测失败后继续熔断', be.stats().breakerOpen, true);
    is('冷却重新计时（此刻仍是 open）', be.stats().breakerState, 'open');
    clock += 1001;
    is('再次进入半开', be.stats().breakerState, 'half-open');
  }

  // ---------------------------------------------------------------- 搜索：两条腿都挂
  console.log('--- makeSearchBackend：fallback 也挂 ---');
  {
    const be = makeSearchBackend({
      primary: async () => {
        throw new Error('p_boom');
      },
      fallback: async () => {
        throw new Error('f_boom');
      }
    });
    let threw = null;
    let r = null;
    try {
      r = await be.search('hot');
    } catch (e) {
      threw = e;
    }
    ok('search() 不抛错', threw === null, String(threw));
    is('返回空 items', r.items.length, 0);
    is('total 为 0', r.total, 0);
    is('source 标成 empty', r.source, 'empty');
    is('lastError 记的是 fallback 的错', be.stats().lastError, 'f_boom');
    is('lastErrorLeg 是 fallback', be.stats().lastErrorLeg, 'fallback');
  }
  {
    const be = makeSearchBackend({ primary: null, fallback: sqlBackend(() => ({ items: [{ slug: 'x' }], total: 1 })) });
    const r = await be.search('hot');
    is('没配 primary 就直接走兜底', r.source, 'fallback');
    is('backend 是 sql', r.backend, 'sql');
    is('primaryCalls 为 0', be.stats().primaryCalls, 0);
    is('enabledBackend 是 fallback', be.enabledBackend(), 'fallback');
  }

  // ---------------------------------------------------------------- meiliBackend
  console.log('--- meiliBackend ---');
  {
    let threw = null;
    try {
      await meiliBackend({ url: '' })('hot');
    } catch (e) {
      threw = e;
    }
    is('未配置 url：抛 meili_unconfigured', threw && threw.message, MEILI_UNCONFIGURED);
    is('未配置 url：err.code 也是它', threw && threw.code, MEILI_UNCONFIGURED);
  }
  {
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url: url, init: init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ hits: [{ slug: 'a', title: 'A', _rankingScore: 0.9 }, { id: 'b', name: 'B' }], estimatedTotalHits: 42 })
      };
    };
    const meili = meiliBackend({ url: 'http://127.0.0.1:7700/', apiKey: 'k', index: 'games', fetchImpl: fakeFetch });
    const r = await meili('hot', { limit: 5, offset: 10, filter: 'status = 1' });
    is('POST 到 /indexes/<index>/search（尾斜杠已去掉）', seen[0].url, 'http://127.0.0.1:7700/indexes/games/search');
    is('method 是 POST', seen[0].init.method, 'POST');
    is('带上 Authorization', seen[0].init.headers.authorization, 'Bearer k');
    const body = JSON.parse(seen[0].init.body);
    is('body.q', body.q, 'hot');
    is('body.limit', body.limit, 5);
    is('body.offset', body.offset, 10);
    is('body.filter 透传', body.filter, 'status = 1');
    is('默认要 ranking score（否则没 score 可用）', body.showRankingScore, true);
    is('hits 归一化成 { slug, title, score }', JSON.stringify(r.items[0]), JSON.stringify({ slug: 'a', title: 'A', score: 0.9 }));
    is('id / name 也能兜底', JSON.stringify(r.items[1]), JSON.stringify({ slug: 'b', title: 'B', score: 0 }));
    is('total 用 estimatedTotalHits', r.total, 42);
    is('source 自报 meili', r.source, 'meili');
  }
  {
    const boomFetch = async () => ({ ok: false, status: 503, text: async () => 'index_not_found' });
    let threw = null;
    try {
      await meiliBackend({ url: 'http://x', fetchImpl: boomFetch })('hot');
    } catch (e) {
      threw = e;
    }
    is('非 200 抛错并带 status', threw && threw.status, 503);
    ok('错误里带上响应体片段', !!threw && /index_not_found/.test(String(threw.detail || '')), threw && threw.detail);
  }

  // ---------------------------------------------------------------- sqlBackend
  console.log('--- sqlBackend ---');
  {
    const sync = sqlBackend(() => ({ items: [{ slug: 'a' }], total: 7 }));
    const r1 = await sync('hot');
    is('同步 adapter 包成异步', r1.source, 'sql');
    is('total 透传', r1.total, 7);
    const asyncOne = sqlBackend(async (q) => ({ items: [{ slug: q }] }));
    const r2 = await asyncOne('hot');
    is('异步 adapter 也认', r2.items[0].slug, 'hot');
    is('没给 total 就用 items.length', r2.total, 1);
    let threw = null;
    try {
      await sqlBackend(() => {
        throw new Error('db_gone');
      })('hot');
    } catch (e) {
      threw = e;
    }
    is('adapter 抛错原样往上抛（兜不兜由上位决定）', threw && threw.message, 'db_gone');
  }

  // ---------------------------------------------------------------- 缓存：命中 / TTL
  console.log('--- createCache：命中率与 TTL ---');
  {
    let clock = 0;
    let loads = 0;
    const c = createCache({ ttlMs: 100, maxEntries: 10, now: () => clock });
    const load = async () => {
      loads++;
      return 'v' + loads;
    };
    is('首次是 miss，调 loader', await c.getOrLoad('hot', load), 'v1');
    is('第二次是 hit，拿现成值', await c.getOrLoad('hot', load), 'v1');
    is('loader 只跑了一次', loads, 1);
    const s = c.stats();
    is('size', s.size, 1);
    is('hits', s.hits, 1);
    is('misses', s.misses, 1);
    is('loads', s.loads, 1);
    is('inflight 归零', s.inflight, 0);
    is('peek 拿到值', c.peek('hot'), 'v1');
    is('peek 没写过的键给 undefined', c.peek('cold'), undefined);
    clock += 101;
    is('过期后 peek 看不到旧值', c.peek('hot'), undefined);
    is('过期后重新加载', await c.getOrLoad('hot', load), 'v2');
    is('重载后 loads = 2', loads, 2);
    is('重载后 peek 是新值', c.peek('hot'), 'v2');
  }

  // ---------------------------------------------------------------- 缓存：单飞
  console.log('--- createCache：并发单飞 ---');
  {
    let loads = 0;
    let release = null;
    const c = createCache({ ttlMs: 5000 });
    const loader = () => {
      loads++;
      return new Promise((r) => {
        release = r;
      });
    };
    const first = c.getOrLoad('rank:hot', loader);
    is('加载中 inflight = 1', c.stats().inflight, 1);
    const joiners = [];
    for (let i = 0; i < 9; i++) joiners.push(c.getOrLoad('rank:hot', loader));
    is('10 个并发只调 1 次 loader', loads, 1);
    is('loads / misses = 1 / 10', c.stats().loads + '/' + c.stats().misses, '1/10');
    release('V');
    const values = await Promise.all([first, ...joiners]);
    ok('10 个都拿到同一个值', values.every((v) => v === 'V'), JSON.stringify(values));
    is('inflight 归零', c.stats().inflight, 0);
    is('加载完成后再来一次就是 hit', await c.getOrLoad('rank:hot', loader), 'V');
    is('hit 后 loads 仍是 1', c.stats().loads, 1);
  }

  // ---------------------------------------------------------------- 缓存：loader 抛错
  console.log('--- createCache：loader 抛错 ---');
  {
    let calls = 0;
    const c = createCache({ ttlMs: 1000 });
    const bad = () => {
      calls++;
      throw new Error('loader_boom');
    };
    const waits = [];
    for (let i = 0; i < 5; i++) {
      waits.push(
        c.getOrLoad('rank:hot', bad).then(
          () => 'resolved',
          (e) => String(e.message)
        )
      );
    }
    const results = await Promise.all(waits);
    ok('5 个等待者都收到同一个错误', results.every((x) => x === 'loader_boom'), JSON.stringify(results));
    is('loader 只被调了一次', calls, 1);
    is('错误不进缓存', c.stats().size, 0);
    is('peek 为空', c.peek('rank:hot'), undefined);
    is('下一个请求能重新加载', await c.getOrLoad('rank:hot', async () => 'ok'), 'ok');
    is('重载后 size = 1', c.stats().size, 1);
  }

  // ---------------------------------------------------------------- 缓存：容量淘汰
  console.log('--- createCache：容量淘汰（LRU） ---');
  {
    const c = createCache({ ttlMs: 1000, maxEntries: 3 });
    for (const k of ['a', 'b', 'c']) await c.getOrLoad(k, async () => k);
    await c.getOrLoad('a', async () => 'A2'); // 命中 a：a 变成最近使用
    await c.getOrLoad('d', async () => 'd'); // 触发淘汰：最久未用的 b 出局
    is('size 不超过上限', c.stats().size, 3);
    is('evictions 记了 1 次', c.stats().evictions, 1);
    is('最久未用的 b 被淘汰', c.peek('b'), undefined);
    is('刚用过的 a 还在', c.peek('a'), 'a');
    is('新来的 d 进来了', c.peek('d'), 'd');
  }

  // ---------------------------------------------------------------- 缓存：显式失效
  console.log('--- createCache：invalidate / invalidatePrefix / clear ---');
  {
    let loads = 0;
    const c = createCache({ ttlMs: 10000 });
    const load = async (k) => {
      loads++;
      return k + '#' + loads;
    };
    await c.getOrLoad('rank:hot', load);
    await c.getOrLoad('rank:new', load);
    await c.getOrLoad('search:x', load);
    is('invalidate 存在的键返回 true', c.invalidate('rank:hot'), true);
    is('invalidate 不存在的键返回 false', c.invalidate('rank:nope'), false);
    is('键真的没了', c.peek('rank:hot'), undefined);
    is('invalidatePrefix 删掉 1 个', c.invalidatePrefix('rank:'), 1);
    ok('前缀外的键没动', c.peek('search:x') !== undefined, String(c.peek('search:x')));
    is('clear 返回清掉的条数', c.clear(), 1);
    is('clear 后 size = 0', c.stats().size, 0);
    is('clear 不动累计计数器', c.stats().loads, 3);
  }
  {
    let release = null;
    const c = createCache({ ttlMs: 1000 });
    const p = c.getOrLoad('k', () => new Promise((r) => { release = r; }));
    c.invalidate('k');
    release('late');
    await p;
    is('加载中被 invalidate 的值不回写', c.stats().size, 0);
  }

  // ---------------------------------------------------------------- redisLike 适配器
  console.log('--- redisLikeAdapter ---');
  {
    let n = 0;
    const c = redisLikeAdapter(null, { ttlMs: 1000 });
    is('没 client 时 backend = memory', c.stats().backend, 'memory');
    is('没 client 也能用', await c.getOrLoad('a', async () => {
      n++;
      return 1;
    }), 1);
    is('第二次命中内存', await c.getOrLoad('a', async () => {
      n++;
      return 2;
    }), 1);
    is('loader 只跑一次', n, 1);
    is('形状与 createCache 一致', typeof c.peek === 'function' && typeof c.invalidatePrefix === 'function' && typeof c.clear === 'function', true);
  }
  {
    const r = fakeRedis();
    const c = redisLikeAdapter(r.client, { ttlMs: 1000, ttlSeconds: 30, keyPrefix: 'rank:' });
    is('有 client 时 backend = redis', c.stats().backend, 'redis');
    const v = await c.getOrLoad('hot', async () => ({ items: [1, 2, 3] }));
    is('值算出来了', JSON.stringify(v), JSON.stringify({ items: [1, 2, 3] }));
    is('写进远端的键带前缀', r.kv.has('rank:hot'), true);
    is('远端写入带 EX 秒数', JSON.stringify(r.setOpts[0]), JSON.stringify({ EX: 30 }));

    let n = 0;
    const c2 = redisLikeAdapter(r.client, { ttlMs: 1000, ttlSeconds: 30, keyPrefix: 'rank:' });
    const v2 = await c2.getOrLoad('hot', async () => {
      n++;
      return 'from-loader';
    });
    is('新实例（内存为空）直接从远端读到值', JSON.stringify(v2), JSON.stringify({ items: [1, 2, 3] }));
    is('这个实例没调 loader', n, 0);

    await c2.getOrLoad('new', async () => 'n');
    is('远端也有 rank:new', r.kv.has('rank:new'), true);
    is('远端此时 2 个键', r.kv.size, 2);
    // 内存层的键是裸键（'hot'/'new'），keyPrefix 由适配器自己加 —— 所以前缀传空串
    const removedByPrefix = c2.invalidatePrefix('');
    is('内存层按前缀删掉 2 条', removedByPrefix, 2);
    await tick(5);
    is('远端前缀下的键也被一起清了', r.kv.size, 0);

    await c2.getOrLoad('hot', async () => 'again');
    is('重新加载会写回远端', r.kv.has('rank:hot'), true);
    c2.invalidate('hot');
    await tick(5);
    is('invalidate 会删远端键', r.kv.has('rank:hot'), false);
  }
  {
    const boom = {
      async get() {
        throw new Error('redis_down');
      },
      async set() {
        throw new Error('redis_down');
      },
      async del() {
        throw new Error('redis_down');
      },
      async keys() {
        throw new Error('redis_down');
      }
    };
    const c = redisLikeAdapter(boom, { ttlMs: 1000 });
    is('退化前 backend = redis', c.stats().backend, 'redis');
    is('远端读失败仍能算出值', await c.getOrLoad('hot', async () => 'V'), 'V');
    is('backend 自动退化成 memory', c.stats().backend, 'memory');
    is('记下了退化原因', c.stats().lastError, 'redis_down');
    is('退化后第二次直接命中内存', await c.getOrLoad('hot', async () => 'X'), 'V');
    is('退化是粘性的（不再打扰远端）', c.stats().backend, 'memory');
    is('退化后 peek 正常', c.peek('hot'), 'V');
  }
  {
    const r = fakeRedis();
    r.kv.set('bad', '{not json');
    const c = redisLikeAdapter(r.client, { ttlMs: 1000 });
    let n = 0;
    const v = await c.getOrLoad('bad', async () => {
      n++;
      return 'fresh';
    });
    is('远端坏值当未命中', v, 'fresh');
    is('坏值会走 loader', n, 1);
    is('坏值不导致退化', c.stats().backend, 'redis');
  }
}

main()
  .then(() => {
    console.log('');
    console.log('PASS ' + pass + ' / FAIL ' + fail + '（' + (Date.now() - startedAt) + 'ms）');
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error('测试脚本自己炸了：', e);
    process.exit(2);
  });
