/**
 * PWA 探针：一条命令验证「两条线」的 PWA 是不是真的能用。
 *
 *   node tools/pwa-test.mjs                 # 全量：Express 线 + CF(Worker) 线 + 无头浏览器
 *   node tools/pwa-test.mjs --no-worker     # 只验 Express 线
 *   node tools/pwa-test.mjs --no-browser    # 只跑 HTTP 断言（不起浏览器）
 *   node tools/pwa-test.mjs --keep-shots    # 保留 caption 之外的截图（默认就保留，开关只作文档）
 *
 * 为什么自己另起一个 Express 子进程：
 *   本任务开工时开发服务器（3000）就在跑，它加载的是改动之前的代码，而任务要求不能重启它。
 *   所以探针用 PORT 环境变量在自己的端口（默认 3101）上起一个只属于自己的 server.js 子进程 ——
 *   跑的是磁盘上的新代码，绝不碰 3000 端口，也绝不 taskkill 任何不属于自己的进程
 *   （收尾只 kill 自己 spawn 的那个 pid，必要时 taskkill /pid <自己的子进程> /T /F）。
 *
 * 端口：CDP 9380（CDP_PORT 可覆盖，任务约定独占）· Express 线 3101（PWA_PORT）· CF 线 3102（PWA_WORKER_PORT）
 * 浏览器：无头 Edge，独立 user-data-dir（mkdtemp），退出时删掉。
 */
import { spawn, spawnSync } from 'node:child_process';
import { findBrowser } from './browser.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SHOTS = path.join(ROOT, 'docs', 'screens');
const CDP_PORT = Number(process.env.CDP_PORT || 9380);
const APP_PORT = Number(process.env.PWA_PORT || 3101);
const WORKER_PORT = Number(process.env.PWA_WORKER_PORT || 3102);
const ORIGIN = 'http://127.0.0.1:' + APP_PORT;
const WORIGIN = 'http://127.0.0.1:' + WORKER_PORT;
const DEV_ORIGIN = 'http://127.0.0.1:3000';
const ARGV = process.argv.slice(2);
const SKIP_WORKER = ARGV.indexOf('--no-worker') >= 0;
const SKIP_BROWSER = ARGV.indexOf('--no-browser') >= 0;

const MANIFEST_FILE = path.join(ROOT, 'public', 'manifest.webmanifest');
const SW_FILE = path.join(ROOT, 'public', 'sw.js');
const ICONS_DIR = path.join(ROOT, 'public', 'icons');
const PRECACHE_FILE = path.join(ROOT, 'public', 'precache.json');
const GEN_PRECACHE = path.join(HERE, 'gen-precache.mjs');
const BUILD_PAGES = path.join(HERE, 'build-pages.mjs');
const DIST_CF = path.join(ROOT, 'dist-cf');
/* 常驻在跑的两条线（3000 老进程 / 4400 Worker 静态产物）：只做对照与信息打印，硬断言用自带端口 */
const LIVE_ORIGIN = 'http://127.0.0.1:3000';
const LIVE_WORIGIN = 'http://127.0.0.1:4400';
/* 真离线验收的两款游戏：match3（只依赖 gamepad.js）与 connect4（还要 net-play.js） */
const OFFLINE_GAMES = [
  { slug: 'match3', title: '宝石三消' },
  { slug: 'connect4', title: '四子棋' }
];


let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  \u2713 ' + name + (detail ? '  【' + detail + '】' : '')); }
  else { fail += 1; fails.push(name + (detail ? '  【' + detail + '】' : '')); console.log('  \u2717 ' + name + (detail ? '  【' + detail + '】' : '')); }
}
function info(text) { console.log('  \u00b7 ' + text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 带自定义 Host 头的 GET：用来验证「论坛子域」那条按主机重写的分支（fetch 不允许改 Host，所以走 node:http）。 */
function hostGet(origin, pathname, hostHeader) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: pathname, method: 'GET', headers: { Host: hostHeader } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 只认真 PNG：8 字节签名 + IHDR 尺寸。返回 null 表示不是 PNG。 */
function pngInfo(buf) {
  if (!buf || buf.length < 26) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}
function parseSizes(sizes) {
  const m = /^([0-9]+)x([0-9]+)$/.exec(String(sizes || '').trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
async function waitHttp(url, tries) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) { r.body && r.body.cancel && r.body.cancel().catch(() => {}); return true; } } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}
function readDisk() {
  const manifestText = fs.readFileSync(MANIFEST_FILE, 'utf8');
  const swText = fs.readFileSync(SW_FILE, 'utf8');
  const m = /const SW_VERSION = '([^']+)'/.exec(swText);
  const swVersion = m ? m[1] : '';
  /* 真离线清单：public/precache.json（tools/gen-precache.mjs 产出），读不到不算致命 */
  const precacheText = fs.existsSync(PRECACHE_FILE) ? fs.readFileSync(PRECACHE_FILE, 'utf8') : '';
  let precache = null;
  try { precache = JSON.parse(precacheText); } catch (e) { precache = null; }
  const pm = /const PRECACHE_VERSION = '([^']+)'/.exec(swText);
  const precacheVersion = ((precache && precache.version) || (pm ? pm[1] : '')) || '';
  return {
    manifestText: manifestText,
    swText: swText,
    swVersion: swVersion,
    precacheText: precacheText,
    precache: precache,
    precacheVersion: precacheVersion,
    /* 缓存桶名 = SW_VERSION + '.' + 清单版本：清单内容一变桶名就变，老桶由 activate 清掉 */
    swCacheTag: swVersion && precacheVersion ? swVersion + '.' + precacheVersion : swVersion
  };
}
/* 清单里的站内路径（元素可以是字符串，也可以是 { url, revision }） */
function precacheUrls(disk) {
  const list = disk.precache && Array.isArray(disk.precache.urls) ? disk.precache.urls : [];
  return list.map((it) => (typeof it === 'string' ? it : (it && it.url) || '')).filter((u) => u.charAt(0) === '/');
}

/* ==================== 阶段 A/B：纯 HTTP 断言 ==================== */

