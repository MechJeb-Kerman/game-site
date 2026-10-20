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
/** 共享介质（memoryStore / redisLikeAdapter）的默认条目上限与默认 TTL */
const DEFAULT_STORE_MAX_ENTRIES = 500;
const DEFAULT_STORE_TTL_MS = 60000;
/** 黑名单规则编译产物的默认 TTL（兜底）与本地副本上限 */
const DEFAULT_RULE_TTL_MS = 60000;
const DEFAULT_RULE_MAX_ENTRIES = 200;
const DEFAULT_RULE_KEY_PREFIX = 'rules:';
/** 介质退化日志前缀：Express 与 Workers 两条线统一，线上直接 grep 这一串 */
const DEGRADE_LOG_PREFIX = '[ban-cache]';

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

/**
 * 共享介质出问题只在每个实例打一行日志：出错多半发生在热路径上，刷屏比不报更糟。
 * 前缀固定 [ban-cache]，Express 与 Workers 两条线一致，线上直接 grep 这一串。
 */
function logBan(scope, detail, err) {
  try {
    if (typeof console === 'undefined' || !console || typeof console.warn !== 'function') return;
    console.warn(DEGRADE_LOG_PREFIX + ' ' + scope + ' ' + detail + '：' + errText(err));
  } catch {
    // 日志本身绝不能把调用方带挂
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

  /** 退化与写失败各只喊一次（热路径上刷屏比不报更糟） */
  let warned = false;
  let writeWarned = false;

  function degrade(err) {
    st.degraded = true;
    st.storeErrors++;
    st.lastError = errText(err);
    if (!warned) {
      warned = true;
      logBan('createLimiter(' + keyPrefix + ')', '共享介质读失败，已退化为内存', err);
    }
  }

  function warnWrite(err) {
    if (writeWarned) return;
    writeWarned = true;
    logBan('createLimiter(' + keyPrefix + ')', '写共享介质失败（只记账，不降级）', err);
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
          warnWrite(err);
        });
      }
    } catch (err) {
      st.storeErrors++;
      st.lastError = errText(err);
      warnWrite(err);
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
  /**
   * 规则版本（默认 1）：写进载荷的 v 字段，读回来对不上就整条当未命中。
   * 黑名单规则改了、别的实例还没来得及 invalidate 时靠它自动失效；默认值下行为与历史一致。
   */
  const version = o.version === undefined || o.version === null ? 1 : o.version;

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

  /** 退化与写失败各只喊一次（热路径上刷屏比不报更糟） */
  let warned = false;
  let writeWarned = false;

  function degrade(err) {
    st.degraded = true;
    st.storeErrors++;
    st.lastError = errText(err);
    if (!warned) {
      warned = true;
      logBan('createBanCache(' + keyPrefix + ')', '共享介质读失败，已退化为内存', err);
    }
  }

  function warnWrite(err) {
    if (writeWarned) return;
    writeWarned = true;
    logBan('createBanCache(' + keyPrefix + ')', '写共享介质失败（只记账，不降级）', err);
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
    // 规则版本对不上：这条是别代规则留下的，当未命中重算（历史载荷没带 v 的按兼容放行）
    if ('v' in entry && String(entry.v) !== String(version)) {
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
    const payload = encode({ v: version, value: value, expiresAt: expiry(t) });
    if (payload === null) return;
    st.storeSets++;
    try {
      const pending = store.set(key, payload, ttlForStore);
      if (isThenable(pending)) {
        pending.then(undefined, function (err) {
          st.storeErrors++;
          st.lastError = errText(err);
          warnWrite(err);
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

/* ---------- 共享介质：内存实现 / Redis 同形适配器 ---------- */

/**
 * 纯内存的共享介质（store 口子的直接实现）：同步 get/set/del，TTL 到点即过期，容量按 LRU 淘汰。
 * 形状与 redisLikeAdapter 一致，所以「注入内存介质」和「注入远端介质」在调用方看是同一套代码：
 * 单进程部署可以直接拿它当共享介质，测试里也拿它当基准实现。
 *
 *   const store = memoryStore({ maxEntries=500, ttlMs=60000, now })
 *   store.get(key) -> value | null
 *   store.set(key, value, ttlMs) -> bool（ttlMs<=0 表示不缓存，返回 false）
 *   store.del(key) -> bool
 *   store.keys(prefix | 'p*') -> string[]
 *   store.clear() -> 清掉的条数
 *   store.stats() -> { kind:'memory-store', ttlMs, maxEntries, size, gets, hits, misses, sets, dels,
 *                      evictions, expired }
 */
export function memoryStore(opts = {}) {
  const o = opts || {};
  const clock = typeof o.now === 'function' ? o.now : null;
  const ttlMs = o.ttlMs === Infinity ? Infinity : toMs(o.ttlMs, DEFAULT_STORE_TTL_MS);
  const maxEntries = Math.max(1, toInt(o.maxEntries, DEFAULT_STORE_MAX_ENTRIES, 1));

  /** key -> { value, expiresAt }；Map 迭代顺序当 LRU */
  const mem = new Map();
  const st = { gets: 0, hits: 0, misses: 0, sets: 0, dels: 0, evictions: 0, expired: 0 };

  function expiringAt(ms) {
    if (ms === Infinity) return Infinity;
    return timeOf(undefined, clock) + ms;
  }

  function get(key) {
    const k = String(key);
    st.gets++;
    const entry = mem.get(k);
    if (!entry) {
      st.misses++;
      return null;
    }
    if (entry.expiresAt <= timeOf(undefined, clock)) {
      mem.delete(k);
      st.expired++;
      st.misses++;
      return null;
    }
    mem.delete(k);
    mem.set(k, entry); // 碰一下挪到 LRU 末尾
    st.hits++;
    return entry.value;
  }

  function set(key, value, ttl) {
    const k = String(key);
    const ms = ttl === Infinity ? Infinity : ttl === undefined || ttl === null ? ttlMs : toMs(ttl, ttlMs);
    if (Number.isFinite(ms) && ms <= 0) return false; // 不缓存
    mem.delete(k);
    while (mem.size >= maxEntries) {
      const first = mem.keys().next();
      if (first.done) break;
      mem.delete(first.value);
      st.evictions++;
    }
    mem.set(k, { value: value, expiresAt: expiringAt(ms) });
    st.sets++;
    return true;
  }

  function del(key) {
    st.dels++;
    return mem.delete(String(key));
  }

  function keys(pattern) {
    const p = pattern === undefined || pattern === null ? '*' : String(pattern);
    const wildcard = p.endsWith('*');
    const literal = wildcard ? p.slice(0, -1) : p;
    const t = timeOf(undefined, clock);
    const out = [];
    for (const entry of mem) {
      if (entry[1].expiresAt <= t) {
        mem.delete(entry[0]);
        st.expired++;
        continue;
      }
      if (wildcard ? entry[0].startsWith(literal) : entry[0] === literal) out.push(entry[0]);
    }
    return out;
  }

  function clear() {
    const n = mem.size;
    mem.clear();
    return n;
  }

  function stats() {
    return {
      kind: 'memory-store',
      ttlMs: ttlMs,
      maxEntries: maxEntries,
      size: mem.size,
      gets: st.gets,
      hits: st.hits,
      misses: st.misses,
      sets: st.sets,
      dels: st.dels,
      evictions: st.evictions,
      expired: st.expired
    };
  }

  return { kind: 'memory-store', get: get, set: set, del: del, keys: keys, clear: clear, stats: stats };
}

/**
 * 把「像 Redis / Cloudflare KV 那样的最小客户端」适配成共享介质（store 口子）。
 * 认的接口与 src/rank-cache.js 的 redisLikeAdapter 同形、退化口径也一致：
 *   get(key) -> Promise<string|null>
 *   set(key, value, { EX: 秒 })
 *   del(key)
 *   keys(pattern)                                按前缀列举（可选，只当管理口子用）
 * keyPrefix 只在适配器内部拼到远端键上，对外 key 是不带前缀的裸键。
 *
 * 没给 client、或任何一次方法调用出错（同步抛 / Promise 拒绝），就永久退化成内存实现
 * （stats().backend 变 'memory'），之后不再打扰远端。区别是这里额外留一份内存副本：
 * 远端抖了也读得到，只是不再往外写。想重新启用远端就重建一个适配器实例。
 *
 *   const store = redisLikeAdapter(client, { ttlMs=60000, keyPrefix='', maxEntries=500, now, ttlSeconds })
 *   store.get(key) -> Promise<value|null>
 *   store.set(key, value, ttlMs) -> Promise<bool>
 *   store.del(key) -> Promise<bool>
 *   store.keys(pattern) -> Promise<string[]>
 *   store.stats() -> memoryStore 的字段 + { kind:'redis-like', backend, lastError, degradedAt }
 */
export function redisLikeAdapter(client, opts = {}) {
  const o = opts || {};
  const ttlMs = o.ttlMs === Infinity ? Infinity : toMs(o.ttlMs, DEFAULT_STORE_TTL_MS);
  const clock = typeof o.now === 'function' ? o.now : null;
  const ttlSeconds = Number.isFinite(o.ttlSeconds)
    ? Math.max(1, Math.round(Number(o.ttlSeconds)))
    // Infinity 的兜底给「一天」：86400000 毫秒 => EX 86400 秒
    //（src/rank-cache.js 的同款公式写成 86400，被当毫秒算出 87 秒；这里是新代码，按本意修正）
    : Math.max(1, Math.ceil((ttlMs === Infinity ? 86400000 : ttlMs) / 1000));
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? '' : String(o.keyPrefix);
  const mem = memoryStore({ maxEntries: o.maxEntries, ttlMs: ttlMs, now: o.now });
  const usable = !!client && typeof client.get === 'function' && typeof client.set === 'function';
  let backend = usable ? 'redis' : 'memory';
  let lastError = null;
  let degradedAt = null;
  let warned = false;

  /** 远端出任何问题：记下原因、喊一嗓子，此后只走内存 */
  function degrade(err) {
    if (backend !== 'redis') return;
    backend = 'memory';
    lastError = errText(err);
    degradedAt = timeOf(undefined, clock);
    if (!warned) {
      warned = true;
      logBan('redisLikeAdapter(' + keyPrefix + ')', '远端介质出错，已退化为内存', err);
    }
  }

  function secondsOf(ms) {
    return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : ttlSeconds;
  }

  async function get(key) {
    const k = String(key);
    if (backend !== 'redis') return mem.get(k);
    try {
      const raw = await client.get(keyPrefix + k);
      if (raw !== null && raw !== undefined) {
        mem.set(k, raw, ttlMs); // 顺手补一份内存副本
        return raw;
      }
      return null;
    } catch (err) {
      degrade(err);
      return mem.get(k);
    }
  }

  async function set(key, value, ttl) {
    const k = String(key);
    const ms = ttl === Infinity ? Infinity : ttl === undefined || ttl === null ? ttlMs : toMs(ttl, ttlMs);
    if (Number.isFinite(ms) && ms <= 0) return false;
    const text = String(value);
    const mirrored = mem.set(k, text, ms);
    if (backend !== 'redis') return mirrored;
    try {
      await client.set(keyPrefix + k, text, { EX: secondsOf(ms) });
      return true;
    } catch (err) {
      degrade(err);
      return mirrored;
    }
  }

  async function del(key) {
    const k = String(key);
    const had = mem.del(k);
    if (backend !== 'redis' || typeof client.del !== 'function') return had;
    try {
      await client.del(keyPrefix + k);
      return true;
    } catch (err) {
      degrade(err);
      return had;
    }
  }

  async function keys(pattern) {
    const p = pattern === undefined || pattern === null ? '*' : String(pattern);
    if (backend === 'redis' && typeof client.keys === 'function') {
      try {
        const list = await client.keys(keyPrefix + p);
        if (Array.isArray(list)) {
          const out = [];
          for (const item of list) {
            const text = String(item);
            out.push(text.startsWith(keyPrefix) ? text.slice(keyPrefix.length) : text);
          }
          return out;
        }
      } catch (err) {
        degrade(err);
      }
    }
    return mem.keys(p);
  }

  /** 只清内存副本：远端是整站共用的命名空间，不在这里 FLUSH，键上的 EX 会自己过期 */
  function clear() {
    return mem.clear();
  }

  function stats() {
    return Object.assign({}, mem.stats(), {
      kind: 'redis-like',
      ttlMs: ttlMs,
      keyPrefix: keyPrefix,
      backend: backend,
      lastError: lastError,
      degradedAt: degradedAt
    });
  }

  return { kind: 'redis-like', get: get, set: set, del: del, keys: keys, clear: clear, stats: stats };
}

/* ---------- 黑名单规则编译缓存 ---------- */

/**
 * 规则指纹：把黑名单规则行折算成稳定的短字符串。只认影响匹配行为的 kind / action / pattern
 * （id、note、created_at 这类无关列不参与），先排序再哈希，所以行序变化不影响指纹。
 * 键里带指纹，规则一改键就变，旧条目没人再读、TTL 到点被清掉。
 */
export function rulesFingerprint(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const parts = [];
  for (const row of list) {
    if (!row) continue;
    const pattern = String(row.pattern === undefined || row.pattern === null ? '' : row.pattern);
    if (!pattern) continue;
    parts.push(
      (row.kind === 'regex' ? 'regex' : 'word') +
      '\u0001' +
      (row.action === 'reject' ? 'reject' : 'review') +
      '\u0001' +
      pattern
    );
  }
  parts.sort();
  const text = parts.join('\u0002');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'fp1:' + h.toString(16).padStart(8, '0') + ':' + parts.length;
}

/**
 * createRuleCache({ ttlMs=60000, keyPrefix='rules:', store=null, client=null, clientKeyPrefix='',
 *                   now, maxEntries=200, version=1 })
 *
 * 黑名单规则的「编译产物」缓存：compileRules 要把每条正则都编译一遍，这是这条链上最贵的一步。
 * 键 = keyPrefix + version + ':' + key，key 由调用方给（rulesFingerprint(rows) 的指纹，或自己
 * 维护的规则版本号）；载荷里同时记着 v（版本）与 k（key），读回来逐个核对，对不上就当未命中
 * 重编译 —— 规则改了、别的实例还没来得及 invalidate 时靠这一条自动失效。
 *
 * 跨实例语义：实例 A 编译一次写进介质；实例 B 本地副本没有这把键，就去读介质命中，
 * 只把 JSON 变回编译产物（RegExp 用 { $re, $flags } 记录后重建），不再跑 compileFn。
 * 本地副本优先：同一把键的产物是幂等的，本机命中不必打扰介质；介质也没有才编译，然后写回。
 * 写回是 await 的（一次编译只写一次，代价可接受）：不 await 的话，迟到的写会落到一次 invalidate 之后，
 * 把旧产物又复活到共享介质里；await 之后「A 编译 → B 命中」与「invalidate 之后不再命中」都是确定的。
 * 同一个键的并发读共享一次编译（单飞），编译失败不写缓存、下一次重试。
 * 介质读写抛错就地退化为内存（本地副本本来就够用），每个实例打一行 [ban-cache] 日志。
 *
 *   getOrCompile(key, compileFn) -> Promise<value>（get 是它的别名）
 *   peek(key) -> { cached, value, expiresAt }
 *   invalidate(key) -> { local, broadcast }
 *   clear() -> 清掉的本地条数（不碰共享介质）
 *   stats() -> { ttlMs, keyPrefix, version, size, backend, storeKind, hits, misses, loads, compiles,
 *                revives, evictions, invalidations, broadcasts, storeGets, storeHits, storeSets,
 *                storeDels, storeErrors, degraded, lastError }
 *
 * TTL 与容量口径：介质条目按 ttlMs 过期（默认 60 秒；Infinity 交给介质自己解释），本地副本上限
 * maxEntries（默认 200，LRU 淘汰）。TTL 只是兜底，真正的失效来自指纹/版本变化与 invalidate。
 * 这里刻意不做 createBanCache 那种「store 权威」：同一把键的编译产物不会变，本机有一条更便宜。
 */
export function createRuleCache(opts = {}) {
  const o = opts || {};
  const ttlMs = o.ttlMs === Infinity ? Infinity : toMs(o.ttlMs, DEFAULT_RULE_TTL_MS);
  const keyPrefix = o.keyPrefix === undefined || o.keyPrefix === null ? DEFAULT_RULE_KEY_PREFIX : String(o.keyPrefix);
  const store = isStore(o.store)
    ? o.store
    : o.client
      ? redisLikeAdapter(o.client, { ttlMs: ttlMs, now: o.now, maxEntries: o.maxEntries, keyPrefix: o.clientKeyPrefix })
      : null;
  const clock = typeof o.now === 'function' ? o.now : null;
  const maxEntries = Math.max(1, toInt(o.maxEntries, DEFAULT_RULE_MAX_ENTRIES, 1));
  const version = o.version === undefined || o.version === null ? 1 : o.version;

  /** 本地副本 key -> { value, expiresAt, stamp }；Map 迭代顺序当 LRU */
  const mem = new Map();
  /** 单飞：key -> Promise，同一个键的并发读只编译一次 */
  const flying = new Map();
  const st = {
    hits: 0, misses: 0, loads: 0, compiles: 0, revives: 0, evictions: 0,
    invalidations: 0, broadcasts: 0,
    storeGets: 0, storeHits: 0, storeSets: 0, storeDels: 0, storeErrors: 0,
    degraded: false, lastError: null
  };
  let warned = false;
  let writeWarned = false;

  function usingStore() {
    return !!store && !st.degraded;
  }

  function degrade(err) {
    st.degraded = true;
    st.storeErrors++;
    st.lastError = errText(err);
    if (!warned) {
      warned = true;
      logBan('createRuleCache(' + keyPrefix + ')', '共享介质读失败，已退化为内存', err);
    }
  }

  function warnWrite(err) {
    if (writeWarned) return;
    writeWarned = true;
    logBan('createRuleCache(' + keyPrefix + ')', '写共享介质失败（只记账，不降级）', err);
  }

  function fullKey(key) {
    return keyPrefix + version + ':' + key;
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

  function localGet(key, t, stamp) {
    const entry = mem.get(key);
    if (!entry) return { hit: false, value: undefined };
    if (entry.expiresAt <= t || entry.stamp !== stamp) {
      mem.delete(key);
      return { hit: false, value: undefined };
    }
    mem.delete(key);
    mem.set(key, entry);
    return { hit: true, value: entry.value };
  }

  function localSet(key, value, expiresAt, stamp) {
    mem.delete(key);
    while (mem.size >= maxEntries) {
      const first = mem.keys().next();
      if (first.done) break;
      mem.delete(first.value);
      st.evictions++;
    }
    mem.set(key, { value: value, expiresAt: expiresAt, stamp: stamp });
  }

  /** 编译产物里可能有 RegExp（正则没法直接 JSON），写成 { $re, $flags } 再还原 */
  function encodeRules(value) {
    try {
      const text = JSON.stringify(value, function (k, v) {
        return v instanceof RegExp ? { $re: v.source, $flags: v.flags } : v;
      });
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }

  function decodeRules(text) {
    try {
      return JSON.parse(String(text), function (k, v) {
        if (
          v &&
          typeof v === 'object' &&
          typeof v.$re === 'string' &&
          typeof v.$flags === 'string' &&
          Object.keys(v).length === 2
        ) {
          return new RegExp(v.$re, v.$flags); // 编译不出来就让它抛：整条当坏值重编译
        }
        return v;
      });
    } catch {
      return UNDECODABLE;
    }
  }

  /** 载荷 { v, k, value, expiresAt }：v（版本）或 k（指纹）对不上就是别代规则的产物，当未命中 */
  function parseEntry(raw, t, stamp) {
    if (raw === null || raw === undefined) return { hit: false, value: undefined };
    const entry = typeof raw === 'string' ? decodeRules(raw) : raw;
    if (!entry || entry === UNDECODABLE || typeof entry !== 'object' || !('value' in entry)) {
      return { hit: false, value: undefined };
    }
    if ('v' in entry && String(entry.v) !== String(version)) return { hit: false, value: undefined };
    if ('k' in entry && String(entry.k) !== String(stamp)) return { hit: false, value: undefined };
    return { hit: true, value: entry.value, expiresAt: expiresFrom(entry.expiresAt, t) };
  }

  function remoteGet(key, t, stamp) {
    st.storeGets++;
    let raw;
    try {
      raw = store.get(key);
    } catch (err) {
      degrade(err);
      return { hit: false, value: undefined };
    }
    if (isThenable(raw)) {
      return raw.then(
        function (text) {
          return parseEntry(text, timeOf(undefined, clock), stamp);
        },
        function (err) {
          degrade(err);
          return { hit: false, value: undefined };
        }
      );
    }
    return parseEntry(raw, t, stamp);
  }

  function remoteSet(key, stamp, value, t) {
    // ttlMs=0 表示不缓存；Infinity 交给介质自己解释
    const ttlForStore = Number.isFinite(ttlMs) ? ttlMs : 0;
    if (ttlForStore <= 0 && ttlMs !== Infinity) return;
    const payload = encodeRules({ v: version, k: String(stamp), value: value, expiresAt: expiry(t) });
    if (payload === null) return; // 编不动（循环引用之类）就只留本地副本
    st.storeSets++;
    let pending;
    try {
      pending = store.set(key, payload, ttlForStore);
    } catch (err) {
      // 写失败只记账不降级：读得出旧值就还能用，退化成内存反而丢掉跨实例共享
      st.storeErrors++;
      st.lastError = errText(err);
      warnWrite(err);
      return undefined;
    }
    if (!isThenable(pending)) return undefined;
    // 返回一个「绝不拒绝」的 promise：编译路径会 await 它，介质写坏了也不能把编译结果带崩
    return pending.then(
      function () {
        return true;
      },
      function (err) {
        st.storeErrors++;
        st.lastError = errText(err);
        warnWrite(err);
        return false;
      }
    );
  }

  function getOrCompile(key, compileFn) {
    const stamp = key === undefined || key === null ? '' : String(key);
    const k = fullKey(stamp);
    const t = timeOf(undefined, clock);

    const local = localGet(k, t, stamp);
    if (local.hit) {
      st.hits++;
      return Promise.resolve(local.value);
    }

    const inflight = flying.get(k);
    if (inflight) return inflight; // 并发读同一把键：一起等第一次编译

    const pending = (async function () {
      if (usingStore()) {
        const got = await remoteGet(k, timeOf(undefined, clock), stamp);
        if (got.hit) {
          st.hits++;
          st.storeHits++;
          st.revives++;
          const at = timeOf(undefined, clock);
          localSet(k, got.value, got.expiresAt === undefined ? expiry(at) : got.expiresAt, stamp);
          return got.value;
        }
      }
      st.misses++;
      st.loads++;
      const value = await (typeof compileFn === 'function' ? compileFn(stamp) : undefined);
      st.compiles++;
      const at = timeOf(undefined, clock);
      localSet(k, value, expiry(at), stamp);
      if (usingStore()) await remoteSet(k, stamp, value, at);
      return value;
    })();

    flying.set(k, pending);
    pending.then(
      function () {
        if (flying.get(k) === pending) flying.delete(k);
      },
      function () {
        if (flying.get(k) === pending) flying.delete(k);
      }
    );
    return pending;
  }

  /** 失效：本地删掉 + 尽力广播一次远端删（src 版同步发起不 await；worker 版是 async） */
  function invalidate(key) {
    const stamp = key === undefined || key === null ? '' : String(key);
    const k = fullKey(stamp);
    const local = mem.delete(k);
    st.invalidations++;
    let broadcast = false;
    if (store && !st.degraded && typeof store.del === 'function') {
      st.storeDels++;
      try {
        const pending = store.del(k);
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

  function peek(key) {
    const stamp = key === undefined || key === null ? '' : String(key);
    const k = fullKey(stamp);
    const t = timeOf(undefined, clock);
    const entry = mem.get(k);
    if (!entry || entry.expiresAt <= t || entry.stamp !== stamp) {
      if (entry) mem.delete(k);
      return { cached: false, value: undefined, expiresAt: 0 };
    }
    return { cached: true, value: entry.value, expiresAt: entry.expiresAt };
  }

  function clear() {
    const n = mem.size;
    mem.clear();
    return n;
  }

  function stats() {
    return {
      ttlMs: ttlMs,
      keyPrefix: keyPrefix,
      version: version,
      size: mem.size,
      backend: usingStore() ? 'memory+store' : 'memory',
      storeKind: store ? store.kind || 'custom' : 'none',
      hits: st.hits,
      misses: st.misses,
      loads: st.loads,
      compiles: st.compiles,
      revives: st.revives,
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

  return {
    getOrCompile: getOrCompile,
    get: getOrCompile,
    peek: peek,
    invalidate: invalidate,
    clear: clear,
    stats: stats
  };
}
