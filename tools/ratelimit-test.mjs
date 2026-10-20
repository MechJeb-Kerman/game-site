/**
 * 限流 / 封禁缓存的自测：src/ratelimit.js、worker/ratelimit.js、src/forum-guard.js 的频控段。
 * 跑法：node tools/ratelimit-test.mjs
 * 结尾打印「通过 N / 失败 M」，有失败就 exit 1（附断言名）。
 */
import assert from 'node:assert/strict';
import { createLimiter, createBanCache } from '../src/ratelimit.js';
import * as w from '../worker/ratelimit.js';
import { RATE, rateWindows, rateRejection, createRateGuard, checkRateFast, forumLimiterStats } from '../src/forum-guard.js';

let pass = 0;
const fails = [];
const tests = [];

/** 登记一条用例（同步 / 异步都行） */
function t(name, fn) {
  tests.push([name, fn]);
}

/** 让出一轮事件循环，等异步 store 的 promise 落定 */
function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

/* ---------- 假件 ---------- */

/** 假 store：{ get, set, del } + data/calls 便于断言；可选 async / fail* / failGetAfter */
function fakeStore(opts) {
  const o = opts || {};
  const data = new Map();
  const calls = { get: [], set: [], del: [] };
  function boom(what) {
    const err = new Error(what + ' boom');
    if (o[what] === 'reject') return Promise.reject(err);
    throw err;
  }
  return {
    kind: 'fake',
    data: data,
    calls: calls,
    get: function (key) {
      calls.get.push(key);
      if (o.failGet) return boom('get');
      if (o.failGetAfter !== undefined && calls.get.length > o.failGetAfter) return boom('get');
      const value = data.has(key) ? data.get(key) : null;
      return o.async ? Promise.resolve(value) : value;
    },
    set: function (key, value, ttlMs) {
      calls.set.push({ key: key, value: value, ttlMs: ttlMs });
      if (o.failSet) return boom('set');
      data.set(key, value);
      return o.async ? Promise.resolve(true) : true;
    },
    del: function (key) {
      calls.del.push(key);
      if (o.failDel) return boom('del');
      const had = data.delete(key);
      return o.async ? Promise.resolve(had) : had;
    }
  };
}

/** 假 Cache API：Map<url, Response>，match 未命中给 undefined（与 Cache API 一致） */
function fakeCaches() {
  const data = new Map();
  const calls = { match: [], put: [], delete: [] };
  return {
    data: data,
    calls: calls,
    match: async function (url) {
      calls.match.push(String(url));
      const hit = data.get(String(url));
      return hit ? hit.clone() : undefined;
    },
    put: async function (url, res) {
      calls.put.push({ url: String(url), cacheControl: res.headers.get('Cache-Control') });
      data.set(String(url), res.clone());
    },
    delete: async function (url) {
      calls.delete.push(String(url));
      return data.delete(String(url));
    }
  };
}

/** node 里通常没有全局 caches；有（workerd / 未来 node）就用真的，测试两条路都不炸 */
const GLOBAL_CACHES = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;

/* ================= A. 窗口基础 ================= */

t('限流：首次放行，remaining = max - 1', function () {
  const lim = createLimiter({ windowMs: 1000, max: 3 });
  const r = lim.hit('a', 1000);
  assert.equal(r.ok, true);
  assert.equal(r.limited, false);
  assert.equal(r.remaining, 2);
  assert.equal(r.count, 0);
  assert.equal(r.resetAt, 2000);
});

t('限流：连续 max 次递减到 0，第 max+1 次被拒', function () {
  const lim = createLimiter({ windowMs: 1000, max: 3 });
  assert.equal(lim.hit('k', 1000).remaining, 2);
  assert.equal(lim.hit('k', 1000).remaining, 1);
  assert.equal(lim.hit('k', 1000).remaining, 0);
  const r = lim.hit('k', 1000);
  assert.equal(r.ok, false);
  assert.equal(r.limited, true);
  assert.equal(r.remaining, 0);
  assert.equal(r.count, 3);
  assert.equal(lim.stats().hits, 4);
  assert.equal(lim.stats().limited, 1);
});

t('限流：被拒的那次不记账（resetAt / count 都不变）', function () {
  const lim = createLimiter({ windowMs: 1000, max: 2 });
  lim.hit('k', 1000);
  lim.hit('k', 1000);
  const first = lim.hit('k', 1500);
  assert.equal(first.limited, true);
  assert.equal(first.resetAt, 2000);
  const second = lim.hit('k', 1900);
  assert.equal(second.limited, true);
  assert.equal(second.resetAt, 2000);
  assert.equal(second.count, 2);
  assert.equal(lim.peek('k', 1900).count, 2);
});

