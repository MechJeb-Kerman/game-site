/**
 * 黑名单规则编译缓存的跨实例自测：src/ratelimit.js、worker/ratelimit.js 的共享介质段
 *（memoryStore / redisLikeAdapter / rulesFingerprint / createRuleCache，以及 createBanCache 的规则版本）。
 * 跑法：node tools/ratelimit-shared-test.mjs
 * 结尾打印「通过 N / 失败 M」，有失败就 exit 1（附断言名）。
 * 全程进程内假介质：不连 Redis、不连 D1、不碰真库、不起 HTTP 服务、不占端口。
 */
import assert from 'node:assert/strict';
import {
  memoryStore,
  redisLikeAdapter,
  rulesFingerprint,
  createRuleCache,
  createBanCache,
  createLimiter
} from '../src/ratelimit.js';
import * as w from '../worker/ratelimit.js';

let pass = 0;
const fails = [];
const tests = [];

/** 登记一条用例（同步 / 异步都行） */
function t(name, fn) {
  tests.push([name, fn]);
}

/** 让出一轮事件循环，等异步 store 的 promise 落定 */
function tick() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

/* ---------- 假件 ---------- */

/** 进程内假介质：get/set/del 一律异步，data/calls 便于断言；可选 failGet / failGetAfter(n) / failSet / failDel */
function fakeMedia(opts) {
  const o = opts || {};
  const clock = typeof o.now === 'function' ? o.now : Date.now;
  const data = new Map();
  const calls = { get: [], set: [], del: [] };
  let gets = 0;
  function boom(what) {
    throw new Error('media ' + what + ' boom');
  }
  return {
    kind: 'fake-media',
    data: data,
    calls: calls,
    async get(key) {
      gets++;
      calls.get.push(String(key));
      if (o.failGet) boom('get');
      if (o.failGetAfter && gets > o.failGetAfter) boom('get');
      const k = String(key);
      const entry = data.get(k);
      if (!entry) return null;
      if (entry.expiresAt <= clock()) {
        data.delete(k);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      calls.set.push([String(key), String(value), ttlMs]);
      if (o.failSet) boom('set');
      const ttl = Number.isFinite(ttlMs) ? ttlMs : Infinity;
      data.set(String(key), { value: String(value), expiresAt: ttl === Infinity ? Infinity : clock() + ttl });
      return true;
    },
    async del(key) {
      calls.del.push(String(key));
      if (o.failDel) boom('del');
      return data.delete(String(key));
    }
  };
}

/** 假 Cache API：只实现 worker 的 cacheStore 认的 match / put / delete（URL 用字符串当 key） */
function fakeCache(opts) {
  const o = opts || {};
  const data = new Map();
  const calls = { match: [], put: [], delete: [] };
  function urlOf(req) {
    return String(req && req.url ? req.url : req);
  }
  return {
    kind: 'fake-cache',
    data: data,
    calls: calls,
    async match(req) {
      const url = urlOf(req);
      calls.match.push(url);
      if (o.failMatch) throw new Error('cache match boom');
      const entry = data.get(url);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        data.delete(url);
        return undefined;
      }
      return {
        headers: { get: function (name) { return String(name).toLowerCase() === 'cache-control' ? entry.cc : null; } },
        text: async function () { return entry.body; }
      };
    },
    async put(req, res) {
      const url = urlOf(req);
      const cc = res && res.headers && res.headers.get ? res.headers.get('Cache-Control') : null;
      const body = await res.text();
      const secs = Number((String(cc).match(/max-age=([0-9]+)/) || [0, 0])[1]) || 0;
      calls.put.push([url, cc]);
      data.set(url, { body: body, cc: cc, expiresAt: secs > 0 ? Date.now() + secs * 1000 : Infinity });
      return undefined;
    },
    async delete(req) {
      const url = urlOf(req);
      calls.delete.push(url);
      if (o.failDelete) throw new Error('cache delete boom');
      return data.delete(url);
    }
  };
}

/** 截获 console.warn：bash 里不方便看 stderr，日志断言直接在进程内做 */
async function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = function () {
    lines.push(Array.prototype.map.call(arguments, String).join(' '));
  };
  try {
    const value = await fn();
    return { value: value, lines: lines };
  } finally {
    console.warn = orig;
  }
}

/** 一个会编译出真 RegExp 的 compileFn，带调用计数 */
function compiler() {
  const box = { calls: 0 };
  box.fn = async function (key) {
    box.calls++;
    await tick();
    return {
      key: String(key),
      rules: [
        { kind: 'regex', action: 'reject', pattern: 'bad', re: new RegExp('bad', 'i') },
        { kind: 'word', action: 'review', pattern: 'spam', needle: 'spam' }
      ]
    };
  };
  return box;
}

