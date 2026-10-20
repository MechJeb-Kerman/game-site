/**
 * 账号社交数据（Cloudflare Workers + D1 版）。
 * 与 src/social.js 一一对应：那边用同步 SQL，这里第一个参数是 D1 绑定、全程 await，
 * 统计口径务必保持一致（comments/threads/replies 只数 status = 1，ratings 认 visitor = 用户 id）。
 */
import { dayKey, pickDaily, streakOf, makeupCheck, calendarCells, monthPerfect } from '../src/daily.js';
import { badgesOf } from '../src/badges.js';
// 打卡奖励的经验（8 档，快照口径）并进等级：与徽章经验各算各的、可叠加
import { rewardLevelOf } from '../src/rewards.js';
// Web Push：notify() 写完站内通知顺手推一条（与 src/social.js:12 的同名 import 对应）
import { notifyPush } from './push.js';
import { listGames } from './data.js';

function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

// Web Push 的 env（VAPID 密钥）不在数据库里：D1 线由 app.js 每个请求进来时注入一次。
// 没注入时 pushConfigured({}) 判未配置，推送整条空转——与线上没配 VAPID 的行为一致。
let pushEnv = {};

/** 注入本次请求的 env（worker/app.js 在 appFetch 开头调）。 */
export function usePushEnv(env) {
  pushEnv = env || {};
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

/* ================= 第八批：全勤日历 / 补做 =================
 * 与 src/social.js 一一对应：同名同参同返回，这里第一个参数是 D1 绑定、全程 await。
 * daily_results 要多两列（makeup / done_day）；worker/schema.js 本次不许动，
 * 所以照 schema.js 末尾 ensureColumns 的写法在第一次用到时幂等补列（PRAGMA table_info → .all() → info.results）。
 * 口径（窗口多长、连续天数认不认补做）写在 src/daily.js 第八批那一段。
 */

const dailyReady = new WeakSet();

/** 幂等补 daily_results 的两列（按 D1 绑定各记一次） */
async function ensureDaily(db) {
  if (dailyReady.has(db)) return;
  const info = await db.prepare('PRAGMA table_info(daily_results)').all();
  const cols = ((info && info.results) || []).map((c) => String(c.name));
  if (cols.indexOf('makeup') < 0) await db.prepare('ALTER TABLE daily_results ADD COLUMN makeup INTEGER NOT NULL DEFAULT 0').run();
  if (cols.indexOf('done_day') < 0) await db.prepare("ALTER TABLE daily_results ADD COLUMN done_day TEXT NOT NULL DEFAULT ''").run();
  dailyReady.add(db);
}

/** 最近 N 天的全勤日历（含今天，按时间正序）；未登录给一份全 false 的格子 */
export async function dailyCalendar(db, userId, days = 28, now = Date.now()) {
  const uid = Number(userId) || 0;
  const n = Math.min(120, Math.max(1, Number(days) || 28));
  const today = dayKey(now);
  if (!uid) return { day: today, today: null, cells: calendarCells([], n, now) };
  await ensureDaily(db);
  const res = await stmt(db, 'SELECT day, slug, makeup, done_day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 200', [uid]).all();
  const rows = (res && res.results) || [];
  let hit = null;
  for (const r of rows) if (String(r.day) === today) { hit = r; break; }
  return { day: today, today: hit, cells: calendarCells(rows, n, now) };
}

/** 月度全勤：month = 'YYYY-MM'（缺省 / 不合法 = 当前月）；补做也算完成，口径见 src/daily.js */
export async function monthlyPerfect(db, userId, month = '', now = Date.now()) {
  const uid = Number(userId) || 0;
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  const label = m ? m[1] + '-' + m[2] : dayKey(now).slice(0, 7);
  if (!uid) return monthPerfect(label, [], now);
  await ensureDaily(db);
  const res = await stmt(db, 'SELECT day FROM daily_results WHERE user_id = ? AND day LIKE ?', [uid, label + '-%']).all();
  return monthPerfect(label, ((res && res.results) || []).map((r) => String(r.day)), now);
}

/**
 * 每日挑战的进度：今天做了没、累计几次、连续几天。
 * 第八批只加字段、不改口径：total / done / doneToday 数「目标日」有没有记录（补做也算完成），
 * streak 只数自然打卡（补做不续连续），done 还是最近 60 个目标日。
 * 新增：calendar（28 天格子）、perfect（当月全勤）、makeupUsed（补做次数）、
 *       makeup（最近一次补做）、doneRows（目标日 + 是否补做 + 实际完成日）。
 */
export async function dailyStats(db, userId, now = Date.now()) {
  const uid = Number(userId) || 0;
  const day = dayKey(now);
  if (!uid) {
    return {
      day: day,
      slug: await dailySlug(db, day),
      total: 0,
      streak: 0,
      doneToday: false,
      done: [],
      calendar: await dailyCalendar(db, 0, 28, now),
      perfect: await monthlyPerfect(db, 0, '', now),
      makeupUsed: 0,
      makeup: { day: '', slug: '', makeup: false, doneDay: '' },
      doneRows: []
    };
  }
  await ensureDaily(db);
  const res = await stmt(db, 'SELECT day, slug, makeup, done_day FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 400', [uid]).all();
  const rows = (res && res.results) || [];
  const targets = rows.map((r) => String(r.day));
  const natural = rows.filter((r) => !Number(r.makeup)).map((r) => String(r.day));
  const made = rows.filter((r) => Number(r.makeup));
  return {
    day: day,
    slug: await dailySlug(db, day),
    total: await count(db, 'SELECT COUNT(*) AS n FROM daily_results WHERE user_id = ?', [uid]),
    streak: streakOf(natural, now),
    doneToday: targets.indexOf(day) >= 0,
    done: targets.slice(0, 60),
    calendar: await dailyCalendar(db, uid, 28, now),
    perfect: await monthlyPerfect(db, uid, '', now),
    makeupUsed: await count(db, 'SELECT COUNT(*) AS n FROM daily_results WHERE user_id = ? AND makeup = 1', [uid]),
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
 * opts.makeup 只作页面自述，落库的 makeup 一律由目标日决定（目标日不是今天就是补做）。
 * 返回值在 fresh / day 之外加了 makeup（这次算不算补做）、doneDay（实际完成日）、error，
 * 原因码与 src/social.js 的 markDaily 逐个一致。
 */
export async function markDaily(db, userId, slug, now = Date.now(), opts = {}) {
  const uid = Number(userId) || 0;
  const today = dayKey(now);
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = String(o.day || '') || today;
  if (!uid) return { fresh: false, day: target, makeup: false, doneDay: today, error: '' };
  const bad = makeupCheck(o.day, now);
  if (bad) return { fresh: false, day: target, makeup: false, doneDay: today, error: bad };
  await ensureDaily(db);
  const makeup = target !== today;
  if (String(slug) !== (await dailySlug(db, target))) return { fresh: false, day: target, makeup: makeup, doneDay: today, error: 'slug_mismatch' };
  const info = await db
    .prepare('INSERT OR IGNORE INTO daily_results (day, user_id, slug, created_at, makeup, done_day) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(target, uid, String(slug), now, makeup ? 1 : 0, today)
    .run();
  return { fresh: !!(info && info.meta && info.meta.changes), day: target, makeup: makeup, doneDay: today, error: '' };
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
    // 当月全勤（perfect-month 徽章读这个数字；perfect 是对象，badgesOf 直接读 stats[b.stat] 读不到）
    perfectMonths: daily.perfect && daily.perfect.perfect ? 1 : 0,
    joinedAt: u.created_at || ''
  };
}

/** 带徽章与等级的完整档案（个人主页 + 后台用） */
export async function profileOf(db, userId) {
  const stats = await statsOf(db, userId);
  if (!stats) return null;
  // rewardLevelOf = levelOf 的字段 + 把打卡奖励经验并进来（多一个 bonus）
  const level = rewardLevelOf(stats);
  return Object.assign({}, stats, {
    badges: badgesOf(stats),
    badgesOwned: badgesOf(stats).filter((b) => b.done).length,
    level: level.level,
    xp: level.xp,
    xpFloor: level.floor,
    xpNext: level.next,
    xpNeed: level.need,
    xpBonus: level.bonus,
    title: level.title
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
  const id = Number((info && info.meta && info.meta.last_row_id) || 0);
  // 通知落库成功才推：push.js 自己判 VAPID 配置、kind 白名单与「自己给自己」
  if (id) {
    notifyPush(db, pushEnv, uid, {
      kind: k,
      actorId: actor,
      actorName: actor ? nameOf(await userBrief(db, actor)) : '',
      targetType: tt,
      targetId: tid,
      body: flat(body, NOTIFY_MAX)
    });
  }
  return { id: id };
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

/** D1 查询的小包装：只关心结果行 */
async function feedRows(db, sql, params) {
  const res = await stmt(db, sql, params).all();
  return (res && res.results) || [];
}

/**
 * 好友动态流：我关注的人最近的 play / comment / thread / daily，按 at 倒序。
 * 与 src/social.js 的 friendFeed 同名同参同返回（第一个参数是 D1 绑定），SQL 与口径逐条对齐。
 * @param {object} db D1 绑定
 * @param {number} userId 当前登录用户
 * @param {{limit?: number, offset?: number, now?: number}} [opts] limit 默认 20、上限 LIST_MAX(50)
 */
export async function friendFeed(db, userId, { limit = 20, offset = 0, now = Date.now() } = {}) {
  void now; // 只为接口对称留着；排序用的是各行自己的绝对时间
  await ensureDaily(db);
  const uid = Number(userId) || 0;
  const size = Math.min(Math.max(Number(limit) || 20, 1), LIST_MAX);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!uid) return { total: 0, items: [] };
  const who = (await feedRows(db,
    'SELECT followee_id FROM follows WHERE user_id = ? ORDER BY created_at DESC, followee_id DESC LIMIT ?',
    [uid, FEED_FOLLOW_MAX]))
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
    (await feedRows(db,
      'SELECT f.user_id AS actor, g.slug AS slug, g.title AS title, f.created_at AS created_at ' +
      'FROM favorites f JOIN games g ON g.id = f.game_id WHERE f.user_id IN (' + qs + ') ' +
      'ORDER BY f.created_at DESC LIMIT ?',
      part.concat([cap]))).forEach(addPlay);
    (await feedRows(db,
      'SELECT q.actor AS actor, q.slug AS slug, g.title AS title, q.at AS created_at FROM (' +
        'SELECT p.actor AS actor, p.slug AS slug, MAX(p.at) AS at FROM (' +
          'SELECT CAST(e.host_id AS INTEGER) AS actor, e.game AS slug, e.created_at AS at ' +
            'FROM elo_history e WHERE e.host_id IN (' + qs + ') ' +
          'UNION ALL ' +
          'SELECT CAST(e.guest_id AS INTEGER) AS actor, e.game AS slug, e.created_at AS at ' +
            'FROM elo_history e WHERE e.guest_id IN (' + qs + ')' +
        ') p GROUP BY p.actor, p.slug ORDER BY at DESC LIMIT ?' +
      ') q LEFT JOIN games g ON g.slug = q.slug',
      keys.concat(keys, [cap]))).forEach(addPlay);
    total += await count(db,
      'SELECT COUNT(*) AS n FROM (' +
        'SELECT f.user_id AS actor, g.slug AS slug FROM favorites f JOIN games g ON g.id = f.game_id ' +
          'WHERE f.user_id IN (' + qs + ') ' +
        'UNION ' +
        'SELECT CAST(e.host_id AS INTEGER) AS actor, e.game AS slug FROM elo_history e WHERE e.host_id IN (' + qs + ') ' +
        'UNION ' +
        'SELECT CAST(e.guest_id AS INTEGER) AS actor, e.game AS slug FROM elo_history e WHERE e.guest_id IN (' + qs + ')' +
      ')',
      part.concat(keys, keys));

    // comment：已发布 + 挂在游戏上（target = 'game'）
    total += await count(db,
      "SELECT COUNT(*) AS n FROM comments c JOIN games g ON g.id = c.game_id " +
      "WHERE c.status = 1 AND c.target = 'game' AND c.user_id IN (" + qs + ')',
      part);
    (await feedRows(db,
      'SELECT c.user_id AS actor, c.body AS body, c.created_at AS created_at, g.slug AS slug, g.title AS title ' +
      "FROM comments c JOIN games g ON g.id = c.game_id WHERE c.status = 1 AND c.target = 'game' AND c.user_id IN (" + qs + ') ' +
      'ORDER BY c.created_at DESC, c.id DESC LIMIT ?',
      part.concat([cap]))).forEach((r) => {
      items.push({
        kind: 'comment', actorId: Number(r.actor) || 0, gameSlug: String(r.slug || ''),
        gameTitle: String(r.title || ''), text: flat(r.body, FEED_TEXT), threadId: 0, at: feedMs(r.created_at)
      });
    });

    // thread：已发布的主题（标题即正文摘要）
    total += await count(db, 'SELECT COUNT(*) AS n FROM forum_threads t WHERE t.status = 1 AND t.user_id IN (' + qs + ')', part);
    (await feedRows(db,
      'SELECT t.id AS id, t.user_id AS actor, t.title AS title, t.created_at AS created_at ' +
      'FROM forum_threads t WHERE t.status = 1 AND t.user_id IN (' + qs + ') ' +
      'ORDER BY t.created_at DESC, t.id DESC LIMIT ?',
      part.concat([cap]))).forEach((r) => {
      items.push({
        kind: 'thread', actorId: Number(r.actor) || 0, gameSlug: '', gameTitle: '',
        text: flat(r.title, FEED_TEXT), threadId: Number(r.id) || 0, at: feedMs(r.created_at)
      });
    });

    // daily：一天一人一条
    total += await count(db, 'SELECT COUNT(*) AS n FROM daily_results d WHERE d.user_id IN (' + qs + ')', part);
    (await feedRows(db,
      'SELECT d.user_id AS actor, d.day AS day, d.slug AS slug, d.makeup AS makeup, d.created_at AS created_at, g.title AS title ' +
      'FROM daily_results d LEFT JOIN games g ON g.slug = d.slug WHERE d.user_id IN (' + qs + ') ' +
      'ORDER BY d.day DESC, d.id DESC LIMIT ?',
      part.concat([cap]))).forEach((r) => {
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
    (await feedRows(db, 'SELECT id, username, display_name FROM users WHERE id IN (' + ids.map(() => '?').join(', ') + ')', ids))
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