t('限流：窗口滑动——t+windowMs-1 仍拒，t+windowMs 放行', function () {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  assert.equal(lim.hit('k', 1000).ok, true);
  assert.equal(lim.hit('k', 1999).ok, false);
  const back = lim.hit('k', 2000);
  assert.equal(back.ok, true);
  assert.equal(back.count, 0);
  assert.equal(lim.hit('k', 2000).ok, false);
});

t('限流：不同 key 互不影响', function () {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  assert.equal(lim.hit('x', 1000).ok, true);
  assert.equal(lim.hit('y', 1000).ok, true);
  assert.equal(lim.hit('x', 1000).ok, false);
  assert.equal(lim.hit('y', 1000).ok, false);
  assert.equal(lim.stats().size, 2);
});

t('限流：keyPrefix 隔离两套计数', function () {
  const a = createLimiter({ windowMs: 1000, max: 1, keyPrefix: 'p1:' });
  const b = createLimiter({ windowMs: 1000, max: 1, keyPrefix: 'p2:' });
  assert.equal(a.hit('k', 1000).ok, true);
  assert.equal(b.hit('k', 1000).ok, true);
  assert.equal(a.hit('k', 1000).ok, false);
  assert.equal(b.hit('k', 1000).ok, false);
});

t('限流：key 一律 String()，1 与 "1" 同键', function () {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  assert.equal(lim.hit(1, 1000).ok, true);
  assert.equal(lim.hit('1', 1000).ok, false);
  assert.equal(lim.stats().size, 1);
});

t('限流：默认 windowMs=60000、max=10', function () {
  const s = createLimiter().stats();
  assert.equal(s.windowMs, 60000);
  assert.equal(s.max, 10);
  assert.equal(s.keyPrefix, '');
  assert.equal(s.backend, 'memory');
  for (const key of ['size', 'hits', 'limited', 'evictions', 'sweeps', 'sweptKeys', 'storeGets', 'storeSets', 'storeErrors', 'degraded', 'lastError']) {
    assert.ok(key in s, 'stats 缺少 ' + key);
  }
});

t('限流：windowMs=0 视为不限', function () {
  const lim = createLimiter({ windowMs: 0, max: 1 });
  for (let i = 0; i < 5; i++) assert.equal(lim.hit('k', 1000).ok, true);
  assert.equal(lim.stats().size, 1);
});

t('限流：max=0 兜底成 1', function () {
  const lim = createLimiter({ max: 0 });
  assert.equal(lim.stats().max, 1);
  assert.equal(lim.hit('k', 1).ok, true);
  assert.equal(lim.hit('k', 1).ok, false);
});

t('限流：opts.now 时钟函数在省略 now 参数时生效', function () {
  let clock = 1000;
  const lim = createLimiter({ windowMs: 1000, max: 1, now: function () { return clock; } });
  assert.equal(lim.hit('k').ok, true);
  clock = 1500;
  assert.equal(lim.hit('k').ok, false);
  clock = 2000;
  assert.equal(lim.hit('k').ok, true);
});

/* ================= B. 容量、清理、统计 ================= */

t('peek：不记账，空 key 返回满额', function () {
  const lim = createLimiter({ windowMs: 1000, max: 3 });
  assert.deepEqual(lim.peek('none', 1000), { count: 0, remaining: 3, resetAt: 2000, limited: false });
  lim.hit('k', 1000);
  assert.deepEqual(lim.peek('k', 1000), { count: 1, remaining: 2, resetAt: 2000, limited: false });
  assert.deepEqual(lim.peek('k', 1000), lim.peek('k', 1000));
  assert.equal(lim.stats().hits, 1);
});

t('peek：满窗口如实报 limited，过期后恢复', function () {
  const lim = createLimiter({ windowMs: 1000, max: 2 });
  lim.hit('k', 1000);
  lim.hit('k', 1000);
  assert.equal(lim.peek('k', 1000).limited, true);
  assert.equal(lim.peek('k', 2000).limited, false);
});

t('reset：清本实例的窗口并返回是否存在', function () {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  lim.hit('k', 1000);
  assert.equal(lim.reset('k'), true);
  assert.equal(lim.reset('k'), false);
  assert.equal(lim.peek('k', 1000).count, 0);
  assert.equal(lim.hit('k', 1000).ok, true);
});

