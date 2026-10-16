import { db } from './db.js';
import { buildSearchIndex, queryVariants } from './pinyin.js';

const SELECT_BASE = `
  SELECT g.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon
  FROM games g
  LEFT JOIN categories c ON c.id = g.category_id
`;

function safeParse(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function mapGame(row) {
  if (!row) return null;
  return {
    ...row,
    tags: safeParse(row.tags),
    category: row.category_slug
      ? { slug: row.category_slug, name: row.category_name, icon: row.category_icon }
      : null
  };
}

/** 转义 LIKE 通配符，避免用户输入 % 或 _ 时全表命中 */
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
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
  const scoreSql = `CASE
      WHEN LOWER(g.title) = ? THEN 0
      WHEN LOWER(g.title) LIKE ? ESCAPE '\\' THEN 1
      WHEN LOWER(g.title) LIKE ? ESCAPE '\\' THEN 2
      WHEN LOWER(g.search_pinyin) LIKE ? ESCAPE '\\' THEN 3
      WHEN LOWER(g.search_pinyin) LIKE ? ESCAPE '\\' THEN 4
      WHEN LOWER(g.subtitle) LIKE ? ESCAPE '\\' THEN 5
      WHEN LOWER(g.tags) LIKE ? ESCAPE '\\' THEN 6
      WHEN LOWER(g.description) LIKE ? ESCAPE '\\' THEN 7
      ELSE 8 END AS search_score`;
  const scoreParams = [raw, starts, like, starts, like, like, like, like];
  const one = "(LOWER(g.title) LIKE ? ESCAPE '\\' OR LOWER(g.subtitle) LIKE ? ESCAPE '\\' OR LOWER(g.description) LIKE ? ESCAPE '\\' OR LOWER(g.tags) LIKE ? ESCAPE '\\' OR LOWER(g.search_pinyin) LIKE ? ESCAPE '\\')";
  const whereSql = '(' + terms.map(() => one).join(' OR ') + ')';
  const whereParams = [];
  for (const t of terms) whereParams.push('%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%');
  return { raw, scoreSql, scoreParams, whereSql, whereParams };
}

const SORTS = {
  // 末位用 id 兜底，保证 0 播放 / 0 评分时排序稳定
  hot:    'g.plays DESC, g.rating DESC, g.id ASC',
  new:    'g.id DESC',
  rating: 'g.rating DESC, g.rating_count DESC, g.id ASC',
  title:  'g.title ASC'
};

/**
 * 查询游戏列表
 * @param {{q?:string, category?:string, tag?:string, sort?:string, limit?:number, offset?:number}} opts
 */
export function listGames(opts = {}) {
  const { q = '', category = '', tag = '', sort = 'hot', limit = 24, offset = 0 } = opts;
  const where = ['g.status = 1'];
  const params = [];

  const plan = searchPlan(q);
  let base = SELECT_BASE;
  let order = SORTS[sort] || SORTS.hot;
  if (plan) {
    // 打分列进 SELECT；有搜索词时相关度永远优先，同分再按选择的排序
    base = SELECT_BASE.replace('FROM games g', ', ' + plan.scoreSql + ' FROM games g');
    params.push(...plan.scoreParams);
    where.push(plan.whereSql);
    params.push(...plan.whereParams);
    order = 'search_score ASC, ' + order;
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag)      { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }

  const sql = base + ' WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?';
  params.push(Math.max(1, Math.min(100, Number(limit) || 24)), Math.max(0, Number(offset) || 0));

  return db.prepare(sql).all(...params).map(mapGame);
}

export function countGames(opts = {}) {
  const { q = '', category = '', tag = '' } = opts;
  const where = ['g.status = 1'];
  const params = [];
  const plan = searchPlan(q);
  if (plan) { where.push(plan.whereSql); params.push(...plan.whereParams); }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag)      { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }
  const sql = 'SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id WHERE ' +
              where.join(' AND ');
  return db.prepare(sql).get(...params).n;
}

/**
 * 一条游戏记录的拼音检索串来源：标题、副标题、标签、分类名、简介前 120 字。
 * 简介太长会撑爆索引，截断即可。
 */
export function gameSearchSource(g = {}) {
  return [g.title, g.subtitle, g.category_name, (g.tags || []).join(' '), String(g.description || '').slice(0, 120)];
}

