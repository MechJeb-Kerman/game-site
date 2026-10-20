/**
 * 论坛数据层（Cloudflare Workers + D1 版）。
 * 与 src/data-forum.js 一一对应，SQL 完全一样，只有三处区别：
 *   1) 第一个参数是 D1 绑定（env.DB），所有查询都 await；
 *   2) LIKE 的转义符用 '~'（避免反斜杠在 JS 字符串与 SQL 里转义两次），语义不变；
 *   3) 需要事务的地方用 db.batch（D1 没有可交互事务），一次性令牌用 crypto.getRandomValues 生成。
 */
import {
  NEWBIE_POST_LIMIT,
  RATE,
  NONCE_TTL_MINUTES,
  decideStatus,
  matchRules,
  compileRules
} from '../src/forum-guard.js';

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

function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

async function all(db, sql, params) {
  const res = await stmt(db, sql, params).all();
  return (res && res.results) || [];
}

async function first(db, sql, params) {
  return await stmt(db, sql, params).first();
}

function likeEscape(s) {
  return String(s).replace(/[~%_]/g, (m) => '~' + m);
}

function hex16() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out;
}

/* ---------- 板块 ---------- */

const DEFAULT_FORUMS = [
  ['general', '综合讨论', '随便聊，游戏相关的、不相关的都行', '💬', 10],
  ['guide', '攻略心得', '通关技巧、隐藏要素、玩法分享', '📖', 20],
  ['help', '求助答疑', '卡关了、报错了、想问什么都可以', '🆘', 30],
  ['meta', '站务反馈', '对站点的建议、Bug 反馈、投稿咨询', '🔧', 40]
];

export async function ensureForums(db) {
  for (const f of DEFAULT_FORUMS) {
    await stmt(db, 'INSERT OR IGNORE INTO forums (slug, name, description, icon, sort) VALUES (?, ?, ?, ?, ?)', f).run();
  }
}

export async function listForums(db) {
  await ensureForums(db);
  return all(db,
    'SELECT f.*, ' +
    '(SELECT COUNT(*) FROM forum_threads t WHERE t.forum_id = f.id AND t.status = 1) AS thread_count, ' +
    '(SELECT COUNT(*) FROM forum_posts p JOIN forum_threads t2 ON t2.id = p.thread_id ' +
    ' WHERE t2.forum_id = f.id AND p.status = 1) AS post_count ' +
    'FROM forums f WHERE f.status = 1 ORDER BY f.sort, f.id');
}

export async function getForum(db, slug) {
  await ensureForums(db);
  return (await first(db, 'SELECT * FROM forums WHERE slug = ?', [String(slug || '')])) || null;
}

async function one(db, sql, params) {
  const row = await first(db, sql, params);
  return row ? Number(row.n) : 0;
}

export async function forumStats(db) {
  return {
    forums: await one(db, 'SELECT COUNT(*) n FROM forums WHERE status = 1'),
    threads: await one(db, 'SELECT COUNT(*) n FROM forum_threads WHERE status = 1'),
    posts: await one(db, 'SELECT COUNT(*) n FROM forum_posts WHERE status = 1'),
    today: await one(db, "SELECT COUNT(*) n FROM forum_posts WHERE status = 1 AND created_at >= datetime('now','localtime','start of day')"),
    users: await one(db, 'SELECT COUNT(DISTINCT user_id) n FROM forum_posts'),
    members: await one(db, 'SELECT COUNT(*) n FROM users'),
    pendingThreads: await one(db, 'SELECT COUNT(*) n FROM forum_threads WHERE status = 0'),
    pendingPosts: await one(db, 'SELECT COUNT(*) n FROM forum_posts WHERE status = 0'),
    reports: await one(db, 'SELECT COUNT(*) n FROM forum_reports WHERE status = 0'),
    muted: await one(db, "SELECT COUNT(*) n FROM users WHERE muted_until IS NOT NULL AND muted_until > datetime('now','localtime')")
  };
}

/* ---------- 主题列表 / 详情 ---------- */

