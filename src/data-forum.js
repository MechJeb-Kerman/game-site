/**
 * 论坛数据层（Express / node:sqlite 版）。
 * 与 worker/data-forum.js 一一对应：那边每个函数第一个参数是 D1 绑定、全程 await，
 * 这里的 SQL 完全一样，方便两条线对读。
 *
 * 状态语义（前后台共用 src/forum-guard.js 的常量）：
 *   主题 forum_threads.status  0 待审 / 1 已发布 / 2 已下架（软删，可恢复）
 *   楼层 forum_posts.status    0 待审 / 1 已发布 / 2 已隐藏（软删）
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import {
  NEWBIE_POST_LIMIT,
  RATE,
  NONCE_TTL_MINUTES,
  decideStatus,
  matchRules,
  compileRules
} from './forum-guard.js';

const THREAD_COLS =
  't.id, t.title, t.status, t.pinned, t.featured, t.locked, t.reply_count, t.view_count, ' +
  't.created_at, t.last_reply_at, t.user_id, u.display_name AS name, u.username, ' +
  'f.id AS forum_id, f.slug AS forum_slug, f.name AS forum_name, f.icon AS forum_icon, ' +
  // 标签跟主题一趟取回：GROUP_CONCAT 拼成 a,b，再由 threadRow 切成数组（省掉每行再查一次库）
  // 标签里不会有逗号 —— cleanTags 已把逗号一并剔除，所以按逗号切是安全的
  "(SELECT GROUP_CONCAT(tt.tag, ',') FROM thread_tags tt WHERE tt.thread_id = t.id) AS tags";

const POST_COLS =
  'p.id, p.thread_id, p.body, p.status, p.is_op, p.parent_id, p.edited_at, p.edit_count, p.created_at, ' +
  'p.user_id, u.display_name AS name, u.username, u.role, ' +
  'pu.display_name AS parent_name';

const POST_JOINS =
  'FROM forum_posts p JOIN users u ON u.id = p.user_id ' +
  'LEFT JOIN forum_posts pp ON pp.id = p.parent_id LEFT JOIN users pu ON pu.id = pp.user_id ';

const THREAD_JOINS =
  'FROM forum_threads t JOIN users u ON u.id = t.user_id JOIN forums f ON f.id = t.forum_id ';

/* ---------- 板块 ---------- */

/** 默认板块：第一次访问论坛时幂等插入，两条线共用同一份种子 */
const DEFAULT_FORUMS = [
  ['general', '综合讨论', '随便聊，游戏相关的、不相关的都行', '💬', 10],
  ['guide', '攻略心得', '通关技巧、隐藏要素、玩法分享', '📖', 20],
  ['help', '求助答疑', '卡关了、报错了、想问什么都可以', '🆘', 30],
  ['meta', '站务反馈', '对站点的建议、Bug 反馈、投稿咨询', '🔧', 40]
];

export function ensureForums() {
  const ins = db.prepare('INSERT OR IGNORE INTO forums (slug, name, description, icon, sort) VALUES (?, ?, ?, ?, ?)');
  for (const f of DEFAULT_FORUMS) ins.run(f[0], f[1], f[2], f[3], f[4]);
}

export function listForums() {
  ensureForums();
  return db.prepare(
    'SELECT f.*, ' +
    '(SELECT COUNT(*) FROM forum_threads t WHERE t.forum_id = f.id AND t.status = 1) AS thread_count, ' +
    '(SELECT COUNT(*) FROM forum_posts p JOIN forum_threads t2 ON t2.id = p.thread_id ' +
    ' WHERE t2.forum_id = f.id AND p.status = 1) AS post_count ' +
    'FROM forums f WHERE f.status = 1 ORDER BY f.sort, f.id'
  ).all();
}

export function getForum(slug) {
  ensureForums();
  return db.prepare('SELECT * FROM forums WHERE slug = ?').get(String(slug || '')) || null;
}

