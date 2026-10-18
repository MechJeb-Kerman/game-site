-- Cloudflare D1 建表脚本（与 worker/schema.js 里的 DDL 完全一致，由它生成，别手改）
-- 应用：npx wrangler d1 migrations apply game-site-db --remote   （本地预览用 --local）
-- 种子数据（4 个分类 / 7 款游戏）不在这里，由 Worker 第一次请求时按 slug 幂等补齐，见 worker/schema.js 的 seedMissing()。
CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug   TEXT UNIQUE NOT NULL,
  name   TEXT NOT NULL,
  icon   TEXT DEFAULT '🎮',
  sort   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  description  TEXT,
  category_id  INTEGER REFERENCES categories(id),
  engine       TEXT DEFAULT 'html5',
  game_url     TEXT NOT NULL,
  width        INTEGER DEFAULT 800,
  height       INTEGER DEFAULT 600,
  orientation  TEXT DEFAULT 'landscape',
  tags         TEXT DEFAULT '[]',
  emoji        TEXT DEFAULT '🎮',
  accent       TEXT DEFAULT '#6366f1',
  accent2      TEXT DEFAULT '#8b5cf6',
  plays        INTEGER DEFAULT 0,
  rating       REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  license      TEXT DEFAULT '自研',
  status       INTEGER DEFAULT 1,
  submitted_by INTEGER,
  created_at   TEXT DEFAULT (datetime('now','localtime'))
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

CREATE TABLE IF NOT EXISTS ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  visitor    TEXT NOT NULL,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (game_id, visitor)
);
CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings(game_id);

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  role         TEXT DEFAULT 'user',
  created_at   TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);