const BAN_STATS = [
  'backend', 'broadcasts', 'degraded', 'evictions', 'hits', 'invalidations', 'keyPrefix', 'lastError',
  'loads', 'misses', 'size', 'storeDels', 'storeErrors', 'storeGets', 'storeHits', 'storeSets', 'ttlMs'
];

/* ---------- A. 共享介质本身 ---------- */

t('memoryStore：get/set/del/keys/clear 与 stats', async function () {
  const ms = memoryStore({ maxEntries: 4, ttlMs: 1000 });
  assert.equal(ms.kind, 'memory-store');
  assert.equal(ms.get('a'), null);
  assert.equal(ms.set('a', 'v1'), true);
  assert.equal(ms.get('a'), 'v1');
  assert.equal(ms.set('b', 'v2', 0), false, 'ttlMs<=0 表示不缓存');
  assert.equal(ms.get('b'), null);
  assert.deepEqual(ms.keys('*').sort(), ['a']);
  assert.deepEqual(ms.keys('a'), ['a']);
  assert.equal(ms.del('a'), true);
  assert.equal(ms.del('a'), false);
  ms.set('x1', '1');
  ms.set('x2', '2');
  assert.deepEqual(ms.keys('x*').sort(), ['x1', 'x2']);
  assert.equal(ms.clear(), 2);
  assert.equal(ms.stats().size, 0);
  assert.deepEqual(Object.keys(ms.stats()).sort(), [
    'dels', 'evictions', 'expired', 'gets', 'hits', 'kind', 'maxEntries', 'misses', 'sets', 'size', 'ttlMs'
  ].sort());
});

t('memoryStore：TTL 到点即过期（now 可控）', async function () {
  let now = 1000;
  const ms = memoryStore({ ttlMs: 100, now: function () { return now; } });
  ms.set('k', 'v');
  assert.equal(ms.get('k'), 'v');
  now = 1101;
  assert.equal(ms.get('k'), null);
  assert.equal(ms.stats().expired, 1);
  assert.equal(ms.stats().size, 0);
  assert.equal(ms.keys('k').length, 0);
});

t('memoryStore：容量上限按 LRU 淘汰', async function () {
  const ms = memoryStore({ maxEntries: 2, ttlMs: Infinity });
  ms.set('a', '1');
  ms.set('b', '2');
  ms.get('a');
  ms.set('c', '3');
  assert.deepEqual(ms.keys('*').sort(), ['a', 'c']);
  assert.equal(ms.stats().evictions, 1);
  assert.equal(ms.stats().maxEntries, 2);
});

t('redisLikeAdapter：没给 client 时就是内存实现', async function () {
  const store = redisLikeAdapter(null, { ttlMs: 1000 });
  assert.equal(store.kind, 'redis-like');
  assert.equal(store.stats().backend, 'memory');
  assert.equal(store.stats().lastError, null);
  await store.set('a', 'v');
  assert.equal(await store.get('a'), 'v');
  assert.equal(await store.del('a'), true);
});

t('redisLikeAdapter：拼 keyPrefix、set 带 EX 秒、keys 剥前缀', async function () {
  const data = new Map();
  const calls = { get: [], set: [], del: [], keys: [] };
  const client = {
    async get(k) { calls.get.push(k); return data.has(k) ? data.get(k) : null; },
    async set(k, v, opt) { calls.set.push([k, v, opt]); data.set(k, v); return 'OK'; },
    async del(k) { calls.del.push(k); return data.delete(k) ? 1 : 0; },
    async keys(p) { calls.keys.push(p); return Array.from(data.keys()); }
  };
  const store = redisLikeAdapter(client, { keyPrefix: 'rl:', ttlMs: 60000 });
  assert.equal(await store.set('a', 'v1'), true);
  assert.deepEqual(calls.set[0], ['rl:a', 'v1', { EX: 60 }]);
  assert.equal(await store.get('a'), 'v1');
  assert.equal(calls.get[0], 'rl:a');
  assert.deepEqual(await store.keys('*'), ['rl:a'].map(function (k) { return k.slice(3); }));
  assert.equal(calls.keys[0], 'rl:*');
  assert.equal(await store.del('a'), true);
  assert.equal(calls.del[0], 'rl:a');
  const s = store.stats();
  assert.equal(s.kind, 'redis-like');
  assert.equal(s.backend, 'redis');
  assert.equal(s.keyPrefix, 'rl:');
  assert.equal(s.degradedAt, null);
  const inf = redisLikeAdapter(client, { ttlMs: Infinity });
  await inf.set('z', 'v');
  assert.deepEqual(calls.set[1][2], { EX: 86400 }, 'Infinity 交给介质自己解释，EX 用一天兜底');
});

