#!/usr/bin/env node
/**
 * Web Push 两线测试：src/push-core.js（加密层）+ src/push.js（Express 线）+ worker/push.js（D1 线）
 * 跑法：node tools/push-test.mjs   （结尾打印「通过 N / 失败 M」，有失败时 exit code 1）
 *
 * 红线：不碰 data/games.db（Express 线整树复制到 %TEMP% 里跑）、不占 3000/4400 端口、
 * 假推送服务只监听 127.0.0.1 的随机端口、不 taskkill 任何浏览器。
 *
 * 覆盖面：① RFC 8291 公开测试向量 ② 往返解密 + 头布局 + 密文长度 ③ VAPID JWT 验签
 * ④ 假推送服务（201 / 404 / 410 / 500×5 / 网络异常） ⑤ 两条线存储结果逐条一致 ⑥ 没配 VAPID 时优雅空转
 */
import { createServer } from 'node:http';
import { mkdirSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// 测试进程自己不许有 VAPID 配置，否则「没配就空转」那节会假通过
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? ' :: ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' :: got ' + a + ' want ' + b); }
}
const head = (s) => console.log('\n' + s);

/* ---------------------------------------------------------------- *
 * 测试自带的独立实现（故意不复用 src/push-core.js 里的任何内部函数）
 * ---------------------------------------------------------------- */

function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  let out = Buffer.from(s, 'binary').toString('base64').split('+').join('-').split('/').join('_');
  while (out.length && out[out.length - 1] === '=') out = out.slice(0, -1);
  return out;
}
function unb64u(str) {
  let s = String(str).split('-').join('+').split('_').join('/');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}
function cat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function hkdfLocal(salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, key, len * 8));
}
/** 完整的 UA 侧解密路径：解析 aes128gcm 头 → ECDH → 两段 HKDF → AES-GCM 解密 → 去填充 */
async function decryptBody(body, uaPrivD, uaPub, auth) {
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20];
  const headerLen = 21 + idlen;
  const keyid = body.subarray(21, headerLen);
  const ct = body.subarray(headerLen);
  if (idlen !== 65) throw new Error('bad_idlen');
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(uaPrivD), x: b64u(uaPub.subarray(1, 33)), y: b64u(uaPub.subarray(33, 65)), ext: true };
  const priv = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const z = new Uint8Array([0]);
  const ikm = await hkdfLocal(auth, shared, cat(enc.encode('WebPush: info'), z, uaPub, keyid), 32);
  const cek = await hkdfLocal(salt, ikm, cat(enc.encode('Content-Encoding: aes128gcm'), z), 16);
  const nonce = await hkdfLocal(salt, ikm, cat(enc.encode('Content-Encoding: nonce'), z), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct));
  let i = record.length - 1;
  while (i >= 0 && record[i] === 0) i--;
  if (i < 0 || record[i] !== 2) throw new Error('bad_padding');
  return { plain: record.subarray(0, i), record: record, salt: salt, rs: rs, idlen: idlen, ct: ct, headerLen: headerLen };
}
/** 独立验签 VAPID JWT（给自己看的第二实现，不依赖 push-core 的 verifyVapidJwt） */
async function verifyLocal(header) {
  const raw = String(header || '');
  const at = raw.indexOf('vapid t=');
  if (at !== 0) return { ok: false, error: 'bad_header' };
  const rest = raw.slice(8);
  const kmark = rest.indexOf(', k=');
  if (kmark < 0) return { ok: false, error: 'bad_header' };
  const jwt = rest.slice(0, kmark);
  const k = rest.slice(kmark + 4).trim();
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, error: 'bad_jwt' };
  const key = await subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const good = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  const payload = JSON.parse(dec.decode(unb64u(parts[1])));
  return { ok: good, payload: payload, aud: payload.aud, exp: payload.exp, sub: payload.sub, kLen: unb64u(k).length, sigLen: unb64u(parts[2]).length, error: good ? '' : 'bad_signature' };
}

const C = await import(pathToFileURL(join(ROOT, 'src', 'push-core.js')).href);
const { encryptPayload } = C;

/* ---------------------------------------------------------------- *
 * ① RFC 8291 Appendix A 的公开测试向量
 * ---------------------------------------------------------------- */
head('① RFC 8291 Appendix A 公开测试向量');
const VEC = {
  plain: 'When I grow up, I want to be a watermelon',
  asPub: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPriv: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  cipher: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};
{
  const sub = { endpoint: 'https://example.com/vec', keys: { p256dh: VEC.uaPub, auth: VEC.auth } };
  const v = await encryptPayload(sub, VEC.plain, { salt: VEC.salt, keyPair: { publicKey: VEC.asPub, privateKey: VEC.asPriv } });
  eq('①-1 整条 body 逐字节复现（Header||密文）', b64u(v.body), VEC.body);
  eq('①-2 86 字节头 = salt16|rs|idlen|keyid65 逐字节复现', b64u(v.body.subarray(0, 86)), VEC.header);
  eq('①-3 密文（含 16 字节 tag）逐字节复现', b64u(v.body.subarray(86)), VEC.cipher);
  eq('①-4 Content-Encoding / Content-Length 头', [v.headers['Content-Encoding'], v.headers['Content-Length']], ['aes128gcm', String(v.body.length)]);
  eq('①-5 body 长度 = 86 头 + 41 明文 + 1 定界符 + 16 tag = 144', v.body.length, 144);
  const d = await decryptBody(v.body, unb64u(VEC.uaPriv), unb64u(VEC.uaPub), unb64u(VEC.auth));
  eq('①-6 用向量里的 UA 私钥解出原文', dec.decode(d.plain), VEC.plain);
}

