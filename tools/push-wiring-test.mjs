#!/usr/bin/env node
/**
 * tools/push-wiring-test.mjs — Web Push 端到端「接线」验收（Express 线为主，Workers 线可选）
 *
 * 覆盖（每节边跑边打印 «  ok   名字 » / «  FAIL 名字 :: 详情 »）：
 *   A. DDL：src/db.js 与 worker/schema.js 的文本里有 push_subs 表与 idx_push_subs_user 索引，
 *      并且起一次真 Express 之后 PRAGMA table_info(push_subs) 真能查出 user_id/endpoint/p256dh/auth/disabled。
 *   B. 三个路由的形状与权限：GET /api/push/key（未登录也 200，configured/publicKey 87 字符/subscribed），
 *      POST /api/push/subscribe（未登录 401 login_required、形状合法 200、坏形状 400、同 endpoint 幂等 1 行），
 *      POST /api/push/unsubscribe（带 endpoint 退一条 removed:1、再退 removed:0、不带 endpoint 退全部）。
 *   C. 通知触发真推送：账号 B 走真路由 POST /u/A/follow → social.notify → notifyPush → 假推送服务收到 1 条真 HTTP，
 *      校验 VAPID 头（vapid t=…, k=…）、content-encoding: aes128gcm、ttl/urgency/topic、密文可解、两次 salt 不同、
 *      自己关注自己不推。
 *   D. 失效与熔断：假服务回 410 → 订阅行被删；回 500 连续 5 次 → fail_count=5 且 disabled=1，之后不再发请求。
 *   E. Workers 线（可选）：tools/serve-worker.mjs 起 createWorkerServer，key/subscribe/subscribed 一致，
 *      worker 侧 follow 也真推到假服务（独立库 data/worker-push-wiring-test.db，跑完删除）。
 *   F. 未配 VAPID 空转：configured:false、publicKey 空串、notify 一个 HTTP 都不发（另起一台没有 VAPID_* 的 Express 实测）。
 *
 * 怎么跑：  cd D:/CODE/game-site && node tools/push-wiring-test.mjs
 * 退出码：  有 FAIL → 1；全过 → 0。
 *
 * 安全约定（脚本自己强制）：
 *   · 绝不打开 / 绝不写 data/games.db：真 Express 跑在 %TEMP% 的仓库副本里，库是副本自建的空库；
 *   · 不监听 3000 / 4400（freePort 会跳过），绝不 kill 非本进程创建的子进程（只 child.kill()）；
 *   · 唯一在仓库里留下的中间物是 E 段临时库 data/worker-push-wiring-test.db，跑完删（容忍 Windows EBUSY 重试）。
 *
 * 本地假推送服务是明文 http，而产品线（src/push-core.js isValidSubscription）只接受 https endpoint；
 * 所以订阅用 https://127.0.0.1:<假端口>/… ，由 --import 预载到 Express 子进程的 fetch shim 把该前缀改写成 http，
 * 其余（加密、VAPID 签名、头、状态码处理）全部走真实代码路径。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DB = join(ROOT, 'data', 'games.db');
const FORBIDDEN_PORTS = [3000, 4400];
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'game-site-push-wiring-'));

// 本进程环境里不允许残留 VAPID_*：Express 线由 spawn 的 env 显式注入，进程内 D 段自己设/删。
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];

/* ------------------------------------------------------------------ 报告 */

let PASS = 0, FAIL = 0;
const FAILED = [];

function ok(name, cond, extra) {
  // 打印格式按验收单：通过 «  ok   <名字>»，失败 «  FAIL <名字> :: <详情>»
  if (cond) { PASS++; console.log('  ok   ' + String(name)); }
  else { FAIL++; FAILED.push(String(name)); console.log('  FAIL ' + String(name) + (extra ? ' :: ' + extra : '')); }
}
function info(msg) { console.log('  info  ' + String(msg)); }
function head(t) { console.log('\n===== ' + t + ' ====='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function snapshot(p) {
  try { const s = statSync(p); return { exists: true, size: s.size, mtimeMs: s.mtimeMs }; }
  catch { return { exists: false, size: -1, mtimeMs: -1 }; }
}
function randHex(n) { return Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex'); }

/* ------------------------------------------------------------- 清理登记处 */

const CLEANUP = [];
async function cleanupAll() {
  for (const fn of CLEANUP.reverse()) {
    try { await fn(); } catch (e) { info('清理项失败（忽略）：' + String((e && e.message) || e)); }
  }
}
/** 先摘掉所有目录联接/symlink，再删树：确保递归删除不会走进真仓库的 node_modules */
function unlinkLinks(dir, depth = 0) {
  if (depth > 4) return;
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const q = join(dir, n);
    let st = null;
    try { st = lstatSync(q); } catch { continue; }
    if (st.isSymbolicLink()) { try { unlinkSync(q); } catch { /* ignore */ } }
    else if (st.isDirectory()) unlinkLinks(q, depth + 1);
  }
}
async function rmTemp(p) {
  unlinkLinks(p);
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { info('删除临时目录第 ' + (i + 1) + ' 次未成：' + String((e && e.code) || (e && e.message) || e)); }
    if (!existsSync(p)) { info('临时目录已删除：' + p); return true; }
    await sleep(600);
  }
  info('临时目录仍有残留（Windows 句柄未释放，仅为整洁问题，不影响结论）：' + p);
  return false;
}

/* --------------------------------------------------------------- 密码学 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s) => enc.encode(s);
const b64u = (u8) => Buffer.from(u8).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdfLocal(salt, ikm, info, len) {
  const key = await webcrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, key, len * 8
  );
  return new Uint8Array(bits);
}
/** 解析 RFC 8188 aes128gcm 密文（独立实现，用来证明「发出去的是密文、且真加密了」） */
async function decryptBody(body, uaPrivD, uaPub, auth) {
  const b = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (b.length < 21) throw new Error('body_too_short');
  const salt = b.slice(0, 16);
  const rs = new DataView(b.buffer, b.byteOffset + 16, 4).getUint32(0, false);
  const idlen = b[20];
  if (idlen !== 65) throw new Error('bad_idlen:' + idlen);
  const headerLen = 21 + idlen;
  const keyid = b.slice(21, headerLen);
  const ct = b.slice(headerLen);
  const priv = await webcrypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: b64u(uaPrivD), x: b64u(uaPub.slice(1, 33)), y: b64u(uaPub.slice(33, 65)), ext: true },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
  );
  const pub = await webcrypto.subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const z = new Uint8Array(1);
  const ikm = await hkdfLocal(auth, shared, cat(utf8('WebPush: info'), z, uaPub, keyid), 32);
  const cek = await hkdfLocal(salt, ikm, cat(utf8('Content-Encoding: aes128gcm'), z), 16);
  const nonce = await hkdfLocal(salt, ikm, cat(utf8('Content-Encoding: nonce'), z), 12);
  const key = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plainBuf = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct);
  let plain = new Uint8Array(plainBuf);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (end <= 0 || plain[end - 1] !== 2) throw new Error('bad_padding');
  plain = plain.slice(0, end - 1);
  return { plain: dec.decode(plain), rs, idlen, headerLen, saltLen: salt.length, ctLen: ct.length };
}
/** 验 VAPID Authorization 头（t=<jwt>, k=<65B 公钥>） */
async function verifyVapidHeader(header) {
  const h = String(header || '');
  if (!/^vapid\s+t=/i.test(h)) return { ok: false, error: 'bad_prefix' };
  const at = h.toLowerCase().indexOf(', k=');
  if (at < 0) return { ok: false, error: 'no_k' };
  const jwt = h.slice(h.toLowerCase().indexOf('t=') + 2, at).trim();
  const k = h.slice(at + 4).trim();
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, error: 'bad_jwt' };
  const kb = unb64u(k);
  const key = await webcrypto.subtle.importKey('raw', kb, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sigOk = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(parts[2]), utf8(parts[0] + '.' + parts[1])
  );
  let payload = null;
  try { payload = JSON.parse(dec.decode(unb64u(parts[1]))); } catch { /* ignore */ }
  return { ok: !!sigOk, payload, aud: payload && payload.aud, sub: payload && payload.sub, kLen: kb.length };
}

