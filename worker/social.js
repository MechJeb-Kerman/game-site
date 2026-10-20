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

/* ================= 第七批：社交图谱（关注 / 站内通知 / 私信） =================
 * 与 src/social.js 一一对应：同名同参同返回，这边多一个 db 参数、全程 await。
 * 三张表见 worker/schema.js 末尾的 DDL（migrations/0007_social_graph.sql 是同一份内容）。
 */

/** 通知 kind 白名单：不在里面的不落库 */
export const NOTIFY_KINDS = ['reply', 'mention', 'follow', 'message', 'comment', 'system'];
/** 通知正文 ≤ 200 字符，私信正文 ≤ 1000 字符 */
export const NOTIFY_MAX = 200;
export const MESSAGE_MAX = 1000;
/** 同一 (user_id, kind, actor_id, target_type, target_id) 在 10 分钟内只写一条 */
const NOTIFY_WINDOW_MINUTES = 10;
/** @提及：@ 后跟 3..20 位 [A-Za-z0-9_-]，一条内容最多认 5 个 */
const MENTION_RE = /@([A-Za-z0-9_-]{3,20})(?![A-Za-z0-9_-])/g;
const MENTION_MAX = 5;
/** 关注列表一页最多 50 条，私信一页最多 100 条 */
const LIST_MAX = 50;
const THREAD_MAX = 100;