t('sweep：清掉过期 key、保留窗口内的，stats 累计', function () {
  const lim = createLimiter({ windowMs: 1000, max: 5 });
  lim.hit('old', 1000);
  lim.hit('fresh', 5000);
  assert.equal(lim.sweep(5000), 1);
  assert.equal(lim.stats().size, 1);
  assert.equal(lim.stats().sweeps, 1);
  assert.equal(lim.stats().sweptKeys, 1);
  assert.equal(lim.sweep(5999), 0);
  assert.equal(lim.sweep(6000), 1);
  assert.equal(lim.stats().size, 0);
  assert.equal(lim.stats().sweptKeys, 2);
});

t('惰性清理：过期 key 再 hit 从零算，size 不涨', function () {
  const lim = createLimiter({ windowMs: 1000, max: 1 });
  lim.hit('k', 1000);
  assert.equal(lim.stats().size, 1);
  const r = lim.hit('k', 2500);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(lim.stats().size, 1);
});

t('maxKeys：超上限按最久未使用淘汰，size 不越界', function () {
  const lim = createLimiter({ windowMs: 100000, max: 5, maxKeys: 2 });
  lim.hit('a', 1000);
  lim.hit('b', 1000);
  lim.hit('c', 1000);
  assert.equal(lim.stats().size, 2);
  assert.equal(lim.stats().evictions, 1);
  assert.equal(lim.peek('a', 1000).count, 0);
});

t('maxKeys：被淘汰的 key 回来重新计数', function () {
  const lim = createLimiter({ windowMs: 100000, max: 1, maxKeys: 1 });
  lim.hit('a', 1000);
  lim.hit('b', 1000);
  assert.equal(lim.hit('a', 1000).ok, true);
  assert.equal(lim.stats().size, 1);
});

/* ================= C. store 注入 ================= */

t('store：只在 key 首次出现时读一次', function () {
  const store = fakeStore();
  const lim = createLimiter({ windowMs: 1000, max: 3, store: store });
  lim.hit('k', 1000);
  lim.hit('k', 1000);
  lim.hit('k', 1000);
  assert.equal(store.calls.get.length, 1);
  assert.equal(lim.stats().storeGets, 1);
  assert.equal(lim.stats().backend, 'memory+store');
});

t('store：每次放行写回，键带前缀、ttl = windowMs', function () {
  const store = fakeStore();
  const lim = createLimiter({ windowMs: 1500, max: 5, keyPrefix: 'rl:', store: store });
  lim.hit('k', 1000);
  lim.hit('k', 2000);
  assert.equal(store.calls.set.length, 2);
  assert.equal(store.calls.set[0].key, 'rl:k');
  assert.equal(store.calls.set[0].ttlMs, 1500);
  const payload = JSON.parse(store.calls.set[1].value);
  assert.equal(payload.v, 1);
  assert.deepEqual(payload.hits, [1000, 2000]);
  assert.equal(lim.stats().storeSets, 2);
});

t('store：远端已有满窗口 → 本地首击即被拒（同步 store 当场合并）', function () {
  const store = fakeStore();
  store.data.set('k', JSON.stringify({ v: 1, hits: [900, 800], at: 1000 }));
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  const r = lim.hit('k', 1000);
  assert.equal(r.limited, true);
  assert.equal(r.count, 2);
});

t('store：远端窗口外的旧记录被丢掉', function () {
  const store = fakeStore();
  store.data.set('k', JSON.stringify({ v: 1, hits: [10, 20], at: 100000 }));
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  const r = lim.hit('k', 100000);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
});

t('store：远端值不是合法 JSON 时当空窗口，不抛错', function () {
  const store = fakeStore();
  store.data.set('k', 'not-json');
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  assert.equal(lim.hit('k', 1000).ok, true);
  assert.equal(lim.stats().storeErrors, 0);
});

t('store：异步 store 的合并交给下一次调用', async function () {
  const store = fakeStore({ async: true });
  store.data.set('k', JSON.stringify({ v: 1, hits: [900, 950], at: 1000 }));
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  assert.equal(lim.hit('k', 1000).ok, true);
  await tick();
  const second = lim.hit('k', 1000);
  assert.equal(second.limited, true);
  assert.equal(second.count, 3);
});

t('store：读同步抛错 → 不外抛、降级为纯内存', function () {
  const store = fakeStore({ failGet: 'throw' });
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  assert.equal(lim.hit('k', 1000).ok, true);
  const s = lim.stats();
  assert.equal(s.degraded, true);
  assert.equal(s.backend, 'memory');
  assert.equal(s.storeErrors, 1);
  assert.match(s.lastError, /get boom/);
});