/* ------------------------------------------------------------ HTTP 小工具 */

function makeJar() {
  const m = new Map();
  return {
    absorb(res) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of list) {
        const kv = String(c).split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) m.set(kv.slice(0, i).trim(), kv.slice(i + 1));
      }
    },
    header() { return [...m.entries()].map(([k, v]) => k + '=' + v).join('; '); },
    size() { return m.size; }
  };
}
async function req(base, path, opts = {}) {
  const h = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(opts.form).toString(); }
  if (opts.jar) { const c = opts.jar.header(); if (c) h.cookie = c; }
  let res;
  try {
    res = await fetch(base + path, { method: opts.method || 'GET', headers: h, body, redirect: 'manual' });
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e), data: null, text: '' };
  }
  if (opts.jar) opts.jar.absorb(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}
async function freePort() {
  for (let i = 0; i < 30; i++) {
    const p = await new Promise((res, rej) => {
      const s = net.createServer();
      s.on('error', rej);
      s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); });
    });
    if (!FORBIDDEN_PORTS.includes(p)) return p;
  }
  throw new Error('取不到空闲端口');
}
async function waitHttp200(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status === 200) return { ok: true, ms: Date.now() - t0 }; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return { ok: false, ms: Date.now() - t0 };
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(60);
  }
  return null;
}
/** 只读查库（服务器正在写同一个库时偶发 BUSY，重试几次） */
async function dbQuery(file, sql, params = []) {
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    let h = null;
    try {
      h = new DatabaseSync(file, { readOnly: true });
      const rows = h.prepare(sql).all(...params);
      h.close();
      return { ok: true, rows };
    } catch (e) {
      lastErr = e;
      try { if (h) h.close(); } catch { /* ignore */ }
      await sleep(120);
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

/* --------------------------------------------------------- 假推送服务 */

async function startPushServer() {
  const reqs = [];
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = String(rq.url || '').split('?')[0];
      reqs.push({
        path, method: rq.method, bytes: body.length,
        enc: rq.headers['content-encoding'] || '', auth: rq.headers.authorization || '',
        ttl: rq.headers.ttl || '', urgency: rq.headers.urgency || '', topic: rq.headers.topic || '',
        body: new Uint8Array(body)
      });
      const status = path.startsWith('/gone404') ? 404 : path.startsWith('/gone410') ? 410 : path.startsWith('/boom') ? 500 : 201;
      rs.writeHead(status, { 'content-type': 'text/plain' });
      rs.end(status === 201 ? 'ok' : 'err');
    });
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  return {
    reqs, port,
    epOf: (p) => 'https://127.0.0.1:' + port + p,
    close: () => new Promise((res) => srv.close(res))
  };
}

/* ------------------------------------------------------------ 临时副本 */

function makeSrcCopy(name) {
  const dir = join(TMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  return dir;
}
function makeRepoCopy(name) {
  const dir = join(TMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const rel of ['src', 'public', 'games', 'package.json', 'server.js']) {
    cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  }
  // 副本在 %TEMP%，靠 node_modules 目录联接（junction，Windows 下无需管理员）解析 express 等依赖
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

import { readFileSync, writeFileSync } from 'node:fs';

/* ============================================ Express 子进程（真 server.js，跑在 %TEMP% 副本里） */

/** 给 Express 子进程预载的 fetch shim：只把 https://127.0.0.1:<假推送端口> 改写成 http://…，其余原样。 */
function writeFetchShim(dir, fakePort) {
  const file = join(dir, 'push-fetch-shim.mjs');
  const lines = [
    '// 由 tools/push-wiring-test.mjs 生成（只落在 %TEMP% 副本目录，不进仓库）',
    'const PORT = String(process.env.PUSH_TEST_FAKE_PORT || "");',
    'const PREFIX = PORT ? "https://127.0.0.1:" + PORT : "";',
    'const real = globalThis.fetch;',
    'globalThis.fetch = function (input, init) {',
    '  const url = typeof input === "string" ? input : (input && input.url) || String(input);',
    '  if (PREFIX && url.indexOf(PREFIX) === 0) {',
    '    return real("http://127.0.0.1:" + PORT + url.slice(PREFIX.length), init);',
    '  }',
    '  return real(input, init);',
    '};',
    ''
  ];
  writeFileSync(file, lines.join('\n'));
  return pathToFileURL(file).href;
}

function startExpress(copyDir, port, extraEnv, shimUrl) {
  const args = shimUrl ? ['--import', shimUrl, 'server.js'] : ['server.js'];
  const child = spawn(process.execPath, args, {
    cwd: copyDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      MAIL_TICK: '0',
      PATH: process.env.PATH || process.env.Path || 'C:/Windows/System32'
    }, extraEnv || {})
  });
  const tail = { out: '', err: '', code: null };
  const keep = (s) => (s.length > 4000 ? s.slice(-4000) : s);
  child.stdout.on('data', (d) => { tail.out = keep(tail.out + d.toString()); });
  child.stderr.on('data', (d) => { tail.err = keep(tail.err + d.toString()); });
  child.on('error', (e) => { tail.err = keep(tail.err + '\n[spawn error] ' + String((e && e.message) || e)); });
  child.on('exit', (c, sig) => { tail.code = c === null ? 'signal:' + sig : c; });
  CLEANUP.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((res) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } res(); }, 5000);
      child.once('exit', () => { clearTimeout(t); res(); });
      try { child.kill(); } catch (e) { clearTimeout(t); res(); }
    });
    info('已结束临时 Express 子进程 pid=' + child.pid);
  });
  return { child, tail };
}
function tailText(t) {
  const s = String((t && t.err) || '') + '\n' + String((t && t.out) || '');
  return s.trim().slice(-800) || '(无输出)';
}
function loc(r) {
  try { return (r && r.headers && typeof r.headers.get === 'function' && r.headers.get('location')) || ''; } catch (e) { return ''; }
}

/* ================================================================ 测试素材 */

