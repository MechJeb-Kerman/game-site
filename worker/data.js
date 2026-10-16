/**
 * D1 版数据层：与 src/data.js 一一对应，区别只有三处
 *   1) 每个函数第一个参数是 D1 数据库绑定（env.DB），查询都是异步的；
 *   2) LIKE 的转义符用 '~'（避免反斜杠在 JS 字符串和 SQL 里转义两次），语义不变；
 *   3) 批量改状态走 db.batch（D1 没有可交互事务），不再手写 BEGIN/COMMIT。
 */
import { buildSearchIndex, queryVariants } from '../src/pinyin.js';
import { validateHtmlUpload, UGC_PREFIX } from '../src/upload.js';

const SELECT_BASE =
  'SELECT g.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon ' +
  'FROM games g LEFT JOIN categories c ON c.id = g.category_id ';

/** 绑定参数：D1 的 prepare() 不带参数，必须 bind() 出新的语句对象 */
function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

function safeParse(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function mapGame(row) {
  if (!row) return null;
  const g = Object.assign({}, row);
  g.tags = safeParse(row.tags);
  g.category = row.category_slug
    ? { slug: row.category_slug, name: row.category_name, icon: row.category_icon }
    : null;
  return g;
}

/** 转义 LIKE 通配符，避免用户输入 % 或 _ 时全表命中 */
function likeEscape(s) {
  return String(s).replace(/[~%_]/g, (m) => '~' + m);
}

/**
 * 搜索条件工厂：中文照常匹配文本，拉丁查询额外命中拼音索引；
 * 同时给出相关度打分表达式（0 最相关，8 最不相关），分数存在 search_score 列里。
 * 注意参数顺序：scoreParams 在 SELECT 里，先于 WHERE 的 whereParams 绑定。
 */
function searchPlan(q) {
  const raw = String(q || '').trim().toLowerCase();
  if (!raw) return null;
  const starts = likeEscape(raw) + '%';
  const like = '%' + likeEscape(raw) + '%';
  // 中文查询会带上全拼 / 首字母两个变体，拉丁查询只有一个变体
  const terms = queryVariants(raw).map((t) => likeEscape(t));
  const scoreSql = "CASE" +
    " WHEN LOWER(g.title) = ? THEN 0" +
    " WHEN LOWER(g.title) LIKE ? ESCAPE '~' THEN 1" +
    " WHEN LOWER(g.title) LIKE ? ESCAPE '~' THEN 2" +
    " WHEN LOWER(g.search_pinyin) LIKE ? ESCAPE '~' THEN 3" +
    " WHEN LOWER(g.search_pinyin) LIKE ? ESCAPE '~' THEN 4" +
    " WHEN LOWER(g.subtitle) LIKE ? ESCAPE '~' THEN 5" +
    " WHEN LOWER(g.tags) LIKE ? ESCAPE '~' THEN 6" +
    " WHEN LOWER(g.description) LIKE ? ESCAPE '~' THEN 7" +
    " ELSE 8 END AS search_score";
  const scoreParams = [raw, starts, like, starts, like, like, like, like];
  const one = "(LOWER(g.title) LIKE ? ESCAPE '~' OR LOWER(g.subtitle) LIKE ? ESCAPE '~'" +
    " OR LOWER(g.description) LIKE ? ESCAPE '~' OR LOWER(g.tags) LIKE ? ESCAPE '~'" +
    " OR LOWER(g.search_pinyin) LIKE ? ESCAPE '~')";
  const whereSql = '(' + terms.map(() => one).join(' OR ') + ')';
  const whereParams = [];
  for (const t of terms) whereParams.push('%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%');
  return { raw, scoreSql, scoreParams, whereSql, whereParams };
}

const SORTS = {
  // 末位用 id 兜底，保证 0 播放 / 0 评分时排序稳定
  hot: 'g.plays DESC, g.rating DESC, g.id ASC',
  new: 'g.id DESC',
  rating: 'g.rating DESC, g.rating_count DESC, g.id ASC',
  title: 'g.title ASC'
};

/** 查询游戏列表（可选 q / category / tag / sort / limit / offset） */
export async function listGames(db, opts) {
  const o = opts || {};
  const category = String(o.category || '');
  const tag = String(o.tag || '');
  const where = ['g.status = 1'];
  const params = [];

  const plan = searchPlan(o.q);
  let base = SELECT_BASE;
  let order = SORTS[String(o.sort || 'hot')] || SORTS.hot;
  if (plan) {
    // 打分列进 SELECT；有搜索词时相关度永远优先，同分再按选择的排序
    base = SELECT_BASE.replace('FROM games g', ', ' + plan.scoreSql + ' FROM games g');
    params.push.apply(params, plan.scoreParams);
    where.push(plan.whereSql);
    params.push.apply(params, plan.whereParams);
    order = 'search_score ASC, ' + order;
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag) { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }

  const limit = Math.max(1, Math.min(100, Number(o.limit) || 24));
  const offset = Math.max(0, Number(o.offset) || 0);
  const sql = base + ' WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?';
  const rows = await stmt(db, sql, params.concat([limit, offset])).all();
  return rows.results.map(mapGame);
}

export async function countGames(db, opts) {
  const o = opts || {};
  const where = ['g.status = 1'];
  const params = [];
  const plan = searchPlan(o.q);
  if (plan) { where.push(plan.whereSql); params.push.apply(params, plan.whereParams); }
  if (String(o.category || '')) { where.push('c.slug = ?'); params.push(String(o.category)); }
  if (String(o.tag || '')) { where.push('g.tags LIKE ?'); params.push('%"' + String(o.tag) + '"%'); }
  const sql = 'SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id WHERE ' + where.join(' AND ');
  const row = await stmt(db, sql, params).first();
  return row ? row.n : 0;
}

/**
 * 一条游戏记录的拼音检索串来源：标题、副标题、分类名、标签、简介前 120 字。
 * 简介太长会撑爆索引，截断即可。
 */
export function gameSearchSource(g = {}) {
  return [g.title, g.subtitle, g.category_name, (g.tags || []).join(' '), String(g.description || '').slice(0, 120)];
}

/** 写入 / 刷新单条游戏的 search_pinyin */
export async function refreshSearchIndex(db, id) {
  const row = await db.prepare(SELECT_BASE + ' WHERE g.id = ?').bind(id).first();
  if (!row) return false;
  const g = mapGame(row);
  await db.prepare('UPDATE games SET search_pinyin = ? WHERE id = ?')
    .bind(buildSearchIndex(gameSearchSource(g)), id).run();
  return true;
}

/**
 * 给所有还没有拼音索引的游戏补一份（老库升级、种子数据变更后调用）。
 * @param {boolean} force 为 true 时全量重建
 */
export async function reindexSearchIndex(db, force = false) {
  const rows = await db.prepare('SELECT g.id FROM games g' +
    (force ? '' : " WHERE g.search_pinyin IS NULL OR g.search_pinyin = ''")).all();
  for (const r of rows.results) await refreshSearchIndex(db, r.id);
  return rows.results.length;
}

export async function getGame(db, slug) {
  const row = await db.prepare(SELECT_BASE + ' WHERE g.slug = ? AND g.status = 1').bind(slug).first();
  return mapGame(row || null);
}

/** 同分类 / 同标签的相关游戏 */
export async function relatedGames(db, game, limit) {
  if (!game) return [];
  const rows = await db.prepare(SELECT_BASE +
    ' WHERE g.status = 1 AND g.id != ? ORDER BY (g.category_id = ?) DESC, g.plays DESC LIMIT ?')
    .bind(game.id, game.category_id, limit || 8).all();
  return rows.results.map(mapGame);
}

export async function listCategories(db) {
  const rows = await db.prepare(
    'SELECT c.*, COUNT(g.id) AS total FROM categories c ' +
    'LEFT JOIN games g ON g.category_id = c.id AND g.status = 1 ' +
    'GROUP BY c.id ORDER BY c.sort ASC'
  ).all();
  return rows.results;
}

export async function getCategory(db, slug) {
  return (await db.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first()) || null;
}

/** 全部标签 + 出现次数，按热度排序 */
export async function listTags(db, limit) {
  const rows = await db.prepare('SELECT tags, plays FROM games WHERE status = 1').all();
  const map = new Map();
  for (const row of rows.results) {
    for (const t of safeParse(row.tags)) map.set(t, (map.get(t) || 0) + 1);
  }
  return Array.from(map.entries())
    .map((e) => ({ name: e[0], count: e[1] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit);
}

/** 游玩 +1，并记录日志，返回新的累计次数（游戏不存在返回 null） */
export async function incrementPlay(db, slug) {
  const g = await db.prepare('SELECT id FROM games WHERE slug = ?').bind(slug).first();
  if (!g) return null;
  await db.batch([
    db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').bind(g.id),
    db.prepare("INSERT INTO play_logs (game_id, day) VALUES (?, date('now','localtime'))").bind(g.id)
  ]);
  const after = await db.prepare('SELECT plays FROM games WHERE id = ?').bind(g.id).first();
  return after.plays;
}

export async function siteStats(db) {
  const row = await db.prepare(
    'SELECT (SELECT COUNT(*) FROM games WHERE status = 1) AS games, ' +
    '(SELECT COALESCE(SUM(plays),0) FROM games WHERE status = 1) AS plays'
  ).first();
  return { games: row.games, plays: row.plays };
}

/* ---------- 评分 ---------- */

/** 写入/覆盖一个访客对某游戏的评分（一人一票、可改票），并把聚合结果回写到 games */
export async function rateGame(db, slug, visitor, stars) {
  const n = Math.round(Number(stars));
  if (!Number.isInteger(n) || n < 1 || n > 5) return { error: 'bad_stars' };
  if (!visitor) return { error: 'no_visitor' };

  const g = await db.prepare('SELECT id FROM games WHERE slug = ? AND status = 1').bind(slug).first();
  if (!g) return { error: 'not_found' };

  const before = await db.prepare('SELECT stars FROM ratings WHERE game_id = ? AND visitor = ?')
    .bind(g.id, visitor).first();

  await db.batch([
    db.prepare('INSERT INTO ratings (game_id, visitor, stars) VALUES (?, ?, ?) ' +
      "ON CONFLICT(game_id, visitor) DO UPDATE SET stars = excluded.stars, updated_at = datetime('now','localtime')")
      .bind(g.id, visitor, n)
  ]);

  const agg = await db.prepare('SELECT COUNT(*) AS c, AVG(stars) AS avg FROM ratings WHERE game_id = ?')
    .bind(g.id).first();
  const avg = Math.round(agg.avg * 10) / 10;
  await db.prepare('UPDATE games SET rating = ?, rating_count = ? WHERE id = ?')
    .bind(avg, agg.c, g.id).run();

  return { stars: n, previous: before ? before.stars : 0, isNew: !before, rating: avg, count: agg.c };
}

/** 当前访客对某游戏已给出的星级（0 = 还没评过） */
export async function myRating(db, slug, visitor) {
  if (!visitor) return 0;
  const row = await db.prepare(
    'SELECT r.stars FROM ratings r JOIN games g ON g.id = r.game_id WHERE g.slug = ? AND r.visitor = ?'
  ).bind(slug, visitor).first();
  return row ? row.stars : 0;
}

/* ================= 用户内容：收藏 / 评论 ================= */

export const COMMENT_PAGE_SIZE = 10;   // 顶层评论每页条数
export const REPLY_PREVIEW = 20;       // 每条顶层评论一次最多带出的回复数

const COMMENT_COLS = 'c.id, c.body, c.created_at, c.parent_id, u.id AS user_id, u.display_name AS name';

/** 某游戏的可见顶层评论（新的在前，分页） */
export async function listComments(db, slug, opts = {}) {
  const size = Math.max(1, Math.min(50, Number(opts.pageSize) || COMMENT_PAGE_SIZE));
  const totalRow = await db.prepare('SELECT COUNT(*) AS n FROM comments c' +
    ' JOIN games g ON g.id = c.game_id' +
    ' WHERE g.slug = ? AND c.status = 1 AND c.parent_id IS NULL').bind(slug).first();
  const total = totalRow ? totalRow.n : 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(1, Math.min(pages, Number(opts.page) || 1));
  const rows = await stmt(db, 'SELECT ' + COMMENT_COLS +
    ' FROM comments c JOIN users u ON u.id = c.user_id JOIN games g ON g.id = c.game_id' +
    ' WHERE g.slug = ? AND c.status = 1 AND c.parent_id IS NULL' +
    ' ORDER BY c.id DESC LIMIT ? OFFSET ?', [slug, size, (page - 1) * size]).all();
  return { items: rows.results.map((r) => Object.assign({}, r, { replies: [], reply_total: 0 })), total, page, pages, pageSize: size };
}

/** 给一页顶层评论补上回复（只查这一页的 parent_id，避免全表扫） */
export async function attachReplies(db, thread) {
  const ids = thread.items.map((c) => c.id);
  if (!ids.length) return thread;
  const holes = ids.map(() => '?').join(',');
  const rows = await stmt(db, 'SELECT ' + COMMENT_COLS +
    ' FROM comments c JOIN users u ON u.id = c.user_id' +
    ' WHERE c.parent_id IN (' + holes + ') AND c.status = 1' +
    ' ORDER BY c.id ASC', ids).all();
  const byRoot = new Map(thread.items.map((c) => [c.id, c]));
  for (const r of rows.results) {
    const root = byRoot.get(r.parent_id);
    if (!root) continue;
    root.reply_total++;
    if (root.replies.length < REPLY_PREVIEW) root.replies.push(r);
  }
  return thread;
}

/** 详情页用：分页 + 回复一次取好 */
export async function commentThread(db, slug, page = 1, pageSize = COMMENT_PAGE_SIZE) {
  const thread = await listComments(db, slug, { page, pageSize });
  return attachReplies(db, thread);
}

/** 全部可见评论数（顶层 + 回复），详情页「玩家评论」角标用 */
export async function countComments(db, slug) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM comments c' +
    ' JOIN games g ON g.id = c.game_id WHERE g.slug = ? AND c.status = 1').bind(slug).first();
  return row ? row.n : 0;
}

export const COMMENT_MAX = 500;

/**
 * 发一条评论或回复。
 * 只做两级（楼中楼）：回复「回复」时自动挂到同一顶层评论下，并在正文前带上 @昵称。
 * @returns {{error:string}|{id:number, body:string, parent_id:number|null}}
 */
export async function addComment(db, slug, userId, body, parentId = null) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if (text.length > COMMENT_MAX) return { error: 'too_long' };
  const g = await db.prepare('SELECT id FROM games WHERE slug = ? AND status = 1').bind(slug).first();
  if (!g) return { error: 'not_found' };

  let root = null;
  let finalText = text;
  if (parentId) {
    const par = await db.prepare('SELECT id, parent_id, user_id, status FROM comments WHERE id = ? AND game_id = ?')
      .bind(Number(parentId), g.id).first();
    if (!par || !Number(par.status)) return { error: 'bad_parent' };
    root = par.parent_id ? par.parent_id : par.id;
    // 回复「回复」时补一个 @ 提醒（正文已经以 @ 开头就不重复加）
    if (par.parent_id && !finalText.startsWith('@')) {
      const who = await db.prepare('SELECT display_name AS name FROM users WHERE id = ?').bind(par.user_id).first();
      finalText = '@' + (who ? who.name : '某人') + ' ' + finalText;
      if (finalText.length > COMMENT_MAX) finalText = finalText.slice(0, COMMENT_MAX);
    }
  }

  const info = await db.prepare('INSERT INTO comments (game_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)')
    .bind(g.id, userId, finalText, root).run();
  return { id: Number(info.meta.last_row_id), body: finalText, parent_id: root, name: null };
}