t('redisLikeAdapter：远端抛错永久退化为内存并打一行 [ban-cache]', async function () {
  let hits = 0;
  const client = {
    async get() { hits++; throw new Error('redis get boom'); },
    async set() { return 'OK'; }
  };
  const store = redisLikeAdapter(client, { keyPrefix: 'rl:' });
  const got = await captureWarn(async function () {
    assert.equal(await store.get('a'), null);
    assert.equal(await store.get('a'), null);
  });
  assert.equal(hits, 1, '退化后不再打扰远端');
  assert.equal(store.stats().backend, 'memory');
  assert.equal(store.stats().degraded, undefined);
  assert.match(String(store.stats().lastError), /redis get boom/);
  assert.equal(typeof store.stats().degradedAt, 'number');
  assert.equal(got.lines.length, 1);
  assert.ok(got.lines[0].startsWith('[ban-cache] '), got.lines[0]);
  assert.ok(got.lines[0].indexOf('redisLikeAdapter(rl:)') >= 0, got.lines[0]);
});

/* ---------- B. src：跨实例的规则编译缓存 ---------- */

t('createRuleCache：无介质时纯本地，stats.storeKind=none', async function () {
  const cache = createRuleCache();
  const box = compiler();
  assert.equal(typeof cache.get, 'function');
  assert.equal(cache.get, cache.getOrCompile, 'get 是 getOrCompile 的别名');
  const v = await cache.getOrCompile('k1', box.fn);
  assert.equal(box.calls, 1);
  const s = cache.stats();
  assert.equal(s.backend, 'memory');
  assert.equal(s.storeKind, 'none');
  assert.equal(s.storeGets, 0);
  assert.equal(s.compiles, 1);
  assert.equal(s.loads, 1);
  assert.equal(s.version, 1);
  assert.equal(s.keyPrefix, 'rules:');
  assert.equal(s.ttlMs, 60000);
  assert.equal(v.key, 'k1');
  assert.equal(await cache.getOrCompile('k1', box.fn), v, '第二次同键不重复编译');
  assert.equal(box.calls, 1);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.peek('k1').cached, true);
  assert.equal(cache.clear(), 1);
  assert.equal(cache.peek('k1').cached, false);
});

t('两实例共享假介质：A 编译一次，B 命中介质不再自己编译', async function () {
  const media = fakeMedia();
  const a = createRuleCache({ store: media, ttlMs: 60000 });
  const b = createRuleCache({ store: media, ttlMs: 60000 });
  const box = compiler();
  const va = await a.getOrCompile('fp1:aaaa:2', box.fn);
  assert.equal(box.calls, 1);
  assert.equal(a.stats().compiles, 1);
  assert.equal(a.stats().loads, 1);
  assert.equal(media.calls.set.length, 1);
  assert.equal(media.calls.set[0][0], 'rules:1:fp1:aaaa:2', '介质键 = keyPrefix + version + : + 指纹');
  assert.equal(media.calls.set[0][2], 60000, '介质条目按 ttlMs 过期');
  const payload = JSON.parse(media.calls.set[0][1]);
  assert.equal(payload.v, 1);
  assert.equal(payload.k, 'fp1:aaaa:2');
  assert.equal(typeof payload.expiresAt, 'number');

  const vb = await b.getOrCompile('fp1:aaaa:2', box.fn);
  assert.equal(box.calls, 1, 'B 没有自己编译');
  assert.deepEqual(vb, va);
  const sb = b.stats();
  assert.equal(sb.compiles, 0);
  assert.equal(sb.loads, 0);
  assert.equal(sb.hits, 1);
  assert.equal(sb.storeGets, 1);
  assert.equal(sb.storeHits, 1);
  assert.equal(sb.revives, 1);
  assert.equal(sb.backend, 'memory+store');
  assert.equal(sb.storeKind, 'fake-media');
});

t('跨实例命中：RegExp 被还原成真正则（$re / $flags）', async function () {
  const media = fakeMedia();
  const a = createRuleCache({ store: media });
  const b = createRuleCache({ store: media });
  const box = compiler();
  await a.getOrCompile('fp1:bbbb:2', box.fn);
  const v = await b.getOrCompile('fp1:bbbb:2', box.fn);
  assert.ok(v.rules[0].re instanceof RegExp, '介质里回来的是 { $re, $flags }，取出应是 RegExp');
  assert.equal(v.rules[0].re.source, 'bad');
  assert.equal(v.rules[0].re.flags, 'i');
  assert.equal(v.rules[0].re.test('xxBADxx'), true);
  assert.equal(v.rules[1].needle, 'spam');
  assert.equal(box.calls, 1);
});