/** 折叠空白并截断：通知正文、标题片段都走它 */
function flat(text, max) {
  return String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 展示名：没设 display_name 就退回用户名 */
function nameOf(row) {
  return String((row && (row.display_name || row.username)) || '');
}

/** users 的一行小档案；没有这个人返回 null */
async function userBrief(db, id) {
  return await one(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [Number(id) || 0]);
}

/* ---------- 关注：互相关注即好友，不另建表 ---------- */

/**
 * 关注一个人。自己关注自己 → self_follow，任一方不存在 → no_user，重复关注幂等。
 * 返回的 following / followers 是**被关注者**的口径（个人主页上那两个数字）。
 * @returns {{ok:true, following:number, followers:number}|{error:string}}
 */
export async function follow(db, userId, targetId) {
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return { error: 'no_user' };
  if (uid === tid) return { error: 'self_follow' };
  if (!(await userBrief(db, uid)) || !(await userBrief(db, tid))) return { error: 'no_user' };
  await stmt(db, 'INSERT OR IGNORE INTO follows (user_id, followee_id) VALUES (?, ?)', [uid, tid]).run();
  const c = await followCounts(db, tid);
  return { ok: true, following: c.following, followers: c.followers };
}

/** 取关：没关注过也算成功（幂等）；返回口径同 follow */
export async function unfollow(db, userId, targetId) {
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return { error: 'no_user' };
  await stmt(db, 'DELETE FROM follows WHERE user_id = ? AND followee_id = ?', [uid, tid]).run();
  const c = await followCounts(db, tid);
  return { ok: true, following: c.following, followers: c.followers };
}

/** 我有没有关注这个人（没登录 / 自己 / 不存在都算 false） */
export async function isFollowing(db, userId, targetId) {
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return false;
  return !!(await one(db, 'SELECT 1 AS x FROM follows WHERE user_id = ? AND followee_id = ?', [uid, tid]));
}

/** 关注数 / 粉丝数 / 好友数（好友 = 互相关注，不另存表） */
export async function followCounts(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return { followers: 0, following: 0, friends: 0 };
  return {
    followers: await count(db, 'SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [uid]),
    following: await count(db, 'SELECT COUNT(*) AS n FROM follows WHERE user_id = ?', [uid]),
    friends: await count(
      db,
      'SELECT COUNT(*) AS n FROM follows a JOIN follows b ' +
        'ON b.user_id = a.followee_id AND b.followee_id = a.user_id WHERE a.user_id = ?',
      [uid]
    )
  };
}

/**
 * 关注 / 粉丝 / 好友列表。
 * kind：followers（谁关注我）/ following（我关注了谁）/ friends（互关）；
 * mutual = 我和这一行是不是互相关注，since = 关注时间（好友取后发生的那一次）。
 * kind 不认识或 userId 为空 → 空列表（路由上当没有）。
 */
export async function followList(db, userId, kind, opts = {}) {
  const uid = Number(userId) || 0;
  const k = String(kind || '');
  const limit = Math.min(Math.max(Number(opts.limit) || 24, 1), LIST_MAX);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  if (!uid || (k !== 'followers' && k !== 'following' && k !== 'friends')) return { total: 0, items: [] };

  let cols;
  let from;
  let where;
  let order;
  let args;      // SELECT 用（含 mutual 子查询里的那个 ?）
  let countArgs; // COUNT 只用 WHERE 的
  if (k === 'followers') {
    cols = 'u.id, u.username, u.display_name, f.created_at AS since, ' +
      'EXISTS (SELECT 1 FROM follows m WHERE m.user_id = ? AND m.followee_id = u.id) AS mutual';
    from = 'FROM follows f JOIN users u ON u.id = f.user_id';
    where = 'f.followee_id = ?';
    order = 'f.created_at DESC, u.id DESC';
    args = [uid, uid];
    countArgs = [uid];
  } else if (k === 'following') {
    cols = 'u.id, u.username, u.display_name, f.created_at AS since, ' +
      'EXISTS (SELECT 1 FROM follows m WHERE m.user_id = u.id AND m.followee_id = ?) AS mutual';
    from = 'FROM follows f JOIN users u ON u.id = f.followee_id';
    where = 'f.user_id = ?';
    order = 'f.created_at DESC, u.id DESC';
    args = [uid, uid];
    countArgs = [uid];
  } else {
    cols = 'u.id, u.username, u.display_name, ' +
      'CASE WHEN f.created_at > g.created_at THEN f.created_at ELSE g.created_at END AS since, 1 AS mutual';
    from = 'FROM follows f JOIN follows g ON g.user_id = f.followee_id AND g.followee_id = f.user_id ' +
      'JOIN users u ON u.id = f.followee_id';
    where = 'f.user_id = ?';
    order = 'since DESC, u.id DESC';
    args = [uid];
    countArgs = [uid];
  }
  const total = await count(db, 'SELECT COUNT(*) AS n ' + from + ' WHERE ' + where, countArgs);
  const res = await stmt(
    db,
    'SELECT ' + cols + ' ' + from + ' WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?',
    args.concat([limit, offset])
  ).all();
  return {
    total: total,
    items: ((res && res.results) || []).map((r) => ({
      id: Number(r.id),
      username: r.username,
      displayName: nameOf(r),
      since: r.since || '',
      mutual: !!Number(r.mutual)
    }))
  };
}

/* ---------- 站内通知 ---------- */

/**
 * 写一条站内通知。三种情况不写：kind 不在白名单（bad_kind）、自己给自己（self）、
 * 同一 (user_id, kind, actor_id, target_type, target_id) 10 分钟内已有（dup）。
 * body 折叠空白后截到 200 字符；actorId 缺省记 0（系统通知）。
 * @returns {{id:number}|{skipped:string}}
 */
export async function notify(db, userId, { kind, actorId = 0, targetType = '', targetId = '', body = '' } = {}) {
  const uid = Number(userId) || 0;
  const k = String(kind || '');
  const actor = Number(actorId) || 0;
  const tt = String(targetType || '');
  const tid = String(targetId || '');
  if (!uid) return { skipped: 'no_user' };
  if (NOTIFY_KINDS.indexOf(k) < 0) return { skipped: 'bad_kind' };
  if (actor && actor === uid) return { skipped: 'self' };
  const dup = await one(
    db,
    'SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND actor_id = ? ' +
      'AND target_type = ? AND target_id = ? ' +
      "AND created_at >= datetime('now','localtime','-" + NOTIFY_WINDOW_MINUTES + " minutes')",
    [uid, k, actor, tt, tid]
  );
  if (dup) return { skipped: 'dup' };
  const info = await stmt(
    db,
    'INSERT INTO notifications (user_id, kind, actor_id, target_type, target_id, body) VALUES (?, ?, ?, ?, ?, ?)',
    [uid, k, actor, tt, tid, flat(body, NOTIFY_MAX)]
  ).run();
  return { id: Number((info && info.meta && info.meta.last_row_id) || 0) };
}

/**
 * 从正文里抠出 @用户名：去重（不区分大小写，保留原写法），最多 5 个。
 * 邮箱（user@host 这种）不算：@ 前面紧挨着字母/数字/._- 的一律跳过。
 * @returns {string[]}
 */
export function extractMentions(text) {
  const src = String(text === null || text === undefined ? '' : text);
  const out = [];
  const seen = new Set();
  MENTION_RE.lastIndex = 0;
  let m = MENTION_RE.exec(src);
  while (m) {
    const prev = m.index > 0 ? src.charAt(m.index - 1) : '';
    if (!prev || !/[A-Za-z0-9_.\-]/.test(prev)) {
      const key = m[1].toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(m[1]);
        if (out.length >= MENTION_MAX) break;
      }
    }
    m = MENTION_RE.exec(src);
  }
  return out;
}

/**
 * 把正文里的 @提及 逐个落成 kind=mention 通知（用户名要真实存在，COLLATE NOCASE 查）。
 * 自己 @ 自己、10 分钟内重复的由 notify 挡掉，不计入返回条数。
 * @returns {number} 实际写了几条
 */
export async function notifyMentions(db, { actorId = 0, text = '', targetType = '', targetId = '', body = '' } = {}) {
  const actor = Number(actorId) || 0;
  const names = extractMentions(text);
  let wrote = 0;
  for (const name of names) {
    const u = await one(db, 'SELECT id FROM users WHERE username = ? COLLATE NOCASE', [name]);
    if (!u) continue;
    const r = await notify(db, u.id, {
      kind: 'mention',
      actorId: actor,
      targetType: targetType,
      targetId: targetId,
      body: body || text
    });
    if (r.id) wrote++;
  }
  return wrote;
}

/**
 * 通知列表（最新的在前）。
 * total 是**当前筛选下**的条数（unreadOnly 时就是未读数），unread 恒为未读总数。
 */
export async function listNotifications(db, userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 20, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, unread: 0, items: [] };
  const unread = await unreadCount(db, uid);
  const where = 'n.user_id = ?' + (unreadOnly ? ' AND n.read_at IS NULL' : '');
  const total = await count(db, 'SELECT COUNT(*) AS n FROM notifications n WHERE ' + where, [uid]);
  const res = await stmt(
    db,
    'SELECT n.id, n.kind, n.body, n.actor_id, n.target_type, n.target_id, n.read_at, n.created_at, ' +
      'u.username, u.display_name FROM notifications n LEFT JOIN users u ON u.id = n.actor_id ' +
      'WHERE ' + where + ' ORDER BY n.id DESC LIMIT ? OFFSET ?',
    [uid, size, skip]
  ).all();
  return {
    total: total,
    unread: unread,
    items: ((res && res.results) || []).map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      body: r.body || '',
      actorId: Number(r.actor_id) || 0,
      actorName: Number(r.actor_id) ? nameOf(r) : '',
      targetType: r.target_type || '',
      targetId: r.target_id || '',
      read: !!r.read_at,
      createdAt: r.created_at || ''
    }))
  };
}