/* ---------- 举报 ---------- */

export const REPORT_MAX = 200;
export const REPORT_REASONS = ['spam', 'abuse', 'spoiler', 'other'];
export const REPORT_LABEL = { spam: '垃圾广告', abuse: '辱骂攻击', spoiler: '剧透', other: '其他' };

async function reportCount(db, commentId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ? AND status = 0')
    .bind(Number(commentId)).first();
  return row ? row.n : 0;
}

/**
 * 举报一条评论：同一用户对同一条只记一次（UNIQUE 冲突就当已举报）。
 * @returns {{error:string}|{reported:boolean, count:number, already:boolean}}
 */
export async function reportComment(db, commentId, userId, reason = 'other') {
  const r = String(reason || 'other').slice(0, 20);
  if (REPORT_REASONS.indexOf(r) < 0) return { error: 'bad_reason' };
  const c = await db.prepare('SELECT id, status FROM comments WHERE id = ?').bind(Number(commentId)).first();
  if (!c || !Number(c.status)) return { error: 'not_found' };
  const seen = await db.prepare('SELECT id FROM comment_reports WHERE comment_id = ? AND user_id = ?')
    .bind(Number(commentId), userId).first();
  if (seen) return { reported: true, already: true, count: await reportCount(db, commentId) };
  await db.prepare('INSERT INTO comment_reports (comment_id, user_id, reason) VALUES (?, ?, ?)')
    .bind(Number(commentId), userId, r).run();
  return { reported: true, already: false, count: await reportCount(db, commentId) };
}