async function httpPhase(origin, label, disk, opts) {
  const worker = !!(opts && opts.worker);
  console.log('\n== ' + label + '  ' + origin + ' ==');
  const bust = '?_cb=' + Date.now() + Math.random().toString(36).slice(2, 8);

  /* ---- manifest ---- */
  const manRes = await fetch(origin + '/manifest.webmanifest' + bust);
  check(label + ' GET /manifest.webmanifest 200', manRes.status === 200, 'HTTP ' + manRes.status);
  const manCt = manRes.headers.get('content-type') || '';
  check(label + ' manifest Content-Type 是 application/manifest+json', manCt.indexOf('application/manifest+json') === 0, manCt || '(空)');
  check(label + ' manifest Cache-Control = public, max-age=3600', manRes.headers.get('cache-control') === 'public, max-age=3600', manRes.headers.get('cache-control') || '(空)');
  const manText = await manRes.text();
  let mf = null;
  try { mf = JSON.parse(manText); } catch (e) { mf = null; }
  check(label + ' manifest 是合法 JSON', !!mf, mf ? '解析成功' : manText.slice(0, 80));
  if (!mf) return;
  check(label + ' manifest 与 public/manifest.webmanifest 逐字节一致', manText === disk.manifestText, manText.length + 'B vs 磁盘 ' + disk.manifestText.length + 'B');
  check(label + ' name/short_name = 趣玩小游戏', mf.name === '趣玩小游戏' && mf.short_name === '趣玩小游戏', String(mf.name) + ' / ' + String(mf.short_name));
  check(label + ' description 非空', typeof mf.description === 'string' && mf.description.length > 8, String(mf.description));
  check(label + ' start_url=/ scope=/ display=standalone', mf.start_url === '/' && mf.scope === '/' && mf.display === 'standalone', String(mf.start_url) + ' ' + String(mf.scope) + ' ' + String(mf.display));
  check(label + ' background_color/theme_color = #0b1020', mf.background_color === '#0b1020' && mf.theme_color === '#0b1020', String(mf.background_color) + ' / ' + String(mf.theme_color));
  check(label + ' lang = zh-CN', mf.lang === 'zh-CN', String(mf.lang));
  const icons = Array.isArray(mf.icons) ? mf.icons : [];
  check(label + ' icons 条数 >= 3 且每条都有 src/sizes/type', icons.length >= 3 && icons.every((i) => i && i.src && i.sizes && i.type), icons.length + ' 条');
  const big = icons.filter((i) => { const s = parseSizes(i.sizes); return s && s.w >= 144; });
  check(label + ' 至少一个 >=144px 的图标（可安装硬条件）', big.length >= 1, big.map((i) => i.sizes).join(',') || '无');
  check(label + ' 含 maskable purpose 的图标', icons.some((i) => String(i.purpose || '').indexOf('maskable') >= 0), icons.map((i) => i.sizes + ':' + String(i.purpose || 'any')).join(' '));
  check(label + ' 含 180x180 的 apple-touch-icon', icons.some((i) => i.sizes === '180x180'), icons.map((i) => i.sizes).join(','));

  /* ---- 图标逐个：状态码 + 真 PNG + 尺寸 + 与磁盘一致 ---- */
  for (const ic of icons) {
    const tag = label + ' ' + ic.src;
    const r = await fetch(origin + ic.src + bust);
    const buf = Buffer.from(await r.arrayBuffer());
    check(tag + ' 200', r.status === 200, 'HTTP ' + r.status);
    check(tag + ' Content-Type = image/png', (r.headers.get('content-type') || '').indexOf('image/png') === 0, r.headers.get('content-type') || '(空)');
    const p = pngInfo(buf);
    const want = parseSizes(ic.sizes);
    check(tag + ' 是真 PNG 且 IHDR 尺寸 = manifest 声明', !!p && !!want && p.width === want.w && p.height === want.h,
      p ? p.width + 'x' + p.height + ' vs 声明 ' + ic.sizes + ' (colorType ' + p.colorType + ')' : '不是 PNG');
    check(tag + ' 单张 < 200KB', buf.length > 0 && buf.length < 200 * 1024, (buf.length / 1024).toFixed(1) + 'KB');
    const local = path.join(ROOT, 'public', ic.src.replace(/^\//, ''));
    const localBuf = fs.existsSync(local) ? fs.readFileSync(local) : null;
    check(tag + ' 与 public/ 下的同名文件逐字节一致（两条线同源）', !!localBuf && localBuf.equals(buf),
      localBuf ? localBuf.length + 'B vs ' + buf.length + 'B' : '磁盘文件缺失');
  }

  /* ---- shortcuts：不许编造路由 ---- */
  const scs = Array.isArray(mf.shortcuts) ? mf.shortcuts : [];
  check(label + ' shortcuts 字段是数组', Array.isArray(mf.shortcuts) || mf.shortcuts === undefined, scs.length + ' 条');
  for (const sc of scs) {
    const okShape = !!(sc && sc.name && sc.url && String(sc.url).charAt(0) === '/');
    check(label + ' shortcut ' + String(sc && sc.url) + ' 字段完整（name+url 站内路径）', okShape, JSON.stringify(sc));
    if (!okShape) continue;
    const r = await fetch(origin + sc.url + bust);
    check(label + ' shortcut ' + sc.url + ' 真实存在（不是编造的路由）', r.status === 200, 'HTTP ' + r.status);
  }

  /* ---- sw.js ---- */
  const swRes = await fetch(origin + '/sw.js' + bust);
  check(label + ' GET /sw.js 200', swRes.status === 200, 'HTTP ' + swRes.status);
  const swCt = swRes.headers.get('content-type') || '';
  check(label + ' /sw.js Content-Type 是 JavaScript', /javascript/.test(swCt), swCt || '(空)');
  check(label + ' /sw.js Service-Worker-Allowed = /', swRes.headers.get('service-worker-allowed') === '/', String(swRes.headers.get('service-worker-allowed')));
  check(label + ' /sw.js Cache-Control = no-cache（不发新版就被缓存卡死）', swRes.headers.get('cache-control') === 'no-cache', swRes.headers.get('cache-control') || '(空)');
  const swText = await swRes.text();
  /* 行尾/结尾空行归一化后比对：Windows 上 autocrlf 会把 worker/app.js 变 CRLF，
     内联副本是按 LF 写进去的，直接逐字节比会假报不一致（tools/gen-sw.mjs 的 --check 同理）。 */
  const normSw = (t) => String(t).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  check(label + ' /sw.js 与 public/sw.js 逐字节一致（行尾归一化后）', normSw(swText) === normSw(disk.swText),
    swText.length + 'B vs 磁盘 ' + disk.swText.length + 'B'
    + (normSw(swText) === normSw(disk.swText) || !(opts && opts.worker) ? '' : '（worker/app.js 里内联的 PWA_SW 还是旧副本：跑 node tools/gen-sw.mjs 同步）'));
  let parseErr = '';
  try { new Function(swText); } catch (e) { parseErr = e.message; }
  check(label + ' /sw.js 语法可解析（inline 进 worker 的转义没坏）', parseErr === '', parseErr || 'new Function 通过');
  check(label + ' /sw.js 里有版本号常量 SW_VERSION=' + disk.swVersion, swText.indexOf("const SW_VERSION = '" + disk.swVersion + "'") >= 0);
  const mustHave = ['qw-shell-', 'qw-assets-', 'skipWaiting', 'clients.claim', 'PWA_VERSION', '/^\\/api\\//', '/^\\/games\\//'];
  const missing = mustHave.filter((k) => swText.indexOf(k) < 0);
  check(label + ' /sw.js 策略要点齐全（壳/资源缓存名、skipWaiting、clientsClaim、排除表）', missing.length === 0, missing.length ? '缺：' + missing.join(' ') : mustHave.length + ' 个标记全中');

  /* ---- 静态资源存活（SW 要缓存的对象）---- */
  const css = await fetch(origin + '/static/css/style.css' + bust);
  check(label + ' /static/css/style.css 200（SW 的缓存对象）', css.status === 200, 'HTTP ' + css.status);
  const fav = await fetch(origin + '/favicon.svg' + bust);
  check(label + ' /favicon.svg 200', fav.status === 200, 'HTTP ' + fav.status);

  /* ---- 真离线清单 /precache.json：服务端路由缺失只提示，不判失败（路由由 Lead 接） ---- */
  const urls = precacheUrls(disk);
  const pcRes = await fetch(origin + '/precache.json' + bust);
  if (pcRes.status === 200) {
    const pcCt = pcRes.headers.get('content-type') || '';
    check(label + ' /precache.json Content-Type 是 JSON', pcCt.indexOf('application/json') === 0, pcCt || '(空)');
    const pcText = await pcRes.text();
    let pc = null;
    try { pc = JSON.parse(pcText); } catch (e) { pc = null; }
    check(label + ' /precache.json 是合法 JSON', !!pc, pc ? '解析成功' : pcText.slice(0, 80));
    check(label + ' /precache.json 线上版本号与磁盘一致', !!pc && pc.version === disk.precacheVersion,
      (pc ? pc.version : '?') + ' vs 磁盘 ' + disk.precacheVersion);
    const pcPodUrls = (pc && Array.isArray(pc.urls) ? pc.urls : []).map((it) => (typeof it === 'string' ? it : (it && it.url) || ''));
    check(label + ' /precache.json 线上清单与磁盘逐条一致', pcPodUrls.length === urls.length && pcPodUrls.every((u, i) => u === urls[i]),
      pcPodUrls.length + ' 条 vs 磁盘 ' + urls.length + ' 条');
  } else {
    info(label + ' /precache.json → HTTP ' + pcRes.status + '（路由未接：Express 老进程没重启 / dist-cf 还没跑 build:pages），跳过线上清单断言，只验磁盘文件');
  }
  check(label + ' 磁盘 public/precache.json 存在且含 version + urls[]', !!disk.precache && typeof disk.precache.version === 'string' && urls.length >= 20,
    disk.precache ? 'version=' + disk.precache.version + ' · ' + urls.length + ' 条' : '读不到或不是合法 JSON');

  /* ---- 清单里每个 URL 都必须真能取到（否则预缓存必然缺件）---- */
  const badUrls = [];
  for (const u of urls) {
    try { const r = await fetch(origin + u + bust); if (r.status !== 200) badUrls.push(u + '→HTTP ' + r.status); }
    catch (e) { badUrls.push(u + '→' + e.message); }
  }
  check(label + ' 清单里 ' + urls.length + ' 个 URL 全部 200（预缓存的前置条件）', badUrls.length === 0,
    badUrls.length ? badUrls.slice(0, 5).join(' ') : '全部 200');

  /* ---- 论坛子域（Host: forum.*）：整站 head 在这些主机上也挂了 manifest 与注册脚本，不许 404 ---- */
  const FHOST = 'forum.pwa-probe.local';
  const fMan = await hostGet(origin, '/manifest.webmanifest', FHOST);
  check(label + ' 论坛主机（Host: ' + FHOST + '）也拿到 manifest，没被重写成 /forum/manifest.webmanifest', fMan.status === 200 && (fMan.headers['content-type'] || '').indexOf('application/manifest+json') === 0,
    'HTTP ' + fMan.status + ' · ' + String(fMan.headers['content-type'] || '(空)'));
  check(label + ' 论坛主机的 manifest 正文与磁盘逐字节一致', fMan.body.toString('utf8') === disk.manifestText, fMan.body.length + 'B');
  const fSw = await hostGet(origin, '/sw.js', FHOST);
  check(label + ' 论坛主机也拿到 /sw.js 且带 Service-Worker-Allowed: /', fSw.status === 200 && fSw.headers['service-worker-allowed'] === '/',
    'HTTP ' + fSw.status + ' · ' + String(fSw.headers['service-worker-allowed'] || '(空)'));
  const fIcon = await hostGet(origin, '/icons/icon-192.png', FHOST);
  check(label + ' 论坛主机也拿到 /icons/icon-192.png', fIcon.status === 200 && (fIcon.headers['content-type'] || '').indexOf('image/png') === 0,
    'HTTP ' + fIcon.status + ' · ' + (fIcon.body.length / 1024).toFixed(1) + 'KB');
}

/* ==================== CDP 客户端 ==================== */

class CDP {
  constructor(wsUrl, sink, tag) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.sink = sink;
    this.tag = tag;
  }
  open() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')); };
    });
  }
  attach() {
    this.ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.method + ' ' + JSON.stringify(msg.error))); else p.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      this.observe(msg.method, msg.params);
      const fns = this.handlers.get(msg.method);
      if (fns) for (const fn of fns.slice()) fn(msg.params);
    };
  }
  /** 把「探针要断言的三类事实」收集起来：请求 URL、console 报错、未捕获异常。 */
  observe(method, params) {
    if (method === 'Network.requestWillBeSent') {
      this.sink.urls.push({ phase: this.sink.phase, url: params.request.url });
      this.sink.reqUrls.set(params.requestId, params.request.url);
    } else if (method === 'Network.loadingFailed' && !params.canceled) {
      this.sink.failed.push({ phase: this.sink.phase, url: this.sink.reqUrls.get(params.requestId) || '', err: params.errorText || '' });
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const text = (params.args || []).map((a) => String(a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
      this.sink.errors.push({ phase: this.sink.phase, kind: 'console', text: text.slice(0, 200) });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      this.sink.errors.push({ phase: this.sink.phase, kind: 'exception', text: String((d.exception && d.exception.description) || d.text || '').slice(0, 200) });
    } else if (method === 'Log.entryAdded' && params.entry && params.entry.level === 'error') {
      this.sink.errors.push({ phase: this.sink.phase, kind: 'log', text: String(params.entry.text || '').slice(0, 200) });
    }
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const arr = this.handlers.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  send(method, params, timeoutMs) {
    const id = (this.id += 1);
    const limit = timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' 超时 ' + limit + 'ms')); }, limit);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); }
      });
      try { this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge/Chrome，可用 CHROME 环境变量指定');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-cdp-'));
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions',
    '--no-first-run', '--mute-audio', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + ud, 'about:blank'];
  const child = spawn(exe, args, { stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { /* 继续等 */ }
    await sleep(250);
  }
  if (!ready) { try { child.kill(); } catch (e) { /* 忽略 */ } throw new Error('无头浏览器没起来（CDP ' + CDP_PORT + '）'); }
  return { child: child, ud: ud, exe: exe };
}

