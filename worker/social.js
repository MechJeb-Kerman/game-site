/**
 * 账号社交数据（Cloudflare Workers + D1 版）。
 * 与 src/social.js 一一对应：那边用同步 SQL，这里第一个参数是 D1 绑定、全程 await，
 * 统计口径务必保持一致（comments/threads/replies 只数 status = 1，ratings 认 visitor = 用户 id）。
 */
import { dayKey, pickDaily, streakOf } from '../src/daily.js';
import { badgesOf, levelOf, titleOf } from '../src/badges.js';
import { listGames } from './data.js';

function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

async function one(db, sql, params) {
  return (await stmt(db, sql, params).first()) || null;
}

async function count(db, sql, params) {
  const r = await one(db, sql, params);
  return Number((r && r.n) || 0);
}

/** 今天（服务器日界）的挑战游戏 slug */
export async function dailySlug(db, day = dayKey()) {
  const list = await listGames(db, { limit: 500 });
  return pickDaily(day, (list && list.items) || list || []);
}

/** 每日挑战的进度：今天做了没、累计几次、连续几天 */
export async function dailyStats(db, userId, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) return { day: day, slug: await dailySlug(db, day), total: 0, streak: 0, doneToday: false, done: [] };
  const res = await stmt(db, 'SELECT day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 400', [uid]).all();
  const rows = ((res && res.results) || []).map((r) => String(r.day));
  return {
    day: day,
    slug: await dailySlug(db, day),
    total: await count(db, 'SELECT COUNT(*) AS n FROM daily_results WHERE user_id = ?', [uid]),
    streak: streakOf(rows, now),
    doneToday: rows.indexOf(day) >= 0,
    done: rows.slice(0, 60)
  };
}

/**
 * 记一次每日挑战完成（当天已记过就跳过——UNIQUE(day,user_id) 兜底）。
 * fresh=true 表示这一次是新记上的（页面据此显示「打卡成功」）。
 */
export async function markDaily(db, userId, slug, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) return { fresh: false, day: day };
  if (String(slug) !== (await dailySlug(db, day))) return { fresh: false, day: day };
  const info = await db
    .prepare('INSERT OR IGNORE INTO daily_results (day, user_id, slug, created_at) VALUES (?, ?, ?, ?)')
    .bind(day, uid, String(slug), now)
    .run();
  return { fresh: !!(info && info.meta && info.meta.changes), day: day };
}

/** 一个账号的全部统计：徽章、等级、个人主页都用它 */
export async function statsOf(db, userId) {
  const uid = Number(userId) || 0;
  const u = uid
    ? await one(db, 'SELECT id, username, display_name, role, email_verified, created_at FROM users WHERE id = ?', [uid])
    : null;
  if (!u) return null;
  const daily = await dailyStats(db, uid);
  const born = Date.parse(String(u.created_at || '').replace(' ', 'T'));
  const days = Number.isFinite(born) ? Math.max(0, Math.floor((Date.now() - born) / 86400000)) : 0;
  return {
    id: Number(u.id),
    username: u.username,
    name: u.display_name || u.username,
    role: u.role || 'user',
    comments: await count(db, 'SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND status = 1', [uid]),
    favorites: await count(db, 'SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', [uid]),
    ratings: await count(db, 'SELECT COUNT(*) AS n FROM ratings WHERE visitor = ?', [String(uid)]),
    threads: await count(db, 'SELECT COUNT(*) AS n FROM forum_threads WHERE user_id = ? AND status = 1', [uid]),
    replies: await count(db, 'SELECT COUNT(*) AS n FROM forum_posts WHERE user_id = ? AND status = 1', [uid]),
    submitted: await count(db, 'SELECT COUNT(*) AS n FROM games WHERE submitted_by = ?', [uid]),
    published: await count(db, 'SELECT COUNT(*) AS n FROM games WHERE submitted_by = ? AND status = 1', [uid]),
    verified: Number(u.email_verified) ? 1 : 0,
    days: days,
    daily: daily.total,
    streak: daily.streak,
    doneToday: daily.doneToday,
    joinedAt: u.created_at || ''
  };
}

/** 带徽章与等级的完整档案（个人主页 + 后台用） */
export async function profileOf(db, userId) {
  const stats = await statsOf(db, userId);
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
export async function profileByName(db, name) {
  const row = await one(db, 'SELECT id FROM users WHERE username = ? COLLATE NOCASE', [String(name || '').trim()]);
  return row ? profileOf(db, row.id) : null;
}

/** 最近完成每日挑战的人（每日挑战页显示「今天已有 N 人打卡」） */
export async function dailyBoard(db, day = dayKey(), limit = 12) {
  const res = await stmt(
    db,
    'SELECT u.username, u.display_name, d.created_at FROM daily_results d JOIN users u ON u.id = d.user_id WHERE d.day = ? ORDER BY d.created_at ASC LIMIT ?',
    [day, limit]
  ).all();
  return {
    count: await count(db, 'SELECT COUNT(*) AS n FROM daily_results WHERE day = ?', [day]),
    rows: ((res && res.results) || []).map((r) => ({ username: r.username, name: r.display_name || r.username }))
  };
}