/** 后台：待处理举报（带评论正文与游戏） */
export async function listReports(db, status = 0, limit = 50) {
  const rows = await stmt(db, 'SELECT r.id, r.reason, r.status, r.created_at,' +
    ' c.id AS comment_id, c.body, c.status AS comment_status,' +
    ' u.display_name AS reporter, cu.display_name AS author, g.title, g.slug' +
    ' FROM comment_reports r' +
    ' JOIN comments c ON c.id = r.comment_id' +
    ' JOIN users u  ON u.id = r.user_id' +
    ' JOIN users cu ON cu.id = c.user_id' +
    ' JOIN games g  ON g.id = c.game_id' +
    ' WHERE r.status = ? ORDER BY r.id DESC LIMIT ?', [Number(status) || 0, limit]).all();
  return rows.results;
}

export async function countReports(db, status = 0) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM comment_reports WHERE status = ?')
    .bind(Number(status) || 0).first();
  return row ? row.n : 0;
}

/** 处理举报：1 已处理（顺手隐藏评论）/ 2 忽略 */
export async function setReportStatus(db, id, status) {
  const s = Number(status) === 2 ? 2 : 1;
  const info = await db.prepare('UPDATE comment_reports SET status = ? WHERE id = ?').bind(s, Number(id)).run();
  return info.meta.changes ? { status: s } : { error: 'not_found' };
}