/* ---------------------------------------------------------------- *
 * 两线的测试素材：UA 键对 / auth secret / VAPID 键对
 * ---------------------------------------------------------------- */
const uaKp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const UA_PUB_65 = new Uint8Array(await subtle.exportKey('raw', uaKp.publicKey));
const UA_PRIV_D = unb64u((await subtle.exportKey('jwk', uaKp.privateKey)).d);
const UA_PUB_B64 = b64u(UA_PUB_65);
const AUTH_16 = webcrypto.getRandomValues(new Uint8Array(16));
const AUTH_B64 = b64u(AUTH_16);

const vKp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PUB = b64u(new Uint8Array(await subtle.exportKey('raw', vKp.publicKey)));
const VAPID_PRIV = (await subtle.exportKey('jwk', vKp.privateKey)).d;
const CFG = { VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: 'mailto:push-test@fishport.cn' };
const FIXED_NOW = Date.parse('2026-10-20T12:00:00.000Z');

/* ---------------------------------------------------------------- *
 * ② 往返：自己解一遍，头布局与密文长度
 * ---------------------------------------------------------------- */
head('② 往返解密 / 头布局 / 密文长度');
{
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: UA_PUB_B64, auth: AUTH_B64 } };
  const text = '中文 + emoji 🎮 + 换行\n第二行 —— tail';
  const ptLen = enc.encode(text).length;
  const r = await encryptPayload(sub, text);
  const body = r.body;
  eq('②-1 头里的 salt 是 16 字节', body.subarray(0, 16).length, 16);
  eq('②-2 rs = 4096（4 字节大端）', new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false), 4096);
  eq('②-3 idlen = 65', body[20], 65);
  ok('②-4 keyid 是 65 字节未压缩点（0x04 开头）', body[21] === 4 && body.subarray(21, 86).length === 65);
  eq('②-5 密文 = 明文 ' + ptLen + ' 字节 + 1 个 0x02 定界符 + 16 tag', body.length - 86, ptLen + 1 + 16);
  ok('②-6 头总长 86，整条 body 无多余字节', body.length === 86 + ptLen + 1 + 16);
  const d = await decryptBody(body, UA_PRIV_D, UA_PUB_65, AUTH_16);
  eq('②-7 UA 私钥独立解出明文（逐字节相等）', dec.decode(d.plain), text);
  eq('②-8 记录末尾是 0x02 定界符（默认不加额外填充）', d.record[d.record.length - 1], 2);
  const r2 = await encryptPayload(sub, text, { pad: 1 });
  eq('②-9 opts.pad=1：密文 = 明文 + 2 个填充字节（0x02 + 0x00）+ 16 tag', r2.body.length - 86, ptLen + 2 + 16);
  const d2 = await decryptBody(r2.body, UA_PRIV_D, UA_PUB_65, AUTH_16);
  eq('②-10 带填充也能解回原文', dec.decode(d2.plain), text);
  const a1 = await encryptPayload(sub, 'x');
  const a2 = await encryptPayload(sub, 'x');
  ok('②-11 每条消息的 salt 与临时公钥都不同（不复用）',
    b64u(a1.body.subarray(0, 16)) !== b64u(a2.body.subarray(0, 16)) && b64u(a1.body.subarray(21, 86)) !== b64u(a2.body.subarray(21, 86)));
  let threw = false;
  try { await encryptPayload({ endpoint: 'http://x/y', keys: { p256dh: UA_PUB_B64, auth: AUTH_B64 } }, 'x'); } catch (e) { threw = true; }
  ok('②-12 http 端点被 isValidSubscription 拦下（encryptPayload 抛错）', threw);
  eq('②-13 isValidSubscription：好订阅 true / 坏键长 false',
    [C.isValidSubscription({ endpoint: 'https://a/b', keys: { p256dh: UA_PUB_B64, auth: AUTH_B64 } }),
     C.isValidSubscription({ endpoint: 'https://a/b', keys: { p256dh: AUTH_B64, auth: AUTH_B64 } })], [true, false]);
  eq('②-14 PUSH_KINDS 是白名单（含 daily，不含 like）',
    [C.PUSH_KINDS.includes('reply'), C.PUSH_KINDS.includes('daily'), C.PUSH_KINDS.includes('like')], [true, true, false]);
  eq('②-15 pushPayload 深链：thread/game/user/daily/未知',
    [C.pushPayload({ kind: 'reply', targetType: 'thread', targetId: '12' }).url,
     C.pushPayload({ kind: 'comment', targetType: 'game', targetId: 'minesweeper' }).url,
     C.pushPayload({ kind: 'follow', targetType: 'user', targetId: 'fish' }).url,
     C.pushPayload({ kind: 'daily' }).url,
     C.pushPayload({ kind: 'system' }).url],
    ['/forum/t/12', '/game/minesweeper', '/u/fish', '/daily', '/notifications']);
  eq('②-16 pushPayload 标题带昵称，tag 用于同目标去重',
    [C.pushPayload({ kind: 'reply', actorName: '小明', targetId: '12' }).title, C.pushPayload({ kind: 'reply', targetId: '12' }).title,
     C.pushPayload({ kind: 'reply', targetId: '12' }).tag, C.pushPayload({ kind: 'follow', actorId: 7 }).tag],
    ['小明 回复了你', '有人回复了你', 'reply-12', 'follow-7']);
}

