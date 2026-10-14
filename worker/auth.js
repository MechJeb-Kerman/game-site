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
  return { id: u.id, username: u.username, name: u.display_name, role: u.role, created_at: u.created_at };
}

/** 校验账号密码，成功返回 { user }，失败返回 { error } */
export async function login(db, username, password) {
  const row = await findUser(db, username);
  // 用户不存在时也跑一次哈希，避免用响应时间探测账号是否存在
  if (!row) { await hashPassword(String(password || ''), 'decoy-salt'); return { error: '用户名或密码不对' }; }
  if (!(await verifyPassword(String(password || ''), row.pass_salt, row.pass_hash))) {
    return { error: '用户名或密码不对' };
  }
  return { user: publicUser(row) };
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
  return publicUser(row || null);
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
