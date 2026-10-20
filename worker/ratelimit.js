/**
 * 可复用的限流与封禁缓存（Cloudflare Workers + D1 版）。
 *
 * 与 src/ratelimit.js 同名同语义，差别只有两处：
 *   1) 跨实例的读写本来就是异步的，所以 hit / isBanned / invalidate 一律 async；
 *      peek / sweep / stats 只看本 isolate 的内存，仍是同步的。
 *   2) 跨实例共享介质默认是 Cache API（caches.default），不是 Redis。
 *
 * 为什么是 Cache API + isolate 内存，而不是 D1 计数表：
 *   - 零 schema、零绑定：caches 是 Workers 运行时全局，wrangler 不用加任何绑定，
 *     也不用为它写迁移；D1 计数表则要多一张表 + 一条 migrations/000N_*.sql。
 *   - 自带 TTL 与删除：响应上的 Cache-Control: max-age=秒 就是窗口过期，
 *     cache.delete 就是失效广播，不需要自己写清理任务。
 *   - 限流本来就是「尽力而为」的判定（worker/app.js 里原来的 isolate 内存版注释
 *     也是这么写的）：丢一点跨实例计数无伤大雅，不值得每次判定都打一次 D1。
 *   代价：同一个 key 的每次判定都要过一次 cache.match（外加一次尽力而为的 cache.put）。
 *
 * caches 拿不到时（node 里跑测试、workers.dev 关了 Cache API、老运行时）自动退化成
 * 纯 isolate 内存：行为与本文件不带 store 时一致，stats().backend 如实是 'memory'。
 *
 * 本文件不需要 db 参数：选了 Cache API 就没有 D1 的份。哪天真要换成 D1 计数表，
 * 按仓库约定应该写成 createLimiter(db, opts)（第一个参数是 db 绑定、全程 await）。
 */

/** isolate 内默认容量上限：key 多到这个数就按最久未使用淘汰（LRU），避免内存泄漏 */
const DEFAULT_MAX_KEYS = 2000;
/** 单个 key 在内存里留的时间戳条数上限（保险丝；正常不会超过 max） */
const DEFAULT_MAX_HITS = 256;
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MAX = 10;
const DEFAULT_BAN_TTL_MS = 60000;
const DEFAULT_BAN_MAX_ENTRIES = 1000;
/** 合成 URL 的根：.invalid 是 RFC 2606 保留的不可解析顶级域，永远不会打到真实站点 */
const DEFAULT_CACHE_ORIGIN = 'https://game-site-ratelimit.invalid';
/** 模块级命名空间：同一个 zone 里其他 Cache API 用户不会撞键 */
export const CACHE_NS = 'game-site/ratelimit/v1';

/* ---------- 小工具 ---------- */

function toInt(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i < min ? min : i;
}

function toMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : Math.floor(n);
}