/** 订阅方密钥：真 P-256 ECDH 密钥对 + 16 字节 auth secret（和浏览器 PushSubscription 同形） */
async function genUaKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    pub, priv: unb64u(jwk.d),
    p256dh: b64u(pub),
    auth: b64u(webcrypto.getRandomValues(new Uint8Array(16)))
  };
}
/** VAPID 三件套：真 P-256 ECDSA 密钥对（产品线要 65 字节公钥 / 32 字节私钥，base64url） */
async function genVapid() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(pub), privateKey: jwk.d, subject: 'mailto:push-wiring-test@example.invalid' };
}
function subOf(endpoint, ua) {
  return { endpoint, keys: { p256dh: ua.p256dh, auth: ua.auth } };
}

/* ================================================================ 小工具 */

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function waitTrue(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(80);
  }
  return false;
}
async function dbRows(file, sql, params) {
  const r = await dbQuery(file, sql, params || []);
  return r && r.ok ? r.rows : null;
}
async function countEp(file, ep) {
  const rows = await dbRows(file, 'SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', [ep]);
  return rows && rows.length ? Number(rows[0].n) : -1;
}
async function pushRow(file, ep) {
  const rows = await dbRows(file, 'SELECT ok_at, fail_count, disabled FROM push_subs WHERE endpoint = ?', [ep]);
  return rows && rows.length ? rows[0] : null;
}
async function registerAccount(base, label) {
  const jar = makeJar();
  const tag = String(label).toLowerCase().replace(/[^a-z0-9]/g, '');
  const username = 'pw' + tag + randHex(3);
  const displayName = 'PW' + tag;
  const r = await req(base, '/api/auth/register', {
    method: 'POST',
    json: { username, password: 'Probe12345', display_name: displayName },
    jar
  });
  const user = (r.data && r.data.user) || {};
  return { jar, username, displayName, id: Number(user.id || 0), status: r.status, data: r.data, text: r.text };
}
async function follow(base, jar, name, action) {
  return req(base, '/u/' + encodeURIComponent(name) + '/follow', {
    method: 'POST',
    form: { action: action || 'follow', form_token: 'wiring-test-nonce' },
    jar
  });
}
function pathOf(ep) {
  try { return new URL(ep).pathname; } catch (e) { return String(ep); }
}
function hits(fake, path) {
  return fake.reqs.filter((r) => r.path === path);
}

/* ===================================================================== A */

async function sectionA(ctx) {
  head('A. push_subs 的 DDL：两条线的源码文本 + 真 Express 起服务后真的建表');
  const dbSrc = readFileSync(join(ROOT, 'src', 'db.js'), 'utf8');
  const wSrc = readFileSync(join(ROOT, 'worker', 'schema.js'), 'utf8');

  ok('A1 src/db.js 含 CREATE TABLE IF NOT EXISTS push_subs', dbSrc.indexOf('CREATE TABLE IF NOT EXISTS push_subs') >= 0);
  ok('A2 src/db.js 含 CREATE INDEX IF NOT EXISTS idx_push_subs_user', dbSrc.indexOf('CREATE INDEX IF NOT EXISTS idx_push_subs_user') >= 0);
  ok('A3 worker/schema.js 含 CREATE TABLE IF NOT EXISTS push_subs', wSrc.indexOf('CREATE TABLE IF NOT EXISTS push_subs') >= 0);
  ok('A4 worker/schema.js 含 CREATE INDEX IF NOT EXISTS idx_push_subs_user', wSrc.indexOf('CREATE INDEX IF NOT EXISTS idx_push_subs_user') >= 0);
  ok('A5 两条线 DDL 都带 user_id/endpoint/p256dh/auth/disabled 列',
    ['user_id', 'endpoint', 'p256dh', 'auth', 'disabled'].every((c) => dbSrc.indexOf(c) >= 0 && wSrc.indexOf(c) >= 0));

  const ready = await waitHttp200(ctx.base + '/api/push/key', 90000);
  ok('A6 真 Express 起来了（GET /api/push/key 有响应）', ready.ok === true, '等待 ' + ready.ms + 'ms');
  if (!ready.ok) {
    info('子进程输出尾部：' + tailText(ctx.proc.tail));
    ctx.ready = false;
    return;
  }
  ctx.ready = true;
  const acc = await registerAccount(ctx.base, 'A');
  ok('A7 注册账号成功（201 + user.id）', acc.status === 201 && acc.id > 0, 'status=' + acc.status + ' id=' + acc.id);
  ctx.accA = acc;

  const cols = await dbRows(ctx.dbf, 'PRAGMA table_info(push_subs)');
  const names = (cols || []).map((r) => String(r.name));
  ok('A8 真服务把 push_subs 表建出来了（PRAGMA table_info 非空）', !!cols && names.length >= 8, '列：' + names.join(','));
  for (const c of ['user_id', 'endpoint', 'p256dh', 'auth', 'disabled']) {
    ok('A9 列 ' + c + ' 存在', names.indexOf(c) >= 0);
  }
  ok('A10 列集齐 10 列（id/user_id/endpoint/p256dh/auth/ua/created_at/ok_at/fail_count/disabled）',
    ['id', 'user_id', 'endpoint', 'p256dh', 'auth', 'ua', 'created_at', 'ok_at', 'fail_count', 'disabled'].every((c) => names.indexOf(c) >= 0),
    names.length + ' 列');
  const idx = await dbRows(ctx.dbf, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_push_subs_user'");
  ok('A11 索引 idx_push_subs_user 在真库里存在', !!idx && idx.length === 1);
}

/* ===================================================================== B */

async function sectionB(ctx) {
  head('B. Express 三条 push 路由：形状与权限');
  if (!ctx.ready) { ok('B0 段前置：Express 子进程可用', false, '见 A6'); return; }
  const anon = makeJar();

  const k1 = await req(ctx.base, '/api/push/key', { jar: anon });
  const pk = (k1.data && k1.data.publicKey) || '';
  ok('B1 未登录 GET /api/push/key → 200', k1.status === 200, 'status=' + k1.status);
  ok('B2 未登录也回 {ok:true, configured:true}', !!(k1.data && k1.data.ok === true && k1.data.configured === true), JSON.stringify(k1.data).slice(0, 160));
  ok('B3 publicKey 是 87 字符 base64url', pk.length === 87 && /^[A-Za-z0-9_-]+$/.test(pk), 'len=' + pk.length);
  ok('B4 publicKey 与进程环境里的 VAPID_PUBLIC_KEY 一致', pk === ctx.vapid.publicKey);
  ok('B5 未登录 subscribed:false', !!k1.data && k1.data.subscribed === false);

  const s1 = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(ctx.fake.epOf('/sub/' + randHex(6)), ctx.ua) }, jar: anon });
  ok('B6 未登录 POST /api/push/subscribe → 401 login_required', s1.status === 401 && !!(s1.data && s1.data.error === 'login_required'), 'status=' + s1.status + ' body=' + s1.text.slice(0, 120));
  const u1 = await req(ctx.base, '/api/push/unsubscribe', { method: 'POST', json: {}, jar: anon });
  ok('B7 未登录 POST /api/push/unsubscribe → 401 login_required', u1.status === 401 && !!(u1.data && u1.data.error === 'login_required'), 'status=' + u1.status);

  const epB = ctx.fake.epOf('/sub/' + randHex(6));
  const s2 = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epB, ctx.ua) }, jar: ctx.accA.jar });
  const id1 = Number((s2.data && s2.data.id) || 0);
  ok('B8 登录后订阅形状合法 → 200 {ok:true,id>0}', s2.status === 200 && !!(s2.data && s2.data.ok === true) && id1 > 0, 'status=' + s2.status + ' body=' + s2.text.slice(0, 120));
  const k2 = await req(ctx.base, '/api/push/key', { jar: ctx.accA.jar });
  ok('B9 订阅后 GET /api/push/key → subscribed:true', !!(k2.data && k2.data.subscribed === true));

  const epB2 = ctx.fake.epOf('/sub/' + randHex(6));
  const s3 = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: subOf(epB2, ctx.ua), jar: ctx.accA.jar });
  ok('B10 body 直接是订阅对象（无 subscription 包装）也接受 → 200', s3.status === 200 && !!(s3.data && s3.data.ok === true), 'status=' + s3.status);

  const badHttp = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf('http://127.0.0.1:' + ctx.fake.port + '/sub/x', ctx.ua) }, jar: ctx.accA.jar });
  ok('B11 endpoint 不是 https → 400', badHttp.status === 400 && !!(badHttp.data && badHttp.data.ok === false), 'status=' + badHttp.status + ' body=' + badHttp.text.slice(0, 120));
  const badLen = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: { endpoint: ctx.fake.epOf('/sub/' + randHex(6)), keys: { p256dh: b64u(new Uint8Array(32)), auth: ctx.ua.auth } } }, jar: ctx.accA.jar });
  ok('B12 p256dh 长度不对（32 字节）→ 400', badLen.status === 400 && !!(badLen.data && badLen.data.ok === false), 'status=' + badLen.status + ' body=' + badLen.text.slice(0, 120));
  const badAuth = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: { endpoint: ctx.fake.epOf('/sub/' + randHex(6)), keys: { p256dh: ctx.ua.p256dh, auth: b64u(new Uint8Array(8)) } } }, jar: ctx.accA.jar });
  ok('B13 auth 长度不对（8 字节）→ 400', badAuth.status === 400 && !!(badAuth.data && badAuth.data.ok === false), 'status=' + badAuth.status + ' body=' + badAuth.text.slice(0, 120));

  const s4 = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epB, ctx.ua) }, jar: ctx.accA.jar });
  const id2 = Number((s4.data && s4.data.id) || 0);
  const n1 = await countEp(ctx.dbf, epB);
  ok('B14 同 endpoint 重复订阅仍 200 且 id 不变（upsert）', s4.status === 200 && id2 === id1, 'id ' + id1 + ' → ' + id2);
  ok('B15 同 endpoint 在库里只有 1 行', n1 === 1, 'n=' + n1);

  const before = await countEp(ctx.dbf, epB);
  const un1 = await req(ctx.base, '/api/push/unsubscribe', { method: 'POST', json: { endpoint: epB }, jar: ctx.accA.jar });
  const after = await countEp(ctx.dbf, epB);
  ok('B16 带 endpoint 退一条 → {ok:true, removed:1}', un1.status === 200 && !!(un1.data && un1.data.ok === true) && un1.data.removed === 1, 'body=' + un1.text.slice(0, 120));
  ok('B17 库里该 endpoint 行数 1 → 0（removed 是真值，不是猜的）', before === 1 && after === 0, before + ' → ' + after);
  const un2 = await req(ctx.base, '/api/push/unsubscribe', { method: 'POST', json: { endpoint: epB }, jar: ctx.accA.jar });
  ok('B18 再退一次 → removed:0', un2.status === 200 && !!(un2.data && un2.data.removed === 0), 'body=' + un2.text.slice(0, 120));

  const rem = await req(ctx.base, '/api/push/unsubscribe', { method: 'POST', json: {}, jar: ctx.accA.jar });
  ok('B19 不带 endpoint 退全部 → removed:1（剩下的那条）', rem.status === 200 && !!(rem.data && rem.data.removed === 1), 'body=' + rem.text.slice(0, 120));
  const left = await dbRows(ctx.dbf, 'SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', [ctx.accA.id]);
  ok('B20 全退后该用户 0 行订阅', !!left && Number(left[0].n) === 0, 'n=' + (left ? left[0].n : '?'));
  const k3 = await req(ctx.base, '/api/push/key', { jar: ctx.accA.jar });
  ok('B21 全退后 GET key → subscribed:false', !!(k3.data && k3.data.subscribed === false));
}