/** 写入 / 刷新单条游戏的 search_pinyin */
export function refreshSearchIndex(id) {
  const row = db.prepare(SELECT_BASE + ' WHERE g.id = ?').get(id);
  if (!row) return false;
  const g = mapGame(row);
  db.prepare('UPDATE games SET search_pinyin = ? WHERE id = ?')
    .run(buildSearchIndex(gameSearchSource(g)), id);
  return true;
}

/**
 * 给所有还没有拼音索引的游戏补一份（老库升级、种子数据变更后调用）。
 * @param {boolean} force 为 true 时全量重建
 */
export function reindexSearchIndex(force = false) {
  const rows = db.prepare(`SELECT g.id FROM games g
    ${force ? '' : "WHERE g.search_pinyin IS NULL OR g.search_pinyin = ''"}`).all();
  for (const r of rows) refreshSearchIndex(r.id);
  return rows.length;
}

export function getGame(slug) {
  return mapGame(db.prepare(SELECT_BASE + ' WHERE g.slug = ? AND g.status = 1').get(slug));
}

/** 同分类 / 同标签的相关游戏 */
export function relatedGames(game, limit = 8) {
  if (!game) return [];
  const rows = db.prepare(SELECT_BASE + `
    WHERE g.status = 1 AND g.id != ?
    ORDER BY (g.category_id = ?) DESC, g.plays DESC
    LIMIT ?
  `).all(game.id, game.category_id, limit);
  return rows.map(mapGame);
}

export function listCategories() {
  return db.prepare(`
    SELECT c.*, COUNT(g.id) AS total
    FROM categories c
    LEFT JOIN games g ON g.category_id = c.id AND g.status = 1
    GROUP BY c.id
    ORDER BY c.sort ASC
  `).all();
}

export function getCategory(slug) {
  return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) || null;
}

/** 全部标签 + 出现次数，按热度排序 */
export function listTags(limit = 24) {
  const map = new Map();
  for (const row of db.prepare('SELECT tags, plays FROM games WHERE status = 1').all()) {
    for (const t of safeParse(row.tags)) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit);
}

/** 游玩 +1，并记录日志 */
export function incrementPlay(slug) {
  const g = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
  if (!g) return null;
  db.prepare('UPDATE games SET plays = plays + 1 WHERE id = ?').run(g.id);
  db.prepare('INSERT INTO play_logs (game_id, day) VALUES (?, date(\'now\',\'localtime\'))').run(g.id);
  return db.prepare('SELECT plays FROM games WHERE id = ?').get(g.id).plays;
}

export function siteStats() {
  const { games } = db.prepare('SELECT COUNT(*) AS games FROM games WHERE status = 1').get();
  const { plays } = db.prepare('SELECT COALESCE(SUM(plays),0) AS plays FROM games WHERE status = 1').get();
  return { games, plays };
}

/* ---------- 评分 ---------- */

/**
 * 写入/覆盖一个访客对某游戏的评分（一人一票、可改票），并把聚合结果回写到 games。
 * @returns {{error:string}|{stars:number, previous:number, isNew:boolean, rating:number, count:number}}
 */
export function rateGame(slug, visitor, stars) {
  const n = Math.round(Number(stars));
  if (!Number.isInteger(n) || n < 1 || n > 5) return { error: 'bad_stars' };
  if (!visitor) return { error: 'no_visitor' };

  const g = db.prepare('SELECT id FROM games WHERE slug = ? AND status = 1').get(slug);
  if (!g) return { error: 'not_found' };

  const before = db.prepare('SELECT stars FROM ratings WHERE game_id = ? AND visitor = ?').get(g.id, visitor);
  db.prepare(`
    INSERT INTO ratings (game_id, visitor, stars) VALUES (?, ?, ?)
    ON CONFLICT(game_id, visitor)
    DO UPDATE SET stars = excluded.stars, updated_at = datetime('now','localtime')
  `).run(g.id, visitor, n);

  const agg = db.prepare('SELECT COUNT(*) AS c, AVG(stars) AS avg FROM ratings WHERE game_id = ?').get(g.id);
  const avg = Math.round(agg.avg * 10) / 10;
  db.prepare('UPDATE games SET rating = ?, rating_count = ? WHERE id = ?').run(avg, agg.c, g.id);

  return { stars: n, previous: before ? before.stars : 0, isNew: !before, rating: avg, count: agg.c };
}

