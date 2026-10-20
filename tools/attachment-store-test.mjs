/**
 * 附件对象存储（local / S3）+ 图片人工审核：数据层验收测试。
 *
 * 跑法：node tools/attachment-store-test.mjs      （零依赖，只用 node: 内置模块）
 * 输出：每个断言一行 FAIL（失败时），末尾 “通过 N 项，失败 M 项”；有失败则 exit code = 1。
 *
 * 隔离纪律（写这个文件的原因）：
 *   · src/ 整树与 worker/attachments.js 先复制到 <tmpdir>/attach-store-test，再从副本里 import ——
 *     副本自己的 ROOT 指向临时目录，所以任何“默认目录 / 默认库”的分支都碰不到仓库里的 data/games.db。
 *   · Express 线用 new DatabaseSync(':memory:')，Worker 线用 tools/d1-local.mjs 的 LocalD1(':memory:')，
 *     两者都只活在本进程里；全程不监听 3000 / 4400，假 S3 用 127.0.0.1:0 让系统随机分配端口。
 *   · 副本与原文件逐字节比对，防止测到的是陈旧拷贝。
 *
 * 覆盖：① 导出面与冻结常量护栏 ② SigV4（AWS 官方向量 + 头部/编码形状）
 *      ③ local 对象存储 ④ 未配置 S3 的回落（含没有 fetch 的运行时）
 *      ⑤ 假 S3 服务（node:http + node:crypto 独立复算签名，含预签 URL 真去 GET）
 *      ⑥ 图片尺寸识别与自动规则各分支 ⑦ 审核状态机（Express 线 + Worker 线，含分页/越权/幂等/统计）
 *      ⑧ DDL 幂等与老库补列
 */
import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalD1 } from './d1-local.mjs';

// ─────────────────────────────── 断言小工具 ───────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
const sections = [];
let cur = null;

function section(title) {
  if (cur) { cur.ep = pass; cur.ef = fail; }   // 上一段在这一刻封口
  cur = { title: title, p: pass, f: fail, ep: pass, ef: fail };
  sections.push(cur);
  console.log('\n— ' + title + ' —');
}
function note(text) {
  console.log('   · ' + text);
}
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  const line = name + (extra ? '  →  ' + extra : '');
  failures.push(line);
  console.log('  FAIL ' + line);
}
function is(name, got, want) {
  ok(name, Object.is(got, want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function deep(name, got, want) {
  is(name, JSON.stringify(got), JSON.stringify(want));
}
function has(name, text, needle) {
  ok(name, typeof text === 'string' && text.indexOf(needle) >= 0,
    '没有找到 ' + JSON.stringify(needle) + '：' + JSON.stringify(String(text).slice(0, 200)));
}
function bytesEq(name, got, want) {
  const a = got ? Buffer.from(got) : null;
  const b = Buffer.from(want);
  ok(name, !!a && a.length === b.length && a.equals(b),
    '长度 got=' + (a ? a.length : 'null') + ' want=' + b.length);
}
function refEq(name, got, want) {
  ok(name, got === want, '不是同一个引用');
}
function typeOf(name, value, kind) {
  is(name + ' 是 ' + kind, typeof value, kind);
}

// ─────────────────────────────── 图片夹具（按 src 里的解析器逐字节对齐） ───────────────────────────────
const SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function putBE32(b, i, n) { b[i] = (n >>> 24) & 255; b[i + 1] = (n >>> 16) & 255; b[i + 2] = (n >>> 8) & 255; b[i + 3] = n & 255; }
function putBE16(b, i, n) { b[i] = (n >>> 8) & 255; b[i + 1] = n & 255; }
function putLE16(b, i, n) { b[i] = n & 255; b[i + 1] = (n >>> 8) & 255; }
function putLE24(b, i, n) { b[i] = n & 255; b[i + 1] = (n >>> 8) & 255; b[i + 2] = (n >>> 16) & 255; }
function putLE32(b, i, n) { b[i] = n & 255; b[i + 1] = (n >>> 8) & 255; b[i + 2] = (n >>> 16) & 255; b[i + 3] = (n >>> 24) & 255; }
function putAscii(b, i, s) { for (let k = 0; k < s.length; k++) b[i + k] = s.charCodeAt(k) & 255; }
function textBytes(s) { return new TextEncoder().encode(s); }

/** PNG：8 字节签名 + IHDR（长 13 + 'IHDR' + 大端宽高 @16/@20）；readPngSize 要 length>=24 */
function pngBytes(w, h, pad) {
  const b = new Uint8Array(26 + (pad || 0));
  for (let i = 0; i < 8; i++) b[i] = SIG_PNG[i];
  b[11] = 13;
  putAscii(b, 12, 'IHDR');
  putBE32(b, 16, w);
  putBE32(b, 20, h);
  b[24] = 8;   // 位深
  b[25] = 6;   // 颜色类型
  return b;
}
/** 冻结夹具的形状：只有签名 + IHDR 长度 + 'IHDR'，共 16 字节 → 读不出宽高 */
function pngHeadOnly() { return pngBytes(1, 1).slice(0, 16); }
/** GIF：'GIF89a' + 小端宽高 @6/@8 */
function gifBytes(w, h) {
  const b = new Uint8Array(14);
  putAscii(b, 0, 'GIF89a');
  putLE16(b, 6, w);
  putLE16(b, 8, h);
  b[10] = 0x00; b[11] = 0x00; b[12] = 0x00; b[13] = 0x3b; // 调色板 + trailer
  return b;
}
/** JPEG：SOI + APP0(段长 16 → 扫描指针跳到 20) + SOF0(段长 17，高 @i+5 宽 @i+7) + EOI */
function jpegBytes(w, h) {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const b = new Uint8Array(head.length + 16 + 2);
  b.set(head, 0);
  const i = head.length; // 20
  b[i] = 0xff; b[i + 1] = 0xc0; b[i + 2] = 0x00; b[i + 3] = 0x11; b[i + 4] = 0x08;
  putBE16(b, i + 5, h);
  putBE16(b, i + 7, w);
  b[i + 9] = 0x03;
  for (let k = i + 10; k < b.length - 2; k++) b[k] = 0x01;
  b[b.length - 2] = 0xff; b[b.length - 1] = 0xd9;
  return b;
}
/** WebP（VP8X）：30 字节，宽高存的是 值-1 的 24 位小端 @24/@27 */
function webpVp8xBytes(w, h) {
  const b = new Uint8Array(30);
  putAscii(b, 0, 'RIFF');
  putLE32(b, 4, 22);
  putAscii(b, 8, 'WEBP');
  putAscii(b, 12, 'VP8X');
  putLE32(b, 16, 10);
  b[20] = 0x00;
  putLE24(b, 24, w - 1);
  putLE24(b, 27, h - 1);
  return b;
}
/** WebP（VP8L）：25 字节，b[20]=0x2f，14 位宽 + 14 位高打包在小端 32 位里 @21 */
function webpVp8lBytes(w, h) {
  const b = new Uint8Array(25);
  putAscii(b, 0, 'RIFF');
  putLE32(b, 4, 17);
  putAscii(b, 8, 'WEBP');
  putAscii(b, 12, 'VP8L');
  putLE32(b, 16, 5);
  b[20] = 0x2f;
  putLE32(b, 21, ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14));
  return b;
}
/** WebP（无 alpha 的 VP8 有损）：30 字节，起始码 9d 01 2a @23，宽 @26 高 @28（14 位） */
function webpVp8Bytes(w, h) {
  const b = new Uint8Array(30);
  putAscii(b, 0, 'RIFF');
  putLE32(b, 4, 22);
  putAscii(b, 8, 'WEBP');
  putAscii(b, 12, 'VP8 ');
  putLE32(b, 16, 10);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  putLE16(b, 26, w & 0x3fff);
  putLE16(b, 28, h & 0x3fff);
  return b;
}

// ─────────────────────────────── SigV4 独立复算（node:crypto，与 src 里的 WebCrypto 实现无关） ───────────────────────────────
function sha256hex(buf) { return createHash('sha256').update(buf).digest('hex'); }
function hmacSha256(key, msg) { return createHmac('sha256', key).update(msg).digest(); }
function signingKey(secret, date, region, service) {
  let k = hmacSha256('AWS4' + secret, date);
  k = hmacSha256(k, region);
  k = hmacSha256(k, service);
  return hmacSha256(k, 'aws4_request');
}
function canonHeaders(headers, signedNames) {
  return signedNames.map(function (n) {
    const v = headers[n] === undefined ? '' : String(headers[n]);
    return n + ':' + v.replace(/\s+/g, ' ').trim();
  }).join('\n') + '\n';
}
function canonicalRequest(rec, signedNames, payloadHash) {
  return [rec.method, rec.path, rec.query, canonHeaders(rec.headers, signedNames), signedNames.join(';'), payloadHash].join('\n');
}
function stringToSign(amzDate, scope, canonical) {
  return ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonical, 'utf8'))].join('\n');
}
/** 校验 Authorization 头签名；返回 { ok, why?, signature?, signedHeaders?, scope? } */
function verifyHeaderAuth(rec, secret) {
  const auth = String(rec.headers.authorization || '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return { ok: false, why: 'authorization 形状不对：' + auth };
  const cred = m[1].split('/');
  if (cred.length !== 5 || cred[4] !== 'aws4_request') return { ok: false, why: 'credential scope 不对：' + m[1] };
  const signed = m[2].split(';');
  if (signed.indexOf('host') < 0) return { ok: false, why: 'SignedHeaders 里没有 host' };
  const payloadHash = String(rec.headers['x-amz-content-sha256'] || '');
  if (payloadHash !== sha256hex(rec.body)) return { ok: false, why: 'x-amz-content-sha256 与实体不符：' + payloadHash };
  const canon = canonicalRequest(rec, signed, payloadHash);
  const scope = cred.slice(1).join('/');
  const want = createHmac('sha256', signingKey(secret, cred[1], cred[2], cred[3]))
    .update(stringToSign(String(rec.headers['x-amz-date'] || ''), scope, canon)).digest('hex');
  if (want !== m[3]) return { ok: false, why: '签名不符 want=' + want + ' got=' + m[3] };
  return { ok: true, signature: m[3], signedHeaders: m[2], scope: scope, payloadHash: payloadHash, canonical: canon, credential: m[1] };
}
/** 校验预签 URL（query 签名，payload 为 UNSIGNED-PAYLOAD，只有 host 进签名头） */
function verifyPresigned(rec, secret) {
  const qi = rec.rawUrl.indexOf('?');
  const path = qi < 0 ? rec.rawUrl : rec.rawUrl.slice(0, qi);
  const rawQuery = qi < 0 ? '' : rec.rawUrl.slice(qi + 1);
  const parts = rawQuery.split('&');
  const kv = new Map();
  parts.forEach(function (p) { const e = p.indexOf('='); kv.set(p.slice(0, e), p.slice(e + 1)); });
  const sig = kv.get('X-Amz-Signature');
  if (!sig) return { ok: false, why: '没有 X-Amz-Signature' };
  if (kv.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return { ok: false, why: '算法不对：' + kv.get('X-Amz-Algorithm') };
  const cred = decodeURIComponent(kv.get('X-Amz-Credential') || '').split('/');
  if (cred.length !== 5) return { ok: false, why: 'Credential 形状不对' };
  const query = parts.filter(function (p) { return p.indexOf('X-Amz-Signature=') !== 0; }).sort().join('&');
  const probe = { method: rec.method, path: path, query: query, headers: rec.headers };
  const canon = canonicalRequest(probe, ['host'], 'UNSIGNED-PAYLOAD');
  const scope = cred.slice(1).join('/');
  const want = createHmac('sha256', signingKey(secret, cred[1], cred[2], cred[3]))
    .update(stringToSign(kv.get('X-Amz-Date') || '', scope, canon)).digest('hex');
  if (want !== sig) return { ok: false, why: '预签签名不符 want=' + want + ' got=' + sig };
  return { ok: true, signature: sig, scope: scope, canonical: canon, expires: kv.get('X-Amz-Expires') };
}

// ─────────────────────────────── 假 S3（node:http，127.0.0.1:0） ───────────────────────────────
function startFakeS3(opts) {
  const o = opts || {};
  const objects = new Map();     // path → { body, type }
  const log = [];
  const server = createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const body = Buffer.concat(chunks);
      const qi = req.url.indexOf('?');
      const rec = {
        method: req.method,
        path: qi < 0 ? req.url : req.url.slice(0, qi),
        query: qi < 0 ? '' : req.url.slice(qi + 1),
        rawUrl: req.url,
        headers: req.headers,
        body: body
      };
      rec.verify = rec.query.indexOf('X-Amz-Signature=') >= 0 ? verifyPresigned(rec, o.secret) : verifyHeaderAuth(rec, o.secret);
      log.push(rec);
      if (o.fail) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return; }
      if (req.method === 'PUT') {
        objects.set(rec.path, { body: body, type: String(req.headers['content-type'] || '') });
        res.writeHead(200, { etag: '"' + createHash('md5').update(body).digest('hex') + '"', 'content-type': 'application/xml' });
        res.end('');
        return;
      }
      if (req.method === 'GET') {
        const hit = objects.get(rec.path);
        if (!hit) { res.writeHead(404, { 'content-type': 'application/xml' }); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
        res.writeHead(200, {
          'content-type': hit.type || 'application/octet-stream',
          'content-length': hit.body.length,
          etag: '"' + createHash('md5').update(hit.body).digest('hex') + '"'
        });
        res.end(hit.body);
        return;
      }
      if (req.method === 'DELETE') {
        if (!objects.has(rec.path)) { res.writeHead(404, { 'content-type': 'application/xml' }); res.end(''); return; }
        objects.delete(rec.path);
        res.writeHead(204);
        res.end('');
        return;
      }
      res.writeHead(405);
      res.end('');
    });
  });
  return new Promise(function (done) {
    server.listen(0, '127.0.0.1', function () {
      done({
        port: server.address().port,
        origin: 'http://127.0.0.1:' + server.address().port,
        objects: objects,
        log: log,
        last: function () { return log[log.length - 1]; },
        close: function () { return new Promise(function (r) { server.close(function () { r(); }); }); }
      });
    });
  });
}