export function forumStats() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    forums: one('SELECT COUNT(*) n FROM forums WHERE status = 1'),
    threads: one('SELECT COUNT(*) n FROM forum_threads WHERE status = 1'),
    posts: one('SELECT COUNT(*) n FROM forum_posts WHERE status = 1'),
    today: one("SELECT COUNT(*) n FROM forum_posts WHERE status = 1 AND created_at >= datetime('now','localtime','start of day')"),
    users: one('SELECT COUNT(DISTINCT user_id) n FROM forum_posts'),
    members: one('SELECT COUNT(*) n FROM users'),
    pendingThreads: one('SELECT COUNT(*) n FROM forum_threads WHERE status = 0'),
    pendingPosts: one('SELECT COUNT(*) n FROM forum_posts WHERE status = 0'),
    reports: one('SELECT COUNT(*) n FROM forum_reports WHERE status = 0'),
    muted: one("SELECT COUNT(*) n FROM users WHERE muted_until IS NOT NULL AND muted_until > datetime('now','localtime')")
  };
}

/* ---------- 主题列表 / 详情 ---------- */

/** 游客只看已发布；登录用户还能看到自己那条待审/被下架的（页面上标注状态） */
function visibleThreadSql(viewerId) {
  return viewerId ? '(t.status = 1 OR t.user_id = ?)' : 't.status = 1';
}

export function listThreads({ forum = '', q = '', tag = '', featuredOnly = false, pinnedFirst = false, page = 1, pageSize = 20, viewerId = null } = {}) {
  const where = [visibleThreadSql(viewerId)];
  const args = viewerId ? [viewerId] : [];
  if (forum) { where.push('f.slug = ?'); args.push(forum); }
  const kw = String(q || '').trim();
  if (kw) {
    const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    where.push("(t.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM forum_posts op WHERE op.thread_id = t.id AND op.is_op = 1 AND op.body LIKE ? ESCAPE '\\'))");
    args.push(like, like);
  }
  // 按标签筛主题：EXISTS 走 idx_thread_tags_tag；不改动其它条件与分页语义
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id AND tt.tag = ?)');
    args.push(String(tag));
  }
  if (featuredOnly) where.push('t.featured = 1');
  const w = 'WHERE ' + where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) n ' + THREAD_JOINS + w).get(...args).n;
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 50);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  const items = db.prepare(
    'SELECT ' + THREAD_COLS + ' ' + THREAD_JOINS + w + ' ' + threadOrder(pinnedFirst) + ' LIMIT ? OFFSET ?'
  ).all(...args, size, (p - 1) * size);
  return { items: items.map(threadRow), total, page: p, pages, pageSize: size };
}

/**
 * 取主题。游客/普通用户只能拿已发布的，作者本人能拿自己的（含待审/下架），站长拿全部。
 * 返回 { thread, canView, isOwner, isAdmin }，路由据此决定 404 与否。
 */
export function getThread(id, viewer = null) {
  const row = db.prepare('SELECT ' + THREAD_COLS + ' ' + THREAD_JOINS + 'WHERE t.id = ?').get(Number(id) || 0);
  if (!row) return null;
  const isAdmin = !!viewer && viewer.role === 'admin';
  const isOwner = !!viewer && Number(viewer.id) === Number(row.user_id);
  const canView = Number(row.status) === 1 || isOwner || isAdmin;
  return { thread: threadRow(row), canView, isOwner, isAdmin };
}

export function bumpThreadView(id) {
  db.prepare('UPDATE forum_threads SET view_count = view_count + 1 WHERE id = ?').run(Number(id) || 0);
}

export function canViewPost(post, viewer) {
  if (!post) return false;
  if (Number(post.status) === 1) return true;
  if (!viewer) return false;
  return viewer.role === 'admin' || Number(post.user_id) === Number(viewer.id);
}

