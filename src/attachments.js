/**
 * 论坛附件：白名单与校验（扩展名 + MIME + 魔数 + 文件名清洗）＋ 存储适配层（fs / D1 两个驱动）。
 *
 * 为什么单独一层：论坛附件在 Express 线要落到本地磁盘（data/attachments/），在 Worker 线只能落 D1
 * （D1 单个值上限约 1MB，所以超过 256 KB 的内容直接给一句人话「太大了」）。校验规则两条线共用这一份，
 * 落盘方式靠 driver 切换；缺驱动时返回 { error: 'storage_unavailable', hint }，调用方退回到
 * 「不落附件、只提示用户」，而不是把整个发帖请求打崩（退化的思路对齐 src/rank-cache.js）。
 *
 * 本文件在 import 期**不做任何 node: 静态导入**：node:fs 与 ../db.js（内含 node:sqlite）都用
 * 「变量拼模块名」的动态 import 惰性加载。原因是 worker/data.js 会 import ../src/upload.js，
 * 而 upload.js 又 import 本文件——一旦这里静态导入 node:sqlite，Worker 打包器就会顺着依赖图去解析它。
 * 同理，本文件只用 globalThis.crypto.subtle 算 sha256、自己实现 base64，不依赖 Buffer（Workers 没有）。
 *
 * 方法约定（**全部 async**，因为 D1 只能异步）：
 *   createStore({driver:'fs'|'d1', ...}) → store 或 { error:'storage_unavailable', hint }
 *   store.save({ownerId, threadId, postId, filename, mime, bytes}) → { ok, id, url, key, sha256, bytes, status }
 *   store.get(id, {withBody})                    → 元数据行（+ body:Uint8Array）或 { error }
 *   store.attach(id, {threadId, postId, ownerId})→ { ok }（pending 认领成 active）
 *   store.remove(id, ownerId, {purge, force})    → 软删 { ok, purged }；ownerId 不符给 { error:'forbidden' }
 *   store.listByPost(postId) / store.listByThread(threadId) → { ok, items:[行], total }
 *   store.gcOrphans(now)                         → 删 pending 超 24h 的孤儿 { ok, removed, purged, cutoff }
 *   store.stats()                                → { driver, saves, bytes, dedupes, purged, gcRemoved }
 * 校验失败一律返回 { error: '<中文人话>' }（对齐 src/upload.js 的 validateHtmlUpload），
 * 存储层失败返回带短码的 { error: 'storage_unavailable' | 'too_large_for_d1' | 'not_found' | ... , hint }。
 *
 * 主理人接线（本文件不碰 server.js / worker/app.js，只留接口）：
 *   Express：建一次全局 store（const store = createStore({ driver: 'fs' })，db 缺省就是 ../db.js 的库）
 *            并加一条 GET /ugc/a/:id —— 它是两段路径，和现有 app.get('/ugc/:file')（单段 .html）不冲突；
 *            处理器里 await store.get(id, { withBody:true })，status !== 'active' 就 404，否则
 *            res.type(row.mime).set('Cache-Control','public, max-age=300').send(Buffer.from(row.body))。
 *            POST 侧（发帖 / 编辑）从 formFromMultipart 的 file.bytes 拿原始字节，交给 store.save()。
 *   Workers：worker/app.js 的 ROUTES 里加一条 { m:'GET', p:'/ugc/a/:id', fn: pageAttachment }，
 *            处理器 await getAttachment(ctx.db, id, { withBody:true })（见 worker/attachments.js）。
 */

// ============================== 一、常量与规则表 ==============================

/** 附件对外 URL 前缀：/ugc/a/<id>（形状落在既有的 /ugc/ 静态前缀里，主机判定 FORUM_SHARED 不用改） */
export const ATTACH_PREFIX = '/ugc/a/';

/** 附件生命周期：pending（已上传未挂帖）→ active（随帖发布）→ deleted（软删，行留着、内容可回收） */
export const ATTACH_STATUS = { PENDING: 'pending', ACTIVE: 'active', DELETED: 'deleted' };

/** pending 孤儿（传了文件却没发成帖）保留多久后回收 */
export const ATTACH_ORPHAN_MS = 24 * 60 * 60 * 1000;

/** 文件名清洗后的长度上限（含扩展名） */
export const FILENAME_MAX = 64;

/** D1 驱动单份内容的原始字节上限：base64 后约 341KB，留足 D1 单值 1MB 的余量 */
export const D1_BLOB_MAX = 256 * 1024;

/** D1 上限的可读文案 */
export const D1_BLOB_LABEL = '256 KB';

/** 单个附件（任何类型）的绝对上限：压缩包那一档 */
export const ATTACH_MAX = 4 * 1024 * 1024;

/** 绝对上限的可读文案 */
export const ATTACH_MAX_LABEL = '4 MB';

/**
 * 三类附件的规则。max 是这一类单个文件的上限；真正的「声明类型」白名单在 ATTACH_EXT.mime 里：
 * application/octet-stream 视为「浏览器没认出类型」，任何一类都放行（把关交给魔数）。
 */
export const ATTACH_KINDS = {
  image: {
    key: 'image',
    label: '图片',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    max: 2 * 1024 * 1024,
    maxLabel: '2 MB'
  },
  text: {
    key: 'text',
    label: '文本',
    exts: ['txt', 'md', 'csv', 'log'],
    max: 256 * 1024,
    maxLabel: '256 KB'
  },
  zip: {
    key: 'zip',
    label: '压缩包',
    exts: ['zip'],
    max: 4 * 1024 * 1024,
    maxLabel: '4 MB'
  }
};

/**
 * 扩展名 → { kind, magic, mime }。magic 是该扩展名**必须**嗅到的内容类型（null = 文本，不嗅魔数，
 * 但也因此必须排除掉所有已知的二进制签名）；mime 是允许声明的类型（等价写法都列上）。
 */
export const ATTACH_EXT = {
  png: { kind: 'image', magic: 'png', mime: ['image/png'] },
  jpg: { kind: 'image', magic: 'jpeg', mime: ['image/jpeg'] },
  jpeg: { kind: 'image', magic: 'jpeg', mime: ['image/jpeg'] },
  gif: { kind: 'image', magic: 'gif', mime: ['image/gif'] },
  webp: { kind: 'image', magic: 'webp', mime: ['image/webp'] },
  txt: { kind: 'text', magic: null, mime: ['text/plain'] },
  md: { kind: 'text', magic: null, mime: ['text/markdown', 'text/plain', 'text/x-markdown'] },
  csv: { kind: 'text', magic: null, mime: ['text/csv', 'text/plain', 'application/csv'] },
  log: { kind: 'text', magic: null, mime: ['text/plain', 'text/x-log'] },
  zip: { kind: 'zip', magic: 'zip', mime: ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'] }
};

/** 允许声明的 MIME 清单（去重；表单 accept 与文案用） */
export const ATTACH_MIME_LIST = Object.keys(ATTACH_EXT)
  .reduce(function (a, k) {
    ATTACH_EXT[k].mime.forEach(function (m) {
      if (a.indexOf(m) < 0) a.push(m);
    });
    return a;
  }, []);

/** 文案用的完整扩展名清单（按类型分组，如 ['.png', '.jpg', ...]） */
export const ATTACH_EXT_LIST = Object.keys(ATTACH_KINDS)
  .map(function (k) {
    return ATTACH_KINDS[k].exts.map(function (e) {
      return '.' + e;
    });
  })
  .reduce(function (a, b) {
    return a.concat(b);
  }, []);

/** 魔数签名：至少覆盖 PNG / JPEG / GIF / WebP / ZIP，扩展名与它对不上就直接拒 */
const SIGNATURES = [
  { kind: 'png', offset: 0, sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'jpeg', offset: 0, sig: [0xff, 0xd8, 0xff] },
  { kind: 'gif', offset: 0, sig: [0x47, 0x49, 0x46, 0x38] }, // 'GIF8'（87a / 89a 都认）
  { kind: 'zip', offset: 0, sig: [0x50, 0x4b, 0x03, 0x04] }, // 普通压缩包：本地文件头
  { kind: 'zip', offset: 0, sig: [0x50, 0x4b, 0x05, 0x06] }, // 空压缩包：只有中央目录结尾
  { kind: 'zip', offset: 0, sig: [0x50, 0x4b, 0x07, 0x08] }, // 分卷压缩包
  { kind: 'pdf', offset: 0, sig: [0x25, 0x50, 0x44, 0x46] }, // '%PDF'：只用于「别把 PDF 当文本传」
  { kind: 'rar', offset: 0, sig: [0x52, 0x61, 0x72, 0x21] }, // 'Rar!'
  { kind: 'gzip', offset: 0, sig: [0x1f, 0x8b] } // gzip
];

/** 嗅探结果的中文名（报错文案用） */
const KIND_LABEL = { png: 'PNG 图片', jpeg: 'JPEG 图片', gif: 'GIF 图片', webp: 'WebP 图片', zip: 'ZIP 压缩包', pdf: 'PDF 文件', rar: 'RAR 压缩包', gzip: 'gzip 压缩包' };

/** 内容存在哪：fs = 磁盘相对路径，d1 = attachments_blob 的行号 */
export const ATTACH_STORAGE = { FS: 'fs', D1: 'd1' };

const HEX = '0123456789abcdef';
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ============================== 二、基础工具（零依赖，两条线都能跑） ==============================

/** 任何「字节来源」→ Uint8Array：字符串按 UTF-8 编码，ArrayBuffer / 视图 / 普通数组都收 */
export function toBytes(value) {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new TextEncoder().encode(String(value));
}

/** 字节 → base64（自己实现：Workers 没有 Buffer，atob/btoa 两条线也不保证同款行为） */
export function bytesToB64(value) {
  const b = toBytes(value);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i];
    const has1 = i + 1 < b.length;
    const has2 = i + 2 < b.length;
    const b1 = has1 ? b[i + 1] : 0;
    const b2 = has2 ? b[i + 2] : 0;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

/** base64 → 字节；非法字符跳过（写进去的是自己编码的串，容错只为坏数据不炸） */
export function b64ToBytes(text) {
  const s = String(text || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64_CHARS.indexOf(s[i]);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** sha256 十六进制串：走 globalThis.crypto.subtle，两条线都有，零 import（内容寻址的去重键） */
export async function sha256Hex(value) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('当前运行时没有 WebCrypto（crypto.subtle），算不了 sha256');
  const digest = await subtle.digest('SHA-256', toBytes(value));
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) out += HEX[view[i] >> 4] + HEX[view[i] & 0x0f];
  return out;
}

/** 与 SQLite datetime('now','localtime') 同格式的本地时间串（created_at 存文本，比较即字典序） */
export function localStamp(ms) {
  const d = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

/** 可读体积，报错文案用 */
export function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

/** 取小写扩展名（不带点）；没有扩展名给 '' */
export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name == null ? '' : name));
  return m ? m[1].toLowerCase() : '';
}

