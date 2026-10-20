/**
 * 真实位图 OG 图：把 src/cards.js 的 1200x630 SVG 分享卡栅格化成 PNG。
 *
 * 背景：微信 / X 这类客户端只认位图（PNG / JPEG），SVG 分享卡它们不认。所以站的 OG 图要
 * 「能出位图就给位图，出不来就回退到既有的 card.svg」——可配置 + 可回退。
 *
 * 设计基准跟着 src/search.js 走：**可配置 + 可回退 + 绝不抛错**
 *   - 不读隐式全局：时钟（now）、子进程（spawn）、网络（fetch）、临时目录（tmpDir）都能注入，
 *     测试不用碰真环境；
 *   - 环境变量只在没传参时兜底：CHROME_PATH / EDGE_PATH / CLOUDFLARE_BROWSER_RENDERING_URL /
 *     BROWSER_RENDERING_URL / BROWSER_RENDERING_TOKEN；
 *   - png() 任何失败都只返回 { ok:false, error }，绝不 throw；失败计数进 stats()。
 *
 * 两条线共用同一个文件：
 *   - Node / Express 线（server.js）：driver 'auto'（默认）或 'chrome'，用本机 Chrome / Edge
 *     无头截图。找不到浏览器时 error = 'no_browser'（auto 下是 'not_configured'），调用方回退 SVG。
 *   - Cloudflare Workers 线（worker/app.js）：Workers 里没有 child_process、没有本机浏览器，
 *     必须显式 driver:'browser'，走 Browser Rendering 之类的渲染端点；没配端点时
 *     error = 'not_configured'，同样回退 SVG。
 *
 * 结果契约：真 PNG（魔数 137 80 78 71 13 10 26 10），尺寸随请求（默认 1200x630，用 IHDR 解析核对，
 * 不符只计数不失败），体积目标 < 400 KB（超了只在结果与 stats 里标 oversized，不自动降质——
 * 降质要换参数，那得让人看得见）。
 *
 * 错误码（png() 只会回这几种，调用方按它决定回退姿势）：
 *   invalid_svg    入参不是非空字符串
 *   bad_size       宽或高越界（16..4096）
 *   no_browser     driver:'chrome' 但本机没有可用的 Chrome / Edge
 *   not_configured driver:'auto' 没探测到浏览器，或 driver:'browser' 没配渲染端点
 *   spawn_failed   子进程起不来（路径错、权限不足）
 *   timeout        渲染超时（自己 spawn 的子进程已杀干净）
 *   no_output      浏览器退出了但没留下截图文件
 *   render_failed  渲染端点报错（带 status；网络异常 status = 0）
 *   bad_png        拿到字节了但不是 PNG（端点配错、返回 HTML 之类）
 *
 * 预生成（可选，离线把热门卡先栅格化好，省掉首次请求的现场渲染）：
 *   createRasterizer({ pregen: true }) 或 { pregen: { dir: '<仓库>/public/og' } } 之后，png() 会先按
 *   ogFileName(kind, key) 去那个目录找离线生成的 PNG（tools/gen-og.mjs 产出，附 manifest.json）：
 *   文件在、是合法 PNG、尺寸也对 → 直接用它（driver 'pregen'，不进内存缓存，文件就是最新真相）；
 *   缺失 / 损坏 / 尺寸不符 → 静默回落现场栅格化；现场也失败 → 调用方照旧回落 card.svg。
 *   所以预生成只是「少渲染几次」的加速层，不改变任何回退语义。目录默认按仓库根的
 *   public/og，也可用 pregenRoot 或环境变量 OG_PREGEN_ROOT 指定基准目录。
 *
 * 典型用法：
 *   import { createRasterizer, ogMeta } from './og.js';
 *   const rz = createRasterizer();                        // Node 线（auto -> chrome）
 *   const rz = createRasterizer({ driver: 'browser' });   // Workers 线
 *   const rz = createRasterizer({ pregen: true });        // 挂了预生成目录（Node 线）
 *   const r = await rz.png({ kind: 'replay', key: id, svg });
 *   const w = await rz.warm();                            // 预热：{ total, ok, failed }
 *   const ogImage = ogMeta(origin, 'replay', id, { png: r.ok });
 *   // Express: res.setHeader('Content-Type', 'image/png').send(Buffer.from(r.bytes))
 *   // Workers: new Response(r.bytes, { headers: { 'content-type': 'image/png' } })
 */

/* ================================ 常量 ================================ */

export const PNG_MAGIC = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 缓存 6 小时
export const DEFAULT_MAX_ENTRIES = 64; // LRU 条目上限
export const DEFAULT_TIMEOUT_MS = 20000; // 单次渲染 20 秒
export const OVERSIZE_BYTES = 400 * 1024; // 体积目标线 400 KB

// 三种分享卡的路由形状：主理人照这个加 /og.png 路由，ogMeta 也从这里填参数（单一出处）。
//   replay  ->  /play/:id/card.svg   |  /play/:id/og.png
//   profile ->  /u/:name/card.svg    |  /u/:name/og.png
//   daily   ->  /daily/card.svg      |  /daily/og.png
export const OG_ROUTES = Object.freeze({
  replay: { svg: '/play/:id/card.svg', png: '/play/:id/og.png' },
  profile: { svg: '/u/:name/card.svg', png: '/u/:name/og.png' },
  daily: { svg: '/daily/card.svg', png: '/daily/og.png' }
});

// 两条线各自要用的 Content-Type（PNG 线别再用 svg 那个，浏览器 / 爬虫会认错）。
export const OG_CONTENT_TYPE = Object.freeze({
  png: 'image/png',
  svg: 'image/svg+xml; charset=utf-8'
});

// 本机浏览器候选路径：Windows 顺序照 tools/pwa-test.mjs，另附 macOS / Linux 常见位置。
// 环境变量 CHROME_PATH / EDGE_PATH 会插到最前面（tools/og-detect.mjs 也用这份表）。
export const BROWSER_CANDIDATES = Object.freeze([
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
]);

