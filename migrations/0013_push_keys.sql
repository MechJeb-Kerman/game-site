-- 0013：推送密钥自举表。
-- 为什么：Cloudflare 控制台里手填 VAPID 三件套是这一步唯一没法用代码完成的操作（用户无法访问控制台）。
-- 打开 PUSH_AUTO_KEYS 后，第一次用到推送（GET /api/push/key 或第一条通知）就把一对 P-256 键写进这张表，
-- 从此这台环境自带推送密钥，控制台不用碰。k 取 public / private / subject 三个值（一行一个）。
-- 两线都在模块内幂等自建（src/push.js 的 PUSH_DDL、worker/push.js 的 PUSH_DDL、src/db.js、worker/schema.js），
-- 这份给已存在的远程 D1 用，命令：
--   pnpm wrangler d1 execute <库名> --remote --file migrations/0013_push_keys.sql
CREATE TABLE IF NOT EXISTS push_keys (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT ''
);
