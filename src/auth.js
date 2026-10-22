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

/**
 * 想让 game-site.fishport.cn 与 forum.fishport.cn 共用登录态，就把 COOKIE_DOMAIN 设成 .fishport.cn。
 * 不设时是「只对当前主机有效」的普通 cookie——本机 127.0.0.1 与 *.workers.dev 必须这样，
 * 那种主机名写了 Domain，浏览器会把整条 cookie 直接丢掉（登录于是永远失败）。
 */
function cookieDomain() {
  const d = String(process.env.COOKIE_DOMAIN || '').trim();
  if (!d) return '';
  return '; Domain=' + (d.charAt(0) === '.' ? d : '.' + d);
}

function setCookie(res, value, maxAge) {
  res.append('Set-Cookie',
    COOKIE + '=' + value + '; Path=/; Max-Age=' + maxAge + cookieDomain() + '; SameSite=Lax; HttpOnly');
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
  return {
    id: u.id,
    username: u.username,
    name: u.display_name,
    role: u.role,
    created_at: u.created_at,
    email: u.email || '',
    email_verified: Number(u.email_verified) ? 1 : 0,
    banned: Number(u.banned) ? 1 : 0,
    banned_reason: u.banned_reason || ''
  };
}

/** 校验账号密码，成功返回 { user }，失败返回 { error }。被封禁的账号在这里就被挡掉 */
export function login(username, password) {
  const row = findUser(username);
  // 用户不存在时也跑一次 scrypt，避免用响应时间探测账号是否存在
  if (!row) { hashPassword(String(password || ''), 'decoy-salt'); return { error: '用户名或密码不对' }; }
  if (!verifyPassword(String(password || ''), row.pass_salt, row.pass_hash)) {
    return { error: '用户名或密码不对' };
  }
  if (Number(row.banned)) {
    return { error: '账号已被封禁' + (row.banned_reason ? '：' + row.banned_reason : '') };
  }
  return { user: publicUser(row) };
}

/** 封禁用户不再能通过会话恢复登录态（封禁时已清 sessions，这里再兜一道） */
function activeOrNull(row) {
  if (!row) return null;
  if (Number(row.banned)) return null;
  return publicUser(row);
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
  return activeOrNull(row);
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
  let password = String(process.env.ADMIN_PASS || '');
  let generated = '';
  if (!password) {
    /* 生产环境不落「admin/admin123」：没给 ADMIN_PASS 就随机生成一个，只在启动日志里出现一次。
       开发环境仍用默认值，否则每次 reset 都要去翻日志抄口令，本地调试成本太高。 */
    if (process.env.NODE_ENV === 'production') {
      password = randomBytes(12).toString('base64url');
      generated = password;
    } else {
      password = DEFAULT_ADMIN.password;
    }
  }
  createUser(username, password, '站长', 'admin');
  if (generated) {
    console.warn('[auth] NODE_ENV=production 且未设置 ADMIN_PASS，已生成随机站长口令：' + generated);
    console.warn('[auth] 这个口令只打印这一次，请立即登录 /admin 修改，或用 ADMIN_PASS 固定它。');
  }
  return true;
}

/** 默认口令还没改的话，启动时提醒一句 */
export function usingDefaultAdminPassword() {
  if (process.env.ADMIN_PASS) return false;
  const row = db.prepare("SELECT pass_salt, pass_hash FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!row) return false;
  return verifyPassword(DEFAULT_ADMIN.password, row.pass_salt, row.pass_hash);
}

/* ================= 账号增强：邮箱验证 / 找回密码 / 第三方登录 ================= */

/** 验证邮件有效期（小时）与重置链接有效期（分钟） */
export const VERIFY_HOURS = 24;
export const RESET_MINUTES = 30;

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 120);
}

export function validEmail(email) {
  const e = normalizeEmail(email);
  return e.length >= 6 && e.length <= 120 && EMAIL_RE.test(e);
}

export function findUserByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(e) || null;
}

/** 邮箱是否被别的账号占了 */
export function emailTaken(email, exceptUserId = 0) {
  const row = findUserByEmail(email);
  return !!row && Number(row.id) !== Number(exceptUserId);
}

function newToken() {
  return randomBytes(32).toString('hex');
}

/**
 * 给账号设置/更换邮箱，并生成验证链接用的 token。
 * 换邮箱会把 email_verified 归零，避免拿别人的邮箱来解锁。
 */
export function setEmail(userId, email) {
  const e = normalizeEmail(email);
  if (!validEmail(e)) return { error: '邮箱格式不对' };
  if (emailTaken(e, userId)) return { error: '这个邮箱已经绑定过别的账号了' };
  const token = newToken();
  db.prepare(`UPDATE users SET email = ?, email_verified = 0, verify_token = ?,
      verify_expires = datetime('now','localtime', ?) WHERE id = ?`)
    .run(e, token, '+' + VERIFY_HOURS + ' hours', Number(userId));
  return { email: e, token };
}

/** 重新发一封验证邮件（邮箱没变，只换 token） */
export function refreshVerifyToken(userId) {
  const token = newToken();
  const info = db.prepare(`UPDATE users SET verify_token = ?, verify_expires = datetime('now','localtime', ?)
    WHERE id = ?`).run(token, '+' + VERIFY_HOURS + ' hours', Number(userId));
  return info.changes ? { token } : { error: 'not_found' };
}

/** 点验证链接：token 对得上且没过期就置为已验证 */
export function verifyEmailToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return { error: '链接无效' };
  const row = db.prepare(`SELECT * FROM users
    WHERE verify_token = ? AND verify_expires > datetime('now','localtime')`).get(t);
  if (!row) return { error: '链接已失效，请重新发送验证邮件' };
  db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?')
    .run(row.id);
  return { user: publicUser({ ...row, email_verified: 1 }), email: row.email };
}

