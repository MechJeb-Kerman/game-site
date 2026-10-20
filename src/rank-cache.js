/**
 * 通用热读缓存（TTL + 容量上限 + 单飞 + 显式失效）：纯内存、零依赖，
 * 排行榜 / 搜索 / 其它「读多写少」的地方都能用，日后换 Redis 也从这里的 getOrLoad 形状接出去。
 *
 * 三个语义上的关键点：
 *   1. 单飞（single-flight）：同一个 key 上的并发读只会跑一次 loader，其余调用共享这次结果——
 *      榜单缓存刚过期那一下被几十个请求同时打，靠这条就不会把数据库打穿；
 *   2. 过期不返旧值：第一个发现过期的请求触发重载，同 key 的其它请求一起等这次重载（不做 stale-while-revalidate）。
 *      榜单宁可慢一点，也不能显示「昨天的分数」；真要旧值，调用方自己在 loader 里兜；
 *   3. loader 抛错不写缓存：错误原样抛给这一次的所有等待者，键上不留半成品，下一个请求重新尝试。
 *
 * 时间全部走注入的 now()，测试不必真的 sleep。
 */

/** JSON 解不出来的远端值（Redis 里可能被别人写了别的东西） */
const UNDECODABLE = Symbol('undecodable');

/** 错误取文本：拿不到 message 就 String(err) */
function errText(err) {
  if (!err) return 'unknown';
  return err.message ? String(err.message) : String(err);
}

/** 序列化：undefined / 循环引用这类写不进远程的值返回 null（调用方跳过写入） */
function encode(value) {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : null;
  } catch (e) {
    return null;
  }
}

/** 反序列化：坏值不抛错，返回哨兵让调用方当成「没命中」 */
function decode(text) {
  try {
    return JSON.parse(String(text));
  } catch (e) {
    return UNDECODABLE;
  }
}

/**
 * 建一个缓存。
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=30000] 值活多久（可传 Infinity = 不过期）
 * @param {number} [opts.maxEntries=200] 容量上限，超了按最久未使用淘汰（正在加载的条目不会被淘汰）
 * @param {()=>number} [opts.now=Date.now] 取时钟
 * @returns {{
 *   getOrLoad:(key:string, loader:(key:string)=>any)=>Promise<any>,
 *   peek:(key:string)=>any, invalidate:(key:string)=>boolean,
 *   invalidatePrefix:(prefix:string)=>number, clear:()=>number, stats:()=>object
 * }}
 */
