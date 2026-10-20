/**
 * 可复用的限流与封禁缓存（Express / node:sqlite 版）。
 *
 * 两个通用件，两条线同名同语义（worker/ratelimit.js 是异步 + Cache API 的镜像）：
 *   - createLimiter(opts)：滑动窗口限流器。默认进程内 Map，带惰性清理与容量上限，
 *     key 再多也不会无限长；要跨实例就注入 store（口子与 src/rank-cache.js 一致：
 *     { get(key), set(key, value, ttlMs), del(key) }，能直接套 Redis / Cache API 适配器）。
 *   - createBanCache(opts)：封禁 / 黑名单查询的带 TTL 缓存。isBanned 未命中才调 loader；
 *     invalidate 既清本实例，也通过 store.del 广播给别的实例（它们下次读时发现没了
 *     就重新 load）。
 *
 * 这一份只用语言内置能力（不 import 任何东西、不碰 Buffer / process），因为
 * worker/data-forum.js 会 import src/forum-guard.js，而 forum-guard 用的是这里的件。
 *
 * 限流是「尽力而为」的判定：宁可偶尔多放一条，也不要把站点卡在计数上。所以存储出
 * 的错一律不抛给调用方，读出错就永久退化成纯内存（口径与 src/rank-cache.js 的
 * redisLikeAdapter 一致），stats().backend 会如实变成 'memory'。
 */

/** 进程内默认容量上限：key 多到这个数就按最久未使用淘汰（LRU），避免内存泄漏 */
const DEFAULT_MAX_KEYS = 5000;
/** 单个 key 在内存里留的时间戳条数上限（保险丝；正常不会超过 max） */
const DEFAULT_MAX_HITS = 256;
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MAX = 10;
/** 封禁缓存默认有效期：60 秒。封禁是低频写、超高频读，60 秒足够挡住热路径 */
const DEFAULT_BAN_TTL_MS = 60000;
/** 封禁缓存的本地副本上限（有 store 时它只是兜底） */
const DEFAULT_BAN_MAX_ENTRIES = 1000;

/* ---------- 小工具 ---------- */

function toInt(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i < min ? min : i;
}

/** 毫秒数：非法值走默认，负数归零（windowMs=0 表示不限） */
function toMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : Math.floor(n);
}

/** 取某个时刻：显式传了 now 就用它（测试与补算用），否则读时钟 */
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

/** store 的口子：只要有 get 就当存储用（set / del 各自可选） */
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

/* ---------- 限流器 ---------- */

/**
 * createLimiter({ windowMs=60000, max=10, keyPrefix='', store=null, now, maxKeys=5000, maxHits=256 })
 *
 * 滑动窗口计数：窗口内已放行 count 次，count >= max 就限流；被限流的那次不记账，
 * resetAt 是窗口内最早一次放行滑出去的时刻（也就是下次能过的时刻）。
 * 每个 key 只在内存里留窗口内的时间戳，超窗的惰性清掉、清空了就把 key 删掉。
 *
 * store 是可选的跨实例共享介质（值一律是 JSON 字符串，Redis / Cache API 都只认字符串）：
 *   - 某个 key 在本实例第一次出现时去 store 读一眼别人的窗口并合并（同步 store 当场
 *     合并；异步 store 的合并结果给下一次调用用）；
 *   - 每次放行把窗口写回 store（尽力而为，ttlMs = windowMs）；
 *   - 读出错就永久退化成纯内存（stats().backend 变 'memory'），写出错只记账不降级
 *     （本实例的判定还是准的，下次写也许就好了）。
 *
 * 返回 { hit, peek, reset, sweep, stats }：
 *   - hit(key, now)：判定并记账。放行 → { ok:true, remaining, resetAt, limited:false, count }；
 *     超限 → { ok:false, remaining:0, resetAt, limited:true, count }。
 *     count 是「判定时窗口内已有的次数」，不含本次；remaining 是这次之后还能再发几次。
 *   - peek(key, now)：只看不记账，返回 { count, remaining, resetAt, limited }。
 *   - reset(key)：清掉本实例这个 key 的窗口，返回是否真的有。
 *   - sweep(now)：清掉所有已过期的 key，返回清掉的 key 数。
 *   - stats()：{ windowMs, max, keyPrefix, size, backend, hits, limited, evictions,
 *     sweeps, sweptKeys, storeGets, storeSets, storeErrors, degraded, lastError }。
 */