/** 站长手动把某个账号标记为已验证（线下核实用） */
export function markEmailVerified(userId) {
  const info = db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?').run(Number(userId));
  return info.changes ? { ok: true } : { error: 'not_found' };
}

/* ---------- 找回密码 ---------- */

/**
 * 申请重置：账号可以填用户名或邮箱。
 * 无论账号是否存在都返回 ok，避免被用来探测注册情况；dev 下把 token 带出来方便自测。
 */
export function createResetToken(account) {
  const key = String(account || '').trim();
  if (!key) return { error: '请填写用户名或邮箱' };
  const row = key.includes('@')
    ? findUserByEmail(key)
    : db.prepare('SELECT * FROM users WHERE username = ?').get(key) || null;
  if (!row) return { ok: true, sent: false };
  if (Number(row.banned)) return { ok: true, sent: false };
  // 没绑定邮箱的账号拿不到链接（也没法发信），同样不暴露账号是否存在
  if (!row.email) return { ok: true, sent: false };
  // 旧的没用完的链接作废，保证同一时间只有一个有效 token
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(row.id);
  const token = newToken();
  db.prepare(`INSERT INTO password_resets (token, user_id, expires_at)
    VALUES (?, ?, datetime('now','localtime', ?))`)
    .run(token, row.id, '+' + RESET_MINUTES + ' minutes');
  return { ok: true, sent: true, token, user: publicUser(row) };
}

/** 用重置 token 改密码：一次性，用完即废，并把所有登录态踢掉 */
export function consumeResetToken(token, password) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return { error: '链接无效' };
  const p = String(password || '');
  if (p.length < 6) return { error: '密码至少 6 位' };
  if (p.length > 72) return { error: '密码最长 72 位' };
  const row = db.prepare(`SELECT * FROM password_resets
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now','localtime')`).get(t);
  if (!row) return { error: '链接已失效，请重新申请' };
  const { salt, hash } = hashPassword(p);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, row.user_id);
    db.prepare("UPDATE password_resets SET used_at = datetime('now','localtime') WHERE token = ?").run(t);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return { user: publicUser(user) };
}

/** 改密码（已登录用户自助），成功后踢掉其它会话 */
export function changePassword(userId, oldPassword, newPassword) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!row) return { error: 'not_found' };
  if (oldPassword !== undefined && !verifyPassword(String(oldPassword || ''), row.pass_salt, row.pass_hash)) {
    return { error: '原密码不对' };
  }
  const p = String(newPassword || '');
  if (p.length < 6) return { error: '密码至少 6 位' };
  if (p.length > 72) return { error: '密码最长 72 位' };
  const { salt, hash } = hashPassword(p);
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  return { ok: true };
}

/* ---------- 第三方登录 ---------- */

/** 用昵称/用户名派生一个站内唯一的用户名 */
function uniqueUsername(base) {
  let seed = String(base || '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '').slice(0, 12) || 'user';
  if (seed.length < 2) seed = 'user' + seed;
  let name = seed;
  for (let i = 2; db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(name); i++) {
    name = seed.slice(0, 12) + i;
  }
  return name;
}

export function oauthAccountsOf(userId) {
  return db.prepare('SELECT provider, provider_uid, created_at FROM oauth_accounts WHERE user_id = ?')
    .all(Number(userId));
}

export function unlinkOAuth(userId, provider) {
  const info = db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?')
    .run(Number(userId), String(provider));
  return info.changes ? { ok: true } : { error: 'not_found' };
}

/**
 * 第三方登录落地：先找绑定关系，再按邮箱认领老账号，最后才新建。
 * 新建的账号口令是随机串，用户只能继续用第三方登录（或走找回密码自己设一个）。
 * @returns {{error:string}|{user:object, created:boolean, linked:boolean}}
 */
export function oauthLogin(provider, providerUid, profile = {}) {
  const p = String(provider || '').trim().slice(0, 20);
  const uid = String(providerUid || '').trim().slice(0, 120);
  if (!p || !uid) return { error: 'bad_provider' };
  const linked = db.prepare('SELECT * FROM oauth_accounts WHERE provider = ? AND provider_uid = ?').get(p, uid);
  if (linked) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(linked.user_id);
    if (!row) return { error: 'not_found' };
    if (Number(row.banned)) return { error: '账号已被封禁' };
    return { user: publicUser(row), created: false, linked: false };
  }

  const email = normalizeEmail(profile.email);
  let row = email && validEmail(email) ? findUserByEmail(email) : null;
  if (row) {
    if (Number(row.banned)) return { error: '账号已被封禁' };
    db.prepare('INSERT INTO oauth_accounts (provider, provider_uid, user_id) VALUES (?, ?, ?)')
      .run(p, uid, row.id);
    if (email && !row.email) {
      db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, row.id);
      row = { ...row, email, email_verified: 1 };
    }
    return { user: publicUser(row), created: false, linked: true };
  }

  const username = uniqueUsername(profile.username || profile.name || p + uid.slice(0, 6));
  const display = String(profile.name || profile.username || username).slice(0, 20);
  const created = createUser(username, newToken().slice(0, 16), display);
  db.prepare('INSERT INTO oauth_accounts (provider, provider_uid, user_id) VALUES (?, ?, ?)')
    .run(p, uid, created.id);
  if (email && validEmail(email)) {
    db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, created.id);
  }
  return { user: { ...created, email: email || '', email_verified: email ? 1 : 0 }, created: true, linked: false };
}