t('store：读 reject 同样降级，且之后不再读 store', async function () {
  const store = fakeStore({ failGet: 'reject' });
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  lim.hit('k', 1000);
  await tick();
  assert.equal(lim.stats().degraded, true);
  const before = store.calls.get.length;
  lim.hit('k', 1000);
  lim.hit('other', 1000);
  assert.equal(store.calls.get.length, before);
  assert.equal(lim.stats().backend, 'memory');
});

t('store：写同步抛错只记账不降级', function () {
  const store = fakeStore({ failSet: 'throw' });
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  assert.equal(lim.hit('k', 1000).ok, true);
  const s = lim.stats();
  assert.equal(s.storeErrors, 1);
  assert.equal(s.degraded, false);
  assert.equal(s.backend, 'memory+store');
  assert.match(s.lastError, /set boom/);
});

t('store：写 reject 只记账不降级', async function () {
  const store = fakeStore({ async: true, failSet: 'reject' });
  const lim = createLimiter({ windowMs: 1000, max: 2, store: store });
  lim.hit('k', 1000);
  await tick();
  assert.equal(lim.stats().storeErrors, 1);
  assert.equal(lim.stats().degraded, false);
});

t('store：不像 store 的对象当没有（只看有没有 get）', function () {
  const lim = createLimiter({ windowMs: 1000, max: 2, store: { set: function () {} } });
  assert.equal(lim.stats().backend, 'memory');
  assert.equal(lim.hit('k', 1000).ok, true);
});

/* ================= D. BanCache ================= */

t('BanCache：未命中调 loader 并缓存，第二次不再调', async function () {
  const cache = createBanCache({ ttlMs: 60000, now: function () { return 1000; } });
  let calls = 0;
  const loader = async function (uid) { calls++; return uid === 7; };
  assert.equal(await cache.isBanned(7, loader), true);
  assert.equal(await cache.isBanned(7, loader), true);
  assert.equal(calls, 1);
  const s = cache.stats();
  assert.equal(s.loads, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.hits, 1);
  assert.equal(s.backend, 'memory');
});

t('BanCache：loader 收到原样的 userId', async function () {
  const cache = createBanCache();
  let seen = null;
  await cache.isBanned('u-9', async function (uid) { seen = uid; return 1; });
  assert.equal(seen, 'u-9');
});

t('BanCache：非布尔值原样缓存（对调用方透明）', async function () {
  const cache = createBanCache();
  const value = { banned: true, reason: '广告' };
  assert.deepEqual(await cache.isBanned(8, async function () { return value; }), value);
  assert.deepEqual(cache.peek(8).value, value);
});

t('BanCache：peek 看得到本地副本与到期时刻', async function () {
  const cache = createBanCache({ ttlMs: 1000, now: function () { return 500; } });
  assert.deepEqual(cache.peek(3), { cached: false, value: undefined, expiresAt: 0 });
  await cache.isBanned(3, async function () { return 'yes'; });
  const p = cache.peek(3);
  assert.equal(p.cached, true);
  assert.equal(p.value, 'yes');
  assert.equal(p.expiresAt, 1500);
});

t('BanCache：ttl 到期后重新 load', async function () {
  let clock = 0;
  const cache = createBanCache({ ttlMs: 1000, now: function () { return clock; } });
  let calls = 0;
  const loader = async function () { calls++; return calls; };
  assert.equal(await cache.isBanned(1, loader), 1);
  clock = 999;
  assert.equal(await cache.isBanned(1, loader), 1);
  clock = 1000;
  assert.equal(await cache.isBanned(1, loader), 2);
  assert.equal(calls, 2);
});

t('BanCache：ttlMs=Infinity 永不过期', async function () {
  let clock = 0;
  const cache = createBanCache({ ttlMs: Infinity, now: function () { return clock; } });
  let calls = 0;
  await cache.isBanned(1, async function () { calls++; return 'x'; });
  clock = 1000000000000;
  assert.equal(await cache.isBanned(1, async function () { calls++; return 'x'; }), 'x');
  assert.equal(calls, 1);
  assert.equal(cache.peek(1).expiresAt, Infinity);
});

t('BanCache：ttlMs=0 表示不缓存（每次都 load）', async function () {
  const cache = createBanCache({ ttlMs: 0, now: function () { return 1000; } });
  let calls = 0;
  const loader = async function () { calls++; return calls; };
  assert.equal(await cache.isBanned(1, loader), 1);
  assert.equal(await cache.isBanned(1, loader), 2);
  assert.equal(calls, 2);
});