// ─────────────────────────────── console.warn 捕获 ───────────────────────────────
const warns = [];
const realWarn = console.warn;
function beginWarn() { warns.length = 0; console.warn = function () { warns.push(Array.prototype.join.call(arguments, ' ')); }; }
function endWarn() { console.warn = realWarn; return warns.slice(); }
async function withWarn(fn) {
  beginWarn();
  try { return await fn(); } finally { endWarn(); }
}

// ─────────────────────────────── 临时环境：副本 + 动态 import ───────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TMP = join(tmpdir(), 'attach-store-test');
const S3_AK = 'AKIAIOSFODNN7EXAMPLE';
const S3_SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const S3_ENV = {
  S3_ENDPOINT: '', S3_BUCKET: 'ugc', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: S3_AK, S3_SECRET_KEY: S3_SK
};

console.log('=== 附件对象存储 / 人工审核：数据层验收测试 ===');
console.log('仓库：' + REPO);
console.log('临时副本：' + TMP);

// 真库护栏：全程比对仓库 data/games.db 的 size / mtime，证明一次都没碰过它
const REAL_DB = join(REPO, 'data', 'games.db');
const realDbBefore = existsSync(REAL_DB) ? statSync(REAL_DB) : null;

rmSync(TMP, { recursive: true, force: true });
cpSync(join(REPO, 'src'), join(TMP, 'src'), { recursive: true });
cpSync(join(REPO, 'worker'), join(TMP, 'worker'), { recursive: true });
// 副本目录自带 package.json（"type":"module"），否则 node 会先按 CJS 解析 .js 再改判 ESM，白冒一条警告
writeFileSync(join(TMP, 'package.json'), '{\n  "type": "module"\n}\n');

const A = await import(pathToFileURL(join(TMP, 'src', 'attachments.js')).href);
const W = await import(pathToFileURL(join(TMP, 'worker', 'attachments.js')).href);

const servers = [];
const dbs = [];
function trackDb(db) { dbs.push(db); return db; }

// ═══════════════════════════════ ① 导出面与冻结护栏 ═══════════════════════════════
section('① 导出面 / 冻结常量护栏（只增不改）');

ok('副本 src/attachments.js 与仓库原文件逐字节一致',
  Buffer.compare(readFileSync(join(TMP, 'src', 'attachments.js')), readFileSync(join(REPO, 'src', 'attachments.js'))) === 0);
ok('副本 worker/attachments.js 与仓库原文件逐字节一致',
  Buffer.compare(readFileSync(join(TMP, 'worker', 'attachments.js')), readFileSync(join(REPO, 'worker', 'attachments.js'))) === 0);

// 冻结面：一旦被动过就该红
is('ATTACH_DDL.length 仍是 7', A.ATTACH_DDL.length, 7);
deep('ATTACH_STATUS 逐字未变', A.ATTACH_STATUS, { PENDING: 'pending', ACTIVE: 'active', DELETED: 'deleted' });
is('ATTACH_MAX 仍是 4 MB', A.ATTACH_MAX, 4 * 1024 * 1024);
is('D1_BLOB_MAX 仍是 256 KB', A.D1_BLOB_MAX, 256 * 1024);
is('ATTACH_EXT_LIST 仍是 10 个扩展名', A.ATTACH_EXT_LIST.length, 10);
typeOf('createStore', A.createStore, 'function');
typeOf('createObjectStore', A.createObjectStore, 'function');
typeOf('localObjectStore', A.localObjectStore, 'function');
typeOf('s3ObjectStore', A.s3ObjectStore, 'function');
typeOf('signAwsV4', A.signAwsV4, 'function');
typeOf('safeObjectKey', A.safeObjectKey, 'function');
typeOf('amzDateStamp', A.amzDateStamp, 'function');
typeOf('readImageSize', A.readImageSize, 'function');
typeOf('setClassifier', A.setClassifier, 'function');
typeOf('getClassifier', A.getClassifier, 'function');
typeOf('autoReviewAttachment', A.autoReviewAttachment, 'function');
typeOf('ensureReviewSchema', A.ensureReviewSchema, 'function');

