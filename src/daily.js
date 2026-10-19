/**
 * 每日挑战的纯逻辑：挑今天的游戏、算连续天数。
 *
 * 「完成」由服务端判定——当天挑战的那款游戏收到一次游玩上报（POST /api/games/:slug/play）
 * 就算完成，不引入客户端申报分数（分数不可信）。数据库那半边在 src/social.js / worker/social.js。
 *
 * 日期用**服务器本地时区**（本机 = Asia/Shanghai，Cloudflare Workers 上 = UTC）：
 * 全站同一个日界，比按访客时区各算一套更简单，也让「今天」在榜单里说得清。
 */

/** 日期键 'YYYY-MM-DD' */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 日期键往前/往后挪 n 天（按自然日加减，跨月跨年与夏令时都不会错位） */
export function shiftDay(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(n || 0));
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 今天挑战哪一款：把日期与「已上架游戏的 slug」一起哈希后取一个。
 * 用哈希而不是顺序轮换，是为了让同一天在两条线（Express / Worker）上算出同一个结果，
 * 也免得「改一次游戏列表，最近几天的挑战全变」。
 */
export function pickDaily(day, games) {
  const slugs = (games || [])
    .map((g) => (typeof g === 'string' ? g : g && g.slug))
    .filter(Boolean)
    .sort();
  if (!slugs.length) return '';
  let h = 2166136261; // FNV-1a 32 位
  const s = String(day || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return slugs[Math.abs(h) % slugs.length];
}

/**
 * 连续天数：从今天往回数（今天还没做就从昨天起算——「今天没打卡」不该把好不容易攒的连续断掉）。
 * days 是这位玩家完成过的日期列表（任意顺序、可重复）。
 */
export function streakOf(days, now = Date.now()) {
  const set = new Set((days || []).map(String));
  const today = dayKey(now);
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (cursor && set.has(cursor) && n < 3660) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}