/** 按码点截断但保留扩展名（'很长很长.md' → 前 61 个字符 + '.md'） */
function truncateKeepExt(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 ? s.slice(dot) : '';
  const keepExt = !!ext && Array.from(ext).length <= 12;
  const extLen = keepExt ? Array.from(ext).length : 0;
  const stem = keepExt ? Array.from(s.slice(0, dot)) : chars;
  return stem.slice(0, Math.max(1, max - extLen)).join('') + (keepExt ? ext : '');
}

/**
 * 文件名清洗：去目录（'../' / 'a\\b\\' / 'D:/x/' 一律只留最后一段）、去控制字符、去 Windows 非法字符、
 * 收敛空白、去首尾的点（不产生隐藏文件与 '..'）、限长 64 且保留扩展名。
 * 控制字符必须去掉：文件名会进 Content-Disposition 头，CR/LF 是头注入的老套路。
 */
export function cleanFilename(name) {
  let s = String(name == null ? '' : name).replace(/\\/g, '/');
  const cut = s.lastIndexOf('/');
  if (cut >= 0) s = s.slice(cut + 1);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[<>:"|?*]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length > FILENAME_MAX) s = truncateKeepExt(s, FILENAME_MAX);
  return s;
}

function startsWith(bytes, sig, offset) {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/**
 * 魔数嗅探：返回 'png'|'jpeg'|'gif'|'webp'|'zip'|'pdf'|'rar'|'gzip'，认不出返回 null。
 * 只认前几字节，够挡住「把脚本改名成 .png」这类；要更严就得上解码器，这里不做。
 */
export function sniffKind(value) {
  const b = toBytes(value);
  if (!b.length) return null;
  if (b.length >= 12 && startsWith(b, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  for (let i = 0; i < SIGNATURES.length; i++) {
    if (startsWith(b, SIGNATURES[i].sig, SIGNATURES[i].offset)) return SIGNATURES[i].kind;
  }
  return null;
}

/** 文本附件里出现 NUL 基本可断定是二进制（UTF-8 文本不会有它） */
function hasNul(b) {
  for (let i = 0; i < b.length; i++) if (b[i] === 0) return true;
  return false;
}

function mimeBase(mime) {
  return String(mime == null ? '' : mime)
    .split(';')[0]
    .trim()
    .toLowerCase();
}

// ============================== 三、校验 ==============================

/**
 * 附件校验：扩展名白名单 → 大小上限 → 声明类型（可选）→ 魔数与扩展名是否一致。
 *
 * @param {string} filename 原始文件名（会先清洗）
 * @param {string} [mime] 浏览器声明的类型；空 / application/octet-stream 视为「没提供」，不否决
 * @param {Uint8Array|ArrayBuffer|string|number} bytes 内容；传**数字**时按「只知道大小」处理（跳过魔数检查），
 *        便于还没把内容读进内存的调用方先卡大小
 * @returns {{ok:true,size:number,kind:string,ext:string,mime:string,name:string}|{error:string}}
 */
export function validateAttachment(filename, mime, bytes) {
  const name = cleanFilename(filename);
  if (!name) return { error: '文件名不能为空' };
  const ext = extOf(name);
  if (!ext) return { error: '附件要带扩展名，支持 ' + ATTACH_EXT_LIST.join(' / ') };
  const rule = ATTACH_EXT[ext];
  if (!rule) return { error: '不支持 .' + ext + ' 这类附件，支持 ' + ATTACH_EXT_LIST.join(' / ') };
  const kind = ATTACH_KINDS[rule.kind];

  let size = 0;
  let body = null;
  if (typeof bytes === 'number') {
    size = Math.trunc(bytes);
  } else if (bytes === undefined || bytes === null || bytes === '') {
    return { error: '没拿到附件内容（' + name + '）' };
  } else {
    body = toBytes(bytes);
    size = body.length;
  }
  if (size <= 0) return { error: name + ' 是空的' };
  if (size > kind.max) {
    return { error: kind.label + '最大 ' + kind.maxLabel + '，' + name + ' 有 ' + fmtSize(size) };
  }

  const m = mimeBase(mime);
  if (m && m !== 'application/octet-stream' && m !== 'binary/octet-stream' && rule.mime.indexOf(m) < 0) {
    return { error: '.' + ext + ' 的类型应为 ' + rule.mime.join(' / ') + '，浏览器报的是 ' + m };
  }

  if (body) {
    const sniffed = sniffKind(body);
    if (rule.magic) {
      if (sniffed !== rule.magic) {
        const seen = sniffed ? '，看着是 ' + (KIND_LABEL[sniffed] || sniffed) : '';
        return { error: '.' + ext + ' 的内容不像' + kind.label + '（魔数不符' + seen + '），请确认没有改过扩展名' };
      }
    } else if (sniffed) {
      return { error: name + ' 是文本附件，但内容看着是 ' + (KIND_LABEL[sniffed] || sniffed) + '，请改扩展名或换文件' };
    } else if (hasNul(body)) {
      return { error: name + ' 里有 NUL 字节，像是二进制文件，不能当文本附件' };
    }
  }

  return { ok: true, size: size, kind: rule.kind, ext: ext, mime: m, name: name };
}

/** 附件的稳定 URL：/ugc/a/<id>（id 是 attachments.id；主机判定与 /ugc/:file 同前缀） */
export function attachmentUrl(id) {
  return ATTACH_PREFIX + String(id);
}

// ============================== 四、表结构（两条线共用一份，单行语句） ==============================

/**
 * attachments / attachments_blob 的 DDL。必须是**单行语句**：D1 的 exec 按换行切分，多行会被切成半句。
 * Express 线由 store 自己幂等执行；Worker 线由 worker/attachments.js 的 ensureAttachments(db) 执行
 * （worker/schema.js 与 migrations/0011_attachments.sql 是同一份的多行可读版）。
 */
export const ATTACH_DDL = [
  'CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0, post_id INTEGER NOT NULL DEFAULT 0, filename TEXT NOT NULL, mime TEXT NOT NULL DEFAULT \'\', bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT \'\', storage TEXT NOT NULL DEFAULT \'\', "key" TEXT NOT NULL DEFAULT \'\', created_at TEXT DEFAULT (datetime(\'now\',\'localtime\')), status TEXT NOT NULL DEFAULT \'pending\')',
  'CREATE INDEX IF NOT EXISTS idx_attachments_post ON attachments(post_id, status, id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id, status, id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id, status, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256, storage, status)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_gc ON attachments(status, created_at)',
  'CREATE TABLE IF NOT EXISTS attachments_blob (id INTEGER PRIMARY KEY AUTOINCREMENT, data_b64 TEXT NOT NULL)'
];

// ============================== 五、存储适配层 ==============================

/** Worker 打包器要静态解析 node:sqlite / node:fs 就会在部署时炸；变量拼模块名让它解析不到 */
// 注意：这里是 src/ 里的 ./db.js（写成拼串是为了绕开打包器的静态解析），不是仓库根的 ../db.js
const MOD_NODE_DB = ['.', 'db.js'].join('/');
const MOD_NODE_FS = 'node' + ':fs';

let nodeDbCache = null;
let nodeFsCache = null;

async function loadNodeDb() {
  if (!nodeDbCache) nodeDbCache = await import(MOD_NODE_DB);
  return nodeDbCache;
}

async function loadNodeFs() {
  if (!nodeFsCache) nodeFsCache = await import(MOD_NODE_FS);
  return nodeFsCache;
}

/** 已经建过表的库（同进程只跑一次 DDL；Worker 里 env.DB 是同一个对象，等于每个 isolate 一次） */
const ensuredDbs = new WeakSet();

function unavailable(hint) {
  return {
    error: 'storage_unavailable',
    hint:
      hint +
      '。附件存储没接上：Express 线用 createStore({ driver: "fs" })（默认落 data/attachments/，元数据进同一个 sqlite）；' +
      'Worker 线用 worker/attachments.js 的 saveAttachment(env.DB, ...)（driver 固定 d1）。' +
      '两条线都没有时把附件入口关掉、只提示用户，别让发帖整条挂掉。'
  };
}

/**
 * 建一个存储适配器。
 *
 * @param {object} [opts]
 * @param {'fs'|'d1'} opts.driver 驱动；缺省 / 不认识的驱动返回 { error:'storage_unavailable', hint }
 * @param {object} [opts.db] fs：node:sqlite 的 DatabaseSync（缺省用 ../db.js 里那个）；
 *                           d1：D1 绑定（env.DB），缺了就是 storage_unavailable
 * @param {string} [opts.dir] fs 的落盘根目录，缺省 <仓库根>/data/attachments
 * @param {object} [opts.io] fs 模块替身（测试注入用；缺省惰性 import node:fs）
 * @param {()=>number} [opts.now] 取时钟（测试注入用，默认 Date.now）
 * @returns {object} store 或 { error:'storage_unavailable', hint }
 */
export function createStore(opts) {
  const o = opts || {};
  const driver = String(o.driver || '').trim().toLowerCase();
  if (driver === ATTACH_STORAGE.FS) return fsStore(o);
  if (driver === ATTACH_STORAGE.D1) return d1Store(o);
  // 对象存储（可插拔：local / s3）与元数据驱动（fs / d1）是两件事，但都从 driver 进来：
  // 显式写 local / s3 时直接给对象适配器（createObjectStore），免得调用方记两个入口。
  if (driver === OBJECT_STORE.LOCAL || driver === OBJECT_STORE.S3 || driver === 'minio' || driver === 's3-compatible') {
    return createObjectStore(o);
  }
  return unavailable(driver ? '不认识的存储驱动 ' + driver : '没有配置存储驱动（driver）');
}

function normId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normRef(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : 0;
}

function meta(row) {
  return {
    id: Number(row.id),
    owner_id: Number(row.owner_id),
    thread_id: Number(row.thread_id),
    post_id: Number(row.post_id),
    filename: String(row.filename || ''),
    mime: String(row.mime || ''),
    bytes: Number(row.bytes),
    sha256: String(row.sha256 || ''),
    storage: String(row.storage || ''),
    key: String(row.key || ''),
    created_at: String(row.created_at || ''),
    status: String(row.status || ''),
    // 审核轴（只增不改：上面 12 个字段的名字 / 顺序 / 类型一律不动）
    review_status: String(row.review_status || ATTACH_REVIEW.PENDING),
    review_by: Number(row.review_by || 0),
    review_at: String(row.review_at || ''),
    review_reason: String(row.review_reason || ''),
    review_source: String(row.review_source || ''),
    review_hidden: Number(row.review_hidden || 0) === 1 ? 1 : 0
  };
}

/** 两个驱动共用的业务逻辑：SQL 完全相同，差异只在 dbh（怎么执行 SQL）与 blob（内容去哪） */
function makeStore(cfg) {
  const driver = cfg.driver;
  const blob = cfg.blob;
  const dbhOf = cfg.dbh;
  const now = cfg.now;
  const st = { saves: 0, bytes: 0, dedupes: 0, purged: 0, gcRemoved: 0 };
  let ready = false;

  async function opened() {
    const dbh = await dbhOf();
    if (!ready) {
      await dbh.ensure();
      ready = true;
    }
    return dbh;
  }

  /** 同一份内容（sha256）只留一份实体：先找现成的活行复用它的 key，找不到才落一份新的 */
  async function locate(dbh, sha, ext, body) {
    const prev = await dbh.first('SELECT "key" AS k FROM attachments WHERE sha256=? AND storage=? AND status<>? LIMIT 1', [sha, driver, ATTACH_STATUS.DELETED]);
    if (prev && prev.k) {
      st.dedupes++;
      return String(prev.k);
    }
    return String(await blob.write({ sha256: sha, ext: ext, bytes: body }));
  }

  /** 没人再引用这份内容才真删（内容寻址会共享实体，删之前必须确认） */
  async function dropIfUnused(dbh, key) {
    if (!key) return false;
    const live = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE "key"=? AND status<>?', [key, ATTACH_STATUS.DELETED]);
    if (Number(live && live.n) > 0) return false;
    const gone = await blob.drop(key);
    if (gone) st.purged++;
    return gone;
  }

  async function save(p) {
    const o = p || {};
    const dbh = await opened();
    const ownerId = normId(o.ownerId);
    if (!ownerId) return { error: '缺少上传者（ownerId）' };
    const threadId = normRef(o.threadId);
    const postId = normRef(o.postId);
    const raw = o.bytes !== undefined ? o.bytes : o.content;
    const checked = validateAttachment(o.filename !== undefined ? o.filename : o.name, o.mime !== undefined ? o.mime : o.type, raw);
    if (checked.error) return checked;
    const body = toBytes(raw);

    if (blob.maxBytes && body.length > blob.maxBytes) {
      return {
        error: 'too_large_for_d1',
        hint: 'D1 单份内容上限 ' + D1_BLOB_LABEL + '，这份有 ' + fmtSize(body.length) + '：图片/文本请压缩后再传，大文件等 Express 线的磁盘存储'
      };
    }

    const sha = await sha256Hex(body);
    const key = await locate(dbh, sha, checked.ext, body);
    let status = threadId || postId ? ATTACH_STATUS.ACTIVE : ATTACH_STATUS.PENDING;
    const stamp = o.now === undefined ? null : localStamp(Number(o.now));
    const ins = await dbh.run(
      'INSERT INTO attachments (owner_id, thread_id, post_id, filename, mime, bytes, sha256, storage, "key", created_at, status) VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, datetime(\'now\',\'localtime\')), ?)',
      [ownerId, threadId, postId, checked.name, checked.mime || '', body.length, sha, driver, key, stamp, status]
    );
    st.saves++;
    st.bytes += body.length;
    // 自动规则：明显不合格的（尺寸 / 魔数这类只有拿到内容才判得了的）直接落 rejected 并软隐藏；
    // 规则给不出结论的一律留在 pending 等人工，返回值形状一个字段都不动。
    const rev = await autoReviewRow(dbh, ins.id, { filename: checked.name, mime: checked.mime || '', bytes: body.length }, body);
    if (rev.hidden) status = rev.lifecycle;
    return { ok: true, id: ins.id, url: attachmentUrl(ins.id), key: key, sha256: sha, bytes: body.length, status: status, driver: driver };
  }

  async function get(id, o) {
    const dbh = await opened();
    const pid = normId(id);
    if (!pid) return { error: 'not_found' };
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [pid]);
    if (!row) return { error: 'not_found' };
    const out = meta(row);
    if (!o || !o.withBody) return out;
    const body = await blob.read(out.key);
    if (!body) return { error: 'body_missing', id: out.id, key: out.key };
    out.body = body;
    return out;
  }

  /** pending 认领：上传时还没发帖，帖子建好后把附件挂上去并置 active */
  async function attach(id, place) {
    const dbh = await opened();
    const pid = normId(id);
    const p = place || {};
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [pid]);
    if (!row) return { error: 'not_found' };
    if (row.status === ATTACH_STATUS.DELETED) return { error: 'deleted', hint: '附件已删除，不能再挂到帖子上' };
    if (p.ownerId !== undefined && normId(p.ownerId) !== Number(row.owner_id)) return { error: 'forbidden', hint: '只能认领自己上传的附件' };
    const threadId = normRef(p.threadId !== undefined ? p.threadId : row.thread_id);
    const postId = normRef(p.postId !== undefined ? p.postId : row.post_id);
    await dbh.run('UPDATE attachments SET thread_id=?, post_id=?, status=? WHERE id=?', [threadId, postId, ATTACH_STATUS.ACTIVE, pid]);
    return { ok: true, id: pid, threadId: threadId, postId: postId, status: ATTACH_STATUS.ACTIVE };
  }

  async function remove(id, ownerId, o) {
    const dbh = await opened();
    const opts = o || {};
    const pid = normId(id);
    if (!pid) return { error: 'not_found' };
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [pid]);
    if (!row) return { error: 'not_found' };
    if (!opts.force && Number(row.owner_id) !== normId(ownerId)) {
      return { error: 'forbidden', hint: '只有上传者本人（或 force 的管理员入口）能删这个附件' };
    }
    if (row.status === ATTACH_STATUS.DELETED) return { ok: true, id: pid, already: true, purged: false };
    await dbh.run('UPDATE attachments SET status=? WHERE id=?', [ATTACH_STATUS.DELETED, pid]);
    const purged = opts.purge === true ? await dropIfUnused(dbh, String(row.key || '')) : false;
    return { ok: true, id: pid, already: false, purged: purged, status: ATTACH_STATUS.DELETED };
  }

  async function listWhere(column, ref) {
    const dbh = await opened();
    const n = normRef(ref);
    if (!n) return { ok: true, items: [], total: 0 };
    const rows = await dbh.all('SELECT * FROM attachments WHERE ' + column + '=? AND status<>? ORDER BY id ASC', [n, ATTACH_STATUS.DELETED]);
    return { ok: true, items: rows.map(meta), total: rows.length };
  }

  function listByPost(postId) {
    return listWhere('post_id', postId);
  }

  function listByThread(threadId) {
    return listWhere('thread_id', threadId);
  }

  /**
   * 回收孤儿：传了文件却没发成帖的 pending 行，超过 24h 连行带内容一起清掉
   * （这里不再软删：pending 行没有任何人引用，留着只会一直占地方）。
   */
  async function gcOrphans(nowMs) {
    const dbh = await opened();
    const t = Number.isFinite(Number(nowMs)) ? Number(nowMs) : now();
    const cutoff = localStamp(t - ATTACH_ORPHAN_MS);
    const rows = await dbh.all('SELECT id, "key" AS k FROM attachments WHERE status=? AND created_at < ?', [ATTACH_STATUS.PENDING, cutoff]);
    let removed = 0;
    let purged = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = await dbh.run('DELETE FROM attachments WHERE id=? AND status=?', [Number(rows[i].id), ATTACH_STATUS.PENDING]);
      if (Number(r.changes) > 0) {
        removed++;
        st.gcRemoved++;
        if (await dropIfUnused(dbh, String(rows[i].k || ''))) purged++;
      }
    }
    return { ok: true, removed: removed, purged: purged, cutoff: cutoff };
  }

  function stats() {
    return { driver: driver, saves: st.saves, bytes: st.bytes, dedupes: st.dedupes, purged: st.purged, gcRemoved: st.gcRemoved };
  }

  async function ensure() {
    await opened();
    return { ok: true, driver: driver };
  }

  // ---------- 人工审核：写结论 / 队列 / 统计 / 自动规则 / 分类器 ----------

  /** 只写审核列（生命周期另算）：审核结论一律落这份行内记录，谁审的、什么时候、为什么都留着 */
  async function writeReview(dbh, id, status, info) {
    const it = info || {};
    const at = it.at === undefined || it.at === null ? localStamp(now()) : String(it.at);
    const by = normId(it.moderatorId);
    const reason = it.reason === undefined || it.reason === null ? '' : String(it.reason).slice(0, 300);
    const source = String(it.source || ATTACH_REVIEW_SOURCE.MANUAL);
    const hidden = status === ATTACH_REVIEW.REJECTED ? 1 : 0;
    await dbh.run('UPDATE attachments SET review_status=?, review_by=?, review_at=?, review_reason=?, review_source=?, review_hidden=? WHERE id=?', [
      status,
      by,
      at,
      reason,
      source,
      hidden,
      id
    ]);
    return { status: status, by: by, at: at, reason: reason, source: source, hidden: hidden };
  }

  /**
   * 自动规则跑一条行：rejected → 写审核列 + 软隐藏（status='deleted'、review_hidden=1）；
   * 没结论 → 只把「转人工的理由」写进 review_reason，不动生命周期（口径：pending 不挡展示）。
   * it.keep === true 时只算不写（干跑）；it.readBody === true 时自己去存储读内容。
   */
  async function autoReviewRow(dbh, id, row, value, it) {
    const opt = it || {};
    let body = value === undefined || value === null ? null : toBytes(value);
    const key = String((row && row.key) || '');
    if ((!body || !body.length) && opt.readBody === true && key) {
      try {
        body = await blob.read(key);
      } catch (e) {
        body = null;
      }
    }
    const verdict = autoReviewAttachment(row || {}, body);
    const n = Number(id) || 0;
    if (opt.keep === true) {
      return { ok: true, id: n, status: verdict.status, reason: verdict.reason, note: verdict.note, wrote: false, hidden: 0, lifecycle: String((row && row.status) || '') };
    }
    if (verdict.status === ATTACH_REVIEW.REJECTED) {
      const info = await writeReview(dbh, n, ATTACH_REVIEW.REJECTED, {
        moderatorId: 0,
        reason: verdict.reason,
        source: ATTACH_REVIEW_SOURCE.AUTO,
        at: opt.at
      });
      await dbh.run('UPDATE attachments SET status=? WHERE id=?', [ATTACH_STATUS.DELETED, n]);
      return { ok: true, id: n, status: verdict.status, reason: verdict.reason, note: '', wrote: true, hidden: 1, lifecycle: ATTACH_STATUS.DELETED, at: info.at };
    }
    if (verdict.note) {
      await dbh.run('UPDATE attachments SET review_reason=?, review_source=? WHERE id=? AND review_status=?', [
        verdict.note,
        ATTACH_REVIEW_SOURCE.AUTO,
        n,
        ATTACH_REVIEW.PENDING
      ]);
    }
    return { ok: true, id: n, status: ATTACH_REVIEW.PENDING, reason: '', note: verdict.note, wrote: false, hidden: 0, lifecycle: String((row && row.status) || '') };
  }

  /** 队列：review_status='pending' 且没被软删的行，FIFO（id 升序）。total 是满足条件的总数，不是这一页的条数 */
  async function listPending(limit, offset) {
    const dbh = await opened();
    const pg = pageArgs(limit, offset);
    const where = 'review_status=? AND status<>?';
    const args = [ATTACH_REVIEW.PENDING, ATTACH_STATUS.DELETED];
    const cnt = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE ' + where, args);
    const rows = await dbh.all('SELECT * FROM attachments WHERE ' + where + ' ORDER BY id ASC LIMIT ? OFFSET ?', args.concat([pg.limit, pg.offset]));
    return { ok: true, total: Number((cnt && cnt.n) || 0), limit: pg.limit, offset: pg.offset, items: rows.map(meta) };
  }

  /** 被拒的（含已被拒→软删的行，人工翻案要能看到它们），最近拒的在前面 */
  async function listRejected(limit, offset) {
    const dbh = await opened();
    const pg = pageArgs(limit, offset);
    const args = [ATTACH_REVIEW.REJECTED];
    const cnt = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE review_status=?', args);
    const rows = await dbh.all('SELECT * FROM attachments WHERE review_status=? ORDER BY id DESC LIMIT ? OFFSET ?', args.concat([pg.limit, pg.offset]));
    return { ok: true, total: Number((cnt && cnt.n) || 0), limit: pg.limit, offset: pg.offset, items: rows.map(meta) };
  }

  /**
   * 人工审核。action: approve / reject。
   * 口径：**reject 即软删 + 隐藏**（行留着、内容不回收，review_hidden=1 记下这次软删是审核造成的），
   * 这样两条线现有的「只发 active」出口天然挡住被拒内容；approve 时若这行是被审核隐藏的，生命周期退回
   * 「挂过帖 → active，没挂过 → pending」。重复审核同一结论是幂等的（already=true，不重复写）。
   */
  async function moderate(id, action, opts) {
    const o = opts || {};
    const raw = String(action === undefined || action === null ? '' : action).trim().toLowerCase();
    const want = ATTACH_REVIEW_ACTION[raw] || (raw === 'approved' ? ATTACH_REVIEW.APPROVED : '') || (raw === 'rejected' ? ATTACH_REVIEW.REJECTED : '');
    if (!want) return { ok: false, status: '', error: 'bad_action', hint: 'action 只认 approve / reject（收到 ' + (raw || '空') + '）' };
    const by = normId(o.moderatorId);
    if (!by) return { ok: false, status: '', error: 'forbidden', hint: '审核要带 moderatorId（审核人 id），0 / 空 / 非数字都视为没登录' };
    const reason = String(o.reason === undefined || o.reason === null ? '' : o.reason).trim();
    if (want === ATTACH_REVIEW.REJECTED && !reason) return { ok: false, status: '', error: 'reason_required', hint: '驳回要写理由（reason）' };
    const n = normId(id);
    if (!n) return { ok: false, status: '', error: 'not_found', hint: '附件 id 不合法：' + String(id) };
    const dbh = await opened();
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [n]);
    if (!row) return { ok: false, status: '', error: 'not_found', hint: '没有这个附件：' + String(n) };
    const cur = String(row.review_status || ATTACH_REVIEW.PENDING);
    const hidden = Number(row.review_hidden || 0) === 1 ? 1 : 0;
    const life = String(row.status || '');
    if (cur === want) {
      return { ok: true, id: n, status: want, already: true, hidden: hidden, lifecycle: life, moderatorId: by, error: '' };
    }
    const info = await writeReview(dbh, n, want, { moderatorId: by, reason: reason, source: ATTACH_REVIEW_SOURCE.MANUAL, at: o.at });
    if (want === ATTACH_REVIEW.REJECTED) {
      await dbh.run('UPDATE attachments SET status=? WHERE id=?', [ATTACH_STATUS.DELETED, n]);
      st.hidden = (st.hidden || 0) + 1;
      return { ok: true, id: n, status: want, already: false, hidden: 1, lifecycle: ATTACH_STATUS.DELETED, moderatorId: by, at: info.at, reason: info.reason, error: '' };
    }
    if (hidden) {
      const restored = normRef(row.thread_id) || normRef(row.post_id) ? ATTACH_STATUS.ACTIVE : ATTACH_STATUS.PENDING;
      await dbh.run('UPDATE attachments SET status=?, review_hidden=0 WHERE id=?', [restored, n]);
      return { ok: true, id: n, status: want, already: false, hidden: 0, lifecycle: restored, moderatorId: by, at: info.at, reason: info.reason, error: '' };
    }
    return { ok: true, id: n, status: want, already: false, hidden: 0, lifecycle: life, moderatorId: by, at: info.at, reason: info.reason, error: '' };
  }

  /**
   * 审核口径的统计（各状态计数与体积）。**不是** stats()：那个被冻结断言同步调用、字段不能动，
   * 所以审核统计另开一个 async 方法，别去改 stats()。
   * pending 含「已软删但审核还没结论」的行；pending_live 才是队列口径。
   */
  async function moderationStats() {
    const dbh = await opened();
    const rows = await dbh.all('SELECT review_status AS s, COUNT(1) AS n, COALESCE(SUM(bytes),0) AS b FROM attachments GROUP BY review_status', []);
    const byStatus = [];
    let total = 0;
    let bytes = 0;
    const byName = {};
    for (let i = 0; i < rows.length; i++) {
      const s = String(rows[i].s || ATTACH_REVIEW.PENDING);
      const n = Number(rows[i].n || 0);
      const b = Number(rows[i].b || 0);
      byStatus.push({ status: s, n: n, bytes: b });
      byName[s] = { n: n, bytes: b };
      total += n;
      bytes += b;
    }
    const live = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE status<>?', [ATTACH_STATUS.DELETED]);
    const livePending = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE review_status=? AND status<>?', [ATTACH_REVIEW.PENDING, ATTACH_STATUS.DELETED]);
    const hidden = await dbh.first('SELECT COUNT(1) AS n FROM attachments WHERE review_hidden=1', []);
    const pend = byName[ATTACH_REVIEW.PENDING] || { n: 0, bytes: 0 };
    const appr = byName[ATTACH_REVIEW.APPROVED] || { n: 0, bytes: 0 };
    const rej = byName[ATTACH_REVIEW.REJECTED] || { n: 0, bytes: 0 };
    return {
      ok: true,
      driver: driver,
      total: total,
      live: Number((live && live.n) || 0),
      pending: pend.n,
      pending_live: Number((livePending && livePending.n) || 0),
      approved: appr.n,
      rejected: rej.n,
      hidden: Number((hidden && hidden.n) || 0),
      bytes: bytes,
      bytes_pending: pend.bytes,
      bytes_approved: appr.bytes,
      bytes_rejected: rej.bytes,
      byStatus: byStatus
    };
  }

  /** 对已有行重跑自动规则（规则变严 / 旧数据回扫）；it.keep 干跑，it.readBody 自己去存储读内容 */
  async function autoReview(id, it) {
    const opt = it || {};
    const n = normId(id);
    if (!n) return { error: 'not_found' };
    const dbh = await opened();
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [n]);
    if (!row) return { error: 'not_found' };
    return autoReviewRow(dbh, n, row, opt.value === undefined ? null : opt.value, { keep: opt.keep === true, readBody: opt.readBody !== false, at: opt.at });
  }

  /**
   * 跑一遍注入的分类器（NSFW 之类）。没注入 → no_classifier，**绝不假装审过**；
   * 分类器没给结论 / 抛异常 → 留在 pending（并把理由写进 review_reason）。
   */
  async function classify(id, it) {
    const opt = it || {};
    const fn = getClassifier();
    if (!fn) return { ok: false, status: '', error: 'no_classifier', hint: '没注入分类器（setClassifier(fn)），审核一律留在 pending 等人工' };
    const n = normId(id);
    if (!n) return { ok: false, status: '', error: 'not_found' };
    const dbh = await opened();
    const row = await dbh.first('SELECT * FROM attachments WHERE id=?', [n]);
    if (!row) return { ok: false, status: '', error: 'not_found' };
    const out = meta(row);
    let body = null;
    if (out.key) {
      try {
        body = await blob.read(out.key);
      } catch (e) {
        body = null;
      }
    }
    let verdict = null;
    try {
      verdict = await fn(out, body);
    } catch (e) {
      const note = '分类器异常，转人工：' + String((e && e.message) || e);
      await dbh.run('UPDATE attachments SET review_reason=?, review_source=? WHERE id=? AND review_status=?', [note, ATTACH_REVIEW_SOURCE.CLASSIFIER, n, ATTACH_REVIEW.PENDING]);
      const got = await dbh.first('SELECT * FROM attachments WHERE id=?', [n]);
      return { ok: true, id: n, status: String((got && got.review_status) || ATTACH_REVIEW.PENDING), note: note, error: '' };
    }
    const want = classifierVerdict(verdict);
    if (!want) {
      const note = '分类器没给结论，留 pending 转人工';
      await dbh.run('UPDATE attachments SET review_reason=?, review_source=? WHERE id=? AND review_status=?', [note, ATTACH_REVIEW_SOURCE.CLASSIFIER, n, ATTACH_REVIEW.PENDING]);
      return { ok: true, id: n, status: ATTACH_REVIEW.PENDING, note: note, error: '' };
    }
    const reason = String((verdict && (verdict.reason || verdict.reject_reason)) || '') || (want === ATTACH_REVIEW.REJECTED ? '分类器判定不合格' : '');
    const info = await writeReview(dbh, n, want, { moderatorId: 0, reason: reason, source: ATTACH_REVIEW_SOURCE.CLASSIFIER, at: opt.at });
    if (want === ATTACH_REVIEW.REJECTED) {
      await dbh.run('UPDATE attachments SET status=? WHERE id=?', [ATTACH_STATUS.DELETED, n]);
      return { ok: true, id: n, status: want, hidden: 1, lifecycle: ATTACH_STATUS.DELETED, reason: info.reason, note: '', error: '' };
    }
    if (Number(row.review_hidden || 0) === 1) {
      const restored = normRef(row.thread_id) || normRef(row.post_id) ? ATTACH_STATUS.ACTIVE : ATTACH_STATUS.PENDING;
      await dbh.run('UPDATE attachments SET status=?, review_hidden=0 WHERE id=?', [restored, n]);
      return { ok: true, id: n, status: want, hidden: 0, lifecycle: restored, reason: info.reason, note: '', error: '' };
    }
    return { ok: true, id: n, status: want, hidden: 0, lifecycle: String(row.status || ''), reason: info.reason, note: '', error: '' };
  }

  /** 显式补审核列 / 索引（幂等）。store.ensure() 已经顺手做过一遍，这个方法给「先建表、后接线」的场景 */
  async function ensureReview() {
    const dbh = await opened();
    const r = await applyReviewSchema(dbh);
    return { ok: true, driver: driver, added: r.added, columns: r.columns };
  }

  return {
    driver: driver,
    url: attachmentUrl,
    save: save,
    get: get,
    attach: attach,
    remove: remove,
    listByPost: listByPost,
    listByThread: listByThread,
    gcOrphans: gcOrphans,
    stats: stats,
    ensure: ensure,
    listPending: listPending,
    listRejected: listRejected,
    moderate: moderate,
    moderationStats: moderationStats,
    autoReview: autoReview,
    classify: classify,
    ensureReview: ensureReview
  };
}