export function createCache(opts = {}) {
  const ttlMs = opts.ttlMs === Infinity ? Infinity : Number.isFinite(opts.ttlMs) ? Math.max(0, Number(opts.ttlMs)) : 30000;
  const maxEntries = Number.isFinite(opts.maxEntries) ? Math.max(1, Math.floor(Number(opts.maxEntries))) : 200;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /** key -> { value, expiresAt, pending }；pending !== null 表示这次加载还在飞 */
  const store = new Map();
  const st = { hits: 0, misses: 0, loads: 0, evictions: 0 };

  /** 有条目、不在加载中、且没过期 —— 三个条件齐了才算「现成值」 */
  function alive(entry) {
    return !!entry && entry.pending === null && entry.expiresAt > now();
  }

  /** 命中后把条目挪到 LRU 末尾（Map 保插入序，删了再塞就是最新） */
  function touch(key, entry) {
    if (store.get(key) === entry) {
      store.delete(key);
      store.set(key, entry);
    }
  }

  /** 超容量就从头淘汰（迭代顺序 = 最久未使用在前），在飞的加载留着不动 */
  function evict() {
    if (store.size <= maxEntries) return;
    for (const pair of store) {
      if (store.size <= maxEntries) break;
      if (pair[1].pending !== null) continue;
      store.delete(pair[0]);
      st.evictions++;
    }
  }

  /**
   * 取 key 的值：命中未过期就现拿，否则调 loader（同 key 并发只调一次）。
   * loader 会收到 key 当第一个参数（不接受也不影响），返回值的 Promise 就是本函数的返回值。
   *
   * 计数口径：hits 只数「拿到现成未过期值」的调用；需要加载的都算 misses
   * （并发跟随者也算 misses——它们确实没拿到现成值，真实开销看 loads）。
   */
  function getOrLoad(key, loader) {
    const k = String(key);
    const entry = store.get(k);
    if (alive(entry)) {
      st.hits++;
      touch(k, entry);
      return Promise.resolve(entry.value);
    }
    if (entry && entry.pending) {
      st.misses++;
      return entry.pending;
    }
    st.misses++;
    st.loads++;
    const fn = typeof loader === 'function' ? loader : () => undefined;
    const pending = (async () => fn(k))();
    store.set(k, { value: undefined, expiresAt: 0, pending: pending });
    pending.catch(() => {}); // 没人 await 时也别冒 unhandled rejection
    pending.then(
      (value) => {
        const cur = store.get(k);
        if (cur && cur.pending === pending) {
          // 期间被 invalidate / clear 过的话 store 里已经不是这次加载了，那就不回写
          store.set(k, { value: value, expiresAt: now() + ttlMs, pending: null });
          evict();
        }
      },
      () => {
        const cur = store.get(k);
        if (cur && cur.pending === pending) store.delete(k); // 失败不留坟
      }
    );
    return pending;
  }

  /** 看一眼有没有现成值（不触发加载、不计命中、不动 LRU）；过期 / 加载中 / 没写过的都给 undefined */
  function peek(key) {
    const entry = store.get(String(key));
    return alive(entry) ? entry.value : undefined;
  }

  /** 显式失效：删掉这个键（正在飞的加载也不会再回写）。返回是否真删掉了东西 */
  function invalidate(key) {
    return store.delete(String(key));
  }

  /** 按前缀失效（如 'rank:'），返回删掉的条数 */
  function invalidatePrefix(prefix) {
    const p = String(prefix);
    let n = 0;
    for (const key of store.keys()) {
      if (key.startsWith(p)) {
        store.delete(key);
        n++;
      }
    }
    return n;
  }

  /** 清空全部条目，返回清掉的条数。计数器保留：它们是这台进程活到现在的累计值，便于看命中率变化 */
  function clear() {
    const n = store.size;
    store.clear();
    return n;
  }

  /** size 含正在加载的条目；inflight = 正在加载的 key 数 */
  function stats() {
    let inflight = 0;
    for (const entry of store.values()) if (entry.pending !== null) inflight++;
    return { size: store.size, hits: st.hits, misses: st.misses, loads: st.loads, evictions: st.evictions, inflight: inflight };
  }

  return {
    getOrLoad: getOrLoad,
    peek: peek,
    invalidate: invalidate,
    invalidatePrefix: invalidatePrefix,
    clear: clear,
    stats: stats
  };
}

/**
 * 把「像 Redis / Cloudflare KV 那样的最小客户端」适配成和 createCache 一样的 getOrLoad 形状，
 * 日后接 Redis / KV 只要换这一层，排行榜那半边不用动。
 *
 * 认的接口（有这些就够；node-redis v4 / ioredis 的常用方法都长这样）：
 *   get(key) -> Promise<string|null>   取字符串
 *   set(key, value, { EX: 秒 })        带过期的写入（TTL 由这里保证）
 *   del(key 或 string[]) -> Promise<number>
 *   keys(pattern) -> Promise<string[]> 按前缀列举（invalidatePrefix 用；真 Redis 上 KEYS 是 O(N)，只当管理口子用）
 *
 * 注意：对外所有 key 与 prefix 都是「内存层」的（不带 keyPrefix 的裸键，如 'hot'），
 * keyPrefix 只在适配器内部拼到远端键上——所以这里是 invalidatePrefix('hot') 而不是 ('rank:hot')。
 *
 * 退化规则：没有 client、或上面任何一个方法抛错，就永久退化成纯内存实现（stats().backend 变 'memory'），
 * 之后不再打扰远端——排行榜不能因为 Redis 抖一下整块挂掉。想重新启用远端就重建一个适配器实例。
 *
 * @param {object|null} client 最小客户端；传 null / undefined 就是纯内存
 * @param {object} [opts] 同 createCache，另加 { keyPrefix?:string, ttlSeconds?:number }
 * @returns {ReturnType<typeof createCache>} 形状一致；stats() 多出 backend / lastError / degradedAt
 */
