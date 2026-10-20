/**
 * 论坛的内容安全约束：Express 版与 Workers+D1 版共用这一份（纯函数，不碰 Node API / DB）。
 * 这里放常量、判定，以及一层热路径频控（走 ratelimit.js 的滑动窗口计数）；
 * 限流的权威口径仍在数据层（数的是库里的真实行），nonce 核销、黑名单落库也各自在数据层做。
 */
import { createLimiter } from './ratelimit.js';

/** 标题 / 正文长度上限（按字符数，不是字节） */
export const THREAD_TITLE_MAX = 80;
export const POST_MAX = 3000;

/** 发帖数少于这个值算新人，内容先进待审队列 */
export const NEWBIE_POST_LIMIT = 3;

/** 表单从打开到提交的最短耗时：快过这个值不像人手填的，内容直接进待审 */
export const MIN_DWELL_MS = 1000;
/** 隐藏蜜罐字段名：正常用户看不见、也不会填，填了就是机器人 */
export const HONEYPOT_FIELD = 'website';
/** 一次性表单令牌字段名与有效期（人机校验用，没引第三方验证码） */
export const NONCE_FIELD = 'form_token';
export const NONCE_TTL_MINUTES = 30;

/** 频控：gapSeconds 是两条之间的最小间隔，perDay / perHour 是滚动窗口上限 */
export const RATE = {
  thread: { gapSeconds: 60, perDay: 10, label: '主题' },
  post: { gapSeconds: 20, perDay: 50, label: '回复' },
  report: { gapSeconds: 0, perHour: 5, label: '举报' }
};

/* ---------- 热路径频控（滑动窗口，可跨实例） ---------- */

/** 一天的毫秒数：数据层的 perDay 就是「最近 24 小时」（datetime('now','localtime','-1 day')），这里保持一致 */
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/**
 * 把某个 kind 的限制拆成若干滑动窗口，顺序是「先间隔、后频率」：
 *   { scope: 'gap' | 'day' | 'hour', windowMs, max }
 * gapSeconds 为 0 的（举报）不产生 gap 窗口；未知 kind 与数据层一样落到 RATE.post。
 */
export function rateWindows(kind) {
  const cfg = RATE[kind] || RATE.post;
  const wins = [];
  if (Number(cfg.gapSeconds) > 0) wins.push({ scope: 'gap', windowMs: Number(cfg.gapSeconds) * 1000, max: 1 });
  if (Number(cfg.perDay) > 0) wins.push({ scope: 'day', windowMs: DAY_MS, max: Number(cfg.perDay) });
  if (Number(cfg.perHour) > 0) wins.push({ scope: 'hour', windowMs: HOUR_MS, max: Number(cfg.perHour) });
  return wins;
}

/**
 * 被限流时的返回形状与 src/data-forum.js / worker/data-forum.js 的 checkRate 逐字一致：
 * 码（too_fast / daily / hourly）与文案都不能变，server.js 的 FORUM_ERR 按码取文案回显。
 */
export function rateRejection(kind, scope) {
  const cfg = RATE[kind] || RATE.post;
  if (scope === 'gap') return { error: 'too_fast', message: '发得太快了，' + cfg.gapSeconds + ' 秒内只能发一条' };
  if (scope === 'hour') return { error: 'hourly', message: '一小时内最多' + cfg.label + ' ' + cfg.perHour + ' 次' };
  return { error: 'daily', message: '今天' + cfg.label + '的数量到上限了（' + cfg.perDay + ' 条）' };
}

/**
 * 一整套频控：每个 kind 的每个窗口各一个 createLimiter。store 注入缝与 src/ratelimit.js
 * 完全相同（{ get, set, del }，可接 Redis / Cache API 适配器），不传就是进程内 / isolate 内存。
 * 返回 { check(kind, userId, now), limiterFor(kind, scope), sweep(now), stats() }。
 */