/** node:sqlite 那套 API → 统一的 dbh（run 要给回 lastInsertRowid / changes） */
function sqliteDbh(db) {
  const api = {
    async ensure() {
      if (ensuredDbs.has(db)) return;
      await reviewSchemaOf(db, api);
      ensuredDbs.add(db);
    },
    async exec(sql) {
      db.exec(String(sql));
    },
    async run(sql, params) {
      const stmt = db.prepare(sql);
      const r = stmt.run.apply(stmt, params || []);
      return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async first(sql, params) {
      const stmt = db.prepare(sql);
      const r = stmt.get.apply(stmt, params || []);
      return r === undefined ? null : r;
    },
    async all(sql, params) {
      const stmt = db.prepare(sql);
      return stmt.all.apply(stmt, params || []);
    }
  };
  return api;
}

/** D1 那套 API → 统一的 dbh（db 首参、全 await、meta 里取 id/changes） */
function d1Dbh(db) {
  function stmt(sql, params) {
    const s = db.prepare(sql);
    return params && params.length ? s.bind.apply(s, params) : s;
  }
  const api = {
    async ensure() {
      if (ensuredDbs.has(db)) return;
      await reviewSchemaOf(db, api);
      ensuredDbs.add(db);
    },
    async exec(sql) {
      await db.exec(String(sql));
    },
    async run(sql, params) {
      const r = await stmt(sql, params).run();
      const m = (r && r.meta) || {};
      return { id: Number(m.last_row_id || 0), changes: Number(m.changes || 0) };
    },
    async first(sql, params) {
      const r = await stmt(sql, params).first();
      return r === undefined ? null : r;
    },
    async all(sql, params) {
      const r = await stmt(sql, params).all();
      return (r && r.results) || [];
    }
  };
  return api;
}

/** 本地磁盘：data/attachments/<yyyymm>/<sha256 前 2 位>/<sha256>.<ext>（内容寻址 = 天然去重） */
function fsStore(o) {
  if (o.db && typeof o.db.prepare !== 'function') {
    return unavailable('fs 驱动要的是 node:sqlite 的 DatabaseSync（要 Worker 线就用 d1 驱动）');
  }
  const now = typeof o.now === 'function' ? o.now : Date.now;

  async function fsModule() {
    if (o.io) return o.io;
    return loadNodeFs();
  }

  async function resolveDb() {
    if (o.db) return o.db;
    const mod = await loadNodeDb();
    return mod.db;
  }

  let dirCache = null;
  async function dir() {
    if (o.dir) return String(o.dir).replace(/[/]+$/, '');
    if (dirCache) return dirCache;
    const mod = await loadNodeDb();
    dirCache = String(mod.ROOT).replace(/\\/g, '/').replace(/[/]+$/, '') + '/data/attachments';
    return dirCache;
  }

  const dbh = async function () {
    return sqliteDbh(await resolveDb());
  };

  const blob = {
    maxBytes: 0, // 磁盘没有大小上限，规则表里的 max 就是上限
    async write(info) {
      const f = await fsModule();
      const d = await dir();
      const dt = new Date(now());
      const month = dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, '0');
      // key 只由 sha256 与白名单里的扩展名拼成，不含用户输入 → 不存在路径穿越
      const key = month + '/' + info.sha256.slice(0, 2) + '/' + info.sha256 + (info.ext ? '.' + info.ext : '');
      const path = d + '/' + key;
      f.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      if (!f.existsSync(path)) f.writeFileSync(path, info.bytes);
      return key;
    },
    async read(key) {
      const f = await fsModule();
      const path = (await dir()) + '/' + String(key);
      if (!f.existsSync(path)) return null;
      return new Uint8Array(f.readFileSync(path));
    },
    async drop(key) {
      const f = await fsModule();
      const path = (await dir()) + '/' + String(key);
      try {
        f.unlinkSync(path);
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  const store = makeStore({ driver: ATTACH_STORAGE.FS, dbh: dbh, blob: blob, now: now });
  store.dir = function () {
    return dir();
  };
  return store;
}

/** D1：内容以 base64 进 attachments_blob，key 就是那张表的行号 */
function d1Store(o) {
  if (!o.db || typeof o.db.prepare !== 'function') {
    return unavailable('d1 驱动要传 db 绑定（Worker 里是 env.DB）');
  }
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const db = o.db;

  const dbh = async function () {
    return d1Dbh(db);
  };

  const blob = {
    maxBytes: D1_BLOB_MAX,
    async write(info) {
      const r = await d1Dbh(db).run('INSERT INTO attachments_blob (data_b64) VALUES (?)', [bytesToB64(info.bytes)]);
      return String(r.id);
    },
    async read(key) {
      const row = await d1Dbh(db).first('SELECT data_b64 FROM attachments_blob WHERE id=?', [normId(key)]);
      if (!row || !row.data_b64) return null;
      return b64ToBytes(row.data_b64);
    },
    async drop(key) {
      const r = await d1Dbh(db).run('DELETE FROM attachments_blob WHERE id=?', [normId(key)]);
      return r.changes > 0;
    }
  };

  return makeStore({ driver: ATTACH_STORAGE.D1, dbh: dbh, blob: blob, now: now });
}

// ============================== 六、对象存储适配器（local / s3 兼容，可插拔） ==============================

/**
 * 对象存储驱动名。createObjectStore(config) 按它分发；createStore 里 driver 显式写这两个值时也转发到这里。
 *   local —— 默认。落 <ROOT>/data/uploads（config.dir 可换），字节原样写盘、不编码（与 fs 驱动的 blob 层同一形状）。
 *   s3    —— S3 兼容对象存储（AWS S3 / MinIO / R2 的 S3 网关都行）。SigV4 自己签、fetch 自己发，零依赖。
 * 适配器接口：{ driver, put(key, bytes, { contentType }), get(key), delete(key), url(key), dir?(), info() }
 *   put/get/delete/url 都是 async；出错一律给 { error, hint } ，不抛。
 */
export const OBJECT_STORE = { LOCAL: 'local', S3: 's3' };

/** 对象存储认的环境变量（config.env 优先，其次 process.env；Worker 里没有 process 就只认 config.env） */
export const OBJECT_ENV_KEYS = [
  'ATTACH_STORE',
  'ATTACH_PUBLIC_BASE',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_PUBLIC_BASE',
  'S3_PATH_STYLE',
  'S3_URL_TTL'
];

const BSLASH = '\\';

/** 反斜杠统一成正斜杠（Windows 的 ROOT / 手填目录进对象 key 之前都过一遍） */
function toPosix(s) {
  return String(s === undefined || s === null ? '' : s).split(BSLASH).join('/');
}

function trimSlash(s) {
  let out = toPosix(s);
  while (out.length && out.charAt(out.length - 1) === '/') out = out.slice(0, -1);
  return out;
}

/** 目录名：不引 node:path（这个模块顶层不许出现静态 node: import） */
function dirOfPath(path) {
  const s = String(path);
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * 对象 key 白名单：只挡危险形状（空 / 绝对路径 / 反斜杠 / .. / 控制字符），不限制字符集。
 * local 驱动靠它挡目录穿越 —— key 一律当相对路径拼在存储根目录下。
 */
export function safeObjectKey(key) {
  const k = String(key === undefined || key === null ? '' : key).trim();
  if (!k) return { ok: false, error: 'key_required', hint: '对象 key 不能为空' };
  if (k.length > 512) return { ok: false, error: 'bad_key', hint: '对象 key 太长（上限 512 字符）：' + k.slice(0, 48) + '…' };
  if (k.charAt(0) === '/') return { ok: false, error: 'bad_key', hint: '对象 key 不能是绝对路径：' + k };
  if (k.indexOf(BSLASH) >= 0) return { ok: false, error: 'bad_key', hint: '对象 key 不能含反斜杠：' + k };
  if (k.indexOf('..') >= 0) return { ok: false, error: 'bad_key', hint: '对象 key 不能含 ..：' + k };
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return { ok: false, error: 'bad_key', hint: '对象 key 不能含控制字符' };
  }
  return { ok: true, key: k };
}

/** 取 env：config.env 优先；没给就 process.env；两个都没有给空对象 */
function envOf(config) {
  if (config && config.env) return config.env;
  if (typeof globalThis.process !== 'undefined' && globalThis.process && globalThis.process.env) return globalThis.process.env;
  return {};
}

function envText(env, name) {
  const v = env ? env[name] : '';
  return v === undefined || v === null ? '' : String(v).trim();
}

function envFlag(env, name, dflt) {
  const v = envText(env, name).toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return dflt;
}

/**
 * local：磁盘目录里的对象存储。put / get 是原样字节（不 base64、不改编码），
 * 落盘形状与 fsStore 的 blob 层一致：<dir>/<key>，key 里的 '/' 就是子目录。
 * url(key)：本地盘没有对外 URL —— 配了 publicBase（config.publicBase 或 ATTACH_PUBLIC_BASE）才拼，
 * 否则给空串（对外访问走 /ugc/a/:id 那条路，由元数据行决定）。
 */
export function localObjectStore(o) {
  const cfg = o || {};
  const injected = cfg.io || null;
  let dirCache = cfg.dir ? trimSlash(cfg.dir) : '';
  const base = trimSlash(cfg.publicBase || envText(envOf(cfg), 'ATTACH_PUBLIC_BASE'));

  async function fsModule() {
    if (injected) return injected;
    return loadNodeFs();
  }

  async function dir() {
    if (dirCache) return dirCache;
    const mod = await loadNodeDb();
    dirCache = trimSlash(toPosix(mod.ROOT)) + '/data/uploads';
    return dirCache;
  }

  async function pathOf(key) {
    return (await dir()) + '/' + String(key);
  }

  return {
    driver: OBJECT_STORE.LOCAL,
    fallback: cfg.fallback === true,
    async dir() {
      return dir();
    },
    info() {
      return { driver: OBJECT_STORE.LOCAL, dir: dirCache, publicBase: base };
    },
    async put(key, bytes, opts) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const opt = opts || {};
      const body = toBytes(bytes);
      const f = await fsModule();
      const path = await pathOf(k.key);
      try {
        f.mkdirSync(dirOfPath(path), { recursive: true });
        f.writeFileSync(path, body);
      } catch (e) {
        return { error: 'store_error', hint: 'local 写盘失败：' + String((e && e.message) || e) };
      }
      return { ok: true, key: k.key, bytes: body.length, contentType: String(opt.contentType || ''), driver: OBJECT_STORE.LOCAL, etag: '' };
    },
    async get(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const f = await fsModule();
      const path = await pathOf(k.key);
      try {
        if (!f.existsSync(path)) return { error: 'not_found', key: k.key, hint: '本地对象不存在：' + path };
        const buf = f.readFileSync(path);
        const body = new Uint8Array(buf);
        return { ok: true, key: k.key, bytes: body, size: body.length, contentType: '', driver: OBJECT_STORE.LOCAL, etag: '' };
      } catch (e) {
        return { error: 'store_error', hint: 'local 读盘失败：' + String((e && e.message) || e) };
      }
    },
    async delete(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const f = await fsModule();
      const path = await pathOf(k.key);
      try {
        if (!f.existsSync(path)) return { ok: true, key: k.key, already: true, driver: OBJECT_STORE.LOCAL };
        f.unlinkSync(path);
      } catch (e) {
        return { error: 'store_error', hint: 'local 删文件失败：' + String((e && e.message) || e) };
      }
      return { ok: true, key: k.key, already: false, driver: OBJECT_STORE.LOCAL };
    },
    async url(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return '';
      return base ? base + '/' + k.key : '';
    }
  };
}

/** 字节 → 小写 hex（跟 sha256Hex 里那套写法一致，复用模块常量的 HEX） */
function hexOf(bytes) {
  const b = toBytes(bytes);
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >> 4] + HEX[b[i] & 0x0f];
  return out;
}

/** 毫秒时间 / Date → 'YYYYMMDDTHHMMSSZ'（UTC；SigV4 的 x-amz-date 就是这个格式） */
export function amzDateStamp(when) {
  const d = when instanceof Date ? when : new Date(typeof when === 'number' ? when : Date.now());
  const p = function (n) {
    return String(n).padStart(2, '0');
  };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

/** 头值规范化：去首尾空白、连续空白折叠成一个空格（canonical headers 的要求） */
function canonHeaderValue(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim();
}

/** SigV4 密钥链用的 HMAC-SHA256（key 是原始字节，msg 是字符串或字节） */
async function hmacSha256(keyBytes, message) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('当前运行时没有 WebCrypto（crypto.subtle），算不了 HMAC');
  const key = await subtle.importKey('raw', toBytes(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, toBytes(message));
  return new Uint8Array(sig);
}

/**
 * AWS SigV4（service 默认 s3）。纯函数：不发请求、不读时钟（时间由 opts.now / opts.amzDate 给），
 * 所以能拿官方文档的签名测试向量离线核对。
 *
 * @param {{method?,host,path?,query?,payloadHash?,payload?,headers?,now?,amzDate?,region?,service?,accessKey?,secretKey?,signOnly?}} o
 *        signOnly：只把列出的头算进 SignedHeaders（预签 URL 必须用 ['host'] —— 因为 AWS 复算时
 *        只认 URL 里 X-Amz-SignedHeaders 声明的那几个头，声明 1 个却签 3 个会 SignatureDoesNotMatch）。
 * @returns {Promise<{authorization,canonicalRequest,stringToSign,signature,signedHeaders,amzDate,scope,headers}>}
 */
export async function signAwsV4(o) {
  const opts = o || {};
  const method = String(opts.method || 'GET').toUpperCase();
  const host = String(opts.host || '');
  const path = String(opts.path || '/');
  const query = String(opts.query || '');
  const region = String(opts.region || 'us-east-1');
  const service = String(opts.service || 's3');
  const accessKey = String(opts.accessKey || '');
  const secretKey = String(opts.secretKey || '');
  const amzDate = opts.amzDate ? String(opts.amzDate) : amzDateStamp(opts.now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = opts.payloadHash ? String(opts.payloadHash) : await sha256Hex(toBytes(opts.payload));

  const headers = { host: host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const extra = opts.headers || {};
  const names = Object.keys(extra);
  for (let i = 0; i < names.length; i++) headers[String(names[i]).toLowerCase()] = canonHeaderValue(extra[names[i]]);
  const only = Array.isArray(opts.signOnly) ? opts.signOnly.map(function (n) { return String(n).toLowerCase(); }) : null;
  const sorted = Object.keys(headers).sort().filter(function (n) { return !only || only.indexOf(n) >= 0; });
  let canonicalHeaders = '';
  for (let i = 0; i < sorted.length; i++) canonicalHeaders += sorted[i] + ':' + canonHeaderValue(headers[sorted[i]]) + '\n';
  const signedHeaders = sorted.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmacSha256(toBytes('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = hexOf(await hmacSha256(kSigning, stringToSign));
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { authorization: authorization, canonicalRequest: canonicalRequest, stringToSign: stringToSign, signature: signature, signedHeaders: signedHeaders, amzDate: amzDate, scope: scope, headers: headers };
}

/** endpoint → { origin, host, basePath }；不成形状给 null（调用方回落 local） */
function splitEndpoint(endpoint) {
  const s = trimSlash(endpoint);
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)(\/.*)?$/.exec(s);
  if (!m) return null;
  return { origin: m[1] + '://' + m[2], host: m[2], basePath: m[3] ? trimSlash(m[3]) : '' };
}

/** SigV4 的 URI 编码：只留 A-Za-z0-9-_.~（'/' 视需要保留） */
function s3UriEncode(text, keepSlash) {
  const b = toBytes(text);
  let out = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    const safe =
      (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f || c === 0x2e || c === 0x7e;
    if (safe) out += String.fromCharCode(c);
    else if (keepSlash && c === 0x2f) out += '/';
    else out += '%' + HEX[c >> 4].toUpperCase() + HEX[c & 0x0f].toUpperCase();
  }
  return out;
}

/**
 * s3：S3 兼容对象存储。签名自己写（SigV4）、传输走 globalThis.fetch，零依赖。
 * 配置不全（缺 bucket / AK / SK，或这个运行时没有 fetch）时**回落 local** 并打一行 warn ——
 * 线上少一个环境变量不该让发帖整条挂掉。回落时返回值上带 fallback=true / fallbackReason。
 * contentType 只作为请求头送给对象存储，不参与签名（未签名的头 AWS 也接受）；payload 一定参与签名。
 */
export function s3ObjectStore(o) {
  const cfg = o || {};
  const env = envOf(cfg);
  const endpoint = trimSlash(cfg.endpoint || envText(env, 'S3_ENDPOINT'));
  const bucket = String(cfg.bucket || envText(env, 'S3_BUCKET') || '');
  const region = String(cfg.region || envText(env, 'S3_REGION') || 'us-east-1');
  const accessKey = String(cfg.accessKey || envText(env, 'S3_ACCESS_KEY') || '');
  const secretKey = String(cfg.secretKey || envText(env, 'S3_SECRET_KEY') || '');
  const publicBase = trimSlash(cfg.publicBase || envText(env, 'S3_PUBLIC_BASE'));
  const ttlRaw = Number(cfg.urlTtl || envText(env, 'S3_URL_TTL') || 3600);
  const urlTtl = Number.isFinite(ttlRaw) && ttlRaw > 0 && ttlRaw <= 604800 ? Math.trunc(ttlRaw) : 3600;
  const fetchFn = cfg.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const nowFn = typeof cfg.now === 'function' ? cfg.now : Date.now;

  const missing = [];
  if (!bucket) missing.push('S3_BUCKET');
  if (!accessKey) missing.push('S3_ACCESS_KEY');
  if (!secretKey) missing.push('S3_SECRET_KEY');
  if (missing.length || !fetchFn) {
    const why = missing.length ? '缺 ' + missing.join(' / ') : '这个运行时没有 fetch';
    const line = '附件存储：S3 没配全（' + why + '），这次按 local 落盘';
    if (typeof console !== 'undefined' && console.warn) console.warn(line);
    const back = localObjectStore(cfg);
    back.fallback = true;
    back.fallbackReason = why;
    back.fallbackLog = line;
    return back;
  }

  const ep = splitEndpoint(endpoint || 'https://s3.' + region + '.amazonaws.com');
  if (!ep) {
    const line = '附件存储：S3_ENDPOINT 不成形状（' + endpoint + '），这次按 local 落盘';
    if (typeof console !== 'undefined' && console.warn) console.warn(line);
    const bad = localObjectStore(cfg);
    bad.fallback = true;
    bad.fallbackReason = 'S3_ENDPOINT 不成形状';
    bad.fallbackLog = line;
    return bad;
  }
  const pathStyle = cfg.pathStyle === undefined ? envFlag(env, 'S3_PATH_STYLE', !/\.amazonaws\.com$/i.test(ep.host)) : cfg.pathStyle === true;
  const host = pathStyle ? ep.host : bucket + '.' + ep.host;
  const service = 's3';

  function objectPath(key) {
    const kp = s3UriEncode(String(key), true);
    return (pathStyle ? '/' + s3UriEncode(bucket, false) + '/' + kp : '/' + kp);
  }

  function requestPath(key) {
    return ep.basePath + objectPath(key);
  }

  /** 组装一次签名请求：返回 path / body / 该发出去的头（host 由 URL 带，不进请求头） */
  async function signedRequest(method, key, body, opt) {
    const o2 = opt || {};
    const path = requestPath(key);
    const bodyBytes = body === undefined || body === null ? new Uint8Array(0) : toBytes(body);
    const payloadHash = await sha256Hex(bodyBytes);
    const sign = await signAwsV4({
      method: method,
      host: host,
      path: path,
      query: o2.query || '',
      payloadHash: payloadHash,
      region: region,
      service: service,
      accessKey: accessKey,
      secretKey: secretKey,
      now: nowFn(),
      headers: o2.signHeaders || {}
    });
    const headers = { authorization: sign.authorization, 'x-amz-date': sign.amzDate, 'x-amz-content-sha256': payloadHash };
    if (o2.contentType) headers['content-type'] = String(o2.contentType);
    return { path: path, bodyBytes: bodyBytes, payloadHash: payloadHash, sign: sign, headers: headers };
  }

  function failure(e) {
    return { error: 'network_error', hint: 'S3 连不上：' + String((e && e.message) || e) };
  }

  const store = {
    driver: OBJECT_STORE.S3,
    fallback: false,
    info() {
      return { driver: OBJECT_STORE.S3, endpoint: ep.origin, bucket: bucket, region: region, pathStyle: pathStyle, host: host, publicBase: publicBase, urlTtl: urlTtl };
    },
    async put(key, bytes, opts) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const opt = opts || {};
      const req = await signedRequest('PUT', k.key, bytes, { contentType: opt.contentType });
      let res = null;
      try {
        res = await fetchFn(ep.origin + req.path, { method: 'PUT', headers: req.headers, body: req.bodyBytes });
      } catch (e) {
        return failure(e);
      }
      if (!res || !res.ok) {
        const code = res ? res.status : 0;
        return { error: 'http_error', status: code, hint: 'S3 PUT ' + req.path + ' 返回 HTTP ' + code };
      }
      const etag = res.headers && res.headers.get ? String(res.headers.get('etag') || '') : '';
      return { ok: true, key: k.key, bytes: req.bodyBytes.length, contentType: String(opt.contentType || ''), driver: OBJECT_STORE.S3, etag: etag, status: res.status };
    },
    async get(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const req = await signedRequest('GET', k.key, null, {});
      let res = null;
      try {
        res = await fetchFn(ep.origin + req.path, { method: 'GET', headers: req.headers });
      } catch (e) {
        return failure(e);
      }
      if (!res) return { error: 'network_error', hint: 'S3 GET 没有返回' };
      if (res.status === 404) return { error: 'not_found', key: k.key, hint: 'S3 上没有这个对象：' + k.key };
      if (!res.ok) return { error: 'http_error', status: res.status, hint: 'S3 GET ' + req.path + ' 返回 HTTP ' + res.status };
      const buf = await res.arrayBuffer();
      const body = new Uint8Array(buf);
      const ct = res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
      const etag = res.headers && res.headers.get ? String(res.headers.get('etag') || '') : '';
      return { ok: true, key: k.key, bytes: body, size: body.length, contentType: ct, driver: OBJECT_STORE.S3, etag: etag, status: res.status };
    },
    async delete(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return k;
      const req = await signedRequest('DELETE', k.key, null, {});
      let res = null;
      try {
        res = await fetchFn(ep.origin + req.path, { method: 'DELETE', headers: req.headers });
      } catch (e) {
        return failure(e);
      }
      if (!res) return { error: 'network_error', hint: 'S3 DELETE 没有返回' };
      if (res.status === 404) return { ok: true, key: k.key, already: true, driver: OBJECT_STORE.S3, status: 404 };
      if (!res.ok) return { error: 'http_error', status: res.status, hint: 'S3 DELETE ' + req.path + ' 返回 HTTP ' + res.status };
      return { ok: true, key: k.key, already: false, driver: OBJECT_STORE.S3, status: res.status };
    },
    async url(key) {
      const k = safeObjectKey(key);
      if (!k.ok) return '';
      if (publicBase) return publicBase + '/' + k.key;
      const path = requestPath(k.key);
      const amz = amzDateStamp(nowFn());
      const scope = amz.slice(0, 8) + '/' + region + '/' + service + '/aws4_request';
      const query =
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=' +
        encodeURIComponent(accessKey + '/' + scope) +
        '&X-Amz-Date=' +
        amz +
        '&X-Amz-Expires=' +
        urlTtl +
        '&X-Amz-SignedHeaders=host';
      const sign = await signAwsV4({
        method: 'GET',
        host: host,
        path: path,
        query: query,
        payloadHash: 'UNSIGNED-PAYLOAD',
        region: region,
        service: service,
        accessKey: accessKey,
        secretKey: secretKey,
        amzDate: amz,
        signOnly: ['host']
      });
      return ep.origin + path + '?' + query + '&X-Amz-Signature=' + sign.signature;
    }
  };
  return store;
}

/**
 * 对象存储工厂（可插拔）。
 * config: { driver?: 'local'|'s3', dir?, io?, fetch?, now?, env?, publicBase?, endpoint?, bucket?, region?, accessKey?, secretKey?, pathStyle?, urlTtl? }
 * 不给 driver 就读 env.ATTACH_STORE（默认 local）。不认识的取值 → 回落 local 并 warn 一行。
 *
 * 注意：仓库里既有的 createStore({driver:'fs'|'d1'}) 是**元数据 + 内容**的工厂，被既有测试锁死
 * （createStore() 必须回 storage_unavailable），所以对象存储另开这个名字；createStore 里也加了
 * driver:'local'|'s3' 的转发，两条路都能拿到同一个适配器。
 */
export function createObjectStore(config) {
  const cfg = config || {};
  const want = String(cfg.driver || cfg.store || envText(envOf(cfg), 'ATTACH_STORE') || OBJECT_STORE.LOCAL)
    .trim()
    .toLowerCase();
  if (want === OBJECT_STORE.S3 || want === 's3-compatible' || want === 'minio') return s3ObjectStore(cfg);
  if (want === OBJECT_STORE.LOCAL || want === 'disk' || want === 'file' || want === 'fs') return localObjectStore(cfg);
  const line = '附件存储：不认识的对象存储驱动 ' + want + '，按 local 落盘';
  if (typeof console !== 'undefined' && console.warn) console.warn(line);
  const back = localObjectStore(cfg);
  back.fallback = true;
  back.fallbackReason = '不认识的驱动 ' + want;
  back.fallbackLog = line;
  return back;
}

// ============================== 七、图片尺寸（不解码，只读头部） ==============================

function be32(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function be16(b, i) {
  return (b[i] << 8) | b[i + 1];
}

function le16(b, i) {
  return b[i] | (b[i + 1] << 8);
}

function le24(b, i) {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

/** PNG：IHDR 里的宽高（大端，偏移 16 / 20）；头部不完整给 null */
function readPngSize(b) {
  if (b.length < 24) return null;
  if (!(b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52)) return null;
  return { width: be32(b, 16), height: be32(b, 20), kind: 'png' };
}

/** GIF：逻辑屏宽高（小端，偏移 6 / 8） */
function readGifSize(b) {
  if (b.length < 10) return null;
  return { width: le16(b, 6), height: le16(b, 8), kind: 'gif' };
}

/** JPEG：扫段头找 SOF（C0-CF，跳过 C4/C8/CC），拿到高度 / 宽度；进了压缩数据还没找到就给 null */
function readJpegSize(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2;
      continue;
    }
    if (m === 0xda) return null;
    const len = be16(b, i + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { width: be16(b, i + 7), height: be16(b, i + 5), kind: 'jpeg' };
    }
    i += 2 + len;
  }
  return null;
}

/** WebP：VP8X / VP8L / VP8 三种块各自读宽高 */
function readWebpSize(b) {
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === 'VP8X') {
    if (b.length < 30) return null;
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27), kind: 'webp' };
  }
  if (fourcc === 'VP8L') {
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), kind: 'webp' };
  }
  if (fourcc === 'VP8 ') {
    if (b.length < 30) return null;
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff, kind: 'webp' };
  }
  return null;
}

