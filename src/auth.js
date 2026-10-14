/** 账号与会话：node:crypto 的 scrypt 加盐哈希 + 存库的随机 token，零第三方依赖 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const KEYLEN = 64;
const SESSION_DAYS = 30;
const COOKIE = 'sid';

/* ---------- cookie ---------- */

/** 极简 cookie 解析（不引 cookie-parser） */
export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setCookie(res, value, maxAge) {
  res.append('Set-Cookie',
    COOKIE + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax; HttpOnly');
}

/* ---------- 口令 ---------- */

export function hashPassword(password, salt) {
  const s = salt || randomBytes(16).toString('hex');
  return { salt: s, hash: scryptSync(password, s, KEYLEN).toString('hex') };
}

export function verifyPassword(password, salt, hash) {
  let calc;
  try { calc = scryptSync(password, salt, KEYLEN); } catch { return false; }
  const want = Buffer.from(String(hash), 'hex');
  // 长度不等时 timingSafeEqual 会抛异常，先挡一道
  return calc.length === want.length && timingSafeEqual(calc, want);
}

/* ---------- 校验 ---------- */

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,16}$/;

/** 校验注册表单，返回 { error } 或清洗过的字段 */
export function validateRegister(username, password, displayName) {
  const u = String(username || '').trim();
  const p = String(password || '');
  const d = String(displayName || '').trim() || u;
  if (!USERNAME_RE.test(u)) return { error: '用户名需为 2~16 位中文、字母、数字、下划线或短横线' };
  if (p.length < 6) return { error: '密码至少 6 位' };
  if (p.length > 72) return { error: '密码最长 72 位' };
  if (d.length > 20) return { error: '昵称最长 20 个字' };
  return { username: u, password: p, displayName: d };
}

/* ---------- 用户 ---------- */

export function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
}

export function createUser(username, password, displayName, role = 'user') {
  const { salt, hash } = hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (username, display_name, pass_hash, pass_salt, role) VALUES (?, ?, ?, ?, ?)'
  ).run(username, displayName || username, hash, salt, role);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid)));
}

/** 只把能公开的字段发给模板，pass_hash / pass_salt 永远不出去 */
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.display_name, role: u.role, created_at: u.created_at };
}

/** 校验账号密码，成功返回 { user }，失败返回 { error } */
export function login(username, password) {
  const row = findUser(username);
  // 用户不存在时也跑一次 scrypt，避免用响应时间探测账号是否存在
  if (!row) { hashPassword(String(password || ''), 'decoy-salt'); return { error: '用户名或密码不对' }; }
  if (!verifyPassword(String(password || ''), row.pass_salt, row.pass_hash)) {
    return { error: '用户名或密码不对' };
  }
  return { user: publicUser(row) };
}

/* ---------- 会话 ---------- */

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime','+30 days'))"
  ).run(token, userId);
  return token;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 从请求里还原当前登录用户，未登录返回 null */
export function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id ' +
    "WHERE s.token = ? AND s.expires_at > datetime('now','localtime')"
  ).get(token) || null;
  return publicUser(row);
}

/** 登录成功后种 cookie，退出时清掉（Max-Age=0） */
export function startSession(res, userId) {
  setCookie(res, createSession(userId), SESSION_DAYS * 24 * 3600);
}

export function endSession(req, res) {
  destroySession(readCookie(req, COOKIE));
  setCookie(res, '', 0);
}

export { COOKIE as SESSION_COOKIE };

/* ---------- 管理员 ---------- */

export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

/**
 * 首次启动时确保有一个管理员账号。
 * 用户名密码可用 ADMIN_USER / ADMIN_PASS 覆盖；没设就用默认值，启动日志会警告。
 */
export function ensureAdmin() {
  const has = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (has) return false;
  const username = String(process.env.ADMIN_USER || DEFAULT_ADMIN.username).trim();
  const password = String(process.env.ADMIN_PASS || DEFAULT_ADMIN.password);
  createUser(username, password, '站长', 'admin');
  return true;
}

/** 默认口令还没改的话，启动时提醒一句 */
export function usingDefaultAdminPassword() {
  if (process.env.ADMIN_PASS) return false;
  const row = db.prepare("SELECT pass_salt, pass_hash FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!row) return false;
  return verifyPassword(DEFAULT_ADMIN.password, row.pass_salt, row.pass_hash);
}