t('BanCache：invalidate 清本实例（无 store 时 broadcast=false）', async function () {
  const cache = createBanCache();
  await cache.isBanned(5, async function () { return true; });
  assert.deepEqual(cache.invalidate(5), { local: true, broadcast: false });
  assert.deepEqual(cache.invalidate(5), { local: false, broadcast: false });
  assert.equal(cache.peek(5).cached, false);
  assert.equal(cache.stats().invalidations, 2);
  assert.equal(cache.stats().broadcasts, 0);
});

t('BanCache：有 store 时写入 store，键带默认前缀', async function () {
  const store = fakeStore();
  const cache = createBanCache({ ttlMs: 60000, store: store, now: function () { return 1000; } });
  assert.deepEqual(await cache.isBanned(11, async function () { return { banned: true }; }), { banned: true });
  assert.equal(store.calls.set.length, 1);
  assert.equal(store.calls.set[0].key, 'ban:11');
  assert.equal(store.calls.set[0].ttlMs, 60000);
  const payload = JSON.parse(store.calls.set[0].value);
  assert.equal(payload.value.banned, true);
  assert.equal(payload.expiresAt, 61000);
  assert.equal(cache.stats().storeSets, 1);
});

t('BanCache：跨实例共用 store → loader 只调一次', async function () {
  const store = fakeStore();
  const a = createBanCache({ store: store, now: function () { return 1000; } });
  const b = createBanCache({ store: store, now: function () { return 1000; } });
  let loads = 0;
  assert.equal(await a.isBanned(21, async function () { loads++; return 'A'; }), 'A');
  assert.equal(await b.isBanned(21, async function () { loads++; return 'B'; }), 'A');
  assert.equal(loads, 1);
  assert.equal(b.stats().loads, 0);
  assert.equal(b.stats().storeHits, 1);
  assert.equal(b.stats().backend, 'memory+store');
});

t('BanCache：invalidate 广播后另一实例重新 load 拿到新值', async function () {
  const store = fakeStore();
  const a = createBanCache({ store: store, now: function () { return 1000; } });
  const b = createBanCache({ store: store, now: function () { return 1000; } });
  let version = 1;
  await a.isBanned(31, async function () { return version; });
  assert.equal(await b.isBanned(31, async function () { return version; }), 1);
  version = 2;
  const r = a.invalidate(31);
  assert.equal(r.local, true);
  assert.equal(r.broadcast, true);
  assert.deepEqual(store.calls.del, ['ban:31']);
  assert.equal(store.data.has('ban:31'), false);
  assert.equal(await b.isBanned(31, async function () { return version; }), 2);
  assert.equal(a.stats().broadcasts, 1);
  assert.equal(b.stats().loads, 1);
});

t('BanCache：del 同步抛错不外抛，本地已清、记 storeErrors', async function () {
  const store = fakeStore({ failDel: 'throw' });
  const cache = createBanCache({ store: store, now: function () { return 1000; } });
  await cache.isBanned(41, async function () { return true; });
  const r = cache.invalidate(41);
  assert.deepEqual(r, { local: true, broadcast: false });
  assert.equal(cache.stats().storeErrors, 1);
  assert.equal(cache.peek(41).cached, false);
});

t('BanCache：读 store 出错即降级，同一次调用内就用本地副本兜底', async function () {
  const store = fakeStore({ failGetAfter: 1 });
  const cache = createBanCache({ store: store, now: function () { return 1000; } });
  let loads = 0;
  const loader = async function () { loads++; return 'v'; };
  assert.equal(await cache.isBanned(61, loader), 'v');
  assert.equal(await cache.isBanned(61, loader), 'v');
  assert.equal(loads, 1);
  assert.equal(cache.stats().degraded, true);
  assert.equal(cache.stats().backend, 'memory');
  assert.equal(cache.stats().hits, 1);
  await cache.isBanned(61, loader);
  assert.equal(loads, 1);
});

t('BanCache：loader 抛错往外抛，且不写缓存', async function () {
  const cache = createBanCache({ now: function () { return 1000; } });
  let calls = 0;
  const bad = async function () { calls++; throw new Error('db down'); };
  await assert.rejects(function () { return cache.isBanned(71, bad); }, /db down/);
  await assert.rejects(function () { return cache.isBanned(71, bad); }, /db down/);
  assert.equal(calls, 2);
  assert.equal(cache.peek(71).cached, false);
});

t('BanCache：maxEntries 上限淘汰最久未用', async function () {
  const cache = createBanCache({ maxEntries: 2, now: function () { return 1000; } });
  await cache.isBanned(1, async function () { return 1; });
  await cache.isBanned(2, async function () { return 2; });
  await cache.isBanned(3, async function () { return 3; });
  const s = cache.stats();
  assert.equal(s.size, 2);
  assert.equal(s.evictions, 1);
  assert.equal(cache.peek(1).cached, false);
  assert.equal(cache.peek(3).cached, true);
});

