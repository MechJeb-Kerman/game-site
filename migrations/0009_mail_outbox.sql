-- 发件箱：外发邮件先落库，失败按指数退避重试，退信可查。
-- 对应 README「后续可做」里的『SPF/DKIM 与退信重试』；用法见 docs/EMAIL.md。
--
-- 与 worker/schema.js 末尾的 DDL、src/outbox.js 的 OUTBOX_DDL、worker/outbox.js 的 OUTBOX_DDL 是同一份建表语句。
-- 远端 D1 应用：
--   npx wrangler d1 migrations apply game-site-db --remote
-- Express 线：src/db.js 的 migrate() 本次不许动，由 src/outbox.js 的 ensureOutbox() 第一次用到时幂等补建。
--
-- 全部 IF NOT EXISTS，重复执行安全；不写 ALTER TABLE（避免两条线撞「列已存在」）。
--
-- status 取值：
--   queued   排队中（next_attempt_at 到点后由重试循环捞出来重发）
--   sent     已投递
--   failed   重试用尽，或明确不可重试（markFailed 的 retry=false）
--   bounced  收件方退信 / 明确拒绝（markBounced 会把该地址排队中与失败的信一并标掉）
-- attempts         累计尝试次数（成功那次也算）
-- last_error       最后一次失败原因（'mail_500' / 'mail_network' / 退信原文……），成功时清空
-- next_attempt_at  下次可投递时间（本地时间文本），NULL 表示不再重试
-- 退避：第 n 次失败等 base * 2^(n-1)，base 默认 60 秒（MAIL_RETRY_BASE_MS），封顶 6 小时，
--       累计 attempts 达到 MAIL_MAX_ATTEMPTS（默认 6）就落 failed。
CREATE TABLE IF NOT EXISTS mail_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr         TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  tag             TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT,
  created_at      TEXT DEFAULT (datetime('now','localtime')),
  updated_at      TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, next_attempt_at);