/* ===================================================================== C */

async function sectionC(ctx) {
  head('C. 通知触发真推送：B 关注 A → social.notify → notifyPush → 假推送服务收到真 HTTP');
  if (!ctx.ready) { ok('C0 段前置：Express 子进程可用', false, '见 A6'); return; }

  const ep = ctx.fake.epOf('/sub/' + randHex(6));
  const p = pathOf(ep);
  const sc = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(ep, ctx.ua) }, jar: ctx.accA.jar });
  ok('C1 A 订阅一条指向假推送服务的 endpoint', sc.status === 200 && !!(sc.data && sc.data.ok === true), 'status=' + sc.status + ' body=' + sc.text.slice(0, 100));
  const row0 = await pushRow(ctx.dbf, ep);
  ok('C2 新订阅行 fail_count=0 disabled=0', !!row0 && Number(row0.fail_count) === 0 && Number(row0.disabled) === 0, row0 ? JSON.stringify(row0) : '行不存在');

  const accB = await registerAccount(ctx.base, 'B');
  ok('C3 注册账号 B', accB.status === 201 && accB.id > 0, 'status=' + accB.status + ' id=' + accB.id);
  const r1 = await follow(ctx.base, accB.jar, ctx.accA.username, 'follow');
  ok('C4 B 关注 A：POST /u/A/follow（带 cookie + form_token）→ 302', r1.status === 302, 'status=' + r1.status + ' location=' + loc(r1));

  const got1 = await waitTrue(() => hits(ctx.fake, p).length >= 1, 5000);
  const h1 = hits(ctx.fake, p)[0];
  ok('C5 5 秒内假推送服务收到 1 条请求', got1 === true && hits(ctx.fake, p).length === 1, 'hits=' + hits(ctx.fake, p).length);
  if (!h1) {
    ok('C6 请求细节：能取到那条请求', false, '没有请求可查（推送没发出来）');
    info('子进程输出尾部：' + tailText(ctx.proc.tail));
    return;
  }
  ok('C6 方法是 POST 且打到订阅的 endpoint 路径', h1.method === 'POST', h1.method + ' ' + h1.path);
  ok('C7 authorization 以 vapid t= 开头且含 ", k="', h1.auth.toLowerCase().indexOf('vapid t=') === 0 && h1.auth.toLowerCase().indexOf(', k=') > 0, h1.auth.slice(0, 44) + '…');
  ok('C8 content-encoding: aes128gcm', h1.enc === 'aes128gcm', 'enc=' + h1.enc);
  ok('C9 ttl 是默认 86400', h1.ttl === '86400', 'ttl=' + h1.ttl);
  ok('C10 urgency 头存在（默认 normal）', h1.urgency === 'normal', 'urgency=' + h1.urgency);
  ok('C11 topic 头存在（follow-<uid>）', !!h1.topic, 'topic=' + h1.topic);
  ok('C12 body 是密文（>= 100 字节）', h1.bytes >= 100, 'bytes=' + h1.bytes);

  const v = await verifyVapidHeader(h1.auth);
  ok('C13 VAPID JWT 验签通过（独立实现，非复用产品代码）', v.ok === true, 'error=' + (v.error || ''));
  ok('C14 k 是 65 字节未压缩公钥', v.kLen === 65, 'kLen=' + v.kLen);
  ok('C15 JWT aud = endpoint origin', v.aud === 'https://127.0.0.1:' + ctx.fake.port, 'aud=' + v.aud);
  ok('C16 JWT sub = VAPID_SUBJECT', v.sub === ctx.vapid.subject, 'sub=' + v.sub);

  const dec1 = await decryptBody(h1.body, ctx.ua.priv, ctx.ua.pub, unb64u(ctx.ua.auth));
  ok('C17 密文能用订阅方私钥解开（真加密，不是明文）', !!dec1.plain, 'ct=' + dec1.ctLen + 'B salt=' + dec1.saltLen + 'B');
  let pl = null;
  try { pl = JSON.parse(dec1.plain); } catch (e) { pl = null; }
  ok('C18 解出的载荷 kind=follow', !!pl && pl.kind === 'follow', String(dec1.plain).slice(0, 140));
  ok('C19 载荷 title 含关注者的名字/账号', !!pl && (String(pl.title).indexOf(accB.displayName) >= 0 || String(pl.title).indexOf(accB.username) >= 0), pl ? String(pl.title) : '');
  ok('C20 载荷 url 指向被关注者的主页', !!pl && String(pl.url).indexOf('/u/') >= 0, pl ? String(pl.url) : '');

  const accC = await registerAccount(ctx.base, 'C');
  const r2 = await follow(ctx.base, accC.jar, ctx.accA.username, 'follow');
  const got2 = await waitTrue(() => hits(ctx.fake, p).length >= 2, 5000);
  const h2 = hits(ctx.fake, p)[1];
  ok('C21 第二个关注者 C 触发第二条真推送', got2 === true && !!h2, 'hits=' + hits(ctx.fake, p).length + '（HTTP ' + r2.status + '）');
  const salt1 = h1.body.slice(0, 16);
  const salt2 = h2 ? h2.body.slice(0, 16) : new Uint8Array(16);
  ok('C22 两次投递的 salt（body 前 16 字节）不同', !!h2 && !sameBytes(salt1, salt2));
  ok('C23 两条密文整体也不同（每次真加密）', !!h2 && !sameBytes(h1.body, h2.body));
  const rowOk = await pushRow(ctx.dbf, ep);
  ok('C24 成功投递后 ok_at 有值、fail_count=0、disabled=0', !!rowOk && String(rowOk.ok_at).length > 0 && Number(rowOk.fail_count) === 0 && Number(rowOk.disabled) === 0, rowOk ? JSON.stringify(rowOk) : '行不见了');

  const selfBefore = hits(ctx.fake, p).length;
  const rSelf = await follow(ctx.base, ctx.accA.jar, ctx.accA.username, 'follow');
  await sleep(1500);
  const selfAfter = hits(ctx.fake, p).length;
  ok('C25 自己关注自己不再推（假服务计数不变）', selfBefore === selfAfter, selfBefore + ' → ' + selfAfter + '（HTTP ' + rSelf.status + '）');

  const notif = await dbRows(ctx.dbf, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'follow'", [ctx.accA.id]);
  if (notif) ok('C26 notifications 表里确有 follow 通知（≥2 行，说明钩子挂在 notify 上）', Number(notif[0].n) >= 2, 'n=' + notif[0].n);
  else info('C26 跳过：库里查不到 notifications 表（通知可能记在别处）');
}

