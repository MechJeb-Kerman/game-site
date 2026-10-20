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
    status: String(row.status || '')
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
    const status = threadId || postId ? ATTACH_STATUS.ACTIVE : ATTACH_STATUS.PENDING;
    const stamp = o.now === undefined ? null : localStamp(Number(o.now));
    const ins = await dbh.run(
      'INSERT INTO attachments (owner_id, thread_id, post_id, filename, mime, bytes, sha256, storage, "key", created_at, status) VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, datetime(\'now\',\'localtime\')), ?)',
      [ownerId, threadId, postId, checked.name, checked.mime || '', body.length, sha, driver, key, stamp, status]
    );
    st.saves++;
    st.bytes += body.length;
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
    ensure: ensure
  };
}

/** node:sqlite 那套 API → 统一的 dbh（run 要给回 lastInsertRowid / changes） */
function sqliteDbh(db) {
  return {
    async ensure() {
      if (ensuredDbs.has(db)) return;
      for (let i = 0; i < ATTACH_DDL.length; i++) db.exec(ATTACH_DDL[i]);
      ensuredDbs.add(db);
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
}

/** D1 那套 API → 统一的 dbh（db 首参、全 await、meta 里取 id/changes） */
function d1Dbh(db) {
  function stmt(sql, params) {
    const s = db.prepare(sql);
    return params && params.length ? s.bind.apply(s, params) : s;
  }
  return {
    async ensure() {
      if (ensuredDbs.has(db)) return;
      for (let i = 0; i < ATTACH_DDL.length; i++) await db.exec(ATTACH_DDL[i]);
      ensuredDbs.add(db);
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