t('真正的跨实例介质：同一个 Redis 同形客户端，B 不再编译', async function () {
  const data = new Map();
  const client = {
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async del(k) { return data.delete(k) ? 1 : 0; }
  };
  const a = createRuleCache({ client: client, clientKeyPrefix: 'gs:', ttlMs: 60000 });
  const b = createRuleCache({ client: client, clientKeyPrefix: 'gs:', ttlMs: 60000 });
  const box = compiler();
  await a.getOrCompile('k1', box.fn);
  assert.equal(a.stats().storeKind, 'redis-like');
  assert.equal(Array.from(data.keys())[0], 'gs:rules:1:k1');
  await b.getOrCompile('k1', box.fn);
  assert.equal(box.calls, 1);
  assert.equal(b.stats().revives, 1);
});

t('规则指纹变了就是新键：重新编译，旧条目不受影响', async function () {
  const media = fakeMedia();
  const a = createRuleCache({ store: media });
  const b = createRuleCache({ store: media });
  const box = compiler();
  const rows1 = [{ kind: 'regex', action: 'reject', pattern: 'bad' }];
  const rows2 = [{ kind: 'regex', action: 'reject', pattern: 'bad' }, { kind: 'word', action: 'review', pattern: 'spam' }];
  const fp1 = rulesFingerprint(rows1);
  const fp2 = rulesFingerprint(rows2);
  assert.notEqual(fp1, fp2);
  await a.getOrCompile(fp1, box.fn);
  await b.getOrCompile(fp2, box.fn);
  assert.equal(box.calls, 2, '规则一改就是另一把键，必须重编译');
  assert.equal(media.data.size, 2, '旧指纹的条目还在（TTL 未到），只是没人再读它');
  await b.getOrCompile(fp1, box.fn);
  assert.equal(box.calls, 2, '回到旧规则时命中旧条目');
  assert.equal(b.stats().revives, 1);
});

t('rulesFingerprint：行序无关、无关列不参与、空规则稳定', async function () {
  const a = [{ kind: 'word', action: 'review', pattern: 'a', id: 9, note: 'x', created_at: 1 }];
  const b = [{ kind: 'word', action: 'review', pattern: 'a', id: 1, note: 'y' }];
  assert.equal(rulesFingerprint(a), rulesFingerprint(b));
  const two = [{ kind: 'word', action: 'review', pattern: 'a' }, { kind: 'word', action: 'review', pattern: 'b' }];
  const rev = [two[1], two[0]];
  assert.equal(rulesFingerprint(two), rulesFingerprint(rev));
  assert.equal(rulesFingerprint([]), 'fp1:811c9dc5:0');
  assert.equal(rulesFingerprint(null), 'fp1:811c9dc5:0');
  assert.notEqual(rulesFingerprint(two), rulesFingerprint([{ kind: 'regex', action: 'review', pattern: 'a' }]));
  assert.notEqual(rulesFingerprint(two), rulesFingerprint([{ kind: 'word', action: 'reject', pattern: 'a' }]));
  assert.equal(rulesFingerprint([{ pattern: '' }]), 'fp1:811c9dc5:0');
});

t('载荷版本 / 指纹对不上当未命中（v=k 双校验）', async function () {
  const media = fakeMedia();
  await media.set('rules:1:k1', JSON.stringify({ v: 9, k: 'k1', value: { tag: 'stale' }, expiresAt: Date.now() + 60000 }), 60000);
  await media.set('rules:1:k2', JSON.stringify({ v: 1, k: 'nope', value: { tag: 'stale' }, expiresAt: Date.now() + 60000 }), 60000);
  await media.set('rules:1:k3', '{not-json', 60000);
  await media.set('rules:1:k4', JSON.stringify({ v: 1, k: 'k4' }), 60000);
  const cache = createRuleCache({ store: media });
  const box = compiler();
  const v1 = await cache.getOrCompile('k1', box.fn);
  const v2 = await cache.getOrCompile('k2', box.fn);
  const v3 = await cache.getOrCompile('k3', box.fn);
  const v4 = await cache.getOrCompile('k4', box.fn);
  assert.equal(box.calls, 4, '四种坏载荷都当未命中');
  assert.equal(v1.tag, undefined);
  assert.equal(v2.tag, undefined);
  assert.equal(v3.key, 'k3');
  assert.equal(v4.key, 'k4');
  assert.equal(cache.stats().storeHits, 0);
});