/* ---------------------------------------------------------------- *
 * ③ VAPID JWT
 * ---------------------------------------------------------------- */
head('③ VAPID JWT（RFC 8292）');
{
  const ep = 'https://fcm.googleapis.com:8443/wp/abc';
  const h = await C.vapidHeader(ep, { publicKey: VAPID_PUB, privateKey: VAPID_PRIV, subject: 'mailto:me@fishport.cn', now: FIXED_NOW });
  ok('③-1 头格式是 vapid t=<jwt>, k=<key>', h.indexOf('vapid t=') === 0 && h.indexOf(', k=') > 0, h.slice(0, 24) + '...');
  const jwt = h.slice(8, h.indexOf(', k='));
  const kPart = h.slice(h.indexOf(', k=') + 4).trim();
  eq('③-2 k= 是归一化后的 65 字节公钥（与传入一致）', kPart, VAPID_PUB);
  eq('③-3 签名是 raw r||s 共 64 字节（不是 DER）', unb64u(jwt.split('.')[2]).length, 64);
  const v = await C.verifyVapidJwt(jwt, VAPID_PUB);
  ok('③-4 verifyVapidJwt 通过', v.ok === true, v.error);
  eq('③-5 header {typ:JWT, alg:ES256}', v.header, { typ: 'JWT', alg: 'ES256' });
  eq('③-6 aud = 端点 origin（含端口）', v.payload.aud, 'https://fcm.googleapis.com:8443');
  eq('③-7 sub 正确', v.payload.sub, 'mailto:me@fishport.cn');
  ok('③-8 exp 在未来且不超过 24 小时', v.payload.exp * 1000 > FIXED_NOW && v.payload.exp * 1000 <= FIXED_NOW + 24 * 3600 * 1000);
  const self = await verifyLocal(h);
  ok('③-9 测试自带的第二实现也能验签（互为独立证据）', self.ok === true && self.sigLen === 64 && self.kLen === 65, self.error);
  const other = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherPub = b64u(new Uint8Array(await subtle.exportKey('raw', other.publicKey)));
  const bad = await C.verifyVapidJwt(jwt, otherPub);
  ok('③-10 换错误公钥必须验签失败', bad.ok === false && bad.error === 'bad_signature', JSON.stringify(bad.error));
  const h2 = await C.vapidHeader('https://push.example.com/x', { publicKey: VAPID_PUB, privateKey: VAPID_PRIV, now: FIXED_NOW });
  eq('③-11 不给 subject 时回退到 DEFAULT_VAPID_SUBJECT', (await C.verifyVapidJwt(h2.slice(8, h2.indexOf(', k=')), VAPID_PUB)).payload.sub, C.DEFAULT_VAPID_SUBJECT);
  const h3 = await C.vapidHeader('https://push.example.com/x', { publicKey: VAPID_PUB, privateKey: VAPID_PRIV, now: FIXED_NOW, expiresInMs: 48 * 3600 * 1000 });
  ok('③-12 expiresInMs 超过 24h 会被夹到 24h 以内（RFC 上限）',
    (await C.verifyVapidJwt(h3.slice(8, h3.indexOf(', k=')), VAPID_PUB)).payload.exp * 1000 <= FIXED_NOW + 24 * 3600 * 1000);
  let threw = false;
  try { await C.vapidHeader('not-a-url', { publicKey: VAPID_PUB, privateKey: VAPID_PRIV }); } catch (e) { threw = true; }
  ok('③-13 坏端点会抛错（调用方在 deliver 里兜住）', threw);
}

/* ---------------------------------------------------------------- *
 * 假推送服务（④）+ 两线投递/存储套件（⑤）
 * ---------------------------------------------------------------- */