/** 当前访客对某游戏已给出的星级（0 = 还没评过） */
export function myRating(slug, visitor) {
  if (!visitor) return 0;
  const row = db.prepare(`
    SELECT r.stars FROM ratings r
    JOIN games g ON g.id = r.game_id
    WHERE g.slug = ? AND r.visitor = ?
  `).get(slug, visitor);
  return row ? row.stars : 0;
}

/* ================= 用户内容：收藏 / 评论 ================= */

export const COMMENT_PAGE_SIZE = 10;   // 顶层评论每页条数
export const REPLY_PREVIEW = 20;       // 每条顶层评论一次最多带出的回复数

const COMMENT_COLS = 'c.id, c.body, c.created_at, c.parent_id, u.id AS user_id, u.display_name AS name';

/** 某游戏的可见顶层评论（新的在前，分页） */
export function listComments(slug, { page = 1, pageSize = COMMENT_PAGE_SIZE } = {}) {
  const size = Math.max(1, Math.min(50, Number(pageSize) || COMMENT_PAGE_SIZE));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM comments c
    JOIN games g ON g.id = c.game_id
    WHERE g.slug = ? AND c.status = 1 AND c.parent_id IS NULL`).get(slug).n;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.max(1, Math.min(pages, Number(page) || 1));
  const items = db.prepare(`SELECT ${COMMENT_COLS}
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN games g ON g.id = c.game_id
    WHERE g.slug = ? AND c.status = 1 AND c.parent_id IS NULL
    ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(slug, size, (p - 1) * size);
  return { items: items.map((r) => ({ ...r, replies: [], reply_total: 0 })), total, page: p, pages, pageSize: size };
}