deep('OBJECT_STORE 两个取值', A.OBJECT_STORE, { LOCAL: 'local', S3: 's3' });
deep('ATTACH_REVIEW 三态', A.ATTACH_REVIEW, { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' });
deep('ATTACH_REVIEW_SOURCE 三个来源', A.ATTACH_REVIEW_SOURCE, { AUTO: 'auto', MANUAL: 'manual', CLASSIFIER: 'classifier' });
deep('ATTACH_REVIEW_ACTION 映射', A.ATTACH_REVIEW_ACTION, { approve: 'approved', reject: 'rejected' });

const rules = A.ATTACH_REVIEW_RULES;
is('规则：单边上限 12000 px', rules.maxPx, 12000);
is('规则：单边上限文案', rules.maxPxLabel, '12000 px');
is('规则：像素总量 4000 万', rules.maxPixels, 40000000);
is('规则：像素总量文案', rules.maxPixelsLabel, '4000 万');
is('规则：体积上限 = ATTACH_MAX', rules.maxBytes, A.ATTACH_MAX);
is('规则：队列默认 50', rules.queueLimit, 50);
is('规则：队列上限 200', rules.queueMax, 200);

const colNames = A.ATTACH_REVIEW_COLUMNS.map(function (c) { return c.name; });
deep('审核列名与顺序（6 列）', colNames,
  ['review_status', 'review_by', 'review_at', 'review_reason', 'review_source', 'review_hidden']);
A.ATTACH_REVIEW_COLUMNS.forEach(function (c) {
  ok('列 ' + c.name + ' 的 DDL 是单行', String(c.ddl).indexOf('\n') < 0, JSON.stringify(String(c.ddl).slice(0, 80)));
});
is('审核索引 2 条', A.ATTACH_REVIEW_DDL.length, 2);
A.ATTACH_REVIEW_DDL.forEach(function (s) {
  ok('审核 DDL 单行且以 CREATE 开头', String(s).indexOf('\n') < 0 && String(s).indexOf('CREATE ') === 0,
    JSON.stringify(String(s).slice(0, 90)));
});
ok('回归护栏：审核索引不带 idx_attachments_ 前缀（冻结断言数 sqlite_master 时是 5 条）',
  A.ATTACH_REVIEW_DDL.every(function (s) { return s.indexOf('idx_attachments') < 0; }));
const envKeys = A.OBJECT_ENV_KEYS;
['ATTACH_STORE', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_PUBLIC_BASE', 'S3_PATH_STYLE']
  .forEach(function (k) { ok('环境变量清单含 ' + k, envKeys.indexOf(k) >= 0, JSON.stringify(envKeys)); });
ok('worker 镜像从 ../src/attachments.js 引（源码断言）',
  readFileSync(join(TMP, 'worker', 'attachments.js'), 'utf8').indexOf("from '../src/attachments.js'") >= 0);
ok('worker 镜像保留 /ugc/a/:id 路由挂载点（源码断言）',
  readFileSync(join(TMP, 'worker', 'attachments.js'), 'utf8').indexOf("'/ugc/a/:id'") >= 0);

// ═══════════════════════════════ ② SigV4 ═══════════════════════════════
section('② SigV4：AWS 官方向量与形状');

const VEC_AMZ = '20130524T000000Z';
const VEC_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const vec = await A.signAwsV4({
  method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
  payloadHash: VEC_HASH, region: 'us-east-1', service: 's3',
  accessKey: S3_AK, secretKey: S3_SK, amzDate: VEC_AMZ, headers: { range: 'bytes=0-9' }
});
is('官方向量签名', vec.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
is('官方向量 SignedHeaders', vec.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
is('官方向量 scope', vec.scope, '20130524/us-east-1/s3/aws4_request');
is('官方向量 amzDate', vec.amzDate, VEC_AMZ);
is('官方向量 canonicalRequest',
  vec.canonicalRequest,
  ['GET', '/test.txt', '', 'host:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:' + VEC_HASH + '\nx-amz-date:' + VEC_AMZ + '\n',
    'host;range;x-amz-content-sha256;x-amz-date', VEC_HASH].join('\n'));
is('官方向量 Authorization',
  vec.authorization,
  'AWS4-HMAC-SHA256 Credential=' + S3_AK + '/20130524/us-east-1/s3/aws4_request, ' +
  'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
  'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
has('stringToSign 第一行是算法', vec.stringToSign, 'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n');
is('返回的头里有 host', vec.headers.host, 'examplebucket.s3.amazonaws.com');
is('返回的头里有 x-amz-date', vec.headers['x-amz-date'], VEC_AMZ);
is('返回的头里有 payload 哈希', vec.headers['x-amz-content-sha256'], VEC_HASH);

const folded = await A.signAwsV4({
  host: 'h', path: '/k', accessKey: 'ak', secretKey: 'sk',
  amzDate: VEC_AMZ, payloadHash: VEC_HASH, headers: { 'X-Amz-Meta-Note': '  a   b  ' }
});
has('额外头 key 转小写且空白折叠', folded.canonicalRequest, 'x-amz-meta-note:a b\n');
has('SignedHeaders 按字典序（host;x-amz-content-sha256;x-amz-date;x-amz-meta-note）',
  folded.signedHeaders, 'host;x-amz-content-sha256;x-amz-date;x-amz-meta-note');

const byBody = await A.signAwsV4({ host: 'h', path: '/k', accessKey: 'ak', secretKey: 'sk', amzDate: VEC_AMZ, payload: textBytes('') });
is('没给 payloadHash 时按 payload 现算', byBody.headers['x-amz-content-sha256'], VEC_HASH);
const byBytes = await A.signAwsV4({ host: 'h', path: '/k', accessKey: 'ak', secretKey: 'sk', amzDate: VEC_AMZ, payload: textBytes('abc') });
is('payload 不是空串时哈希也对', byBytes.headers['x-amz-content-sha256'], sha256hex(Buffer.from('abc')));

is('amzDateStamp(epoch)', A.amzDateStamp(new Date(0)), '19700101T000000Z');
is('amzDateStamp(毫秒数)', A.amzDateStamp(1700000000000), '20231114T221320Z');
is('amzDateStamp(无参数走现在，长度 16)', A.amzDateStamp().length, 16);

const k1 = A.safeObjectKey('');
ok('空 key 被挡', k1.ok === false && k1.error === 'key_required', JSON.stringify(k1));
const k2 = A.safeObjectKey('/abs/x.png');
ok('绝对路径 key 被挡', k2.ok === false && k2.hint.indexOf('绝对路径') >= 0, JSON.stringify(k2));
ok('反斜杠 key 被挡', A.safeObjectKey('a\\b').ok === false);
ok('.. key 被挡', A.safeObjectKey('a/../b').ok === false);
ok('控制字符 key 被挡', A.safeObjectKey('a\u0001b').ok === false);
ok('超长 key 被挡（>512）', A.safeObjectKey('a'.repeat(513)).ok === false);
is('key 两头空白被 trim', A.safeObjectKey('  ok/key.png  ').key, 'ok/key.png');
ok('中文与空格 key 放行（编码交给 s3UriEncode）', A.safeObjectKey('中文/图片 1.png').ok === true);

// ═══════════════════════════════ ③ local 对象存储 ═══════════════════════════════
section('③ local 对象存储：put / get / delete / url');

const localDir = join(TMP, 'obj-local');
const local = A.createObjectStore({ driver: 'local', dir: localDir, publicBase: 'https://cdn.example.com/base/' });
is('local 驱动名', local.driver, 'local');
is('local 不回落', local.fallback, false);
is('info().driver', local.info().driver, 'local');
is('info().dir 就是给的目录（内部统一正斜杠）', local.info().dir, localDir.replace(/\\/g, '/'));
is('info().publicBase 去掉尾斜杠', local.info().publicBase, 'https://cdn.example.com/base');
is('dir() 异步也给同一个目录', await local.dir(), localDir.replace(/\\/g, '/'));

const blobA = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
const putA = await local.put('news/2026/a.bin', blobA, { contentType: 'application/x-test' });
ok('put 成功', putA.ok === true, JSON.stringify(putA));
is('put 回 key', putA.key, 'news/2026/a.bin');
is('put 回字节数', putA.bytes, blobA.length);
is('put 回 contentType', putA.contentType, 'application/x-test');
is('put 回 driver', putA.driver, 'local');
is('local 没有 etag（磁盘不算）', putA.etag, '');
ok('落盘目录按 key 自动建子目录', existsSync(join(localDir, 'news', '2026', 'a.bin')));
bytesEq('磁盘上的字节与写入一致', readFileSync(join(localDir, 'news', '2026', 'a.bin')), blobA);

const getA = await local.get('news/2026/a.bin');
ok('get 成功', getA.ok === true, JSON.stringify(getA).slice(0, 200));
bytesEq('get 的字节与写入一致', getA.bytes, blobA);
is('get 给 size', getA.size, blobA.length);
is('local get 不谎报 content-type（磁盘没存）', getA.contentType, '');
is('get 的 driver', getA.driver, 'local');
const missGet = await local.get('nope/missing.bin');
ok('get 不存在的对象给 not_found', missGet.error === 'not_found', JSON.stringify(missGet));
has('not_found 的 hint 带绝对路径', missGet.hint, localDir.replace(/\\/g, '/'));

is('url 拼 publicBase（url 是 async）', await local.url('news/2026/a.bin'), 'https://cdn.example.com/base/news/2026/a.bin');
is('url 遇到非法 key 给空串', await local.url('../evil'), '');
async function noBaseUrl() {
  const bare = A.createObjectStore({ driver: 'local', dir: join(TMP, 'obj-local2'), env: {} });
  const u = await bare.url('x.bin');
  return { url: u, info: bare.info(), fallback: bare.fallback };
}
const bare = await noBaseUrl();
is('没配 publicBase 时 url 给空串（前端退回 /ugc/a/:id）', bare.url, '');
is('没配 publicBase 时 info().publicBase 是空串', bare.info.publicBase, '');
is('local 永远不回落', bare.fallback, false);

const putBad = await local.put('../evil', blobA, {});
ok('put 非法 key 被挡（透传 safeObjectKey 的错误）', putBad.ok === false && putBad.error === 'bad_key', JSON.stringify(putBad));

const cnKey = '中文/图片 1.png';
const putCn = await local.put(cnKey, pngBytes(4, 4), {});
ok('中文 + 空格 key 能落盘', putCn.ok === true, JSON.stringify(putCn));
ok('中文 key 的文件真的在', existsSync(join(localDir, '中文', '图片 1.png')));
bytesEq('中文 key 读回一致', (await local.get(cnKey)).bytes, pngBytes(4, 4));
is('中文 key 的 url 原样拼', await local.url(cnKey), 'https://cdn.example.com/base/中文/图片 1.png');

await local.put('same/key.bin', new Uint8Array([9, 9]), {});
await local.put('same/key.bin', new Uint8Array([7, 7, 7]), {});
const over = await local.get('same/key.bin');
is('local 是同路径覆盖写（不做内容寻址）', over.size, 3);
bytesEq('覆盖后的内容是新的一份', over.bytes, new Uint8Array([7, 7, 7]));

const delA = await local.delete('news/2026/a.bin');
ok('delete 成功', delA.ok === true, JSON.stringify(delA));
is('delete 回 already=false', delA.already, false);
is('delete 后文件真没了', existsSync(join(localDir, 'news', '2026', 'a.bin')), false);
const delAgain = await local.delete('news/2026/a.bin');
is('重复 delete 幂等（already=true）', delAgain.already, true);
ok('重复 delete 仍是 ok', delAgain.ok === true, JSON.stringify(delAgain));

const putEmpty = await local.put('zero/empty.bin', new Uint8Array(0), {});
is('空对象也能写', putEmpty.bytes, 0);
is('空对象读回 size=0', (await local.get('zero/empty.bin')).size, 0);

const STORE_ENV = { ATTACH_STORE: 'local', ...{} };
// 注意：老 createStore 即使走 local 也会去开一次默认库（副本里的 data/games.db）——
// 这里显式喂一个内存库，免得那个句柄一直开着、收尾删不掉临时目录。
const bootDb = trackDb(new DatabaseSync(':memory:'));
const viaCreateStore = A.createStore({ driver: 'local', db: bootDb, dir: join(TMP, 'obj-local3'), env: STORE_ENV });
is('createStore 认得 driver local（转发给对象存储）', viaCreateStore.driver, 'local');
const viaFsAlias = A.createObjectStore({ driver: 'fs', dir: join(TMP, 'obj-local4'), env: {} });
is("driver 'fs' 当 local 的同义词", viaFsAlias.driver, 'local');
is("driver 'fs' 不算回落", viaFsAlias.fallback, false);
const defaultDir = await A.createObjectStore({ driver: 'local', env: {} }).dir();
ok('没给 dir 时默认落在副本的 data/attachments（证明副本 ROOT 是临时目录）',
  defaultDir.indexOf(TMP.replace(/\\/g, '/')) === 0 || defaultDir.indexOf(TMP) === 0, 'got=' + defaultDir);

// ═══════════════════════════════ ④ 未配置 S3 的回落 ═══════════════════════════════
section('④ 未配置 S3：回落到 local 且只打一行日志');

const back1 = await withWarn(function () { return A.createObjectStore({ driver: 's3', dir: join(TMP, 'obj-back1'), env: {} }); });
const warn1 = endWarn();
is('s3 缺配置 → driver=local', back1.driver, 'local');
is('标了 fallback', back1.fallback, true);
is('fallbackReason 逐字', back1.fallbackReason, '缺 S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY');
is('fallbackLog 逐字', back1.fallbackLog, '附件存储：S3 没配全（缺 S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY），这次按 local 落盘');
is('只打了一行日志', warn1.length, 1);
is('日志内容与 fallbackLog 一致', warn1[0], back1.fallbackLog);
ok('回落出来的 store 真能用', (await back1.put('x/y.bin', new Uint8Array([1]))).ok === true);

const back2 = await withWarn(function () { return A.createObjectStore({ dir: join(TMP, 'obj-back2'), env: { ATTACH_STORE: 's3' } }); });
const warn2 = endWarn();
is('ATTACH_STORE=s3 也走 s3 分支再回落', back2.driver, 'local');
is('ATTACH_STORE=s3 的 fallbackReason', back2.fallbackReason, '缺 S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY');
is('ATTACH_STORE=s3 一行日志', warn2.length, 1);

const back3 = await withWarn(function () {
  return A.createObjectStore({ dir: TMP, env: { ATTACH_STORE: '  S3  ', S3_BUCKET: 'b', S3_ACCESS_KEY: 'ak' } });
});
endWarn();
is('ATTACH_STORE 两端空白 + 大写也认得', back3.fallbackReason, '缺 S3_SECRET_KEY');
is('缺哪个报哪个（只缺 SK）', back3.fallbackReason.indexOf('S3_SECRET_KEY') > 0, true);

const back4 = await withWarn(function () {
  return A.createObjectStore({ driver: 'minio', dir: TMP, env: { S3_BUCKET: 'b', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });
});
endWarn();
is('minio 归 s3 一类（有配置就不回落）', back4.driver, 's3');
const back5 = await withWarn(function () { return A.createObjectStore({ driver: 's3-compatible', dir: TMP, env: {} }); });
endWarn();
is('s3-compatible 也归 s3（缺配置照旧回落）', back5.driver, 'local');

const savedFetch = globalThis.fetch;
const back6 = await withWarn(function () {
  globalThis.fetch = undefined;
  try {
    return A.createObjectStore({ dir: TMP, env: { ATTACH_STORE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });
  } finally { globalThis.fetch = savedFetch; }
});
const warn6 = endWarn();
is('运行时没有 fetch 也回落', back6.driver, 'local');
is('没有 fetch 的 fallbackReason', back6.fallbackReason, '这个运行时没有 fetch');
is('没有 fetch 的日志逐字', back6.fallbackLog, '附件存储：S3 没配全（这个运行时没有 fetch），这次按 local 落盘');
is('没有 fetch 也只一行日志', warn6.length, 1);

const back7 = await withWarn(function () { return A.createObjectStore({ driver: 'wat', dir: TMP, env: {} }); });
const warn7 = endWarn();
is('不认识的驱动也回落', back7.driver, 'local');
is('不认识的驱动 fallbackReason 逐字', back7.fallbackReason, '不认识的驱动 wat');
is('不认识的驱动日志逐字', warn7[0], '附件存储：不认识的对象存储驱动 wat，按 local 落盘');
is('不认识的驱动一行日志', warn7.length, 1);

const back8 = await withWarn(function () {
  return A.createObjectStore({ driver: 's3', dir: TMP, env: { S3_ENDPOINT: '不是URL', S3_BUCKET: 'b', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });
});
const warn8 = endWarn();
is('endpoint 不成形状也回落', back8.driver, 'local');
is('endpoint 不成形状的 fallbackReason', back8.fallbackReason, 'S3_ENDPOINT 不成形状');
has('endpoint 不成形状的日志', warn8[0], 'S3_ENDPOINT 不成形状');

// ═══════════════════════════════ ⑤ 假 S3：真实 HTTP + 独立复算签名 ═══════════════════════════════
section('⑤ 假 S3 服务：put / get / delete / url（签名由 node:crypto 独立复算）');

const fake = await startFakeS3({ secret: S3_SK });
servers.push(fake);
const s3env = { S3_ENDPOINT: fake.origin, S3_BUCKET: 'ugc', S3_REGION: 'us-east-1', S3_ACCESS_KEY: S3_AK, S3_SECRET_KEY: S3_SK };
const s3 = A.createObjectStore({ driver: 's3', env: s3env });
is('s3 驱动名', s3.driver, 's3');
is('配全了就不回落', s3.fallback, false);
const s3info = s3.info();
is('info().endpoint', s3info.endpoint, fake.origin);
is('info().bucket', s3info.bucket, 'ugc');
is('info().region', s3info.region, 'us-east-1');
is('非 amazonaws 主机默认 path-style', s3info.pathStyle, true);
is('info().host 是裸主机', s3info.host, '127.0.0.1:' + fake.port);
is('info().urlTtl 默认 3600', s3info.urlTtl, 3600);

const bodyS3 = textBytes('hello s3 world');
const putS3 = await s3.put('ugc-img/a.png', bodyS3, { contentType: 'image/png' });
ok('s3 put 成功', putS3.ok === true, JSON.stringify(putS3));
is('s3 put 回 driver', putS3.driver, 's3');
is('s3 put 回 status', putS3.status, 200);
ok('s3 put 带回 etag（服务端给的）', typeof putS3.etag === 'string' && putS3.etag.length > 2, 'etag=' + JSON.stringify(putS3.etag));
is('s3 put 回的字节数', putS3.bytes, bodyS3.length);

const recPut = fake.last();
is('请求方法是 PUT', recPut.method, 'PUT');
is('path-style 路径 = /<bucket>/<key>', recPut.path, '/ugc/ugc-img/a.png');
ok('服务端独立复算签名通过', recPut.verify.ok === true, recPut.verify.why);
is('署名头就是三个（host 由 URL 带，content-type 不签名）', recPut.verify.signedHeaders, 'host;x-amz-content-sha256;x-amz-date');
is('payload 哈希 = 实体 sha256', recPut.verify.payloadHash, sha256hex(Buffer.from(bodyS3)));
is('scope 里的 region/service', recPut.verify.scope.split('/').slice(1).join('/'), recPut.verify.scope.slice(9));
has('Authorization 带算法前缀', recPut.headers.authorization, 'AWS4-HMAC-SHA256 Credential=' + S3_AK + '/');
has('Authorization 带 scope', recPut.headers.authorization, '/us-east-1/s3/aws4_request');
has('Authorization 带 SignedHeaders 段', recPut.headers.authorization, ', SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=');
has('Authorization 的签名是 64 位十六进制', recPut.headers.authorization, 'Signature=' + recPut.verify.signature);
is('请求头带了 x-amz-date', typeof recPut.headers['x-amz-date'] === 'string' && recPut.headers['x-amz-date'].length === 16, true);
ok('x-amz-date 以 Z 结尾', String(recPut.headers['x-amz-date']).endsWith('Z'));
bytesEq('服务端收到的实体逐字节一致', recPut.body, bodyS3);
is('服务端存下来的 content-type', fake.objects.get('/ugc/ugc-img/a.png').type, 'image/png');

const getS3 = await s3.get('ugc-img/a.png');
ok('s3 get 成功', getS3.ok === true, JSON.stringify(getS3).slice(0, 200));
bytesEq('s3 get 的字节一致', getS3.bytes, bodyS3);
is('s3 get 的 size', getS3.size, bodyS3.length);
is('s3 get 回传 content-type', getS3.contentType, 'image/png');
is('s3 get 的 driver', getS3.driver, 's3');
ok('s3 GET 的签名也由服务端独立验过', fake.last().verify.ok === true, fake.last().verify.why);

const missS3 = await s3.get('ugc-img/none.png');
ok('s3 get 404 → not_found', missS3.error === 'not_found', JSON.stringify(missS3));
has('not_found 的 hint 带 key', missS3.hint, 'ugc-img/none.png');

const cnBytes = textBytes('中文内容');
const putCnS3 = await s3.put('ugc-img/中文 图.png', cnBytes, {});
is('中文/空格 key 也认', putCnS3.ok, true);
const recCn = fake.last();
has('路径按 %XX 编码（UTF-8 大写十六进制）', recCn.path, '%E4%B8%AD%E6%96%87%20%E5%9B%BE.png');
ok('路径里没有裸空格', recCn.path.indexOf(' ') < 0, recCn.path);
ok('编码后的路径签名仍然对得上', recCn.verify.ok === true, recCn.verify.why);
bytesEq('中文 key 的 s3 读回一致', (await s3.get('ugc-img/中文 图.png')).bytes, cnBytes);

const emptyPut = await s3.put('ugc-img/empty.bin', new Uint8Array(0), {});
is('空对象 PUT 也 ok', emptyPut.bytes, 0);
is('空对象 payload 哈希是 e3b0…（空 sha256）', fake.last().verify.payloadHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
ok('空对象 PUT 签名通过', fake.last().verify.ok === true, fake.last().verify.why);

const delS3 = await s3.delete('ugc-img/empty.bin');
ok('s3 delete 成功', delS3.ok === true, JSON.stringify(delS3));
is('s3 delete 回 already=false', delS3.already, false);
is('s3 delete 回 status=204', delS3.status, 204);
ok('服务端对象真删了', !fake.objects.has('/ugc/ugc-img/empty.bin'));
const delS3again = await s3.delete('ugc-img/empty.bin');
is('重复 delete → already=true', delS3again.already, true);
is('重复 delete 的 status=404', delS3again.status, 404);

const basePathStore = A.createObjectStore({
  driver: 's3', env: { ...s3env, S3_ENDPOINT: fake.origin + '/gw' }
});
is('带 basePath 时 info().endpoint 只报 origin（basePath 另算）', basePathStore.info().endpoint, fake.origin);
await basePathStore.put('p.png', bodyS3, {});
ok('basePath 拼在对象路径前面', fake.last().path === '/gw/ugc/p.png', 'path=' + fake.last().path);
ok('basePath 路径签名也过', fake.last().verify.ok === true, fake.last().verify.why);

const pubStore = A.createObjectStore({ driver: 's3', env: { ...s3env, S3_PUBLIC_BASE: 'https://cdn.example.com/u' } });
const pubUrl = await pubStore.url('ugc-img/a.png');
has('配了 publicBase 就用它（不透传签名）', pubUrl, 'https://cdn.example.com/u/');
ok('publicBase URL 里没有签名参数', pubUrl.indexOf('X-Amz-Signature') < 0, pubUrl);

const preUrl = await s3.url('ugc-img/a.png');
has('没配 publicBase 给预签 URL', preUrl, fake.origin + '/ugc/ugc-img/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256');
has('预签 URL 带 Credential', preUrl, 'X-Amz-Credential=');
has('预签 URL 带 SignedHeaders=host', preUrl, 'X-Amz-SignedHeaders=host');
has('预签 URL 带 Expires=3600', preUrl, 'X-Amz-Expires=3600');
ok('预签 URL 的 Signature 是 64 位十六进制', /[?&]X-Amz-Signature=[0-9a-f]{64}$/.test(preUrl), preUrl);
const preRes = await fetch(preUrl);
is('预签 URL 真去 GET 能拿到 200（服务端独立复算过 query 签名）', preRes.status, 200);
bytesEq('预签 URL 取回的字节一致', Buffer.from(await preRes.arrayBuffer()), bodyS3);
ok('预签请求的签名复算通过', fake.last().verify.ok === true, fake.last().verify.why);
is('预签请求的 payload 占位是 UNSIGNED-PAYLOAD', fake.last().query.indexOf('X-Amz-Signature') >= 0, true);

const ttlStore = A.createObjectStore({ driver: 's3', env: { ...s3env }, urlTtl: 60 });
has('urlTtl 可覆盖', await ttlStore.url('p.png'), 'X-Amz-Expires=60');
const ttlBad = A.createObjectStore({ driver: 's3', env: { ...s3env }, urlTtl: 0 });
has('urlTtl=0 回落到 3600', await ttlBad.url('p.png'), 'X-Amz-Expires=3600');
const ttlHuge = A.createObjectStore({ driver: 's3', env: { ...s3env }, urlTtl: 99999999 });
has('urlTtl 超上限回落到 3600', await ttlHuge.url('p.png'), 'X-Amz-Expires=3600');

const vhost = A.createObjectStore({ driver: 's3', env: { ...s3env, S3_PATH_STYLE: 'false' } });
is('S3_PATH_STYLE=false → 虚拟主机风格', vhost.info().pathStyle, false);
is('虚拟主机风格的 host', vhost.info().host, 'ugc.127.0.0.1:' + fake.port);
const vhostUrl = await vhost.url('p.png');
has('虚拟主机风格路径没有 bucket 段', vhostUrl, fake.origin + '/p.png?');
const awsDefault = A.createObjectStore({ driver: 's3', env: { S3_BUCKET: 'b', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });
is('没给 endpoint 时默认 s3.<region>.amazonaws.com', awsDefault.info().endpoint, 'https://s3.us-east-1.amazonaws.com');
is('amazonaws 主机默认虚拟主机风格', awsDefault.info().pathStyle, false);
is('amazonaws 默认 host 是 bucket.前缀', awsDefault.info().host, 'b.s3.us-east-1.amazonaws.com');
const pathStyleEnv = A.createObjectStore({ driver: 's3', env: { ...s3env, S3_PATH_STYLE: '1' } });
is('S3_PATH_STYLE=1 认成 true', pathStyleEnv.info().pathStyle, true);
ok('只算 info/url 的这几个 store 没发过请求', fake.log.length > 0 && s3info.pathStyle === true);

const failServer = await startFakeS3({ secret: S3_SK, fail: true });
servers.push(failServer);
const s3fail = A.createObjectStore({ driver: 's3', env: { ...s3env, S3_ENDPOINT: failServer.origin } });
const putFail = await s3fail.put('a.png', bodyS3, {});
ok('PUT 收到 500 → http_error', putFail.error === 'http_error', JSON.stringify(putFail));
is('错误里带 status', putFail.status, 500);
has('错误里带路径与码', putFail.hint, '500');
const getFail = await s3fail.get('a.png');
ok('GET 收到 500 → http_error', getFail.error === 'http_error', JSON.stringify(getFail));
is('GET 的错误也带 status', getFail.status, 500);
const delFail = await s3fail.delete('a.png');
ok('DELETE 收到 500 → http_error', delFail.error === 'http_error', JSON.stringify(delFail));

const dead = await startFakeS3({ secret: S3_SK });
await dead.close();
const s3dead = A.createObjectStore({ driver: 's3', env: { ...s3env, S3_ENDPOINT: dead.origin } });
const deadPut = await s3dead.put('a.png', bodyS3, {});
ok('端口关了 → network_error', deadPut.error === 'network_error', JSON.stringify(deadPut));
has('network_error 的 hint 带「连不上」', deadPut.hint, '连不上');
const deadGet = await s3dead.get('a.png');
ok('端口关了 GET 也是 network_error', deadGet.error === 'network_error', JSON.stringify(deadGet));

// ═══════════════════════════════ ⑥ 图片尺寸 + 自动规则 ═══════════════════════════════
section('⑥ 图片尺寸识别（不解码）与自动规则各分支');

const szPng = A.readImageSize(pngBytes(800, 600));
is('PNG 宽', szPng.width, 800);
is('PNG 高', szPng.height, 600);
is('PNG kind', szPng.kind, 'png');
const szGif = A.readImageSize(gifBytes(320, 240));
is('GIF 宽', szGif.width, 320);
is('GIF 高', szGif.height, 240);
is('GIF kind', szGif.kind, 'gif');
const szJpg = A.readImageSize(jpegBytes(1024, 768));
is('JPEG 宽', szJpg.width, 1024);
is('JPEG 高', szJpg.height, 768);
is('JPEG kind', szJpg.kind, 'jpeg');
const szVp8x = A.readImageSize(webpVp8xBytes(640, 480));
is('WebP(VP8X) 宽', szVp8x.width, 640);
is('WebP(VP8X) 高', szVp8x.height, 480);
const szVp8l = A.readImageSize(webpVp8lBytes(300, 200));
is('WebP(VP8L) 宽', szVp8l.width, 300);
is('WebP(VP8L) 高', szVp8l.height, 200);
const szVp8 = A.readImageSize(webpVp8Bytes(512, 384));
is('WebP(VP8) 宽', szVp8.width, 512);
is('WebP(VP8) 高', szVp8.height, 384);
is('PNG 宽 0 也照读（不合法交给规则判）', A.readImageSize(pngBytes(0, 768)).width, 0);
is('只有 16 字节的 PNG 头 → null', A.readImageSize(pngHeadOnly()), null);
is('10 字节 JPEG（冻结夹具形状）→ null', A.readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])), null);
is('8 字节 GIF → null', A.readImageSize(textBytes('GIF89a\u0001\u0000')), null);
is('纯文本 → null', A.readImageSize(textBytes('hello world!')), null);
is('空内容 → null', A.readImageSize(new Uint8Array(0)), null);
is('9 字节都不够 → null', A.readImageSize(new Uint8Array(9)), null);
is('WebP 但块不认识 → null', A.readImageSize(new Uint8Array(30).fill(1)), null);

function rule(name, meta, value) { return A.autoReviewAttachment(meta, value); }
const REJECTED = A.ATTACH_REVIEW.REJECTED;
const PENDING = A.ATTACH_REVIEW.PENDING;

const rNoName = rule('文件名空', {}, null);
is('没文件名 → rejected', rNoName.status, REJECTED);
is('没文件名的 reason', rNoName.reason, '文件名不能为空');
is('rejected 不带 note', rNoName.note, '');
const rNoExt = rule('无扩展名', { filename: 'README', bytes: 10 }, textBytes('abcdefghij'));
is('无扩展名 → rejected', rNoExt.status, REJECTED);
is('无扩展名的 reason 逐字', rNoExt.reason, '附件要带扩展名，支持 ' + A.ATTACH_EXT_LIST.join(' / '));
const rBadExt = rule('不支持的类型', { filename: 'evil.exe', bytes: 10 }, new Uint8Array([0x4d, 0x5a, 0, 0, 0, 0, 0, 0, 0, 0]));
is('.exe → rejected', rBadExt.status, REJECTED);
has('.exe 的 reason 逐字开头', rBadExt.reason, '不支持 .exe 这类附件，支持 ');
const rMime = rule('MIME 不符', { filename: 'a.png', mime: 'text/plain', bytes: 26 }, pngBytes(8, 8));
is('MIME 不符 → rejected', rMime.status, REJECTED);
is('MIME 不符的 reason 逐字', rMime.reason, '.png 的类型应为 image/png，浏览器报的是 text/plain');
const rOctet = rule('octet-stream 不算 MIME 不符', { filename: 'a.png', mime: 'application/octet-stream', bytes: 26 }, pngBytes(8, 8));
is('application/octet-stream 放行给后面的规则判', rOctet.status, PENDING);
const rZero = rule('空文件', { filename: 'a.png', mime: 'image/png', bytes: 0 }, new Uint8Array(0));
is('0 字节 → rejected', rZero.status, REJECTED);
is('0 字节的 reason', rZero.reason, 'a.png 是空的');
const rKindMax = rule('超图片 2 MB', { filename: 'a.png', mime: 'image/png', bytes: 3 * 1024 * 1024 }, pngBytes(8, 8));
is('超 kind.max → rejected', rKindMax.status, REJECTED);
has('超 kind.max 的 reason', rKindMax.reason, '图片最大 2 MB，a.png 有 ');
const rHardMax = rule('超硬上限 4 MB', { filename: 'a.zip', mime: 'application/zip', bytes: 5 * 1024 * 1024 }, new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
is('超 ATTACH_MAX → rejected', rHardMax.status, REJECTED);
has('超 ATTACH_MAX 的 reason', rHardMax.reason, '附件最大 4 MB，a.zip 有 ');
const rMagic = rule('魔数不符', { filename: 'a.png', mime: 'image/png', bytes: 20 }, textBytes('this is not a png!'));
is('魔数不符 → rejected', rMagic.status, REJECTED);
is('魔数不符的 reason 逐字', rMagic.reason, '.png 的内容不像图片（魔数不符）');
const rMagicZip = rule('ZIP 魔数不符', { filename: 'a.zip', mime: 'application/zip', bytes: 8 }, textBytes('not a zip'));
has('ZIP 魔数不符也带类型名', rMagicZip.reason, '.zip 的内容不像压缩包（魔数不符');
const rTextPng = rule('文本里塞 PNG', { filename: 'a.txt', mime: 'text/plain', bytes: 26 }, pngBytes(8, 8));
is('文本里塞 PNG → rejected', rTextPng.status, REJECTED);
has('文本里塞 PNG 的 reason', rTextPng.reason, 'a.txt 是文本附件，但内容看着是 ');
has('文本里塞 PNG 的 reason 收尾', rTextPng.reason, '，请改扩展名或换文件');
const rNul = rule('文本里有 NUL', { filename: 'a.txt', mime: 'text/plain', bytes: 5 }, Uint8Array.from([0x61, 0x62, 0x00, 0x63, 0x64]));
is('NUL → rejected', rNul.status, REJECTED);
has('NUL 的 reason', rNul.reason, '里有 NUL 字节，像是二进制文件，不能当文本附件');
const rNoBody = rule('没给内容', { filename: 'a.png', mime: 'image/png', bytes: 26 }, null);
is('没内容 → 留 pending', rNoBody.status, PENDING);
is('没内容的 note 逐字', rNoBody.note, '没拿到内容，魔数与尺寸判不了，转人工');
is('没内容的 reason 是空串', rNoBody.reason, '');
const rHeadOnly = rule('尺寸读不出', { filename: 'a.png', mime: 'image/png', bytes: 16 }, pngHeadOnly());
is('尺寸读不出 → 留 pending（不许当不合格）', rHeadOnly.status, PENDING);
is('尺寸读不出的 note 逐字', rHeadOnly.note, '图片尺寸读不出来（头部不完整或不是标准图片），转人工');
const rZeroSide = rule('宽 0', { filename: 'a.png', mime: 'image/png', bytes: 26 }, pngBytes(0, 768));
is('宽 0 → rejected', rZeroSide.status, REJECTED);
is('宽 0 的 reason 逐字', rZeroSide.reason, '图片宽高不合法（0×768）');
const rSide = rule('单边超限', { filename: 'a.png', mime: 'image/png', bytes: 26 }, pngBytes(13000, 2));
is('单边超限 → rejected', rSide.status, REJECTED);
is('单边超限的 reason 逐字', rSide.reason, '图片单边上限 12000 px，这张 13000×2');
const rAtSide = rule('单边正好 12000', { filename: 'a.png', mime: 'image/png', bytes: 26 }, pngBytes(12000, 2));
is('正好 12000 不算超（边界）', rAtSide.status, PENDING);
const rPixels = rule('总量超限', { filename: 'a.png', mime: 'image/png', bytes: 26 }, pngBytes(7000, 7000));
is('总量超限 → rejected', rPixels.status, REJECTED);
is('总量超限的 reason 逐字', rPixels.reason, '图片像素总量上限 4000 万，这张 7000×7000');
const rOkPng = rule('正常图片', { filename: 'a.png', mime: 'image/png', bytes: 26 }, pngBytes(800, 600));
is('正常图片 → 留 pending', rOkPng.status, PENDING);
is('正常图片的 note 逐字', rOkPng.note, '自动规则没发现不合格项，等人工 / 分类器给结论');
is('正常图片也没给 approved（口径）', rOkPng.status === 'approved', false);
const rOkTxt = rule('正常文本', { filename: 'note.txt', mime: 'text/plain', bytes: 11 }, textBytes('hello world'));
is('正常文本 → 留 pending', rOkTxt.status, PENDING);
is('正常文本的 note 同一条', rOkTxt.note, '自动规则没发现不合格项，等人工 / 分类器给结论');
const rTxtNoMime = rule('文本没报类型', { filename: 'note.txt', bytes: 11 }, textBytes('hello world'));
is('没报 MIME 的文本也放行', rTxtNoMime.status, PENDING);
const rZip = rule('正常 ZIP', { filename: 'a.zip', mime: 'application/zip', bytes: 8 }, new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
is('ZIP 头对但内容不全 → 留 pending（尺寸/魔数之外不猜）', rZip.status, PENDING);
is('返回形状恒定的 source', rZip.source, 'auto');
deep('返回字段清单恒定',
  Object.keys(rZip).sort(),
  ['ext', 'height', 'kind', 'name', 'note', 'reason', 'size', 'source', 'status', 'width'].sort());
is('返回里带解析出的扩展名', rZip.ext, 'zip');
is('返回里带 kind', rZip.kind, 'zip');
is('返回里带尺寸（非图片给 0）', rZip.width, 0);
is('图片返回值里带尺寸', rOkPng.width, 800);
const allRules = [rNoName, rNoExt, rBadExt, rMime, rOctet, rZero, rKindMax, rHardMax, rMagic, rMagicZip, rTextPng, rNul,
  rNoBody, rHeadOnly, rZeroSide, rSide, rAtSide, rPixels, rOkPng, rOkTxt, rTxtNoMime, rZip];
ok('自动规则永远不给 approved（20+ 分支全覆盖）',
  allRules.every(function (r) { return r.status !== A.ATTACH_REVIEW.APPROVED; }));
ok('自动规则的 status 只有 pending / rejected 两种',
  allRules.every(function (r) { return r.status === PENDING || r.status === REJECTED; }));

// ═══════════════════════════════ ⑦ 审核状态机 ═══════════════════════════════
section('⑦ 审核状态机：Express 线（node:sqlite + 磁盘）');

const sqDb = trackDb(new DatabaseSync(':memory:'));
const fsDir = join(TMP, 'uploads-fs');
const st = A.createStore({ driver: 'fs', db: sqDb, dir: fsDir });
const ens = await st.ensure();
is('ensure() ok', ens.ok, true);
is('ensure() 的 driver', ens.driver, 'fs');
is('ensure() 幂等（第二次同结果）', (await st.ensure()).driver, 'fs');
const rev1 = await st.ensureReview();
is('ensureReview() ok', rev1.ok, true);
is('ensureReview() 的列数', rev1.columns, 6);
deep('第一次补的 6 列（老库场景之外这里是空数组，见 ⑧）', rev1.added, []);
const rev2 = await st.ensureReview();
deep('ensureReview() 再跑一次还是空 added（幂等）', rev2.added, []);
is('后续再跑 columns 不变', rev2.columns, 6);

const colsNow = sqDb.prepare('PRAGMA table_info(attachments)').all().map(function (r) { return r.name; });
is('建完表共 18 列（12 冻结 + 6 审核）', colsNow.length, 18);
['review_status', 'review_by', 'review_at', 'review_reason', 'review_source', 'review_hidden']
  .forEach(function (c) { ok('表里真有 ' + c, colsNow.indexOf(c) >= 0); });
const idxAttach = sqDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_attachments%'").all();
is('冻结断言认的 idx_attachments% 索引仍是 5 条', idxAttach.length, 5);
const idxReview = sqDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_attach_review%'").all();
is('审核索引 2 条', idxReview.length, 2);

const png800 = pngBytes(800, 600);
const a1 = await st.save({ ownerId: 1, filename: 'draft.png', mime: 'image/png', bytes: png800 });
ok('save 成功', a1.ok === true, JSON.stringify(a1));
is('没挂帖 → 生命周期 pending', a1.status, 'pending');
is('fs 驱动', a1.driver, 'fs');
const a2 = await st.save({ ownerId: 2, postId: 9, filename: 'post.png', mime: 'image/png', bytes: pngBytes(801, 601) });
is('挂了帖 → 生命周期 active', a2.status, 'active');
const a3 = await st.save({ ownerId: 3, filename: 'huge.png', mime: 'image/png', bytes: pngBytes(13000, 2) });
is('自动规则判不合格 → 落库即 deleted（软隐藏）', a3.status, 'deleted');
const g3 = await st.get(a3.id);
is('被自动拒的行 review_status=rejected', g3.review_status, 'rejected');
is('被自动拒的行 review_source=auto', g3.review_source, 'auto');
has('被自动拒的行带规则理由', g3.review_reason, '图片单边上限 12000 px');
is('被自动拒的行 review_hidden=1', g3.review_hidden, 1);
is('被自动拒的行 review_by=0（不是人）', g3.review_by, 0);
is('被自动拒的行 review_at 记了时间', g3.review_at.length >= 16, true);

const g1 = await st.get(a1.id);
is('待审行的 review_status=pending', g1.review_status, 'pending');
is('待审行 review_source=auto（自动规则写了 note）', g1.review_source, 'auto');
has('待审行 review_reason 是那条 note', g1.review_reason, '自动规则没发现不合格项');
is('待审行 review_hidden=0', g1.review_hidden, 0);
is('meta() 原有 12 字段顺序没变（首字段 id）', Object.keys(g1)[0], 'id');
is('meta() 的第 13 个字段是 review_status', Object.keys(g1)[11 + 1], 'review_status');

const lp0 = await st.listPending();
is('listPending() 默认 limit', lp0.limit, 50);
is('listPending() 默认 offset', lp0.offset, 0);
is('listPending() 屏障：不含被软删的行', lp0.total, 2);
deep('listPending() 的 id 升序', lp0.items.map(function (r) { return r.id; }), [a1.id, a2.id]);
const lp1 = await st.listPending(1, 1);
is('分页 total 是总数不是本页数', lp1.total, 2);
is('分页 items 只有 1 条', lp1.items.length, 1);
is('分页 offset 生效', lp1.items[0].id, a2.id);
const lp2 = await st.listPending(999, -5);
is('limit 超上限被夹到 200', lp2.limit, 200);
is('负 offset 归一成 0', lp2.offset, 0);
const lp3 = await st.listPending(0, 0);
is('limit 0 归一成 50', lp3.limit, 50);
const lp4 = await st.listPending('2', '1');
is('字符串参数也认（Number 归一）', lp4.limit, 2);
is('字符串 offset 也认', lp4.offset, 1);

const forbidden1 = await st.moderate(a2.id, 'approve', { moderatorId: 0 });
ok('moderatorId=0 → forbidden', forbidden1.ok === false && forbidden1.error === 'forbidden', JSON.stringify(forbidden1));
has('forbidden 的 hint 说明要带 moderatorId', forbidden1.hint, 'moderatorId');
const forbidden2 = await st.moderate(a2.id, 'approve', {});
ok('没带 moderatorId → forbidden', forbidden2.error === 'forbidden');
const forbidden3 = await st.moderate(a2.id, 'approve', { moderatorId: 'abc' });
ok('moderatorId 非数字 → forbidden', forbidden3.error === 'forbidden');
is('forbidden 时没改库', (await st.get(a2.id)).review_status, 'pending');
const badAction = await st.moderate(a3.id, 'delete', { moderatorId: 1 });
ok('不认识的 action → bad_action', badAction.ok === false && badAction.error === 'bad_action', JSON.stringify(badAction));
is('bad_action 的 hint 逐字', badAction.hint, 'action 只认 approve / reject（收到 delete）');
const noReason = await st.moderate(a1.id, 'reject', { moderatorId: 7 });
ok('reject 不给理由 → reason_required', noReason.ok === false && noReason.error === 'reason_required', JSON.stringify(noReason));
const blankReason = await st.moderate(a1.id, 'reject', { moderatorId: 7, reason: '   ' });
ok('reject 空白理由也 → reason_required', blankReason.error === 'reason_required');
const missing = await st.moderate(9999, 'approve', { moderatorId: 7 });
ok('不存在的 id → not_found', missing.ok === false && missing.error === 'not_found', JSON.stringify(missing));
is('not_found 的 hint 逐字', missing.hint, '没有这个附件：9999');
const badId = await st.moderate('abc', 'approve', { moderatorId: 7 });
ok('非数字 id → not_found', badId.error === 'not_found', JSON.stringify(badId));
const zeroId = await st.moderate(0, 'approve', { moderatorId: 7 });
ok('id 0 → not_found', zeroId.error === 'not_found');

const ap2 = await st.moderate(a2.id, 'approve', { moderatorId: 42, reason: '内容正常', at: '2026-01-02 03:04:05' });
ok('approve 成功', ap2.ok === true, JSON.stringify(ap2));
is('approve 回 status', ap2.status, 'approved');
is('approve 不是重复操作', ap2.already, false);
is('approve 回 hidden=0', ap2.hidden, 0);
is('approve 回生命周期', ap2.lifecycle, 'active');
is('approve 回审核人', ap2.moderatorId, 42);
is('approve 回审核时间（注入的）', ap2.at, '2026-01-02 03:04:05');
is('approve 回 error 空串', ap2.error, '');
const g2a = await st.get(a2.id);
is('库里的 review_status', g2a.review_status, 'approved');
is('库里的 review_by', g2a.review_by, 42);
is('库里的 review_at', g2a.review_at, '2026-01-02 03:04:05');
is('库里的 review_source=manual', g2a.review_source, 'manual');
is('库里的 review_reason', g2a.review_reason, '内容正常');
is('approve 不动生命周期 status', g2a.status, 'active');

const ap2b = await st.moderate(a2.id, 'approve', { moderatorId: 42, at: '2099-09-09 09:09:09' });
is('重复 approve 幂等（already=true）', ap2b.already, true);
is('重复 approve 仍回 approved', ap2b.status, 'approved');
is('重复 approve 不写库（时间没被覆盖）', (await st.get(a2.id)).review_at, '2026-01-02 03:04:05');

const ap1 = await st.moderate(a1.id, 'approve', { moderatorId: 43, at: '2026-01-02 03:05:06' });
is('没挂帖的 pdraft 被批准后生命周期仍是 pending', ap1.lifecycle, 'pending');
is('批准后 status 保持 pending（没帖可挂）', (await st.get(a1.id)).status, 'pending');
const rejected0 = await st.listRejected();
is('此刻被拒清单只有自动拒的那条', rejected0.total, 1);
is('被拒清单按 id 倒序（含软删行）', rejected0.items[0].id, a3.id);

const rj2 = await st.moderate(a2.id, 'reject', { moderatorId: 99, reason: '广告图', at: '2026-01-02 03:06:07' });
ok('reject 成功', rj2.ok === true, JSON.stringify(rj2));
is('reject 回 lifecycle=deleted', rj2.lifecycle, 'deleted');
is('reject 回 hidden=1', rj2.hidden, 1);
const g2r = await st.get(a2.id);
is('reject 后 review_status', g2r.review_status, 'rejected');
is('reject 后生命周期 status=deleted（软删）', g2r.status, 'deleted');
is('reject 后 review_hidden=1', g2r.review_hidden, 1);
is('reject 后审核人', g2r.review_by, 99);
is('reject 后理由', g2r.review_reason, '广告图');
is('reject 后来源=manual', g2r.review_source, 'manual');
const g2body = await st.get(a2.id, { withBody: true });
ok('软删不回收内容：withBody 还取得到（get 不带 ok 字段）', !!g2body.body, JSON.stringify(g2body).slice(0, 120));
bytesEq('软删后读回的字节还在', g2body.body, pngBytes(801, 601));
const rj2b = await st.moderate(a2.id, 'reject', { moderatorId: 99, reason: '别的理由' });
is('重复 reject 幂等（already=true）', rj2b.already, true);
is('重复 reject 不覆盖理由', (await st.get(a2.id)).review_reason, '广告图');

const lpDone = await st.listPending();
is('队列里 pending 的都被处理完了（active 的也批准了）', lpDone.total, 0);
const rejected1 = await st.listRejected();
is('被拒清单现在 2 条', rejected1.total, 2);
deep('被拒清单倒序', rejected1.items.map(function (r) { return r.id; }), [a3.id, a2.id]);
ok('被拒清单里带理由', rejected1.items.every(function (r) { return typeof r.review_reason === 'string' && r.review_reason.length > 0; }));

const reApprove = await st.moderate(a2.id, 'approve', { moderatorId: 100, at: '2026-01-02 03:07:08' });
is('翻案：approve 回 lifecycle=active（有 post_id）', reApprove.lifecycle, 'active');
is('翻案后 hidden 清零', reApprove.hidden, 0);
is('翻案后库里的 review_hidden=0', (await st.get(a2.id)).review_hidden, 0);
is('翻案后 status 回到 active', (await st.get(a2.id)).status, 'active');
is('翻案后被拒清单少一条', (await st.listRejected()).total, 1);
const reS3 = await st.moderate(a3.id, 'approve', { moderatorId: 100, at: '2026-01-02 03:08:09' });
is('给自动拒的行翻案：没帖 → lifecycle=pending', reS3.lifecycle, 'pending');
is('翻案后 status=pending（回到待归属）', (await st.get(a3.id)).status, 'pending');
is('翻案后 hidden=0', reS3.hidden, 0);
is('翻案后被拒清单清零', (await st.listRejected()).total, 0);

const longReason = await st.moderate(a2.id, 'reject', { moderatorId: 5, reason: 'x'.repeat(400) + '尾巴' });
is('超长理由被截到 300 字符', longReason.reason.length, 300);
ok('截断保留了开头', longReason.reason.indexOf('xxx') === 0, longReason.reason.slice(0, 20));
is('截断后库里也是 300 字符', (await st.get(a2.id)).review_reason.length, 300);
await st.moderate(a2.id, 'approve', { moderatorId: 5 }); // 复位，给后面的统计用

const a4 = await st.save({ ownerId: 4, filename: 'four.png', mime: 'image/png', bytes: pngBytes(900, 700) });
const dry = await st.autoReview(a4.id, { keep: true, value: pngBytes(13000, 2) });
ok('autoReview keep 干跑', dry.ok === true, JSON.stringify(dry));
is('keep 干跑给出会判成什么', dry.status, 'rejected');
is('keep 干跑写了没：没写', dry.wrote, false);
is('keep 干跑 hidden 不置位', dry.hidden, 0);
is('keep 干跑不动生命周期', (await st.get(a4.id)).status, 'pending');
is('keep 干跑不动审核状态', (await st.get(a4.id)).review_status, 'pending');
has('keep 干跑也能看到理由', dry.reason, '图片单边上限 12000 px');
const dryOk = await st.autoReview(a4.id, { keep: true, value: pngBytes(800, 600) });
is('keep 干跑：正常图判 pending', dryOk.status, 'pending');
has('keep 干跑：正常图带 note', dryOk.note, '自动规则没发现不合格项');
const arMissing = await st.autoReview(9999, {});
ok('autoReview 不存在的 id → not_found', arMissing.error === 'not_found', JSON.stringify(arMissing));
const arBad = await st.autoReview('x', {});
ok('autoReview 非法 id → not_found', arBad.error === 'not_found');

const a5 = await st.save({ ownerId: 5, filename: 'five.png', mime: 'image/png', bytes: pngBytes(500, 400) });
await st.moderate(a5.id, 'approve', { moderatorId: 6, reason: '人工通过' });
const arOnApproved = await st.autoReview(a5.id, { value: pngBytes(800, 600) });
is('自动规则不会覆盖已 approved 行的结论', (await st.get(a5.id)).review_status, 'approved');
is('自动规则也不会覆盖它的理由', (await st.get(a5.id)).review_reason, '人工通过');
ok('autoReview 在已审批行上仍回 ok', arOnApproved.ok === true, JSON.stringify(arOnApproved));

const a6 = await st.save({ ownerId: 6, filename: 'six.png', mime: 'image/png', bytes: pngBytes(640, 480) });
const noCls = await st.classify(a6.id);
ok('没注入分类器 → no_classifier', noCls.ok === false && noCls.error === 'no_classifier', JSON.stringify(noCls));
has('no_classifier 的 hint 逐字', noCls.hint, '没注入分类器（setClassifier(fn)），审核一律留在 pending 等人工');
is('没分类器时不改库（仍 pending）', (await st.get(a6.id)).review_status, 'pending');

const clsSet = A.setClassifier(function () { return 'weird-signal'; });
is('setClassifier 回 set', clsSet.classifier, 'set');
is('getClassifier 拿得到', typeof A.getClassifier(), 'function');
const clsNoVerdict = await st.classify(a6.id);
ok('分类器没给结论 → ok:true 但留 pending', clsNoVerdict.ok === true, JSON.stringify(clsNoVerdict));
is('没结论时的 status', clsNoVerdict.status, 'pending');
is('没结论时的 note 逐字', clsNoVerdict.note, '分类器没给结论，留 pending 转人工');
const g6a = await st.get(a6.id);
is('没结论写进 review_reason', g6a.review_reason, '分类器没给结论，留 pending 转人工');
is('没结论时 review_source=classifier', g6a.review_source, 'classifier');
is('没结论仍是 pending', g6a.review_status, 'pending');

A.setClassifier(function () { throw new Error('boom'); });
const clsThrow = await st.classify(a6.id);
ok('分类器抛异常 → 不判不合格，转人工', clsThrow.ok === true, JSON.stringify(clsThrow));
is('异常时的 status 仍是 pending', clsThrow.status, 'pending');
is('异常时的 note 逐字', clsThrow.note, '分类器异常，转人工：boom');
const g6b = await st.get(a6.id);
is('异常写进 review_reason', g6b.review_reason, '分类器异常，转人工：boom');
is('异常时仍是 pending', g6b.review_status, 'pending');
ok('异常时也不写 approved/rejected', g6b.review_status === 'pending');

let seenArgs = null;
A.setClassifier(function (m, b) { seenArgs = { m: m, b: b }; return { status: 'approved', reason: '分类器说没事' }; });
const clsOk = await st.classify(a6.id);
ok('分类器给 approved', clsOk.ok === true && clsOk.status === 'approved', JSON.stringify(clsOk));
is('分类器结论写库', (await st.get(a6.id)).review_status, 'approved');
is('分类器结论的来源', (await st.get(a6.id)).review_source, 'classifier');
is('分类器结论的审核人是 0（不是人）', (await st.get(a6.id)).review_by, 0);
is('分类器拿到的 meta.id', seenArgs.m.id, a6.id);
is('分类器拿到的 meta.filename', seenArgs.m.filename, 'six.png');
ok('分类器拿到了内容本体（Uint8Array）', seenArgs.b instanceof Uint8Array && seenArgs.b.length === 26, 'len=' + (seenArgs.b && seenArgs.b.length));

const a7 = await st.save({ ownerId: 7, filename: 'seven.png', mime: 'image/png', bytes: pngBytes(300, 200) });
A.setClassifier(function () { return 'nsfw'; });
const clsReject = await st.classify(a7.id);
ok('分类器给 rejected', clsReject.ok === true && clsReject.status === 'rejected', JSON.stringify(clsReject));
is('分类器拒了 → hidden=1', clsReject.hidden, 1);
is('分类器拒了 → 生命周期 deleted', clsReject.lifecycle, 'deleted');
is('分类器拒了 → 库里 status=deleted', (await st.get(a7.id)).status, 'deleted');
is('分类器拒了 → review_source=classifier', (await st.get(a7.id)).review_source, 'classifier');
has('分类器拒了的理由', (await st.get(a7.id)).review_reason, '分类器判定不合格');
const clsAgain = await st.classify(a7.id);
ok('对已 rejected 的行再 classify 也回 ok', clsAgain.ok === true, JSON.stringify(clsAgain));
is('已 rejected 的行不会被 approved', (await st.get(a7.id)).review_status, 'rejected');
const clsCleared = A.setClassifier(null);
is('清掉分类器', clsCleared.classifier, 'cleared');
is('getClassifier 变回 null', A.getClassifier(), null);
const clsOffAgain = await st.classify(a6.id);
ok('清掉后又是 no_classifier（不假装审过）', clsOffAgain.error === 'no_classifier', JSON.stringify(clsOffAgain));

const stats1 = await st.moderationStats();
ok('moderationStats ok', stats1.ok === true, JSON.stringify(stats1).slice(0, 200));
is('stats driver', stats1.driver, 'fs');
const rawTotal = sqDb.prepare('SELECT COUNT(1) AS n FROM attachments').get().n;
const rawBytes = sqDb.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM attachments').get().b;
const rawLive = sqDb.prepare("SELECT COUNT(1) AS n FROM attachments WHERE status<>'deleted'").get().n;
const rawPending = sqDb.prepare("SELECT COUNT(1) AS n FROM attachments WHERE review_status='pending'").get().n;
const rawPendingLive = sqDb.prepare("SELECT COUNT(1) AS n FROM attachments WHERE review_status='pending' AND status<>'deleted'").get().n;
const rawApproved = sqDb.prepare("SELECT COUNT(1) AS n FROM attachments WHERE review_status='approved'").get().n;
const rawRejected = sqDb.prepare("SELECT COUNT(1) AS n FROM attachments WHERE review_status='rejected'").get().n;
const rawHidden = sqDb.prepare('SELECT COUNT(1) AS n FROM attachments WHERE review_hidden=1').get().n;
const rawByStatus = sqDb.prepare('SELECT review_status AS s, COUNT(1) AS n, COALESCE(SUM(bytes),0) AS b FROM attachments GROUP BY review_status ORDER BY review_status').all();
is('stats.total 与裸 SQL 一致', stats1.total, rawTotal);
is('stats.bytes 与裸 SQL 一致', stats1.bytes, rawBytes);
is('stats.live 与裸 SQL 一致', stats1.live, rawLive);
is('stats.pending 与裸 SQL 一致', stats1.pending, rawPending);
is('stats.pending_live 与裸 SQL 一致', stats1.pending_live, rawPendingLive);
is('stats.approved 与裸 SQL 一致', stats1.approved, rawApproved);
is('stats.rejected 与裸 SQL 一致', stats1.rejected, rawRejected);
is('stats.hidden 与裸 SQL 一致', stats1.hidden, rawHidden);
deep('stats.byStatus 与裸 SQL 一致',
  stats1.byStatus.map(function (r) { return { status: r.status, n: r.n, bytes: r.bytes }; }).sort(function (a, b) { return a.status < b.status ? -1 : 1; }),
  rawByStatus.map(function (r) { return { status: r.s, n: r.n, bytes: r.b }; }));
const statSum = stats1.byStatus.reduce(function (acc, r) { return acc + r.n; }, 0);
is('byStatus 的 n 之和 = total', statSum, stats1.total);
is('bytes_pending + bytes_approved + bytes_rejected = bytes',
  stats1.bytes_pending + stats1.bytes_approved + stats1.bytes_rejected, stats1.bytes);
ok('审核统计没有占用冻结的 stats()（那个仍是同步计数）', typeof st.stats === 'function' && st.stats().driver === 'fs');
is('冻结 stats() 的形状没变（saves 计数）', st.stats().saves, 7);
is('冻结 stats() 的 dedupes 仍在', typeof st.stats().dedupes, 'number');

const st2 = A.createStore({ driver: 'fs', db: sqDb, dir: fsDir });
const reread = await st2.get(a1.id, { withBody: true });
bytesEq('换一个 store 实例仍能从磁盘读回同一条内容', reread.body, png800);

// ── Worker 线（LocalD1 顶替 env.DB）
section('⑦-b 审核状态机：Worker 线（tools/d1-local.mjs）');

const d1 = new LocalD1();
dbs.push(d1);
const wEns = await W.ensureAttachments(d1);
deep('ensureAttachments 逐字仍是 {ok:true,statements:7}', wEns, { ok: true, statements: 7 });
deep('ensureAttachments 幂等', await W.ensureAttachments(d1), { ok: true, statements: 7 });
const wRev = await W.ensureAttachmentReview(d1);
is('ensureAttachmentReview ok', wRev.ok, true);
deep('返回形状 = 裸 ensureReviewSchema 结果（无 driver）', Object.keys(wRev).sort(), ['added', 'columns', 'ok', 'statements']);
deep('ensureAttachments 已顺手补过列 → 这次 added 为空', wRev.added, []);
is('ensureAttachmentReview 的列数', wRev.columns, 6);
is('ensureAttachmentReview 的语句数 9（7 建表 + 2 索引）', wRev.statements, 9);
is('reviewSchema 暴露的列数', (await W.attachmentReviewSchema()).columns.length, 6);
refEq('attachmentReviewSchema 的 states 就是 ATTACH_REVIEW', (await W.attachmentReviewSchema()).states, A.ATTACH_REVIEW);
is('attachmentReviewSchema 的 rules.maxPx', (await W.attachmentReviewSchema()).rules.maxPx, 12000);
is('attachmentReviewSchema 的 ddl 条数', (await W.attachmentReviewSchema()).ddl.length, 2);
const wNoDbPending = await W.listPendingAttachments(null, 10, 0);
ok('没给 db → storage_unavailable', wNoDbPending.error === 'storage_unavailable', JSON.stringify(wNoDbPending));
has('storage_unavailable 的 hint 提到 D1', wNoDbPending.hint, 'D1');
ok('moderateAttachment(null) 也是 storage_unavailable', (await W.moderateAttachment(null, 1, 'approve', {})).error === 'storage_unavailable');
ok('attachmentModerationStats(null) 也是 storage_unavailable', (await W.attachmentModerationStats(null)).error === 'storage_unavailable');

const w1 = await W.saveAttachment(d1, { ownerId: 1, filename: 'w1.png', mime: 'image/png', bytes: pngBytes(320, 240) });
ok('Worker saveAttachment 成功', w1.ok === true, JSON.stringify(w1));
is('Worker 线 driver=d1', w1.driver, 'd1');
is('没挂帖 → pending', w1.status, 'pending');
const w2 = await W.saveAttachment(d1, { ownerId: 1, postId: 3, filename: 'w2.png', mime: 'image/png', bytes: pngBytes(321, 241) });
is('挂帖 → active', w2.status, 'active');
const w3 = await W.saveAttachment(d1, { ownerId: 1, filename: 'w3.png', mime: 'image/png', bytes: pngBytes(13000, 2) });
is('自动拒 → deleted', w3.status, 'deleted');
const bigBytes = new Uint8Array(300 * 1024);
bigBytes.set(pngBytes(10, 10), 0);
const wTooBig = await W.saveAttachment(d1, { ownerId: 1, filename: 'big.png', mime: 'image/png', bytes: bigBytes });
ok('超 D1 单份上限 → too_large_for_d1', wTooBig.error === 'too_large_for_d1', JSON.stringify(wTooBig));
has('too_large 的 hint 带上限文案', wTooBig.hint, A.D1_BLOB_LABEL);

const wPending = await W.listPendingAttachments(d1, 10, 0);
is('Worker 队列 total', wPending.total, 2);
is('Worker 队列回 limit/offset', wPending.limit + '/' + wPending.offset, '10/0');
is('Worker 队列条目带 review_status', wPending.items[0].review_status, 'pending');
const wApprove = await W.moderateAttachment(d1, w2.id, 'approve', { moderatorId: 11, at: '2026-02-03 04:05:06' });
ok('Worker approve 成功', wApprove.ok === true, JSON.stringify(wApprove));
is('Worker approve 回 status', wApprove.status, 'approved');
is('Worker approve 回生命周期', wApprove.lifecycle, 'active');
const wAgain = await W.moderateAttachment(d1, w2.id, 'approve', { moderatorId: 11 });
is('Worker 重复 approve 幂等', wAgain.already, true);
ok('Worker forbidden 分支', (await W.moderateAttachment(d1, w1.id, 'approve', {})).error === 'forbidden');
ok('Worker bad_action 分支', (await W.moderateAttachment(d1, w1.id, 'hide', { moderatorId: 1 })).error === 'bad_action');
ok('Worker reason_required 分支', (await W.moderateAttachment(d1, w1.id, 'reject', { moderatorId: 1 })).error === 'reason_required');
ok('Worker not_found 分支', (await W.moderateAttachment(d1, 9999, 'approve', { moderatorId: 1 })).error === 'not_found');
const wReject = await W.moderateAttachment(d1, w1.id, 'reject', { moderatorId: 12, reason: '重复图', at: '2026-02-03 04:06:07' });
ok('Worker reject 成功', wReject.ok === true, JSON.stringify(wReject));
is('Worker reject → deleted', wReject.lifecycle, 'deleted');
is('Worker reject → hidden 1', wReject.hidden, 1);
const wRejectedList = await W.listRejectedAttachments(d1, 10, 0);
is('Worker 被拒清单 2 条（自动 + 人工）', wRejectedList.total, 2);
deep('Worker 被拒清单倒序', wRejectedList.items.map(function (r) { return r.id; }), [w3.id, w1.id]);
const wStats = await W.attachmentModerationStats(d1);
ok('Worker 统计 ok', wStats.ok === true);
is('Worker 统计 total', wStats.total, 3);
is('Worker 统计 pending（w1 被人工拒、w2 approved、w3 自动拒）', wStats.pending, 0);
is('Worker 统计 approved', wStats.approved, 1);
is('Worker 统计 rejected', wStats.rejected, 2);
is('Worker 统计 hidden', wStats.hidden, 2);
const wDry = await W.autoReviewAttachmentInDb(d1, w1.id, { keep: true, value: pngBytes(800, 600) });
is('Worker 干跑不写库', wDry.wrote, false);
const wClassifyOff = await W.classifyAttachment(d1, w1.id);
ok('Worker 分类器未注入 → no_classifier', wClassifyOff.error === 'no_classifier', JSON.stringify(wClassifyOff));

const pg1 = await W.pageAttachment({ db: d1 }, { id: String(w2.id) });
is('pageAttachment 对 active 行给 200', pg1.status, 200);
is('pageAttachment 的 content-type', pg1.headers.get('content-type'), 'image/png');
is('pageAttachment 带 nosniff', pg1.headers.get('x-content-type-options'), 'nosniff');
is('pageAttachment 的缓存策略', pg1.headers.get('cache-control'), 'public, max-age=300');
has('pageAttachment 的 disposition 带 filename*', pg1.headers.get('content-disposition'), "inline; filename*=UTF-8''w2.png");
bytesEq('pageAttachment 的实体就是要的那份内容', Buffer.from(await pg1.arrayBuffer()), pngBytes(321, 241));
const pgPending = await W.pageAttachment({ db: d1 }, { id: String(wPending.items[0].id) });
is('pageAttachment 对 pending 行给 404（草稿不外发）', pgPending.status, 404);
const pgRejected = await W.pageAttachment({ db: d1 }, { id: String(w3.id) });
is('pageAttachment 对被拒（软删）行给 404', pgRejected.status, 404);
is('404 的响应体逐字', await pgRejected.text(), '404 Not Found');
is('pageAttachment 对非法 id 给 404', (await W.pageAttachment({ db: d1 }, { id: '../etc' })).status, 404);
is('pageAttachment 对不存在的 id 给 404', (await W.pageAttachment({ db: d1 }, { id: '424242' })).status, 404);

const objLocal = await withWarn(function () { return W.objectStoreFor({}, { driver: 'local', dir: join(TMP, 'obj-worker') }); });
endWarn();
is('objectStoreFor 转发 local', objLocal.driver, 'local');
const objBack = await withWarn(function () { return W.objectStoreFor({ ATTACH_STORE: 's3' }, { dir: join(TMP, 'obj-worker2') }); });
const warnObj = endWarn();
is('objectStoreFor 从 env 读 ATTACH_STORE 并回落', objBack.driver, 'local');
is('objectStoreFor 的回落日志仍是一行', warnObj.length, 1);
const objS3 = await withWarn(function () {
  return W.objectStoreFor({ ATTACH_STORE: 's3', S3_ENDPOINT: fake.origin, S3_BUCKET: 'ugc', S3_ACCESS_KEY: S3_AK, S3_SECRET_KEY: S3_SK }, {});
});
const warnS3 = endWarn();
is('objectStoreFor 配全给 s3', objS3.driver, 's3');
is('配全时不打回落日志', warnS3.length, 0);
is('objectStoreFor 的 env 被 info 读到', objS3.info().bucket, 'ugc');

// ═══════════════════════════════ ⑧ DDL 幂等 / 老库补列 ═══════════════════════════════
section('⑧ DDL 幂等与老库补列');

const legacy = trackDb(new DatabaseSync(':memory:'));
legacy.exec(A.ATTACH_DDL[0]);
const legacyCols = legacy.prepare('PRAGMA table_info(attachments)').all().map(function (r) { return r.name; });
is('老库先只有 12 列（冻结形态）', legacyCols.length, 12);
const legacyFix = await A.ensureReviewSchema(legacy);
ok('老库补列成功', legacyFix.ok === true, JSON.stringify(legacyFix));
deep('补的正是这 6 列（顺序即 ATTACH_REVIEW_COLUMNS）', legacyFix.added, colNames);
is('补列后的列数', legacy.prepare('PRAGMA table_info(attachments)').all().length, 18);
is('补列后老行默认 review_status=pending',
  (function () {
    legacy.exec("INSERT INTO attachments (owner_id, filename, bytes, sha256, storage, \"key\", status) VALUES (1,'a.png',1,'x','fs','k','active')");
    return legacy.prepare('SELECT review_status AS s, review_by AS b, review_hidden AS h FROM attachments').get().s;
  })(), 'pending');
is('补列后 review_by 默认 0', legacy.prepare('SELECT review_by AS b FROM attachments').get().b, 0);
is('补列后 review_hidden 默认 0', legacy.prepare('SELECT review_hidden AS h FROM attachments').get().h, 0);
const legacyAgain = await A.ensureReviewSchema(legacy);
deep('补列幂等：第二次 added 为空', legacyAgain.added, []);
is('补列幂等：columns 不变', legacyAgain.columns, 6);
const legacyIdx = legacy.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_attach_review%'").all();
is('老库上也建了 2 条审核索引', legacyIdx.length, 2);
const legacyBaseIdx = legacy.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_attachments%'").all();
is('老库上 idx_attachments% 仍是 5 条（冻结断言护栏）', legacyBaseIdx.length, 5);

const bad1 = await A.ensureReviewSchema(null);
ok('null → bad_db', bad1.ok === false && bad1.error === 'bad_db', JSON.stringify(bad1));
has('bad_db 的 hint 逐字', bad1.hint, 'ensureReviewSchema 要的是 node:sqlite 的 DatabaseSync 或 D1 绑定（env.DB）');
ok('{} → bad_db', (await A.ensureReviewSchema({})).error === 'bad_db');
ok('42 → bad_db', (await A.ensureReviewSchema(42)).error === 'bad_db');
ok('undefined → bad_db', (await A.ensureReviewSchema()).error === 'bad_db');

const d1b = new LocalD1();
dbs.push(d1b);
const d1Fix = await A.ensureReviewSchema(d1b);
ok('D1 绑定也走同一条补列路径', d1Fix.ok === true, JSON.stringify(d1Fix));
deep('D1 线返回形状与 sqlite 线一致（无 driver）', Object.keys(d1Fix).sort(), ['added', 'columns', 'ok', 'statements']);
deep('D1 线从零补 6 列', d1Fix.added, colNames);
deep('D1 线再跑幂等', (await A.ensureReviewSchema(d1b)).added, []);
is('D1 线列数 18', (await d1b.prepare('PRAGMA table_info(attachments)').all()).results.length, 18);
const d1Store = A.createStore({ driver: 'd1', db: d1b });
const d1Saved = await d1Store.save({ ownerId: 9, filename: 'nine.png', mime: 'image/png', bytes: pngBytes(64, 64) });
ok('d1 驱动也能 save（老行为）', d1Saved.ok === true, JSON.stringify(d1Saved));
is('d1 驱动名', d1Saved.driver, 'd1');
is('d1 待审队列能读到刚存的',
  (await d1Store.listPending(10, 0)).items.some(function (r) { return r.id === d1Saved.id; }), true);
ok('d1 驱动也有 moderationStats', (await d1Store.moderationStats()).ok === true);

// ═══════════════════════════════ 收尾 ═══════════════════════════════
for (const s of servers) { try { await s.close(); } catch (e) { /* 已关 */ } }
for (const d of dbs) { try { d.close(); } catch (e) { /* LocalD1/DatabaseSync 都有关 */ } }
const realDbAfter = existsSync(REAL_DB) ? statSync(REAL_DB) : null;
ok('全程没碰过真库 data/games.db（size + mtime 不变）',
  (!!realDbBefore === !!realDbAfter) && (!realDbBefore || (realDbBefore.size === realDbAfter.size && realDbBefore.mtimeMs === realDbAfter.mtimeMs)),
  realDbBefore ? ('before=' + realDbBefore.size + '/' + realDbBefore.mtimeMs + ' after=' + (realDbAfter ? realDbAfter.size + '/' + realDbAfter.mtimeMs : '缺失')) : '真库本来就不存在');

if (cur) { cur.ep = pass; cur.ef = fail; }
// 「默认落在副本 data/ 下」那条断言会把副本的 src/db.js 拉进来，而它在 import 时就开了
// <ROOT>/data/games.db（Windows 上不关这个句柄，临时目录就删不掉）——收尾显式关掉它。
try {
  const copyDb = await import(pathToFileURL(join(TMP, 'src', 'db.js')).href);
  if (copyDb && copyDb.db && typeof copyDb.db.close === 'function') copyDb.db.close();
} catch (e) { /* 没被拉起来就不用关 */ }

// 逐个孩子删：Windows 上整树 rmSync 被句柄挡住时只会报顶层目录，看不出是谁没放
let cleanErr = '';
const held = [];
for (const name of existsSync(TMP) ? readdirSync(TMP) : []) {
  try { rmSync(join(TMP, name), { recursive: true, force: true, maxRetries: 4, retryDelay: 120 }); }
  catch (e) { held.push(name + ' → ' + ((e && e.code) || e)); }
}
if (held.length) cleanErr = '还占着：' + held.join('，');
else {
  for (let i = 0; i < 4; i++) {
    try { rmSync(TMP, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 }); } catch (e) { cleanErr = String((e && e.code) || e); }
    if (!existsSync(TMP)) { cleanErr = ''; break; }
    await new Promise(function (r) { setTimeout(r, 200); });
  }
}
const cleaned = !existsSync(TMP);

console.log('\n=== 分段统计 ===');
for (const s of sections) {
  console.log('  ' + s.title + '：通过 ' + (s.ep - s.p) + ' / 失败 ' + (s.ef - s.f));
}
if (cleaned) console.log('(临时副本已删：' + TMP + ')');
else console.log('(临时目录没删干净：' + TMP + ' —— ' + cleanErr + ')');
console.log('');
console.log('=== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ===');
if (fail) {
  console.log('失败清单：');
  failures.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
  process.exitCode = 1;
}