// 环境变量覆盖（CHROME_PATH / EDGE_PATH）插到候选表最前面，去重保序。
// 探测顺序只有这一处出处：createRasterizer 的 resolveBrowser() 与 tools/og-detect.mjs 都用它，
// 免得「脚本说有、代码说没有」这种口径分歧。
export function browserCandidates(env) {
  const e = env || {};
  const head = [firstNonEmpty(e.CHROME_PATH), firstNonEmpty(e.EDGE_PATH)].filter(Boolean);
  const out = [];
  const seen = new Set();
  const all = head.concat(BROWSER_CANDIDATES);
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// kind 别名：主理人如果按 views.js 的口径传 'play' / 'user' 也能认。
const KIND_ALIAS = Object.freeze({
  replay: 'replay',
  play: 'replay',
  profile: 'profile',
  user: 'profile',
  u: 'profile',
  daily: 'daily',
  day: 'daily'
});

/* ============================== 小工具 ============================== */

function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  return String(err);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function firstNonEmpty() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// Node 全局 Buffer 的保护判断：Workers 里没有它，直接引用会 ReferenceError。
function hasBuffer() {
  return typeof Buffer !== 'undefined' && Buffer !== null && typeof Buffer.from === 'function';
}

function utf8Bytes(text) {
  const s = String(text);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
  if (hasBuffer()) return new Uint8Array(Buffer.from(s, 'utf8'));
  return new Uint8Array(0);
}

function toBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value.buffer && typeof value.byteLength === 'number') {
    try { return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength); } catch (err) { return null; }
  }
  return null;
}