async function newSession(browser, sink, tag) {
  const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' });
  const target = await r.json();
  const cdp = new CDP(target.webSocketDebuggerUrl, sink, tag);
  await cdp.open();
  cdp.attach();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // dev server 给 HTML 回 Cache-Control: public, max-age=3600 —— 关掉缓存 + URL 带一次性 _cb，否则会读到旧页面
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  sink.sessions.push(cdp);
  return cdp;
}

function waitEvent(cdp, method, timeoutMs) {
  return new Promise((resolve) => {
    let off = () => {};
    const t = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    off = cdp.on(method, (params) => { clearTimeout(t); off(); resolve(params); });
  });
}
async function navigate(cdp, url) {
  const loaded = waitEvent(cdp, 'Page.loadEventFired', 15000);
  const res = await cdp.send('Page.navigate', { url: url });
  const got = await loaded;
  await sleep(150);
  return { errorText: (res && res.errorText) || '', loaded: !!got };
}
async function evalRC(cdp, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面里抛异常: ' + String((d.exception && d.exception.description) || d.text || ''));
  }
  return r.result ? r.result.value : undefined;
}

function versionProbeScript() {
  return '(function () { return new Promise(function (resolve) {'
    + ' var done = false;'
    + ' var t = setTimeout(function () { if (!done) { done = true; resolve("(超时)"); } }, 5000);'
    + ' navigator.serviceWorker.addEventListener("message", function (e) {'
    + '   if (!done && e.data && e.data.type === "PWA_VERSION") { done = true; clearTimeout(t); resolve(String(e.data.version)); }'
    + ' });'
    + ' navigator.serviceWorker.ready.then(function (r) {'
    + '   var sw = r.active || navigator.serviceWorker.controller;'
    + '   if (sw) sw.postMessage({ type: "PWA_VERSION" });'
    + '   else { done = true; clearTimeout(t); resolve("(没有 active SW)"); }'
    + ' });'
    + ' }); })()';
}
/* 版本握手详情：新版 sw.js 还回 precache/cache/pages；旧内联副本只回 version —— 缺字段只提示，不判失败 */
function versionDetailScript() {
  return '(function () { return new Promise(function (resolve) {'
    + ' var done = false;'
    + ' var t = setTimeout(function () { if (!done) { done = true; resolve("(超时)"); } }, 5000);'
    + ' navigator.serviceWorker.addEventListener("message", function (e) {'
    + '   if (!done && e.data && e.data.type === "PWA_VERSION") { done = true; clearTimeout(t);'
    + '     resolve({ version: String(e.data.version || ""), precache: String(e.data.precache || ""),'
    + '       cache: String(e.data.cache || ""), pages: Number(e.data.pages || 0) }); }'
    + ' });'
    + ' navigator.serviceWorker.ready.then(function (r) {'
    + '   var sw = r.active || navigator.serviceWorker.controller;'
    + '   if (sw) sw.postMessage({ type: "PWA_VERSION" });'
    + '   else { done = true; clearTimeout(t); resolve("(没有 active SW)"); }'
    + ' });'
    + ' }); })()';
}
/* 预缓存取证：install 里逐条计数（单个 URL 失败只计数、不整体失败）的 ok/total/failedCount */
function precacheStatusScript() {
  return '(function () { return new Promise(function (resolve) {'
    + ' var done = false;'
    + ' var t = setTimeout(function () { if (!done) { done = true; resolve("(超时)"); } }, 8000);'
    + ' navigator.serviceWorker.addEventListener("message", function (e) {'
    + '   if (!done && e.data && e.data.type === "PWA_PRECACHE_STATUS") { done = true; clearTimeout(t);'
    + '     resolve({ version: String(e.data.version || ""), total: Number(e.data.total || 0), ok: Number(e.data.ok || 0),'
    + '       failedCount: Number(e.data.failedCount || 0), failed: e.data.failed || [], done: !!e.data.done, at: Number(e.data.at || 0) }); }'
    + ' });'
    + ' navigator.serviceWorker.ready.then(function (r) {'
    + '   var sw = r.active || navigator.serviceWorker.controller;'
    + '   if (sw) sw.postMessage({ type: "PWA_PRECACHE_STATUS" });'
    + '   else { done = true; clearTimeout(t); resolve("(没有 active SW)"); }'
    + ' });'
    + ' }); })()';
}
/* 游戏页探针：离线时页面能开、window.GAME.state() 能算，才算「离线也能玩」 */
function gameProbeScript() {
  return '(async function () {'
    + ' var g = window.GAME || null;'
    + ' var out = { title: document.title || "", gameSlug: g ? String(g.slug || "") : "",'
    + '   hasState: !!(g && typeof g.state === "function"), stateJson: "", stateKeys: 0, gameError: "",'
    + '   nodes: document.querySelectorAll("*").length, board: !!document.querySelector("canvas, #board, .board, #area"),'
    + '   cached: false, online: navigator.onLine, controller: !!navigator.serviceWorker.controller };'
    + ' try { var st = out.hasState ? g.state() : null; var s = JSON.stringify(st);'
    + '   out.stateJson = (s === undefined || s === null) ? "" : String(s);'
    + '   out.stateKeys = (st && typeof st === "object") ? Object.keys(st).length : 0; } catch (e) { out.gameError = String(e); }'
    + ' try { out.cached = !!(await caches.match(location.pathname)); } catch (e) { out.cached = false; }'
    + ' return out;'
    + ' })()';
}
function cacheAuditScript(ver) {
  return '(async function () {'
    + ' var keys = await caches.keys();'
    + ' var out = { keys: keys, assetUrls: [], shellKeys: [], shellTitle: "", shellBytes: 0 };'
    + ' var a = await caches.open("qw-assets-' + ver + '");'
    + ' var ak = await a.keys();'
    + ' out.assetUrls = ak.map(function (r) { return r.url; });'
    + ' var s = await caches.open("qw-shell-' + ver + '");'
    + ' var sk = await s.keys();'
    + ' out.shellKeys = sk.map(function (r) { return r.url; });'
    + ' for (var i = 0; i < sk.length; i += 1) {'
    + '   var m = await s.match(sk[i]);'
    + '   var t = m ? await m.text() : "";'
    + '   if (!out.shellBytes) { out.shellBytes = t.length; var i1 = t.indexOf("<title>"); var i2 = t.indexOf("</title>"); if (i1 >= 0 && i2 > i1) out.shellTitle = t.slice(i1 + 7, i2); }'
    + ' }'
    + ' return out;'
    + ' })()';
}
function shellProbeScript() {
  return '(function () { var b = document.body; var txt = b ? (b.innerText || "") : "";'
    + ' return { title: document.title || "", len: txt.length, head: txt.slice(0, 48),'
    + '   marker: !!document.querySelector("header, nav, .topbar, .nav, .hero, main") }; })()';
}
function captionExpr(text) {
  return '(function () { var old = document.getElementById("pwa-probe-caption"); if (old) old.remove();'
    + ' var d = document.createElement("div"); d.id = "pwa-probe-caption"; d.textContent = ' + JSON.stringify(text) + ';'
    + ' d.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 14px;'
    + 'font:13px/1.6 ui-monospace,Consolas,monospace;color:#e9edfa;background:rgba(11,16,32,.94);'
    + 'border-top:1px solid rgba(99,102,241,.7);letter-spacing:.2px";'
    + ' document.body.appendChild(d); return true; })()';
}
async function shot(cdp, file, caption) {
  await evalRC(cdp, captionExpr(caption));
  await sleep(250);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  const p = pngInfo(fs.readFileSync(file));
  check('截图 ' + path.basename(file) + ' 是 1440x900 的真 PNG', !!p && p.width === 1440 && p.height === 900, p ? p.width + 'x' + p.height + ' ' + (fs.statSync(file).size / 1024).toFixed(0) + 'KB' : '不是 PNG');
}

