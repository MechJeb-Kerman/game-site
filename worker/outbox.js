/**
 * 发件箱（Workers + D1 版）：逻辑与 src/outbox.js 完全一致，唯一区别是 db 从第一个参数来、全程 await。
 *
 * 表见 migrations/0009_mail_outbox.sql（worker/schema.js 末尾合入的是同一份 DDL）。
 * 注意：D1 的 exec() 是按换行切语句执行的，跨多行的 CREATE TABLE 会被切坏
 *   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS mail_outbox (: incomplete input
 * 所以下面的 DDL 每条都必须写成单行字符串；这里也不用 exec()，而是逐条 prepare().run()（同 worker/schema.js）。
 *
 * 时间统一按 'YYYY-MM-DD HH:mm:ss' 文本存，dueList 直接比字符串挑「到期该发」的信。
 */

/** 四种状态：排队中 / 已投递 / 重试用尽 / 被退信 */
export const STATUSES = ['queued', 'sent', 'failed', 'bounced'];
/** 退避上限：6 小时 */
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/** 第一次失败后等多久，默认 60 秒；MAIL_RETRY_BASE_MS 可覆盖（单位毫秒） */
export function retryBaseMs(env) {
  const n = Number((env || {}).MAIL_RETRY_BASE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60000;
}

/** 最多尝试几次，默认 6；MAIL_MAX_ATTEMPTS 可覆盖（至少 1） */
export function maxAttempts(env) {
  const n = Number((env || {}).MAIL_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
}

/** 第 attempts 次失败后的等待毫秒数：base * 2^(attempts-1)，封顶 6 小时 */
export function backoffMs(env, attempts) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(RETRY_MAX_MS, retryBaseMs(env) * Math.pow(2, n - 1));
}

/** 本地时区 'YYYY-MM-DD HH:mm:ss'（和 datetime('now','localtime') 一个格式） */
function stamp(when) {
  const d = when instanceof Date ? when : new Date(when === undefined || when === null ? Date.now() : when);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** now 参数三态：不传=现在、Date、毫秒数、或 'YYYY-MM-DD HH:mm:ss' 文本 */
function stampOf(now) {
  if (typeof now === 'string' && now.trim()) {
    const d = new Date(now.trim().replace(' ', 'T'));
    return isNaN(d.getTime()) ? stamp() : stamp(d);
  }
  return stamp(now);
}

function clampLimit(limit, def, max) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

/** 每条都是单行：D1 的 exec() 按换行切语句，多行会被切坏（对应 src/outbox.js 的 OUTBOX_DDL） */
export const OUTBOX_DDL = [
  "CREATE TABLE IF NOT EXISTS mail_outbox ( id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', next_attempt_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')) )",
  "CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, next_attempt_at)"
];

/** 已经建过表的连接（同一个 isolate 内只跑一次） */
const READY = new WeakSet();

/** 幂等建表；db 缺绑定时报 no_d1_binding（调用方自己决定是否忽略） */
export async function ensureOutbox(db) {
  if (!db) throw new Error('no_d1_binding');
  if (READY.has(db)) return db;
  for (const sql of OUTBOX_DDL) await db.prepare(sql).run();
  READY.add(db);
  return db;
}

/**
 * 入队一封信（status='queued'，next_attempt_at=现在，下一轮 dueList 就能捞到）。
 * @returns {{ok:true, id:number, status:string, next_attempt_at:string}|{ok:false, id:0, error:string}}
 */
export async function enqueue(db, { to, subject = '', text = '', tag = '' } = {}) {
  const addr = String(to || '').trim();
  if (!addr) return { ok: false, id: 0, error: 'no_recipient' };
  await ensureOutbox(db);
  const now = stamp();
  const info = await db.prepare(
    'INSERT INTO mail_outbox (to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at)' +
    " VALUES (?, ?, ?, ?, 'queued', 0, '', ?, ?, ?)"
  ).bind(addr, String(subject || ''), String(text || ''), String(tag || ''), now, now, now).run();
  const meta = (info && info.meta) || {};
  return { ok: true, id: Number(meta.last_row_id || 0), status: 'queued', next_attempt_at: now };
}

/**
 * 到期该发的信：status='queued' 且 next_attempt_at <= now，最早到期的先来。
 * 返回的是 mail_outbox 的原样行（to_addr / body_text / last_error 等列名不做别名）。
 */
export async function dueList(db, now, limit = 20) {
  await ensureOutbox(db);
  const rows = await db.prepare(
    'SELECT id, to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at' +
    " FROM mail_outbox WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?" +
    ' ORDER BY next_attempt_at ASC, id ASC LIMIT ?'
  ).bind(stampOf(now), clampLimit(limit, 20, 500)).all();
  return (rows && rows.results) || [];
}

/** 投递成功：status='sent'，清掉错误与下次时间，attempts 记一次 */
export async function markSent(db, id) {
  await ensureOutbox(db);
  const key = Number(id) || 0;
  const info = await db.prepare(
    "UPDATE mail_outbox SET status = 'sent', attempts = attempts + 1, last_error = '', next_attempt_at = NULL, updated_at = ? WHERE id = ?"
  ).bind(stamp(), key).run();
  const changed = Number(((info && info.meta) || {}).changes || 0);
  return { ok: changed > 0, id: key, status: 'sent', changed: changed };
}

/**
 * 投递失败：attempts+1，按指数退避排下一次；attempts 达到 maxAttempts(env) 或 retry=false 时落 failed。
 * @returns {{ok:boolean, id:number, status:string, attempts:number, delay_ms:number, next_attempt_at:(string|null)}|{ok:false, id:number, error:'not_found', status:'', attempts:0}}
 */
export async function markFailed(env, db, id, error = '', { retry = true } = {}) {
  await ensureOutbox(db);
  const key = Number(id) || 0;
  const row = await db.prepare('SELECT attempts FROM mail_outbox WHERE id = ?').bind(key).first();
  if (!row) return { ok: false, id: key, status: '', attempts: 0, delay_ms: 0, next_attempt_at: null, error: 'not_found' };
  const attempts = Number(row.attempts || 0) + 1;
  const giveUp = retry === false || attempts >= maxAttempts(env);
  const status = giveUp ? 'failed' : 'queued';
  const delay = giveUp ? 0 : backoffMs(env, attempts);
  const next = giveUp ? null : stamp(Date.now() + delay);
  await db.prepare(
    'UPDATE mail_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?'
  ).bind(status, attempts, String(error || '').slice(0, 500), next, stamp(), key).run();
  return { ok: true, id: key, status, attempts, delay_ms: delay, next_attempt_at: next };
}

/** 各状态计数（后台「集成自检」/ 文档用），total 是所有状态之和 */
export async function stats(db) {
  await ensureOutbox(db);
  const out = { queued: 0, sent: 0, failed: 0, bounced: 0, total: 0 };
  const rows = await db.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status').all();
  for (const r of (rows && rows.results) || []) {
    const k = String(r.status || '');
    const n = Number(r.n || 0);
    if (STATUSES.indexOf(k) >= 0) out[k] = n;
    out.total += n;
  }
  return out;
}

/**
 * 退信：把这个地址「排队中 / 重试用尽」的信一并标成 bounced（已投递的不动）。
 * 地址比较忽略大小写，重复调用幂等。
 * @returns {{ok:true, address:string, reason:string, changed:number}|{ok:false, address:string, changed:0, error:string}}
 */
export async function markBounced(db, address, reason = '') {
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, address: '', changed: 0, error: 'no_recipient' };
  await ensureOutbox(db);
  const why = String(reason || '').slice(0, 500);
  const info = await db.prepare(
    "UPDATE mail_outbox SET status = 'bounced', last_error = ?, next_attempt_at = NULL, updated_at = ?" +
    " WHERE to_addr = ? COLLATE NOCASE AND status IN ('queued', 'failed')"
  ).bind(why, stamp(), addr).run();
  const changed = Number(((info && info.meta) || {}).changes || 0);
  return { ok: true, address: addr, reason: why, changed: changed };
}

/** 退信一览（后台页 / 文档引用）：count 是退信总数，rows 是最近 limit 条 */
export async function bounceSummary(db, limit = 20) {
  await ensureOutbox(db);
  const rows = await db.prepare(
    "SELECT id, to_addr, subject, tag, last_error, updated_at FROM mail_outbox WHERE status = 'bounced'" +
    ' ORDER BY updated_at DESC, id DESC LIMIT ?'
  ).bind(clampLimit(limit, 20, 200)).all();
  const c = await db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'bounced'").first();
  return { count: Number((c && c.n) || 0), rows: (rows && rows.results) || [] };
}