function bytesToBase64(bytes) {
  const b = toBytes(bytes);
  if (!b || !b.length) return '';
  if (typeof btoa === 'function') {
    try {
      let bin = '';
      const CHUNK = 0x8000; // 分块，免得 apply 参数过多爆栈
      for (let i = 0; i < b.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    } catch (err) { /* 落到 Buffer 分支 */ }
  }
  if (hasBuffer()) return Buffer.from(b).toString('base64');
  return '';
}

// Node 内置模块懒加载：用变量拼 specifier，打包器（wrangler / esbuild）无法静态解析，
// Workers 上 import 会失败并被吞掉——那边本来也不该走 chrome 驱动。
const nodeModuleCache = new Map();
async function loadNode(name) {
  if (nodeModuleCache.has(name)) return nodeModuleCache.get(name);
  let mod = null;
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  if (isNode) {
    const spec = 'node:' + name;
    try { mod = await import(spec); } catch (err) { mod = null; }
  }
  nodeModuleCache.set(name, mod);
  return mod;
}

/* ============================ PNG / HTML ============================ */

// 解析 PNG 的 IHDR：不是 PNG（或太短）回 null，否则回 { width, height }。
export function pngSize(bytes) {
  const b = toBytes(bytes);
  if (!b || b.length < 24) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_MAGIC[i]) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // 'IHDR'
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function isPng(bytes) {
  return pngSize(bytes) !== null;
}

// 最小 HTML 外壳：SVG 走 data:image/svg+xml;base64, 塞进 <img>，画布固定成 width x height。
// 为什么用 img 而不是把 SVG 内联进 DOM：内联时页面里的 CSS 会渗进 SVG（栅格化出来和爬虫
// 直接看 SVG 的结果不一致），套 <img> 是隔离的，SVG 看到的就是它自己。
export function svgToHtml(svg, width, height) {
  const w = intOr(width, OG_WIDTH);
  const h = intOr(height, OG_HEIGHT);
  const b64 = bytesToBase64(utf8Bytes(String(svg)));
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>OG 分享卡</title>'
    + '<style>html,body{margin:0;padding:0;background:#0b1220;}'
    + 'body{width:' + w + 'px;height:' + h + 'px;overflow:hidden;}'
    + 'img{display:block;width:' + w + 'px;height:' + h + 'px;}</style></head>'
    + '<body><img width="' + w + '" height="' + h + '" alt="分享卡" src="data:image/svg+xml;base64,' + b64 + '"></body></html>';
}

/* ============================== ogMeta ============================== */

// 把一个路径模板里的第一段 :id / :name 换成实际值（空值就把整段删掉）。
function fillPath(template, segment) {
  const head = template.indexOf(':');
  if (head < 0) return template;
  let end = head;
  while (end < template.length && template.charAt(end) !== '/') end++; // 跳过 :id / :name 到下一个斜杠
  const filled = template.slice(0, head) + segment + template.slice(end);
  return segment ? filled : filled.replaceAll('//', '/'); // 空 id：整段去掉，别留 // 双斜杠
}

/**
 * 算这条分享卡的 OG 图地址（纯函数，无副作用）。
 *
 *   ogMeta('https://example.com', 'replay', 12, { png: true })
 *     -> 'https://example.com/play/12/og.png'
 *   ogMeta('https://example.com', 'profile', 'alice', {})
 *     -> 'https://example.com/u/alice/card.svg'
 *   ogMeta('https://example.com', 'daily', null, { png: true })
 *     -> 'https://example.com/daily/og.png'
 *
 * kind 认 replay / play、profile / user、daily / day；认不出来的 kind 回空串（调用方自己
 * 回退站内默认 OG 图 origin + '/static/img/og.svg'）。origin 末尾的斜杠会被吃掉。
 * 不传 png（或 png 假）时回既有的 card.svg 路径，所以「栅格化能力没就绪」这条路上，
 * 视图层行为跟现在完全一致。
 */
export function ogMeta(origin, kind, id, opts) {
  const key = KIND_ALIAS[String(kind === undefined || kind === null ? '' : kind).trim().toLowerCase()];
  if (!key) return '';
  const route = OG_ROUTES[key];
  const wantPng = !!(opts && opts.png);
  const template = wantPng ? route.png : route.svg;
  const segment = route.svg.indexOf(':') < 0 ? '' : encodeURIComponent(String(id === undefined || id === null ? '' : id));
  let base = String(origin === undefined || origin === null ? '' : origin);
  while (base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  return base + fillPath(template, segment);
}

/* ===================== 预生成清单（public/og） ===================== */

// 离线预生成（tools/gen-og.mjs）与线上读取（createRasterizer 的 pregen 选项）共用一套
// 「key → 文件名 → 清单条目」的口径，两边都从这里取，免得各写一份慢慢漂移。
//
// 为什么文件名要自己算：profile 的 key 是用户名，可能是中文 / 空格 / emoji / 各种标点，
// 直接当文件名在 Windows 上会炸（\ / : * ? " < > | 都是非法字符），而且 og/ 是静态目录，
// URL 里还得再编码一层，不如落盘时就换算成 ASCII 安全名。
export const OG_PREGEN_DIR = 'public/og'; // 相对仓库根；tools/gen-og.mjs 就落这里
export const OG_MANIFEST_NAME = 'manifest.json';
export const OG_PREGEN_VERSION = 1;
export const OG_PREGEN_KINDS = Object.freeze(['replay', 'daily', 'profile']);

// FNV-1a 32 位（16 进制 8 位）：Workers 上不能碰 node:crypto，这里只是「同名兜底」，
// 不当安全哈希用。
function fnv1aHex(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// kind 归一到 replay / profile / daily（play / user / u / day 也认，与 ogMeta 同一张嘴）。
export function ogKindName(kind) {
  const raw = String(kind === undefined || kind === null ? '' : kind).trim().toLowerCase();
  return KIND_ALIAS[raw] || raw || 'card';
}

// 清单条目的主键，与栅格化缓存 key 的前两段同形：'replay:12'。
export function ogPregenKey(kind, key) {
  return ogKindName(kind) + ':' + String(key === undefined || key === null ? '' : key);
}

/**
 * key → 预生成文件名（纯函数，确定性）。
 *
 *   ogFileName('replay', 12)      -> 'replay-12.png'
 *   ogFileName('play', '12')      -> 'replay-12.png'（别名归一）
 *   ogFileName('profile', '张三')  -> 'profile-__~3f2a1b0c.png'（换掉非法字符 + 短哈希防撞名）
 *
 * 规则：[A-Za-z0-9._-] 之外一律换成 '_'（连续一段合成一个 '_'）；只要换过（或截断过）就追加
 * '~' + 8 位 FNV-1a，原文参与哈希，所以「张三」「张 三」这类不会撞名。用 '~' 当分隔是因为它
 * 自己会被换成 '_'——干净 key 的文件名里永远不出现 '~'，两种形态不可能同名。
 * 先截到 48 字符再补哈希；开头 / 结尾的 '.' '_' 去掉（Windows 上那是非法名）。
 */
export function ogFileName(kind, key) {
  const k = ogKindName(kind);
  const raw = String(key === undefined || key === null ? '' : key);
  let base = raw.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (base.length > 48) base = base.slice(0, 48);
  base = base.replace(/^[._]+/, '').replace(/[._]+$/, '');
  if (!base) base = 'card';
  const changed = base !== raw;
  return k + '-' + base + (changed ? '~' + fnv1aHex(k + ':' + raw) : '') + '.png';
}

// 目录参数归一：绝对路径原样用；相对路径按 root 解（默认 cwd，OG_PREGEN_ROOT 可覆盖）。
function resolveDir(pathMod, raw, root) {
  const dir = String(raw === undefined || raw === null ? '' : raw);
  if (!dir || !pathMod) return dir;
  try {
    if (typeof pathMod.isAbsolute === 'function' && pathMod.isAbsolute(dir)) return dir;
  } catch (err) { /* 当相对路径处理 */ }
  let base = String(root === undefined || root === null ? '' : root);
  if (!base && typeof process !== 'undefined' && process.cwd) {
    try { base = process.cwd(); } catch (err) { base = ''; }
  }
  if (!base) return dir;
  try { return pathMod.resolve(base, dir); } catch (err) { return dir; }
}

/**
 * 组装清单（纯函数）：条目按 key 排序、同 key 后者覆盖前者，顶层再带一份整体指纹。
 * opts: { generatedAt, dir, width, height }
 * 条目字段（逐字）：{ key, kind, id, file, bytes, width, height, revision, source, generatedAt }
 *   revision = 来源指纹（生成这张图那份 SVG 的短哈希）：源变了它才变，--check 靠它发现
 *   「源已变、该重新生成」。
 */
export function buildOgManifest(entries, opts) {
  const o = opts || {};
  const at = String(o.generatedAt || new Date().toISOString());
  const defW = intOr(o.width, OG_WIDTH);
  const defH = intOr(o.height, OG_HEIGHT);
  const byKey = new Map();
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    const kind = ogKindName(e.kind);
    const id = String(e.id === undefined || e.id === null ? '' : e.id);
    const key = String(e.key === undefined || e.key === null ? '' : e.key) || (kind + ':' + id);
    byKey.set(key, {
      key: key,
      kind: kind,
      id: id,
      file: String(e.file === undefined || e.file === null ? '' : e.file) || ogFileName(kind, id || key),
      bytes: Math.max(0, intOr(e.bytes, 0)),
      width: intOr(e.width, defW),
      height: intOr(e.height, defH),
      revision: String(e.revision === undefined || e.revision === null ? '' : e.revision),
      source: String(e.source === undefined || e.source === null ? '' : e.source),
      generatedAt: String(e.generatedAt || at)
    });
  }
  const sorted = Array.from(byKey.values()).sort(function (a, b) {
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });
  let total = 0;
  for (let i = 0; i < sorted.length; i++) total += sorted[i].bytes;
  return {
    version: OG_PREGEN_VERSION,
    generatedAt: at,
    dir: String(o.dir || OG_PREGEN_DIR),
    width: defW,
    height: defH,
    count: sorted.length,
    bytes: total,
    fingerprint: fnv1aHex(sorted.map(function (e) { return e.key + '@' + e.revision; }).join('|')),
    entries: sorted
  };
}

/**
 * 清单比对（纯函数）：回问题清单，空数组 = 一致。generatedAt 不参与比对（与 gen-precache 同口径）。
 *   oldManifest  磁盘上读到的清单对象
 *   fresh        现在「应该」有的条目（key / kind / id / file / revision，bytes 可缺）
 *   opts.disk    { 文件名: 磁盘字节数 }：查文件缺失与字节数不符
 *   opts.files   目录里的 *.png 文件名数组：查清单外的多余文件
 */
export function diffOgManifest(oldManifest, fresh, opts) {
  const o = opts || {};
  const problems = [];
  const man = oldManifest;
  if (!man || typeof man !== 'object' || Array.isArray(man)) return ['清单不存在或不是 JSON 对象'];
  if (intOr(man.version, 0) !== OG_PREGEN_VERSION) {
    problems.push('version 不一致：磁盘 ' + intOr(man.version, 0) + ' / 现状 ' + OG_PREGEN_VERSION);
  }
  if (!Array.isArray(man.entries)) {
    problems.push('清单缺少 entries 数组');
    return problems;
  }
  const oldByKey = new Map();
  for (let i = 0; i < man.entries.length; i++) {
    const e = man.entries[i] || {};
    const key = String(e.key || '');
    if (key) oldByKey.set(key, e);
  }
  const freshByKey = new Map();
  const freshList = Array.isArray(fresh) ? fresh : [];
  for (let i = 0; i < freshList.length; i++) {
    const e = freshList[i] || {};
    const kind = ogKindName(e.kind);
    const id = String(e.id === undefined || e.id === null ? '' : e.id);
    const key = String(e.key || '') || ogPregenKey(kind, id);
    freshByKey.set(key, {
      key: key,
      file: String(e.file || '') || ogFileName(kind, id || key),
      revision: String(e.revision || '')
    });
  }
  for (const pair of freshByKey) {
    const key = pair[0];
    const fe = pair[1];
    const oe = oldByKey.get(key);
    if (!oe) { problems.push('新增条目（源里有、清单里没有，跑生成补上）：' + key); continue; }
    const of = String(oe.file || '');
    if (of !== fe.file) problems.push('文件名不一致：' + key + '（清单 ' + of + ' / 现状 ' + fe.file + '）');
    const orv = String(oe.revision || '');
    if (orv !== fe.revision) problems.push('来源已变（要重新生成）：' + key + '（' + orv + ' → ' + fe.revision + '）');
  }
  for (const pair of oldByKey) {
    if (!freshByKey.has(pair[0])) problems.push('多余条目（源里已经没有了）：' + pair[0]);
  }
  const disk = o.disk;
  if (disk && typeof disk === 'object') {
    for (const pair of oldByKey) {
      const oe = pair[1];
      const file = String(oe.file || '');
      if (!file) continue;
      if (!Object.prototype.hasOwnProperty.call(disk, file)) {
        problems.push('文件缺失：' + file + '（清单 ' + intOr(oe.bytes, 0) + ' 字节）');
        continue;
      }
      const want = intOr(oe.bytes, 0);
      const actual = intOr(disk[file], -1);
      if (actual !== want) problems.push('文件字节数不符：' + file + '（清单 ' + want + ' / 磁盘 ' + actual + '）');
    }
  }
  if (Array.isArray(o.files)) {
    const known = new Set();
    for (const pair of oldByKey) known.add(String(pair[1].file || ''));
    for (let i = 0; i < o.files.length; i++) {
      const f = String(o.files[i] || '');
      if (f && !known.has(f)) problems.push('多余文件（清单里没有）：' + f);
    }
  }
  return problems;
}

/**
 * 读预生成清单。
 *   回 { ok:true, manifest, file }
 *    | { ok:false, error:'no_fs' | 'no_manifest' | 'bad_json' | 'bad_shape', file, detail }
 * opts: { dir, name, root, fs, path, manifest }（manifest 直接给对象就跳过读盘）
 * 注意 no_manifest 与 bad_json 是两个不同的错：前者是「还没生成过」，后者是「清单被写坏了」。
 */
export async function readOgManifest(opts) {
  const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : { dir: opts };
  const pathMod = o.path || await loadNode('path');
  const fs = o.fs || await loadNode('fs');
  const dir = resolveDir(pathMod, firstNonEmpty(o.dir, OG_PREGEN_DIR), o.root);
  const name = firstNonEmpty(o.name, OG_MANIFEST_NAME);
  const file = pathMod ? pathMod.join(dir, name) : dir + '/' + name;
  if (o.manifest && typeof o.manifest === 'object' && !Array.isArray(o.manifest)) {
    return { ok: true, manifest: o.manifest, file: file };
  }
  if (!fs || !fs.promises) return { ok: false, error: 'no_fs', file: file };
  let text = '';
  try { text = await fs.promises.readFile(file, 'utf8'); }
  catch (err) { return { ok: false, error: 'no_manifest', file: file, detail: errText(err) }; }
  let manifest = null;
  try { manifest = JSON.parse(String(text)); }
  catch (err) { return { ok: false, error: 'bad_json', file: file, detail: errText(err) }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'bad_shape', file: file };
  }
  if (!Array.isArray(manifest.entries)) {
    return { ok: false, error: 'bad_shape', file: file, detail: 'entries 不是数组' };
  }
  return { ok: true, manifest: manifest, file: file };
}

/**
 * 预热：把清单里的 key 依次读一遍（校验 PNG 魔数与清单里的尺寸），回统计。
 *   -> { dir, file, version, total, ok, failed, bytes, entries:[{key,file,ok,bytes,width,height,error}] }
 * 若读不到清单，回 { total:0, ok:0, failed:0, error:'no_manifest'|'no_fs'|… }。
 * 只读：不写文件、不动栅格化器的内存缓存（线上请求走 pregen 直读文件，本来就是最新真相）。
 * 逐条 error 码：missing（文件不在）/ bad_png（不是合法 PNG）/ size_mismatch（尺寸与清单不符）。
 */
export async function warmOgPregen(opts) {
  const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : { dir: opts };
  const pathMod = o.path || await loadNode('path');
  const fs = o.fs || await loadNode('fs');
  const dir = resolveDir(pathMod, firstNonEmpty(o.dir, OG_PREGEN_DIR), o.root);
  const empty = { dir: dir, file: '', version: 0, total: 0, ok: 0, failed: 0, bytes: 0, entries: [] };
  if (!fs || !fs.promises || !pathMod) return Object.assign(empty, { error: 'no_fs' });
  const info = await readOgManifest({ dir: dir, name: o.name, root: o.root, fs: fs, path: pathMod, manifest: o.manifest });
  if (!info.ok) return Object.assign(empty, { file: info.file || '', error: info.error, detail: info.detail });
  const manifest = info.manifest;
  const list = Array.isArray(manifest.entries) ? manifest.entries : [];
  const results = [];
  let ok = 0, failed = 0, bytes = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    const key = String(e.key || '') || ogPregenKey(e.kind, e.id);
    const id = (e.id === undefined || e.id === null || e.id === '') ? key : e.id;
    const file = String(e.file || '') || ogFileName(e.kind, id);
    const abs = pathMod.join(dir, file);
    let buf = null;
    try { buf = await fs.promises.readFile(abs); }
    catch (err) {
      failed++;
      results.push({ key: key, file: file, ok: false, error: 'missing', detail: errText(err) });
      continue;
    }
    const u8 = toBytes(buf);
    const size = pngSize(u8);
    if (!size) {
      failed++;
      results.push({ key: key, file: file, ok: false, error: 'bad_png' });
      continue;
    }
    const wantW = intOr(e.width, 0);
    const wantH = intOr(e.height, 0);
    if ((wantW && size.width !== wantW) || (wantH && size.height !== wantH)) {
      failed++;
      results.push({ key: key, file: file, ok: false, error: 'size_mismatch', width: size.width, height: size.height });
      continue;
    }
    ok++;
    bytes += u8.length;
    results.push({ key: key, file: file, ok: true, bytes: u8.length, width: size.width, height: size.height });
  }
  return {
    dir: dir, file: info.file, version: intOr(manifest.version, 0),
    total: list.length, ok: ok, failed: failed, bytes: bytes, entries: results
  };
}