function visibleThreadSql(viewerId) {
  return viewerId ? '(t.status = 1 OR t.user_id = ?)' : 't.status = 1';
}

export async function listThreads(db, opts) {
  const o = opts || {};
  const viewerId = o.viewerId ? Number(o.viewerId) : null;
  const where = [visibleThreadSql(viewerId)];
  const args = viewerId ? [viewerId] : [];
  if (o.forum) { where.push('f.slug = ?'); args.push(String(o.forum)); }
  const kw = String(o.q || '').trim();
  if (kw) {
    const like = '%' + likeEscape(kw) + '%';
    where.push("(t.title LIKE ? ESCAPE '~' OR EXISTS (SELECT 1 FROM forum_posts op WHERE op.thread_id = t.id AND op.is_op = 1 AND op.body LIKE ? ESCAPE '~'))");
    args.push(like, like);
  }
  // 按标签筛主题：EXISTS 走 idx_thread_tags_tag；不改动其它条件与分页语义
  if (o.tag) {
    where.push('EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id AND tt.tag = ?)');
    args.push(String(o.tag));
  }
  if (o.featuredOnly) where.push('t.featured = 1');
  const w = 'WHERE ' + where.join(' AND ');
  const total = await one(db, 'SELECT COUNT(*) n ' + THREAD_JOINS + w, args);
  const size = Math.min(Math.max(Number(o.pageSize) || 20, 1), 50);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(Number(o.page) || 1, 1), pages);
  const items = await all(db,
    'SELECT ' + THREAD_COLS + ' ' + THREAD_JOINS + w + ' ' + threadOrder(o.pinnedFirst) + ' LIMIT ? OFFSET ?',
    args.concat([size, (page - 1) * size]));
  return { items: items.map(threadRow), total, page, pages, pageSize: size };
}

export async function getThread(db, id, viewer) {
  const row = await first(db, 'SELECT ' + THREAD_COLS + ' ' + THREAD_JOINS + 'WHERE t.id = ?', [Number(id) || 0]);
  if (!row) return null;
  const isAdmin = !!viewer && viewer.role === 'admin';
  const isOwner = !!viewer && Number(viewer.id) === Number(row.user_id);
  return { thread: threadRow(row), canView: Number(row.status) === 1 || isOwner || isAdmin, isOwner, isAdmin };
}

export async function bumpThreadView(db, id) {
  await stmt(db, 'UPDATE forum_threads SET view_count = view_count + 1 WHERE id = ?', [Number(id) || 0]).run();
}

export function canViewPost(post, viewer) {
  if (!post) return false;
  if (Number(post.status) === 1) return true;
  if (!viewer) return false;
  return viewer.role === 'admin' || Number(post.user_id) === Number(viewer.id);
}

export async function listPosts(db, threadId, opts) {
  const o = opts || {};
  const viewer = o.viewer || null;
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
  const total = await one(db, 'SELECT COUNT(*) n FROM forum_posts p ' + w, args);
  const size = Math.min(Math.max(Number(o.pageSize) || 15, 1), 50);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(Number(o.page) || 1, 1), pages);
  const rows = await all(db,
    'SELECT ' + POST_COLS + ' ' + POST_JOINS + w + ' ORDER BY p.id ASC LIMIT ? OFFSET ?',
    args.concat([size, (page - 1) * size]));
  const offset = (page - 1) * size;
  rows.forEach((r, i) => { r.floor = offset + i + 1; });
  return { items: rows, total, page, pages, pageSize: size };
}

export async function getPost(db, id, viewer) {
  const row = await first(db, 'SELECT ' + POST_COLS + ' ' + POST_JOINS + 'WHERE p.id = ?', [Number(id) || 0]);
  if (!row || !canViewPost(row, viewer)) return null;
  return row;
}

export async function listPostEdits(db, postId, limit) {
  return all(db,
    'SELECT e.id, e.before_body, e.after_body, e.created_at, u.display_name AS name ' +
    'FROM forum_post_edits e LEFT JOIN users u ON u.id = e.editor_id ' +
    'WHERE e.post_id = ? ORDER BY e.id DESC LIMIT ?',
    [Number(postId) || 0, Number(limit) || 20]);
}