export function redisLikeAdapter(client, opts = {}) {
  const ttlMs = opts.ttlMs === Infinity ? Infinity : Number.isFinite(opts.ttlMs) ? Math.max(0, Number(opts.ttlMs)) : 30000;
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const ttlSeconds = Number.isFinite(opts.ttlSeconds) ? Math.max(1, Math.round(Number(opts.ttlSeconds))) : Math.max(1, Math.ceil((ttlMs === Infinity ? 86400 : ttlMs) / 1000));
  const keyPrefix = String(opts.keyPrefix || '');
  const mem = createCache({ ttlMs: ttlMs, maxEntries: opts.maxEntries, now: opts.now });
  let backend = client ? 'redis' : 'memory';
  let lastError = null;
  let degradedAt = null;

  /** 远端出任何问题：记下原因，此后只走内存 */
  function degrade(err) {
    if (backend !== 'redis') return;
    backend = 'memory';
    lastError = errText(err);
    degradedAt = clock();
  }

  /** 远端操作一律「尽力而为」：同步抛错和 Promise 拒绝都只导致退化，绝不丢给调用方 */
  function remote(fn) {
    if (backend !== 'redis') return undefined;
    try {
      const p = fn();
      if (p && typeof p.then === 'function') p.then(undefined, (err) => degrade(err));
      return p;
    } catch (err) {
      degrade(err);
      return undefined;
    }
  }

  function redisKey(key) {
    return keyPrefix + key;
  }

  /** 一次加载的真正内容：先问远端，没命中再调 loader，然后把结果写回远端 */
  async function loadThrough(key, loader) {
    if (backend === 'redis') {
      try {
        const hit = await client.get(redisKey(key));
        if (hit !== null && hit !== undefined) {
          const parsed = decode(hit);
          if (parsed !== UNDECODABLE) return parsed; // 坏值当未命中，重算即可
        }
      } catch (err) {
        degrade(err);
      }
    }
    const value = await loader(key);
    if (backend === 'redis') {
      try {
        const payload = encode(value);
        if (payload !== null) await client.set(redisKey(key), payload, { EX: ttlSeconds });
      } catch (err) {
        degrade(err);
      }
    }
    return value;
  }

  function getOrLoad(key, loader) {
    const fn = typeof loader === 'function' ? loader : () => undefined;
    return mem.getOrLoad(key, (k) => loadThrough(k, fn));
  }

  function invalidate(key) {
    const k = String(key);
    const had = mem.invalidate(k);
    remote(() => client.del(redisKey(k)));
    return had;
  }

  function invalidatePrefix(prefix) {
    const p = String(prefix);
    const n = mem.invalidatePrefix(p);
    if (typeof client.keys === 'function') {
      remote(() =>
        (async () => {
          const keys = await client.keys(redisKey(p) + '*');
          if (Array.isArray(keys) && keys.length) await client.del(keys);
        })()
      );
    }
    return n;
  }

  /** 只清内存层：远端是整站共用的命名空间，不在这里 FLUSH，键上的 EX 会自己过期 */
  function clear() {
    return mem.clear();
  }

  function stats() {
    return Object.assign({}, mem.stats(), { backend: backend, lastError: lastError, degradedAt: degradedAt });
  }

  return {
    getOrLoad: getOrLoad,
    peek: mem.peek,
    invalidate: invalidate,
    invalidatePrefix: invalidatePrefix,
    clear: clear,
    stats: stats
  };
}