t('并发读同一把键只编译一次（单飞）', async function () {
  const media = fakeMedia();
  const cache = createRuleCache({ store: media });
  const box = compiler();
  const all = await Promise.all([
    cache.getOrCompile('s', box.fn),
    cache.getOrCompile('s', box.fn),
    cache.getOrCompile('s', box.fn),
    cache.getOrCompile('s', box.fn)
  ]);
  assert.equal(box.calls, 1);
  assert.equal(cache.stats().compiles, 1);
  assert.equal(cache.stats().loads, 1);
  assert.equal(all[0], all[3], '并发读拿的是同一个产物引用');
  assert.equal(media.calls.set.length, 1, '只往介质写一次');
});

t('两个实例同时冷读：各编译一次（刻意不做分布式锁）', async function () {
  const media = fakeMedia();
  const a = createRuleCache({ store: media });
  const b = createRuleCache({ store: media });
  const box = compiler();
  await Promise.all([a.getOrCompile('r', box.fn), b.getOrCompile('r', box.fn)]);
  assert.equal(box.calls, 2, '跨实例的并发冷读没有分布式锁，两边各编译一次（幂等，可接受）');
  assert.equal(a.stats().compiles, 1);
  assert.equal(b.stats().compiles, 1);
});

t('介质读抛错：退化为内存 + 一行日志 + 本地副本兜底', async function () {
  const media = fakeMedia({ failGetAfter: 1 });
  const a = createRuleCache({ store: media, ttlMs: 60000 });
  const b = createRuleCache({ store: media, ttlMs: 60000 });
  const box = compiler();
  await a.getOrCompile('k', box.fn);
  assert.equal(media.calls.get.length, 1);
  const run = await captureWarn(async function () {
    await b.getOrCompile('k', box.fn);
  });
  assert.equal(box.calls, 2, '介质读失败 → 当未命中 → 自己编译');
  const sb = b.stats();
  assert.equal(sb.degraded, true);
  assert.equal(sb.backend, 'memory');
  assert.equal(sb.storeErrors, 1);
  assert.match(String(sb.lastError), /media get boom/);
  assert.equal(run.lines.length, 1, '每个实例只喊一次');
  assert.ok(run.lines[0].startsWith('[ban-cache] '), run.lines[0]);
  assert.ok(run.lines[0].indexOf('createRuleCache(rules:)') >= 0, run.lines[0]);
  assert.ok(run.lines[0].indexOf('退化为内存') >= 0, run.lines[0]);
  await b.getOrCompile('k', box.fn);
  assert.equal(media.calls.get.length, 2, '退化后不再打扰介质（前两次是 a 的 1 次 + b 撞错的那 1 次）');
  assert.equal(b.stats().hits, 1, '本地副本兜底');
  assert.equal(b.stats().misses, 1);
});

t('介质写抛错：只记账不降级 + 一行日志', async function () {
  const media = fakeMedia({ failSet: true });
  const cache = createRuleCache({ store: media });
  const box = compiler();
  const run = await captureWarn(async function () {
    const v = await cache.getOrCompile('k', box.fn);
    assert.equal(v.key, 'k');
    await tick();
  });
  const s = cache.stats();
  assert.equal(s.storeSets, 1);
  assert.equal(s.storeErrors, 1);
  assert.equal(s.degraded, false, '写失败不降级');
  assert.equal(s.backend, 'memory+store');
  assert.match(String(s.lastError), /media set boom/);
  assert.equal(run.lines.length, 1);
  assert.ok(run.lines[0].startsWith('[ban-cache] '), run.lines[0]);
  assert.ok(run.lines[0].indexOf('写共享介质失败') >= 0, run.lines[0]);
  assert.equal(cache.peek('k').cached, true, '本地副本照常可用');
});

t('TTL 到点：本地与介质条目一起失效，然后重新编译', async function () {
  let now = 1000;
  const clock = function () { return now; };
  const media = fakeMedia({ now: clock });
  const a = createRuleCache({ store: media, ttlMs: 1000, now: clock });
  const b = createRuleCache({ store: media, ttlMs: 1000, now: clock });
  const box = compiler();
  await a.getOrCompile('k', box.fn);
  assert.equal(a.peek('k').expiresAt, 2000);
  assert.equal(media.data.get('rules:1:k').expiresAt, 2000);
  await b.getOrCompile('k', box.fn);
  assert.equal(box.calls, 1, 'TTL 内跨实例命中');
  now = 2001;
  assert.equal(a.peek('k').cached, false, '本地副本过期');
  await b.getOrCompile('k', box.fn);
  assert.equal(box.calls, 2, '过期后重新编译');
  assert.equal(media.calls.get.length, 3, 'a 冷编译前 1 次 + b 命中 1 次 + 过期后重读 1 次');
  assert.equal(b.stats().compiles, 1);
  assert.equal(media.data.get('rules:1:k').expiresAt, 3001, '介质上的旧条目已过期被替换');
});