/** 楼层：游客与普通用户只看已发布，作者能看到自己待审/被隐藏的，站长全看 */
export function listPosts(threadId, { page = 1, pageSize = 15, viewer = null } = {}) {
  const tid = Number(threadId) || 0;
  const where = ['p.thread_id = ?'];
  const args = [tid];
  if (viewer && viewer.role === 'admin') {
    // 站长全看
  } else if (viewer) {
    where.push('(p.status = 1 OR p.user_id = ?)');
    args.push(Number(viewer.id));
  } else {
    where.push('p.status = 1');
  }
  const w = 'WHERE ' + where.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) n FROM forum_posts p ' + w).get(...args).n;
  const size = Math.min(Math.max(Number(pageSize) || 15, 1), 50);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  const rows = db.prepare(
    'SELECT ' + POST_COLS + ' ' + POST_JOINS + w + ' ORDER BY p.id ASC LIMIT ? OFFSET ?'
  ).all(...args, size, (p - 1) * size);
  const offset = (p - 1) * size;
  rows.forEach((r, i) => { r.floor = offset + i + 1; });
  return { items: rows, total, page: p, pages, pageSize: size };
}

export function getPost(id, viewer = null) {
  const row = db.prepare('SELECT ' + POST_COLS + ' ' + POST_JOINS + 'WHERE p.id = ?').get(Number(id) || 0);
  if (!row || !canViewPost(row, viewer)) return null;
  return row;
}

/** 编辑留痕（后台与楼主都看得到改过什么） */
export function listPostEdits(postId, limit = 20) {
  return db.prepare(
    'SELECT e.id, e.before_body, e.after_body, e.created_at, u.display_name AS name ' +
    'FROM forum_post_edits e LEFT JOIN users u ON u.id = e.editor_id ' +
    'WHERE e.post_id = ? ORDER BY e.id DESC LIMIT ?'
  ).all(Number(postId) || 0, Number(limit) || 20);
}

export function countUserPosts(userId) {
  return db.prepare('SELECT COUNT(*) n FROM forum_posts WHERE user_id = ? AND status = 1').get(Number(userId) || 0).n;
}

/* ---------- 发帖门槛 / 频控 ---------- */

/** 能不能发帖：登录 + 已验证邮箱 + 没被封 + 没被禁言 */
export function forumGate(user) {
  if (!user) return { error: 'login', message: '登录后才能发帖' };
  const u = db.prepare(
    "SELECT email_verified, banned, banned_reason, muted_until, mute_reason, " +
    "(muted_until IS NOT NULL AND muted_until > datetime('now','localtime')) AS muted " +
    'FROM users WHERE id = ?'
  ).get(Number(user.id));
  if (!u) return { error: 'login', message: '登录后才能发帖' };
  if (Number(u.banned)) {
    return { error: 'banned', message: '账号已被封禁' + (u.banned_reason ? '：' + u.banned_reason : '') };
  }
  if (Number(u.muted)) {
    return { error: 'muted', message: '你被禁言到 ' + u.muted_until + (u.mute_reason ? '（' + u.mute_reason + '）' : '') };
  }
  if (!Number(u.email_verified)) {
    return { error: 'email', message: '要先在「账号」页验证邮箱，才能发帖' };
  }
  return { ok: true };
}

function since(seconds) {
  return db.prepare("SELECT datetime('now','localtime','-' || ? || ' seconds') AS t").get(Number(seconds) || 0).t;
}
function sinceMinutes(minutes) {
  return db.prepare("SELECT datetime('now','localtime','-' || ? || ' minutes') AS t").get(Number(minutes) || 0).t;
}