/* ============================ 栅格化器 ============================ */

/**
 * createRasterizer(opts) -> { png, stats, clear, browserPath, warm }
 *
 * opts 全部可选：
 *   driver     'auto'（默认，Node 线）| 'chrome' | 'browser'（Workers 线）
 *   ttlMs      缓存存活毫秒，默认 6 小时；<= 0 表示不缓存
 *   maxEntries 缓存条目上限，默认 64，超出按 LRU 淘汰最久没命中的
 *   timeoutMs  单次渲染超时，默认 20 秒
 *   endpoint   渲染端点 URL（覆盖 BROWSER_RENDERING_URL / CLOUDFLARE_BROWSER_RENDERING_URL）
 *   token      渲染端点 token（覆盖 BROWSER_RENDERING_TOKEN，走 Authorization: Bearer）
 *   chromePath 指定浏览器可执行文件（覆盖 CHROME_PATH / EDGE_PATH 与候选表）
 *   env        环境变量来源，默认 process.env（Workers 上显式传 ctx.env 更清楚）
 *   now        时钟注入，默认 Date.now
 *   fetch      网络注入，默认全局 fetch
 *   spawn      子进程注入，默认 node:child_process.spawn
 *   tmpDir     临时文件根目录，默认 os.tmpdir()
 *   pregen     预生成 PNG 的优先读取路径：false（默认，关）| true（默认目录）| 目录字符串 |
 *              { dir, name, fs, path }；相对目录按 pregenRoot 解
 *   pregenRoot pregen 目录的基准目录（默认 cwd，可被环境变量 OG_PREGEN_ROOT 覆盖）
 *   browserCandidates / browserExists  浏览器探测的注入点（测试用）
 *   fs / os / path                     文件系统相关注入点（一般不用）
 *
 * png() 命中预生成文件时多回三个字段：source:'pregen'、pregen:true、file（文件名）；命中缓存
 * 与现场渲染的返回形状一个字没动（既有调用方与测试不受影响）。
 */