/** 未读通知数（导航栏角标用） */
export async function unreadCount(db, userId) {
  const uid = Number(userId) || 0;
  return uid ? await count(db, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [uid]) : 0;
}

/**
 * 标记已读：id = 0 表示该用户全部已读；给了 id 就只能改自己的（别人的返回 ok:false）。
 * @returns {{ok:boolean, unread:number}}
 */
export async function markRead(db, userId, id = 0) {
  const uid = Number(userId) || 0;
  const nid = Number(id) || 0;
  if (!uid) return { ok: false, unread: 0 };
  if (!nid) {
    await stmt(db, "UPDATE notifications SET read_at = datetime('now','localtime') WHERE user_id = ? AND read_at IS NULL", [uid]).run();
    return { ok: true, unread: 0 };
  }
  const mine = await one(db, 'SELECT id FROM notifications WHERE id = ? AND user_id = ?', [nid, uid]);
  if (!mine) return { ok: false, unread: await unreadCount(db, uid) };
  await stmt(db, "UPDATE notifications SET read_at = datetime('now','localtime') WHERE id = ? AND user_id = ?", [nid, uid]).run();
  return { ok: true, unread: await unreadCount(db, uid) };
}

/* ---------- 私信 ---------- */

/**
 * 发一条私信：正文去首尾空白后 1..1000 字符；不能发给自己；收件人不认识 / 被封禁都拒绝。
 * 这里**不写** kind=message 的通知（留给上层调 notify，免得数据层到处写通知）。
 * @returns {{ok:true, id:number}|{error:string}} error: empty / too_long / self / no_user / banned
 */