let port = 0;
const requests = [];
const counters = new Map();
const seen = (p) => {
  for (let i = requests.length - 1; i >= 0; i--) if (requests[i].path === p) return requests[i];
  return null;
};
const hits = (p) => counters.get(p) || 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const path = String(req.url || '/').split('?')[0];
    const body = new Uint8Array(Buffer.concat(chunks));
    const rec = {
      path: path, method: req.method || '', bytes: body.length,
      enc: String(req.headers['content-encoding'] || ''),
      auth: String(req.headers.authorization || ''),
      ttl: String(req.headers.ttl || ''), topic: String(req.headers.topic || ''), urgency: String(req.headers.urgency || ''),
      ct: '', decrypted: '', error: '', rs: -1, idlen: -1, saltLen: -1
    };
    try {
      const d = await decryptBody(body, UA_PRIV_D, UA_PUB_65, AUTH_16);
      rec.rs = d.rs; rec.idlen = d.idlen; rec.saltLen = d.salt.length;
      rec.ct = b64u(d.ct);
      rec.decrypted = dec.decode(d.plain);
    } catch (err) { rec.error = String((err && err.message) || err); }
    requests.push(rec);
    counters.set(path, hits(path) + 1);
    const status = path.indexOf('/gone404') === 0 ? 404 : path.indexOf('/gone410') === 0 ? 410 : path.indexOf('/boom') === 0 ? 500 : 201;
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(status === 201 ? 'ok' : 'nope');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
const epOf = (p) => 'https://127.0.0.1:' + port + p;
/** 订阅必须是 https（isValidSubscription 的要求），但假服务是 http；投递时把 scheme 换回来 */
const toLocal = (url, init) => fetch(String(url).split('https://127.0.0.1:').join('http://127.0.0.1:'), init);

/* ---------------------------------------------------------------- *
 * 两条线的装配
 * ---------------------------------------------------------------- */
head('⑤ 装配两条线');
const tmp = mkdtempSync(join(tmpdir(), 'game-site-push-'));
mkdirSync(join(tmp, 'public'), { recursive: true });
mkdirSync(join(tmp, 'games'), { recursive: true });
mkdirSync(join(tmp, 'data'), { recursive: true });
cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
if (typeof dbmod.migrate === 'function') dbmod.migrate();
const P = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href).then(() => import(pathToFileURL(join(tmp, 'src', 'push.js')).href));
const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
const W = await import(pathToFileURL(join(ROOT, 'worker', 'push.js')).href);
const wdb = new LocalD1(':memory:');
console.log('  · Express 线副本：' + tmp);
console.log('  · Worker 线：LocalD1(:memory:)');

eq('⑤-1 两线 PUSH_DDL 逐字相同', P.PUSH_DDL, W.PUSH_DDL);
ok('⑤-2 每条 DDL 都是单行（D1 的 exec 按换行切）', P.PUSH_DDL.every((s) => s.indexOf('\n') < 0), String(P.PUSH_DDL.length) + ' 条');
eq('⑤-3 两线失败阈值相同', [P.PUSH_FAIL_LIMIT, W.PUSH_FAIL_LIMIT], [5, 5]);

const apiE = {
  tag: 'express',
  ensurePush: () => P.ensurePush(),
  subscribe: (u, s, a) => P.subscribe(u, s, a),
  unsubscribe: (u, e) => P.unsubscribe(u, e),
  listSubscriptions: (u) => P.listSubscriptions(u),
  deliver: (u, pl, o) => P.deliver(u, pl, o),
  pushConfigured: (env) => P.pushConfigured(env),
  vapidPublicKey: (env) => P.vapidPublicKey(env),
  notifyPush: (u, n, o) => P.notifyPush(u, n, o)
};
const apiW = {
  tag: 'worker',
  ensurePush: () => W.ensurePush(wdb),
  subscribe: (u, s, a) => W.subscribe(wdb, u, s, a),
  unsubscribe: (u, e) => W.unsubscribe(wdb, u, e),
  listSubscriptions: (u) => W.listSubscriptions(wdb, u),
  deliver: (u, pl, o) => W.deliver(wdb, (o && o.env) || {}, u, pl, o),
  pushConfigured: (env) => W.pushConfigured(env),
  vapidPublicKey: (env) => W.vapidPublicKey(env),
  notifyPush: (u, n, o) => W.notifyPush(wdb, (o && o.env) || {}, u, n, o)
};

/** created_at 用的是真实时钟，两线必然不同毫秒；其余字段必须逐条一致 */
const normRow = (r) => ({ id: r.id, user_id: r.user_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, ua: r.ua, ok_at: r.ok_at, fail_count: r.fail_count, disabled: r.disabled });
const normAll = (rows) => (rows || []).map(normRow);
const zero = { sent: 0, pruned: 0, failed: 0, skipped: 0 };

/* ---------------------------------------------------------------- *
 * ④ + ⑤ 套件：同一条脚本跑两遍，返回值逐条比对
 * ---------------------------------------------------------------- */
head('④ 假推送服务 / ⑤ 两线一致');
const traceE = [];
const traceW = [];

