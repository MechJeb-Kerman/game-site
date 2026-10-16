/**
 * D1 版账号与会话：WebCrypto 的 PBKDF2-SHA256 加盐哈希 + 存库的随机 token。
 * 与 Express 版 src/auth.js 行为一致，只是把 node:crypto 的 scrypt 换成 Workers 里可用的 PBKDF2
 * （Node 22 与 Cloudflare Workers 都有 globalThis.crypto，两边都能跑）。
 */
const ITERATIONS = 100000;   // PBKDF2-SHA256 迭代次数
const KEYLEN_BYTES = 32;
export const SESSION_DAYS = 30;
export const COOKIE = 'sid';

/* ---------- cookie ---------- */

/** 极简 cookie 解析（不引第三方库） */
export function readCookie(headerValue, name) {
  const raw = String(headerValue || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** 生成 Set-Cookie 头；退出登录时 maxAge=0 立即失效 */
export function sessionCookie(value, maxAge) {
  return COOKIE + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax; HttpOnly';
}

/* ---------- 口令 ---------- */

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function randomHex(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

async function pbkdf2(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations: ITERATIONS },
    key,
    KEYLEN_BYTES * 8
  );
  return toHex(new Uint8Array(bits));
}

export async function hashPassword(password, salt) {
  const s = salt || randomHex(16);
  return { salt: s, hash: await pbkdf2(password, s) };
}

/** 定长时间比较，避免用响应时间猜测哈希前缀 */
function timingSafeEqualHex(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, salt, hash) {
  try {
    return timingSafeEqualHex(await pbkdf2(password, salt), hash);
  } catch {
    return false;
  }
}

/* ---------- 校验 ---------- */

const USERNAME_RE = /^[A-Za-z0-9_一-龥-]{2,16}$/;

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

export async function findUser(db, username) {
  return (await db.prepare('SELECT * FROM users WHERE username = ?')
    .bind(String(username || '').trim()).first()) || null;
}

export async function createUser(db, username, password, displayName, role) {
  const { salt, hash } = await hashPassword(password);
  const res = await db.prepare(
    'INSERT INTO users (username, display_name, pass_hash, pass_salt, role) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, displayName || username, hash, salt, role || 'user').run();
  const row = await db.prepare('SELECT * FROM users WHERE id = ?')
    .bind(Number(res.meta.last_row_id)).first();
  return publicUser(row);
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

/** 校验账号密码，成功返回 { user }，失败返回 { error } */
export async function login(db, username, password) {
  const row = await findUser(db, username);
  // 用户不存在时也跑一次哈希，避免用响应时间探测账号是否存在
  if (!row) { await hashPassword(String(password || ''), 'decoy-salt'); return { error: '用户名或密码不对' }; }
  if (!(await verifyPassword(String(password || ''), row.pass_salt, row.pass_hash))) {
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

export async function createSession(db, userId) {
  const token = randomHex(32);
  await db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime','+30 days'))"
  ).bind(token, userId).run();
  return token;
}

export async function destroySession(db, token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/** 从请求里还原当前登录用户，未登录返回 null */
export async function currentUser(db, request) {
  const token = readCookie(request.headers.get('cookie'), COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id ' +
    "WHERE s.token = ? AND s.expires_at > datetime('now','localtime')"
  ).bind(token).first();
  return activeOrNull(row || null);
}

/* ---------- 管理员 ---------- */

export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

/** 首次运行时确保有一个管理员账号；用户名密码可用 ADMIN_USER / ADMIN_PASS 覆盖 */
export async function ensureAdmin(db, env) {
  const has = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
  if (has) return false;
  const username = String((env && env.ADMIN_USER) || DEFAULT_ADMIN.username).trim();
  const password = String((env && env.ADMIN_PASS) || DEFAULT_ADMIN.password);
  await createUser(db, username, password, '站长', 'admin');
  return true;
}

/** 默认口令还没改的话，启动时提醒一句 */
export async function usingDefaultAdminPassword(db, env) {
  if (env && env.ADMIN_PASS) return false;
  const row = await db.prepare("SELECT pass_salt, pass_hash FROM users WHERE role = 'admin' LIMIT 1").first();
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

export async function findUserByEmail(db, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return (await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').bind(e).first()) || null;
}

/** 邮箱是否被别的账号占了 */
export async function emailTaken(db, email, exceptUserId = 0) {
  const row = await findUserByEmail(db, email);
  return !!row && Number(row.id) !== Number(exceptUserId);
}

function newToken() {
  return randomHex(32);
}

/**
 * 给账号设置/更换邮箱，并生成验证链接用的 token。
 * 换邮箱会把 email_verified 归零，避免拿别人的邮箱来解锁。
 */
export async function setEmail(db, userId, email) {
  const e = normalizeEmail(email);
  if (!validEmail(e)) return { error: '邮箱格式不对' };
  if (await emailTaken(db, e, userId)) return { error: '这个邮箱已经绑定过别的账号了' };
  const token = newToken();
  await db.prepare('UPDATE users SET email = ?, email_verified = 0, verify_token = ?,' +
    " verify_expires = datetime('now','localtime', ?) WHERE id = ?")
    .bind(e, token, '+' + VERIFY_HOURS + ' hours', Number(userId)).run();
  return { email: e, token };
}

/** 重新发一封验证邮件（邮箱没变，只换 token） */
export async function refreshVerifyToken(db, userId) {
  const token = newToken();
  const info = await db.prepare('UPDATE users SET verify_token = ?,' +
    " verify_expires = datetime('now','localtime', ?) WHERE id = ?")
    .bind(token, '+' + VERIFY_HOURS + ' hours', Number(userId)).run();
  return info.meta.changes ? { token } : { error: 'not_found' };
}

/** 点验证链接：token 对得上且没过期就置为已验证 */
export async function verifyEmailToken(db, token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return { error: '链接无效' };
  const row = await db.prepare('SELECT * FROM users' +
    " WHERE verify_token = ? AND verify_expires > datetime('now','localtime')").bind(t).first();
  if (!row) return { error: '链接已失效，请重新发送验证邮件' };
  await db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?')
    .bind(row.id).run();
  return { user: publicUser(Object.assign({}, row, { email_verified: 1 })), email: row.email };
}

/** 站长手动把某个账号标记为已验证（线下核实用） */
export async function markEmailVerified(db, userId) {
  const info = await db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?')
    .bind(Number(userId)).run();
  return info.meta.changes ? { ok: true } : { error: 'not_found' };
}

/* ---------- 找回密码 ---------- */

/**
 * 申请重置：账号可以填用户名或邮箱。
 * 无论账号是否存在都返回 ok，避免被用来探测注册情况；dev 下把 token 带出来方便自测。
 */
export async function createResetToken(db, account) {
  const key = String(account || '').trim();
  if (!key) return { error: '请填写用户名或邮箱' };
  const row = key.includes('@')
    ? await findUserByEmail(db, key)
    : (await db.prepare('SELECT * FROM users WHERE username = ?').bind(key).first()) || null;
  if (!row) return { ok: true, sent: false };
  if (Number(row.banned)) return { ok: true, sent: false };
  // 没绑定邮箱的账号拿不到链接（也没法发信），同样不暴露账号是否存在
  if (!row.email) return { ok: true, sent: false };
  // 旧的没用完的链接作废，保证同一时间只有一个有效 token
  await db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').bind(row.id).run();
  const token = newToken();
  await db.prepare("INSERT INTO password_resets (token, user_id, expires_at)" +
    " VALUES (?, ?, datetime('now','localtime', ?))")
    .bind(token, row.id, '+' + RESET_MINUTES + ' minutes').run();
  return { ok: true, sent: true, token, user: publicUser(row) };
}

/** 用重置 token 改密码：一次性，用完即废，并把所有登录态踢掉 */
export async function consumeResetToken(db, token, password) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return { error: '链接无效' };
  const pw = String(password || '');
  if (pw.length < 6) return { error: '密码至少 6 位' };
  if (pw.length > 72) return { error: '密码最长 72 位' };
  const row = await db.prepare('SELECT * FROM password_resets' +
    " WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now','localtime')").bind(t).first();
  if (!row) return { error: '链接已失效，请重新申请' };
  const { salt, hash } = await hashPassword(pw);
  // D1 没有可交互事务，三条写操作一次 batch 提交
  await db.batch([
    db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, row.user_id),
    db.prepare("UPDATE password_resets SET used_at = datetime('now','localtime') WHERE token = ?").bind(t),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id)
  ]);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  return { user: publicUser(user) };
}

/** 改密码（已登录用户自助），成功后踢掉所有会话 */
export async function changePassword(db, userId, oldPassword, newPassword) {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(Number(userId)).first();
  if (!row) return { error: 'not_found' };
  if (oldPassword !== undefined && !(await verifyPassword(String(oldPassword || ''), row.pass_salt, row.pass_hash))) {
    return { error: '原密码不对' };
  }
  const pw = String(newPassword || '');
  if (pw.length < 6) return { error: '密码至少 6 位' };
  if (pw.length > 72) return { error: '密码最长 72 位' };
  const { salt, hash } = await hashPassword(pw);
  await db.batch([
    db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, row.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id)
  ]);
  return { ok: true };
}

/* ---------- 第三方登录 ---------- */

/** 用昵称/用户名派生一个站内唯一的用户名 */
async function uniqueUsername(db, base) {
  let seed = String(base || '').replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '').slice(0, 12) || 'user';
  if (seed.length < 2) seed = 'user' + seed;
  let name = seed;
  for (let i = 2; await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(name).first(); i++) {
    name = seed.slice(0, 12) + i;
  }
  return name;
}

export async function oauthAccountsOf(db, userId) {
  const rows = await db.prepare('SELECT provider, provider_uid, created_at FROM oauth_accounts WHERE user_id = ?')
    .bind(Number(userId)).all();
  return rows.results;
}

export async function unlinkOAuth(db, userId, provider) {
  const info = await db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?')
    .bind(Number(userId), String(provider)).run();
  return info.meta.changes ? { ok: true } : { error: 'not_found' };
}

/**
 * 第三方登录落地：先找绑定关系，再按邮箱认领老账号，最后才新建。
 * 新建的账号口令是随机串，用户只能继续用第三方登录（或走找回密码自己设一个）。
 * @returns {{error:string}|{user:object, created:boolean, linked:boolean}}
 */
export async function oauthLogin(db, provider, providerUid, profile = {}) {
  const p = String(provider || '').trim().slice(0, 20);
  const uid = String(providerUid || '').trim().slice(0, 120);
  if (!p || !uid) return { error: 'bad_provider' };
  const linked = await db.prepare('SELECT * FROM oauth_accounts WHERE provider = ? AND provider_uid = ?')
    .bind(p, uid).first();
  if (linked) {
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(linked.user_id).first();
    if (!row) return { error: 'not_found' };
    if (Number(row.banned)) return { error: '账号已被封禁' };
    return { user: publicUser(row), created: false, linked: false };
  }

  const email = normalizeEmail(profile.email);
  let row = email && validEmail(email) ? await findUserByEmail(db, email) : null;
  if (row) {
    if (Number(row.banned)) return { error: '账号已被封禁' };
    await db.prepare('INSERT INTO oauth_accounts (provider, provider_uid, user_id) VALUES (?, ?, ?)')
      .bind(p, uid, row.id).run();
    if (email && !row.email) {
      await db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').bind(email, row.id).run();
      row = Object.assign({}, row, { email: email, email_verified: 1 });
    }
    return { user: publicUser(row), created: false, linked: true };
  }

  const username = await uniqueUsername(db, profile.username || profile.name || p + uid.slice(0, 6));
  const display = String(profile.name || profile.username || username).slice(0, 20);
  const created = await createUser(db, username, newToken().slice(0, 16), display);
  await db.prepare('INSERT INTO oauth_accounts (provider, provider_uid, user_id) VALUES (?, ?, ?)')
    .bind(p, uid, created.id).run();
  if (email && validEmail(email)) {
    await db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').bind(email, created.id).run();
  }
  return { user: Object.assign({}, created, { email: email || '', email_verified: email ? 1 : 0 }), created: true, linked: false };
}