t('invalidate：本地删掉 + 广播介质删（src 版同步发起）', async function () {
  const media = fakeMedia();
  const a = createRuleCache({ store: media });
  const box = compiler();
  await a.getOrCompile('k', box.fn);
  const r = a.invalidate('k');
  assert.deepEqual(r, { local: true, broadcast: true });
  assert.deepEqual(media.calls.del, ['rules:1:k']);
  assert.equal(a.stats().broadcasts, 1);
  await tick();
  assert.equal(a.peek('k').cached, false);
  await tick();
  const again = a.invalidate('nope');
  assert.deepEqual(again, { local: false, broadcast: true }, '本地没有也照样广播：删除是幂等的');
  assert.deepEqual(media.calls.del, ['rules:1:k', 'rules:1:nope']);
});

t('TTL 口径：store.set 收到的 ttlMs / ttlMs=0 不写介质 / Infinity 交给介质', async function () {
  const m1 = fakeMedia();
  const a = createRuleCache({ store: m1 });
  const box = compiler();
  await a.getOrCompile('k', box.fn);
  assert.equal(m1.calls.set[0][2], 60000);

  const m2 = fakeMedia();
  const b = createRuleCache({ store: m2, ttlMs: 0 });
  await b.getOrCompile('k', box.fn);
  assert.equal(m2.calls.set.length, 0, 'ttlMs=0 表示不缓存，不写介质');
  assert.equal(b.stats().storeSets, 0);
  assert.equal(b.peek('k').cached, false);

  const m3 = fakeMedia();
  const c = createRuleCache({ store: m3, ttlMs: Infinity });
  await c.getOrCompile('k', box.fn);
  assert.equal(m3.calls.set[0][2], 0, 'Infinity 交给介质自己解释（与 createBanCache 同一口径）');
  assert.equal(c.peek('k').expiresAt, Infinity);
});

t('本地副本容量上限：maxEntries 个键之外按 LRU 淘汰', async function () {
  const cache = createRuleCache({ maxEntries: 2 });
  const box = compiler();
  await cache.getOrCompile('a', box.fn);
  await cache.getOrCompile('b', box.fn);
  await cache.getOrCompile('a', box.fn);
  await cache.getOrCompile('c', box.fn);
  assert.equal(cache.stats().size, 2);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.peek('b').cached, false);
  assert.equal(cache.peek('a').cached, true);
  assert.equal(cache.peek('c').cached, true);
});

t('编译失败不写缓存，下一次重试', async function () {
  const media = fakeMedia();
  const cache = createRuleCache({ store: media });
  let boom = true;
  const fn = async function () {
    if (boom) throw new Error('compile boom');
    return { ok: true };
  };
  await assert.rejects(cache.getOrCompile('k', fn), /compile boom/);
  assert.equal(cache.peek('k').cached, false);
  assert.equal(cache.stats().compiles, 0);
  assert.equal(media.calls.set.length, 0);
  boom = false;
  const v = await cache.getOrCompile('k', fn);
  assert.deepEqual(v, { ok: true });
  assert.equal(cache.stats().compiles, 1);
  assert.equal(media.calls.set.length, 1);
  const other = await cache.getOrCompile('k', fn);
  assert.equal(other, v);
});

t('peek 三态与 clear', async function () {
  const cache = createRuleCache();
  assert.deepEqual(cache.peek('k'), { cached: false, value: undefined, expiresAt: 0 });
  const box = compiler();
  const v = await cache.getOrCompile('k', box.fn);
  const p = cache.peek('k');
  assert.equal(p.cached, true);
  assert.equal(p.value, v);
  assert.equal(typeof p.expiresAt, 'number');
  assert.equal(cache.peek().cached, false, '没给 key 时按空串查');
  cache.invalidate('k');
  assert.equal(cache.peek('k').cached, false);
});

t('JSON 编不动的产物只留本地副本，不写介质', async function () {
  const media = fakeMedia();
  const cache = createRuleCache({ store: media });
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const fn = async function () { return cyclic; };
  const v = await cache.getOrCompile('k', fn);
  assert.equal(v, cyclic);
  assert.equal(media.calls.set.length, 0);
  assert.equal(cache.stats().storeSets, 0);
  assert.equal(cache.peek('k').cached, true);
  assert.equal(cache.stats().compiles, 1);
});