/* ===================================================================== D */

async function sectionD(ctx) {
  head('D. 失效与熔断：404/410 → 删订阅行；连续 500 × 5 → disabled=1 后不再发');
  if (!ctx.ready) { ok('D0 段前置：Express 子进程可用', false, '见 A6'); return; }

  // ---- 支线一：假服务固定回 410 → 订阅行应被删
  const accG = await registerAccount(ctx.base, 'Gone');
  const epGone = ctx.fake.epOf('/gone410/sub/' + randHex(6));
  const pGone = pathOf(epGone);
  const sg = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epGone, ctx.ua) }, jar: accG.jar });
  ok('D1 订阅一条假服务固定回 410 的 endpoint', sg.status === 200 && !!(sg.data && sg.data.ok === true), 'status=' + sg.status);
  ok('D2 订阅后库里 1 行', (await countEp(ctx.dbf, epGone)) === 1);
  const f1 = await registerAccount(ctx.base, 'Dg1');
  await follow(ctx.base, f1.jar, accG.username, 'follow');
  const hitGone = await waitTrue(() => hits(ctx.fake, pGone).length >= 1, 5000);
  ok('D3 通知触发后假服务确实收到了请求（它回 410）', hitGone === true, 'hits=' + hits(ctx.fake, pGone).length);
  const wentZero = await waitTrue(async () => (await countEp(ctx.dbf, epGone)) === 0, 5000);
  ok('D4 回 410 后该订阅行被删除（库里 1 → 0）', wentZero === true, 'n=' + (await countEp(ctx.dbf, epGone)));
  const kg = await req(ctx.base, '/api/push/key', { jar: accG.jar });
  ok('D5 删行后 GET key → subscribed:false', !!(kg.data && kg.data.subscribed === false));

  // ---- 支线二：假服务固定回 500 → fail_count 到 5 熔断
  const accX = await registerAccount(ctx.base, 'Boom');
  const epBoom = ctx.fake.epOf('/boom/sub/' + randHex(6));
  const pBoom = pathOf(epBoom);
  const sb = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epBoom, ctx.ua) }, jar: accX.jar });
  ok('D6 订阅一条假服务固定回 500 的 endpoint', sb.status === 200 && !!(sb.data && sb.data.ok === true), 'status=' + sb.status);
  for (let i = 1; i <= 5; i++) {
    const f = await registerAccount(ctx.base, 'Df' + i);
    await follow(ctx.base, f.jar, accX.username, 'follow');
    const reached = await waitTrue(async () => {
      const rows = await dbRows(ctx.dbf, 'SELECT fail_count FROM push_subs WHERE endpoint = ?', [epBoom]);
      return !!rows && rows.length === 1 && Number(rows[0].fail_count) >= i;
    }, 6000);
    const row = await pushRow(ctx.dbf, epBoom);
    ok('D' + (6 + i) + ' 第 ' + i + ' 次失败后 fail_count=' + i + (i >= 5 ? '，disabled 应为 1' : ''),
      reached === true, row ? JSON.stringify(row) : '行不见了');
  }
  const rowB = await pushRow(ctx.dbf, epBoom);
  ok('D12 连续 5 次失败后 fail_count=5', !!rowB && Number(rowB.fail_count) === 5, rowB ? JSON.stringify(rowB) : '');
  ok('D13 并且 disabled=1（熔断）', !!rowB && Number(rowB.disabled) === 1, rowB ? JSON.stringify(rowB) : '');
  ok('D14 熔断的行仍在库里（只是不发，不是被删）', (await countEp(ctx.dbf, epBoom)) === 1);
  ok('D15 到熔断为止假服务恰好收到 5 次', hits(ctx.fake, pBoom).length === 5, 'hits=' + hits(ctx.fake, pBoom).length);

  const f6 = await registerAccount(ctx.base, 'Df6');
  await follow(ctx.base, f6.jar, accX.username, 'follow');
  await sleep(2000);
  ok('D16 熔断后再触发，假服务计数不再增长（仍然 5）', hits(ctx.fake, pBoom).length === 5, 'hits=' + hits(ctx.fake, pBoom).length);

  const again = await req(ctx.base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epBoom, ctx.ua) }, jar: accX.jar });
  const rowB2 = await pushRow(ctx.dbf, epBoom);
  ok('D17 重新订阅同 endpoint 会清掉 disabled 与 fail_count', again.status === 200 && !!rowB2 && Number(rowB2[0] === undefined ? rowB2.disabled : rowB2.disabled) === 0 && Number(rowB2.fail_count) === 0, rowB2 ? JSON.stringify(rowB2) : '');
  const f7 = await registerAccount(ctx.base, 'Df7');
  await follow(ctx.base, f7.jar, accX.username, 'follow');
  const back = await waitTrue(() => hits(ctx.fake, pBoom).length >= 6, 5000);
  ok('D18 复活后又能收到投递（计数 5 → 6）', back === true, 'hits=' + hits(ctx.fake, pBoom).length);
}