export function createLimiter(opts = {}) {
  const o = opts || {};
  const windowMs = toMs(o.windowMs, DEFAULT_WINDOW_MS);
  const max = Math.max(1, toInt(o.max, DEFAULT_MAX, 1));
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? '' : String(o.keyPrefix);
  const store = isStore(o.store) ? o.store : null;
  const clock = typeof o.now === 'function' ? o.now : null;
  const maxKeys = Math.max(1, toInt(o.maxKeys, DEFAULT_MAX_KEYS, 1));
  const maxHits = Math.max(1, toInt(o.maxHits, DEFAULT_MAX_HITS, 1));

  /** key -> 窗口内命中时间戳（升序）；Map 的迭代顺序同时当 LRU 用 */
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

  /** 丢窗口外的旧记录（升序数组，从头切） */
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

  /** 取某个 key 的窗口；fresh 表示这次刚建（只有这时才去 store 预取） */
  function windowFor(key, now) {
    let list = mem.get(key);
    let fresh = false;
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
      fresh = true;
    }
    // 触碰一次，挪到 LRU 尾部
    mem.delete(key);
    mem.set(key, list);
    return { list: list, fresh: fresh };
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

  /** 把 store 里的窗口并进来（同一个毫秒的重复时间戳按一条算，跨实例误差容忍） */
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

  function prefetch(key, list, now) {
    st.storeGets++;
    let raw;
    try {
      raw = store.get(key);
    } catch (err) {
      degrade(err);
      return;
    }
    if (isThenable(raw)) {
      raw.then(function (value) {
        mergeRemote(key, list, now, value);
      }, function (err) {
        degrade(err);
      });
      return;
    }
    mergeRemote(key, list, now, raw);
  }

  function pushRemote(key, list, now) {
    const payload = encode({ v: 1, hits: list.slice(-maxHits), at: now });
    if (payload === null) return;
    st.storeSets++;
    try {
      const pending = store.set(key, payload, windowMs);
      if (isThenable(pending)) {
        pending.then(undefined, function (err) {
          st.storeErrors++;
          st.lastError = errText(err);
        });
      }
    } catch (err) {
      st.storeErrors++;
      st.lastError = errText(err);
    }
  }

  function hit(key, now) {
    const t = timeOf(now, clock);
    const k = fullKey(key);
    const w = windowFor(k, t);
    if (w.fresh && usingStore()) prefetch(k, w.list, t);
    const d = decide(w.list, t, true);
    st.hits++;
    if (d.limited) {
      st.limited++;
      return { ok: false, remaining: 0, resetAt: d.resetAt, limited: true, count: d.count };
    }
    w.list.push(t);
    if (usingStore()) pushRemote(k, w.list, t);
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
 * createBanCache({ ttlMs=60000, keyPrefix='ban:', store=null, now, maxEntries=1000 })
 *
 * 封禁 / 黑名单查询的带 TTL 缓存：isBanned(userId, loaderFn) 命中缓存就直接返回，
 * 未命中才 await loaderFn(userId) 并把结果缓存起来。loaderFn 由调用方接线
 * （src/data.js 的 listUsers / src/data-forum.js 的 forumGate 之类），这里不认识 DB。
 *
 * store 在的时候它才是权威：每次都先读 store（命中就用，并顺手补一份本地副本），
 * 只有 store 说没有、或 store 已经降级，才落到本地副本、再落到 loader。
 * 本实例的本地副本只在 store 不可用时兜底，所以「另一个实例失效了、我还拿着旧值」
 * 不会发生。
 *
 * invalidate(userId)：清本实例 + 通过 store.del 广播失效，返回
 *   { local: 本实例是否真有这条, broadcast: 是否发起了广播 }。
 *   异步 store 的广播只保证「已发起」，失败记进 stats().storeErrors 不抛。
 * peek(userId)：同步看一眼本地副本 → { cached, value, expiresAt }（有 store 时只当提示）。
 * stats()：{ ttlMs, keyPrefix, size, backend, hits, misses, loads, evictions,
 *   invalidations, broadcasts, storeGets, storeHits, storeSets, storeDels, storeErrors,
 *   degraded, lastError }。
 */
export function createBanCache(opts = {}) {
  const o = opts || {};
  const ttlMs = o.ttlMs === Infinity ? Infinity : toMs(o.ttlMs, DEFAULT_BAN_TTL_MS);
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? 'ban:' : String(o.keyPrefix);
  const store = isStore(o.store) ? o.store : null;
  const clock = typeof o.now === 'function' ? o.now : null;
  const maxEntries = Math.max(1, toInt(o.maxEntries, DEFAULT_BAN_MAX_ENTRIES, 1));

  /** key -> { value, expiresAt }；Map 迭代顺序当 LRU */
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

  /** 过期时刻取「远端标的」和「本地算的」里更早的那个，绝不比任一边更旧 */
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

  /** 读 store：返回 { hit, value, expiresAt } 或 Promise；出错降级当未命中 */
  function remoteGet(key, t) {
    st.storeGets++;
    let raw;
    try {
      raw = store.get(key);
    } catch (err) {
      degrade(err);
      return { hit: false, value: undefined };
    }
    if (isThenable(raw)) {
      return raw.then(function (value) {
        return parseEntry(value, t);
      }, function (err) {
        degrade(err);
        return { hit: false, value: undefined };
      });
    }
    return parseEntry(raw, t);
  }

  function remoteSet(key, value, t) {
    // ttlMs=0 表示不缓存；Infinity 交给 store 自己解释（适配器按具体秒数处理）
    const ttlForStore = Number.isFinite(ttlMs) ? ttlMs : 0;
    if (ttlForStore <= 0 && ttlMs !== Infinity) return;
    const payload = encode({ v: 1, value: value, expiresAt: expiry(t) });
    if (payload === null) return;
    st.storeSets++;
    try {
      const pending = store.set(key, payload, ttlForStore);
      if (isThenable(pending)) {
        pending.then(undefined, function (err) {
          st.storeErrors++;
          st.lastError = errText(err);
        });
      }
    } catch (err) {
      degrade(err);
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

  function invalidate(userId) {
    const key = fullKey(userId);
    const local = mem.delete(key);
    st.invalidations++;
    let broadcast = false;
    if (store && !st.degraded && typeof store.del === 'function') {
      st.storeDels++;
      try {
        const pending = store.del(key);
        broadcast = true;
        if (isThenable(pending)) {
          pending.then(undefined, function (err) {
            st.storeErrors++;
            st.lastError = errText(err);
          });
        }
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
