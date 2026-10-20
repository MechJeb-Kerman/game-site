/**
 * Web Push 加密层（RFC 8291 aes128gcm 内容加密 + RFC 8292 VAPID 鉴权）——纯逻辑、零依赖、两线共用。
 *
 * 这个文件不 import 任何东西（连 node: 内置模块都不用），只依赖 globalThis.crypto.subtle，
 * 所以同一份源码在 Node 22+（Express 线 src/push.js）与 Workerd（Workers 线 worker/push.js）
 * 里行为一致。两条线只在这一层下面分叉：一边 node:sqlite、一边 D1。
 *
 * VAPID 三件套怎么生成（生成一次，写进 .env / wrangler secret；src/push.js 的文件头也有同一段）：
 *   node -e "(async()=>{const{webcrypto:c}=require('node:crypto');const k=await c.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const pub=Buffer.from(await c.subtle.exportKey('raw',k.publicKey)).toString('base64url');const jwk=await c.subtle.exportKey('jwk',k.privateKey);console.log('VAPID_PUBLIC_KEY='+pub);console.log('VAPID_PRIVATE_KEY='+jwk.d);})()"
 *   VAPID_PUBLIC_KEY：65 字节未压缩点（04||x||y）的 base64url，无填充。
 *   VAPID_PRIVATE_KEY：32 字节 raw 标量的 base64url，无填充。
 *   VAPID_SUBJECT：mailto:xxx 或 https://xxx。
 *   公钥那半要以 base64url 字符串发给浏览器当 applicationServerKey（浏览器自己会解码，别去补 '='）。
 *
 * 加密取舍（别改，改了两条线一起坏）：
 *   - aes128gcm 记录：头 = salt(16) || rs(4 字节大端 = 4096) || idlen(1 = 65) || keyid(65)；
 *     keyid 是本服务器这一条消息的临时 ECDH 公钥；头后面是密文 + 16 字节 GCM tag。
 *   - 明文按 RFC 8188 记录格式补 1 个 0x02 定界符（padding delimiter）再加密，
 *     所以密文长度 = 明文字节数 + 1 + 16；要更多填充用 opts.pad 在定界符之后追加 N 个 0x00（默认 0），
 *     记录 = data || 0x02 || 0x00×pad，密文长度 = 明文字节数 + 1 + pad + 16。
 *     这一条用 RFC 8291 Appendix A 的公开测试向量逐字节对齐（tools/push-test.mjs 第 1 节）。
 *   - AES-GCM 的 additionalData 为空（RFC 8188 就是这个定义；把 86 字节头当 AAD 算不出向量的密文）。
 *   - HKDF-SHA256 两段：IKM = HKDF(auth_secret, ecdh, "WebPush: info"||0x00||ua||as, 32)；
 *     CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm"||0x00, 16)；NONCE = HKDF(salt, IKM, "Content-Encoding: nonce"||0x00, 12)。
 *   - VAPID 的 ES256 签名是 raw r||s（64 字节），不是 DER；WebCrypto 默认就给 raw。
 *   - 用到的键都是 P-256：DH 用 ECDH、签名用 ECDSA，标量/点可以互换（同一个曲线参数）。
 */

/** 会被推送到手机的通知 kind 白名单（与 src/social.js 的 NOTIFY_KINDS 对齐，另加 daily 每日挑战提醒）。不在白名单的 kind 一律不推。 */
export const PUSH_KINDS = ['reply', 'mention', 'follow', 'message', 'comment', 'system', 'daily'];

/** VAPID_SUBJECT 缺省值（src/push.js 的 pushConfigured 会在返回值里标注用的就是这个） */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@fishport.cn';

/** RFC 8188 记录大小 rs，写进头部 4 字节；单条记录明文的硬上限就是它减掉 tag。 */
const RECORD_SIZE = 4096;

/* ------------------------------------------------------------------ *
 * 字节 / base64url 小工具（btoa/atob 在 Node 22+ 与 Workerd 都有）
 * ------------------------------------------------------------------ */

/** 任意二进制输入 → Uint8Array（Uint8Array / ArrayBuffer / Buffer / 数字数组 / 字符串按 UTF-8） */
export function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return new Uint8Array(0);
}

/** 拼接若干 Uint8Array */
function cat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(String(s));
const fromUtf8 = (b) => new TextDecoder().decode(b);

