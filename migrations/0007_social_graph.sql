-- 第七批：社交图谱（关注 / 站内通知 / 私信）
--
-- 与 worker/schema.js 末尾的 DDL 是同一份建表语句；src/social.js 的 ensureSocial()
-- 也用同一组语句（src/db.js 的 migrate() 本次不许动，所以 Express 线靠幂等自愈补建）。
-- 本机的库由运行时补；这个文件是给已部署的远程 D1 用的：
--   npx wrangler d1 migrations apply game-site-db --remote
--
-- 三张表都是 CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS，重复执行安全；
-- 不涉及 ALTER TABLE，所以不会出现两条线互相撞「列已存在」的问题。

CREATE TABLE IF NOT EXISTS follows (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (user_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_user     ON follows(user_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- 站内通知：kind 取 reply / mention / follow / message / comment / system；actor_id = 0 表示系统。
-- target_type + target_id 指向站内对象（thread / game / user），body 是 ≤200 字符的短文本。
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  actor_id    INTEGER NOT NULL DEFAULT 0,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  read_at     TEXT,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

-- 私信：一对一会话，body ≤1000 字符；read_at 为空即未读。
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages(to_id, read_at);
