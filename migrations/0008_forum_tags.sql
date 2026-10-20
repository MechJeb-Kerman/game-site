-- 第八批：主题标签与精华
--
-- 与 worker/schema.js 的 DDL 保持一致。本机 SQLite 的库由 src/db.js 的 migrate() 建，
-- 这个文件是给已部署的远程 D1 用的：
--   npx wrangler d1 migrations apply game-site-db --remote
--
-- 部署顺序：先跑本迁移，再上带 tags / featured 的代码。
-- forum_threads.featured 用 ALTER 补（pinned 早在 0004 就有了，重复 ADD 会报
-- duplicate column name，SQLite 没有 ADD COLUMN IF NOT EXISTS）。
-- 若代码先上线、src/db.js 的 addColumn 或 worker/schema.js 的 ADD_COLUMNS 已经把
-- featured 补上了，这条 ALTER 会因列已存在而失败，跳过它即可（表结构已达成目标）。

-- 精华开关：0/1。置顶看时间（置顶内部按最新回复），精华看质量，两者互不影响
ALTER TABLE forum_threads ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;

-- 主题标签：一个主题最多 3 个（上限由 data-forum.js 的 cleanTags 保证，库里不设约束）
-- 删主题时标签跟着走，不留孤儿（两条线的 foreign_keys 都开着）
CREATE TABLE IF NOT EXISTS thread_tags (
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (thread_id, tag)
);

-- 按标签翻主题：tag 在前，先走索引再回表
CREATE INDEX IF NOT EXISTS idx_thread_tags_tag ON thread_tags(tag);