export async function sendMessage(db, fromId, toId, body) {
  const fid = Number(fromId) || 0;
  const tid = Number(toId) || 0;
  const text = String(body === null || body === undefined ? '' : body).trim();
  if (!text) return { error: 'empty' };
  if (text.length > MESSAGE_MAX) return { error: 'too_long' };
  if (!fid || !tid) return { error: 'no_user' };
  if (!(await userBrief(db, fid)) || !(await userBrief(db, tid))) return { error: 'no_user' };
  if (fid === tid) return { error: 'self' };
  const to = await one(db, 'SELECT banned FROM users WHERE id = ?', [tid]);
  if (to && Number(to.banned)) return { error: 'banned' };
  const info = await stmt(db, 'INSERT INTO messages (from_id, to_id, body) VALUES (?, ?, ?)', [fid, tid, text]).run();
  return { ok: true, id: Number((info && info.meta && info.meta.last_row_id) || 0) };
}

/**
 * 会话列表：每个聊过的人一行，带最后一条消息与未读数。
 * outgoing = 最后一条是不是我发的；total = 会话数（不是消息数）。最新聊的排前面。
 */
export async function listMessageThreads(db, userId, { limit = 24, offset = 0 } = {}) {
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 24, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, items: [] };
  const total = await count(
    db,
    'SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM messages WHERE from_id = ? OR to_id = ? ' +
      'GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)',
    [uid, uid, uid]
  );
  const res = await stmt(
    db,
    'SELECT peer, MAX(id) AS last_id, SUM(CASE WHEN to_id = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread ' +
      'FROM (SELECT id, from_id, to_id, read_at, CASE WHEN from_id = ? THEN to_id ELSE from_id END AS peer ' +
      'FROM messages WHERE from_id = ? OR to_id = ?) ' +
      'GROUP BY peer ORDER BY last_id DESC LIMIT ? OFFSET ?',
    [uid, uid, uid, uid, size, skip]
  ).all();
  const rows = (res && res.results) || [];
  if (!rows.length) return { total: total, items: [] };

  const lastIds = rows.map((r) => Number(r.last_id));
  const lastRes = await stmt(
    db,
    'SELECT id, from_id, body, created_at FROM messages WHERE id IN (' + lastIds.map(() => '?').join(',') + ')',
    lastIds
  ).all();
  const lastOf = new Map((((lastRes && lastRes.results) || [])).map((r) => [Number(r.id), r]));

  const peerIds = rows.map((r) => Number(r.peer));
  const userRes = await stmt(
    db,
    'SELECT id, username, display_name FROM users WHERE id IN (' + peerIds.map(() => '?').join(',') + ')',
    peerIds
  ).all();
  const nameById = new Map((((userRes && userRes.results) || [])).map((u) => [Number(u.id), nameOf(u)]));

  return {
    total: total,
    items: rows.map((r) => {
      const last = lastOf.get(Number(r.last_id)) || {};
      return {
        peerId: Number(r.peer),
        peerName: nameById.get(Number(r.peer)) || '',
        lastBody: last.body || '',
        lastAt: last.created_at || '',
        unread: Number(r.unread) || 0,
        outgoing: Number(last.from_id) === uid
      };
    })
  };
}

/**
 * 一段会话的消息。按 id 倒序（最新在前）；翻页用 before = 上一页最后一条的 id（0 表示从头取）。
 * total 是这段会话的**全部**条数，不是本页条数。
 */