/* ===================================================================== E */

async function rmWorkerDb(file, W) {
  try { if (W && typeof W.close === 'function') await W.close(); } catch (e) { /* ignore */ }
  // 关掉 HTTP 服务器不等于库文件解锁：LocalD1 底下是 node:sqlite 的 DatabaseSync，
  // 必须显式 close()，否则 Windows 上 unlink 永远 EBUSY（第一次跑就这么把库留在仓库里了）。
  try { if (W && W.db && typeof W.db.close === 'function') W.db.close(); } catch (e) { /* ignore */ }
  for (let i = 0; i < 12; i++) {
    let left = false;
    for (const suf of ['', '-wal', '-shm']) {
      const p = file + suf;
      if (!existsSync(p)) continue;
      try { unlinkSync(p); } catch (e) { left = true; }
    }
    if (!left) return;
    await sleep(300);
  }
  info('临时 worker 库删不掉（可能被占用，Windows EBUSY）：' + file);
}

async function sectionE(ctx) {
  head('E. Workers 线（可选）：createWorkerServer + 独立库 data/worker-push-wiring-test.db');
  const wdb = join(ROOT, 'data', 'worker-push-wiring-test.db');
  let W = null;
  const realFetch = globalThis.fetch;
  let patched = false;
  try {
    const mod = await import(pathToFileURL(join(ROOT, 'tools', 'serve-worker.mjs')).href);
    if (typeof mod.createWorkerServer !== 'function') {
      ok('E1 tools/serve-worker.mjs 导出 createWorkerServer', false, '实际导出：' + Object.keys(mod).join(','));
      return;
    }
    for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(wdb + suf); } catch (e) { /* 本来就不存在 */ } }
    W = await mod.createWorkerServer({
      port: 0,
      db: wdb,
      env: {
        VAPID_PUBLIC_KEY: ctx.vapid.publicKey,
        VAPID_PRIVATE_KEY: ctx.vapid.privateKey,
        VAPID_SUBJECT: ctx.vapid.subject
      }
    });
    CLEANUP.push(() => rmWorkerDb(wdb, W));
    if (typeof W.warmup === 'function') await W.warmup();
    const wbase = 'http://127.0.0.1:' + W.port;
    ok('E1 Worker 服务起来了（port=' + W.port + '）', Number(W.port) > 0, 'db=' + wdb + ' dbFile=' + (W.dbFile || '?'));

    const wq = async (sql, ...params) => {
      const r = await W.db.prepare(sql).bind(...params).all();
      return (r && r.results) || [];
    };

    const wan = makeJar();
    const ka = await req(wbase, '/api/push/key', { jar: wan });
    ok('E2 未登录 GET /api/push/key → 200 configured:true publicKey 87 字符 subscribed:false',
      ka.status === 200 && !!(ka.data && ka.data.configured === true) && String(ka.data.publicKey || '').length === 87 && ka.data.subscribed === false,
      'status=' + ka.status + ' body=' + ka.text.slice(0, 120));
    ok('E2b publicKey 与 VAPID_PUBLIC_KEY 一致', !!(ka.data && ka.data.publicKey === ctx.vapid.publicKey));
    const sa = await req(wbase, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(ctx.fake.epOf('/sub/' + randHex(6)), ctx.ua) }, jar: wan });
    ok('E3 未登录 POST subscribe → 401 login_required', sa.status === 401 && !!(sa.data && sa.data.error === 'login_required'), 'status=' + sa.status + ' body=' + sa.text.slice(0, 120));

    const accW = await registerAccount(wbase, 'W');
    ok('E4 Worker 注册账号 → 201 + id', accW.status === 201 && accW.id > 0, 'status=' + accW.status + ' body=' + accW.text.slice(0, 120));
    const epW = ctx.fake.epOf('/sub/' + randHex(6));
    const pW = pathOf(epW);
    const sw = await req(wbase, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epW, ctx.ua) }, jar: accW.jar });
    ok('E5 Worker 订阅 → 200 id>0', sw.status === 200 && !!(sw.data && sw.data.ok === true) && Number(sw.data.id) > 0, 'status=' + sw.status + ' body=' + sw.text.slice(0, 120));
    const kw = await req(wbase, '/api/push/key', { jar: accW.jar });
    ok('E6 Worker 订阅后 GET key → subscribed:true', !!(kw.data && kw.data.subscribed === true));
    const wrows = await wq('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', epW);
    ok('E7 Worker 侧库里确实 1 行订阅', Number((wrows[0] || {}).n) === 1, 'n=' + (wrows[0] || {}).n);

    // worker 服务跑在本进程内：只在 E 段把 https://127.0.0.1:<假端口> 改写成 http
    const httpsPrefix = 'https://127.0.0.1:' + ctx.fake.port;
    const httpPrefix = 'http://127.0.0.1:' + ctx.fake.port;
    globalThis.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
      if (url.indexOf(httpsPrefix) === 0) return realFetch(httpPrefix + url.slice(httpsPrefix.length), init);
      return realFetch(input, init);
    };
    patched = true;

    const accWF = await registerAccount(wbase, 'WF');
    ok('E8 Worker 注册关注者账号', accWF.status === 201 && accWF.id > 0, 'status=' + accWF.status);
    const rw = await follow(wbase, accWF.jar, accW.username, 'follow');
    ok('E9 Worker 侧 POST /u/A/follow → 302', rw.status === 302, 'status=' + rw.status + ' location=' + loc(rw));
    const gotW = await waitTrue(() => hits(ctx.fake, pW).length >= 1, 5000);
    ok('E10 Worker 侧 notify 也真推到了假推送服务', gotW === true, 'hits=' + hits(ctx.fake, pW).length);
    const hW = hits(ctx.fake, pW)[0];
    if (hW) {
      const vW = await verifyVapidHeader(hW.auth);
      ok('E11 Worker 投递头同样是真 VAPID + aes128gcm + ttl 86400', vW.ok === true && hW.enc === 'aes128gcm' && hW.ttl === '86400', 'error=' + (vW.error || '') + ' enc=' + hW.enc + ' ttl=' + hW.ttl);
      const dW = await decryptBody(hW.body, ctx.ua.priv, ctx.ua.pub, unb64u(ctx.ua.auth));
      let plW = null;
      try { plW = JSON.parse(dW.plain); } catch (e) { plW = null; }
      ok('E12 Worker 投递的密文可解且 kind=follow', !!plW && plW.kind === 'follow', String(dW.plain).slice(0, 120));
    } else {
      ok('E11 Worker 投递头可验', false, '没有请求可查');
      ok('E12 Worker 投递密文可解', false, '没有请求可查');
    }
    const uw = await req(wbase, '/api/push/unsubscribe', { method: 'POST', json: { endpoint: epW }, jar: accW.jar });
    const wrows2 = await wq('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', epW);
    ok('E13 Worker 退订 → removed:1 且库里 0 行', uw.status === 200 && !!(uw.data && uw.data.removed === 1) && Number((wrows2[0] || {}).n) === 0, 'body=' + uw.text.slice(0, 100));

    // E14/E15（诊断，不动产品代码）：E10 失败是 worker/social.js 把 notifyPush 当裸标识符用、却没从 './push.js' import
    // （运行时 ReferenceError，被 notify 自己的 try 吞掉）。这里绕开 social.js，直接用 worker/push.js 导出的
    // notifyPush + 同一套 VAPID env 投一条：若能收到并解开，说明 worker 侧 env → 加密 → VAPID → 投递 这条链是好的，
    // 缺的只是那一行 import。
    const epD = ctx.fake.epOf('/sub/' + randHex(6));
    const pD = pathOf(epD);
    const sd = await req(wbase, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(epD, ctx.ua) }, jar: accW.jar });
    const beforeD = hits(ctx.fake, pD).length;
    const wpush = await import(pathToFileURL(join(ROOT, 'worker', 'push.js')).href);
    wpush.notifyPush(W.db, {
      VAPID_PUBLIC_KEY: ctx.vapid.publicKey,
      VAPID_PRIVATE_KEY: ctx.vapid.privateKey,
      VAPID_SUBJECT: ctx.vapid.subject
    }, accW.id, {
      kind: 'follow', actorId: accWF.id, actorName: accWF.username || 'wf',
      targetType: 'user', targetId: accW.id, body: 'E14 诊断'
    });
    const gotD = await waitTrue(() => hits(ctx.fake, pD).length > beforeD, 5000);
    ok('E14（诊断）直接调 worker/push.js 的 notifyPush → 假服务收到请求（说明 E10 只差 worker/social.js 的一行 import）',
      gotD === true && sd.status === 200,
      'subscribe=' + sd.status + ' hits+' + (hits(ctx.fake, pD).length - beforeD));
    const hD = hits(ctx.fake, pD)[0];
    if (hD) {
      const vD = await verifyVapidHeader(hD.auth);
      const dd = await decryptBody(hD.body, ctx.ua.priv, ctx.ua.pub, unb64u(ctx.ua.auth));
      let pl = null;
      try { pl = JSON.parse(dd.plain); } catch (e) { pl = null; }
      ok('E15（诊断）这一条的 VAPID 头可验、密文可解、kind=follow',
        vD.ok === true && hD.enc === 'aes128gcm' && !!pl && pl.kind === 'follow',
        'error=' + (vD.error || '') + ' enc=' + hD.enc + ' ttl=' + hD.ttl + ' plain=' + String(dd.plain).slice(0, 120));
    } else {
      ok('E15（诊断）这一条的 VAPID 头可验、密文可解、kind=follow', false, '没有请求可查');
    }
  } catch (e) {
    ok('E0 Worker 段整体执行', false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    if (patched) globalThis.fetch = realFetch;
  }
}

