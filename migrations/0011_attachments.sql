-- 第十一批：论坛附件（attachments / attachments_blob）
--
-- 与 src/attachments.js 里的 ATTACH_DDL、worker/attachments.js 的 ensureAttachments(db) 是同一份建表语句：
--   * D1 线：worker 首次请求附件时用单行版幂等补建（worker/schema.js 本次不动，靠这里兜底）；
--   * Express 线：createStore({ driver: 'fs' }) 第一次用到附件时用单行版幂等补建（src/db.js 的 migrate() 本次不动）；
--   * 本文件是给**已部署的远程 D1** 用的多行可读版：
--       npx wrangler d1 migrations apply game-site-db --remote
--
-- 全部是 CREATE TABLE / INDEX IF NOT EXISTS，重复执行安全，不涉及 ALTER TABLE，
-- 所以两条线（自愈补建 + 迁移）不会互相撞「表已存在 / 列已存在」。
--
-- 两个刻意的取舍：
--   1) key 是 SQLite 关键字，列名必须写成 "key"（单行版里也是这么引用的）；
--   2) owner_id 故意不加 REFERENCES users(id)：附件是软删 + 内容寻址共用一份实体，
--      删用户不该级联删掉附件实体（Worker 线也不保证每次都开 FK）。

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL,                      -- 上传者 users(id)
  thread_id  INTEGER NOT NULL DEFAULT 0,            -- 挂到哪个主题（0 = 还没挂上帖子）
  post_id    INTEGER NOT NULL DEFAULT 0,            -- 挂到哪个帖子（0 = 还没挂上帖子）
  filename   TEXT    NOT NULL,                      -- 清洗后的文件名：≤64 字符、保留扩展名、无路径分隔符
  mime       TEXT    NOT NULL DEFAULT '',           -- 声明类型，只收白名单里的值
  bytes      INTEGER NOT NULL DEFAULT 0,            -- 原始字节数（按类型卡上限：图片 2MB / 文本 256KB / 压缩包 4MB）
  sha256     TEXT    NOT NULL DEFAULT '',           -- 内容哈希：去重键，也是磁盘路径的前两级
  storage    TEXT    NOT NULL DEFAULT '',           -- fs（Express 磁盘）| d1（attachments_blob）
  "key"      TEXT    NOT NULL DEFAULT '',           -- 存储定位符：fs 是相对路径，d1 是 attachments_blob.id
  created_at TEXT DEFAULT (datetime('now','localtime')),
  status     TEXT NOT NULL DEFAULT 'pending'        -- pending（已上传未挂帖）| active（随帖发布）| deleted（软删）
);

-- 帖子详情页取附件；带 status 让「只列未删」走索引前缀
CREATE INDEX IF NOT EXISTS idx_attachments_post   ON attachments(post_id, status, id);
-- 主题页汇总各帖附件
CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id, status, id);
-- 「我上传的附件」列表：按 id 倒序取最近
CREATE INDEX IF NOT EXISTS idx_attachments_owner  ON attachments(owner_id, status, id DESC);
-- 去重：同一份内容（sha256）在同一驱动下只留一份实体；delete 时判「还有没有人引用」也用它
CREATE INDEX IF NOT EXISTS idx_attachments_sha    ON attachments(sha256, storage, status);
-- gcOrphans：扫 pending 且 created_at 超期的行
CREATE INDEX IF NOT EXISTS idx_attachments_gc     ON attachments(status, created_at);

-- D1 线的内容实体：base64 文本。单份内容上限 256 KB（base64 后约 341KB，留足 D1 单值 1MB 的余量），
-- 超限时存储层直接返回 { error: 'too_large_for_d1' }，图片/文本让用户压缩后再传，大文件走 Express 线的磁盘存储。
-- fs 线不用这张表（内容落在 data/attachments/ 下）。
CREATE TABLE IF NOT EXISTS attachments_blob (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  data_b64 TEXT NOT NULL                            -- 内容的 base64；行号就是 attachments."key"
);
