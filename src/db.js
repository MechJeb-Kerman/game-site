import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 项目根目录 / 静态资源目录 / 游戏包目录 */
export const ROOT = join(here, '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const GAMES_DIR = join(ROOT, 'games');
const DATA_DIR = join(ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

/** 使用 Node 22.5+ 内置的 node:sqlite，零原生依赖 */
export const db = new DatabaseSync(join(DATA_DIR, 'games.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      slug   TEXT UNIQUE NOT NULL,
      name   TEXT NOT NULL,
      icon   TEXT DEFAULT '🎮',
      sort   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS games (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      subtitle    TEXT,
      description TEXT,
      category_id INTEGER REFERENCES categories(id),
      engine      TEXT DEFAULT 'html5',
      game_url    TEXT NOT NULL,
      width       INTEGER DEFAULT 800,
      height      INTEGER DEFAULT 600,
      orientation TEXT DEFAULT 'landscape',
      tags        TEXT DEFAULT '[]',
      emoji       TEXT DEFAULT '🎮',
      accent      TEXT DEFAULT '#6366f1',
      accent2     TEXT DEFAULT '#8b5cf6',
      plays        INTEGER DEFAULT 0,
      rating       REAL DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      license      TEXT DEFAULT '自研',
      status      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_games_cat   ON games(category_id);
    CREATE INDEX IF NOT EXISTS idx_games_plays ON games(plays DESC);

    CREATE TABLE IF NOT EXISTS play_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id),
      day        TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_game ON play_logs(game_id);
    CREATE INDEX IF NOT EXISTS idx_logs_day  ON play_logs(day);

    -- 评分：visitor 存投票者标识（接入用户系统后就是登录用户 id），一人一票、可改票
    CREATE TABLE IF NOT EXISTS ratings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      visitor    TEXT NOT NULL,
      stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (game_id, visitor)
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings(game_id);
  `);

  // 用户 / 会话 / 收藏 / 评论：纯 SQLite + node:crypto，不引第三方依赖
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      pass_hash    TEXT NOT NULL,
      pass_salt    TEXT NOT NULL,
      role         TEXT DEFAULT 'user',
      created_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 会话：token 存库，退出即删，过期自然失效（不用 JWT，省得算签名密钥）
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- 收藏：复合主键天然去重，一人一游戏一条
    CREATE TABLE IF NOT EXISTS favorites (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (user_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);

    -- 评论：status 1 可见 / 0 被管理员隐藏（软删除，可恢复）
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      status     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);
  `);

  // games.status 语义：1 已上架 / 0 已下架 / 2 待审核
  addColumn('games', 'submitted_by', 'submitted_by INTEGER');

  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补字段，老库要手动 ALTER
  addColumn('games', 'rating_count', 'rating_count INTEGER DEFAULT 0');
}

/** 幂等补列 */
function addColumn(table, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (cols.some((c) => c.name === column)) return;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
}