/**
 * 从图片头部读宽高（不解码像素，也就不会踩解压炸弹）。认 png / jpeg / gif / webp 四种，
 * 读不出来（头部不完整、非标准、不是这几种）返回 null —— 调用方据此**转人工**，不能当不合格。
 * @returns {{width:number,height:number,kind:string}|null}
 */
export function readImageSize(value) {
  const b = toBytes(value);
  if (b.length < 10) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return readPngSize(b);
  if (b[0] === 0xff && b[1] === 0xd8) return readJpegSize(b);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return readGifSize(b);
  if (b.length >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return readWebpSize(b);
  return null;
}

// ============================== 八、人工审核（状态、自动规则、分类器、审核 DDL） ==============================

/**
 * 审核状态。与生命周期 status（pending / active / deleted）是**两条轴**：
 * 内容能不能对外看由 status 管，审没审过由 review_status 管。
 */
export const ATTACH_REVIEW = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };

/** 结论是谁下的：auto = 自动规则挡的，manual = 人工审核，classifier = 注入的分类器 */
export const ATTACH_REVIEW_SOURCE = { AUTO: 'auto', MANUAL: 'manual', CLASSIFIER: 'classifier' };

/** moderate 的 action 白名单（左边是入参，右边是落到 review_status 的值） */
export const ATTACH_REVIEW_ACTION = { approve: 'approved', reject: 'rejected' };