/* ==================== 阶段 C：浏览器里的 SW 行为 ==================== */

async function expressBrowserPhase(browser, sink, disk) {
  console.log('\n== 浏览器：Express 线（注册 / 缓存 / 断网 / 恢复）==');
  const cdp = await newSession(browser, sink, 'express');
  const t = () => Date.now();

  sink.phase = 'online-1';
  const nav1 = await navigate(cdp, ORIGIN + '/?_cb=' + t());
  const title1 = await evalRC(cdp, 'document.title');
  check('在线首屏加载成功（title 含站名）', String(title1).indexOf('趣玩小游戏') >= 0, String(title1) + (nav1.errorText ? ' navError=' + nav1.errorText : ''));

  const swState = await evalRC(cdp,
    '(async function () { var reg = await navigator.serviceWorker.ready;'
    // ready 只代表「有 active worker」，clients.claim() 是它之后的一次异步接管；
    // 首次安装要先把 38 个预缓存页面灌进 Cache，Linux 无头 Chrome 上常常慢半拍，
    // 所以这里最多等 3 秒，而不是 ready 之后立刻读一次 controller。
    + ' for (var i = 0; i < 30 && !navigator.serviceWorker.controller; i++) {'
    + ' await new Promise(function (r) { setTimeout(r, 100); }); }'
    + ' return { active: !!(reg.active), script: reg.active ? reg.active.scriptURL : "", scope: reg.scope,'
    + ' controller: !!navigator.serviceWorker.controller }; })()', true);
  check('navigator.serviceWorker.ready 后 active 存在', !!(swState && swState.active), JSON.stringify(swState));
  check('active.scriptURL 就是 /sw.js', !!(swState && /\/sw\.js$/.test(String(swState.script))), String(swState && swState.script));
  check('scope 覆盖整站（/）', !!(swState && swState.scope && String(swState.scope).indexOf(String(ORIGIN)) === 0), String(swState && swState.scope));
  check('clientsClaim 生效：首个页面就已被 SW 接管', !!(swState && swState.controller), 'controller=' + (swState ? swState.controller : '?'));
  const ver1 = await evalRC(cdp, versionProbeScript(), true);
  check('SW 版本握手（页面 ⇄ sw.js postMessage）', ver1 === disk.swVersion, '实测 ' + String(ver1) + ' · 磁盘 ' + disk.swVersion);
  const det = await evalRC(cdp, versionDetailScript(), true);
  if (det && typeof det === 'object') {
    check('SW 握手带回预缓存清单版本（= ' + disk.precacheVersion + '）', det.precache === disk.precacheVersion, '实测 ' + (det.precache || '(空)'));
    check('缓存桶名 = SW_VERSION + 清单版本（' + disk.swCacheTag + '）', det.cache === disk.swCacheTag, '实测 ' + (det.cache || '(空)'));
    check('SW 认得 ' + precacheUrls(disk).length + ' 个预缓存页面（离线导航直接命中）', det.pages >= precacheUrls(disk).length, '实测 pages=' + det.pages);
  } else {
    info('SW 只回了旧版握手字段（' + String(det) + '）：worker/app.js 内联的 PWA_SW 还是旧副本，跑 node tools/gen-sw.mjs 同步后才有 precache/cache/pages');
  }
  const pcStatus = await evalRC(cdp, precacheStatusScript(), true);
  if (pcStatus && typeof pcStatus === 'object') {
    const want = disk.precache ? Number(disk.precache.count || precacheUrls(disk).length) : precacheUrls(disk).length;
    check('install 预缓存跑完并逐条计数（done=true）', pcStatus.done === true, JSON.stringify({ done: pcStatus.done, total: pcStatus.total, ok: pcStatus.ok }));
    check('预缓存 ok === total === ' + want + '（一条不缺）', pcStatus.total === want && pcStatus.ok === want, 'total=' + pcStatus.total + ' ok=' + pcStatus.ok + ' failed=' + pcStatus.failedCount);
    check('预缓存失败条数为 0（单条失败只计数、不整体失败）', pcStatus.failedCount === 0, pcStatus.failedCount ? JSON.stringify(pcStatus.failed) : '0');
    check('预缓存清单版本与磁盘一致', pcStatus.version === disk.precacheVersion, String(pcStatus.version));
  } else {
    info('读不到 PWA_PRECACHE_STATUS（' + String(pcStatus) + '）：这一版 SW 还没实现该消息');
  }

  sink.phase = 'online-2';
  const nav2 = await navigate(cdp, ORIGIN + '/?_cb=' + t());
  const title2 = await evalRC(cdp, 'document.title');
  check('第二次导航（模拟「下次刷新」）正常', String(title2).indexOf('趣玩小游戏') >= 0, String(title2) + (nav2.errorText ? ' navError=' + nav2.errorText : ''));
  const audit = await evalRC(cdp, cacheAuditScript(disk.swCacheTag), true);
  const hasPrefix = (p) => !!(audit && audit.keys && audit.keys.some((k) => k.indexOf(p) === 0));
  check('缓存里有 qw-shell-…（前缀 ' + disk.swVersion + '，桶名 = ' + disk.swCacheTag + '）', hasPrefix('qw-shell-' + disk.swVersion), (audit && audit.keys || []).join(' ') || '(无缓存)');
  check('缓存里有 qw-assets-…（前缀 ' + disk.swVersion + '）', hasPrefix('qw-assets-' + disk.swVersion), '');
  check('静态资源确实进了 assets 缓存', !!(audit && audit.assetUrls.some((u) => u.indexOf('/static/') >= 0)), (audit ? audit.assetUrls.length : 0) + ' 条：' + (audit ? audit.assetUrls.slice(0, 3).join(' ') : ''));
  const pathOfUrl = (u) => { try { return new URL(u).pathname; } catch (e) { return u; } };
  const pcUrls = precacheUrls(disk);
  const pcMissing = pcUrls.filter((u) => !(audit && (audit.assetUrls || []).concat(audit.shellKeys || []).some((a) => pathOfUrl(a) === u)));
  check('清单里 ' + pcUrls.length + ' 条全在缓存里（含 23 款游戏页，离线才敢说能玩）', pcMissing.length === 0,
    pcMissing.length ? '缺 ' + pcMissing.length + ' 条：' + pcMissing.slice(0, 5).join(' ') : '一条不缺');
  check('离线壳已预热缓存且内容是站点首页（title 含站名）', !!(audit && audit.shellKeys.length >= 1 && String(audit.shellTitle).indexOf('趣玩小游戏') >= 0),
    (audit ? audit.shellKeys.length : 0) + ' 个键 · title=' + (audit ? audit.shellTitle : '') + ' · ' + (audit ? audit.shellBytes : 0) + 'B');
  const bad = (u) => { try { return /^\/(api|u|account|admin|auth|login|logout|register|forgot|reset|verify|favorites|submit|ugc|comments)(\/|$)/.test(new URL(u).pathname); } catch (e) { return false; } };
  check('缓存里没有一条需鉴权路径（/api /u /account /admin /auth …）', !!(audit && !audit.assetUrls.concat(audit.shellKeys).some(bad)),
    audit ? audit.assetUrls.concat(audit.shellKeys).filter(bad).join(' | ') || '全部干净' : '');

  await shot(cdp, path.join(SHOTS, 'pwa-home.png'),
    'PWA 在线态 · /manifest.webmanifest 200 · icons 4/4 200 · SW /sw.js active ' + disk.swVersion
    + ' · 清单 ' + disk.precacheVersion + ' · 缓存 qw-shell-' + disk.swCacheTag + ' + qw-assets-' + disk.swCacheTag);

  sink.phase = 'offline';
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const nav3 = await navigate(cdp, ORIGIN + '/?_cb=' + t());
  const shell = await evalRC(cdp, shellProbeScript());
  check('CDP 断网后导航 / 仍返回站点外壳（title 含站名）', !!(shell && String(shell.title).indexOf('趣玩小游戏') >= 0), (shell ? 'title=' + shell.title : '读不到') + (nav3.errorText ? ' · navError=' + nav3.errorText : ''));
  check('离线外壳不是空白页（正文 > 200 字符）', !!(shell && shell.len > 200), shell ? shell.len + ' 字符 · 开头「' + shell.head + '…」' : '');
  check('离线外壳带站点骨架（header/nav/main 之一）', !!(shell && shell.marker), '');
  await shot(cdp, path.join(SHOTS, 'pwa-offline.png'),
    'CDP offline=true · 导航 / 由 Service Worker 的离线壳响应（network-first 落缓存）· title 与 DOM 骨架完整 · 无网络请求成功');

  /* ---- 真离线验收：断网下直接打开游戏页并确认 window.GAME.state() 能算 ---- */
  sink.phase = 'offline-games';
  let gameProbeLast = null;
  for (const gm of OFFLINE_GAMES) {
    const urlG = ORIGIN + '/games/' + gm.slug + '/index.html?_cb=' + t();
    const navG = await navigate(cdp, urlG);
    const probe = await evalRC(cdp, gameProbeScript(), true);
    gameProbeLast = probe;
    const tag = '断网导航 /games/' + gm.slug + '/index.html';
    check(tag + ' 加载成功（title 含「' + gm.title + '」）', !!(probe && String(probe.title).indexOf(gm.title) >= 0),
      (probe ? 'title=' + probe.title : '读不到') + (navG.errorText ? ' · navError=' + navG.errorText : ''));
    check(tag + ' window.GAME 存在且 slug = ' + gm.slug, !!(probe && probe.gameSlug === gm.slug), probe ? 'slug=' + JSON.stringify(probe.gameSlug) : '');
    check(tag + ' window.GAME.state() 可用（离线也能玩的关键）', !!(probe && probe.hasState && probe.stateJson.length > 10 && probe.stateKeys >= 3 && !probe.gameError),
      probe ? 'state() 返回 ' + probe.stateJson.length + ' 字符 / ' + probe.stateKeys + ' 个字段 · err=' + (probe.gameError || '无') : '');
    check(tag + ' 页面结构完整（DOM > 30 节点 + 棋盘容器）', !!(probe && probe.nodes > 30 && probe.board), probe ? probe.nodes + ' 个节点 · board=' + probe.board : '');
    check(tag + ' 这份文档命中了预缓存', !!(probe && probe.cached), probe ? 'cached=' + probe.cached : '');
    check(tag + ' 浏览器确实处于断网态（navigator.onLine=false）', !!(probe && probe.online === false), probe ? 'online=' + probe.online : '');
    check(tag + ' 页面仍被 SW 接管', !!(probe && probe.controller), probe ? 'controller=' + probe.controller : '');
  }
  await shot(cdp, path.join(SHOTS, 'pwa-offline-games.png'),
    'CDP offline=true · 直接导航 /games/' + OFFLINE_GAMES.map((g) => g.slug).join('/index.html 与 /games/')
    + '/index.html 由 SW 预缓存直出 · window.GAME.state() 返回 ' + (gameProbeLast ? gameProbeLast.stateKeys : 0) + ' 个字段 · 零网络可用');

  sink.phase = 'online-3';
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const nav4 = await navigate(cdp, ORIGIN + '/?_cb=' + t());
  const title4 = await evalRC(cdp, 'document.title');
  check('恢复网络后导航正常（network-first 回到真网络）', String(title4).indexOf('趣玩小游戏') >= 0, String(title4) + (nav4.errorText ? ' navError=' + nav4.errorText : ''));
  const still = await evalRC(cdp, 'navigator.serviceWorker.controller ? "controlled" : "lost"');
  check('恢复网络后 SW 仍然在管（没有被注销）', still === 'controlled', String(still));
}

