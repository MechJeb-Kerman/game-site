/**
 * 搜索后端适配器（纯逻辑 + 依赖注入）：「主搜索 + 兜底搜索 + 熔断」这一段抽成一个模块，
 * 为「搜索换 Meilisearch」做准备。本轮只提供模块本身，接线（server.js / worker/app.js）由 Lead 做。
 *
 * 两条硬规矩：
 *   1. 不读 env、不用全局 fetch：url / apiKey / fetchImpl / now 全部从参数进，测试与 Workers 环境都好用；
 *   2. search() 永不抛错：主后端抛错或超时就退兜底，兜底也挂就返回空结果并把错误记进 stats().lastError。
 *      页面宁可显示「没搜到」，也不该因为搜索后端抖一下整页 500。
 *
 * 计费口径（stats 里那些数都是干什么的）：
 *   primaryCalls / primaryFailures —— 真发出去的主后端请求数 / 其中失败（抛错或超时）的次数；
 *   fallbackCalls / fallbackHits  —— 兜底被调用次数 / 其中成功返回的次数（返回空列表也算成功）；
 *   breakerOpen                   —— 熔断器是否已被触发（连续失败到阈值后为 true，直到某次 primary 成功才复位）；
 *   lastError / lastErrorLeg      —— 最近一次错误原文，以及它是哪条腿（primary / fallback / adapter）犯的；
 *   lastLatencyMs                 —— 最近一次 primary 尝试的耗时（被熔断跳过时不更新）。
 *
 * 结果形状（search() 的返回值，两条腿统一）：
 *   { items, total, source, backend, query, queryKey, latencyMs }
 *   source   —— 'primary' | 'fallback' | 'empty'，页面据此决定要不要提示「兜底结果」；
 *   backend  —— 提供方自报的名字（'meili' / 'sql'），也就是哪套实现真的答了这一问。
 */

/** 查询串长度上限：超长搜索词对结果没帮助，只会拖慢后端 */
export const MAX_QUERY_LENGTH = 64;

/** Meilisearch 没配 url 时抛的错误码（上层据此决定要不要把它当 primary） */
export const MEILI_UNCONFIGURED = 'meili_unconfigured';

/** 单条腿的超时错误码 */
const LEG_TIMEOUT = 'search_timeout';

/**
 * 归一化搜索词：去首尾空白 + 把连续空白折成一个空格 + 截到 64 字符。
 * 返回 { raw, text, key }：
 *   raw  —— 原样（日志 / 回显用）；
 *   text —— 归一化后仍保留大小写的串，交给后端搜的就是它；
 *   key  —— text 经 NFKC + 小写后的比较键（缓存 key / 去重用：全角「ＨＯＴ」与「hot」在这里相等）。
 */
export function normalizeQuery(q) {
  const raw = q === undefined || q === null ? '' : String(q);
  const text = raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
  return { raw: raw, text: text, key: text.normalize('NFKC').toLowerCase() };
}

/** 错误取文本：拿不到 message 就 String(err) */
function errText(err) {
  if (!err) return 'unknown';
  return err.message ? String(err.message) : String(err);
}

