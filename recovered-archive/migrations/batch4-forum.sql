-- 第四批：论坛（板块 / 主题 / 楼层 / 编辑留痕 / 举报 / 内容黑名单 / 表单 nonce）
--
-- 与 worker/schema.js 的 DDL 保持一致。本机 SQLite（src/db.js 的 migrate）会自己建表，
-- 这个文件是给已部署的远程 D1 用的：
--   npx wrangler d1 migrations apply game-site-db --remote
--
-- 注意：禁言用的 users.muted_until / users.mute_reason 不在这里 ALTER ——
-- 两条线各有一份幂等补列助手（src/db.js 的 addColumn、worker/schema.js 的 ADD_COLUMNS），
-- 请求进来时自动补齐；写进迁移文件反而会在「先部署代码、后跑迁移」时撞车（列已存在）。

CREATE TABLE IF NOT EXISTS forums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon        TEXT DEFAULT '💬',
  sort        INTEGER DEFAULT 0,
  status      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS forum_threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id      INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        INTEGER DEFAULT 0,
  pinned        INTEGER DEFAULT 0,
  locked        INTEGER DEFAULT 0,
  reply_count   INTEGER DEFAULT 0,
  view_count    INTEGER DEFAULT 0,
  last_reply_at TEXT,
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_threads_forum  ON forum_threads(forum_id, status, pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_recent ON forum_threads(status, pinned DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_user   ON forum_threads(user_id, id DESC);

CREATE TABLE IF NOT EXISTS forum_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     INTEGER DEFAULT 0,
  is_op      INTEGER DEFAULT 0,
  parent_id  INTEGER,
  edited_at  TEXT,
  edit_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fposts_thread ON forum_posts(thread_id, status, id);
CREATE INDEX IF NOT EXISTS idx_fposts_user   ON forum_posts(user_id, id DESC);

CREATE TABLE IF NOT EXISTS forum_post_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  editor_id   INTEGER NOT NULL REFERENCES users(id),
  before_body TEXT NOT NULL,
  after_body  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fedits_post ON forum_post_edits(post_id, id DESC);

CREATE TABLE IF NOT EXISTS forum_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  status      INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (target_type, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_freports_status ON forum_reports(status, id DESC);

CREATE TABLE IF NOT EXISTS forum_blacklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL,
  kind       TEXT DEFAULT 'word',
  action     TEXT DEFAULT 'review',
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS form_nonces (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER,
  kind       TEXT DEFAULT '',
  used_at    TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_nonces_created ON form_nonces(created_at);