/**
 * 自动规则的阈值。**只管明显不合格**：自动规则给不出 approved —— 合格不等于审核通过，
 * 没人工、没分类器时一律留在 pending（不许假装审过）。
 */
export const ATTACH_REVIEW_RULES = {
  maxPx: 12000,
  maxPxLabel: '12000 px',
  maxPixels: 40000000,
  maxPixelsLabel: '4000 万',
  maxBytes: ATTACH_MAX,
  queueLimit: 50,
  queueMax: 200
};

/** 审核队列分页参数归一：limit 默认 50、上限 200；offset 负数当 0 */
function pageArgs(limit, offset) {
  let lim = Math.trunc(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) lim = ATTACH_REVIEW_RULES.queueLimit;
  if (lim > ATTACH_REVIEW_RULES.queueMax) lim = ATTACH_REVIEW_RULES.queueMax;
  let off = Math.trunc(Number(offset));
  if (!Number.isFinite(off) || off < 0) off = 0;
  return { limit: lim, offset: off };
}

/** 模块级分类器（NSFW 之类）：注入才用；返回 null / 没结论都算「没审过」 */
let CLASSIFIER = null;

/** 注入外部分类器：fn(meta, body) → {status:'approved'|'rejected', reason?} 或 'approved'/'rejected'；其它返回值视为没结论 */
export function setClassifier(fn) {
  CLASSIFIER = typeof fn === 'function' ? fn : null;
  return { ok: true, classifier: CLASSIFIER ? 'set' : 'cleared' };
}

