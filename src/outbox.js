/**
 * 发件箱（Express / node:sqlite 线）：外发邮件先落库，失败按指数退避重试，退信可查。
 *
 * 与 worker/outbox.js 一一对应：同名同参同返回，那边多一个 db 参数、全程 await。
 * 表见 migrations/0009_mail_outbox.sql；src/db.js 的 migrate() 本次不许动，
 * 所以这里用 ensureOutbox() 幂等自愈（思路同 src/social.js 的 ensureSocial）。
 *
 * 时间统一按本地时区的 'YYYY-MM-DD HH:mm:ss' 文本存（与 datetime('now','localtime') 同格式），
 * dueList 因此可以直接用字符串比大小，挑出「到期该发」的信。
 */
import { db } from './db.js';

/** 四种状态：排队中 / 已投递 / 重试用尽 / 被退信 */
export const STATUSES = ['queued', 'sent', 'failed', 'bounced'];
/** 退避上限：6 小时 */
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/** 第一次失败后等多久，默认 60 秒；MAIL_RETRY_BASE_MS 可覆盖（单位毫秒） */
export function retryBaseMs() {
  const n = Number(process.env.MAIL_RETRY_BASE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60000;
}

/** 最多尝试几次，默认 6；MAIL_MAX_ATTEMPTS 可覆盖（至少 1） */
export function maxAttempts() {
  const n = Number(process.env.MAIL_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
}

/** 第 attempts 次失败后的等待毫秒数：base * 2^(attempts-1)，封顶 6 小时 */
export function backoffMs(attempts) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(RETRY_MAX_MS, retryBaseMs() * Math.pow(2, n - 1));
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

/**
 * mail_outbox 的建表语句。src/db.js 的 migrate() 里没有这一段（那个文件本次不许动），
 * 所以第一次用到时按幂等方式补建一次——和 src/social.js 的 ensureSocial 是一个思路。
 * Worker 线对应 worker/outbox.js 的单行版 DDL（D1 的 exec 按换行切语句，不能多行）。
 */
const OUTBOX_DDL = [
  'CREATE TABLE IF NOT EXISTS mail_outbox (' +
    '  id              INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  to_addr         TEXT NOT NULL,' +
    "  subject         TEXT NOT NULL DEFAULT ''," +
    "  body_text       TEXT NOT NULL DEFAULT ''," +
    "  tag             TEXT NOT NULL DEFAULT ''," +
    "  status          TEXT NOT NULL DEFAULT 'queued'," +
    '  attempts        INTEGER NOT NULL DEFAULT 0,' +
    "  last_error      TEXT NOT NULL DEFAULT ''," +
    '  next_attempt_at TEXT,' +
    "  created_at      TEXT DEFAULT (datetime('now','localtime'))," +
    "  updated_at      TEXT DEFAULT (datetime('now','localtime'))" +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, next_attempt_at)'
];

let readyFor = null;
let override = null;

/** 当前连接的默认库（src/db.js 的 data/games.db）；测试可以换 */
function store() {
  return override || db;
}

/**
 * 测试钩子：把发件箱接到另一个 SQLite 连接上（tools/outbox-test.mjs 跑临时库，不碰 data/games.db），
 * 传 null 恢复默认。返回之前的连接。生产代码不要用。
 */
export function useOutboxStore(handle) {
  const prev = override;
  override = handle || null;
  readyFor = null;
  return prev;
}

/** 幂等建表（每个连接只跑一次）；导出是给调用方在启动时预热用，普通调用不必手动调 */
export function ensureOutbox() {
  const h = store();
  if (readyFor === h) return h;
  for (const sql of OUTBOX_DDL) h.exec(sql);
  readyFor = h;
  return h;
}

/**
 * 入队一封信（status='queued'，next_attempt_at=现在，下一轮 dueList 就能捞到）。
 * @returns {{ok:true, id:number, status:string, next_attempt_at:string}|{ok:false, id:0, error:string}}
 */
export function enqueue({ to, subject = '', text = '', tag = '' } = {}) {
  const addr = String(to || '').trim();
  if (!addr) return { ok: false, id: 0, error: 'no_recipient' };
  const h = ensureOutbox();
  const now = stamp();
  const info = h.prepare(
    'INSERT INTO mail_outbox (to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at)' +
    " VALUES (?, ?, ?, ?, 'queued', 0, '', ?, ?, ?)"
  ).run(addr, String(subject || ''), String(text || ''), String(tag || ''), now, now, now);
  return { ok: true, id: Number(info.lastInsertRowid || 0), status: 'queued', next_attempt_at: now };
}

/**
 * 到期该发的信：status='queued' 且 next_attempt_at <= now，最早到期的先来。
 * 返回的是 mail_outbox 的原样行（to_addr / body_text / last_error 等列名不做别名）。
 */
export function dueList(now, limit = 20) {
  const h = ensureOutbox();
  return h.prepare(
    'SELECT id, to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at' +
    " FROM mail_outbox WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?" +
    ' ORDER BY next_attempt_at ASC, id ASC LIMIT ?'
  ).all(stampOf(now), clampLimit(limit, 20, 500));
}

/** 投递成功：status='sent'，清掉错误与下次时间，attempts 记一次 */
export function markSent(id) {
  const h = ensureOutbox();
  const key = Number(id) || 0;
  const info = h.prepare(
    "UPDATE mail_outbox SET status = 'sent', attempts = attempts + 1, last_error = '', next_attempt_at = NULL, updated_at = ? WHERE id = ?"
  ).run(stamp(), key);
  return { ok: Number(info.changes || 0) > 0, id: key, status: 'sent', changed: Number(info.changes || 0) };
}

/**
 * 投递失败：attempts+1，按指数退避排下一次；attempts 达到 maxAttempts() 或 retry=false 时落 failed。
 * @returns {{ok:boolean, id:number, status:string, attempts:number, delay_ms:number, next_attempt_at:(string|null)}|{ok:false, id:number, error:'not_found', status:'', attempts:0}}
 */
export function markFailed(id, error = '', { retry = true } = {}) {
  const h = ensureOutbox();
  const key = Number(id) || 0;
  const row = h.prepare('SELECT attempts FROM mail_outbox WHERE id = ?').get(key);
  if (!row) return { ok: false, id: key, status: '', attempts: 0, delay_ms: 0, next_attempt_at: null, error: 'not_found' };
  const attempts = Number(row.attempts || 0) + 1;
  const giveUp = retry === false || attempts >= maxAttempts();
  const status = giveUp ? 'failed' : 'queued';
  const delay = giveUp ? 0 : backoffMs(attempts);
  const at = stamp();
  const next = giveUp ? null : stamp(Date.now() + delay);
  h.prepare(
    'UPDATE mail_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?'
  ).run(status, attempts, String(error || '').slice(0, 500), next, at, key);
  return { ok: true, id: key, status, attempts, delay_ms: delay, next_attempt_at: next };
}

/** 各状态计数（后台「集成自检」/ 文档用），total 是所有状态之和 */
export function stats() {
  const h = ensureOutbox();
  const out = { queued: 0, sent: 0, failed: 0, bounced: 0, total: 0 };
  for (const r of h.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status').all()) {
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
export function markBounced(address, reason = '') {
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, address: '', changed: 0, error: 'no_recipient' };
  const h = ensureOutbox();
  const why = String(reason || '').slice(0, 500);
  const info = h.prepare(
    "UPDATE mail_outbox SET status = 'bounced', last_error = ?, next_attempt_at = NULL, updated_at = ?" +
    " WHERE to_addr = ? COLLATE NOCASE AND status IN ('queued', 'failed')"
  ).run(why, stamp(), addr);
  return { ok: true, address: addr, reason: why, changed: Number(info.changes || 0) };
}

/** 退信一览（后台页 / 文档引用）：count 是退信总数，rows 是最近 limit 条 */
export function bounceSummary(limit = 20) {
  const h = ensureOutbox();
  const rows = h.prepare(
    "SELECT id, to_addr, subject, tag, last_error, updated_at FROM mail_outbox WHERE status = 'bounced'" +
    ' ORDER BY updated_at DESC, id DESC LIMIT ?'
  ).all(clampLimit(limit, 20, 200));
  const c = h.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE status = 'bounced'").get();
  return { count: Number((c && c.n) || 0), rows: rows };
}
