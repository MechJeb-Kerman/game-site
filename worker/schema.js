/**
 * D1 建表 + 种子 + 管理员自举。
 * 对应 Express 版：server.js 启动时调用的 seed(false) + auth.ensureAdmin()。
 * Worker 没有"启动"概念，所以放在第一次请求前跑，并用模块级 Promise 只跑一次。
 */
import { CATEGORIES, GAMES } from './seed-data.js';
import { ensureAdmin } from './auth.js';

/** 与 src/db.js migrate() 的 schema 逐字段一致（D1 是 SQLite，语法通用） */
export const DDL = [
  "CREATE TABLE IF NOT EXISTS categories (",
  "  id     INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  slug   TEXT UNIQUE NOT NULL,",
  "  name   TEXT NOT NULL,",
  "  icon   TEXT DEFAULT '🎮',",
  "  sort   INTEGER DEFAULT 0",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS games (",
  "  id           INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  slug         TEXT UNIQUE NOT NULL,",
  "  title        TEXT NOT NULL,",
  "  subtitle     TEXT,",
  "  description  TEXT,",
  "  category_id  INTEGER REFERENCES categories(id),",
  "  engine       TEXT DEFAULT 'html5',",
  "  game_url     TEXT NOT NULL,",
  "  width        INTEGER DEFAULT 800,",
  "  height       INTEGER DEFAULT 600,",
  "  orientation  TEXT DEFAULT 'landscape',",
  "  tags         TEXT DEFAULT '[]',",
  "  emoji        TEXT DEFAULT '🎮',",
  "  accent       TEXT DEFAULT '#6366f1',",
  "  accent2      TEXT DEFAULT '#8b5cf6',",
  "  plays        INTEGER DEFAULT 0,",
  "  rating       REAL DEFAULT 0,",
  "  rating_count INTEGER DEFAULT 0,",
  "  license      TEXT DEFAULT '自研',",
  "  status       INTEGER DEFAULT 1,",
  "  submitted_by INTEGER,",
  "  created_at   TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_games_cat   ON games(category_id);",
  "CREATE INDEX IF NOT EXISTS idx_games_plays ON games(plays DESC);",
  "",
  "CREATE TABLE IF NOT EXISTS play_logs (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id),",
  "  day        TEXT NOT NULL,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_logs_game ON play_logs(game_id);",
  "CREATE INDEX IF NOT EXISTS idx_logs_day  ON play_logs(day);",
  "",
  "CREATE TABLE IF NOT EXISTS ratings (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,",
  "  visitor    TEXT NOT NULL,",
  "  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),",
  "  updated_at TEXT DEFAULT (datetime('now','localtime')),",
  "  UNIQUE (game_id, visitor)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings(game_id);",
  "",
  "CREATE TABLE IF NOT EXISTS users (",
  "  id           INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  username     TEXT UNIQUE NOT NULL,",
  "  display_name TEXT NOT NULL,",
  "  pass_hash    TEXT NOT NULL,",
  "  pass_salt    TEXT NOT NULL,",
  "  role         TEXT DEFAULT 'user',",
  "  created_at   TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS sessions (",
  "  token      TEXT PRIMARY KEY,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  expires_at TEXT NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS favorites (",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  PRIMARY KEY (user_id, game_id)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS comments (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  body       TEXT NOT NULL,",
  "  status     INTEGER DEFAULT 1,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);"
].join("\n");

/**
 * 建表。注意不能用 db.exec(DDL)：D1 的 exec() 是按换行切语句再执行的，
 * 我们这种跨多行的 CREATE TABLE 会被切坏，线上报
 *   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS categories (: incomplete input
 * （本地 tools/d1-local.mjs 用的是 node:sqlite 的 exec，能吃多行语句，所以之前测不出来）。
 * 这里自己按分号拆成单条，逐条 prepare().run()。
 */
export async function migrate(db) {
  const stmts = DDL.split(';').map((s) => s.trim()).filter(Boolean);
  for (const sql of stmts) await db.prepare(sql).run();
}

/** 空库才灌种子数据，语义与 seed(false) 相同 */
export async function seedIfEmpty(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM games').first();
  if (row && row.n > 0) return { seeded: false };

  const stmts = [];
  for (const c of CATEGORIES) {
    stmts.push(db.prepare('INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)')
      .bind(c.slug, c.name, c.icon, c.sort));
  }
  await db.batch(stmts);

  const catRows = await db.prepare('SELECT id, slug FROM categories').all();
  const catId = new Map(catRows.results.map((r) => [r.slug, r.id]));

  const gameStmts = GAMES.map((g) => db.prepare(
    'INSERT INTO games (slug, title, subtitle, description, category_id, engine, game_url,' +
    ' width, height, orientation, tags, emoji, accent, accent2, plays, rating, license)' +
    " VALUES (?, ?, ?, ?, ?, 'html5', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)"
  ).bind(
    g.slug, g.title, g.subtitle, g.description, catId.get(g.category), g.game_url,
    g.width, g.height, g.orientation, JSON.stringify(g.tags),
    g.emoji, g.accent, g.accent2, g.license
  ));
  await db.batch(gameStmts);
  return { seeded: true, games: gameStmts.length };
}

let readyPromise = null;

/**
 * 幂等自举：建表 → 空库灌种子 → 保证有管理员。
 * 一次 isolate 生命周期只跑一次；失败则重置，让下次请求重试。
 */
export function ensureReady(env) {
  if (!readyPromise) {
    readyPromise = (async () => {
      await migrate(env.DB);
      await seedIfEmpty(env.DB);
      await ensureAdmin(env.DB, env);
      return true;
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}