async function suite(A, trace) {
  const L = '[' + A.tag + ']';
  const rec = (v) => { trace.push(JSON.stringify(v)); return v; };
  const pathOf = (p, u) => '/' + p + '-' + u;
  const ep = (p, u) => epOf(pathOf(p, u));
  const subOf = (p, u, auth = AUTH_B64) => ({ endpoint: ep(p, u), keys: { p256dh: UA_PUB_B64, auth: auth } });
  const payload = { title: '小明 回复了你', body: '点开看看', url: '/forum/t/42', tag: 'reply-42', kind: 'reply' };
  const opts = { fetchImpl: toLocal, now: FIXED_NOW, env: CFG };
  const u1 = 5001;
  const u2 = 5002;
  const u3 = 5003;

  // --- 存储：幂等 upsert ---
  const r1 = rec(await A.subscribe(u1, subOf('ok', u1), 'UA/1'));
  ok(L + ' subscribe 返回 ok 与自增 id', r1.ok === true && r1.id > 0, JSON.stringify(r1));
  const r2 = rec(await A.subscribe(u1, subOf('ok', u1), 'UA/2'));
  ok(L + ' 同 endpoint 重复订阅是同一个 id（upsert 幂等）', r2.ok === true && r2.id === r1.id, JSON.stringify(r2));
  const rows1 = rec(normAll(await A.listSubscriptions(u1)));
  ok(L + ' 幂等 upsert 只留一行且 ua 已更新', rows1.length === 1 && rows1[0].ua === 'UA/2', JSON.stringify(rows1));
  rec(await A.subscribe(u1, { endpoint: 'http://insecure/x', keys: { p256dh: UA_PUB_B64, auth: AUTH_B64 } }));
  eq(L + ' 坏订阅（http）被拒', trace[trace.length - 1], JSON.stringify({ ok: false, id: 0, error: 'bad_subscription' }));
  rec(await A.subscribe(0, subOf('ok', 0)));
  eq(L + ' userId=0 被拒', trace[trace.length - 1], JSON.stringify({ ok: false, id: 0, error: 'bad_user' }));

  // --- 201 → sent ---
  const d1 = rec(await A.deliver(u1, payload, opts));
  eq(L + ' 201：sent=1 其余为零', d1, { sent: 1, pruned: 0, failed: 0, skipped: 0 });
  const rowOk = rec(normAll(await A.listSubscriptions(u1)))[0];
  ok(L + ' 201：写 ok_at、fail_count 归零', rowOk.ok_at === new Date(FIXED_NOW).toISOString() && rowOk.fail_count === 0, JSON.stringify(rowOk));
  const srv = seen(pathOf('ok', u1));
  ok(L + ' 服务端收到 POST + Content-Encoding: aes128gcm', srv && srv.method === 'POST' && srv.enc === 'aes128gcm', JSON.stringify(srv && { m: srv.method, e: srv.enc }));
  ok(L + ' 服务端用 UA 私钥解出的体 = 推送 JSON', srv && srv.error === '' && JSON.stringify(JSON.parse(srv.decrypted)) === JSON.stringify(payload), srv ? (srv.error || srv.decrypted) : 'no request');
  ok(L + ' 服务端解出的头布局正确（salt16/rs4096/idlen65）', srv && srv.saltLen === 16 && srv.rs === 4096 && srv.idlen === 65, JSON.stringify(srv && { s: srv.saltLen, r: srv.rs, i: srv.idlen }));
  const vig = srv ? await verifyLocal(srv.auth) : { ok: false, error: 'no request' };
  ok(L + ' Authorization 是可验签的 vapid t=<jwt>, k=<65 字节>', vig.ok === true && vig.kLen === 65 && vig.sigLen === 64, vig.error || '');
  ok(L + ' VAPID aud = 端点 origin、exp 在注入时间之后', vig.aud === epOf('') && vig.exp * 1000 > FIXED_NOW && vig.exp * 1000 <= FIXED_NOW + 24 * 3600 * 1000, JSON.stringify({ aud: vig.aud, exp: vig.exp }));
  eq(L + ' TTL / Urgency / Topic 头', [srv.ttl, srv.urgency, srv.topic], ['86400', 'normal', 'reply-42']);

  // --- 404 / 410 → 删订阅 ---
  rec(await A.subscribe(u1, subOf('gone404', u1)));
  const d404 = rec(await A.deliver(u1, payload, opts));
  eq(L + ' 404：pruned=1、已成功的那条不受影响', d404, { sent: 1, pruned: 1, failed: 0, skipped: 0 });
  const rows404 = rec(normAll(await A.listSubscriptions(u1)));
  ok(L + ' 404：订阅已从表里删掉', rows404.length === 1 && rows404[0].endpoint === ep('ok', u1), JSON.stringify(rows404.map((r) => r.endpoint)));
  rec(await A.subscribe(u1, subOf('gone410', u1)));
  const d410 = rec(await A.deliver(u1, payload, opts));
  eq(L + ' 410：pruned=1', d410, { sent: 1, pruned: 1, failed: 0, skipped: 0 });
  const rows410 = rec(normAll(await A.listSubscriptions(u1)));
  ok(L + ' 410：订阅已从表里删掉', rows410.length === 1 && rows410[0].endpoint === ep('ok', u1), JSON.stringify(rows410.map((r) => r.endpoint)));

  // --- 500 ×5 → disabled ---
  rec(await A.subscribe(u1, subOf('boom', u1)));
  for (let i = 1; i <= 5; i++) {
    const d = rec(await A.deliver(u1, payload, opts));
    const row = rec(normAll(await A.listSubscriptions(u1))).filter((r) => r.endpoint === ep('boom', u1))[0];
    ok(L + ' 500 第 ' + i + ' 次：failed=1、fail_count=' + i, d.failed === 1 && d.sent === 1 && row && row.fail_count === i, JSON.stringify({ d: d, row: row }));
  }
  const dead = rec(normAll(await A.listSubscriptions(u1))).filter((r) => r.endpoint === ep('boom', u1))[0];
  eq(L + ' 5 次失败后 disabled=1', [dead.disabled, dead.fail_count], [1, 5]);
  const beforeBoom = hits(pathOf('boom', u1));
  const d6 = rec(await A.deliver(u1, payload, opts));
  ok(L + ' disabled 的订阅不再被 POST（只投还活着的）', hits(pathOf('boom', u1)) === beforeBoom && d6.sent === 1 && d6.failed === 0, JSON.stringify({ before: beforeBoom, after: hits(pathOf('boom', u1)), d: d6 }));

  // --- 混合 + 网络异常 ---
  rec(await A.subscribe(u2, subOf('ok', u2)));
  rec(await A.subscribe(u2, subOf('boom', u2)));
  const dm = rec(await A.deliver(u2, payload, opts));
  eq(L + ' 混合：一条成功一条失败', dm, { sent: 1, pruned: 0, failed: 1, skipped: 0 });
  rec(await A.subscribe(u3, subOf('ok', u3)));
  const boomFetch = () => { throw new Error('net_down'); };
  const dnet = rec(await A.deliver(u3, payload, { fetchImpl: boomFetch, now: FIXED_NOW, env: CFG }));
  eq(L + ' fetch 抛异常：failed=1（异常不外泄）', dnet, { sent: 0, pruned: 0, failed: 1, skipped: 0 });
  const rowNet = rec(normAll(await A.listSubscriptions(u3)))[0];
  ok(L + ' 网络错误只累计 fail_count，不删订阅', rowNet.fail_count === 1 && rowNet.disabled === 0, JSON.stringify(rowNet));

  // --- 退订 ---
  eq(L + ' 按 endpoint 退订', rec(await A.unsubscribe(u2, ep('boom', u2))), { ok: true, removed: 1 });
  eq(L + ' endpoint 空串 = 退掉该用户全部', rec(await A.unsubscribe(u2)), { ok: true, removed: 1 });
  eq(L + ' 退订不存在的订阅 removed=0', rec(await A.unsubscribe(u2, ep('nope', u2))), { ok: true, removed: 0 });
  eq(L + ' 退订后列表为空', rec(normAll(await A.listSubscriptions(u2))), []);
  eq(L + ' 不存在的用户列表为空', rec(normAll(await A.listSubscriptions(999999))), []);
  rec(await A.unsubscribe(0));
  eq(L + ' userId=0 退订被拒', trace[trace.length - 1], JSON.stringify({ ok: false, removed: 0 }));
  // --- 同一 endpoint 换用户（同一浏览器换账号登录）---
  const sharedSub = { endpoint: epOf('/shared'), keys: { p256dh: UA_PUB_B64, auth: AUTH_B64 } };
  const first = rec(await A.subscribe(6001, sharedSub, 'UA/3'));
  const moved = rec(await A.subscribe(6002, sharedSub, 'UA/4'));
  const rowsMoved = rec(normAll(await A.listSubscriptions(6002)));
  ok(L + ' 同一 endpoint 换用户后归属新用户且仍只有一行', moved.id === first.id && rowsMoved.length === 1 && rowsMoved[0].user_id === 6002, JSON.stringify(rowsMoved));
  eq(L + ' 原用户已看不到这条订阅', rec(normAll(await A.listSubscriptions(6001))), []);
  await A.ensurePush();
  await A.ensurePush();
  rec({ ensure_push_twice_ok: true });
  ok(L + ' ensurePush 幂等（重复调用不报错）', true);
}

