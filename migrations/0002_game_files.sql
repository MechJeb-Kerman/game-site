-- 第二批功能：投稿上传的单文件 HTML 存在库里（Express / Workers 两条线共用同一张表）
-- 应用：npx wrangler d1 migrations apply game-site-db --remote   （本地预览用 --local）
-- 说明：0001_init.sql 是 worker/schema.js 里 DDL 的生成物、已在线上 apply 过，所以新表单开一个迁移文件；
--       Worker 首次请求时也会用 CREATE TABLE IF NOT EXISTS 兜底（见 worker/schema.js），两条路径等价。
CREATE TABLE IF NOT EXISTS game_files (
  slug       TEXT PRIMARY KEY,
  filename   TEXT,
  size       INTEGER DEFAULT 0,
  html       TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
