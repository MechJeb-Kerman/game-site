import { db } from './db.js';

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
 * 查询游戏列表
 * @param {{q?:string, category?:string, tag?:string, sort?:string, limit?:number, offset?:number}} opts
 */
export function listGames(opts = {}) {
  const { q = '', category = '', tag = '', sort = 'hot', limit = 24, offset = 0 } = opts;
  const where = ['g.status = 1'];
  const params = [];

  if (q.trim()) {
    const like = '%' + likeEscape(q.trim()) + '%';
    where.push('(g.title LIKE ? ESCAPE \'\\\' OR g.subtitle LIKE ? ESCAPE \'\\\' OR g.description LIKE ? ESCAPE \'\\\' OR g.tags LIKE ? ESCAPE \'\\\')');
    params.push(like, like, like, like);
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag)      { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }

  const orderBy = {
    // 末位用 id 兜底，保证 0 播放 / 0 评分时排序稳定
    hot:    'g.plays DESC, g.rating DESC, g.id ASC',
    new:    'g.id DESC',
    rating: 'g.rating DESC, g.rating_count DESC, g.id ASC',
    title:  'g.title ASC'
  }[sort] || 'g.plays DESC';

  const sql = SELECT_BASE + ' WHERE ' + where.join(' AND ') +
              ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?';
  params.push(Math.max(1, Math.min(100, Number(limit) || 24)), Math.max(0, Number(offset) || 0));

  return db.prepare(sql).all(...params).map(mapGame);
}

export function countGames(opts = {}) {
  const { q = '', category = '', tag = '' } = opts;
  const where = ['g.status = 1'];
  const params = [];
  if (q.trim()) {
    const like = '%' + likeEscape(q.trim()) + '%';
    where.push('(g.title LIKE ? ESCAPE \'\\\' OR g.subtitle LIKE ? ESCAPE \'\\\' OR g.description LIKE ? ESCAPE \'\\\' OR g.tags LIKE ? ESCAPE \'\\\')');
    params.push(like, like, like, like);
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag)      { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }
  const sql = 'SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id WHERE ' +
              where.join(' AND ');
  return db.prepare(sql).get(...params).n;
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

/** 某游戏的全部可见评论（新的在前） */
export function listComments(slug, limit = 50) {
  return db.prepare(`SELECT c.id, c.body, c.created_at, u.id AS user_id, u.display_name AS name
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN games g ON g.id = c.game_id
    WHERE g.slug = ? AND c.status = 1
    ORDER BY c.id DESC LIMIT ?`).all(slug, limit);
}

export function countComments(slug) {
  return db.prepare(`SELECT COUNT(*) AS n FROM comments c
    JOIN games g ON g.id = c.game_id
    WHERE g.slug = ? AND c.status = 1`).get(slug).n;
}

export const COMMENT_MAX = 500;

/** 发一条评论，返回 { error } 或 { id, body } */
export function addComment(slug, userId, body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if (text.length > COMMENT_MAX) return { error: 'too_long' };
  const g = db.prepare(`SELECT id FROM games WHERE slug = ? AND status = 1`).get(slug);
  if (!g) return { error: 'not_found' };
  const info = db.prepare('INSERT INTO comments (game_id, user_id, body) VALUES (?, ?, ?)')
    .run(g.id, userId, text);
  return { id: Number(info.lastInsertRowid), body: text };
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
  return { slug };
}

/** 后台：按状态列出游戏（含未上架的） */
export function listGamesByStatus(status, limit = 100) {
  return db.prepare(SELECT_BASE + ` WHERE g.status = ? ORDER BY g.id DESC LIMIT ?`).all(Number(status), limit).map(mapGame);
}

/** 后台：全部非待审核游戏 */
export function listManagedGames(limit = 200) {
  return db.prepare(SELECT_BASE + ` WHERE g.status != 2 ORDER BY g.status DESC, g.plays DESC, g.id ASC LIMIT ?`).all(limit).map(mapGame);
}

export function setGameStatus(slug, status) {
  const s = Number(status);
  if (![0, 1, 2].includes(s)) return { error: 'bad_status' };
  const info = db.prepare(`UPDATE games SET status = ? WHERE slug = ?`).run(s, String(slug));
  return info.changes ? { status: s } : { error: 'not_found' };
}

/** 后台：最近评论（含被隐藏的） */
export function listRecentComments(limit = 30) {
  return db.prepare(`SELECT c.id, c.body, c.status, c.created_at, u.display_name AS name, g.title, g.slug
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN games g ON g.id = c.game_id
    ORDER BY c.id DESC LIMIT ?`).all(limit);
}

export function setCommentStatus(id, status) {
  const s = Number(status) ? 1 : 0;
  const info = db.prepare(`UPDATE comments SET status = ? WHERE id = ?`).run(s, Number(id));
  return info.changes ? { status: s } : { error: 'not_found' };
}

export function adminStats() {
  return db.prepare(
    'SELECT' +
    " (SELECT COUNT(*) FROM games WHERE status = 1) AS published," +
    " (SELECT COUNT(*) FROM games WHERE status = 2) AS pending," +
    " (SELECT COUNT(*) FROM games WHERE status = 0) AS offline," +
    " (SELECT COUNT(*) FROM users) AS users," +
    " (SELECT COUNT(*) FROM comments WHERE status = 1) AS comments," +
    " (SELECT COUNT(*) FROM favorites) AS favorites"
  ).get();
}