export function createRateGuard(opts = {}) {
  const o = opts || {};
  const store = o.store || null;
  const clock = typeof o.now === 'function' ? o.now : null;
  const limiters = new Map();

  /** 取（必要时新建）某个窗口的限流器；这个 kind 没有这个窗口就返回 null */
  function limiterFor(kind, scope) {
    const name = String(kind) + ':' + String(scope);
    const cached = limiters.get(name);
    if (cached) return cached;
    const win = rateWindows(kind).find(function (w) { return w.scope === scope; });
    if (!win) return null;
    const lim = createLimiter({
      windowMs: win.windowMs,
      max: win.max,
      keyPrefix: 'rl:forum:' + name + ':',
      store: store,
      now: clock
    });
    limiters.set(name, lim);
    return lim;
  }

  /**
   * 只看不记账：任一窗口已满就返回数据层同形的 { error, message }，全都没满给 { ok: true }。
   * 为什么拆出 peek：数据层的 checkRate 数的是**库里真实存在的行**，所以「被拒的提交」不该
   * 占配额。而一次提交在 createThread/ createReply 里还可能因为令牌过期、待审以外的原因失败
   * ——若 peek 完立刻 hit，那次失败的尝试就会吃掉 60 秒间隔，把紧随其后的正常提交挡成 too_fast
   * （2026-10-20 验收实测：新人在「假令牌」之后发首帖被误拒）。
   */
  function peek(kind, userId, when) {
    for (const win of rateWindows(kind)) {
      const lim = limiterFor(kind, win.scope);
      if (lim && lim.peek(userId, when).limited) return rateRejection(kind, win.scope);
    }
    return { ok: true };
  }

  /** 记账：所有窗口都记一次（调用方必须在**内容真的落库之后**才调） */
  function hit(kind, userId, when) {
    for (const win of rateWindows(kind)) {
      const lim = limiterFor(kind, win.scope);
      if (lim) lim.hit(userId, when);
    }
  }

  /** peek + 立刻 hit（一步到位的旧语义，供只需要「挡一下」的场景用） */
  function check(kind, userId, when) {
    const p = peek(kind, userId, when);
    if (p.error) return p;
    hit(kind, userId, when);
    return { ok: true };
  }

  /** 清掉所有窗口里已过期的 key，返回清掉的总数 */
  function sweep(when) {
    let removed = 0;
    for (const lim of limiters.values()) removed += lim.sweep(when);
    return removed;
  }

  /** 每个窗口一份 stats（键名 'kind:scope'）；顺便把 RATE 里所有窗口都建出来，保证覆盖完整 */
  function stats() {
    for (const kind of Object.keys(RATE)) {
      for (const win of rateWindows(kind)) limiterFor(kind, win.scope);
    }
    const out = {};
    for (const entry of limiters) out[entry[0]] = entry[1].stats();
    return out;
  }

  return { check: check, peek: peek, hit: hit, limiterFor: limiterFor, sweep: sweep, stats: stats };
}

/**
 * 默认那套（无 store，进程内 / isolate 内存）。
 * ⚠️ 接线教训（2026-10-20 验收实测，两处 too_fast 误报）：**不要把它挂在论坛路由的热路径上**。
 * 数据层的 checkRate 排在 forumGate（禁言）/ 锁定 / 黑名单判定之后，且站长豁免；在路由里再挡一层会：
 *   ① 把「已禁言（muted）」「待审（pending）」这类更具体的结果盖成 too_fast；
 *   ② 让被拒的尝试（令牌过期等）也吃掉 60 秒间隔，把紧随其后的正常提交挡掉；
 *   ③ 内存态跨测试运行存活，back-to-back 的验收会交替失败。
 * 所以两条线（server.js / worker/app.js）都已撤掉路由级调用，只由数据层 checkRate 把关。
 * 真要接，请用 peekRateFast + hitRateFast 成对：内容落库成功后才记账。
 */
const defaultGuard = createRateGuard();

/** 走默认 guard 的快速频控：返回 { ok: true } 或 { error, message }（与本文件原常量语义一致） */
export function checkRateFast(kind, userId, now) {
  return defaultGuard.check(kind, userId, now);
}

/**
 * 只挡不记账：路由里先 peek 挡掉明显的连发，等内容真的写进库（createThread/createReply 无 error）
 * 再调 hitRateFast 记账——与数据层 checkRate「数库里真实行」的口径保持一致。
 */