/** 滚动窗口频控：先看两条之间的间隔，再看每窗口上限 */
export function checkRate(kind, userId) {
  const cfg = RATE[kind] || RATE.post;
  const uid = Number(userId) || 0;
  const table = kind === 'thread' ? 'forum_threads' : kind === 'report' ? 'forum_reports' : 'forum_posts';
  if (cfg.gapSeconds) {
    const last = db.prepare('SELECT MAX(created_at) AS t FROM ' + table + ' WHERE user_id = ?').get(uid).t;
    if (last && last > since(cfg.gapSeconds)) {
      return { error: 'too_fast', message: '发得太快了，' + cfg.gapSeconds + ' 秒内只能发一条' };
    }
  }
  if (cfg.perDay) {
    const n = db.prepare('SELECT COUNT(*) n FROM ' + table + " WHERE user_id = ? AND created_at >= datetime('now','localtime','-1 day')").get(uid).n;
    if (n >= cfg.perDay) return { error: 'daily', message: '今天' + cfg.label + '的数量到上限了（' + cfg.perDay + ' 条）' };
  }
  if (cfg.perHour) {
    const n = db.prepare('SELECT COUNT(*) n FROM ' + table + " WHERE user_id = ? AND created_at >= datetime('now','localtime','-1 hour')").get(uid).n;
    if (n >= cfg.perHour) return { error: 'hourly', message: '一小时内最多' + cfg.label + ' ' + cfg.perHour + ' 次' };
  }
  return { ok: true };
}

/* ---------- 发主题 / 回复 / 编辑 ---------- */

function judge(user, text, fastSubmit) {
  const m = matchRules(text, forumRules());
  if (m.action === 'reject') return { blocked: true, hits: m.hits };
  const trusted = !!user && user.role === 'admin';
  const newbie = !trusted && countUserPosts(user.id) < NEWBIE_POST_LIMIT;
  const d = decideStatus({ trusted, newbie, ruleAction: m.action, fastSubmit });
  return { status: d.status, reason: d.reason, hits: m.hits };
}

export function createThread({ forumId, user, title, body, fastSubmit = false }) {
  const gate = forumGate(user);
  if (gate.error) return gate;
  // 站长不受发帖/举报限流约束（本人就是审核者；验收测试也会连续造帖）
  if (user.role !== 'admin') {
    const rate = checkRate('thread', user.id);
    if (rate.error) return rate;
  }
  const forum = db.prepare('SELECT * FROM forums WHERE id = ?').get(Number(forumId) || 0);
  if (!forum) return { error: 'no_forum', message: '没有这个板块' };
  const j = judge(user, title + '\n' + body, fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，发不出去', hits: j.hits };
  let threadId = 0;
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      'INSERT INTO forum_threads (forum_id, user_id, title, status, last_reply_at) VALUES (?, ?, ?, ?, datetime(\'now\',\'localtime\'))'
    ).run(forum.id, user.id, title, j.status);
    threadId = Number(r.lastInsertRowid);
    db.prepare(
      'INSERT INTO forum_posts (thread_id, user_id, body, status, is_op) VALUES (?, ?, ?, ?, 1)'
    ).run(threadId, user.id, body, j.status);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { id: threadId, slug: forum.slug, status: j.status, reason: j.reason, newbie: countUserPosts(user.id) < NEWBIE_POST_LIMIT };
}