export async function threadMessages(db, userId, peerId, { limit = 30, before = 0 } = {}) {
  const uid = Number(userId) || 0;
  const pid = Number(peerId) || 0;
  const size = Math.min(Math.max(Number(limit) || 30, 1), THREAD_MAX);
  const cursor = Math.max(Number(before) || 0, 0);
  const who = pid ? await userBrief(db, pid) : null;
  const peer = { id: pid, username: who ? who.username : '', displayName: nameOf(who) };
  if (!uid || !pid) return { total: 0, items: [], peer: peer };
  const total = await count(
    db,
    'SELECT COUNT(*) AS n FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    [uid, pid, pid, uid]
  );
  const args = [uid, pid, pid, uid];
  let where = 'WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))';
  if (cursor) { where += ' AND id < ?'; args.push(cursor); }
  const res = await stmt(
    db,
    'SELECT id, from_id, body, created_at FROM messages ' + where + ' ORDER BY id DESC LIMIT ?',
    args.concat([size])
  ).all();
  return {
    total: total,
    items: ((res && res.results) || []).map((r) => ({
      id: Number(r.id),
      fromId: Number(r.from_id),
      body: r.body || '',
      createdAt: r.created_at || '',
      mine: Number(r.from_id) === uid
    })),
    peer: peer
  };
}

/** 把某个人发给我的、还没读的私信全部标成已读；read = 这次改了几条 */
export async function markThreadRead(db, userId, peerId) {
  const uid = Number(userId) || 0;
  const pid = Number(peerId) || 0;
  if (!uid || !pid) return { ok: false, read: 0 };
  const info = await stmt(
    db,
    "UPDATE messages SET read_at = datetime('now','localtime') WHERE to_id = ? AND from_id = ? AND read_at IS NULL",
    [uid, pid]
  ).run();
  return { ok: true, read: Number((info && info.meta && info.meta.changes) || 0) };
}

/* ---------- 论坛 / 评论动作的可选钩子（worker/app.js 在动作成功后调，数据层不自己触发） ---------- */

/**
 * 回复主题后补通知：楼主收一条 kind=reply，正文里 @ 到的人各收一条 kind=mention。
 * 自己回自己的主题不产生 reply 通知（notify 的 self 规则兜底），但 @ 到别人照样通知。
 * targetId 形如 12#p34：主对象是主题 12，# 后是这一楼（直接拼 URL 时浏览器会把它当锚点）；
 * 只要纯 id 就 String(targetId).split('#')[0]。
 * @returns {{id:number, skipped:string, mentioned:number}}
 */
export async function notifyReply(db, { actorId = 0, threadId = 0, threadTitle = '', ownerId = 0, postId = 0, body = '' } = {}) {
  const actor = Number(actorId) || 0;
  const tid = Number(threadId) || 0;
  const targetId = String(tid) + (postId ? '#p' + (Number(postId) || 0) : '');
  const title = flat(threadTitle, 60);
  const text = flat(body, NOTIFY_MAX);
  const r = await notify(db, ownerId, {
    kind: 'reply',
    actorId: actor,
    targetType: 'thread',
    targetId: targetId,
    body: (title ? '回复了你的主题《' + title + '》：' : '回复了你的主题：') + text
  });
  const mentioned = await notifyMentions(db, { actorId: actor, text: body, targetType: 'thread', targetId: targetId, body: text });
  return { id: r.id || 0, skipped: r.skipped || '', mentioned: mentioned };
}

/**
 * 游戏 / 公告评论后补通知：被评论对象的作者收一条 kind=comment（自己评自己的不写），
 * 正文里 @ 到的人各收一条 kind=mention。
 * targetId 形如 snake#c34：主对象是游戏 slug，# 后是评论 id。
 * @returns {{id:number, skipped:string, mentioned:number}}
 */
export async function notifyComment(db, { actorId = 0, gameSlug = '', ownerId = 0, commentId = 0, body = '' } = {}) {
  const actor = Number(actorId) || 0;
  const slug = String(gameSlug || '').trim();
  const targetId = slug + (commentId ? '#c' + (Number(commentId) || 0) : '');
  const text = flat(body, NOTIFY_MAX);
  const r = await notify(db, ownerId, {
    kind: 'comment',
    actorId: actor,
    targetType: 'game',
    targetId: targetId,
    body: '评论了你的作品：' + text
  });
  const mentioned = await notifyMentions(db, { actorId: actor, text: body, targetType: 'game', targetId: targetId, body: text });
  return { id: r.id || 0, skipped: r.skipped || '', mentioned: mentioned };
}