export function peekRateFast(kind, userId, now) {
  return defaultGuard.peek(kind, userId, now);
}

/** 内容落库之后记账（与 peekRateFast 配对使用） */
export function hitRateFast(kind, userId, now) {
  return defaultGuard.hit(kind, userId, now);
}

/** 默认 guard 各窗口的统计（用于自测与排查） */
export function forumLimiterStats() {
  return defaultGuard.stats();
}

/** 主题 / 楼层 / 禁言的状态语义，后台与前台共用 */
export const THREAD_STATUS = { 0: '待审核', 1: '已发布', 2: '已下架' };
export const POST_STATUS = { 0: '待审核', 1: '已发布', 2: '已隐藏' };

export const REPORT_REASONS = ['spam', 'ad', 'abuse', 'illegal', 'other'];
export const REPORT_LABEL = {
  spam: '垃圾广告',
  ad: '推广刷屏',
  abuse: '人身攻击',
  illegal: '违法内容',
  other: '其他'
};
export const REPORT_TARGETS = ['thread', 'post'];

/** 统一文本清洗：去控制字符、折叠空行、去首尾空白、截断 */
export function cleanText(raw, max) {
  let s = String(raw === undefined || raw === null ? '' : raw);
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  const limit = Number(max) || POST_MAX;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

export function validateTitle(raw) {
  const value = cleanText(raw, THREAD_TITLE_MAX + 1);
  if (!value) return { ok: false, error: '标题不能为空' };
  if (value.length > THREAD_TITLE_MAX) return { ok: false, error: '标题不能超过 ' + THREAD_TITLE_MAX + ' 个字' };
  return { ok: true, value: value };
}

export function validateBody(raw) {
  const value = cleanText(raw, POST_MAX + 1);
  if (!value) return { ok: false, error: '内容不能为空' };
  if (value.length > POST_MAX) return { ok: false, error: '内容不能超过 ' + POST_MAX + ' 个字' };
  return { ok: true, value: value };
}

/**
 * 把库里取出的黑名单编译成可匹配的形式。正则写坏了不让它拖垮整个站点：
 * 编译失败的那条直接跳过（后台会把它标出来）。
 */
export function compileRules(rows) {
  const out = [];
  for (const r of rows || []) {
    const kind = r.kind === 'regex' ? 'regex' : 'word';
    const action = r.action === 'reject' ? 'reject' : 'review';
    const pattern = String(r.pattern || '');
    if (!pattern) continue;
    if (kind === 'word') {
      out.push({ kind, action, pattern, needle: pattern.toLowerCase() });
      continue;
    }
    try {
      out.push({ kind, action, pattern, re: new RegExp(pattern, 'i') });
    } catch {
      out.push({ kind, action, pattern, broken: true });
    }
  }
  return out;
}

/** 命中检测：reject 优先于 review；返回命中的模式文本，供后台展示 */
export function matchRules(text, rules) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const hits = [];
  let action = 'ok';
  for (const r of rules || []) {
    if (r.broken) continue;
    const hit = r.kind === 'word' ? lower.indexOf(r.needle) >= 0 : r.re.test(s);
    if (!hit) continue;
    hits.push(r.pattern);
    if (r.action === 'reject') action = 'reject';
    else if (action !== 'reject') action = 'review';
  }
  return { action, hits };
}

/**
 * 发出去的内容是「直接公开(1)」还是「先进待审(0)」。原因写进后台队列，便于站长判断。
 * reject 不在这里处理——调用方在此之前就拦掉了。
 */
export function decideStatus(opts) {
  const o = opts || {};
  if (o.trusted) return { status: 1, reason: '' };
  if (o.ruleAction === 'review') return { status: 0, reason: '命中关键词审核规则' };
  if (o.fastSubmit) return { status: 0, reason: '提交过快，疑似非人工' };
  if (o.newbie) return { status: 0, reason: '新账号前 ' + NEWBIE_POST_LIMIT + ' 条内容' };
  return { status: 1, reason: '' };
}

/** 前台能看到的判定（后台与作者自己除外） */
export function isPublic(status) {
  return Number(status) === 1;
}
