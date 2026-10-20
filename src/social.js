/**
 * 账号社交数据（Express / node:sqlite 版）：个人主页统计、每日挑战落库、徽章来源。
 * 与 worker/social.js 一一对应，那边每个函数第一个参数是 D1 绑定、全程 await。
 */
import { db } from './db.js';
import { dayKey, pickDaily, streakOf, makeupCheck, calendarCells, monthPerfect } from './daily.js';
import { badgesOf, levelOf, titleOf } from './badges.js';
import { listGames } from './data.js';

const one = (sql, ...args) => Number((db.prepare(sql).get(...args) || {}).n || 0);

/** 今天（服务器日界）的挑战游戏 slug */
export function dailySlug(day = dayKey()) {
  return pickDaily(day, listGames({ limit: 500 }));
}

/* ================= 第八批：全勤日历 / 补做 =================
 * 与 worker/social.js 一一对应：同名同参同返回，那边多一个 db 参数、全程 await。
 * daily_results 要多两列（makeup / done_day）。src/db.js 的 migrate() 本次不许动，
 * 所以照 ensureSocial 的思路在第一次用到时幂等补列——migrations/0006_social.sql 头部注释
 * 说的就是这个坑：迁移文件里只放「建表 / 建索引」，补列交给运行时 ALTER，两边才不会打架。
 * 口径（窗口多长、连续天数认不认补做）写在 src/daily.js 第八批那一段。
 */

const dailyReady = new WeakSet();

