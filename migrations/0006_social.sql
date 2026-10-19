-- 第六批：观战 / 棋谱回放 / 每日挑战
-- 与 src/db.js、worker/schema.js 的 DDL 保持一致。
-- 注意：这里只放建表与建索引（幂等）。给 play_rooms 补 watch_token / replay_id 两列
-- 由运行时的 ensureColumns/addColumn 负责——两处都写成 ALTER TABLE ADD COLUMN 的话，
-- 先跑过的一方会让另一方报 duplicate column name。

CREATE TABLE IF NOT EXISTS play_replays (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game       TEXT NOT NULL,
  room_code  TEXT NOT NULL DEFAULT '',
  host_name  TEXT NOT NULL DEFAULT '',
  guest_name TEXT NOT NULL DEFAULT '',
  result     TEXT NOT NULL DEFAULT '',
  move_count INTEGER NOT NULL DEFAULT 0,
  moves      TEXT NOT NULL DEFAULT '[]',
  plays      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_replays_game ON play_replays(game, id DESC);

CREATE TABLE IF NOT EXISTS daily_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  slug       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_user ON daily_results(day, user_id);