/** base64url，无填充 */
export function b64u(buf) {
  const b = toBytes(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（也容忍标准 base64 的 +/ 与结尾 = 与空白）→ Uint8Array；不合法时抛错 */
export function fromB64u(str) {
  const raw = String(str == null ? '' : str).replace(/\s+/g, '').replace(/=+$/, '');
  if (!raw) return new Uint8Array(0);
  const s = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/]/.test(s)) throw new Error('bad_base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 键的 base64url 归一化（容忍补了 '=' 的写法）；不合法返回空串 */
function canonKey(v) {
  try {
    const b = toBytes(v);
    const bytes = typeof v === 'string' ? fromB64u(v) : b;
    return bytes.length ? b64u(bytes) : '';
  } catch (err) {
    return '';
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const seg = (v) => { const s = String(v == null ? '' : v).trim(); return s ? encodeURIComponent(s) : ''; };

/* ------------------------------------------------------------------ *
 * 订阅校验
 * ------------------------------------------------------------------ */

/**
 * 浏览器 PushSubscription.toJSON() 的形状：{ endpoint, keys: { p256dh, auth } }。
 * 这里同时接受 keys 拍平与不拍平两种写法。
 * @returns {boolean} endpoint 是 https、p256dh 65 字节、auth 16 字节才为 true
 */
export function isValidSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const endpoint = String(sub.endpoint == null ? '' : sub.endpoint).trim();
  if (!/^https:\/\//i.test(endpoint)) return false;
  try {
    if (new URL(endpoint).protocol !== 'https:') return false;
  } catch (err) {
    return false;
  }
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : sub;
  try {
    if (fromB64u(keys.p256dh).length !== 65) return false;
    if (fromB64u(keys.auth).length !== 16) return false;
  } catch (err) {
    return false;
  }
  return true;
}

/** 拍平 keys 包装（存库 / 加密都只看 endpoint+p256dh+auth） */
function subFields(sub) {
  const keys = sub && sub.keys && typeof sub.keys === 'object' ? sub.keys : (sub || {});
  return {
    endpoint: String((sub && sub.endpoint) || '').trim(),
    p256dh: String(keys.p256dh || ''),
    auth: String(keys.auth || '')
  };
}

/* ------------------------------------------------------------------ *
 * 通知文案 / 深链（纯函数，不查库）
 * ------------------------------------------------------------------ */

const KIND_TEXT = {
  reply: { actor: true, title: '回复了你', body: '点开查看回复内容', url: '/notifications' },
  mention: { actor: true, title: '提到了你', body: '点开查看内容', url: '/notifications' },
  message: { actor: true, title: '给你发了私信', body: '点开查看私信', url: '/notifications' },
  comment: { actor: true, title: '评论了你的游戏', body: '点开查看评论', url: '/notifications' },
  follow: { actor: true, title: '关注了你', body: '点开看看 TA 的主页', url: '/notifications' },
  system: { actor: false, title: '系统通知', body: '', url: '/notifications' },
  daily: { actor: false, title: '每日挑战已刷新', body: '来挑战今天的谜题', url: '/daily' },
  default: { actor: false, title: '新通知', body: '', url: '/notifications' }
};

/** 深链规则与 src/views.js 的 noticeHref 对齐：thread → /forum/t/<id>、game → /game/<id>、user → /u/<id>、replay → /replay/<id>、daily → /daily */
function targetUrl(targetType, targetId, kind, actorName) {
  const type = String(targetType || '').trim().toLowerCase();
  const id = seg(targetId);
  if (id) {
    if (type === 'thread' || type === 'post' || type === 'forum') return '/forum/t/' + id;
    if (type === 'game') return '/game/' + id;
    if (type === 'user') return '/u/' + id;
    if (type === 'replay') return '/replay/' + id;
    if (type === 'daily') return '/daily';
  }
  if (type === 'daily') return '/daily';
  // targetType 认不出来（或没带）= 按 kind 兜底，仍然是可点开的页面而不是死链
  if (kind === 'daily') return '/daily';
  if (kind === 'follow') {
    const who = id || seg(actorName);
    if (who) return '/u/' + who;
  }
  return '';
}

/**
 * 通知 → 推送载荷（纯函数）。
 * @returns {{title:string, body:string, url:string, tag:string, kind:string}} tag 用于同目标去重（Tag / Topic 头）
 */
export function pushPayload({ kind, actorId = 0, actorName = '', targetType = '', targetId = '', body = '' } = {}) {
  const k = String(kind || '').trim();
  const text = KIND_TEXT[k] || KIND_TEXT.default;
  const who = String(actorName || '').trim();
  let title = text.title;
  if (text.actor) title = who ? who + ' ' + title : '有人' + title;
  const raw = String(body || '').replace(/\s+/g, ' ').trim();
  const url = targetUrl(targetType, targetId, k, who) || text.url || '/notifications';
  const tagSeed = String(targetId || '').trim() || String(actorId || 0);
  const tag = clip(((k || 'push') + '-' + tagSeed).replace(/[^A-Za-z0-9_-]/g, '-'), 32);
  return { title: title, body: raw ? clip(raw, 140) : text.body, url: url, tag: tag, kind: k };
}

/* ------------------------------------------------------------------ *
 * HKDF / ECDH / AES-GCM
 * ------------------------------------------------------------------ */

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('no_webcrypto');
  return c.subtle;
}

/** HKDF-SHA256（extract+expand 一把） */
async function hkdf(salt, ikm, info, len) {
  const key = await subtle().importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: toBytes(salt), info: toBytes(info) }, key, len * 8);
  return new Uint8Array(bits);
}

const b64uBytes = (v) => (typeof v === 'string' ? fromB64u(v) : toBytes(v));

async function importEcdhPublic(raw65) {
  return subtle().importKey('raw', raw65, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** 32 字节标量 + 65 字节点 → 可 deriveBits 的 ECDH 私钥（JWK 形式两种运行时都吃） */
async function importEcdhPrivate(d32, pub65) {
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(d32), x: b64u(pub65.subarray(1, 33)), y: b64u(pub65.subarray(33, 65)), ext: true };
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** 这一条消息的临时 ECDH 键对；opts.keyPair 可注入（测试用 RFC 向量里的固定键） */
async function ephemeralKeyPair(injected) {
  if (injected && injected.publicKey && injected.privateKey) {
    const pub = b64uBytes(injected.publicKey);
    const priv = b64uBytes(injected.privateKey);
    if (pub.length !== 65 || priv.length !== 32) throw new Error('bad_ephemeral_keypair');
    return { pub: pub, priv: priv };
  }
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const jwk = await subtle().exportKey('jwk', kp.privateKey);
  return { pub: pub, priv: fromB64u(jwk.d) };
}

/**
 * RFC 8291 aes128gcm 加密一条推送。
 * @param {{endpoint:string, p256dh:string, auth:string}} sub 订阅（p256dh 65 字节、auth 16 字节的 base64url）
 * @param {string|Uint8Array} plaintext 明文（对象会先 JSON.stringify）
 * @param {{salt?:string|Uint8Array, keyPair?:{publicKey:string|Uint8Array, privateKey:string|Uint8Array}, pad?:number}} [opts]
 *        仅测试注入：salt（16 字节）、keyPair（这条消息的临时键对）、pad（额外的 0x00 填充字节数，默认 0）
 * @returns {Promise<{body:Uint8Array, headers:Record<string,string>}>}
 */
export async function encryptPayload(sub, plaintext, opts = {}) {
  if (!isValidSubscription(sub)) throw new Error('bad_subscription');
  const f = subFields(sub);
  const uaPub = fromB64u(f.p256dh);
  if (uaPub[0] !== 4) throw new Error('bad_public_key');   // 必须是未压缩点
  const authSecret = fromB64u(f.auth);

  const salt = opts.salt ? b64uBytes(opts.salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('bad_salt');
  const kp = await ephemeralKeyPair(opts.keyPair);

  const ecdh = new Uint8Array(await subtle().deriveBits(
    { name: 'ECDH', public: await importEcdhPublic(uaPub) },
    await importEcdhPrivate(kp.priv, kp.pub),
    256
  ));
  const keyInfo = cat(utf8('WebPush: info'), new Uint8Array([0]), uaPub, kp.pub);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, cat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const pad = Math.max(0, Math.min(Number(opts.pad) || 0, 2048));
  const data = typeof plaintext === 'string' ? utf8(plaintext)
    : (plaintext && typeof plaintext === 'object' && !(plaintext instanceof Uint8Array) && !(plaintext instanceof ArrayBuffer) && !ArrayBuffer.isView(plaintext))
      ? utf8(JSON.stringify(plaintext))
      : toBytes(plaintext);
  // RFC 8188：记录 = data || 0x02 定界符 || 0x00×pad（定界符在前、零填充在后，顺序反了 UA 会解出尾部多余的 0x00）
  const record = cat(data, new Uint8Array([2]), new Uint8Array(pad));
  if (record.length + 16 > RECORD_SIZE) throw new Error('payload_too_large');

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  const header = cat(salt, rs, new Uint8Array([65]), kp.pub);

  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // additionalData 留空：RFC 8188 就是这个定义（拿头当 AAD 会算不出 RFC 8291 的测试向量）
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, record));
  const body = cat(header, ct);
  return {
    body: body,
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.length),
      'Content-Type': 'application/octet-stream'
    }
  };
}