t('BanCache：stats 字段齐全', function () {
  const s = createBanCache().stats();
  for (const key of ['ttlMs', 'keyPrefix', 'size', 'backend', 'hits', 'misses', 'loads', 'evictions', 'invalidations', 'broadcasts', 'storeGets', 'storeHits', 'storeSets', 'storeDels', 'storeErrors', 'degraded', 'lastError']) {
    assert.ok(key in s, 'stats 缺少 ' + key);
  }
  assert.equal(s.ttlMs, 60000);
  assert.equal(s.keyPrefix, 'ban:');
});

/* ================= E. worker 版（Cache API） ================= */

t('worker：resolveCache 显式注入优先；没有全局 caches 时是 null', function () {
  const fc = fakeCaches();
  assert.equal(w.resolveCache({ cache: fc }), fc);
  assert.equal(w.cacheStore(null), null);
  assert.equal(w.cacheStore({}), null);
  if (!GLOBAL_CACHES) assert.equal(w.resolveCache({}), null);
});

t('worker：没有 cache 时退化成 isolate 内存，行为与 src 版一致', async function () {
  const lim = w.createLimiter({ windowMs: 1000, max: 2, cache: GLOBAL_CACHES });
  assert.equal((await lim.hit('k', 1000)).ok, true);
  assert.equal((await lim.hit('k', 1000)).remaining, 0);
  const r = await lim.hit('k', 1000);
  assert.equal(r.limited, true);
  assert.equal(r.count, 2);
  const s = lim.stats();
  assert.equal(s.backend, 'memory');
  assert.equal(s.storeKind, 'none');
  assert.equal(s.limited, 1);
});

t('worker：hit 是异步的，peek / stats 是同步的', async function () {
  const lim = w.createLimiter({ windowMs: 1000, max: 1, cache: GLOBAL_CACHES });
  const pending = lim.hit('k', 1000);
  assert.equal(typeof pending.then, 'function');
  await pending;
  assert.equal(lim.peek('k', 1000).limited, true);
  assert.equal(lim.stats().size, 1);
});

t('worker：cacheStore 的 URL 带命名空间，ttl 秒向上取整', async function () {
  const fc = fakeCaches();
  const store = w.cacheStore(fc, { baseUrl: 'https://example.invalid', namespace: 'ns1' });
  assert.equal(store.kind, 'cache-api');
  assert.equal(store.urlOf('a b'), 'https://example.invalid/ns1/a%20b');
  await store.set('a b', 'v', 1500);
  assert.equal(fc.calls.put[0].url, 'https://example.invalid/ns1/a%20b');
  assert.equal(fc.calls.put[0].cacheControl, 'max-age=2');
  assert.equal(await store.get('a b'), 'v');
  assert.equal(await store.get('missing'), null);
  await store.set('x', 'y', Infinity);
  assert.equal(fc.calls.put[1].cacheControl, 'max-age=1');
  await store.del('a b');
  assert.equal(await store.get('a b'), null);
});

t('worker：默认命名空间是 CACHE_NS', function () {
  const fc = fakeCaches();
  const store = w.cacheStore(fc);
  assert.equal(store.urlOf('k').indexOf('https://game-site-ratelimit.invalid/' + w.CACHE_NS + '/'), 0);
  assert.equal(store.urlOf('k'), 'https://game-site-ratelimit.invalid/' + w.CACHE_NS + '/k');
});

t('worker：cache 跨实例读穿（A 写、B 首击即限流）', async function () {
  const fc = fakeCaches();
  const waits = [];
  const a = w.createLimiter({ windowMs: 1000, max: 1, cache: fc, waitUntil: function (p) { waits.push(p); } });
  assert.equal((await a.hit('k', 1000)).ok, true);
  await Promise.all(waits);
  assert.equal(fc.calls.put.length, 1);
  assert.match(fc.calls.put[0].cacheControl, /^max-age=1$/);
  const b = w.createLimiter({ windowMs: 1000, max: 1, cache: fc });
  const second = await b.hit('k', 1000);
  assert.equal(second.limited, true);
  assert.equal(b.stats().backend, 'memory+store');
  assert.equal(b.stats().storeKind, 'cache-api');
  assert.equal(b.stats().storeGets, 1);
});

t('worker：match 出错 → 降级为内存，不外抛', async function () {
  const fc = fakeCaches();
  fc.match = async function () { throw new Error('match boom'); };
  const lim = w.createLimiter({ windowMs: 1000, max: 2, cache: fc });
  assert.equal((await lim.hit('k', 1000)).ok, true);
  assert.equal(lim.stats().degraded, true);
  assert.equal(lim.stats().backend, 'memory');
  assert.match(lim.stats().lastError, /match boom/);
});

