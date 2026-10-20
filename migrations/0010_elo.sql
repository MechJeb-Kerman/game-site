-- 第十批：联机棋类的 Elo 评分 / 天梯 / 赛季
-- 与 src/db.js、worker/schema.js 的 DDL 保持一致（两处合入由仓库主理人做）。
-- 只有服务端裁判的四款棋类会结算（connect4 / reversi / draughts / gomoku，见 src/rules/index.js 的
-- SLUGS；judge 跑在服务端才能采信胜负），走法由客户端自定义的棋种与本文件无关。
--
-- 字段口径（与 src/elo.js、src/play-store.js 的 Elo 段一一对应，改一处要改三处）：
--   user_id / host_id / guest_id 都是 TEXT 身份键。对局房间是匿名的（play_rooms 只有昵称与座位
--   token，没有账号绑定），所以键由昵称派生：'n:' + NFKC 归一 + 折叠空白 + 转小写（src/elo.js 的
--   playerKey）。接入账号后直接放 String(users.id)（数字串不带前缀，与 'n:…' 不会撞）。
--   season 是 'YYYY-Q1' .. 'YYYY-Q4'：UTC 自然季度（src/elo.js 的 seasonOf），历史赛季的数据留着
--   可查，新赛季从 1200 重新开始（局数也独立，所以新赛季头 10 局又是 K=40）。
--   rating / peak 都是整数分，下限 100（src/elo.js 的 MIN_RATING），起始 1200。
--
-- player_ratings 的列要能被这条 upsert 原样写进去（少一列 / 多一列都会让结算静默失败）：
--   INSERT INTO player_ratings (user_id, game, season, rating, games, wins, losses, draws, peak, updated_at)
--   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, game, season) DO UPDATE SET ...
--
-- elo_history 故意不加 REFERENCES play_rooms(id)：sweep 会删掉过期的房间（waiting 2 小时 / 其它 24 小时），
-- 级联删会把结算历史一起抹掉，而这个房间「结过没」全靠这张表判断——抹掉就等于可以二次结算。
-- 所以 room_id 只当普通整数存着，靠 idx_elo_history_room 的 UNIQUE 兜住重复。
--
-- 应用顺序：已部署的远程 D1 用
--   npx wrangler d1 migrations apply game-site-db --remote
-- 本机 SQLite（src/db.js 的 migrate）从内联 DDL 建表，不读这个目录。

CREATE TABLE IF NOT EXISTS player_ratings (
  user_id    TEXT NOT NULL,
  game       TEXT NOT NULL,
  season     TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 1200,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  draws      INTEGER NOT NULL DEFAULT 0,
  peak       INTEGER NOT NULL DEFAULT 1200,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game, season)
);
-- 天梯榜的取数路径：WHERE game = ? AND season = ? ORDER BY rating DESC, games DESC, user_id ASC
CREATE INDEX IF NOT EXISTS idx_ratings_board ON player_ratings(game, season, rating DESC, games DESC, user_id);

CREATE TABLE IF NOT EXISTS elo_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL,
  game        TEXT NOT NULL,
  season      TEXT NOT NULL,
  host_id     TEXT NOT NULL,
  guest_id    TEXT NOT NULL,
  host_delta  INTEGER NOT NULL DEFAULT 0,
  guest_delta INTEGER NOT NULL DEFAULT 0,
  host_after  INTEGER NOT NULL DEFAULT 0,
  guest_after INTEGER NOT NULL DEFAULT 0,
  result      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT 0
);
-- 一个房间只结算一次：正常路径先查这张表，并发窗口靠这个唯一索引兜住（撞上就当已结算）
CREATE UNIQUE INDEX IF NOT EXISTS idx_elo_history_room ON elo_history(room_id);
CREATE INDEX IF NOT EXISTS idx_elo_history_season ON elo_history(game, season, id DESC);
