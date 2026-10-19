/**
 * 成就徽章（服务端可验证版）。
 *
 * 这里只放纯函数：徽章清单、按统计算徽章、按统计算等级。数据库那半边在
 * src/social.js（Express）与 worker/social.js（D1）里，两条线共用这一份定义。
 *
 * 刻意**不做**联机对局胜负类成就：房间的 result 是客户端声明后照单转发的
 * （服务端不判棋，见 src/play.js 顶部说明），拿它发徽章等于谁都能自己刷。
 */

/** 徽章清单：stat 是 src/social.js 里 statsOf() 的字段名 */
export const BADGES = [
  { id: 'say-first', icon: '💬', name: '开口第一句', desc: '发表 1 条评论', stat: 'comments', need: 1 },
  { id: 'talker-10', icon: '🗣️', name: '话匣子', desc: '发表 10 条评论', stat: 'comments', need: 10 },
  { id: 'talker-50', icon: '📣', name: '金句频出', desc: '发表 50 条评论', stat: 'comments', need: 50 },
  { id: 'collector-5', icon: '📁', name: '小收藏家', desc: '收藏 5 款游戏', stat: 'favorites', need: 5 },
  { id: 'collector-20', icon: '⭐', name: '私藏库', desc: '收藏 20 款游戏', stat: 'favorites', need: 20 },
  { id: 'rater-5', icon: '🌟', name: '打分员', desc: '给 5 款游戏评分', stat: 'ratings', need: 5 },
  { id: 'thread-first', icon: '🧵', name: '第一次发帖', desc: '在论坛发 1 个主题', stat: 'threads', need: 1 },
  { id: 'thread-10', icon: '📌', name: '论坛常客', desc: '在论坛发 10 个主题', stat: 'threads', need: 10 },
  { id: 'reply-50', icon: '✍️', name: '盖楼大王', desc: '论坛回帖 50 条', stat: 'replies', need: 50 },
  { id: 'daily-first', icon: '📅', name: '今日打卡', desc: '完成 1 次每日挑战', stat: 'daily', need: 1 },
  { id: 'daily-30', icon: '🗓️', name: '月度全勤', desc: '累计完成 30 次每日挑战', stat: 'daily', need: 30 },
  { id: 'streak-7', icon: '🔥', name: '七日之火', desc: '连续 7 天完成每日挑战', stat: 'streak', need: 7 },
  { id: 'mail-ok', icon: '📧', name: '邮箱已验证', desc: '完成邮箱验证', stat: 'verified', need: 1 },
  { id: 'veteran-30', icon: '🕰️', name: '老玩家', desc: '注册满 30 天', stat: 'days', need: 30 },
  { id: 'author', icon: '🎁', name: '投稿者', desc: '提交 1 款游戏', stat: 'submitted', need: 1 },
  { id: 'published', icon: '🚀', name: '作者认证', desc: '提交的游戏被收录上架', stat: 'published', need: 1 }
];

/** 每个统计项的权重（算经验值用） */
const XP = {
  comments: 5, favorites: 3, ratings: 5, threads: 10, replies: 3,
  daily: 20, streak: 10, verified: 10, days: 1, submitted: 20, published: 50
};

/** 按统计算徽章：返回全部徽章（含未拿到的进度），已拿到的排在前面 */
export function badgesOf(stats) {
  const s = stats || {};
  const rows = BADGES.map((b) => {
    const now = Math.min(Number(s[b.stat] || 0), b.need);
    return { id: b.id, icon: b.icon, name: b.name, desc: b.desc, need: b.need, now: now, done: now >= b.need };
  });
  return rows.sort((a, b) => (b.done ? 1 : 0) - (a.done ? 1 : 0) || (b.now / b.need) - (a.now / a.need));
}

/** 已拿到的徽章数 */
export function badgeCount(stats) {
  return badgesOf(stats).filter((b) => b.done).length;
}

/** 升到 level 需要的经验（1 级 0、2 级 100、3 级 300、4 级 600……） */
export function xpFor(level) {
  const n = Math.max(1, Number(level) || 1);
  return 50 * (n - 1) * n;
}

/** 按统计算经验与等级 */
export function levelOf(stats) {
  const s = stats || {};
  let xp = 0;
  for (const key of Object.keys(XP)) xp += Number(s[key] || 0) * XP[key];
  let level = 1;
  while (level < 99 && xp >= xpFor(level + 1)) level++;
  return { xp: xp, level: level, floor: xpFor(level), next: xpFor(level + 1), need: Math.max(0, xpFor(level + 1) - xp) };
}

/** 等级称号 */
export function titleOf(level) {
  const n = Number(level) || 1;
  if (n >= 12) return '骨灰级玩家';
  if (n >= 8) return '资深玩家';
  if (n >= 5) return '老玩家';
  if (n >= 3) return '常客';
  if (n >= 2) return '熟面孔';
  return '新面孔';
}