export function createRasterizer(opts) {
  const o = opts || {};
  const env = o.env || (typeof process !== 'undefined' && process.env ? process.env : {});
  const driverWanted = firstNonEmpty(o.driver, 'auto').toLowerCase();
  const ttlMs = intOr(o.ttlMs, DEFAULT_TTL_MS);
  const maxEntries = Math.max(1, intOr(o.maxEntries, DEFAULT_MAX_ENTRIES));
  const timeoutMs = Math.max(1, intOr(o.timeoutMs, DEFAULT_TIMEOUT_MS));
  const nowFn = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
  const spawnImpl = typeof o.spawn === 'function' ? o.spawn : null;
  const fetchImpl = typeof o.fetch === 'function' ? o.fetch : null;
  const endpoint = firstNonEmpty(o.endpoint, o.renderUrl, env.CLOUDFLARE_BROWSER_RENDERING_URL, env.BROWSER_RENDERING_URL);
  const token = firstNonEmpty(o.token, env.BROWSER_RENDERING_TOKEN);
  const explicitBrowser = firstNonEmpty(o.chromePath, env.CHROME_PATH, env.EDGE_PATH);
  const candidates = Array.isArray(o.browserCandidates) ? o.browserCandidates : BROWSER_CANDIDATES;
  const tmpDirWanted = firstNonEmpty(o.tmpDir);
  const existsImpl = typeof o.browserExists === 'function' ? o.browserExists : null;
  // 预生成目录：false / 不给 = 关；true = 默认目录；字符串 = 目录；对象 = { dir, name, fs, path }
  const pregenConf = (function () {
    const p = o.pregen;
    if (!p) return null;
    if (p === true) return { dir: OG_PREGEN_DIR, name: OG_MANIFEST_NAME, fs: null, path: null };
    if (typeof p === 'string') return { dir: p, name: OG_MANIFEST_NAME, fs: null, path: null };
    if (typeof p === 'object') {
      const dir = firstNonEmpty(p.dir, p.directory);
      if (!dir) return null;
      return { dir: dir, name: firstNonEmpty(p.name, OG_MANIFEST_NAME), fs: p.fs || null, path: p.path || null };
    }
    return null;
  })();
  const pregenRootOpt = firstNonEmpty(o.pregenRoot, env.OG_PREGEN_ROOT);
  let pregenDirResolved = '';

  const cache = new Map(); // cacheKey -> { bytes, at, driver, bytesLen, oversized }
  const st = {
    hits: 0, misses: 0, renders: 0, failures: 0,
    oversized: false, oversizedCount: 0, evictions: 0, expired: 0, clears: 0, sizeMismatch: 0,
    pregenHits: 0, pregenMisses: 0, pregenInvalid: 0, pregenSizeSkip: 0, pregenDir: '', pregenLastFile: '',
    lastError: '', driverUsed: '', lastBytes: 0, lastSize: null
  };
  let browserChecked = false;
  let browserResolved = '';
  let cpRef = null; // 真子进程模块：只在「自己 spawn」时才拿它做 taskkill 兜底

  function fail(error, status) {
    st.failures++;
    st.lastError = error;
    const out = { ok: false, error: error };
    if (status !== undefined && status !== null) out.status = status;
    return out;
  }

  async function ensureDeps() {
    const deps = {
      fs: o.fs || await loadNode('fs'),
      os: o.os || await loadNode('os'),
      path: o.path || await loadNode('path')
    };
    if (!deps.fs || !deps.os || !deps.path) return null;
    if (!deps.fs.promises) return null;
    return deps;
  }

  async function defaultExists(p) {
    const fs = o.fs || await loadNode('fs');
    if (!fs || typeof fs.existsSync !== 'function') return false;
    try { return !!fs.existsSync(p); } catch (err) { return false; }
  }

  // 预生成目录（惰性解析一次）：给了绝对路径就用它，相对路径按 pregenRoot / cwd 解。
  async function ensurePregenDir() {
    if (!pregenConf) return '';
    if (pregenDirResolved) return pregenDirResolved;
    const pathMod = pregenConf.path || o.path || await loadNode('path');
    pregenDirResolved = resolveDir(pathMod, pregenConf.dir, pregenRootOpt);
    st.pregenDir = pregenDirResolved;
    return pregenDirResolved;
  }

  // 读一份预生成文件。任何异常（不在 / 不是 PNG / 尺寸不符）都只回 reason 交给调用方回落，
  // 绝不 throw —— 预生成永远只是加速层。
  async function readPregen(kind, key, width, height) {
    const dir = await ensurePregenDir();
    if (!dir) return { ok: false, reason: 'disabled' };
    const fs = pregenConf.fs || o.fs || await loadNode('fs');
    const pathMod = pregenConf.path || o.path || await loadNode('path');
    if (!fs || !fs.promises || !pathMod) return { ok: false, reason: 'no_fs' };
    const file = ogFileName(kind, key);
    let buf = null;
    try { buf = await fs.promises.readFile(pathMod.join(dir, file)); }
    catch (err) { return { ok: false, reason: 'missing', file: file, detail: errText(err) }; }
    const bytes = toBytes(buf);
    const size = pngSize(bytes);
    if (!size) return { ok: false, reason: 'invalid', file: file };
    if (size.width !== width || size.height !== height) {
      return { ok: false, reason: 'size', file: file, pngWidth: size.width, pngHeight: size.height };
    }
    return { ok: true, file: file, bytes: bytes, bytesLen: bytes.length, pngWidth: size.width, pngHeight: size.height };
  }

  // 预热：把这份栅格化器认的预生成目录按清单读一遍（统计口径见 warmOgPregen）。
  async function warm(opts2) {
    if (!pregenConf) {
      return { dir: '', file: '', version: 0, total: 0, ok: 0, failed: 0, bytes: 0, entries: [], error: 'pregen_disabled' };
    }
    const oo = opts2 || {};
    return await warmOgPregen({
      dir: oo.dir || await ensurePregenDir(),
      name: oo.name || pregenConf.name,
      root: pregenRootOpt,
      fs: oo.fs || pregenConf.fs || o.fs,
      path: oo.path || pregenConf.path || o.path,
      manifest: oo.manifest
    });
  }

  // 探测本机浏览器：显式路径（参数 / CHROME_PATH / EDGE_PATH）优先，然后候选表。
  async function resolveBrowser() {
    if (browserChecked) return browserResolved;
    browserChecked = true;
    const exists = existsImpl || defaultExists;
    const list = explicitBrowser
      ? [explicitBrowser].concat(candidates.filter(function (p) { return p !== explicitBrowser; }))
      : candidates;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      if (await exists(p)) { browserResolved = p; break; }
    }
    return browserResolved;
  }

  function readCache(cacheKey, atMs) {
    const entry = cache.get(cacheKey);
    if (!entry) return null;
    if (!(ttlMs > 0) || atMs - entry.at > ttlMs) {
      cache.delete(cacheKey);
      st.expired++;
      return null;
    }
    cache.delete(cacheKey); // 命中挪到队尾 = 最近使用
    cache.set(cacheKey, entry);
    return entry;
  }

  function writeCache(cacheKey, entry) {
    if (!(ttlMs > 0)) return; // 不缓存模式
    if (cache.has(cacheKey)) cache.delete(cacheKey);
    cache.set(cacheKey, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
      st.evictions++;
    }
  }

  // 只杀自己 spawn 的那个进程树（仓库铁律：禁止按映像名全局杀浏览器）。
  // tree 只在「确实是我们用真 spawn 起的」时为真——注入假 spawn 的测试里不去动系统进程。
  function killTree(child, tree) {
    if (!child) return;
    if (tree && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { /* 组杀不成就单杀 */ }
    }
    try { if (typeof child.kill === 'function') child.kill('SIGKILL'); } catch (err) { /* 已退出 */ }
    if (tree && process.platform === 'win32' && child.pid && cpRef && typeof cpRef.spawn === 'function') {
      // Windows 上 child.kill() 只杀到启动器，Chrome 的子进程要靠 taskkill /T 带下去；
      // 只针对我们自己的 pid，绝不按映像名杀。
      try {
        cpRef.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (err) { /* 忽略 */ }
    }
  }

  function runProcess(spawnFn, bin, args, tree) {
    return new Promise(function (resolve) {
      let child = null;
      let settled = false;
      let timer = null;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }
      try {
        child = spawnFn(bin, args, {
          stdio: 'ignore',
          windowsHide: true,
          detached: process.platform !== 'win32'
        });
      } catch (err) {
        return finish({ ok: false, error: 'spawn_failed', detail: errText(err) });
      }
      if (!child || typeof child.on !== 'function') {
        return finish({ ok: false, error: 'spawn_failed', detail: 'spawn 返回的不是子进程' });
      }
      timer = setTimeout(function () {
        killTree(child, tree);
        finish({ ok: false, error: 'timeout', detail: '超过 ' + timeoutMs + 'ms 未完成' });
      }, timeoutMs);
      child.on('error', function (err) {
        finish({ ok: false, error: 'spawn_failed', detail: errText(err) });
      });
      child.on('close', function (code) {
        finish({ ok: true, code: code });
      });
    });
  }

  async function rmrf(fs, dir) {
    for (let i = 0; i < 3; i++) {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); return true; }
      catch (err) { await sleep(120); } // Windows 上浏览器刚退出时句柄可能还没放
    }
    return false;
  }

  // 本机无头浏览器截图：写临时 HTML -> --screenshot 出 PNG -> 读回字节 -> 清临时目录。
  async function renderChrome(req) {
    const deps = await ensureDeps();
    if (!deps) return { ok: false, error: 'no_browser', detail: '本环境没有 node:fs / os / path（Workers 请用 driver:browser）' };
    const fs = deps.fs;
    const path = deps.path;
    let cp = null;
    if (!spawnImpl) {
      cp = await loadNode('child_process');
      if (!cp || typeof cp.spawn !== 'function') return { ok: false, error: 'no_browser', detail: '本环境没有 node:child_process' };
      cpRef = cp;
    }
    const spawnFn = spawnImpl || cp.spawn;
    const bin = await resolveBrowser();
    if (!bin) return { ok: false, error: 'no_browser' };

    let dir = '';
    try {
      const root = tmpDirWanted || deps.os.tmpdir();
      await fs.promises.mkdir(root, { recursive: true });
      dir = await fs.promises.mkdtemp(path.join(root, 'og-raster-'));
      const htmlPath = path.join(dir, 'card.html');
      const shotPath = path.join(dir, 'card.png');
      const profileDir = path.join(dir, 'profile');
      await fs.promises.writeFile(htmlPath, req.html, 'utf8');
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--force-device-scale-factor=1',
        '--window-size=' + req.width + ',' + req.height,
        '--user-data-dir=' + profileDir,
        '--screenshot=' + shotPath,
        fileUrl(path, htmlPath)
      ];
      const run = await runProcess(spawnFn, bin, args, !spawnImpl);
      if (!run.ok) return run;
      let bytes = null;
      try { bytes = new Uint8Array(await fs.promises.readFile(shotPath)); }
      catch (err) { return { ok: false, error: 'no_output', detail: errText(err) }; }
      if (!bytes.length) return { ok: false, error: 'no_output' };
      return { ok: true, bytes: bytes, driver: 'chrome' };
    } catch (err) {
      return { ok: false, error: 'render_failed', detail: errText(err) };
    } finally {
      if (dir) await rmrf(fs, dir);
    }
  }

  // Workers 线：POST {html} 到渲染端点，期望回 image/png 字节。
  async function renderBrowser(req) {
    if (!endpoint) return { ok: false, error: 'not_configured' };
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof doFetch !== 'function') return { ok: false, error: 'not_configured', detail: '本环境没有 fetch' };
    const headers = { 'content-type': 'application/json', accept: 'image/png' };
    if (token) headers.authorization = 'Bearer ' + token;
    let ctl = null;
    let timer = null;
    const init = {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ html: req.html })
    };
    if (typeof AbortController === 'function') {
      ctl = new AbortController();
      init.signal = ctl.signal;
      if (timeoutMs > 0) timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
    }
    try {
      const res = await doFetch(endpoint, init);
      const status = res && res.status ? Number(res.status) : 0;
      if (!res || res.ok !== true) return { ok: false, error: 'render_failed', status: status };
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (!bytes.length) return { ok: false, error: 'render_failed', status: status, detail: '空响应' };
      return { ok: true, bytes: bytes, driver: 'browser' };
    } catch (err) {
      const aborted = ctl && ctl.signal && ctl.signal.aborted;
      return { ok: false, error: aborted ? 'timeout' : 'render_failed', status: 0, detail: errText(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function fileUrl(pathMod, file) {
    const raw = String(file).replaceAll('\\', '/');
    return 'file:///' + encodeURI(raw).replaceAll('#', '%23').replaceAll('?', '%3F');
  }

  /**
   * 渲染（或从缓存取）一张卡片的 PNG。
   * req: { kind, key, svg, width = 1200, height = 630, html }
   * 回：{ ok:true, bytes, bytesLen, cached, driver, key, width, height, pngWidth, pngHeight, oversized }
   *    | { ok:false, error, status? }
   * 命中缓存时回**同一份字节对象**（调用方别去改它）。
   */
  async function png(req) {
    const r = req || {};
    if (typeof r.svg !== 'string' || !r.svg.trim()) return fail('invalid_svg');
    const kind = String(r.kind === undefined || r.kind === null ? 'card' : r.kind).trim() || 'card';
    const key = String(r.key === undefined || r.key === null ? '' : r.key);
    const width = intOr(r.width, OG_WIDTH);
    const height = intOr(r.height, OG_HEIGHT);
    if (width < 16 || width > 4096 || height < 16 || height > 4096) return fail('bad_size');
    const cacheKey = kind + ':' + key + ':' + width + 'x' + height;
    const atMs = nowFn();

    // 预生成优先：文件在就用它（每次直读磁盘，文件是唯一真相，不进 LRU 也就不会被 TTL 挡住）。
    if (pregenConf) {
      const pre = await readPregen(kind, key, width, height);
      if (pre.file) st.pregenLastFile = pre.file;
      if (pre.ok) {
        st.pregenHits++;
        const over = pre.bytesLen > OVERSIZE_BYTES;
        if (over) { st.oversized = true; st.oversizedCount++; }
        return {
          ok: true, cached: false, source: 'pregen', pregen: true, driver: 'pregen', file: pre.file, key: cacheKey,
          bytes: pre.bytes, bytesLen: pre.bytesLen,
          width: width, height: height, pngWidth: pre.pngWidth, pngHeight: pre.pngHeight,
          oversized: over
        };
      }
      st.pregenMisses++;
      if (pre.reason === 'invalid') st.pregenInvalid++;
      else if (pre.reason === 'size') st.pregenSizeSkip++;
    }

    const hit = readCache(cacheKey, atMs);
    if (hit) {
      st.hits++;
      return {
        ok: true, cached: true, driver: hit.driver, key: cacheKey,
        bytes: hit.bytes, bytesLen: hit.bytesLen,
        width: width, height: height, pngWidth: hit.pngWidth, pngHeight: hit.pngHeight,
        oversized: hit.oversized
      };
    }
    st.misses++;

    const html = typeof r.html === 'string' && r.html ? r.html : svgToHtml(r.svg, width, height);
    let res;
    if (driverWanted === 'browser') {
      res = await renderBrowser({ html: html, width: width, height: height });
    } else if (driverWanted === 'chrome') {
      res = await renderChrome({ html: html, width: width, height: height });
    } else {
      // auto：Node 侧有浏览器就用 chrome；没有就 not_configured（Workers 侧请显式传 browser）。
      const bin = await resolveBrowser();
      res = bin
        ? await renderChrome({ html: html, width: width, height: height })
        : { ok: false, error: 'not_configured' };
    }
    if (!res.ok) return fail(res.error, res.status);

    const size = pngSize(res.bytes);
    if (!size) return fail('bad_png');
    const bytesLen = res.bytes.length;
    const oversized = bytesLen > OVERSIZE_BYTES;
    if (oversized) { st.oversized = true; st.oversizedCount++; }
    if (size.width !== width || size.height !== height) st.sizeMismatch++;
    st.renders++;
    st.driverUsed = res.driver;
    st.lastBytes = bytesLen;
    st.lastSize = { width: size.width, height: size.height };

    writeCache(cacheKey, {
      bytes: res.bytes, at: atMs, driver: res.driver, bytesLen: bytesLen,
      oversized: oversized, pngWidth: size.width, pngHeight: size.height
    });

    return {
      ok: true, cached: false, driver: res.driver, key: cacheKey,
      bytes: res.bytes, bytesLen: bytesLen,
      width: width, height: height, pngWidth: size.width, pngHeight: size.height,
      oversized: oversized
    };
  }

  // 只读快照（含缓存占用与本次进程的渲染痕迹）；oversized 是「有没有出过超限图」的布尔标记，
  // oversizedCount 才是次数。统计是累计的，clear() 不清统计。
  function stats() {
    return {
      hits: st.hits,
      misses: st.misses,
      renders: st.renders,
      failures: st.failures,
      oversized: st.oversized,
      oversizedCount: st.oversizedCount,
      limitBytes: OVERSIZE_BYTES,
      evictions: st.evictions,
      expired: st.expired,
      clears: st.clears,
      sizeMismatch: st.sizeMismatch,
      entries: cache.size,
      maxEntries: maxEntries,
      ttlMs: ttlMs,
      timeoutMs: timeoutMs,
      driver: driverWanted,
      driverUsed: st.driverUsed,
      browser: browserResolved,
      endpointConfigured: !!endpoint,
      lastError: st.lastError,
      lastBytes: st.lastBytes,
      lastSize: st.lastSize,
      pregen: !!pregenConf,
      pregenDir: pregenDirResolved || (pregenConf ? String(pregenConf.dir) : ''),
      pregenHits: st.pregenHits,
      pregenMisses: st.pregenMisses,
      pregenInvalid: st.pregenInvalid,
      pregenSizeSkip: st.pregenSizeSkip,
      pregenLastFile: st.pregenLastFile
    };
  }

  // 清空缓存，返回清掉的条目数。
  function clear() {
    const n = cache.size;
    cache.clear();
    st.clears++;
    return n;
  }

  // 把探测结果暴露出去（tools/og-detect.mjs 与测试都用得上），不改变任何状态。
  async function browserPath() {
    return await resolveBrowser();
  }

  return { png: png, stats: stats, clear: clear, browserPath: browserPath, warm: warm };
}

export default {
  createRasterizer, ogMeta, svgToHtml, pngSize, isPng, browserCandidates,
  OG_ROUTES, OG_CONTENT_TYPE, BROWSER_CANDIDATES, PNG_MAGIC, OG_WIDTH, OG_HEIGHT,
  OG_PREGEN_DIR, OG_MANIFEST_NAME, OG_PREGEN_VERSION, OG_PREGEN_KINDS,
  ogKindName, ogPregenKey, ogFileName,
  buildOgManifest, diffOgManifest, readOgManifest, warmOgPregen
};
