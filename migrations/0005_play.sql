-- 第五批：联机对战房间（五子棋 / 中国象棋 / 国际象棋等共享一套房间与走法中继）
--
-- 与 worker/schema.js 的 DDL 保持一致。本机 SQLite（src/db.js 的 migrate）会自己建表，
-- 这个文件是给已部署的远程 D1 用的：
--   npx wrangler d1 migrations apply game-site-db --remote
--
-- 语义：服务端只做「轮流 + 走法中继」，不校验走法合法性、不判胜负（规则跑在客户端）；
-- play_moves.move 存客户端给的那串 JSON 文本，每个游戏自己解释。

CREATE TABLE IF NOT EXISTS play_rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  game        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'waiting',
  host_name   TEXT NOT NULL DEFAULT '',
  guest_name  TEXT NOT NULL DEFAULT '',
  host_token  TEXT NOT NULL,
  guest_token TEXT NOT NULL DEFAULT '',
  turn        INTEGER NOT NULL DEFAULT 0,
  move_count  INTEGER NOT NULL DEFAULT 0,
  result      TEXT NOT NULL DEFAULT '',
  rematch     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_play_rooms_game ON play_rooms(game, status, id);

CREATE TABLE IF NOT EXISTS play_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  seat       INTEGER NOT NULL,
  move       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_play_moves_room ON play_moves(room_id, seq);
