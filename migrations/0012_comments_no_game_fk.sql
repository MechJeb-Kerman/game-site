-- 0012：摘掉 comments.game_id 上遗留的 REFERENCES games(id) 外键。
-- 为什么：comments.game_id 是通用目标 id —— target='game' 存游戏 id、target='post' 存公告帖 id
-- （src/data.js addCommentTo）。公告帖 id 不在 games 表里时，外键让插入失败（Express 线公告评论 500）。
-- Express 线由 src/db.js 的 rebuildCommentsNoGameFk() 在启动时幂等重建；这份给 D1（远程库）用：
--   pnpm wrangler d1 execute <库名> --remote --file migrations/0012_comments_no_game_fk.sql
-- SQLite 不支持 DROP CONSTRAINT，只能整表重建；外键检查在事务外关闭，列集合写死为本迁移之前的完整集合。
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE comments_rebuild (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  parent_id  INTEGER,
  target     TEXT NOT NULL DEFAULT 'game'
);
INSERT INTO comments_rebuild (id, game_id, user_id, body, status, created_at, parent_id, target)
  SELECT id, game_id, user_id, body, status, created_at, parent_id, target FROM comments;
DROP TABLE comments;
ALTER TABLE comments_rebuild RENAME TO comments;
CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target, game_id, status, id DESC);
COMMIT;
PRAGMA foreign_keys = ON;