/** 收藏 / 取消收藏，返回 { error } 或 { favorited, count } */
export async function toggleFavorite(db, slug, userId) {
  const g = await db.prepare('SELECT id FROM games WHERE slug = ? AND status = 1').bind(slug).first();
  if (!g) return { error: 'not_found' };
  const has = await db.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND game_id = ?')
    .bind(userId, g.id).first();
  if (has) {
    await db.prepare('DELETE FROM favorites WHERE user_id = ? AND game_id = ?').bind(userId, g.id).run();
  } else {
    await db.prepare('INSERT INTO favorites (user_id, game_id) VALUES (?, ?)').bind(userId, g.id).run();
  }
  const n = await db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE game_id = ?').bind(g.id).first();
  return { favorited: !has, count: n.n };
}

export async function favoriteCount(db, slug) {
  const g = await db.prepare('SELECT id FROM games WHERE slug = ?').bind(slug).first();
  if (!g) return 0;
  const n = await db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE game_id = ?').bind(g.id).first();
  return n.n;
}

export async function isFavorited(db, slug, userId) {
  if (!userId) return false;
  const row = await db.prepare(
    'SELECT 1 AS x FROM favorites f JOIN games g ON g.id = f.game_id WHERE g.slug = ? AND f.user_id = ?'
  ).bind(slug, userId).first();
  return !!row;
}

/** 我的收藏（按收藏时间倒序） */
export async function listFavorites(db, userId) {
  const rows = await db.prepare(SELECT_BASE +
    ' INNER JOIN favorites f ON f.game_id = g.id WHERE f.user_id = ? AND g.status = 1 ' +
    'ORDER BY f.created_at DESC, g.id DESC').bind(userId).all();
  return rows.results.map(mapGame);
}

/* ================= 投稿与后台 ================= */

export const STATUS_LABEL = { 0: '已下架', 1: '已上架', 2: '待审核' };
export function statusLabel(n) { return STATUS_LABEL[Number(n)] || '未知'; }

/** 标题转 slug：中文也能留，其余字符折成短横线 */
export function slugify(title) {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'game';
}

export async function uniqueSlug(db, title) {
  const base = slugify(title);
  let slug = base;
  for (let i = 2; await db.prepare('SELECT 1 AS x FROM games WHERE slug = ?').bind(slug).first(); i++) {
    slug = base + '-' + i;
  }
  return slug;
}

/* ---------- 投稿上传的单文件 HTML ---------- */

/** 读投稿上传的文件（没有就是 null） */
export async function getGameFile(db, slug) {
  return (await db.prepare('SELECT slug, filename, size, html, created_at FROM game_files WHERE slug = ?').bind(String(slug)).first()) || null;
}