/* ---------- C. worker：同一套语义（跨实例一律 async，介质默认 Cache API） ---------- */

t('worker：createRuleCache 走 Cache API 介质，键落在命名空间下', async function () {
  const fc = fakeCache();
  const cache = w.createRuleCache({ cache: fc, ttlMs: 60000 });
  const box = compiler();
  await cache.getOrCompile('fp1:cccc:1', box.fn);
  assert.equal(cache.stats().storeKind, 'cache-api');
  assert.equal(fc.calls.put.length, 1);
  const url = fc.calls.put[0][0];
  assert.ok(url.startsWith('https://game-site-ratelimit.invalid/' + w.CACHE_NS + '/'), url);
  assert.ok(url.indexOf('rules%3A1%3Afp1%3Acccc%3A1') >= 0, url);
  assert.equal(fc.calls.put[0][1], 'max-age=60');
  assert.equal(cache.stats().backend, 'memory+store');
});

t('worker：两实例共享同一个假 Cache，编译一次', async function () {
  const fc = fakeCache();
  const a = w.createRuleCache({ cache: fc, ttlMs: 60000 });
  const b = w.createRuleCache({ cache: fc, ttlMs: 60000 });
  const box = compiler();
  const va = await a.getOrCompile('k', box.fn);
  const vb = await b.getOrCompile('k', box.fn);
  assert.equal(box.calls, 1);
  assert.equal(b.stats().compiles, 0);
  assert.equal(b.stats().storeHits, 1);
  assert.equal(b.stats().revives, 1);
  assert.deepEqual(vb, va);
  assert.ok(vb.rules[0].re instanceof RegExp);
  assert.equal(fc.calls.put.length, 1);
});

t('worker：invalidate 是 async，await 过删除才算 broadcast', async function () {
  const fc = fakeCache();
  const a = w.createRuleCache({ cache: fc });
  const box = compiler();
  await a.getOrCompile('k', box.fn);
  const r = await a.invalidate('k');
  assert.deepEqual(r, { local: true, broadcast: true });
  assert.equal(fc.calls.delete.length, 1);
  assert.equal(a.stats().broadcasts, 1);
  await a.getOrCompile('k', box.fn);
  assert.equal(box.calls, 2, '失效后重新编译');

  const bad = fakeCache({ failDelete: true });
  const c = w.createRuleCache({ cache: bad });
  await c.getOrCompile('k', box.fn);
  const r2 = await c.invalidate('k');
  assert.deepEqual(r2, { local: true, broadcast: false }, 'await 抛错就不算广播');
  assert.equal(c.stats().storeErrors, 1);
  assert.equal(c.stats().broadcasts, 0);
});

t('worker：介质 match 抛错退化为内存 + 一行日志', async function () {
  const fc = fakeCache({ failMatch: true });
  const a = w.createRuleCache({ cache: fc, ttlMs: 60000 });
  const box = compiler();
  const run = await captureWarn(async function () {
    await a.getOrCompile('k', box.fn);
  });
  assert.equal(box.calls, 1);
  const s = a.stats();
  assert.equal(s.degraded, true);
  assert.equal(s.backend, 'memory');
  assert.match(String(s.lastError), /cache match boom/);
  assert.equal(run.lines.length, 1);
  assert.ok(run.lines[0].startsWith('[ban-cache] '), run.lines[0]);
  await a.getOrCompile('k', box.fn);
  assert.equal(a.stats().hits, 1, '退化后本地副本兜底');
  assert.equal(fc.calls.match.length, 1);
});

t('worker：createRuleCache stats 字段与 src 版逐项同形', async function () {
  const srcKeys = Object.keys(createRuleCache().stats()).sort();
  const wKeys = Object.keys(w.createRuleCache().stats()).sort();
  assert.deepEqual(wKeys, srcKeys);
  const fc = fakeCache();
  const sandbox = w.createRuleCache({ cache: fc, ttlMs: 1000, version: 3, keyPrefix: 'pp:' });
  const s = sandbox.stats();
  assert.equal(s.version, 3);
  assert.equal(s.keyPrefix, 'pp:');
  assert.equal(s.ttlMs, 1000);
  assert.equal(s.storeKind, 'cache-api');
  assert.equal(typeof w.memoryStore, 'function');
  assert.equal(typeof w.redisLikeAdapter, 'function');
  assert.equal(typeof w.rulesFingerprint, 'function');
  assert.equal(w.rulesFingerprint([{ pattern: 'a' }]), rulesFingerprint([{ pattern: 'a' }]));

  const client = {
    async get() { return null; },
    async set() { return 'OK'; },
    async del() { return 1; }
  };
  const viaRedis = w.createRuleCache({ client: client, clientKeyPrefix: 'gs:' });
  assert.equal(viaRedis.stats().storeKind, 'redis-like');
  const box = compiler();
  await viaRedis.getOrCompile('k', box.fn);
  assert.equal(box.calls, 1);
});