/** 给一页顶层评论补上回复（只查这一页的 parent_id，避免全表扫） */
export function attachReplies(thread) {
  const ids = thread.items.map((c) => c.id);
  if (!ids.length) return thread;
  const holes = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT ${COMMENT_COLS}
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.parent_id IN (${holes}) AND c.status = 1
    ORDER BY c.id ASC`).all(...ids);
  const byRoot = new Map(thread.items.map((c) => [c.id, c]));
  for (const r of rows) {
    const root = byRoot.get(r.parent_id);
    if (!root) continue;
    root.reply_total++;
    if (root.replies.length < REPLY_PREVIEW) root.replies.push(r);
  }
  return thread;
}

/** 详情页用：分页 + 回复一次取好 */
export function commentThread(slug, page = 1, pageSize = COMMENT_PAGE_SIZE) {
  const thread = listComments(slug, { page, pageSize });
  return attachReplies(thread);
}

/** 全部可见评论数（顶层 + 回复），详情页「玩家评论」角标用 */
export function countComments(slug) {
  return db.prepare(`SELECT COUNT(*) AS n FROM comments c
    JOIN games g ON g.id = c.game_id
    WHERE g.slug = ? AND c.status = 1`).get(slug).n;
}

export const COMMENT_MAX = 500;

/**
 * 发一条评论或回复。
 * 只做两级（楼中楼）：回复「回复」时自动挂到同一顶层评论下，并在正文前带上 @昵称。
 * @returns {{error:string}|{id:number, body:string, parent_id:number|null, name:string}}
 */
export function addComment(slug, userId, body, parentId = null) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if (text.length > COMMENT_MAX) return { error: 'too_long' };
  const g = db.prepare(`SELECT id FROM games WHERE slug = ? AND status = 1`).get(slug);
  if (!g) return { error: 'not_found' };

  let root = null;
  let finalText = text;
  if (parentId) {
    const p = db.prepare(`SELECT id, parent_id, user_id, status FROM comments WHERE id = ? AND game_id = ?`)
      .get(Number(parentId), g.id);
    if (!p || !Number(p.status)) return { error: 'bad_parent' };
    root = p.parent_id ? p.parent_id : p.id;
    // 回复「回复」时补一个 @ 提醒（正文已经以 @ 开头就不重复加）
    if (p.parent_id && !finalText.startsWith('@')) {
      const who = db.prepare('SELECT display_name AS name FROM users WHERE id = ?').get(p.user_id);
      finalText = '@' + (who ? who.name : '某人') + ' ' + finalText;
      if (finalText.length > COMMENT_MAX) finalText = finalText.slice(0, COMMENT_MAX);
    }
  }

  const info = db.prepare('INSERT INTO comments (game_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)')
    .run(g.id, userId, finalText, root);
  return { id: Number(info.lastInsertRowid), body: finalText, parent_id: root, name: null };
}

/* ---------- 举报 ---------- */

export const REPORT_MAX = 200;
export const REPORT_REASONS = ['spam', 'abuse', 'spoiler', 'other'];
export const REPORT_LABEL = { spam: '垃圾广告', abuse: '辱骂攻击', spoiler: '剧透', other: '其他' };

/**
 * 举报一条评论：同一用户对同一条只记一次（UNIQUE 冲突就当已举报）。
 * @returns {{error:string}|{reported:boolean, count:number, already:boolean}}
 */
export function reportComment(commentId, userId, reason = 'other') {
  const r = String(reason || 'other').slice(0, 20);
  if (!REPORT_REASONS.includes(r)) return { error: 'bad_reason' };
  const c = db.prepare('SELECT id, status FROM comments WHERE id = ?').get(Number(commentId));
  if (!c || !Number(c.status)) return { error: 'not_found' };
  const seen = db.prepare('SELECT id FROM comment_reports WHERE comment_id = ? AND user_id = ?')
    .get(Number(commentId), userId);
  if (seen) {
    return { reported: true, already: true, count: reportCount(commentId) };
  }
  db.prepare('INSERT INTO comment_reports (comment_id, user_id, reason) VALUES (?, ?, ?)')
    .run(Number(commentId), userId, r);
  return { reported: true, already: false, count: reportCount(commentId) };
}

function reportCount(commentId) {
  return db.prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ? AND status = 0")
    .get(Number(commentId)).n;
}

/** 后台：待处理举报（带评论正文与游戏） */
export function listReports(status = 0, limit = 50) {
  return db.prepare(`SELECT r.id, r.reason, r.status, r.created_at,
      c.id AS comment_id, c.body, c.status AS comment_status,
      u.display_name AS reporter, cu.display_name AS author, g.title, g.slug
    FROM comment_reports r
    JOIN comments c ON c.id = r.comment_id
    JOIN users u  ON u.id = r.user_id
    JOIN users cu ON cu.id = c.user_id
    JOIN games g  ON g.id = c.game_id
    WHERE r.status = ?
    ORDER BY r.id DESC LIMIT ?`).all(Number(status) || 0, limit);
}

export function countReports(status = 0) {
  return db.prepare('SELECT COUNT(*) AS n FROM comment_reports WHERE status = ?')
    .get(Number(status) || 0).n;
}

/** 处理举报：1 已处理（顺手隐藏评论）/ 2 忽略 */
export function setReportStatus(id, status) {
  const s = Number(status) === 2 ? 2 : 1;
  const info = db.prepare('UPDATE comment_reports SET status = ? WHERE id = ?').run(s, Number(id));
  return info.changes ? { status: s } : { error: 'not_found' };
}

/** 收藏 / 取消收藏，返回 { error } 或 { favorited, count } */
export function toggleFavorite(slug, userId) {
  const g = db.prepare(`SELECT id FROM games WHERE slug = ? AND status = 1`).get(slug);
  if (!g) return { error: 'not_found' };
  const has = db.prepare(`SELECT 1 AS x FROM favorites WHERE user_id = ? AND game_id = ?`).get(userId, g.id);
  if (has) db.prepare('DELETE FROM favorites WHERE user_id = ? AND game_id = ?').run(userId, g.id);
  else db.prepare('INSERT INTO favorites (user_id, game_id) VALUES (?, ?)').run(userId, g.id);
  return { favorited: !has, count: db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE game_id = ?`).get(g.id).n };
}