/** 写入/覆盖投稿上传的文件（D1 没有 upsert 之外的技巧，用 ON CONFLICT 保持与 SQLite 侧一致） */
export async function saveGameFile(db, slug, filename, html) {
  const text = String(html);
  const size = new TextEncoder().encode(text).length;
  await db.prepare(
    'INSERT INTO game_files (slug, filename, size, html) VALUES (?, ?, ?, ?)' +
    ' ON CONFLICT(slug) DO UPDATE SET filename = excluded.filename, size = excluded.size, html = excluded.html'
  ).bind(String(slug), String(filename || '').slice(0, 120), size, text).run();
  return size;
}

/** 投稿失败时回滚用 */
export async function deleteGameFile(db, slug) {
  await db.prepare('DELETE FROM game_files WHERE slug = ?').bind(String(slug)).run();
}

/**
 * 用户投稿：写进 games 但 status = 2（待审核），管理员通过后才上架。
 * 两种投法二选一：①上传自包含的 .html（存 game_files，game_url 记成 /ugc/<slug>.html）②填已有地址。上传优先。
 */
export async function createSubmission(db, f, userId) {
  const title = String(f.title || '').trim().slice(0, 40);
  const file = f.file && typeof f.file === 'object' ? f.file : null;
  let url = String(f.game_url || '').trim().slice(0, 300);
  if (title.length < 2) return { error: '请填写游戏名称（至少 2 个字）' };

  let upload = null;
  if (file) {
    const check = validateHtmlUpload(file.name, file.html);
    if (check.error) return { error: check.error };
    upload = { filename: file.name, html: String(file.html) };
  } else if (!/^(https?:\/\/|\/)/.test(url)) {
    return { error: '请上传单文件 HTML 游戏（.html），或填写已有的游戏地址 /games/xxx/index.html' };
  }

  const cat = await getCategory(db, String(f.category || '').trim());
  const tags = String(f.tags || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  const slug = await uniqueSlug(db, title);
  if (upload) url = UGC_PREFIX + slug + '.html';
  await db.prepare(
    'INSERT INTO games (slug, title, subtitle, description, category_id, game_url,' +
    ' width, height, orientation, tags, emoji, accent, accent2, license, status, submitted_by)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)'
  ).bind(
    slug, title,
    String(f.subtitle || '').trim().slice(0, 60) || null,
    String(f.description || '').trim().slice(0, 600) || null,
    cat ? cat.id : null,
    url,
    Math.max(200, Math.min(2000, Number(f.width) || 800)),
    Math.max(200, Math.min(2000, Number(f.height) || 600)),
    String(f.orientation || 'landscape') === 'portrait' ? 'portrait' : 'landscape',
    JSON.stringify(tags),
    String(f.emoji || '🎮').slice(0, 4),
    String(f.accent || '#6366f1').slice(0, 9),
    String(f.accent2 || '#8b5cf6').slice(0, 9),
    String(f.license || '投稿').slice(0, 40),
    userId
  ).run();
  if (upload) {
    try {
      await saveGameFile(db, slug, upload.filename, upload.html);
    } catch (err) {
      await db.prepare('DELETE FROM games WHERE slug = ?').bind(slug).run();
      return { error: '保存上传的文件失败：' + (err && err.message ? err.message : err) };
    }
  }
  const row = await db.prepare('SELECT id FROM games WHERE slug = ?').bind(slug).first();
  if (row) await refreshSearchIndex(db, row.id);
  return { slug, id: row ? Number(row.id) : 0, uploaded: !!upload };
}

/** 后台：按状态列出游戏（含未上架的） */
export async function listGamesByStatus(db, status, limit) {
  const rows = await db.prepare(SELECT_BASE + ' WHERE g.status = ? ORDER BY g.id DESC LIMIT ?')
    .bind(Number(status), limit || 100).all();
  return rows.results.map(mapGame);
}

/** 后台：管理列表的公共条件（关键字 + 状态 + 分类） */
function managedWhere(opts) {
  const o = opts || {};
  const status = o.status;
  const where = [];
  const params = [];
  if (status !== null && status !== '' && status !== undefined) { where.push('g.status = ?'); params.push(Number(status)); }
  if (String(o.q || '').trim()) {
    const like = '%' + likeEscape(String(o.q).trim()).toLowerCase() + '%';
    where.push("(LOWER(g.title) LIKE ? ESCAPE '~' OR LOWER(g.slug) LIKE ? ESCAPE '~' OR LOWER(g.search_pinyin) LIKE ? ESCAPE '~')");
    params.push(like, like, like);
  }
  if (String(o.category || '')) { where.push('c.slug = ?'); params.push(String(o.category)); }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

/**
 * 后台游戏列表：可带状态 / 关键字（标题、slug、拼音）/ 分类，支持分页。
 * @param {{status?:number|string|null,q?:string,category?:string,limit?:number,offset?:number}} opts
 */
export async function listManagedGames(db, opts = {}) {
  const w = managedWhere(opts);
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const rows = await stmt(db, SELECT_BASE + w.sql +
    ' ORDER BY g.status DESC, g.plays DESC, g.id ASC LIMIT ? OFFSET ?', w.params.concat([limit, offset])).all();
  return rows.results.map(mapGame);
}

export async function countManagedGames(db, opts = {}) {
  const w = managedWhere(opts);
  const row = await stmt(db, 'SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id' + w.sql, w.params).first();
  return row ? row.n : 0;
}

/** 后台预览投稿用：不看 status 也能取到 */
export async function getGameAny(db, slug) {
  const row = await db.prepare(SELECT_BASE + ' WHERE g.slug = ?').bind(String(slug)).first();
  return mapGame(row || null);
}

export async function setGameStatus(db, slug, status) {
  const s = Number(status);
  if ([0, 1, 2].indexOf(s) < 0) return { error: 'bad_status' };
  const res = await db.prepare('UPDATE games SET status = ? WHERE slug = ?').bind(s, String(slug)).run();
  return res.meta.changes ? { status: s } : { error: 'not_found' };
}

/**
 * 批量上下架：一次 batch 改多条，返回 { changed, missing }。
 * missing 里的 slug 是没找到的，前端可以提示。D1 用 batch 代替手写事务。
 */
export async function setGamesStatus(db, slugs, status) {
  const s = Number(status);
  if ([0, 1, 2].indexOf(s) < 0) return { error: 'bad_status' };
  const list = [...new Set([].concat(slugs || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);
  if (!list.length) return { error: 'empty' };
  const holes = list.map(() => '?').join(',');
  const found = await stmt(db, 'SELECT id, slug FROM games WHERE slug IN (' + holes + ')', list).all();
  const byslug = new Map(found.results.map((r) => [r.slug, r.id]));
  const changed = [];
  const missing = [];
  const stmts = [];
  for (const slug of list) {
    const id = byslug.get(slug);
    if (!id) { missing.push(slug); continue; }
    stmts.push(db.prepare('UPDATE games SET status = ? WHERE id = ?').bind(s, id));
    changed.push(slug);
  }
  if (stmts.length) await db.batch(stmts);
  return { status: s, changed, missing };
}

/* ---------- 彻底删除 ---------- */

/** 彻底删除前的连带数据量，确认页与审计日志共用（D1 版） */
export async function gamePurgeInfo(db, slug) {
  const g = await stmt(db, 'SELECT id, slug, title, status, emoji FROM games WHERE slug = ?', [String(slug)]).first();
  if (!g) return null;
  const one = async (sql, params) => (await stmt(db, sql, params).first()).n;
  return {
    slug: g.slug,
    id: g.id,
    title: g.title,
    emoji: g.emoji || '',
    status: Number(g.status),
    comments: await one('SELECT COUNT(*) n FROM comments WHERE game_id = ?', [g.id]),
    reports: await one('SELECT COUNT(*) n FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE game_id = ?)', [g.id]),
    ratings: await one('SELECT COUNT(*) n FROM ratings WHERE game_id = ?', [g.id]),
    favorites: await one('SELECT COUNT(*) n FROM favorites WHERE game_id = ?', [g.id]),
    plays: await one('SELECT COUNT(*) n FROM play_logs WHERE game_id = ?', [g.id]),
    file: await one('SELECT COUNT(*) n FROM game_files WHERE slug = ?', [g.slug])
  };
}

/** 彻底删除（D1 版）：必须先下架；批量语句在一个事务里执行 */
export async function deleteGame(db, slug) {
  const info = await gamePurgeInfo(db, slug);
  if (!info) return { error: 'not_found' };
  if (info.status === 1) return { error: 'online' };
  const one = (sql) => db.prepare(sql).bind(info.id);
  await db.batch([
    one('DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE game_id = ?)'),
    one('DELETE FROM comments WHERE game_id = ?'),
    one('DELETE FROM ratings WHERE game_id = ?'),
    one('DELETE FROM favorites WHERE game_id = ?'),
    one('DELETE FROM play_logs WHERE game_id = ?'),
    db.prepare('DELETE FROM game_files WHERE slug = ?').bind(info.slug),
    db.prepare('DELETE FROM games WHERE id = ?').bind(info.id)
  ]);
  return { info };
}

/* ---------- 账号管理 ---------- */

/** 后台用户列表：带评论数、投稿数、是否封禁 */
export async function listUsers(db, opts = {}) {
  const params = [];
  let where = '';
  if (String(opts.q || '').trim()) {
    where = " WHERE LOWER(u.username) LIKE ? ESCAPE '~' OR LOWER(u.display_name) LIKE ? ESCAPE '~' OR LOWER(IFNULL(u.email,'')) LIKE ? ESCAPE '~'";
    const like = '%' + likeEscape(String(opts.q).trim()).toLowerCase() + '%';
    params.push(like, like, like);
  }
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const rows = await stmt(db, 'SELECT u.id, u.username, u.display_name, u.role, u.email, u.email_verified,' +
    ' u.banned, u.banned_reason, u.created_at,' +
    ' (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.status = 1) AS comments,' +
    ' (SELECT COUNT(*) FROM games g2 WHERE g2.submitted_by = u.id) AS submissions' +
    ' FROM users u' + where + ' ORDER BY u.banned DESC, u.id ASC LIMIT ? OFFSET ?',
    params.concat([limit, offset])).all();
  return rows.results;
}

export async function countUsers(db, q = '') {
  if (!String(q).trim()) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    return row ? row.n : 0;
  }
  const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
  const row = await stmt(db, 'SELECT COUNT(*) AS n FROM users u' +
    " WHERE LOWER(u.username) LIKE ? ESCAPE '~' OR LOWER(u.display_name) LIKE ? ESCAPE '~'" +
    " OR LOWER(IFNULL(u.email,'')) LIKE ? ESCAPE '~'", [like, like, like]).first();
  return row ? row.n : 0;
}

/** 封禁 / 解封。封禁时顺手把该用户的会话全部踢掉 */
export async function setUserBanned(db, id, banned, reason = '') {
  const uid = Number(id);
  const row = await db.prepare('SELECT id, role FROM users WHERE id = ?').bind(uid).first();
  if (!row) return { error: 'not_found' };
  if (row.role === 'admin') return { error: 'cannot_ban_admin' };
  const b = banned ? 1 : 0;
  const stmts = [db.prepare('UPDATE users SET banned = ?, banned_reason = ? WHERE id = ?')
    .bind(b, b ? String(reason || '').slice(0, 200) : null, uid)];
  if (b) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid));
  await db.batch(stmts);
  return { banned: !!b };
}

/** 后台：最近评论（含被隐藏的、带父评论与待处理举报数） */
export async function listRecentComments(db, opts = {}) {
  const o = typeof opts === 'number' ? { limit: opts } : (opts || {});
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 30));
  const offset = Math.max(0, Number(o.offset) || 0);
  const rows = await db.prepare('SELECT c.id, c.body, c.status, c.parent_id, c.created_at,' +
    ' u.display_name AS name, g.title, g.slug,' +
    ' (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id AND r.status = 0) AS reports' +
    ' FROM comments c JOIN users u ON u.id = c.user_id JOIN games g ON g.id = c.game_id' +
    ' ORDER BY c.id DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
  return rows.results;
}