t('worker：BanCache 跨实例共享 Cache API，await invalidate 广播', async function () {
  const fc = fakeCaches();
  const a = w.createBanCache({ cache: fc, now: function () { return 1000; } });
  const b = w.createBanCache({ cache: fc, now: function () { return 1000; } });
  let loads = 0;
  assert.equal(await a.isBanned(9, async function () { loads++; return 'banned'; }), 'banned');
  assert.equal(await b.isBanned(9, async function () { loads++; return 'ok'; }), 'banned');
  assert.equal(loads, 1);
  assert.equal(b.stats().storeHits, 1);
  const r = await a.invalidate(9);
  assert.equal(r.local, true);
  assert.equal(r.broadcast, true);
  assert.equal(fc.calls.delete.length, 1);
  assert.equal(await b.isBanned(9, async function () { loads++; return 'second'; }), 'second');
  assert.equal(loads, 2);
});

t('worker：BanCache 本地 ttl 到期后重新 load', async function () {
  let clock = 0;
  const cache = w.createBanCache({ ttlMs: 1000, cache: GLOBAL_CACHES, now: function () { return clock; } });
  let calls = 0;
  const loader = async function () { calls++; return calls; };
  assert.equal(await cache.isBanned(1, loader), 1);
  clock = 1000;
  assert.equal(await cache.isBanned(1, loader), 2);
  assert.equal(calls, 2);
  assert.equal(cache.stats().storeKind, 'none');
});

t('worker：sweep / reset / stats', async function () {
  const lim = w.createLimiter({ windowMs: 1000, max: 3, cache: GLOBAL_CACHES });
  await lim.hit('a', 1000);
  await lim.hit('b', 5000);
  assert.equal(lim.sweep(5000), 1);
  assert.equal(lim.stats().size, 1);
  assert.equal(lim.stats().sweptKeys, 1);
  assert.equal(lim.reset('b'), true);
  assert.equal(lim.stats().size, 0);
});

/* ================= F. forum-guard 接线 ================= */

t('forum-guard：RATE 常量结构不变（原调用方语义不变）', function () {
  assert.deepEqual(RATE, {
    thread: { gapSeconds: 60, perDay: 10, label: '主题' },
    post: { gapSeconds: 20, perDay: 50, label: '回复' },
    report: { gapSeconds: 0, perHour: 5, label: '举报' }
  });
});

t('forum-guard：rateWindows 把 RATE 拆成滑动窗口', function () {
  assert.deepEqual(rateWindows('thread'), [
    { scope: 'gap', windowMs: 60000, max: 1 },
    { scope: 'day', windowMs: 86400000, max: 10 }
  ]);
  assert.deepEqual(rateWindows('post'), [
    { scope: 'gap', windowMs: 20000, max: 1 },
    { scope: 'day', windowMs: 86400000, max: 50 }
  ]);
  assert.deepEqual(rateWindows('report'), [{ scope: 'hour', windowMs: 3600000, max: 5 }]);
  assert.deepEqual(rateWindows('没有这个 kind'), rateWindows('post'));
});

t('forum-guard：rateRejection 的码与文案与数据层逐字一致', function () {
  assert.deepEqual(rateRejection('thread', 'gap'), { error: 'too_fast', message: '发得太快了，60 秒内只能发一条' });
  assert.deepEqual(rateRejection('post', 'gap'), { error: 'too_fast', message: '发得太快了，20 秒内只能发一条' });
  assert.deepEqual(rateRejection('thread', 'day'), { error: 'daily', message: '今天主题的数量到上限了（10 条）' });
  assert.deepEqual(rateRejection('post', 'day'), { error: 'daily', message: '今天回复的数量到上限了（50 条）' });
  assert.deepEqual(rateRejection('report', 'hour'), { error: 'hourly', message: '一小时内最多举报 5 次' });
  for (const bad of [rateRejection('thread', 'gap'), rateRejection('post', 'day'), rateRejection('report', 'hour')]) {
    assert.deepEqual(Object.keys(bad).sort(), ['error', 'message']);
  }
});

t('forum-guard：check 首次放行、gap 窗口内第二次拒、过了间隔又能发', function () {
  const g = createRateGuard();
  assert.deepEqual(g.check('post', 101, 5000), { ok: true });
  const r = g.check('post', 101, 6000);
  assert.equal(r.error, 'too_fast');
  assert.equal(r.message, '发得太快了，20 秒内只能发一条');
  assert.deepEqual(g.check('post', 101, 25001), { ok: true });
});