await suite(apiE, traceE);
await suite(apiW, traceW);

let firstDiff = -1;
for (let i = 0; i < Math.max(traceE.length, traceW.length); i++) {
  if (traceE[i] !== traceW[i]) { firstDiff = i; break; }
}
ok('⑤-4 两线 ' + traceE.length + ' 步返回值逐条一致', firstDiff < 0,
  firstDiff < 0 ? '' : ('第 ' + (firstDiff + 1) + ' 步 express=' + traceE[firstDiff] + ' worker=' + traceW[firstDiff]));
eq('⑤-5 两线最终 push_subs 内容一致（忽略 created_at）',
  [normAll(await apiE.listSubscriptions(5001)), normAll(await apiE.listSubscriptions(5002)), normAll(await apiE.listSubscriptions(5003)), normAll(await apiE.listSubscriptions(6002))],
  [normAll(await apiW.listSubscriptions(5001)), normAll(await apiW.listSubscriptions(5002)), normAll(await apiW.listSubscriptions(5003)), normAll(await apiW.listSubscriptions(6002))]);
eq('⑤-6 两线 pushConfigured 四态一致', [apiE.pushConfigured({}), apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB }), apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: 'admin@x.com' }), apiE.pushConfigured(CFG)],
  [apiW.pushConfigured({}), apiW.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB }), apiW.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: 'admin@x.com' }), apiW.pushConfigured(CFG)]);