export function favoriteCount(slug) {
  const g = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
  return g ? db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE game_id = ?`).get(g.id).n : 0;
}

export function isFavorited(slug, userId) {
  if (!userId) return false;
  return !!db.prepare(`SELECT 1 AS x FROM favorites f
    JOIN games g ON g.id = f.game_id
    WHERE g.slug = ? AND f.user_id = ?`).get(slug, userId);
}

/** 我的收藏（按收藏时间倒序） */
export function listFavorites(userId) {
  return db.prepare(SELECT_BASE + `
    INNER JOIN favorites f ON f.game_id = g.id
    WHERE f.user_id = ? AND g.status = 1
    ORDER BY f.created_at DESC, g.id DESC
  `).all(userId).map(mapGame);
}

/* ================= 投稿与后台 ================= */

export const STATUS_LABEL = { 0: '已下架', 1: '已上架', 2: '待审核' };
export function statusLabel(n) { return STATUS_LABEL[Number(n)] || '未知'; }

/** 标题转 slug：中文也能留，其余字符折成短横线 */
export function slugify(title) {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'game';
}

export function uniqueSlug(title) {
  const base = slugify(title);
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 AS x FROM games WHERE slug = ?').get(slug); i++) {
    slug = base + '-' + i;
  }
  return slug;
}

/**
 * 用户投稿：写进 games 但 status = 2（待审核），管理员通过后才上架。
 * @returns {{error:string}|{slug:string}}
 */
export function createSubmission(f, userId) {
  const title = String(f.title || '').trim().slice(0, 40);
  const url = String(f.game_url || '').trim().slice(0, 300);
  if (title.length < 2) return { error: '请填写游戏名称（至少 2 个字）' };
  if (!/^(https?:\/\/|\/)/.test(url)) {
    return { error: '游戏地址要填 /games/xxx/index.html 这样的站内路径，或 http(s) 开头的链接' };
  }
  const cat = getCategory(String(f.category || '').trim());
  const tags = String(f.tags || '')
    .split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  const slug = uniqueSlug(title);
  db.prepare(
    'INSERT INTO games (slug, title, subtitle, description, category_id, game_url,' +
    ' width, height, orientation, tags, emoji, accent, accent2, license, status, submitted_by)' +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)"
  ).run(
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
  );
  const id = Number(db.prepare('SELECT id FROM games WHERE slug = ?').get(slug).id);
  refreshSearchIndex(id);
  return { slug, id };
}

/** 后台：按状态列出游戏（含未上架的） */
export function listGamesByStatus(status, limit = 100) {
  return db.prepare(SELECT_BASE + ` WHERE g.status = ? ORDER BY g.id DESC LIMIT ?`).all(Number(status), limit).map(mapGame);
}

/** 后台：管理列表的公共条件（关键字 + 状态 + 分类） */
function managedWhere(opts = {}) {
  const { status = null, q = '', category = '' } = opts;
  const where = [];
  const params = [];
  if (status !== null && status !== '' && status !== undefined) { where.push('g.status = ?'); params.push(Number(status)); }
  if (String(q).trim()) {
    const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
    where.push("(LOWER(g.title) LIKE ? ESCAPE '\\' OR LOWER(g.slug) LIKE ? ESCAPE '\\' OR LOWER(g.search_pinyin) LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

/**
 * 后台游戏列表：可带状态 / 关键字（标题、slug、拼音）/ 分类，支持分页。
 * @param {{status?:number|string|null,q?:string,category?:string,limit?:number,offset?:number}} opts
 */
export function listManagedGames(opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  const w = managedWhere(opts);
  return db.prepare(SELECT_BASE + w.sql +
    ` ORDER BY g.status DESC, g.plays DESC, g.id ASC LIMIT ? OFFSET ?`)
    .all(...w.params, Math.max(1, Math.min(500, Number(limit) || 200)), Math.max(0, Number(offset) || 0))
    .map(mapGame);
}

export function countManagedGames(opts = {}) {
  const w = managedWhere(opts);
  return db.prepare('SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id' + w.sql)
    .get(...w.params).n;
}

/** 后台预览投稿用：不看 status 也能取到 */
export function getGameAny(slug) {
  return mapGame(db.prepare(SELECT_BASE + ' WHERE g.slug = ?').get(String(slug)));
}

export function setGameStatus(slug, status) {
  const s = Number(status);
  if (![0, 1, 2].includes(s)) return { error: 'bad_status' };
  const info = db.prepare(`UPDATE games SET status = ? WHERE slug = ?`).run(s, String(slug));
  return info.changes ? { status: s } : { error: 'not_found' };
}

/**
 * 批量上下架：一次事务改多条，返回 { changed, missing }。
 * missing 里的 slug 是没找到的，前端可以提示。
 */
export function setGamesStatus(slugs, status) {
  const s = Number(status);
  if (![0, 1, 2].includes(s)) return { error: 'bad_status' };
  const list = [...new Set([].concat(slugs || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);
  if (!list.length) return { error: 'empty' };
  const find = db.prepare('SELECT id FROM games WHERE slug = ?');
  const upd = db.prepare('UPDATE games SET status = ? WHERE id = ?');
  const changed = [];
  const missing = [];
  db.exec('BEGIN');
  try {
    for (const slug of list) {
      const row = find.get(slug);
      if (!row) { missing.push(slug); continue; }
      upd.run(s, row.id);
      changed.push(slug);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { status: s, changed, missing };
}

/* ---------- 账号管理 ---------- */

/** 后台用户列表：带评论数、投稿数、是否封禁 */
export function listUsers(opts = {}) {
  const { q = '', limit = 100, offset = 0 } = opts;
  const params = [];
  let where = '';
  if (String(q).trim()) {
    where = " WHERE LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(u.email,'')) LIKE ? ESCAPE '\\'";
    const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
    params.push(like, like, like);
  }
  return db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.email, u.email_verified,
      u.banned, u.banned_reason, u.created_at,
      (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.status = 1) AS comments,
      (SELECT COUNT(*) FROM games g2 WHERE g2.submitted_by = u.id) AS submissions
    FROM users u${where}
    ORDER BY u.banned DESC, u.id ASC LIMIT ? OFFSET ?`)
    .all(...params, Math.max(1, Math.min(500, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
}

export function countUsers(q = '') {
  if (!String(q).trim()) return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
  return db.prepare(`SELECT COUNT(*) AS n FROM users u
    WHERE LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\'
       OR LOWER(IFNULL(u.email,'')) LIKE ? ESCAPE '\\'`).get(like, like, like).n;
}

/** 封禁 / 解封。封禁时顺手把该用户的会话全部踢掉 */
export function setUserBanned(id, banned, reason = '') {
  const uid = Number(id);
  const row = db.prepare('SELECT id, role FROM users WHERE id = ?').get(uid);
  if (!row) return { error: 'not_found' };
  if (row.role === 'admin') return { error: 'cannot_ban_admin' };
  const b = banned ? 1 : 0;
  db.prepare('UPDATE users SET banned = ?, banned_reason = ? WHERE id = ?')
    .run(b, b ? String(reason || '').slice(0, 200) : null, uid);
  if (b) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  return { banned: !!b };
}

/** 后台：最近评论（含被隐藏的、带父评论与待处理举报数） */
export function listRecentComments(opts = {}) {
  const { limit = 30, offset = 0 } = typeof opts === 'number' ? { limit: opts } : opts;
  return db.prepare(`SELECT c.id, c.body, c.status, c.parent_id, c.created_at,
      u.display_name AS name, g.title, g.slug,
      (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id AND r.status = 0) AS reports
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN games g ON g.id = c.game_id
    ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(Math.max(1, Math.min(200, Number(limit) || 30)), Math.max(0, Number(offset) || 0));
}

export function countAllComments() {
  return db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
}

export function setCommentStatus(id, status) {
  const s = Number(status) ? 1 : 0;
  const info = db.prepare(`UPDATE comments SET status = ? WHERE id = ?`).run(s, Number(id));
  return info.changes ? { status: s } : { error: 'not_found' };
}

/* ---------- 操作日志 ---------- */

/**
 * 记一条后台操作。actor 传登录用户对象即可。
 * action 用「域.动作」的短标识，例如 game.status / game.batch / user.ban。
 */
export function logAudit(actor, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit_logs (actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(actor ? Number(actor.id) || null : null,
         actor ? String(actor.display_name || actor.username || '').slice(0, 40) : '系统',
         String(action || '').slice(0, 40),
         String(target || '').slice(0, 80),
         String(detail || '').slice(0, 200));
}

/** 后台：操作日志（倒序，支持按动作/操作人/目标过滤） */
export function listAudit(opts = {}) {
  const { q = '', limit = 50, offset = 0 } = opts;
  const params = [];
  let where = '';
  if (String(q).trim()) {
    where = " WHERE LOWER(IFNULL(a.actor_name,'')) LIKE ? ESCAPE '\\' OR LOWER(a.action) LIKE ? ESCAPE '\\' OR LOWER(a.target) LIKE ? ESCAPE '\\'";
    const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
    params.push(like, like, like);
  }
  return db.prepare(`SELECT a.id, a.actor_name, a.action, a.target, a.detail, a.created_at FROM audit_logs a
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.max(1, Math.min(200, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
}

export function countAudit(q = '') {
  if (!String(q).trim()) return db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
  const like = '%' + likeEscape(String(q).trim()).toLowerCase() + '%';
  return db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a
    WHERE LOWER(IFNULL(a.actor_name,'')) LIKE ? ESCAPE '\\' OR LOWER(a.action) LIKE ? ESCAPE '\\'
       OR LOWER(a.target) LIKE ? ESCAPE '\\'`).get(like, like, like).n;
}

export function adminStats() {
  return db.prepare(
    'SELECT' +
    " (SELECT COUNT(*) FROM games WHERE status = 1) AS published," +
    " (SELECT COUNT(*) FROM games WHERE status = 2) AS pending," +
    " (SELECT COUNT(*) FROM games WHERE status = 0) AS offline," +
    " (SELECT COUNT(*) FROM users) AS users," +
    " (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned," +
    " (SELECT COUNT(*) FROM comments WHERE status = 1) AS comments," +
    " (SELECT COUNT(*) FROM comment_reports WHERE status = 0) AS reports," +
    " (SELECT COUNT(*) FROM favorites) AS favorites"
  ).get();
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

export const BOARD_LABEL = Object.fromEntries(Object.entries(BOARD_KINDS).map(([k, v]) => [k, v.label]));

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
export function leaderboard(kind = 'today', limit = 20) {
  const k = boardKind(kind);
  const spec = BOARD_KINDS[k];
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  let rows;

  if (spec.metric === 'plays') {
    rows = db.prepare(`SELECT ${BOARD_COLS}, COUNT(p.id) AS value
      FROM play_logs p JOIN games g ON g.id = p.game_id
      LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status = 1 AND ${spec.range}
      GROUP BY g.id HAVING value > 0
      ORDER BY value DESC, g.plays DESC, g.id ASC LIMIT ?`).all(n);
  } else if (spec.metric === 'plays_all') {
    rows = db.prepare(`SELECT ${BOARD_COLS}, g.plays AS value
      FROM games g LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status = 1
      ORDER BY g.plays DESC, g.id ASC LIMIT ?`).all(n);
  } else if (spec.metric === 'rating') {
    rows = db.prepare(`SELECT ${BOARD_COLS}, g.rating AS value
      FROM games g LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status = 1 AND g.rating_count > 0
      ORDER BY g.rating DESC, g.rating_count DESC, g.id ASC LIMIT ?`).all(n);
  } else if (spec.metric === 'fav') {
    rows = db.prepare(`SELECT ${BOARD_COLS}, COUNT(f.game_id) AS value
      FROM games g LEFT JOIN categories c ON c.id = g.category_id
      LEFT JOIN favorites f ON f.game_id = g.id
      WHERE g.status = 1
      GROUP BY g.id ORDER BY value DESC, g.plays DESC, g.id ASC LIMIT ?`).all(n);
  } else {
    rows = db.prepare(`SELECT ${BOARD_COLS}, g.id AS value
      FROM games g LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status = 1
      ORDER BY g.id DESC LIMIT ?`).all(n);
  }

  // 环比：上一个周期的名次，用来看「↑3 / ↓2 / 新上榜」
  const prevRank = new Map();
  if (spec.metric === 'plays') {
    const prev = db.prepare(`SELECT g.slug AS slug, COUNT(p.id) AS value
      FROM play_logs p JOIN games g ON g.id = p.game_id
      WHERE g.status = 1 AND ${spec.prev}
      GROUP BY g.id HAVING value > 0
      ORDER BY value DESC, g.plays DESC, g.id ASC`).all();
    prev.map((r, i) => prevRank.set(r.slug, i + 1));
  }

  const list = rows.map((r, i) => {
    const rank = i + 1;
    const before = prevRank.get(r.slug) || null;
    return {
      rank,
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
export function recentPlays(slug, days = 1) {
  return db.prepare(`SELECT COUNT(*) AS n FROM play_logs p
    JOIN games g ON g.id = p.game_id
    WHERE g.slug = ? AND p.day >= date('now','localtime', ?)`)
    .get(slug, '-' + Math.max(0, Number(days) - 1) + ' days').n;
}

/** 榜单页 / 后台头部的全站概览：今日、近 7 天、近 14 天趋势 */
export function boardOverview() {
  const today = db.prepare("SELECT COUNT(*) AS n FROM play_logs WHERE day = date('now','localtime')").get().n;
  const week = db.prepare("SELECT COUNT(*) AS n FROM play_logs WHERE day >= date('now','localtime','-6 days')").get().n;
  const trend = db.prepare(`SELECT day, COUNT(*) AS n FROM play_logs
    WHERE day >= date('now','localtime','-13 days')
    GROUP BY day ORDER BY day ASC`).all();
  return { today, week, trend };
}