t('forum-guard：举报走 hour 窗口，第 6 次拒且不消耗配额', function () {
  const g = createRateGuard();
  for (let i = 0; i < 5; i++) assert.deepEqual(g.check('report', 102, 1000 + i), { ok: true });
  const r = g.check('report', 102, 1005);
  assert.equal(r.error, 'hourly');
  assert.equal(r.message, '一小时内最多举报 5 次');
  assert.equal(g.stats()['report:hour'].hits, 5);
  assert.equal(g.stats()['report:hour'].limited, 0);
});

t('forum-guard：间隔够久时 thread 满 10 条后撞 day 上限', function () {
  const g = createRateGuard();
  const t0 = 1700000000000;
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(g.check('thread', 103, t0 + i * 61000), { ok: true }, '第 ' + (i + 1) + ' 条应放行');
  }
  const r = g.check('thread', 103, t0 + 10 * 61000);
  assert.equal(r.error, 'daily');
  assert.equal(r.message, '今天主题的数量到上限了（10 条）');
});

t('forum-guard：不同 userId 互不影响', function () {
  const g = createRateGuard();
  assert.deepEqual(g.check('post', 104, 1000), { ok: true });
  assert.deepEqual(g.check('post', 105, 1000), { ok: true });
  assert.equal(g.check('post', 104, 1000).error, 'too_fast');
});

t('forum-guard：createRateGuard 注入 store 后走 store（键带 rl:forum: 前缀）', function () {
  const store = fakeStore();
  const g = createRateGuard({ store: store });
  assert.deepEqual(g.check('post', 106, 1000), { ok: true });
  assert.equal(store.calls.set.length, 2);
  assert.equal(store.calls.set[0].key, 'rl:forum:post:gap:106');
  assert.equal(store.calls.set[0].ttlMs, 20000);
  assert.equal(store.calls.set[1].key, 'rl:forum:post:day:106');
  assert.equal(store.calls.set[1].ttlMs, 86400000);
  assert.equal(g.limiterFor('post', 'day').stats().max, 50);
  assert.equal(g.limiterFor('post', '没有这个窗口'), null);
  assert.equal(g.stats()['post:gap'].backend, 'memory+store');
});

t('forum-guard：report 没有 gap 窗口，limiterFor 如实返回 null', function () {
  const g = createRateGuard();
  assert.equal(g.limiterFor('report', 'gap'), null);
  assert.ok(g.limiterFor('report', 'hour'));
  assert.ok(g.limiterFor('thread', 'gap'));
});

t('forum-guard：sweep 只清过期的窗口', function () {
  const g = createRateGuard();
  assert.deepEqual(g.check('post', 108, 1000), { ok: true });
  assert.equal(g.stats()['post:gap'].size, 1);
  assert.equal(g.stats()['post:day'].size, 1);
  assert.equal(g.sweep(21001), 1);
  assert.equal(g.stats()['post:gap'].size, 0);
  assert.equal(g.stats()['post:day'].size, 1);
  assert.equal(g.sweep(1000 + 86400001), 1);
  assert.equal(g.stats()['post:day'].size, 0);
});

t('forum-guard：默认 guard 的 checkRateFast 与 forumLimiterStats', function () {
  const t0 = 1700000100000;
  assert.deepEqual(checkRateFast('report', 107, t0), { ok: true });
  assert.deepEqual(checkRateFast('report', 107, t0 + 1), { ok: true });
  const s = forumLimiterStats();
  assert.ok(s['report:hour'].hits >= 2);
  for (const key of ['thread:gap', 'thread:day', 'post:gap', 'post:day', 'report:hour']) {
    assert.ok(key in s, 'stats 缺少 ' + key);
  }
  assert.equal(s['thread:gap'].windowMs, 60000);
  assert.equal(s['thread:gap'].max, 1);
  assert.equal(s['post:day'].max, 50);
  assert.equal(s['report:hour'].windowMs, 3600000);
});

/* ---------- 跑 ---------- */

const started = Date.now();
for (const entry of tests) {
  try {
    await entry[1]();
    pass++;
  } catch (err) {
    fails.push({ name: entry[0], err: err });
  }
}

for (const f of fails) {
  console.log('✗ ' + f.name);
  console.log('    ' + (f.err && f.err.message ? String(f.err.message) : String(f.err)));
}

console.log('通过 ' + pass + ' / 失败 ' + fails.length + '（' + (Date.now() - started) + 'ms，共 ' + tests.length + ' 条用例）');
if (fails.length) process.exitCode = 1;