export function createReply({ threadId, user, body, parentId = null, fastSubmit = false }) {
  const gate = forumGate(user);
  if (gate.error) return gate;
  const found = getThread(threadId, user);
  if (!found || !found.canView) return { error: 'not_found', message: '没有这个主题' };
  if (Number(found.thread.locked) && user.role !== 'admin') {
    return { error: 'locked', message: '这个主题已经锁定，不能再回复' };
  }
  // 站长不受发帖/举报限流约束（本人就是审核者；验收测试也会连续造帖）
  if (user.role !== 'admin') {
    const rate = checkRate('post', user.id);
    if (rate.error) return rate;
  }
  let parent = null;
  if (parentId) {
    parent = db.prepare('SELECT id, thread_id, user_id FROM forum_posts WHERE id = ?').get(Number(parentId) || 0);
    if (!parent || Number(parent.thread_id) !== Number(found.thread.id)) parent = null;
  }
  const j = judge(user, body, fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，发不出去', hits: j.hits };
  const r = db.prepare(
    'INSERT INTO forum_posts (thread_id, user_id, body, status, is_op, parent_id) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(found.thread.id, user.id, body, j.status, parent ? parent.id : null);
  if (j.status === 1) {
    db.prepare(
      "UPDATE forum_threads SET reply_count = reply_count + 1, last_reply_at = datetime('now','localtime') WHERE id = ?"
    ).run(found.thread.id);
  }
  return { id: Number(r.lastInsertRowid), status: j.status, reason: j.reason, ranked: !!parent };
}

/** 编辑自己的楼层（站长可编辑任何人的）；每次都写一条留痕 */
export function editPost({ postId, user, body, fastSubmit = false }) {
  const gate = forumGate(user);
  if (gate.error) return gate;
  const row = db.prepare('SELECT p.*, t.id AS tid FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id WHERE p.id = ?')
    .get(Number(postId) || 0);
  if (!row) return { error: 'not_found', message: '没有这一楼' };
  if (Number(row.user_id) !== Number(user.id) && user.role !== 'admin') {
    return { error: 'forbidden', message: '只能改自己的内容' };
  }
  if (body === row.body) return { ok: true, unchanged: true };
  const j = judge(user, body, fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，改不了', hits: j.hits };
  // 编辑过的内容一律重新进待审（作者是站长则直接公开），避免先发干净的再改成广告
  const status = user.role === 'admin' ? 1 : j.status === 1 ? 0 : j.status;
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE forum_posts SET body = ?, status = ?, edited_at = datetime('now','localtime'), edit_count = edit_count + 1 WHERE id = ?"
    ).run(body, status, row.id);
    // 首楼（楼主帖）被改回待审时，整个主题也跟着回待审：不然这条改动在后台哪一栏都看不到
    if (Number(row.is_op) === 1 && status === 0) {
      db.prepare('UPDATE forum_threads SET status = 0 WHERE id = ?').run(row.thread_id);
    }
    db.prepare(
      'INSERT INTO forum_post_edits (post_id, editor_id, before_body, after_body) VALUES (?, ?, ?, ?)'
    ).run(row.id, user.id, row.body, body);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, status, reason: status === 0 ? (j.reason || '编辑后重新进审核') : '' };
}

/* ---------- 举报 ---------- */

export function reportTarget({ targetType, targetId, user, reason, detail = '' }) {
  const gate = forumGate(user);
  if (gate.error) return gate;
  const type = targetType === 'thread' ? 'thread' : 'post';
  const id = Number(targetId) || 0;
  const rate = checkRate('report', user.id);
  if (rate.error) return rate;
  let exists = false;
  let threadId = 0;
  if (type === 'thread') {
    const t = getThread(id, user);
    exists = !!(t && t.canView);
    threadId = id;
  } else {
    const p = getPost(id, user);
    exists = !!p;
    if (p) threadId = Number(p.thread_id);
  }
  if (!exists) return { error: 'not_found', message: '要举报的内容不存在' };
  const r = db.prepare(
    'INSERT OR IGNORE INTO forum_reports (target_type, target_id, user_id, reason, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(type, id, user.id, String(reason || 'other').slice(0, 20), String(detail || '').slice(0, 200));
  return { ok: true, already: Number(r.changes) === 0, threadId };
}

export function listReports(status = 0, limit = 50) {
  const rows = db.prepare(
    'SELECT r.*, u.display_name AS reporter, ' +
    "COALESCE(tt.title, th.title) AS thread_title, " +
    "CASE WHEN r.target_type = 'thread' THEN tt.title ELSE substr(fp.body, 1, 120) END AS target_text, " +
    'COALESCE(tt.id, th.id) AS thread_id ' +
    'FROM forum_reports r LEFT JOIN users u ON u.id = r.user_id ' +
    'LEFT JOIN forum_threads tt ON r.target_type = \'thread\' AND tt.id = r.target_id ' +
    'LEFT JOIN forum_posts fp ON r.target_type = \'post\' AND fp.id = r.target_id ' +
    'LEFT JOIN forum_threads th ON th.id = fp.thread_id ' +
    'WHERE r.status = ? ORDER BY r.id DESC LIMIT ?'
  ).all(Number(status) || 0, Number(limit) || 50);
  return rows;
}

export function countReports(status = 0) {
  return db.prepare('SELECT COUNT(*) n FROM forum_reports WHERE status = ?').get(Number(status) || 0).n;
}

export function setReportStatus(id, status) {
  const s = Number(status) === 2 ? 2 : 1;
  db.prepare('UPDATE forum_reports SET status = ? WHERE id = ?').run(s, Number(id) || 0);
  return { ok: true, status: s };
}

/* ---------- 黑名单 ---------- */

export function listBlacklist() {
  return db.prepare('SELECT * FROM forum_blacklist ORDER BY id DESC').all();
}

export function addBlacklist({ pattern, kind = 'word', action = 'review', note = '' }) {
  const p = String(pattern || '').trim().slice(0, 200);
  if (!p) return { error: 'empty', message: '规则不能为空' };
  const k = kind === 'regex' ? 'regex' : 'word';
  if (k === 'regex') {
    try { new RegExp(p, 'i'); } catch { return { error: 'bad_regex', message: '正则写错了，编译不过' }; }
  }
  const a = action === 'reject' ? 'reject' : 'review';
  db.prepare('INSERT INTO forum_blacklist (pattern, kind, action, note) VALUES (?, ?, ?, ?)')
    .run(p, k, a, String(note || '').slice(0, 100));
  ruleCache = null; // 规则变了，立刻作废缓存，别等 10 秒
  return { ok: true };
}

export function deleteBlacklist(id) {
  db.prepare('DELETE FROM forum_blacklist WHERE id = ?').run(Number(id) || 0);
  ruleCache = null;
  return { ok: true };
}

let ruleCache = null;
const ruleCacheAt = { t: 0 };

/** 规则表很小，缓存 10 秒，免得每发一帖都查一次库 */
export function forumRules() {
  if (ruleCache && Date.now() - ruleCacheAt.t < 10000) return ruleCache;
  ruleCache = compileRules(listBlacklist().reverse());
  ruleCacheAt.t = Date.now();
  return ruleCache;
}

/* ---------- 人机校验用的一次性 nonce ---------- */

export function issueNonce(userId, kind = 'post') {
  const token = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO form_nonces (token, user_id, kind) VALUES (?, ?, ?)')
    .run(token, Number(userId) || null, String(kind || 'post').slice(0, 20));
  // 顺手清掉过期的一次性令牌，表不会一直长
  db.prepare("DELETE FROM form_nonces WHERE created_at < datetime('now','localtime','-" + (NONCE_TTL_MINUTES * 2) + " minutes')").run();
  return token;
}

/** 核销：必须存在、属于同一个人、没用过、没过期；成功后立刻写 used_at（防重放） */
export function consumeNonce(token, userId, kind = 'post') {
  const t = String(token || '').trim();
  if (!/^[0-9a-f]{32}$/.test(t)) return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  const row = db.prepare('SELECT * FROM form_nonces WHERE token = ?').get(t);
  if (!row || row.used_at || Number(row.user_id) !== Number(userId)) {
    return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  }
  const ttl = db.prepare(
    "SELECT (created_at < datetime('now','localtime','-" + NONCE_TTL_MINUTES + " minutes')) AS old FROM form_nonces WHERE token = ?"
  ).get(t);
  if (Number(ttl.old)) return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  db.prepare("UPDATE form_nonces SET used_at = datetime('now','localtime') WHERE token = ?").run(t);
  const dw = db.prepare(
    // 两边都取本地时间字符串再转 epoch，否则会被时区差算成一个负数
    "SELECT (strftime('%s','now','localtime') - strftime('%s', created_at)) * 1000 AS ms FROM form_nonces WHERE token = ?"
  ).get(t);
  return { ok: true, dwellMs: Number(dw.ms) || 0, kind: row.kind };
}

/* ---------- 审核队列与后台动作 ---------- */

export function listPendingThreads(limit = 50) {
  return db.prepare(
    // 待审列表多带一列正文（主题正文在首楼，所以要连上 is_op=1 那条楼层）：
    // 后台要能看到待审的原文，包括「首楼编辑后重新待审」的新正文
    'SELECT ' + THREAD_COLS + ', op.body AS body ' + THREAD_JOINS +
    'LEFT JOIN forum_posts op ON op.thread_id = t.id AND op.is_op = 1 WHERE t.status = 0 ORDER BY t.id ASC LIMIT ?'
  ).all(Number(limit) || 50).map(threadRow);
}

export function listPendingPosts(limit = 50) {
  return db.prepare(
    'SELECT ' + POST_COLS + ', t.title AS thread_title, t.id AS thread_id ' + POST_JOINS +
    'JOIN forum_threads t ON t.id = p.thread_id WHERE p.status = 0 AND p.is_op = 0 ORDER BY p.id ASC LIMIT ?'
  ).all(Number(limit) || 50);
}

export function setThreadStatus(id, status) {
  const s = [0, 1, 2].indexOf(Number(status)) >= 0 ? Number(status) : 1;
  const tid = Number(id) || 0;
  db.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').run(s, tid);
  // 主题通过/下架时，它的首楼跟着走；回复保持各自状态
  db.prepare('UPDATE forum_posts SET status = ? WHERE thread_id = ? AND is_op = 1').run(s === 2 ? 2 : s, tid);
  return { ok: true, status: s };
}

export function setPostStatus(id, status) {
  const s = Number(status) === 2 ? 2 : Number(status) === 0 ? 0 : 1;
  db.prepare('UPDATE forum_posts SET status = ? WHERE id = ?').run(s, Number(id) || 0);
  return { ok: true, status: s };
}

/**
 * 置顶 / 锁定 / 精华（后台动作）。actorRole 收角色字符串（'admin' / 'mod'）或 user 对象：
 * - 不传角色：既有后台路由的老调用路径（路由本身已过 requireAdmin），行为与以前完全一样；
 * - 传了角色：不是 admin/mod 就返回 { error: 'forbidden' }；
 * - featured 是新能力，必须显式带 admin/mod 角色（老路由不认识它，不传就当越权挡掉）。
 */
export function setThreadFlags(id, { featured, pinned, locked } = {}, actorRole) {
  if (actorRole !== undefined && actorRole !== null && !isModerator(actorRole)) return { error: 'forbidden' };
  if (featured !== undefined && !isModerator(actorRole)) return { error: 'forbidden' };
  const tid = Number(id) || 0;
  if (pinned !== undefined) db.prepare('UPDATE forum_threads SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, tid);
  if (locked !== undefined) db.prepare('UPDATE forum_threads SET locked = ? WHERE id = ?').run(locked ? 1 : 0, tid);
  if (featured !== undefined) db.prepare('UPDATE forum_threads SET featured = ? WHERE id = ?').run(featured ? 1 : 0, tid);
  return { ok: true };
}

/* ---------- 禁言 ---------- */

export function setUserMuted(id, minutes, reason = '') {
  const uid = Number(id) || 0;
  const m = Math.max(0, Math.min(Number(minutes) || 0, 60 * 24 * 365));
  if (!m) {
    db.prepare('UPDATE users SET muted_until = NULL, mute_reason = NULL WHERE id = ?').run(uid);
    return { ok: true, muted: false };
  }
  db.prepare("UPDATE users SET muted_until = datetime('now','localtime','+' || ? || ' minutes'), mute_reason = ? WHERE id = ?")
    .run(m, String(reason || '').slice(0, 100), uid);
  return { ok: true, muted: true, minutes: m };
}

export function listMuted(limit = 20) {
  return db.prepare(
    "SELECT id, username, display_name, muted_until, mute_reason FROM users " +
    "WHERE muted_until IS NOT NULL AND muted_until > datetime('now','localtime') ORDER BY muted_until LIMIT ?"
  ).all(Number(limit) || 20);
}

/* ---------- 主题标签 / 精华 / 置顶 ---------- */

/** 单个标签最长 16 字符（中文按 1 个字符算），一个主题最多 3 个 */
export const TAG_MAX = 16;
export const TAG_LIMIT = 3;
// 只留中文（含扩展 A）、英文字母、数字与 - _，其余（空白、标点、emoji）统统剔除
const TAG_STRIP = /[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9_-]/g;
const TAG_SPLIT = /[,，、\s]+/;

/** 版主及以上：站长（admin）与版主（mod）同一档。收角色字符串，也收整条 user */
export function isModerator(actor) {
  const role = typeof actor === 'string' ? actor : (actor && actor.role) || '';
  return role === 'admin' || role === 'mod';
}

/**
 * 标签清洗：切成一个个标签 → 剔掉中英数字与 - _ 之外的字符 → 去空、去重
 * → 单个截到 16 字符 → 最多留 3 个。数组或 "a,b" / "a b" 这样的字符串都收。
 */
export function cleanTags(tags) {
  const raw = Array.isArray(tags)
    ? tags
    : tags === undefined || tags === null || tags === ''
      ? []
      : String(tags).split(TAG_SPLIT);
  const list = [];
  for (const item of raw) {
    const tag = String(item === undefined || item === null ? '' : item).replace(TAG_STRIP, '').slice(0, TAG_MAX);
    if (!tag || list.indexOf(tag) >= 0) continue;
    list.push(tag);
    if (list.length >= TAG_LIMIT) break;
  }
  return list;
}

/** 行里的 tags 是 GROUP_CONCAT 拼出来的 "a,b"：还原成数组，没标签就是 [] */
function threadRow(row) {
  if (!row) return row;
  row.tags = row.tags ? String(row.tags).split(',') : [];
  return row;
}

/**
 * 列表排序。默认顺序与老代码逐字一致（置顶在前，各自按最新回复，再按 id 兜底）；
 * pinnedFirst 只是把「置顶优先」写得更直白：置顶内部一样按最新回复，
 * 以后默认顺序若要改，显式传 pinnedFirst 的调用方不会跟着变。
 */
function threadOrder(pinnedFirst) {
  const rest = 'COALESCE(t.last_reply_at, t.created_at) DESC, t.id DESC';
  return pinnedFirst
    ? 'ORDER BY CASE WHEN t.pinned = 1 THEN 0 ELSE 1 END, ' + rest
    : 'ORDER BY t.pinned DESC, ' + rest;
}

/** 标签云：只数已发布主题上的标签，用得多的排前面（同数按标签字典序） */
export function listTags(limit = 20) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db.prepare(
    'SELECT tt.tag AS tag, COUNT(*) AS count FROM thread_tags tt ' +
    'JOIN forum_threads t ON t.id = tt.thread_id WHERE t.status = 1 ' +
    'GROUP BY tt.tag ORDER BY COUNT(*) DESC, tt.tag ASC LIMIT ?'
  ).all(size).map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/** 按标签翻主题：薄封装，分页形状与 listThreads 完全一致（page / pageSize / viewerId / pinnedFirst 都能一起传） */
export function threadsByTag(tag, opts = {}) {
  return listThreads(Object.assign({}, opts, { tag }));
}

/**
 * 覆盖式设置某个主题的标签（先清后插，一个事务里做完）。
 * 只允许 admin/mod：返回 { ok: true, tags: 落库的标签 }；主题不存在 → { error: 'no_thread' }；
 * 权限不够 → { error: 'forbidden' }（新接口，不传角色也算没权限）。
 */
export function setThreadTags(threadId, tags, actorRole) {
  if (!isModerator(actorRole)) return { error: 'forbidden' };
  const tid = Number(threadId) || 0;
  const row = db.prepare('SELECT id FROM forum_threads WHERE id = ?').get(tid);
  if (!row) return { error: 'no_thread', message: '没有这个主题' };
  const list = cleanTags(tags);
  const del = db.prepare('DELETE FROM thread_tags WHERE thread_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO thread_tags (thread_id, tag) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    del.run(tid);
    for (const tag of list) ins.run(tid, tag);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, tags: list };
}