/** 当前分类器（没注入给 null —— 调用方据此知道「不能假装审过」） */
export function getClassifier() {
  return CLASSIFIER;
}

/** 分类器返回值 → approved / rejected / null（没结论） */
function classifierVerdict(out) {
  if (out === undefined || out === null) return null;
  if (typeof out === 'string') {
    const s = out.trim().toLowerCase();
    if (s === 'approved' || s === 'approve' || s === 'ok' || s === 'pass' || s === 'safe') return ATTACH_REVIEW.APPROVED;
    if (s === 'rejected' || s === 'reject' || s === 'nsfw' || s === 'block' || s === 'blocked') return ATTACH_REVIEW.REJECTED;
    return null;
  }
  if (typeof out === 'object') {
    const s = String(out.status || '')
      .trim()
      .toLowerCase();
    if (s === 'approved' || s === 'approve' || s === 'ok' || s === 'pass' || s === 'safe') return ATTACH_REVIEW.APPROVED;
    if (s === 'rejected' || s === 'reject' || s === 'nsfw' || s === 'block' || s === 'blocked') return ATTACH_REVIEW.REJECTED;
    if (out.rejected === true || out.nsfw === true) return ATTACH_REVIEW.REJECTED;
    if (out.approved === true || out.ok === true) return ATTACH_REVIEW.APPROVED;
    return null;
  }
  return null;
}