function timeOf(now, clock) {
  if (Number.isFinite(now)) return Number(now);
  if (typeof clock === 'function') {
    const t = Number(clock());
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function isThenable(value) {
  return !!value && typeof value.then === 'function';
}

function isStore(store) {
  return !!store && typeof store.get === 'function';
}

function errText(err) {
  return err && err.message ? String(err.message) : String(err);
}

function encode(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

const UNDECODABLE = Symbol('undecodable');

function decode(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return UNDECODABLE;
  }
}

/* ---------- Cache API 适配 ---------- */

/**
 * 取运行时全局的 caches.default；拿不到就 null（node、workers.dev 关掉 Cache API、
 * 老运行时都会走到这里，调用方据此退化成 isolate 内存）。opts.cache 可显式注入。
 */
export function resolveCache(opts = {}) {
  const o = opts || {};
  if (o.cache) return o.cache;
  if (typeof caches === 'undefined' || !caches) return null;
  const def = caches.default;
  return def && typeof def.match === 'function' && typeof def.put === 'function' ? def : null;
}

/**
 * 把 Cache API 包成 store 的口子（与 src/ratelimit.js 的 store 同形）：
 *   get(key) -> Promise<字符串|null>；set(key, value, ttlMs)；del(key) -> Promise<bool>
 * 键是一个合成 URL：<baseUrl>/<namespace>/<encodeURIComponent(key)>。
 * ttlMs 换成 Cache-Control 的 max-age（秒，向上取整，最小 1 秒；Cache API 只能给具体秒数，
 * 所以 Infinity / 非法值一律按 1 秒）。
 */
export function cacheStore(cache, opts = {}) {
  if (!cache || typeof cache.match !== 'function' || typeof cache.put !== 'function') return null;
  const o = opts || {};
  const base = String(o.baseUrl || DEFAULT_CACHE_ORIGIN).replace(/\/+$/, '');
  const ns = String(o.namespace || CACHE_NS).replace(/^\/+|\/+$/g, '');
  function urlOf(key) {
    return base + '/' + ns + '/' + encodeURIComponent(String(key));
  }
  function secsOf(ttlMs) {
    const n = Number(ttlMs);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.ceil(n / 1000));
  }
  return {
    kind: 'cache-api',
    urlOf: urlOf,
    async get(key) {
      const hit = await cache.match(urlOf(key));
      return hit ? await hit.text() : null;
    },
    async set(key, value, ttlMs) {
      const res = new Response(String(value), { headers: { 'Cache-Control': 'max-age=' + secsOf(ttlMs) } });
      await cache.put(urlOf(key), res);
      return true;
    },
    async del(key) {
      if (typeof cache.delete !== 'function') return false;
      return await cache.delete(urlOf(key));
    }
  };
}

/* ---------- 限流器 ---------- */

/**
 * createLimiter({ windowMs=60000, max=10, keyPrefix='', store=null, cache=null, now,
 *                waitUntil=null, baseUrl, namespace, maxKeys=2000, maxHits=256 })
 *
 * 语义与 src/ratelimit.js 的 createLimiter 一致，区别是：
 *   - hit(key, now) 是 async：store 健康时每次判定都先读一次共享窗口并合并，
 *     再把本次记账写回（尽力而为，不 await；有 ctx.waitUntil 就交给它，
 *     免得响应一返回写就被取消）；
 *   - 读 store 出错就永久退化成 isolate 内存（stats().backend 变 'memory'），
 *     写出错只记账不降级；
 *   - state 是每个 isolate 各一份（这正是要跨实例的原因），merge 用时间戳去重，
 *     同毫秒的并发写会互相覆盖，属可接受的误差。
 *
 * store 不传时用 cache（或运行时 caches.default）现包一个；都拿不到就是纯内存。
 */
export function createLimiter(opts = {}) {
  const o = opts || {};
  const windowMs = toMs(o.windowMs, DEFAULT_WINDOW_MS);
  const max = Math.max(1, toInt(o.max, DEFAULT_MAX, 1));
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? '' : String(o.keyPrefix);
  const clock = typeof o.now === 'function' ? o.now : null;
  const maxKeys = Math.max(1, toInt(o.maxKeys, DEFAULT_MAX_KEYS, 1));
  const maxHits = Math.max(1, toInt(o.maxHits, DEFAULT_MAX_HITS, 1));
  const store = isStore(o.store) ? o.store : cacheStore(resolveCache(o), o);
  const waitUntil = typeof o.waitUntil === 'function' ? o.waitUntil : null;

  const mem = new Map();
  const st = {
    hits: 0, limited: 0, evictions: 0, sweeps: 0, sweptKeys: 0,
    storeGets: 0, storeSets: 0, storeErrors: 0,
    degraded: false, lastError: null
  };

  function usingStore() {
    return !!store && !st.degraded;
  }

  function degrade(err) {
    st.degraded = true;
    st.storeErrors++;
    st.lastError = errText(err);
  }

  function fullKey(key) {
    return keyPrefix + String(key);
  }

  function prune(list, now) {
    if (!list.length) return list;
    const floor = now - windowMs;
    let cut = 0;
    while (cut < list.length && list[cut] <= floor) cut++;
    if (cut) list.splice(0, cut);
    return list;
  }

  function evictOldest() {
    const first = mem.keys().next();
    if (first.done) return;
    mem.delete(first.value);
    st.evictions++;
  }

  function windowFor(key, now) {
    let list = mem.get(key);
    if (list) {
      prune(list, now);
      if (!list.length) {
        mem.delete(key);
        list = null;
      }
    }
    if (!list) {
      while (mem.size >= maxKeys) evictOldest();
      list = [];
    }
    mem.delete(key);
    mem.set(key, list);
    return list;
  }

  /**
   * 判定：count 是窗口内已有的次数（不含本次）。consumed 表示本次要占一个名额，
   * 此时 remaining 是「这次之后还能再发几次」——首次放行就是 max-1，与 rate-limit
   * 响应头的口径一致；peek 不占名额，remaining 是「现在还能发几次」。
   */
  function decide(list, now, consumed) {
    const count = list.length;
    const limited = count >= max;
    return {
      count: count,
      limited: limited,
      remaining: limited ? 0 : max - count - (consumed ? 1 : 0),
      resetAt: count ? list[0] + windowMs : now + windowMs
    };
  }

  function mergeRemote(key, list, now, raw) {
    if (mem.get(key) !== list) return false;
    const payload = typeof raw === 'string' ? decode(raw) : raw;
    if (!payload || payload === UNDECODABLE || !Array.isArray(payload.hits)) return false;
    const floor = now - windowMs;
    const seen = new Set(list);
    let added = 0;
    for (const item of payload.hits) {
      const ts = Number(item);
      if (!Number.isFinite(ts) || ts <= floor) continue;
      if (seen.has(ts)) continue;
      seen.add(ts);
      list.push(ts);
      added++;
    }
    if (!added) return false;
    list.sort(function (a, b) { return a - b; });
    if (list.length > maxHits) list.splice(0, list.length - maxHits);
    return true;
  }

  async function pullRemote(key, list, now) {
    st.storeGets++;
    let raw;
    try {
      raw = await store.get(key);
    } catch (err) {
      degrade(err);
      return false;
    }
    return mergeRemote(key, list, now, raw);
  }

  function pushRemote(key, list, now) {
    const payload = encode({ v: 1, hits: list.slice(-maxHits), at: now });
    if (payload === null) return;
    st.storeSets++;
    let pending;
    try {
      pending = store.set(key, payload, windowMs);
    } catch (err) {
      st.storeErrors++;
      st.lastError = errText(err);
      return;
    }
    if (!isThenable(pending)) return;
    const guarded = pending.then(function () {
      return true;
    }, function (err) {
      st.storeErrors++;
      st.lastError = errText(err);
      return false;
    });
    if (waitUntil) {
      try {
        waitUntil(guarded);
      } catch {
        // ctx.waitUntil 只在该次请求的窗口内有效，过期了就算了：写丢了不影响判定
      }
    }
  }

  async function hit(key, now) {
    const t = timeOf(now, clock);
    const k = fullKey(key);
    const list = windowFor(k, t);
    if (usingStore()) await pullRemote(k, list, t);
    const d = decide(list, t, true);
    st.hits++;
    if (d.limited) {
      st.limited++;
      return { ok: false, remaining: 0, resetAt: d.resetAt, limited: true, count: d.count };
    }
    list.push(t);
    if (usingStore()) pushRemote(k, list, t);
    return { ok: true, remaining: d.remaining, resetAt: d.resetAt, limited: false, count: d.count };
  }

  function peek(key, now) {
    const t = timeOf(now, clock);
    const k = fullKey(key);
    const list = mem.get(k);
    if (!list) return { count: 0, remaining: max, resetAt: t + windowMs, limited: false };
    prune(list, t);
    if (!list.length) {
      mem.delete(k);
      return { count: 0, remaining: max, resetAt: t + windowMs, limited: false };
    }
    return decide(list, t, false);
  }

  function reset(key) {
    return mem.delete(fullKey(key));
  }

  function sweep(now) {
    const t = timeOf(now, clock);
    let removed = 0;
    for (const entry of mem) {
      prune(entry[1], t);
      if (!entry[1].length) {
        mem.delete(entry[0]);
        removed++;
      }
    }
    st.sweeps++;
    st.sweptKeys += removed;
    return removed;
  }

  function stats() {
    return {
      windowMs: windowMs,
      max: max,
      keyPrefix: keyPrefix,
      size: mem.size,
      backend: usingStore() ? 'memory+store' : 'memory',
      storeKind: store ? store.kind || 'custom' : 'none',
      hits: st.hits,
      limited: st.limited,
      evictions: st.evictions,
      sweeps: st.sweeps,
      sweptKeys: st.sweptKeys,
      storeGets: st.storeGets,
      storeSets: st.storeSets,
      storeErrors: st.storeErrors,
      degraded: st.degraded,
      lastError: st.lastError
    };
  }

  return { hit: hit, peek: peek, reset: reset, sweep: sweep, stats: stats };
}

/* ---------- 封禁 / 黑名单缓存 ---------- */

/**
 * createBanCache({ ttlMs=60000, keyPrefix='ban:', store=null, cache=null, now, maxEntries=1000 })
 *
 * 语义与 src/ratelimit.js 的 createBanCache 一致：store 健康时它是权威，每次都先读
 * store（命中就用并补一份本地副本）；store 不可用才落到本地副本、再落到 loader。
 * 跨实例共享默认走 Cache API，所以 isolate 之间不会各缓存各的 60 秒。
 *
 *   isBanned(userId, loaderFn) -> Promise<任意值>
 *   invalidate(userId) -> Promise<{ local, broadcast }>（await 过 store.del 才算完）
 *   peek(userId) -> { cached, value, expiresAt }（同步，只看本地副本）
 *   stats() -> 与 src 版同名字段
 */
export function createBanCache(opts = {}) {
  const o = opts || {};
  const ttlMs = o.ttlMs === Infinity ? Infinity : toMs(o.ttlMs, DEFAULT_BAN_TTL_MS);
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? 'ban:' : String(o.keyPrefix);
  const store = isStore(o.store) ? o.store : cacheStore(resolveCache(o), o);
  const clock = typeof o.now === 'function' ? o.now : null;
  const maxEntries = Math.max(1, toInt(o.maxEntries, DEFAULT_BAN_MAX_ENTRIES, 1));

  const mem = new Map();
  const st = {
    hits: 0, misses: 0, loads: 0, evictions: 0, invalidations: 0, broadcasts: 0,
    storeGets: 0, storeHits: 0, storeSets: 0, storeDels: 0, storeErrors: 0,
    degraded: false, lastError: null
  };

  function usingStore() {
    return !!store && !st.degraded;
  }

  function degrade(err) {
    st.degraded = true;
    st.storeErrors++;
    st.lastError = errText(err);
  }

  function fullKey(userId) {
    return keyPrefix + String(userId);
  }

  function expiry(t) {
    return ttlMs === Infinity ? Infinity : t + ttlMs;
  }

  function expiresFrom(remote, t) {
    const local = expiry(t);
    const n = Number(remote);
    if (!Number.isFinite(n) || n <= 0) return local;
    return n < local ? n : local;
  }

  function localGet(key, t) {
    const entry = mem.get(key);
    if (!entry) return { hit: false, value: undefined };
    if (entry.expiresAt <= t) {
      mem.delete(key);
      return { hit: false, value: undefined };
    }
    mem.delete(key);
    mem.set(key, entry);
    return { hit: true, value: entry.value };
  }

  function localSet(key, value, expiresAt) {
    mem.delete(key);
    while (mem.size >= maxEntries) {
      const first = mem.keys().next();
      if (first.done) break;
      mem.delete(first.value);
      st.evictions++;
    }
    mem.set(key, { value: value, expiresAt: expiresAt });
  }

  function parseEntry(raw, t) {
    if (raw === null || raw === undefined) return { hit: false, value: undefined };
    const entry = typeof raw === 'string' ? decode(raw) : raw;
    if (!entry || entry === UNDECODABLE || typeof entry !== 'object' || !('value' in entry)) {
      return { hit: false, value: undefined };
    }
    return { hit: true, value: entry.value, expiresAt: expiresFrom(entry.expiresAt, t) };
  }

  async function remoteGet(key, t) {
    st.storeGets++;
    let raw;
    try {
      raw = await store.get(key);
    } catch (err) {
      degrade(err);
      return { hit: false, value: undefined };
    }
    return parseEntry(raw, t);
  }

  function remoteSet(key, value, t) {
    const ttlForStore = Number.isFinite(ttlMs) ? ttlMs : 0;
    if (ttlForStore <= 0 && ttlMs !== Infinity) return;
    const payload = encode({ v: 1, value: value, expiresAt: expiry(t) });
    if (payload === null) return;
    st.storeSets++;
    let pending;
    try {
      pending = store.set(key, payload, ttlForStore);
    } catch (err) {
      degrade(err);
      return;
    }
    if (isThenable(pending)) {
      pending.then(undefined, function (err) {
        st.storeErrors++;
        st.lastError = errText(err);
      });
    }
  }

  async function isBanned(userId, loaderFn) {
    const key = fullKey(userId);
    const t = timeOf(undefined, clock);

    if (usingStore()) {
      const got = await remoteGet(key, t);
      if (got.hit) {
        st.hits++;
        st.storeHits++;
        localSet(key, got.value, got.expiresAt === undefined ? expiry(t) : got.expiresAt);
        return got.value;
      }
    }
    if (!usingStore()) {
      const local = localGet(key, t);
      if (local.hit) {
        st.hits++;
        return local.value;
      }
    }

    st.misses++;
    st.loads++;
    const value = typeof loaderFn === 'function' ? await loaderFn(userId) : undefined;
    localSet(key, value, expiry(t));
    if (usingStore()) remoteSet(key, value, t);
    return value;
  }

  function peek(userId) {
    const key = fullKey(userId);
    const t = timeOf(undefined, clock);
    const entry = mem.get(key);
    if (!entry || entry.expiresAt <= t) {
      if (entry) mem.delete(key);
      return { cached: false, value: undefined, expiresAt: 0 };
    }
    return { cached: true, value: entry.value, expiresAt: entry.expiresAt };
  }

  /** 失效广播要等 store.del 落实，所以这里是 async（src 版同步发起了就算数） */
  async function invalidate(userId) {
    const key = fullKey(userId);
    const local = mem.delete(key);
    st.invalidations++;
    let broadcast = false;
    if (store && !st.degraded && typeof store.del === 'function') {
      st.storeDels++;
      try {
        await store.del(key);
        broadcast = true;
      } catch (err) {
        st.storeErrors++;
        st.lastError = errText(err);
      }
    }
    if (broadcast) st.broadcasts++;
    return { local: local, broadcast: broadcast };
  }

  function stats() {
    return {
      ttlMs: ttlMs,
      keyPrefix: keyPrefix,
      size: mem.size,
      backend: usingStore() ? 'memory+store' : 'memory',
      storeKind: store ? store.kind || 'custom' : 'none',
      hits: st.hits,
      misses: st.misses,
      loads: st.loads,
      evictions: st.evictions,
      invalidations: st.invalidations,
      broadcasts: st.broadcasts,
      storeGets: st.storeGets,
      storeHits: st.storeHits,
      storeSets: st.storeSets,
      storeDels: st.storeDels,
      storeErrors: st.storeErrors,
      degraded: st.degraded,
      lastError: st.lastError
    };
  }

  return { isBanned: isBanned, peek: peek, invalidate: invalidate, stats: stats };
}