eq('⑤-7 两线 vapidPublicKey 一致（好配置给出 65 字节公钥 / 空配置给空串）', [apiE.vapidPublicKey(CFG), apiE.vapidPublicKey({})], [apiW.vapidPublicKey(CFG), apiW.vapidPublicKey({})]);
ok('⑤-8 vapidPublicKey 是给浏览器的 base64url（无填充、43 字符）', apiE.vapidPublicKey(CFG) === VAPID_PUB && VAPID_PUB.length === 87 && VAPID_PUB.indexOf('=') < 0, apiE.vapidPublicKey(CFG).length + ' 字符');
/* 光比 PUSH_DDL 字符串还不够：Express 线的表通常由 src/db.js 的 migrate() 先建出来，
   Workers 线由 worker/schema.js 建，两处与模块内 PUSH_DDL 若有一处不同（例如漏了 AUTOINCREMENT），
   行号分配就会分叉——⑤-4/⑤-5 的逐条比对正是这样炸出来的。这里直接比库里的建表语句。 */
{
  const normSql = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sqlE = normSql((dbmod.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'push_subs'").get() || {}).sql);
  const sqlW = normSql((await wdb.prepare("SELECT sql FROM sqlite_master WHERE name = 'push_subs'").first() || {}).sql);
  ok('⑤-9 两线实际建出的 push_subs 表结构逐字一致（含 AUTOINCREMENT）', sqlE !== '' && sqlE === sqlW, sqlE === sqlW ? sqlE.slice(0, 120) : ('express=' + sqlE + ' / worker=' + sqlW));
}

/* ---------------------------------------------------------------- *
 * ⑥ 没配 VAPID：整条链路空转
 * ---------------------------------------------------------------- */
head('⑥ 未配置 VAPID 时优雅空转');
{
  eq('⑥-1 一对键都没有 → no_keys', [apiE.pushConfigured({}).ok, apiE.pushConfigured({}).reason], [false, 'no_keys']);
  eq('⑥-2 只有一半键 → bad_keys', apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB }).reason, 'bad_keys');
  eq('⑥-3 键长度不对 → bad_keys', apiE.pushConfigured({ VAPID_PUBLIC_KEY: 'AAAA', VAPID_PRIVATE_KEY: 'BBBB' }).reason, 'bad_keys');
  eq('⑥-4 SUBJECT 不合法 → no_subject', apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: 'admin@fishport.cn' }).reason, 'no_subject');
  eq('⑥-5 不配 SUBJECT 回退默认并在返回值里标注',
    [apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV }).ok,
     apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV }).subject,
     apiE.pushConfigured({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV }).defaultSubject,
     apiE.pushConfigured(CFG).defaultSubject],
    [true, C.DEFAULT_VAPID_SUBJECT, true, false]);
  eq('⑥-6 没配置时 vapidPublicKey 返回空串', [apiE.vapidPublicKey({}), apiW.vapidPublicKey({})], ['', '']);

  // deliver：没配置 → 零值返回，且一个 SQL 都不查（拿会炸的 store 当探针）
  const bombE = new Proxy({}, { get() { throw new Error('db_touched'); }, has() { throw new Error('db_touched'); } });
  const prevStore = P.usePushStore(bombE);
  let touched = false;
  let zeroDeliver = null;
  try { zeroDeliver = await P.deliver(1, { title: 'x', kind: 'reply' }, { env: {} }); } catch (e) { touched = true; }
  eq('⑥-7 Express 线 deliver 未配置 → 零值', zeroDeliver, zero);
  ok('⑥-8 Express 线 deliver 未配置 → 不碰数据库', touched === false);
  let threwN = false;
  try { P.notifyPush(1, { kind: 'reply', actorId: 2, actorName: 'A' }); } catch (e) { threwN = true; }
  ok('⑥-9 Express 线 notifyPush 未配置 → 立刻返回、不抛异常、不查库', threwN === false);
  try { P.notifyPush(1, { kind: 'like', actorId: 2 }, { env: CFG }); } catch (e) { threwN = true; }
  ok('⑥-10 kind 不在白名单（like）→ 连库都不查', threwN === false);
  P.usePushStore(prevStore);

  const bombW = new Proxy({}, { get() { throw new Error('db_touched'); } });
  let wZero = null;
  let wThrew = false;
  try { wZero = await W.deliver(bombW, {}, 1, { title: 'x', kind: 'reply' }); } catch (e) { wThrew = true; }
  eq('⑥-11 Worker 线 deliver 未配置 → 零值且不碰 D1', [wZero, wThrew], [zero, false]);
  let wN = false;
  try { W.notifyPush(bombW, {}, 1, { kind: 'reply' }); W.notifyPush(bombW, CFG, 1, { kind: 'like' }); } catch (e) { wN = true; }
  ok('⑥-12 Worker 线 notifyPush 未配置/非白名单 → 不抛异常、不碰 D1', wN === false);
  ok('⑥-13 未配置时 deliver 对没订阅的用户同样零值', JSON.stringify(await apiE.deliver(4242, { title: 'x' }, { env: {} })) === JSON.stringify(zero));
}

/* ---------------------------------------------------------------- *
 * ⑦ PUSH_AUTO_KEYS 自举（库里现生成一对 VAPID 键）
 * ---------------------------------------------------------------- */