export async function countAllComments(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM comments').first();
  return row ? row.n : 0;
}

export async function setCommentStatus(db, id, status) {
  const s = Number(status) ? 1 : 0;
  const res = await db.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(s, Number(id)).run();
  return res.meta.changes ? { status: s } : { error: 'not_found' };
}

/* ---------- 操作日志 ---------- */

/**
 * 记一条后台操作。actor 传登录用户对象即可。
 * action 用「域.动作」的短标识，例如 game.status / games.batch / user.ban。
 */
export async function logAudit(db, actor, action, target = '', detail = '') {
  await db.prepare('INSERT INTO audit_logs (actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(actor ? Number(actor.id) || null : null,
      actor ? String(actor.display_name || actor.username || '').slice(0, 40) : '系统',
      String(action || '').slice(0, 40),
      String(target || '').slice(0, 80),
      String(detail || '').slice(0, 200)).run();
}

/** 后台：操作日志（倒序，支持按动作/操作人/目标过滤） */
export async function listAudit(db, opts = {}) {
  const params = [];
  let where = '';
  if (String(opts.q || '').trim()) {
    where = " WHERE LOWER(IFNULL(a.actor_name,'')) LIKE ? ESCAPE '~' OR LOWER(a.action) LIKE ? ESCAPE '~' OR LOWER(a.target) LIKE ? ESCAPE '~'";
    const like = '%' + likeEscape(String(opts.q).trim()).toLowerCase() + '%';
    params.push(like, like, like);
  }
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const rows = await stmt(db, 'SELECT a.id, a.actor_name, a.action, a.target, a.detail, a.created_at FROM audit_logs a' +
    where + ' ORDER BY a.id DESC LIMIT ? OFFSET ?', params.concat([limit, offset])).all();
  return rows.results;
}