async function workerBrowserPhase(browser, sink, disk) {
  console.log('\n== 浏览器：CF（Worker）线 ==');
  const cdp = await newSession(browser, sink, 'worker');
  sink.phase = 'worker-1';
  const nav = await navigate(cdp, WORIGIN + '/?_cb=' + Date.now());
  const title = await evalRC(cdp, 'document.title');
  check('Worker 线首页加载成功（title 含站名）', String(title).indexOf('趣玩小游戏') >= 0, String(title) + (nav.errorText ? ' navError=' + nav.errorText : ''));
  const st = await evalRC(cdp,
    '(async function () { try { var reg = await navigator.serviceWorker.ready;'
    + ' return { ok: true, active: !!(reg.active), script: reg.active ? reg.active.scriptURL : "" }; }'
    + ' catch (e) { return { ok: false, err: String(e) }; } })()', true);
  check('Worker 线 SW 注册成功（内联 sw.js 是可执行的真脚本）', !!(st && st.ok && st.active), JSON.stringify(st));
  check('Worker 线 active.scriptURL 指向 /sw.js', !!(st && /\/sw\.js$/.test(String(st.script))), String(st && st.script));
  const ver = await evalRC(cdp, versionProbeScript(), true);
  check('Worker 线 SW 版本握手', ver === disk.swVersion, '实测 ' + String(ver) + ' · 磁盘 ' + disk.swVersion);
  const detW = await evalRC(cdp, versionDetailScript(), true);
  if (detW && typeof detW === 'object') {
    check('Worker 线 SW 握手带回预缓存版本', detW.precache === disk.precacheVersion, '实测 ' + (detW.precache || '(空)'));
  } else {
    info('Worker 线 SW 是 worker/app.js 里冻结的旧内联副本（只回 version）：跑 node tools/gen-sw.mjs 同步 public/sw.js 后这里才会带上 precache/cache/pages（公共文件不许在本任务改）');
  }
  const cachesOn = await evalRC(cdp, 'caches.keys().then(function (k) { return k.join(","); })', true);
  const onPrefix = (p) => String(cachesOn).split(',').some((k) => k.indexOf(p) === 0);
  check('Worker 线缓存按版本建立（qw-shell-' + disk.swVersion + '…）', onPrefix('qw-shell-' + disk.swVersion), String(cachesOn));
}