/** 小整数兜底（null / '' / NaN 都用默认值） */
function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/** 给一次异步调用套超时：到点就 reject，并且无论胜负都清掉计时器（别把事件循环吊住） */
function withTimeout(run, ms) {
  const task = Promise.resolve().then(run);
  if (!(ms > 0)) return task;
  let timer = null;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(LEG_TIMEOUT);
      err.code = LEG_TIMEOUT;
      reject(err);
    }, ms);
  });
  return Promise.race([task, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 组装一个带兜底与熔断的搜索后端。
 *
 * @param {object} opts
 * @param {(q:string, opts:object)=>Promise<{items:Array,total?:number,source?:string}>|null} opts.primary 主后端；null = 没配（直接走兜底）
 * @param {(q:string, opts:object)=>Promise<{items:Array,total?:number,source?:string}>|null} opts.fallback 兜底，形状同 primary
 * @param {number} [opts.timeoutMs=1500] 单次 primary 的上限，超时按失败算
 * @param {{failures?:number,cooldownMs?:number}} [opts.breaker={failures:3,cooldownMs:30000}] 连续失败到 failures 次打开熔断，冷却 cooldownMs 后放一个半开探测
 * @param {()=>number} [opts.now=Date.now] 取时钟（测试用假时钟）
 * @returns {{search:(q:string,opts?:object)=>Promise<object>, stats:()=>object, enabledBackend:()=>('primary'|'fallback')}}
 */
export function makeSearchBackend(opts = {}) {
  const primary = typeof opts.primary === 'function' ? opts.primary : null;
  const fallback = typeof opts.fallback === 'function' ? opts.fallback : null;
  const timeoutMs = intOr(opts.timeoutMs, 1500);
  const br = opts.breaker || {};
  const maxFailures = Math.max(1, intOr(br.failures, 3));
  const cooldownMs = intOr(br.cooldownMs, 30000);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  let failStreak = 0; // 连续失败次数（成功一次即清零）
  let openUntil = 0; // 熔断打开到什么时候（到点放一个半开探测）
  let probing = false; // 半开探测是否已有一个在飞（半开只放一个，其余先走兜底）
  const st = { primaryCalls: 0, primaryFailures: 0, fallbackCalls: 0, fallbackHits: 0, lastError: null, lastErrorLeg: null, lastLatencyMs: null };

  /** 'closed' 正常 | 'open' 冷却中不放行 | 'half-open' 冷却结束、放一个探测 */
  function breakerState() {
    if (failStreak < maxFailures) return 'closed';
    return now() < openUntil ? 'open' : 'half-open';
  }

  /** 这一次调用要不要走 primary（纯函数，不改状态；探测标记由 search 自己置） */
  function canTryPrimary() {
    if (!primary) return false;
    const state = breakerState();
    if (state === 'closed') return true;
    return state === 'half-open' && !probing;
  }

  /** 统一结果形状：两条腿、三种结局都从这出去 */
  function pack(raw, source, norm, ms) {
    const res = raw && typeof raw === 'object' ? raw : {};
    const items = Array.isArray(res.items) ? res.items : [];
    const total = Number(res.total);
    return {
      items: items,
      total: Number.isFinite(total) ? total : items.length,
      source: source,
      backend: String(res.source || (source === 'empty' ? '' : source)),
      query: norm.text,
      queryKey: norm.key,
      latencyMs: Math.max(0, Math.round(Number(ms) || 0))
    };
  }

  /**
   * 搜一次。永不抛错；出了任何岔子都返回空结果（items: []，source: 'empty'）。
   * 归一化后的查询串（text）才会交给后端，opts 原样透传。
   */
  async function search(q, o) {
    const norm = normalizeQuery(q);
    const options = o && typeof o === 'object' ? o : {};
    const started = now();
    try {
      if (canTryPrimary()) {
        const half = breakerState() === 'half-open';
        st.primaryCalls++;
        if (half) probing = true;
        const t0 = now();
        try {
          const res = await withTimeout(() => primary(norm.text, options), timeoutMs);
          const ms = Math.max(0, Math.round(now() - t0));
          st.lastLatencyMs = ms;
          failStreak = 0;
          openUntil = 0;
          return pack(res, 'primary', norm, ms);
        } catch (err) {
          st.lastLatencyMs = Math.max(0, Math.round(now() - t0));
          st.primaryFailures++;
          st.lastError = errText(err);
          st.lastErrorLeg = 'primary';
          failStreak++;
          if (failStreak >= maxFailures) openUntil = now() + cooldownMs;
        } finally {
          if (half) probing = false;
        }
      }
      if (!fallback) return pack(null, 'empty', norm, now() - started);
      st.fallbackCalls++;
      const t1 = now();
      try {
        const res = await fallback(norm.text, options);
        st.fallbackHits++;
        return pack(res, 'fallback', norm, now() - t1);
      } catch (err) {
        st.lastError = errText(err);
        st.lastErrorLeg = 'fallback';
        return pack(null, 'empty', norm, now() - started);
      }
    } catch (err) {
      // 最后一道闸：能走到这儿说明是适配器自己的 bug，那也不能让页面 500
      st.lastError = errText(err);
      st.lastErrorLeg = 'adapter';
      return pack(null, 'empty', norm, now() - started);
    }
  }

  function stats() {
    return {
      primaryCalls: st.primaryCalls,
      primaryFailures: st.primaryFailures,
      fallbackCalls: st.fallbackCalls,
      fallbackHits: st.fallbackHits,
      breakerOpen: failStreak >= maxFailures,
      lastError: st.lastError,
      lastLatencyMs: st.lastLatencyMs,
      // 下面是给运维/后台页看的补充信息，不是核心契约
      lastErrorLeg: st.lastErrorLeg,
      breakerState: breakerState(),
      failureStreak: failStreak
    };
  }

  /** 下一次 search 实际会先打哪条腿（后台页「搜索后端状态」用） */
  function enabledBackend() {
    return canTryPrimary() ? 'primary' : 'fallback';
  }

  return { search: search, stats: stats, enabledBackend: enabledBackend };
}

/** 把一条 Meilisearch 命中归一化成站内要的形状（多出来的字段一律不往下传） */
function normalizeHit(h) {
  const hit = h && typeof h === 'object' ? h : {};
  const rank = hit._rankingScore !== undefined ? hit._rankingScore : hit.score !== undefined ? hit.score : 0;
  const score = Number(rank);
  return {
    slug: String(hit.slug !== undefined ? hit.slug : hit.id !== undefined ? hit.id : ''),
    title: String(hit.title !== undefined ? hit.title : hit.name !== undefined ? hit.name : ''),
    score: Number.isFinite(score) ? score : 0
  };
}

/**
 * Meilisearch 后端：写成一个 primary 形状的函数，交给 makeSearchBackend 用。
 * 走 POST <url>/indexes/<index>/search，把 hits 归一化成 { slug, title, score }，source 自报 'meili'。
 * url 为空时直接抛 Error('meili_unconfigured')——要不要用它是上层的事（没配就别当 primary）。
 *
 * @param {{url:string,apiKey?:string,index?:string,fetchImpl?:Function,timeoutMs?:number}} cfg
 */
export function meiliBackend(cfg = {}) {
  const base = String(cfg.url || '').replace(/\/+$/, '');
  const apiKey = String(cfg.apiKey || '');
  const index = String(cfg.index || 'games');
  const doFetch = typeof cfg.fetchImpl === 'function' ? cfg.fetchImpl : fetch;
  const timeoutMs = intOr(cfg.timeoutMs, 1500);
  const endpoint = base ? base + '/indexes/' + encodeURIComponent(index) + '/search' : '';

  return async function meiliSearch(q, opts = {}) {
    if (!base) {
      const err = new Error(MEILI_UNCONFIGURED);
      err.code = MEILI_UNCONFIGURED;
      throw err;
    }
    const o = opts || {};
    const body = { q: String(q || '') };
    body.limit = intOr(o.limit, 20);
    body.offset = intOr(o.offset, 0);
    if (o.filter) body.filter = o.filter;
    if (o.sort) body.sort = o.sort;
    if (o.showRankingScore !== false) body.showRankingScore = true; // 归一化里要有 score，就得先跟 Meili 要
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctl && timeoutMs > 0) timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || res.ok !== true) {
      const status = res && Number.isFinite(Number(res.status)) ? Number(res.status) : 0;
      const err = new Error('meili_http_' + status);
      err.code = 'meili_http';
      err.status = status;
      try {
        err.detail = String(await res.text()).slice(0, 300);
      } catch (e) {
        /* 读不到响应体就算了，状态码已经够定位 */
      }
      throw err;
    }
    const data = await res.json();
    const hits = Array.isArray(data && data.hits) ? data.hits : [];
    const rawTotal = data ? (data.estimatedTotalHits !== undefined ? data.estimatedTotalHits : data.totalHits) : undefined;
    const total = Number(rawTotal);
    return { items: hits.map(normalizeHit), total: Number.isFinite(total) ? total : hits.length, source: 'meili' };
  };
}

/**
 * 把现有的 SQL 搜索包成 primary 形状（同步或异步的 adapter 都认）。
 * adapter(q, opts) 返回 { items, total }；它抛错就原样往上抛——兜不兜由 makeSearchBackend 决定。
 */
export function sqlBackend(adapter) {
  const run = typeof adapter === 'function' ? adapter : () => ({ items: [], total: 0 });
  return async function sqlSearch(q, opts = {}) {
    const res = (await run(q, opts)) || {};
    const items = Array.isArray(res.items) ? res.items : [];
    const total = Number(res.total);
    return { items: items, total: Number.isFinite(total) ? total : items.length, source: 'sql' };
  };
}
