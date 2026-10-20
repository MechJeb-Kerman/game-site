/**
 * 每日挑战的纯逻辑：挑今天的游戏、算连续天数。
 *
 * 「完成」由服务端判定——当天挑战的那款游戏收到一次游玩上报（POST /api/games/:slug/play）
 * 就算完成，不引入客户端申报分数（分数不可信）。数据库那半边在 src/social.js / worker/social.js。
 *
 * 日期用**服务器本地时区**（本机 = Asia/Shanghai，Cloudflare Workers 上 = UTC）：
 * 全站同一个日界，比按访客时区各算一套更简单，也让「今天」在榜单里说得清。
 *
 * 第八批的全勤日历 / 补做也在这里定口径（窗口多长、连续天数认不认补做），
 * 落库在 src/social.js 与 worker/social.js，两边一一对应。
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

/* ================= 第八批：全勤日历与补做 =================
 * 口径（src/social.js 与 worker/social.js 两边逐字一致）：
 *
 *  · 「完成」= daily_results 里有这一天的记录。补做也写一行，只是 makeup = 1；
 *    行的 day 是**目标日**（本该完成的那天），done_day 是服务端**实际收到上报**的日期。
 *  · 连续天数只认自然打卡：喂给 streakOf 的是 makeup = 0 的那些行的 day。
 *    理由——连续天数现在只进 streak-7 徽章，补做若能续上连续，等于用一次点击买回一条连续，
 *    对按时打卡的人不公平，徽章数字也就没意义了。补做照样进总完成数 / 月度全勤 / 日历格子。
 *  · 补做窗口 = 今天往前 MAKEUP_WINDOW 天（含昨天、前天，**不含今天**）：
 *    今天还没过完，「补今天的」和正常打卡是同一件事，不该走补做口子（否则同一天既能打卡又能补做，
 *    done_day 也说不清是哪一次）。超出窗口（含未来日期）一律 error = 'too_late'。
 */

/** 补做窗口：今天之前还能补做的天数（不含今天） */
export const MAKEUP_WINDOW = 2;

/**
 * 补做窗口判定：day 为空 = 当天打卡，返回 null（可以记）。
 * 不能记时返回原因码：'bad_day' 日期格式不对，'too_late' 超出窗口（含未来的日期）。
 */
export function makeupCheck(day, now = Date.now()) {
  const target = String(day || '');
  if (!target) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return 'bad_day';
  const today = dayKey(now);
  if (target === today) return null;
  for (let k = 1; k <= MAKEUP_WINDOW; k++) if (shiftDay(today, -k) === target) return null;
  return 'too_late';
}

/**
 * 某个月的进度：total 只数「到今天为止已经过去的天数」，未来的格子不进分母
 * （否则每月 1 号永远不可能全勤）。今天早于这个月（月份还没开始）返回 null。
 */
export function monthProgress(month, day = dayKey()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const label = m[1] + '-' + m[2];
  const today = String(day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || today < label + '-01') return null;
  const monthDays = new Date(Number(m[1]), Number(m[2]), 0).getDate(); // 下个月的第 0 天 = 本月最后一天
  const total = today.slice(0, 7) === label ? Math.min(Number(today.slice(8, 10)), monthDays) : monthDays;
  return { month: label, total: total, monthDays: monthDays };
}

/**
 * 月度全勤：done 只数 month 这个月、且不晚于今天的天数。
 * perfect = 已经过去的每一天都有记录（1 号当天做一次就是 1/1）。
 */
export function monthPerfect(month, doneDays, now = Date.now()) {
  const p = monthProgress(month, dayKey(now));
  if (!p) return { month: String(month || ''), total: 0, done: 0, perfect: false };
  const prefix = p.month + '-';
  const set = new Set();
  for (const d of (doneDays || [])) {
    const s = String(d || '');
    if (s.slice(0, prefix.length) === prefix && Number(s.slice(8, 10)) <= p.total) set.add(s);
  }
  return { month: p.month, total: p.total, done: set.size, perfect: set.size >= p.total };
}

/**
 * 日历格子：最近 n 天（含今天）按时间正序。rows 是 daily_results 的 { day, slug, makeup, done_day } 行。
 * 今天的格子没有「补做」一说（当天完成就是 makeup = 0），done 只看目标日有没有记录。
 * doneDay 是审计字段（实际完成日期）：自然打卡等于 day，补做则晚于 day。
 */
export function calendarCells(rows, days = 28, now = Date.now()) {
  const n = Math.min(120, Math.max(1, Number(days) || 28));
  const byDay = new Map();
  for (const r of (rows || [])) {
    const target = String((r && r.day) || '');
    if (target) byDay.set(target, r);
  }
  const today = dayKey(now);
  const cells = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    const row = byDay.get(day) || null;
    cells.push({
      day: day,
      done: !!row,
      slug: row ? String(row.slug || '') : '',
      makeup: row ? !!Number(row.makeup) : false,
      today: i === 0,
      doneDay: row ? String(row.done_day || row.day || '') : ''
    });
  }
  return cells;
}