/* ---------- D. 规则版本语义与「没注入介质时逐字不变」的哨兵 ---------- */

t('createBanCache：载荷 v 与 opts.version 对不上当未命中（src + worker）', async function () {
  const media = fakeMedia();
  const a = createBanCache({ store: media, ttlMs: 60000, version: 7 });
  const v = await a.isBanned(11, async function () { return 'v7'; });
  assert.equal(v, 'v7');
  assert.equal(JSON.parse(media.calls.set[0][1]).v, 7, '载荷带上规则版本');
  await media.set('ban:12', JSON.stringify({ v: 6, value: 'stale', expiresAt: Date.now() + 60000 }), 60000);
  const b = createBanCache({ store: media, ttlMs: 60000 });
  let loads = 0;
  const val = await b.isBanned(12, async function () { loads++; return 'fresh'; });
  assert.equal(loads, 1, '版本对不上 → 重查');
  assert.equal(val, 'fresh');
  assert.equal(b.stats().loads, 1);
  assert.equal(b.stats().storeHits, 0);
  const c = createBanCache({ store: media, ttlMs: 60000, version: 7 });
  const hit = await c.isBanned(11, async function () { throw new Error('不该再查'); });
  assert.equal(hit, 'v7', '版本一致就命中');
  assert.equal(c.stats().storeHits, 1);
  assert.equal(c.stats().loads, 0);

  const wmedia = fakeMedia();
  const wa = w.createBanCache({ store: wmedia, ttlMs: 60000, version: 4 });
  await wa.isBanned(21, async function () { return 'w4'; });
  assert.equal(JSON.parse(wmedia.calls.set[0][1]).v, 4);
  await wmedia.set('ban:22', JSON.stringify({ v: 3, value: 'stale', expiresAt: Date.now() + 60000 }), 60000);
  const wb = w.createBanCache({ store: wmedia, ttlMs: 60000 });
  let wloads = 0;
  await wb.isBanned(22, async function () { wloads++; return 'w-fresh'; });
  assert.equal(wloads, 1);
  const wc = w.createBanCache({ store: wmedia, ttlMs: 60000, version: 4 });
  assert.equal(await wc.isBanned(21, async function () { throw new Error('不该再查'); }), 'w4');
});

t('createBanCache：没注入介质时行为与 stats 字段逐字不变', async function () {
  const cache = createBanCache({ ttlMs: 60000 });
  assert.deepEqual(Object.keys(cache.stats()).sort(), BAN_STATS);
  assert.equal(cache.stats().backend, 'memory');
  let loads = 0;
  assert.equal(await cache.isBanned(5, async function () { loads++; return true; }), true);
  assert.equal(loads, 1);
  assert.equal(await cache.isBanned(5, async function () { throw new Error('不该再查'); }), true);
  assert.equal(cache.stats().loads, 1);
  assert.equal(cache.stats().hits, 1);
  assert.deepEqual(cache.peek(5).cached, true);
  assert.deepEqual(cache.peek(6), { cached: false, value: undefined, expiresAt: 0 });
  assert.deepEqual(cache.invalidate(5), { local: true, broadcast: false });
  assert.deepEqual(cache.invalidate(6), { local: false, broadcast: false });
  assert.equal(cache.stats().storeGets, 0);
  assert.equal(cache.stats().degraded, false);
});

t('createLimiter：没注入介质时的 stats 字段逐字不变（回归哨兵）', async function () {
  const lim = createLimiter();
  assert.deepEqual(Object.keys(lim.stats()).sort(), [
    'backend', 'degraded', 'evictions', 'hits', 'keyPrefix', 'lastError', 'limited', 'max', 'size',
    'storeErrors', 'storeGets', 'storeSets', 'sweeps', 'sweptKeys', 'windowMs'
  ].sort());
  assert.equal(lim.stats().backend, 'memory');
  const r = await lim.hit('u1');
  assert.equal(r.ok, true);
  assert.equal(r.limited, false);
  assert.equal(lim.stats().storeGets, 0);
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