/* ==================== 阶段 D：常驻在跑的两条线（3000 / 4400）对照 ==================== */
/* 与 httpPhase 的「清单里每个 URL 都 200」同一断言，但对象是别人正在跑的进程：
   对方没起来只提示不判失败，路由没接上（老进程 / dist-cf 没 build:pages）也只提示 */
async function livePrecachePhase(origin, label, disk) {
  const bust = () => '?_cb=' + Date.now() + Math.random().toString(36).slice(2, 7);
  let alive = false;
  try { const r = await fetch(origin + '/' + bust()); alive = r.status < 500; } catch (e) { alive = false; }
  if (!alive) { info(label + ' ' + origin + ' 没在跑（跳过对照）'); return; }
  const urls = precacheUrls(disk);
  const bad = [];
  for (const u of urls) {
    try { const r = await fetch(origin + u + bust()); if (r.status !== 200) bad.push(u + '→HTTP ' + r.status); }
    catch (e) { bad.push(u + '→' + e.message); }
  }
  check(label + ' 清单里 ' + urls.length + ' 个 URL 全部 200', bad.length === 0, bad.length ? bad.slice(0, 5).join(' ') : '全部 200 @ ' + origin);
  const pc = await fetch(origin + '/precache.json' + bust());
  if (pc.status === 200) {
    const body = await pc.text();
    let obj = null;
    try { obj = JSON.parse(body); } catch (e) { obj = null; }
    check(label + ' /precache.json 200 且版本与磁盘一致', !!obj && obj.version === disk.precacheVersion,
      'HTTP 200 · ' + (obj ? obj.version : body.slice(0, 60)));
  } else {
    info(label + ' /precache.json → HTTP ' + pc.status
      + '（路由未接：3000 是改动前启动的老进程，重启即好；4400 走 dist-cf，先跑 node tools/build-pages.mjs 才有产物）');
  }
}

