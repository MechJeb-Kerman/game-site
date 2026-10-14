/**
 * D1 版数据层：与 src/data.js 一一对应，区别只有两处
 *   1) 每个函数第一个参数是 D1 数据库绑定（env.DB），查询都是异步的；
 *   2) LIKE 的转义符用 '~'（避免反斜杠在 JS 字符串和 SQL 里转义两次），语义不变。
 */

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

/** 拼 WHERE 与参数：列表查询与计数共用 */
function buildWhere(opts) {
  const o = opts || {};
  const q = String(o.q || '');
  const category = String(o.category || '');
  const tag = String(o.tag || '');
  const where = ['g.status = 1'];
  const params = [];
  if (q.trim()) {
    const like = '%' + likeEscape(q.trim()) + '%';
    where.push("(g.title LIKE ? ESCAPE '~' OR g.subtitle LIKE ? ESCAPE '~' OR g.description LIKE ? ESCAPE '~' OR g.tags LIKE ? ESCAPE '~')");
    params.push(like, like, like, like);
  }
  if (category) { where.push('c.slug = ?'); params.push(category); }
  if (tag) { where.push('g.tags LIKE ?'); params.push('%"' + tag + '"%'); }
  return { where: where.join(' AND '), params };
}

/** 查询游戏列表（可选 q / category / tag / sort / limit / offset） */
export async function listGames(db, opts) {
  const o = opts || {};
  const sort = String(o.sort || 'hot');
  const orderBy = {
    // 末位用 id 兜底，保证 0 播放 / 0 评分时排序稳定
    hot: 'g.plays DESC, g.rating DESC, g.id ASC',
    new: 'g.id DESC',
    rating: 'g.rating DESC, g.rating_count DESC, g.id ASC',
    title: 'g.title ASC'
  }[sort] || 'g.plays DESC';
  const { where, params } = buildWhere(o);
  const limit = Math.max(1, Math.min(100, Number(o.limit) || 24));
  const offset = Math.max(0, Number(o.offset) || 0);
  const sql = SELECT_BASE + ' WHERE ' + where + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?';
  const rows = await stmt(db, sql, params.concat([limit, offset])).all();
  return rows.results.map(mapGame);
}

export async function countGames(db, opts) {
  const { where, params } = buildWhere(opts);
  const sql = 'SELECT COUNT(*) AS n FROM games g LEFT JOIN categories c ON c.id = g.category_id WHERE ' + where;
  const row = await stmt(db, sql, params).first();
  return row ? row.n : 0;
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

/** 某游戏的全部可见评论（新的在前） */
export async function listComments(db, slug, limit) {
  const rows = await db.prepare(
    'SELECT c.id, c.body, c.created_at, u.id AS user_id, u.display_name AS name ' +
    'FROM comments c JOIN users u ON u.id = c.user_id JOIN games g ON g.id = c.game_id ' +
    'WHERE g.slug = ? AND c.status = 1 ORDER BY c.id DESC LIMIT ?'
  ).bind(slug, limit || 50).all();
  return rows.results;
}

export async function countComments(db, slug) {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM comments c JOIN games g ON g.id = c.game_id WHERE g.slug = ? AND c.status = 1'
  ).bind(slug).first();
  return row.n;
}

export const COMMENT_MAX = 500;

/** 发一条评论，返回 { error } 或 { id, body } */
export async function addComment(db, slug, userId, body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if (text.length > COMMENT_MAX) return { error: 'too_long' };
  const g = await db.prepare('SELECT id FROM games WHERE slug = ? AND status = 1').bind(slug).first();
  if (!g) return { error: 'not_found' };
  const res = await db.prepare('INSERT INTO comments (game_id, user_id, body) VALUES (?, ?, ?)')
    .bind(g.id, userId, text).run();
  return { id: Number(res.meta.last_row_id), body: text };
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

/** 用户投稿：写进 games 但 status = 2（待审核），管理员通过后才上架 */
export async function createSubmission(db, f, userId) {
  const title = String(f.title || '').trim().slice(0, 40);
  const url = String(f.game_url || '').trim().slice(0, 300);
  if (title.length < 2) return { error: '请填写游戏名称（至少 2 个字）' };
  if (!/^(https?:\/\/|\/)/.test(url)) {
    return { error: '游戏地址要填 /games/xxx/index.html 这样的站内路径，或 http(s) 开头的链接' };
  }
  const cat = await getCategory(db, String(f.category || '').trim());
  const tags = String(f.tags || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  const slug = await uniqueSlug(db, title);
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
  return { slug };
}

/** 后台：按状态列出游戏（含未上架的） */
export async function listGamesByStatus(db, status, limit) {
  const rows = await db.prepare(SELECT_BASE + ' WHERE g.status = ? ORDER BY g.id DESC LIMIT ?')
    .bind(Number(status), limit || 100).all();
  return rows.results.map(mapGame);
}

/** 后台：全部非待审核游戏 */
export async function listManagedGames(db, limit) {
  const rows = await db.prepare(SELECT_BASE +
    ' WHERE g.status != 2 ORDER BY g.status DESC, g.plays DESC, g.id ASC LIMIT ?')
    .bind(limit || 200).all();
  return rows.results.map(mapGame);
}

export async function setGameStatus(db, slug, status) {
  const s = Number(status);
  if ([0, 1, 2].indexOf(s) < 0) return { error: 'bad_status' };
  const res = await db.prepare('UPDATE games SET status = ? WHERE slug = ?').bind(s, String(slug)).run();
  return res.meta.changes ? { status: s } : { error: 'not_found' };
}

/** 后台：最近评论（含被隐藏的） */
export async function listRecentComments(db, limit) {
  const rows = await db.prepare(
    'SELECT c.id, c.body, c.status, c.created_at, u.display_name AS name, g.title, g.slug ' +
    'FROM comments c JOIN users u ON u.id = c.user_id JOIN games g ON g.id = c.game_id ' +
    'ORDER BY c.id DESC LIMIT ?'
  ).bind(limit || 30).all();
  return rows.results;
}

export async function setCommentStatus(db, id, status) {
  const s = Number(status) ? 1 : 0;
  const res = await db.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(s, Number(id)).run();
  return res.meta.changes ? { status: s } : { error: 'not_found' };
}

export async function adminStats(db) {
  return await db.prepare(
    'SELECT' +
    ' (SELECT COUNT(*) FROM games WHERE status = 1) AS published,' +
    ' (SELECT COUNT(*) FROM games WHERE status = 2) AS pending,' +
    ' (SELECT COUNT(*) FROM games WHERE status = 0) AS offline,' +
    ' (SELECT COUNT(*) FROM users) AS users,' +
    ' (SELECT COUNT(*) FROM comments WHERE status = 1) AS comments,' +
    ' (SELECT COUNT(*) FROM favorites) AS favorites'
  ).first();
}