head('⑦ PUSH_AUTO_KEYS 自举');
{
  const FLAG = { PUSH_AUTO_KEYS: '1' };
  const rowsOf = (h) => h.prepare('SELECT k, v FROM push_keys').all();
  // Express：第一次解析就生成并落库
  const before = rowsOf(dbmod.db).length;
  const cfgE = P.resolveVapid(FLAG);
  ok('⑦-1 打开开关后 resolveVapid 给出可用配置（source=db）', cfgE.ok === true && cfgE.source === 'db', cfgE.source + ' / ok=' + cfgE.ok);
  ok('⑦-2 公钥是 65 字节未压缩点、私钥是 32 字节标量（base64url 无填充）',
    unb64u(cfgE.publicKey).length === 65 && unb64u(cfgE.privateKey).length === 32 && cfgE.publicKey.indexOf('=') < 0,
    cfgE.publicKey.length + ' / ' + cfgE.privateKey.length + ' 字符');
  eq('⑦-3 库里正好落了 public/private/subject 三行（此前 ' + before + ' 行）', rowsOf(dbmod.db).map((r) => r.k).sort(), ['private', 'public', 'subject']);
  const rowsE1 = rowsOf(dbmod.db);
  const cfgE2 = P.resolveVapid(FLAG);
  ok('⑦-4 再解析一次拿到同一对键、不重复生成', cfgE2.publicKey === cfgE.publicKey && cfgE2.privateKey === cfgE.privateKey && JSON.stringify(rowsOf(dbmod.db)) === JSON.stringify(rowsE1));
  eq('⑦-5 keyForClient 与库里公钥一致（且是给浏览器的 base64url）', P.keyForClient(FLAG), cfgE.publicKey);
  eq('⑦-6 开关关掉后，库里的键不再外泄（keyForClient 回空串、resolveVapid 不 ok）', [P.keyForClient({}), P.resolveVapid({}).ok], ['', false]);
  const envCfg = P.resolveVapid({ VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: 'mailto:admin@fishport.cn', PUSH_AUTO_KEYS: '1' });
  ok('⑦-7 环境变量给了三件套时优先用它（source=env），不碰库里的自举键', envCfg.source === 'env' && envCfg.publicKey === VAPID_PUB && envCfg.privateKey === VAPID_PRIV && JSON.stringify(rowsOf(dbmod.db)) === JSON.stringify(rowsE1));
  const badFlag = P.resolveVapid({ PUSH_AUTO_KEYS: 'yes' });
  ok('⑦-8 开关认 yes/on/true/1 四种写法，其它值一律当关', badFlag.ok === true && P.resolveVapid({ PUSH_AUTO_KEYS: 'maybe' }).ok === false && P.resolveVapid({ PUSH_AUTO_KEYS: '0' }).ok === false);
  // Worker：同一套语义（首参是 D1）
  const wdb2 = new LocalD1(':memory:');
  const cfgW = await W.resolveVapid(wdb2, FLAG);
  ok('⑦-9 Worker 线同样自举成功（source=db，长度合规）', cfgW.ok === true && cfgW.source === 'db' && unb64u(cfgW.publicKey).length === 65 && unb64u(cfgW.privateKey).length === 32);
  eq('⑦-10 Worker 线也只落三行、再解析拿同一对键', [(await wdb2.prepare('SELECT k FROM push_keys').all()).results.map((r) => r.k).sort(), await W.keyForClient(wdb2, FLAG)], [['private', 'public', 'subject'], cfgW.publicKey]);
  // 并发首启：两个请求同时进来，只能有一对键留下来（靠 INSERT OR IGNORE）
  const wdb3 = new LocalD1(':memory:');
  const [c1, c2, c3] = await Promise.all([W.keyForClient(wdb3, FLAG), W.keyForClient(wdb3, FLAG), W.keyForClient(wdb3, FLAG)]);
  const rowsW3 = (await wdb3.prepare('SELECT k, v FROM push_keys').all()).results;
  ok('⑦-11 并发首启不分叉：三次读回同一把公钥、库里仍只有三行', c1 !== '' && c1 === c2 && c2 === c3 && rowsW3.length === 3 && rowsW3.filter((r) => r.k === 'public')[0].v === c1, rowsW3.length + ' 行');
  eq('⑦-12 Worker 线关掉开关同样不外泄、没有 env 时也照旧空转', [await W.keyForClient(wdb2, {}), (await W.resolveVapid(wdb2, {})).ok], ['', false]);
  // 库里被写坏（长度不对）时不当作可用配置，降级回去而不是拿坏键去签 JWT
  await dbmod.db.prepare("UPDATE push_keys SET v = 'AAAA' WHERE k = 'public'").run();
  ok('⑦-13 库里的键被写坏 → 当没配置降级（不拿坏键去签名）', P.resolveVapid(FLAG).ok === false && P.keyForClient(FLAG) === '');
  await dbmod.db.prepare('UPDATE push_keys SET v = ? WHERE k = ?').run(cfgE.publicKey, 'public');
  ok('⑦-14 修回去立刻恢复可用（坏键不会被缓存住）', P.keyForClient(FLAG) === cfgE.publicKey);
}

/* ---------------------------------------------------------------- *
 * 收尾
 * ---------------------------------------------------------------- */
await new Promise((resolve) => server.close(resolve));
head('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exitCode = 1;
