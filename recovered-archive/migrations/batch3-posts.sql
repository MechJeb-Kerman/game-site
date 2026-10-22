-- 第三批：公告（posts）与「评论可挂在公告上」
--
-- 与 worker/schema.js 的 DDL / ADD_COLUMNS / ADD_INDEXES 保持一致；
-- 本机 SQLite（src/db.js 的 migrate）会自己建表补列，这个文件是给已部署的远程 D1 用的：
--   npx wrangler d1 migrations apply game-site-db --remote

CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  pinned       INTEGER DEFAULT 0,
  status       INTEGER DEFAULT 1,
  author_id    INTEGER,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  updated_at   TEXT,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, pinned DESC, id DESC);

-- 评论目标：'game' = 游戏（默认，老数据全是这个），'post' = 公告。
-- comments.game_id 从此是「通用目标 id」：target='game' 时是 games.id，target='post' 时是 posts.id。
ALTER TABLE comments ADD COLUMN target TEXT NOT NULL DEFAULT 'game';

CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target, game_id, status, id DESC);