export async function countAudit(db, q = '') {
  if (!String(q).trim()) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM audit_logs').first();
    return row ? row.n : 0;
  }
  const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
  const row = await stmt(db, 'SELECT COUNT(*) AS n FROM audit_logs a' +
    " WHERE LOWER(IFNULL(a.actor_name,'')) LIKE ? ESCAPE '~' OR LOWER(a.action) LIKE ? ESCAPE '~'" +
    " OR LOWER(a.target) LIKE ? ESCAPE '~'", [like, like, like]).first();
  return row ? row.n : 0;
}

export async function adminStats(db) {
  return await db.prepare(
    'SELECT' +
    ' (SELECT COUNT(*) FROM games WHERE status = 1) AS published,' +
    ' (SELECT COUNT(*) FROM games WHERE status = 2) AS pending,' +
    ' (SELECT COUNT(*) FROM games WHERE status = 0) AS offline,' +
    ' (SELECT COUNT(*) FROM users) AS users,' +
    ' (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,' +
    ' (SELECT COUNT(*) FROM comments WHERE status = 1) AS comments,' +
    ' (SELECT COUNT(*) FROM comment_reports WHERE status = 0) AS reports,' +
    ' (SELECT COUNT(*) FROM favorites) AS favorites'
  ).first();
}

/* ================= 排行榜 ================= */

export const BOARD_KINDS = {
  today:  { label: '今日热玩', metric: 'plays', range: "p.day = date('now','localtime')", prev: "p.day = date('now','localtime','-1 day')" },
  week:   { label: '本周热玩', metric: 'plays', range: "p.day >= date('now','localtime','-6 days')", prev: "p.day >= date('now','localtime','-13 days') AND p.day < date('now','localtime','-6 days')" },
  month:  { label: '本月热玩', metric: 'plays', range: "p.day >= date('now','localtime','-29 days')", prev: "p.day >= date('now','localtime','-59 days') AND p.day < date('now','localtime','-29 days')" },
  all:    { label: '总播放榜', metric: 'plays_all' },
  rating: { label: '最高评分', metric: 'rating' },
  fav:    { label: '收藏榜',   metric: 'fav' },
  new:    { label: '最新上架', metric: 'new' }
};

export const BOARD_LABEL = Object.fromEntries(Object.entries(BOARD_KINDS).map(function (e) { return [e[0], e[1].label]; }));