/* ===================================================================== F */

/** 未配 VAPID（env / process.env 里没有三件套）：configured:false、publicKey 空串、整条链路空转不发一个 HTTP。
 *  进程内那段用 worker/push.js 而不是 src/push.js —— 后者 import 了 src/db.js，一 import 就会打开真库 data/games.db。
 *  端到端那段是另起一台 Express：同一个 %TEMP% 副本、同一个副本库，只是 env 里没有 VAPID_*。
 */
async function sectionF(ctx) {
  head('F. 未配 VAPID：configured:false / publicKey 空串 / notify 一次 HTTP 都不发');
  const before = ctx.fake.reqs.length;

  const wp = await import(pathToFileURL(join(ROOT, 'worker', 'push.js')).href);
  const cfg = wp.pushConfigured({});
  ok('F1 未配时 pushConfigured({}) → {ok:false, reason:"no_keys", publicKey 空}',
    cfg.ok === false && cfg.reason === 'no_keys' && !cfg.publicKey,
    'ok=' + cfg.ok + ' reason=' + cfg.reason + ' publicKey=' + JSON.stringify(cfg.publicKey));
  ok('F2 未配时 vapidPublicKey({}) → ""', wp.vapidPublicKey({}) === '', 'value=' + JSON.stringify(wp.vapidPublicKey({})));

  const realFetch = globalThis.fetch;
  let fetched = 0;
  let notifyErr = '';
  globalThis.fetch = function () { fetched++; return realFetch.apply(globalThis, arguments); };
  try {
    wp.notifyPush(null, {}, 1, { kind: 'follow', actorId: 2, targetType: 'user', targetId: 2 });
    await sleep(150);
  } catch (e) {
    notifyErr = String((e && e.message) || e);
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('F3 未配时 notifyPush() 立刻返回、一次 HTTP 都不发', fetched === 0 && !notifyErr,
    'fetch ' + fetched + ' 次' + (notifyErr ? ' err=' + notifyErr : ''));

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const proc = startExpress(ctx.copyDir, port, { PUSH_TEST_FAKE_PORT: String(ctx.fake.port) }, writeFetchShim(ctx.copyDir, ctx.fake.port));
  info('未配 VAPID 的 Express: ' + base + '（env 里没有 VAPID_*，库=同一个 %TEMP% 副本库）');
  const ready = await waitHttp200(base + '/api/push/key', 90000);
  ok('F4 未配 VAPID 时服务照常起得来（GET /api/push/key 有响应）', ready.ok === true, '等待 ' + ready.ms + 'ms');
  if (!ready.ok) {
    info('子进程输出尾部：' + tailText(proc.tail));
    return;
  }

  const kAnon = await req(base, '/api/push/key', { jar: makeJar() });
  ok('F5 未登录 GET /api/push/key → {ok:true, configured:false, publicKey:""}',
    kAnon.status === 200 && !!(kAnon.data && kAnon.data.ok === true && kAnon.data.configured === false) && kAnon.data.publicKey === '',
    'status=' + kAnon.status + ' body=' + JSON.stringify(kAnon.data).slice(0, 160));
  ok('F6 未配时 subscribed 仍是布尔值（接口形状不塌）', !!(kAnon.data && typeof kAnon.data.subscribed === 'boolean'));

  const target = await registerAccount(base, 'Ft');
  const fan = await registerAccount(base, 'Ff');
  ok('F7 未配 VAPID 也能注册账号（后面前置就位）',
    target.status === 201 && target.id > 0 && fan.status === 201 && fan.id > 0,
    'target=' + target.status + '/' + target.id + ' fan=' + fan.status + '/' + fan.id);

  const ep = ctx.fake.epOf('/sub/' + randHex(6));
  const s = await req(base, '/api/push/subscribe', { method: 'POST', json: { subscription: subOf(ep, ctx.ua) }, jar: target.jar });
  ok('F8 未配 VAPID 时订阅照常落库（200 + id>0）', s.status === 200 && Number(s.data && s.data.id) > 0,
    'status=' + s.status + ' body=' + String(s.text).slice(0, 140));
  const k2 = await req(base, '/api/push/key', { jar: target.jar });
  ok('F9 已登录也一样：configured:false + publicKey:"" + subscribed:true（行确实在库里）',
    k2.status === 200 && !!(k2.data && k2.data.configured === false && k2.data.publicKey === '' && k2.data.subscribed === true),
    JSON.stringify(k2.data).slice(0, 160));

  const f = await follow(base, fan.jar, target.username, 'follow');
  ok('F10 未配 VAPID 时关注请求照常成功（302 + notice=followed）',
    f.status === 302 && String(loc(f)).indexOf('notice=followed') >= 0, 'status=' + f.status + ' loc=' + String(loc(f)).slice(0, 80));
  const rows = await dbRows(ctx.dbf, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = ?', [target.id, 'follow']);
  ok('F11 站内通知照常落库（未配 VAPID 只影响推送，不影响写库）', Number(rows && rows[0] && rows[0].n) >= 1,
    'notifications=' + JSON.stringify(rows));
  await sleep(1200);
  ok('F12 未配 VAPID 时 notifyPush 没有发任何 HTTP（假推送服务零新增请求）', ctx.fake.reqs.length === before,
    '新增 ' + (ctx.fake.reqs.length - before) + ' 条');
  ok('F13 那条订阅从头到尾没被投递过（假服务里没有它的请求）', hits(ctx.fake, pathOf(ep)).length === 0,
    'hits=' + hits(ctx.fake, pathOf(ep)).length);
}

/* ==================================================================== main */

async function main() {
  const started = Date.now();
  console.log('tools/push-wiring-test.mjs — Web Push 端到端接线验收（Express 线为主 + Workers 线）');
  console.log('仓库    : ' + ROOT);
  console.log('临时根  : ' + TMP_ROOT + '（跑完删除）');
  console.log('真库    : ' + REAL_DB + '（本脚本从不打开它；Express 跑在 %TEMP% 副本里，库是自建空库）');
  const realBefore = snapshot(REAL_DB);
  CLEANUP.push(() => rmTemp(TMP_ROOT));

  const ctx = { ready: false, fake: null, base: '', copyDir: '', dbf: '', vapid: null, ua: null, accA: null, proc: null };
  ctx.vapid = await genVapid();
  ctx.ua = await genUaKeys();

  head('0. 测试素材自检（必须真密钥，否则 notifyPush 会直接跳过投递）');
  ok('0.1 VAPID 公钥是 87 字符 base64url', ctx.vapid.publicKey.length === 87 && /^[A-Za-z0-9_-]+$/.test(ctx.vapid.publicKey), 'len=' + ctx.vapid.publicKey.length);
  ok('0.2 VAPID 私钥是 32 字节 base64url', unb64u(ctx.vapid.privateKey).length === 32);
  ok('0.3 订阅方 p256dh 是真 P-256 公钥（65 字节）', ctx.ua.pub.length === 65);
  ok('0.4 订阅方 auth 是 16 随机字节', unb64u(ctx.ua.auth).length === 16);

  ctx.fake = await startPushServer();
  CLEANUP.push(() => ctx.fake.close());
  info('假推送服务 http://127.0.0.1:' + ctx.fake.port + '（默认 201；/gone410/* → 410；/boom/* → 500）');

  ctx.copyDir = makeRepoCopy('express');
  ctx.dbf = join(ctx.copyDir, 'data', 'games.db');
  const port = await freePort();
  ctx.base = 'http://127.0.0.1:' + port;
  const shim = writeFetchShim(ctx.copyDir, ctx.fake.port);
  ctx.proc = startExpress(ctx.copyDir, port, {
    VAPID_PUBLIC_KEY: ctx.vapid.publicKey,
    VAPID_PRIVATE_KEY: ctx.vapid.privateKey,
    VAPID_SUBJECT: ctx.vapid.subject,
    PUSH_TEST_FAKE_PORT: String(ctx.fake.port)
  }, shim);
  info('Express  : ' + ctx.base + '（cwd=' + ctx.copyDir + '，库=' + ctx.dbf + '，node --import fetch-shim server.js）');

  await sectionA(ctx);
  await sectionB(ctx);
  await sectionC(ctx);
  await sectionD(ctx);
  await sectionE(ctx);
  await sectionF(ctx);

  head('Z. 收尾核对');
  const realAfter = snapshot(REAL_DB);
  if (realBefore.exists && realAfter.exists && realBefore.size === realAfter.size && realBefore.mtimeMs === realAfter.mtimeMs) {
    ok('Z1 真库 data/games.db 全程未被本脚本触碰（size/mtime 未变）', true, 'size=' + realAfter.size);
  } else {
    info('Z1 真库在测试期间被别的进程改过（本脚本结构上不会打开它）：' + JSON.stringify(realBefore) + ' → ' + JSON.stringify(realAfter));
  }
  ok('Z2 测试数据都在临时库里（临时库存在且路径 ≠ 真库）', ctx.dbf !== REAL_DB && existsSync(ctx.dbf), ctx.dbf);
  console.log('\n用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}

main().then(async () => {
  console.log('\n================= 结果 =================');
  console.log('通过 ' + PASS + ' / 失败 ' + FAIL);
  if (FAIL) console.log('失败项：\n  - ' + FAILED.join('\n  - '));
  await cleanupAll();
  process.exit(FAIL ? 1 : 0);
}).catch(async (e) => {
  console.error('脚本异常：' + ((e && e.stack) || e));
  console.log('\n================= 结果 =================');
  console.log('通过 ' + PASS + ' / 失败 ' + (FAIL + 1) + '（脚本异常中断）');
  await cleanupAll();
  process.exit(1);
});