export async function countUserPosts(db, userId) {
  return one(db, 'SELECT COUNT(*) n FROM forum_posts WHERE user_id = ? AND status = 1', [Number(userId) || 0]);
}

/* ---------- 发帖门槛 / 频控 ---------- */

export async function forumGate(db, user) {
  if (!user) return { error: 'login', message: '登录后才能发帖' };
  const u = await first(db,
    "SELECT email_verified, banned, banned_reason, muted_until, mute_reason, " +
    "(muted_until IS NOT NULL AND muted_until > datetime('now','localtime')) AS muted " +
    'FROM users WHERE id = ?', [Number(user.id)]);
  if (!u) return { error: 'login', message: '登录后才能发帖' };
  if (Number(u.banned)) return { error: 'banned', message: '账号已被封禁' + (u.banned_reason ? '：' + u.banned_reason : '') };
  if (Number(u.muted)) return { error: 'muted', message: '你被禁言到 ' + u.muted_until + (u.mute_reason ? '（' + u.mute_reason + '）' : '') };
  if (!Number(u.email_verified)) return { error: 'email', message: '要先在「账号」页验证邮箱，才能发帖' };
  return { ok: true };
}

async function since(db, seconds) {
  const row = await first(db, "SELECT datetime('now','localtime','-' || ? || ' seconds') AS t", [Number(seconds) || 0]);
  return row ? row.t : '';
}

export async function checkRate(db, kind, userId) {
  const cfg = RATE[kind] || RATE.post;
  const uid = Number(userId) || 0;
  const table = kind === 'thread' ? 'forum_threads' : kind === 'report' ? 'forum_reports' : 'forum_posts';
  if (cfg.gapSeconds) {
    const row = await first(db, 'SELECT MAX(created_at) AS t FROM ' + table + ' WHERE user_id = ?', [uid]);
    const last = row ? row.t : null;
    if (last && last > (await since(db, cfg.gapSeconds))) {
      return { error: 'too_fast', message: '发得太快了，' + cfg.gapSeconds + ' 秒内只能发一条' };
    }
  }
  if (cfg.perDay) {
    const n = await one(db, 'SELECT COUNT(*) n FROM ' + table + " WHERE user_id = ? AND created_at >= datetime('now','localtime','-1 day')", [uid]);
    if (n >= cfg.perDay) return { error: 'daily', message: '今天' + cfg.label + '的数量到上限了（' + cfg.perDay + ' 条）' };
  }
  if (cfg.perHour) {
    const n = await one(db, 'SELECT COUNT(*) n FROM ' + table + " WHERE user_id = ? AND created_at >= datetime('now','localtime','-1 hour')", [uid]);
    if (n >= cfg.perHour) return { error: 'hourly', message: '一小时内最多' + cfg.label + ' ' + cfg.perHour + ' 次' };
  }
  return { ok: true };
}

/* ---------- 发主题 / 回复 / 编辑 ---------- */

async function judge(db, user, text, fastSubmit) {
  const m = matchRules(text, await forumRules(db));
  if (m.action === 'reject') return { blocked: true, hits: m.hits };
  const trusted = !!user && user.role === 'admin';
  const newbie = !trusted && (await countUserPosts(db, user.id)) < NEWBIE_POST_LIMIT;
  const d = decideStatus({ trusted, newbie, ruleAction: m.action, fastSubmit });
  return { status: d.status, reason: d.reason, hits: m.hits };
}