/** 排行榜种类校验，URL 里传了乱七八糟的值一律回落到 today */
export function boardKind(kind) {
  const k = String(kind || '').trim();
  return BOARD_KINDS[k] ? k : 'today';
}

const BOARD_COLS = 'g.id, g.slug, g.title, g.emoji, g.accent, g.accent2, g.plays, g.rating, g.rating_count, c.name AS category_name';

/**
 * 排行榜数据。热玩榜靠 play_logs 按天聚合（纯 SQLite，不需要 Redis）。
 * @param {string} kind today|week|month|all|rating|fav|new
 * @param {number} limit 条数（1-50）
 */
export async function leaderboard(db, kind = 'today', limit = 20) {
  const k = boardKind(kind);
  const spec = BOARD_KINDS[k];
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  let rows;

  if (spec.metric === 'plays') {
    rows = await stmt(db, 'SELECT ' + BOARD_COLS + ', COUNT(p.id) AS value' +
      ' FROM play_logs p JOIN games g ON g.id = p.game_id' +
      ' LEFT JOIN categories c ON c.id = g.category_id' +
      ' WHERE g.status = 1 AND ' + spec.range +
      ' GROUP BY g.id HAVING value > 0' +
      ' ORDER BY value DESC, g.plays DESC, g.id ASC LIMIT ?', [n]).all();
  } else if (spec.metric === 'plays_all') {
    rows = await stmt(db, 'SELECT ' + BOARD_COLS + ', g.plays AS value' +
      ' FROM games g LEFT JOIN categories c ON c.id = g.category_id' +
      ' WHERE g.status = 1' +
      ' ORDER BY g.plays DESC, g.id ASC LIMIT ?', [n]).all();
  } else if (spec.metric === 'rating') {
    rows = await stmt(db, 'SELECT ' + BOARD_COLS + ', g.rating AS value' +
      ' FROM games g LEFT JOIN categories c ON c.id = g.category_id' +
      ' WHERE g.status = 1 AND g.rating_count > 0' +
      ' ORDER BY g.rating DESC, g.rating_count DESC, g.id ASC LIMIT ?', [n]).all();
  } else if (spec.metric === 'fav') {
    rows = await stmt(db, 'SELECT ' + BOARD_COLS + ', COUNT(f.game_id) AS value' +
      ' FROM games g LEFT JOIN categories c ON c.id = g.category_id' +
      ' LEFT JOIN favorites f ON f.game_id = g.id' +
      ' WHERE g.status = 1' +
      ' GROUP BY g.id ORDER BY value DESC, g.plays DESC, g.id ASC LIMIT ?', [n]).all();
  } else {
    rows = await stmt(db, 'SELECT ' + BOARD_COLS + ', g.id AS value' +
      ' FROM games g LEFT JOIN categories c ON c.id = g.category_id' +
      ' WHERE g.status = 1' +
      ' ORDER BY g.id DESC LIMIT ?', [n]).all();
  }

  // 环比：上一个周期的名次，用来看「↑3 / ↓2 / 新上榜」
  const prevRank = new Map();
  if (spec.metric === 'plays') {
    const prev = await stmt(db, 'SELECT g.slug AS slug, COUNT(p.id) AS value' +
      ' FROM play_logs p JOIN games g ON g.id = p.game_id' +
      ' WHERE g.status = 1 AND ' + spec.prev +
      ' GROUP BY g.id HAVING value > 0' +
      ' ORDER BY value DESC, g.plays DESC, g.id ASC', []).all();
    prev.results.map(function (r, i) { prevRank.set(r.slug, i + 1); });
  }

  const list = rows.results.map(function (r, i) {
    const rank = i + 1;
    const before = prevRank.get(r.slug) || null;
    return {
      rank: rank,
      slug: r.slug,
      title: r.title,
      emoji: r.emoji,
      accent: r.accent,
      accent2: r.accent2,
      category: r.category_name,
      value: Number(r.value) || 0,
      plays: r.plays,
      rating: r.rating,
      rating_count: r.rating_count,
      // 有上一周期数据时才显示涨跌，否则按「新上榜」显示
      hasPrev: prevRank.size > 0,
      prevRank: before,
      move: before ? before - rank : null
    };
  });

  return { kind: k, label: spec.label, metric: spec.metric, rows: list };
}

/** 单个游戏最近 N 天的游玩次数（详情页展示） */
export async function recentPlays(db, slug, days = 1) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM play_logs p' +
    ' JOIN games g ON g.id = p.game_id' +
    " WHERE g.slug = ? AND p.day >= date('now','localtime', ?)")
    .bind(String(slug), '-' + Math.max(0, Number(days) - 1) + ' days').first();
  return row ? row.n : 0;
}

/** 榜单页 / 后台头部的全站概览：今日、近 7 天、近 14 天趋势 */
export async function boardOverview(db) {
  const t = await db.prepare("SELECT COUNT(*) AS n FROM play_logs WHERE day = date('now','localtime')").first();
  const w = await db.prepare("SELECT COUNT(*) AS n FROM play_logs WHERE day >= date('now','localtime','-6 days')").first();
  const trend = await db.prepare('SELECT day, COUNT(*) AS n FROM play_logs' +
    " WHERE day >= date('now','localtime','-13 days')" +
    ' GROUP BY day ORDER BY day ASC').all();
  return { today: t ? t.n : 0, week: w ? w.n : 0, trend: trend.results };
}
