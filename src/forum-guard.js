/**
 * 论坛的内容安全约束：Express 版与 Workers+D1 版共用这一份（纯函数，不碰 Node API / DB）。
 * 这里只放常量与判定；限流计数、nonce 核销、黑名单落库在各自的数据层做。
 */

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