/** 幂等补 daily_results 的两列（按库对象各记一次：测试里一个进程可能开好几个临时库） */
function ensureDaily() {
  if (dailyReady.has(db)) return;
  const cols = db.prepare('PRAGMA table_info(daily_results)').all().map((c) => String(c.name));
  if (!cols.includes('makeup')) db.exec('ALTER TABLE daily_results ADD COLUMN makeup INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('done_day')) db.exec("ALTER TABLE daily_results ADD COLUMN done_day TEXT NOT NULL DEFAULT ''");
  dailyReady.add(db);
}

/** 最近 N 天的全勤日历（含今天，按时间正序）；未登录给一份全 false 的格子 */
export function dailyCalendar(userId, days = 28, now = Date.now()) {
  const uid = Number(userId) || 0;
  const n = Math.min(120, Math.max(1, Number(days) || 28));
  const today = dayKey(now);
  if (!uid) return { day: today, today: null, cells: calendarCells([], n, now) };
  ensureDaily();
  const rows = db.prepare('SELECT day, slug, makeup, done_day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 200').all(uid);
  return { day: today, today: rows.find((r) => String(r.day) === today) || null, cells: calendarCells(rows, n, now) };
}

/** 月度全勤：month = 'YYYY-MM'（缺省 / 不合法 = 当前月）；补做也算完成，口径见 src/daily.js */
export function monthlyPerfect(userId, month = '', now = Date.now()) {
  const uid = Number(userId) || 0;
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  const label = m ? m[1] + '-' + m[2] : dayKey(now).slice(0, 7);
  if (!uid) return monthPerfect(label, [], now);
  ensureDaily();
  const rows = db.prepare('SELECT day FROM daily_results WHERE user_id = ? AND day LIKE ?').all(uid, label + '-%');
  return monthPerfect(label, rows.map((r) => String(r.day)), now);
}

/**
 * 每日挑战的进度：今天做了没、累计几次、连续几天。
 * 第八批只加字段、不改口径：total / done / doneToday 数「目标日」有没有记录（补做也算完成），
 * streak 只数自然打卡（补做不续连续），done 还是最近 60 个目标日。
 * 新增：calendar（28 天格子）、perfect（当月全勤）、makeupUsed（补做次数）、
 *       makeup（最近一次补做）、doneRows（目标日 + 是否补做 + 实际完成日）。
 */
export function dailyStats(userId, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) {
    return {
      day: day,
      slug: dailySlug(day),
      total: 0,
      streak: 0,
      doneToday: false,
      done: [],
      calendar: dailyCalendar(0, 28, now),
      perfect: monthlyPerfect(0, '', now),
      makeupUsed: 0,
      makeup: { day: '', slug: '', makeup: false, doneDay: '' },
      doneRows: []
    };
  }
  ensureDaily();
  const rows = db.prepare('SELECT day, slug, makeup, done_day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(uid);
  const targets = rows.map((r) => String(r.day));
  const days = new Set(targets);
  const natural = rows.filter((r) => !Number(r.makeup)).map((r) => String(r.day));
  const made = rows.filter((r) => Number(r.makeup));
  return {
    day: day,
    slug: dailySlug(day),
    total: one('SELECT COUNT(*) n FROM daily_results WHERE user_id = ?', uid),
    streak: streakOf(natural, now),
    doneToday: days.has(day),
    done: targets.slice(0, 60),
    calendar: dailyCalendar(uid, 28, now),
    perfect: monthlyPerfect(uid, '', now),
    makeupUsed: one('SELECT COUNT(*) n FROM daily_results WHERE user_id = ? AND makeup = 1', uid),
    makeup: made.length
      ? { day: String(made[0].day), slug: String(made[0].slug || ''), makeup: true, doneDay: String(made[0].done_day || '') }
      : { day: '', slug: '', makeup: false, doneDay: '' },
    doneRows: rows.map((r) => ({ day: String(r.day), slug: String(r.slug || ''), makeup: !!Number(r.makeup), doneDay: String(r.done_day || r.day || '') }))
  };
}

/**
 * 记一次每日挑战完成（当天已记过就跳过——UNIQUE(day,user_id) 兜底）。
 * fresh=true 表示这一次是新记上的（页面据此显示「打卡成功」）。
 *
 * opts.day = 补做的目标日 'YYYY-MM-DD'：不传 / 空串 = 当天打卡（老调用点行为不变）。
 * opts.makeup 只作页面自述，落库的 makeup 一律由目标日决定（目标日不是今天就是补做）——
 * 不给任何人留「把过去的日子伪装成自然打卡、借此续上连续」的口子。
 * 返回值在 fresh / day 之外加了 makeup（这次算不算补做）、doneDay（实际完成日）、error：
 *   'too_late' 超出补做窗口（含未来日期）、'bad_day' 日期格式不对、'slug_mismatch' 传的 slug 不是那天的题
 *   —— 除当天重复打卡（fresh=false、error 为空）外都不落库。
 */
export function markDaily(userId, slug, now = Date.now(), opts = {}) {
  const uid = Number(userId) || 0;
  const today = dayKey(now);
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = String(o.day || '') || today;
  if (!uid) return { fresh: false, day: target, makeup: false, doneDay: today, error: '' };
  const bad = makeupCheck(o.day, now);
  if (bad) return { fresh: false, day: target, makeup: false, doneDay: today, error: bad };
  ensureDaily();
  const makeup = target !== today;
  if (String(slug) !== dailySlug(target)) return { fresh: false, day: target, makeup: makeup, doneDay: today, error: 'slug_mismatch' };
  const info = db
    .prepare('INSERT OR IGNORE INTO daily_results (day, user_id, slug, created_at, makeup, done_day) VALUES (?, ?, ?, ?, ?, ?)')
    .run(target, uid, String(slug), now, makeup ? 1 : 0, today);
  return { fresh: !!info.changes, day: target, makeup: makeup, doneDay: today, error: '' };
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

/* ================= 第七批：社交图谱（关注 / 站内通知 / 私信） =================
 * 与 worker/social.js 一一对应：同名同参同返回，那边多一个 db 参数、全程 await。
 * 三张表见 migrations/0007_social_graph.sql；src/db.js 的 migrate() 本次不许动，
 * 所以这里用 ensureSocial() 幂等自愈（思路同 src/db.js 的 addColumn / addIndex）。
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
function userBrief(id) {
  return db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(Number(id) || 0) || null;
}

/**
 * 第七批的三张表：src/db.js 的 migrate() 里没有这一段（那个文件本次不许动），
 * 所以第一次用到时按幂等方式补建一次——和 src/db.js 补列 / 补索引是一个思路。
 * Worker 线对应 worker/schema.js 末尾的 DDL，两边列名逐字一致。
 */
const SOCIAL_DDL = [
  'CREATE TABLE IF NOT EXISTS follows (' +
    '  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    "  created_at  TEXT DEFAULT (datetime('now','localtime'))," +
    '  UNIQUE (user_id, followee_id)' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_follows_user     ON follows(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)',
  'CREATE TABLE IF NOT EXISTS notifications (' +
    '  id          INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '  kind        TEXT NOT NULL,' +
    '  actor_id    INTEGER NOT NULL DEFAULT 0,' +
    "  target_type TEXT NOT NULL DEFAULT ''," +
    "  target_id   TEXT NOT NULL DEFAULT ''," +
    "  body        TEXT NOT NULL DEFAULT ''," +
    '  read_at     TEXT,' +
    "  created_at  TEXT DEFAULT (datetime('now','localtime'))" +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at)',
  'CREATE TABLE IF NOT EXISTS messages (' +
    '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '  body       TEXT NOT NULL,' +
    '  read_at    TEXT,' +
    "  created_at TEXT DEFAULT (datetime('now','localtime'))" +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages(to_id, read_at)'
];

let socialReady = false;

/** 幂等建第七批的表（进程内只跑一次） */
function ensureSocial() {
  if (socialReady) return;
  for (const sql of SOCIAL_DDL) db.exec(sql);
  socialReady = true;
}

/* ---------- 关注：互相关注即好友，不另建表 ---------- */

/**
 * 关注一个人。自己关注自己 → self_follow，任一方不存在 → no_user，重复关注幂等。
 * 返回的 following / followers 是**被关注者**的口径（个人主页上那两个数字）。
 * @returns {{ok:true, following:number, followers:number}|{error:string}}
 */
export function follow(userId, targetId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return { error: 'no_user' };
  if (uid === tid) return { error: 'self_follow' };
  if (!userBrief(uid) || !userBrief(tid)) return { error: 'no_user' };
  db.prepare('INSERT OR IGNORE INTO follows (user_id, followee_id) VALUES (?, ?)').run(uid, tid);
  const c = followCounts(tid);
  return { ok: true, following: c.following, followers: c.followers };
}

/** 取关：没关注过也算成功（幂等）；返回口径同 follow */
export function unfollow(userId, targetId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return { error: 'no_user' };
  db.prepare('DELETE FROM follows WHERE user_id = ? AND followee_id = ?').run(uid, tid);
  const c = followCounts(tid);
  return { ok: true, following: c.following, followers: c.followers };
}

/** 我有没有关注这个人（没登录 / 自己 / 不存在都算 false） */
export function isFollowing(userId, targetId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const tid = Number(targetId) || 0;
  if (!uid || !tid) return false;
  return !!db.prepare('SELECT 1 AS x FROM follows WHERE user_id = ? AND followee_id = ?').get(uid, tid);
}

/** 关注数 / 粉丝数 / 好友数（好友 = 互相关注，不另存表） */
export function followCounts(userId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  if (!uid) return { followers: 0, following: 0, friends: 0 };
  return {
    followers: one('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', uid),
    following: one('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?', uid),
    friends: one(
      'SELECT COUNT(*) AS n FROM follows a JOIN follows b ' +
      'ON b.user_id = a.followee_id AND b.followee_id = a.user_id WHERE a.user_id = ?',
      uid
    )
  };
}

/**
 * 关注 / 粉丝 / 好友列表。
 * kind：followers（谁关注我）/ following（我关注了谁）/ friends（互关）；
 * mutual = 我和这一行是不是互相关注，since = 关注时间（好友取后发生的那一次）。
 * kind 不认识或 userId 为空 → 空列表（路由上当没有）。
 * @returns {{total:number, items:Array<{id:number, username:string, displayName:string, since:string, mutual:boolean}>}}
 */
export function followList(userId, kind, opts = {}) {
  ensureSocial();
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
  const total = one('SELECT COUNT(*) AS n ' + from + ' WHERE ' + where, ...countArgs);
  const rows = db
    .prepare('SELECT ' + cols + ' ' + from + ' WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
    .all(...args, limit, offset);
  return {
    total: total,
    items: rows.map((r) => ({
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
export function notify(userId, { kind, actorId = 0, targetType = '', targetId = '', body = '' } = {}) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const k = String(kind || '');
  const actor = Number(actorId) || 0;
  const tt = String(targetType || '');
  const tid = String(targetId || '');
  if (!uid) return { skipped: 'no_user' };
  if (NOTIFY_KINDS.indexOf(k) < 0) return { skipped: 'bad_kind' };
  if (actor && actor === uid) return { skipped: 'self' };
  const dup = db.prepare(
    'SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND actor_id = ? ' +
    'AND target_type = ? AND target_id = ? ' +
    "AND created_at >= datetime('now','localtime','-" + NOTIFY_WINDOW_MINUTES + " minutes')"
  ).get(uid, k, actor, tt, tid);
  if (dup) return { skipped: 'dup' };
  const info = db
    .prepare('INSERT INTO notifications (user_id, kind, actor_id, target_type, target_id, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, k, actor, tt, tid, flat(body, NOTIFY_MAX));
  return { id: Number(info.lastInsertRowid) || 0 };
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
export function notifyMentions({ actorId = 0, text = '', targetType = '', targetId = '', body = '' } = {}) {
  ensureSocial();
  const actor = Number(actorId) || 0;
  const names = extractMentions(text);
  let wrote = 0;
  for (const name of names) {
    const u = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
    if (!u) continue;
    const r = notify(u.id, {
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
 * @returns {{total:number, unread:number, items:Array<object>}}
 */
export function listNotifications(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 20, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, unread: 0, items: [] };
  const unread = unreadCount(uid);
  const where = 'n.user_id = ?' + (unreadOnly ? ' AND n.read_at IS NULL' : '');
  const total = one('SELECT COUNT(*) AS n FROM notifications n WHERE ' + where, uid);
  const rows = db.prepare(
    'SELECT n.id, n.kind, n.body, n.actor_id, n.target_type, n.target_id, n.read_at, n.created_at, ' +
    'u.username, u.display_name FROM notifications n LEFT JOIN users u ON u.id = n.actor_id ' +
    'WHERE ' + where + ' ORDER BY n.id DESC LIMIT ? OFFSET ?'
  ).all(uid, size, skip);
  return {
    total: total,
    unread: unread,
    items: rows.map((r) => ({
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
export function unreadCount(userId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  return uid ? one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', uid) : 0;
}

/**
 * 标记已读：id = 0 表示该用户全部已读；给了 id 就只能改自己的（别人的返回 ok:false）。
 * @returns {{ok:boolean, unread:number}}
 */
export function markRead(userId, id = 0) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const nid = Number(id) || 0;
  if (!uid) return { ok: false, unread: 0 };
  if (!nid) {
    db.prepare("UPDATE notifications SET read_at = datetime('now','localtime') WHERE user_id = ? AND read_at IS NULL").run(uid);
    return { ok: true, unread: 0 };
  }
  const mine = db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(nid, uid);
  if (!mine) return { ok: false, unread: unreadCount(uid) };
  db.prepare("UPDATE notifications SET read_at = datetime('now','localtime') WHERE id = ? AND user_id = ?").run(nid, uid);
  return { ok: true, unread: unreadCount(uid) };
}

/* ---------- 私信 ---------- */

/**
 * 发一条私信：正文去首尾空白后 1..1000 字符；不能发给自己；收件人不认识 / 被封禁都拒绝。
 * 这里**不写** kind=message 的通知（留给上层调 notify，免得数据层到处写通知）。
 * @returns {{ok:true, id:number}|{error:string}} error: empty / too_long / self / no_user / banned
 */
export function sendMessage(fromId, toId, body) {
  ensureSocial();
  const fid = Number(fromId) || 0;
  const tid = Number(toId) || 0;
  const text = String(body === null || body === undefined ? '' : body).trim();
  if (!text) return { error: 'empty' };
  if (text.length > MESSAGE_MAX) return { error: 'too_long' };
  if (!fid || !tid) return { error: 'no_user' };
  if (!userBrief(fid) || !userBrief(tid)) return { error: 'no_user' };
  if (fid === tid) return { error: 'self' };
  const to = db.prepare('SELECT banned FROM users WHERE id = ?').get(tid);
  if (to && Number(to.banned)) return { error: 'banned' };
  const info = db.prepare('INSERT INTO messages (from_id, to_id, body) VALUES (?, ?, ?)').run(fid, tid, text);
  return { ok: true, id: Number(info.lastInsertRowid) || 0 };
}

/**
 * 会话列表：每个聊过的人一行，带最后一条消息与未读数。
 * outgoing = 最后一条是不是我发的；total = 会话数（不是消息数）。最新聊的排前面。
 * @returns {{total:number, items:Array<{peerId:number, peerName:string, lastBody:string, lastAt:string, unread:number, outgoing:boolean}>}}
 */
export function listMessageThreads(userId, { limit = 24, offset = 0 } = {}) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 24, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, items: [] };
  const total = one(
    'SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM messages WHERE from_id = ? OR to_id = ? ' +
    'GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)',
    uid, uid, uid
  );
  const rows = db.prepare(
    'SELECT peer, MAX(id) AS last_id, SUM(CASE WHEN to_id = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread ' +
    'FROM (SELECT id, from_id, to_id, read_at, CASE WHEN from_id = ? THEN to_id ELSE from_id END AS peer ' +
    'FROM messages WHERE from_id = ? OR to_id = ?) ' +
    'GROUP BY peer ORDER BY last_id DESC LIMIT ? OFFSET ?'
  ).all(uid, uid, uid, uid, size, skip);
  if (!rows.length) return { total: total, items: [] };

  const lastIds = rows.map((r) => Number(r.last_id));
  const lasts = db.prepare(
    'SELECT id, from_id, body, created_at FROM messages WHERE id IN (' + lastIds.map(() => '?').join(',') + ')'
  ).all(...lastIds);
  const lastOf = new Map(lasts.map((r) => [Number(r.id), r]));

  const peerIds = rows.map((r) => Number(r.peer));
  const users = db.prepare(
    'SELECT id, username, display_name FROM users WHERE id IN (' + peerIds.map(() => '?').join(',') + ')'
  ).all(...peerIds);
  const nameById = new Map(users.map((u) => [Number(u.id), nameOf(u)]));

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
 * @returns {{total:number, items:Array<{id:number, fromId:number, body:string, createdAt:string, mine:boolean}>, peer:object}}
 */
export function threadMessages(userId, peerId, { limit = 30, before = 0 } = {}) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const pid = Number(peerId) || 0;
  const size = Math.min(Math.max(Number(limit) || 30, 1), THREAD_MAX);
  const cursor = Math.max(Number(before) || 0, 0);
  const who = pid ? userBrief(pid) : null;
  const peer = { id: pid, username: who ? who.username : '', displayName: nameOf(who) };
  if (!uid || !pid) return { total: 0, items: [], peer: peer };
  const total = one(
    'SELECT COUNT(*) AS n FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
    uid, pid, pid, uid
  );
  const args = [uid, pid, pid, uid];
  let where = 'WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))';
  if (cursor) { where += ' AND id < ?'; args.push(cursor); }
  const rows = db.prepare('SELECT id, from_id, body, created_at FROM messages ' + where + ' ORDER BY id DESC LIMIT ?')
    .all(...args, size);
  return {
    total: total,
    items: rows.map((r) => ({
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
export function markThreadRead(userId, peerId) {
  ensureSocial();
  const uid = Number(userId) || 0;
  const pid = Number(peerId) || 0;
  if (!uid || !pid) return { ok: false, read: 0 };
  const info = db
    .prepare("UPDATE messages SET read_at = datetime('now','localtime') WHERE to_id = ? AND from_id = ? AND read_at IS NULL")
    .run(uid, pid);
  return { ok: true, read: Number(info.changes) || 0 };
}

/* ---------- 论坛 / 评论动作的可选钩子（server.js 在动作成功后调，数据层不自己触发） ---------- */

/**
 * 回复主题后补通知：楼主收一条 kind=reply，正文里 @ 到的人各收一条 kind=mention。
 * 自己回自己的主题不产生 reply 通知（notify 的 self 规则兜底），但 @ 到别人照样通知。
 * targetId 形如 12#p34：主对象是主题 12，# 后是这一楼（直接拼 URL 时浏览器会把它当锚点）；
 * 只要纯 id 就 String(targetId).split('#')[0]。
 * @returns {{id:number, skipped:string, mentioned:number}}
 */
export function notifyReply({ actorId = 0, threadId = 0, threadTitle = '', ownerId = 0, postId = 0, body = '' } = {}) {
  ensureSocial();
  const actor = Number(actorId) || 0;
  const tid = Number(threadId) || 0;
  const targetId = String(tid) + (postId ? '#p' + (Number(postId) || 0) : '');
  const title = flat(threadTitle, 60);
  const text = flat(body, NOTIFY_MAX);
  const r = notify(ownerId, {
    kind: 'reply',
    actorId: actor,
    targetType: 'thread',
    targetId: targetId,
    body: (title ? '回复了你的主题《' + title + '》：' : '回复了你的主题：') + text
  });
  const mentioned = notifyMentions({ actorId: actor, text: body, targetType: 'thread', targetId: targetId, body: text });
  return { id: r.id || 0, skipped: r.skipped || '', mentioned: mentioned };
}

/**
 * 游戏 / 公告评论后补通知：被评论对象的作者收一条 kind=comment（自己评自己的不写），
 * 正文里 @ 到的人各收一条 kind=mention。
 * targetId 形如 snake#c34：主对象是游戏 slug，# 后是评论 id。
 * @returns {{id:number, skipped:string, mentioned:number}}
 */
export function notifyComment({ actorId = 0, gameSlug = '', ownerId = 0, commentId = 0, body = '' } = {}) {
  ensureSocial();
  const actor = Number(actorId) || 0;
  const slug = String(gameSlug || '').trim();
  const targetId = slug + (commentId ? '#c' + (Number(commentId) || 0) : '');
  const text = flat(body, NOTIFY_MAX);
  const r = notify(ownerId, {
    kind: 'comment',
    actorId: actor,
    targetType: 'game',
    targetId: targetId,
    body: '评论了你的作品：' + text
  });
  const mentioned = notifyMentions({ actorId: actor, text: body, targetType: 'game', targetId: targetId, body: text });
  return { id: r.id || 0, skipped: r.skipped || '', mentioned: mentioned };
}

/* ================= 第十批：好友动态流 /feed =================
 * 「关注的人最近在玩什么」——个人主页 / 关注 / 私信之后，README「后续可做」里剩下的那条。
 * 与 worker/social.js 的同名函数一一对应：那边第一个参数是 D1 绑定、全程 await，SQL 与口径一样。
 *
 * 取数口径（两条线必须一致）：
 *   · 名单：follows 里 user_id = 我 的行取 followee_id（天然不含我自己），按关注时间倒序最多
 *     FEED_FOLLOW_MAX 个；一个都没关注就直接空。
 *   · play：play_logs 只有 (game_id, day) 两个字段、没有 user_id，落不了「谁玩了什么」，
 *     所以「在玩」只认两张逐人 + 逐游戏 + 带时间戳的表：
 *       favorites（收藏；UNIQUE(user_id, game_id)，一人一游戏一条）
 *       ∪ elo_history（服务端裁判的一局；host_id / guest_id 是身份键——登录用户存 String(user.id)，
 *         匿名存 playerKey(昵称) 即 'n:' 前缀，所以只认纯数字键，并且按 TEXT 传参）
 *     同一人同一游戏只留最近一条：elo 一人一游戏能堆几十条，不去重会把 feed 刷成一个人的战绩表。
 *   · comment：comments 只取 status = 1 且 target = 'game'（target = 'post' 时 game_id 是公告帖 id，
 *     拿它去 join games 会串到别的游戏上）；正文截到 FEED_TEXT 字。
 *   · thread：forum_threads 只取 status = 1（0 待审 / 2 下架都不外露），正文用标题——
 *     主题行与首楼同一时间、同一作者，取一处就够，不必再查 forum_posts。
 *   · daily：daily_results 一天一人一条，指向 /daily，补做的标注出来。
 * at 一律毫秒：comments / forum_threads / favorites 的 created_at 是 datetime('now','localtime') 文本，
 * 按仓库既有写法 Date.parse(s.replace(' ', 'T')) 当本地时间解析（同 follows 列表那段）；elo_history 与
 * daily_results 本身就是毫秒。now 只为与 dailyStats 那组接口对称（测试里可以喂固定时钟）——
 * 动态流按各行自己的绝对时间排序，不依赖「今天」是哪天。
 */
const FEED_TEXT = 60;
/** 一次最多算多少个关注对象；D1 单条语句最多 100 个绑定参数，所以按 FEED_CHUNK 分批查 */
const FEED_FOLLOW_MAX = 150;
const FEED_CHUNK = 30;
/** 同一毫秒的排序位（数字小的在前），两条线共用一套顺序 */
const FEED_RANK = { play: 0, comment: 1, thread: 2, daily: 3 };

/** created_at 归一成毫秒：文本 datetime 与整数毫秒都吃；解析不出来给 0（排最后，不会顶到最前面） */
function feedMs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(String(v == null ? '' : v).trim().replace(' ', 'T'));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * 好友动态流：我关注的人最近的 play / comment / thread / daily，按 at 倒序。
 * @param {number} userId 当前登录用户
 * @param {{limit?: number, offset?: number, now?: number}} [opts] limit 默认 20、上限 LIST_MAX(50)
 * @returns {{total: number, items: Array<{kind: string, actorId: number, username: string, displayName: string, gameSlug: string, gameTitle: string, text: string, threadId: number, at: number}>}}
 */
export function friendFeed(userId, { limit = 20, offset = 0, now = Date.now() } = {}) {
  void now; // 只为接口对称留着；排序用的是各行自己的绝对时间
  ensureSocial();
  ensureDaily();
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 20, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, items: [] };
  const who = db.prepare('SELECT followee_id FROM follows WHERE user_id = ? ORDER BY created_at DESC, followee_id DESC LIMIT ?')
    .all(uid, FEED_FOLLOW_MAX)
    .map((r) => Number(r.followee_id) || 0)
    .filter((id) => id > 0 && id !== uid);
  if (!who.length) return { total: 0, items: [] };

  // 每个来源各取「本页之前 + 本页」这么多：先合并去重再切页。分批也安全——一行若在全局前 cap 名里，
  // 它在自己那一批里也一定在前 cap 名里（行按作者分批，作者之间不会互相顶掉）。
  const cap = skip + size;
  const items = [];
  const play = new Map();
  let total = 0;

  const addPlay = (r) => {
    const actor = Number(r.actor) || 0;
    const slug = String(r.slug || '').trim();
    if (!actor || !slug) return;
    const at = feedMs(r.created_at);
    const key = actor + ':' + slug;
    const old = play.get(key);
    if (!old || at > old.at) {
      play.set(key, { kind: 'play', actorId: actor, gameSlug: slug, gameTitle: String(r.title || slug), text: '', threadId: 0, at: at });
    }
  };

  for (let i = 0; i < who.length; i += FEED_CHUNK) {
    const part = who.slice(i, i + FEED_CHUNK);
    const qs = part.map(() => '?').join(', ');
    const keys = part.map(String); // elo 的身份键是 TEXT，别按数字绑

    // play：收藏 ∪ 天梯对局，按（人, 游戏）去重留最近一条
    db.prepare(
      'SELECT f.user_id AS actor, g.slug AS slug, g.title AS title, f.created_at AS created_at ' +
      'FROM favorites f JOIN games g ON g.id = f.game_id WHERE f.user_id IN (' + qs + ') ' +
      'ORDER BY f.created_at DESC LIMIT ?'
    ).all(...part, cap).forEach(addPlay);
    db.prepare(
      'SELECT q.actor AS actor, q.slug AS slug, g.title AS title, q.at AS created_at FROM (' +
        'SELECT p.actor AS actor, p.slug AS slug, MAX(p.at) AS at FROM (' +
          'SELECT CAST(e.host_id AS INTEGER) AS actor, e.game AS slug, e.created_at AS at ' +
            'FROM elo_history e WHERE e.host_id IN (' + qs + ') ' +
          'UNION ALL ' +
          'SELECT CAST(e.guest_id AS INTEGER) AS actor, e.game AS slug, e.created_at AS at ' +
            'FROM elo_history e WHERE e.guest_id IN (' + qs + ')' +
        ') p GROUP BY p.actor, p.slug ORDER BY at DESC LIMIT ?' +
      ') q LEFT JOIN games g ON g.slug = q.slug'
    ).all(...keys, ...keys, cap).forEach(addPlay);
    total += one(
      'SELECT COUNT(*) AS n FROM (' +
        'SELECT f.user_id AS actor, g.slug AS slug FROM favorites f JOIN games g ON g.id = f.game_id ' +
          'WHERE f.user_id IN (' + qs + ') ' +
        'UNION ' +
        'SELECT CAST(e.host_id AS INTEGER) AS actor, e.game AS slug FROM elo_history e WHERE e.host_id IN (' + qs + ') ' +
        'UNION ' +
        'SELECT CAST(e.guest_id AS INTEGER) AS actor, e.game AS slug FROM elo_history e WHERE e.guest_id IN (' + qs + ')' +
      ')'
      , ...part, ...keys, ...keys);

    // comment：已发布 + 挂在游戏上（target = 'game'）
    total += one(
      "SELECT COUNT(*) AS n FROM comments c JOIN games g ON g.id = c.game_id " +
      "WHERE c.status = 1 AND c.target = 'game' AND c.user_id IN (" + qs + ')',
      ...part);
    db.prepare(
      'SELECT c.user_id AS actor, c.body AS body, c.created_at AS created_at, g.slug AS slug, g.title AS title ' +
      "FROM comments c JOIN games g ON g.id = c.game_id WHERE c.status = 1 AND c.target = 'game' AND c.user_id IN (" + qs + ') ' +
      'ORDER BY c.created_at DESC, c.id DESC LIMIT ?'
    ).all(...part, cap).forEach((r) => {
      items.push({
        kind: 'comment', actorId: Number(r.actor) || 0, gameSlug: String(r.slug || ''),
        gameTitle: String(r.title || ''), text: flat(r.body, FEED_TEXT), threadId: 0, at: feedMs(r.created_at)
      });
    });

    // thread：已发布的主题（标题即正文摘要）
    total += one('SELECT COUNT(*) AS n FROM forum_threads t WHERE t.status = 1 AND t.user_id IN (' + qs + ')', ...part);
    db.prepare(
      'SELECT t.id AS id, t.user_id AS actor, t.title AS title, t.created_at AS created_at ' +
      'FROM forum_threads t WHERE t.status = 1 AND t.user_id IN (' + qs + ') ' +
      'ORDER BY t.created_at DESC, t.id DESC LIMIT ?'
    ).all(...part, cap).forEach((r) => {
      items.push({
        kind: 'thread', actorId: Number(r.actor) || 0, gameSlug: '', gameTitle: '',
        text: flat(r.title, FEED_TEXT), threadId: Number(r.id) || 0, at: feedMs(r.created_at)
      });
    });

    // daily：一天一人一条
    total += one('SELECT COUNT(*) AS n FROM daily_results d WHERE d.user_id IN (' + qs + ')', ...part);
    db.prepare(
      'SELECT d.user_id AS actor, d.day AS day, d.slug AS slug, d.makeup AS makeup, d.created_at AS created_at, g.title AS title ' +
      'FROM daily_results d LEFT JOIN games g ON g.slug = d.slug WHERE d.user_id IN (' + qs + ') ' +
      'ORDER BY d.day DESC, d.id DESC LIMIT ?'
    ).all(...part, cap).forEach((r) => {
      const day = String(r.day || '');
      items.push({
        kind: 'daily', actorId: Number(r.actor) || 0, gameSlug: String(r.slug || ''),
        gameTitle: String(r.title || r.slug || ''),
        text: '完成了每日挑战' + (Number(r.makeup) ? '（补做）' : ''), threadId: 0,
        // created_at 是毫秒；只有老库为 0 时才退回当天中午，别把 1970 顶到最前面
        at: feedMs(r.created_at) || feedMs(day + 'T12:00:00')
      });
    });
  }

  play.forEach((it) => items.push(it));
  items.sort((a, b) => (b.at - a.at) || ((FEED_RANK[a.kind] || 0) - (FEED_RANK[b.kind] || 0)) || (b.actorId - a.actorId));

  const page = items.slice(skip, skip + size);
  const ids = [];
  page.forEach((it) => { if (it.actorId && ids.indexOf(it.actorId) < 0) ids.push(it.actorId); });
  const people = new Map();
  if (ids.length) {
    db.prepare('SELECT id, username, display_name FROM users WHERE id IN (' + ids.map(() => '?').join(', ') + ')')
      .all(...ids)
      .forEach((u) => people.set(Number(u.id), { username: String(u.username || ''), displayName: nameOf(u) }));
  }
  return {
    total: total,
    items: page.map((it) => {
      const p = people.get(it.actorId) || { username: '', displayName: '' };
      return {
        kind: it.kind,
        actorId: it.actorId,
        username: p.username,
        displayName: p.displayName || p.username,
        gameSlug: it.gameSlug || '',
        gameTitle: it.gameTitle || '',
        text: it.text || '',
        threadId: Number(it.threadId) || 0,
        at: Number(it.at) || 0
      };
    })
  };
}