function autoReject(out, reason) {
  out.status = ATTACH_REVIEW.REJECTED;
  out.reason = reason;
  out.note = '';
  return out;
}

/**
 * 自动规则：只看「客观不合法」，返回 {status:'rejected',reason,...} 或 {status:'pending',note,...}。
 * 读不出结论的（没给内容、图片尺寸解析不了）**留在 pending 转人工**，绝不猜 —— 自动规则永远不会给 approved。
 * @param {{filename?,mime?,bytes?}} meta 附件行（或即将插入的形状）
 * @param {Uint8Array|ArrayBuffer|string|null} [value] 内容；给了才能查魔数与尺寸
 */
export function autoReviewAttachment(meta, value) {
  const row = meta || {};
  const rules = ATTACH_REVIEW_RULES;
  const name = cleanFilename(row.filename);
  const out = {
    status: ATTACH_REVIEW.PENDING,
    reason: '',
    note: '',
    source: ATTACH_REVIEW_SOURCE.AUTO,
    name: name,
    ext: '',
    kind: '',
    size: 0,
    width: 0,
    height: 0
  };
  if (!name) return autoReject(out, '文件名不能为空');
  const ext = extOf(name);
  out.ext = ext;
  if (!ext) return autoReject(out, '附件要带扩展名，支持 ' + ATTACH_EXT_LIST.join(' / '));
  const rule = ATTACH_EXT[ext];
  if (!rule) return autoReject(out, '不支持 .' + ext + ' 这类附件，支持 ' + ATTACH_EXT_LIST.join(' / '));
  out.kind = rule.kind;
  const kind = ATTACH_KINDS[rule.kind];
  const m = mimeBase(row.mime);
  if (m && m !== 'application/octet-stream' && m !== 'binary/octet-stream' && rule.mime.indexOf(m) < 0) {
    return autoReject(out, '.' + ext + ' 的类型应为 ' + rule.mime.join(' / ') + '，浏览器报的是 ' + m);
  }
  const size = Math.trunc(Number(row.bytes) || 0);
  out.size = size;
  if (size <= 0) return autoReject(out, name + ' 是空的');
  if (size > rules.maxBytes) return autoReject(out, '附件最大 ' + ATTACH_MAX_LABEL + '，' + name + ' 有 ' + fmtSize(size));
  if (size > kind.max) return autoReject(out, kind.label + '最大 ' + kind.maxLabel + '，' + name + ' 有 ' + fmtSize(size));

  const body = value === undefined || value === null ? null : toBytes(value);
  if (!body || !body.length) {
    out.note = '没拿到内容，魔数与尺寸判不了，转人工';
    return out;
  }
  const sniffed = sniffKind(body);
  if (rule.magic) {
    if (sniffed !== rule.magic) {
      const seen = sniffed ? '，看着是 ' + (KIND_LABEL[sniffed] || sniffed) : '';
      return autoReject(out, '.' + ext + ' 的内容不像' + kind.label + '（魔数不符' + seen + '）');
    }
  } else if (sniffed) {
    return autoReject(out, name + ' 是文本附件，但内容看着是 ' + (KIND_LABEL[sniffed] || sniffed) + '，请改扩展名或换文件');
  } else if (hasNul(body)) {
    return autoReject(out, name + ' 里有 NUL 字节，像是二进制文件，不能当文本附件');
  }

  if (rule.kind === 'image') {
    const dim = readImageSize(body);
    if (!dim) {
      out.note = '图片尺寸读不出来（头部不完整或不是标准图片），转人工';
      return out;
    }
    out.width = dim.width;
    out.height = dim.height;
    if (!(dim.width > 0) || !(dim.height > 0)) return autoReject(out, '图片宽高不合法（' + dim.width + '×' + dim.height + '）');
    if (dim.width > rules.maxPx || dim.height > rules.maxPx) {
      return autoReject(out, '图片单边上限 ' + rules.maxPxLabel + '，这张 ' + dim.width + '×' + dim.height);
    }
    if (dim.width * dim.height > rules.maxPixels) {
      return autoReject(out, '图片像素总量上限 ' + rules.maxPixelsLabel + '，这张 ' + dim.width + '×' + dim.height);
    }
  }
  out.note = '自动规则没发现不合格项，等人工 / 分类器给结论';
  return out;
}