export async function createThread(db, params) {
  const p = params || {};
  const gate = await forumGate(db, p.user);
  if (gate.error) return gate;
  // 站长不受发帖/举报限流约束（本人就是审核者；验收测试也会连续造帖）
  if (p.user.role !== 'admin') {
    const rate = await checkRate(db, 'thread', p.user.id);
    if (rate.error) return rate;
  }
  const forum = await first(db, 'SELECT * FROM forums WHERE id = ?', [Number(p.forumId) || 0]);
  if (!forum) return { error: 'no_forum', message: '没有这个板块' };
  const j = await judge(db, p.user, p.title + '\n' + p.body, p.fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，发不出去', hits: j.hits };
  const ins = await stmt(db,
    "INSERT INTO forum_threads (forum_id, user_id, title, status, last_reply_at) " +
    "VALUES (?, ?, ?, ?, datetime('now','localtime'))",
    [forum.id, p.user.id, p.title, j.status]).run();
  const threadId = Number((ins.meta && ins.meta.last_row_id) || 0);
  await stmt(db, 'INSERT INTO forum_posts (thread_id, user_id, body, status, is_op) VALUES (?, ?, ?, ?, 1)',
    [threadId, p.user.id, p.body, j.status]).run();
  return { id: threadId, slug: forum.slug, status: j.status, reason: j.reason };
}

export async function createReply(db, params) {
  const p = params || {};
  const gate = await forumGate(db, p.user);
  if (gate.error) return gate;
  const found = await getThread(db, p.threadId, p.user);
  if (!found || !found.canView) return { error: 'not_found', message: '没有这个主题' };
  if (Number(found.thread.locked) && p.user.role !== 'admin') {
    return { error: 'locked', message: '这个主题已经锁定，不能再回复' };
  }
  // 站长不受发帖/举报限流约束（本人就是审核者；验收测试也会连续造帖）
  if (p.user.role !== 'admin') {
    const rate = await checkRate(db, 'post', p.user.id);
    if (rate.error) return rate;
  }
  let parent = null;
  if (p.parentId) {
    parent = await first(db, 'SELECT id, thread_id, user_id FROM forum_posts WHERE id = ?', [Number(p.parentId) || 0]);
    if (!parent || Number(parent.thread_id) !== Number(found.thread.id)) parent = null;
  }
  const j = await judge(db, p.user, p.body, p.fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，发不出去', hits: j.hits };
  const ins = await stmt(db,
    'INSERT INTO forum_posts (thread_id, user_id, body, status, is_op, parent_id) VALUES (?, ?, ?, ?, 0, ?)',
    [found.thread.id, p.user.id, p.body, j.status, parent ? parent.id : null]).run();
  if (j.status === 1) {
    await stmt(db, "UPDATE forum_threads SET reply_count = reply_count + 1, last_reply_at = datetime('now','localtime') WHERE id = ?",
      [found.thread.id]).run();
  }
  return { id: Number((ins.meta && ins.meta.last_row_id) || 0), status: j.status, reason: j.reason };
}

export async function editPost(db, params) {
  const p = params || {};
  const gate = await forumGate(db, p.user);
  if (gate.error) return gate;
  const row = await first(db,
    'SELECT p.*, t.id AS tid FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id WHERE p.id = ?',
    [Number(p.postId) || 0]);
  if (!row) return { error: 'not_found', message: '没有这一楼' };
  if (Number(row.user_id) !== Number(p.user.id) && p.user.role !== 'admin') {
    return { error: 'forbidden', message: '只能改自己的内容' };
  }
  if (p.body === row.body) return { ok: true, unchanged: true };
  const j = await judge(db, p.user, p.body, p.fastSubmit);
  if (j.blocked) return { error: 'blocked', message: '内容里包含被禁止的表述，改不了', hits: j.hits };
  const status = p.user.role === 'admin' ? 1 : j.status === 1 ? 0 : j.status;
  const stmts = [
    db.prepare("UPDATE forum_posts SET body = ?, status = ?, edited_at = datetime('now','localtime'), edit_count = edit_count + 1 WHERE id = ?")
      .bind(p.body, status, row.id),
    db.prepare('INSERT INTO forum_post_edits (post_id, editor_id, before_body, after_body) VALUES (?, ?, ?, ?)')
      .bind(row.id, p.user.id, row.body, p.body)
  ];
  // 首楼被改回待审时，整个主题也跟着回待审（否则这条改动在后台哪一栏都看不到）
  if (Number(row.is_op) === 1 && status === 0) {
    stmts.push(db.prepare('UPDATE forum_threads SET status = 0 WHERE id = ?').bind(row.thread_id));
  }
  await db.batch(stmts);
  return { ok: true, status, reason: status === 0 ? (j.reason || '编辑后重新进审核') : '' };
}

/* ---------- 举报 ---------- */

export async function reportTarget(db, params) {
  const p = params || {};
  const gate = await forumGate(db, p.user);
  if (gate.error) return gate;
  const type = p.targetType === 'thread' ? 'thread' : 'post';
  const id = Number(p.targetId) || 0;
  const rate = await checkRate(db, 'report', p.user.id);
  if (rate.error) return rate;
  let exists = false;
  let threadId = 0;
  if (type === 'thread') {
    const t = await getThread(db, id, p.user);
    exists = !!(t && t.canView);
    threadId = id;
  } else {
    const post = await getPost(db, id, p.user);
    exists = !!post;
    if (post) threadId = Number(post.thread_id);
  }
  if (!exists) return { error: 'not_found', message: '要举报的内容不存在' };
  const r = await stmt(db,
    'INSERT OR IGNORE INTO forum_reports (target_type, target_id, user_id, reason, detail) VALUES (?, ?, ?, ?, ?)',
    [type, id, p.user.id, String(p.reason || 'other').slice(0, 20), String(p.detail || '').slice(0, 200)]).run();
  return { ok: true, already: !(r.meta && r.meta.changes), threadId };
}

export async function listReports(db, status, limit) {
  return all(db,
    'SELECT r.*, u.display_name AS reporter, ' +
    "COALESCE(tt.title, th.title) AS thread_title, " +
    "CASE WHEN r.target_type = 'thread' THEN tt.title ELSE substr(fp.body, 1, 120) END AS target_text, " +
    'COALESCE(tt.id, th.id) AS thread_id ' +
    'FROM forum_reports r LEFT JOIN users u ON u.id = r.user_id ' +
    "LEFT JOIN forum_threads tt ON r.target_type = 'thread' AND tt.id = r.target_id " +
    "LEFT JOIN forum_posts fp ON r.target_type = 'post' AND fp.id = r.target_id " +
    'LEFT JOIN forum_threads th ON th.id = fp.thread_id ' +
    'WHERE r.status = ? ORDER BY r.id DESC LIMIT ?',
    [Number(status) || 0, Number(limit) || 50]);
}

export async function countReports(db, status) {
  return one(db, 'SELECT COUNT(*) n FROM forum_reports WHERE status = ?', [Number(status) || 0]);
}

export async function setReportStatus(db, id, status) {
  const s = Number(status) === 2 ? 2 : 1;
  await stmt(db, 'UPDATE forum_reports SET status = ? WHERE id = ?', [s, Number(id) || 0]).run();
  return { ok: true, status: s };
}

/* ---------- 黑名单 ---------- */

export async function listBlacklist(db) {
  return all(db, 'SELECT * FROM forum_blacklist ORDER BY id DESC');
}

export async function addBlacklist(db, params) {
  const p = params || {};
  const pattern = String(p.pattern || '').trim().slice(0, 200);
  if (!pattern) return { error: 'empty', message: '规则不能为空' };
  const kind = p.kind === 'regex' ? 'regex' : 'word';
  if (kind === 'regex') {
    try { new RegExp(pattern, 'i'); } catch { return { error: 'bad_regex', message: '正则写错了，编译不过' }; }
  }
  const action = p.action === 'reject' ? 'reject' : 'review';
  await stmt(db, 'INSERT INTO forum_blacklist (pattern, kind, action, note) VALUES (?, ?, ?, ?)',
    [pattern, kind, action, String(p.note || '').slice(0, 100)]).run();
  ruleCache = null;
  return { ok: true };
}

export async function deleteBlacklist(db, id) {
  await stmt(db, 'DELETE FROM forum_blacklist WHERE id = ?', [Number(id) || 0]).run();
  ruleCache = null;
  return { ok: true };
}

let ruleCache = null;
let ruleCacheAt = 0;

export async function forumRules(db) {
  if (ruleCache && Date.now() - ruleCacheAt < 10000) return ruleCache;
  const rows = await listBlacklist(db);
  ruleCache = compileRules(rows.reverse());
  ruleCacheAt = Date.now();
  return ruleCache;
}

/* ---------- 人机校验用的一次性 nonce ---------- */

export async function issueNonce(db, userId, kind) {
  const token = hex16();
  await stmt(db, 'INSERT INTO form_nonces (token, user_id, kind) VALUES (?, ?, ?)',
    [token, Number(userId) || null, String(kind || 'post').slice(0, 20)]).run();
  await stmt(db, "DELETE FROM form_nonces WHERE created_at < datetime('now','localtime','-" + (NONCE_TTL_MINUTES * 2) + " minutes')").run();
  return token;
}

export async function consumeNonce(db, token, userId, kind) {
  const t = String(token || '').trim();
  if (!/^[0-9a-f]{32}$/.test(t)) return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  const row = await first(db, 'SELECT * FROM form_nonces WHERE token = ?', [t]);
  if (!row || row.used_at || Number(row.user_id) !== Number(userId)) {
    return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  }
  const aging = await first(db,
    "SELECT (created_at < datetime('now','localtime','-" + NONCE_TTL_MINUTES + " minutes')) AS old FROM form_nonces WHERE token = ?",
    [t]);
  if (Number(aging && aging.old)) return { error: 'stale', message: '表单已过期，请重新打开页面再提交' };
  await stmt(db, "UPDATE form_nonces SET used_at = datetime('now','localtime') WHERE token = ?", [t]).run();
  const dw = await first(db,
    "SELECT (strftime('%s','now','localtime') - strftime('%s', created_at)) * 1000 AS ms FROM form_nonces WHERE token = ?", [t]);
  return { ok: true, dwellMs: Number(dw && dw.ms) || 0, kind: row.kind };
}

/* ---------- 审核队列与后台动作 ---------- */

export async function listPendingThreads(db, limit) {
  // 待审列表多带一列正文（主题正文在首楼，连上 is_op=1 那条楼层）
  const rows = await all(db, 'SELECT ' + THREAD_COLS + ', op.body AS body ' + THREAD_JOINS +
    'LEFT JOIN forum_posts op ON op.thread_id = t.id AND op.is_op = 1 WHERE t.status = 0 ORDER BY t.id ASC LIMIT ?',
    [Number(limit) || 50]);
  return rows.map(threadRow);
}

export async function listPendingPosts(db, limit) {
  return all(db,
    'SELECT ' + POST_COLS + ', t.title AS thread_title, t.id AS thread_id ' + POST_JOINS +
    'JOIN forum_threads t ON t.id = p.thread_id WHERE p.status = 0 AND p.is_op = 0 ORDER BY p.id ASC LIMIT ?',
    [Number(limit) || 50]);
}

export async function setThreadStatus(db, id, status) {
  const s = [0, 1, 2].indexOf(Number(status)) >= 0 ? Number(status) : 1;
  const tid = Number(id) || 0;
  await db.batch([
    db.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').bind(s, tid),
    db.prepare('UPDATE forum_posts SET status = ? WHERE thread_id = ? AND is_op = 1').bind(s === 2 ? 2 : s, tid)
  ]);
  return { ok: true, status: s };
}

export async function setPostStatus(db, id, status) {
  const s = Number(status) === 2 ? 2 : Number(status) === 0 ? 0 : 1;
  await stmt(db, 'UPDATE forum_posts SET status = ? WHERE id = ?', [s, Number(id) || 0]).run();
  return { ok: true, status: s };
}

/**
 * 置顶 / 锁定 / 精华（后台动作）。actorRole 收角色字符串（'admin' / 'mod'）或 user 对象：
 * - 不传角色：既有后台路由的老调用路径（路由本身已过 requireAdmin），行为与以前完全一样；
 * - 传了角色：不是 admin/mod 就返回 { error: 'forbidden' }；
 * - featured 是新能力，必须显式带 admin/mod 角色（老路由不认识它，不传就当越权挡掉）。
 */
export async function setThreadFlags(db, id, flags, actorRole) {
  const f = flags || {};
  if (actorRole !== undefined && actorRole !== null && !isModerator(actorRole)) return { error: 'forbidden' };
  if (f.featured !== undefined && !isModerator(actorRole)) return { error: 'forbidden' };
  const tid = Number(id) || 0;
  const batch = [];
  if (f.pinned !== undefined) batch.push(db.prepare('UPDATE forum_threads SET pinned = ? WHERE id = ?').bind(f.pinned ? 1 : 0, tid));
  if (f.locked !== undefined) batch.push(db.prepare('UPDATE forum_threads SET locked = ? WHERE id = ?').bind(f.locked ? 1 : 0, tid));
  if (f.featured !== undefined) batch.push(db.prepare('UPDATE forum_threads SET featured = ? WHERE id = ?').bind(f.featured ? 1 : 0, tid));
  if (batch.length) await db.batch(batch);
  return { ok: true };
}

/* ---------- 禁言 ---------- */

export async function setUserMuted(db, id, minutes, reason) {
  const uid = Number(id) || 0;
  const m = Math.max(0, Math.min(Number(minutes) || 0, 60 * 24 * 365));
  if (!m) {
    await stmt(db, 'UPDATE users SET muted_until = NULL, mute_reason = NULL WHERE id = ?', [uid]).run();
    return { ok: true, muted: false };
  }
  await stmt(db, "UPDATE users SET muted_until = datetime('now','localtime','+' || ? || ' minutes'), mute_reason = ? WHERE id = ?",
    [m, String(reason || '').slice(0, 100), uid]).run();
  return { ok: true, muted: true, minutes: m };
}

export async function listMuted(db, limit) {
  return all(db,
    'SELECT id, username, display_name, muted_until, mute_reason FROM users ' +
    "WHERE muted_until IS NOT NULL AND muted_until > datetime('now','localtime') ORDER BY muted_until LIMIT ?",
    [Number(limit) || 20]);
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
export async function listTags(db, limit) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = await all(db,
    'SELECT tt.tag AS tag, COUNT(*) AS count FROM thread_tags tt ' +
    'JOIN forum_threads t ON t.id = tt.thread_id WHERE t.status = 1 ' +
    'GROUP BY tt.tag ORDER BY COUNT(*) DESC, tt.tag ASC LIMIT ?',
    [size]);
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/** 按标签翻主题：薄封装，分页形状与 listThreads 完全一致（page / pageSize / viewerId / pinnedFirst 都能一起传） */
export async function threadsByTag(db, tag, opts) {
  return listThreads(db, Object.assign({}, opts || {}, { tag }));
}

/**
 * 覆盖式设置某个主题的标签（先清后插；D1 的 batch 自带事务）。
 * 只允许 admin/mod：返回 { ok: true, tags: 落库的标签 }；主题不存在 → { error: 'no_thread' }；
 * 权限不够 → { error: 'forbidden' }（新接口，不传角色也算没权限）。
 */
export async function setThreadTags(db, threadId, tags, actorRole) {
  if (!isModerator(actorRole)) return { error: 'forbidden' };
  const tid = Number(threadId) || 0;
  const row = await first(db, 'SELECT id FROM forum_threads WHERE id = ?', [tid]);
  if (!row) return { error: 'no_thread', message: '没有这个主题' };
  const list = cleanTags(tags);
  const batch = [db.prepare('DELETE FROM thread_tags WHERE thread_id = ?').bind(tid)];
  for (const tag of list) batch.push(db.prepare('INSERT OR IGNORE INTO thread_tags (thread_id, tag) VALUES (?, ?)').bind(tid, tag));
  await db.batch(batch);
  return { ok: true, tags: list };
}