/* ==================== 主流程 ==================== */

/**
 * Worker 线跑的是 tools/serve-worker.mjs 的 Static Assets 假实现，它读 dist-cf（构建产物）。
 * dist-cf 是 .gitignore 里的东西：新克隆 / 新增游戏后没跑 build:pages 就是旧产物，
 * /games/<slug>/index.html 会 404、/precache.json 还是旧版本号 —— 那是产物过期，不是代码坏了。
 * 这里先对齐一次（版本号或清单条数不符就重建），让探针自给自足。
 */
function distCfState(disk) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DIST_CF, 'precache.json'), 'utf8'));
    const games = fs.existsSync(path.join(DIST_CF, 'games')) ? fs.readdirSync(path.join(DIST_CF, 'games')).length : 0;
    return { version: p.version, count: p.count, games: games };
  } catch (e) { return null; }
}
function ensureDistCf(disk) {
  const before = distCfState(disk);
  const wantVersion = disk.precacheVersion;
  const wantCount = disk.precache && Array.isArray(disk.precache.urls) ? disk.precache.urls.length : 0;
  if (before && before.version === wantVersion && (!wantCount || before.count === wantCount)) {
    return 'dist-cf 已是最新（' + before.version + ' · ' + before.count + ' 条 · ' + before.games + ' 个游戏目录）';
  }
  const r = spawnSync(process.execPath, [BUILD_PAGES, '--cf'], { cwd: ROOT, encoding: 'utf8' });
  const after = distCfState(disk);
  const head = before ? (before.version + ' · ' + before.count + ' 条 · ' + before.games + ' 个游戏目录') : '缺 dist-cf';
  return 'dist-cf 过期（' + head + '）→ 跑 build:pages --cf（exit=' + (r.status === null ? '?' : r.status) + '）'
    + (after ? ' → ' + after.version + ' · ' + after.count + ' 条 · ' + after.games + ' 个游戏目录' : ' → 仍然读不到');
}

