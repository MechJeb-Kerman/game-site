/**
 * 账号社交数据（Express / node:sqlite 版）：个人主页统计、每日挑战落库、徽章来源。
 * 与 worker/social.js 一一对应，那边每个函数第一个参数是 D1 绑定、全程 await。
 */
import { db } from './db.js';
import { dayKey, pickDaily, streakOf } from './daily.js';
import { badgesOf, levelOf, titleOf } from './badges.js';
import { listGames } from './data.js';

const one = (sql, ...args) => Number((db.prepare(sql).get(...args) || {}).n || 0);

/** 今天（服务器日界）的挑战游戏 slug */
export function dailySlug(day = dayKey()) {
  return pickDaily(day, listGames({ limit: 500 }));
}

/** 每日挑战的进度：今天做了没、累计几次、连续几天 */
export function dailyStats(userId, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) return { day: day, slug: dailySlug(day), total: 0, streak: 0, doneToday: false, done: [] };
  const rows = db.prepare('SELECT day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(uid).map((r) => String(r.day));
  const days = new Set(rows);
  return {
    day: day,
    slug: dailySlug(day),
    total: one('SELECT COUNT(*) n FROM daily_results WHERE user_id = ?', uid),
    streak: streakOf(rows, now),
    doneToday: days.has(day),
    done: rows.slice(0, 60)
  };
}

/**
 * 记一次每日挑战完成（当天已记过就跳过——UNIQUE(day,user_id) 兜底）。
 * fresh=true 表示这一次是新记上的（页面据此显示「打卡成功」）。
 */
export function markDaily(userId, slug, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) return { fresh: false, day: day };
  if (String(slug) !== dailySlug(day)) return { fresh: false, day: day };
  const info = db
    .prepare('INSERT OR IGNORE INTO daily_results (day, user_id, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(day, uid, String(slug), now);
  return { fresh: !!info.changes, day: day };
}

/** 一个账号的全部统计：徽章、等级、个人主页都用它 */
export function statsOf(userId) {
  const uid = Number(userId) || 0;
  const u = uid ? db.prepare('SELECT id, username, display_name, role, email_verified, created_at FROM users WHERE id = ?').get(uid) : null;
  if (!u) return null;
  const daily = dailyStats(uid);
  const born = Date.parse(String(u.created_at || '').replace(' ', 'T'));
  const days = Number.isFinite(born) ? Math.max(0, Math.floor((Date.now() - born) / 86400000)) : 0;
  return {
    id: Number(u.id),
    username: u.username,
    name: u.display_name || u.username,
    role: u.role || 'user',
    comments: one('SELECT COUNT(*) n FROM comments WHERE user_id = ? AND status = 1', uid),
    favorites: one('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', uid),
    ratings: one('SELECT COUNT(*) n FROM ratings WHERE visitor = ?', String(uid)),
    threads: one('SELECT COUNT(*) n FROM forum_threads WHERE user_id = ? AND status = 1', uid),
    replies: one('SELECT COUNT(*) n FROM forum_posts WHERE user_id = ? AND status = 1', uid),
    submitted: one('SELECT COUNT(*) n FROM games WHERE submitted_by = ?', uid),
    published: one('SELECT COUNT(*) n FROM games WHERE submitted_by = ? AND status = 1', uid),
    verified: Number(u.email_verified) ? 1 : 0,
    days: days,
    daily: daily.total,
    streak: daily.streak,
    doneToday: daily.doneToday,
    joinedAt: u.created_at || ''
  };
}

/** 带徽章与等级的完整档案（个人主页 + 后台用） */
export function profileOf(userId) {
  const stats = statsOf(userId);
  if (!stats) return null;
  const level = levelOf(stats);
  return Object.assign({}, stats, {
    badges: badgesOf(stats),
    badgesOwned: badgesOf(stats).filter((b) => b.done).length,
    level: level.level,
    xp: level.xp,
    xpFloor: level.floor,
    xpNext: level.next,
    xpNeed: level.need,
    title: titleOf(level.level)
  });
}

/** 按用户名找档案（个人主页路由用；用户名不区分大小写） */
export function profileByName(name) {
  const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String(name || '').trim());
  return row ? profileOf(row.id) : null;
}

/** 最近完成每日挑战的人（每日挑战页显示「今天已有 N 人打卡」） */
export function dailyBoard(day = dayKey(), limit = 12) {
  const rows = db
    .prepare('SELECT u.username, u.display_name, d.created_at FROM daily_results d JOIN users u ON u.id = d.user_id WHERE d.day = ? ORDER BY d.created_at ASC LIMIT ?')
    .all(day, limit);
  return { count: one('SELECT COUNT(*) n FROM daily_results WHERE day = ?', day), rows: rows.map((r) => ({ username: r.username, name: r.display_name || r.username })) };
}