/** 审核列（SQLite 的 ADD COLUMN 不许带 datetime('now') 这类非常量默认值，所以时间列默认 ''，值由代码写） */
export const ATTACH_REVIEW_COLUMNS = [
  { name: 'review_status', ddl: "ALTER TABLE attachments ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'" },
  { name: 'review_by', ddl: 'ALTER TABLE attachments ADD COLUMN review_by INTEGER NOT NULL DEFAULT 0' },
  { name: 'review_at', ddl: "ALTER TABLE attachments ADD COLUMN review_at TEXT NOT NULL DEFAULT ''" },
  { name: 'review_reason', ddl: "ALTER TABLE attachments ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''" },
  { name: 'review_source', ddl: "ALTER TABLE attachments ADD COLUMN review_source TEXT NOT NULL DEFAULT ''" },
  { name: 'review_hidden', ddl: 'ALTER TABLE attachments ADD COLUMN review_hidden INTEGER NOT NULL DEFAULT 0' }
];

/**
 * 审核索引（每条单行：LocalD1 的 exec 是按行切的）。
 * 名字**故意不用 idx_attachments_ 前缀**：既有测试用
 * \`SELECT name FROM sqlite_master WHERE name LIKE 'idx_attachments%'\` 数出 5 条索引来锁 ATTACH_DDL，
 * 审核索引挤进那个命名空间就会把那条断言打挂（测试不许改，索引名是我们的自由）。
 */
export const ATTACH_REVIEW_DDL = [
  'CREATE INDEX IF NOT EXISTS idx_attach_review ON attachments(review_status, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_attach_review_by ON attachments(review_by, review_status)'
];

/**
 * 审核装配：基表（幂等）→ 按 PRAGMA table_info 补缺列 → 建索引。跑几次结果都一样，
 * 第一次返回值里 added 是补上的列名，之后是空数组。
 */
async function applyReviewSchema(dbh) {
  for (let i = 0; i < ATTACH_DDL.length; i++) await dbh.exec(ATTACH_DDL[i]);
  const added = [];
  const info = (await dbh.all('PRAGMA table_info(attachments)', [])) || [];
  const have = {};
  for (let i = 0; i < info.length; i++) have[String(info[i].name)] = true;
  for (let i = 0; i < ATTACH_REVIEW_COLUMNS.length; i++) {
    const col = ATTACH_REVIEW_COLUMNS[i];
    if (have[col.name]) continue;
    await dbh.exec(col.ddl);
    added.push(col.name);
  }
  for (let i = 0; i < ATTACH_REVIEW_DDL.length; i++) await dbh.exec(ATTACH_REVIEW_DDL[i]);
  return { ok: true, added: added, columns: ATTACH_REVIEW_COLUMNS.length, statements: ATTACH_DDL.length + ATTACH_REVIEW_DDL.length };
}

/** 一条连接只装配一次（并发调用共享同一个 promise；失败了把缓存清掉，下次还能重试） */
const reviewSchemaCache = new WeakMap();

function reviewSchemaOf(db, dbh) {
  const key = db && (typeof db === 'object' || typeof db === 'function') ? db : null;
  if (key && reviewSchemaCache.has(key)) {
    // 同一条连接已经装配过：这次一列都没补，added 归零（幂等对外也看得见）
    return reviewSchemaCache.get(key).then(function (r) {
      return Object.assign({}, r, { added: [] });
    });
  }
  const p = applyReviewSchema(dbh);
  if (key) {
    reviewSchemaCache.set(key, p);
    p.catch(function () {
      reviewSchemaCache.delete(key);
    });
  }
  return p;
}

/**
 * 给一条连接补审核列与索引（幂等，可重复调用）。
 * 认两种形状：node:sqlite 的 DatabaseSync（Express 线）与 D1 绑定（Worker 线，有 batch() 方法）。
 */
export async function ensureReviewSchema(db) {
  if (db && typeof db.prepare === 'function' && typeof db.batch === 'function') return reviewSchemaOf(db, d1Dbh(db));
  if (db && typeof db.prepare === 'function') return reviewSchemaOf(db, sqliteDbh(db));
  return { ok: false, error: 'bad_db', hint: 'ensureReviewSchema 要的是 node:sqlite 的 DatabaseSync 或 D1 绑定（env.DB）' };
}