async function main() {
  const t0 = Date.now();
  console.log('PWA 探针  ' + ROOT);
  const disk = readDisk();
  if (!disk.swVersion) { console.log('  \u2717 读不到 public/sw.js 里的 SW_VERSION'); return 1; }
  info('磁盘基准：manifest ' + disk.manifestText.length + 'B · sw.js ' + disk.swText.length + 'B · SW_VERSION=' + disk.swVersion);
  info('图标：' + fs.readdirSync(ICONS_DIR).map((f) => f + '(' + (fs.statSync(path.join(ICONS_DIR, f)).size / 1024).toFixed(1) + 'KB)').join(' '));
  info('真离线清单：' + (disk.precache
    ? disk.precache.count + ' 条 · ' + (Number(disk.precache.bytes || 0) / 1024).toFixed(1) + 'KB · 最大单文件 ' + (Number(disk.precache.maxBytes || 0) / 1024).toFixed(1) + 'KB · 版本 ' + disk.precacheVersion
    : '读不到 public/precache.json（先跑 node tools/gen-precache.mjs）'));

  /* gen-precache --check：清单与磁盘必须一致，过期清单 = 离线缺件 */
  const pcCheck = await new Promise((resolve) => {
    let out = '';
    try {
      const c = spawn(process.execPath, [GEN_PRECACHE, '--check'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      c.stdout.on('data', (d) => { out += d.toString(); });
      c.stderr.on('data', (d) => { out += d.toString(); });
      c.on('error', (e) => resolve({ code: -1, out: String(e) }));
      c.on('close', (code) => resolve({ code: code, out: out }));
    } catch (e) { resolve({ code: -1, out: String(e) }); }
  });
  check('gen-precache --check：precache.json 与磁盘一致（退出码 0）', pcCheck.code === 0,
    'exit=' + pcCheck.code + ' · ' + pcCheck.out.trim().split('\n').slice(-3).join(' / '));

  let serverChild = null;
  let worker = null;
  let browser = null;
  let serverLog = '';
  const sink = { phase: 'boot', urls: [], errors: [], failed: [], reqUrls: new Map(), sessions: [] };

  try {
    try {
      const r = await fetch(DEV_ORIGIN + '/manifest.webmanifest');
      info('对照：已在跑的 dev server(3000) /manifest.webmanifest → HTTP ' + r.status + (r.status === 200 ? '（已经重启过，是新代码）' : '（旧代码；重启后才会生效）'));
    } catch (e) { info('对照：dev server(3000) 没响应 ' + e.message); }

    serverChild = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(APP_PORT) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverChild.stdout.on('data', (d) => { serverLog += d.toString(); });
    serverChild.stderr.on('data', (d) => { serverLog += d.toString(); });
    const up = await waitHttp(ORIGIN + '/', 80);
    check('自带 Express 子进程就绪（端口 ' + APP_PORT + '，跑磁盘上的新代码，不动 3000）', up, up ? '' : serverLog.slice(-300));
    if (!up) throw new Error('Express 子进程没起来');

    await httpPhase(ORIGIN, 'Express 线', disk, { worker: false });
    await livePrecachePhase(LIVE_ORIGIN, '常驻 dev server(3000)', disk);

    if (!SKIP_WORKER) {
      info(ensureDistCf(disk));
      const mod = await import('./serve-worker.mjs');
      worker = await mod.createWorkerServer({ port: WORKER_PORT });
      const warm = await worker.warmup();
      info('Worker 线预热：HTTP ' + warm.status + ' · 游戏 ' + warm.games + ' 款');
      await httpPhase(WORIGIN, 'CF（Worker）线', disk, { worker: true });
      await livePrecachePhase(LIVE_WORIGIN, '常驻 Worker(4400)', disk);
      info('dist-cf 是 tools/build-pages.mjs 的白名单产物：没有 manifest.webmanifest / sw.js / icons —— 这三个都是 worker/app.js 内联提供的（上面「逐字节一致」那几条就是防漂移的闸门）');
    }

    if (!SKIP_BROWSER) {
      browser = await launchBrowser();
      info('无头浏览器：' + browser.exe + ' · CDP ' + CDP_PORT + ' · user-data-dir ' + browser.ud);
      await expressBrowserPhase(browser, sink, disk);
      if (!SKIP_WORKER) await workerBrowserPhase(browser, sink, disk);
    }

    console.log('\n== 跨阶段断言 ==');
    /* 断网阶段以 'offline' 开头（offline 壳页 + offline-games 游戏页），一律单列 */
    const isOfflinePhase = (p) => String(p).indexOf('offline') === 0;
    const onlineErrors = sink.errors.filter((e) => !isOfflinePhase(e.phase));
    check('浏览器全程 console 0 报错 / 0 未捕获异常（断网阶段单列）', onlineErrors.length === 0,
      onlineErrors.length ? onlineErrors.slice(0, 3).map((e) => e.phase + '/' + e.kind + ': ' + e.text).join(' | ') : sink.errors.length + ' 条报错全部发生在断网阶段');
    const offErrors = sink.errors.filter((e) => isOfflinePhase(e.phase));
    info('断网阶段（壳页 + 游戏页）的报错 ' + offErrors.length + ' 条（预期就是网络中断）' + (offErrors.length ? '：' + offErrors[0].text.slice(0, 90) : ''));
    const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return u; } };
    const offFailed = sink.failed.filter((f) => isOfflinePhase(f.phase));
    const promised = /^\/(static|games|icons|cover)\//;
    const brokePromise = offFailed.filter((f) => promised.test(pathOf(f.url)));
    check('断网期间 SW 承诺缓存的路径（/static /games /icons /cover）一个都没失败', brokePromise.length === 0,
      brokePromise.length ? brokePromise.map((f) => pathOf(f.url) + ' ' + f.err).join(' | ') : '承诺缓存的资源全部命中缓存');
    const offGameFailed = offFailed.filter((f) => f.phase === 'offline-games' && /^\/games\//.test(pathOf(f.url)));
    check('断网打开游戏页期间 /games/ 下的子资源 0 失败（页面自足 + 预缓存命中）', offGameFailed.length === 0,
      offGameFailed.length ? offGameFailed.map((f) => pathOf(f.url) + ' ' + f.err).join(' | ') : '两款游戏页及其引用的 js 全部命中缓存');
    const grouped = {};
    for (const f of offFailed) { const k = pathOf(f.url); grouped[k] = (grouped[k] || 0) + 1; }
    info('断网期间失败的请求（预期只剩「必须走网络」的那些）：' + (Object.keys(grouped).length ? Object.keys(grouped).map((k) => k + '×' + grouped[k]).join('  ') : '无'));

    const external = sink.urls.filter((u) => u.url.indexOf(ORIGIN) !== 0 && u.url.indexOf(WORIGIN) !== 0
      && u.url.indexOf('data:') !== 0 && u.url.indexOf('about:') !== 0 && u.url.indexOf('devtools://') !== 0);
    check('全程 0 个外部域名请求（同源 + data: 之外一个都没有）', external.length === 0,
      external.length ? external.slice(0, 5).map((u) => u.url).join(' | ') : '共 ' + sink.urls.length + ' 个请求，全部同源');
  } catch (err) {
    fail += 1;
    fails.push('探针异常：' + err.message);
    console.log('  \u2717 探针异常：' + err.message);
    if (serverLog) console.log('  -- server.js 输出（末尾）--\n' + serverLog.slice(-600));
  } finally {
    for (const s of sink.sessions) s.close();
    if (browser) {
      try { browser.child.kill(); } catch (e) { /* 忽略 */ }
      await sleep(400);
      try { fs.rmSync(browser.ud, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    if (worker) { try { await worker.close(); } catch (e) { /* 忽略 */ } }
    if (serverChild) {
      try { serverChild.kill(); } catch (e) { /* 忽略 */ }
      await sleep(500);
      if (serverChild.exitCode === null && serverChild.pid) {
        info('Express 子进程没退，收尾 taskkill /pid ' + serverChild.pid + ' /T /F（只针对自己 spawn 的 pid）');
        try { spawn('taskkill', ['/pid', String(serverChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
      }
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log('  PWA 探针结果：PASS ' + pass + ' · FAIL ' + fail + ' · 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (fails.length) { console.log('  失败项：'); for (const f of fails) console.log('   \u2717 ' + f); }
  console.log('  截图：docs/screens/pwa-home.png · docs/screens/pwa-offline.png · docs/screens/pwa-offline-games.png');
  return fail === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