/* ------------------------------------------------------------------ *
 * VAPID（RFC 8292）
 * ------------------------------------------------------------------ */

/** PKCS#8（无公钥的 P-256 形式）包一个 32 字节标量；Node 与浏览器都吃，Workerd 不吃时会走 JWK 回退 */
function pkcs8FromScalar(d32) {
  return cat(Uint8Array.from([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
  ]), d32);
}

async function importVapidPrivate(privateKey, publicKey) {
  const d = b64uBytes(privateKey);
  if (d.length !== 32) throw new Error('bad_private_key');
  try {
    return await subtle().importKey('pkcs8', pkcs8FromScalar(d), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch (err) {
    const pub = b64uBytes(publicKey);
    if (pub.length !== 65) throw err;
    const jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), ext: true };
    return subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
}

/**
 * VAPID 鉴权头。
 * @param {string} endpoint 订阅的 endpoint（aud 取它的 origin）
 * @param {{publicKey:string|Uint8Array, privateKey:string|Uint8Array, subject?:string, now?:number, expiresInMs?:number}} opts
 * @returns {Promise<string>} 'vapid t=<jwt>, k=<publicKey>'
 */
export async function vapidHeader(endpoint, { publicKey, privateKey, subject, now = Date.now(), expiresInMs = 12 * 3600 * 1000 } = {}) {
  let aud = '';
  try {
    aud = new URL(String(endpoint || '')).origin;
  } catch (err) {
    aud = '';
  }
  if (!aud || aud === 'null') throw new Error('bad_endpoint');
  const k = canonKey(publicKey);
  if (!k) throw new Error('bad_public_key');
  const ttl = Math.min(Math.max(Number(expiresInMs) || 0, 60 * 1000), 24 * 3600 * 1000);   // RFC 8292：exp 不得超过 24 小时
  const claims = {
    aud: aud,
    exp: Math.floor((Number(now) + ttl) / 1000),
    sub: String(subject || DEFAULT_VAPID_SUBJECT)
  };
  const signingInput = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(utf8(JSON.stringify(claims)));
  const key = await importVapidPrivate(privateKey, publicKey);
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput)));
  if (sig.length !== 64) throw new Error('bad_signature_length');   // 必须是 raw r||s，不是 DER
  return 'vapid t=' + signingInput + '.' + b64u(sig) + ', k=' + k;
}

/**
 * 校验一个 VAPID JWT（只给测试与自检用；服务器不收 JWT，所以生产链路不调它）。
 * @returns {Promise<{ok:boolean, header?:object, payload?:object, error:string}>}
 */
export async function verifyVapidJwt(jwt, publicKey) {
  try {
    const parts = String(jwt == null ? '' : jwt).trim().split('.');
    if (parts.length !== 3) return { ok: false, error: 'bad_jwt' };
    const header = JSON.parse(fromUtf8(fromB64u(parts[0])));
    const payload = JSON.parse(fromUtf8(fromB64u(parts[1])));
    const sig = fromB64u(parts[2]);
    if (sig.length !== 64) return { ok: false, error: 'bad_signature_length', header: header, payload: payload };
    const key = await subtle().importKey('raw', fromB64u(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, utf8(parts[0] + '.' + parts[1]));
    if (!good) return { ok: false, error: 'bad_signature', header: header, payload: payload };
    return { ok: true, header: header, payload: payload, error: '' };
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
}
