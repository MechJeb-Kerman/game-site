#!/usr/bin/env node
/**
 * 真实位图 OG 图自测（src/og.js + tools/og-detect.mjs）
 *
 * 跑法：node tools/og-raster-test.mjs
 *
 * 边界：①~⑥ 全部用注入的假 spawn / 假 fetch / 假时钟，不碰真网络、不起真浏览器；
 *       只有最后一节「⑦ 真机渲染」会真的起一次本机无头 Chrome / Edge——找不到浏览器就记
 *       SKIP，不算失败，但会在输出里明说。真机渲染只杀自己 spawn 的那个进程（src/og.js 的
 *       killTree 只对自己那个 pid 下手），本仓库铁律：禁止按映像名全局杀浏览器。
 * 产物：D:/CODE/.tmp-ver/og-replay.png（真机那条成功时落盘，供人工肉眼查看）
 * 出口码：有失败 1，全过 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  createRasterizer, ogMeta, pngSize, isPng, svgToHtml, browserCandidates, BROWSER_CANDIDATES,
  PNG_MAGIC, OVERSIZE_BYTES, OG_WIDTH, OG_HEIGHT, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES
} from '../src/og.js';
import { replayCardSvg } from '../src/cards.js';
import { detectBrowser } from './og-detect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(ROOT, '..', '.tmp-ver'); // D:/CODE/.tmp-ver
const OUT_PNG = path.join(OUT_DIR, 'og-replay.png');

let pass = 0;
let fail = 0;
let skip = 0;
const SKIPPED = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + String(extra).slice(0, 200)));
  }
}

function skipCase(name, why) {
  skip++;
  SKIPPED.push(name + '（' + why + '）');
  console.log('  SKIP ' + name + '  → ' + why);
}

/* ================================ 测试素材 ================================ */

// 带中文、实体转义、属性里带引号的 SVG：确认 base64 通道是「按字节」走的，没被重新编码。
const SVG_CARD = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">'
  + '<rect width="1200" height="630" fill="#0b1220"/>'
  + '<text x="60" y="140" fill="#f8fafc" font-size="64" font-family="sans-serif">OG 测试卡 &amp; 中文</text>'
  + '</svg>';

/* ---------- 手搓真 PNG（给假 spawn / 假 fetch 当渲染结果） ---------- */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
  return out;
}

/** 造一张宽高正确、结构合法的真 PNG；padBytes 用来把体积顶过 400 KB 那条线。 */
function makePng(width, height, padBytes) {
  const raw = Buffer.alloc((width * 4 + 1) * height); // 每行 filter 字节 + RGBA 全 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // 颜色类型 RGBA
  const parts = [
    Buffer.from(PNG_MAGIC),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0))
  ];
  if (padBytes > 0) parts.push(Buffer.alloc(padBytes)); // 尾巴（只为称重，不参与解析）
  return Buffer.concat(parts);
}

/* ---------- 假子进程 / 假 fetch ---------- */

function fakeSpawn(plan) {
  const p = plan || {};
  const calls = [];
  const fn = function (bin, args, options) {
    const rec = { bin: bin, args: args, options: options, html: '', htmlUrl: '', htmlPath: '', shotPath: '', killed: false, pid: p.pid || 424242 };
    rec.htmlUrl = String(args[args.length - 1] || '');
    rec.htmlPath = decodeURI(rec.htmlUrl.replace('file:///', ''));
    for (let i = 0; i < args.length; i++) {
      if (String(args[i]).indexOf('--screenshot=') === 0) rec.shotPath = String(args[i]).slice('--screenshot='.length);
    }
    try { rec.html = fs.readFileSync(rec.htmlPath, 'utf8'); } catch (e) { rec.html = ''; }
    calls.push(rec);

    const listeners = {};
    const child = {
      pid: rec.pid,
      kill: function () { rec.killed = true; return true; },
      on: function (ev, fn2) { (listeners[ev] = listeners[ev] || []).push(fn2); return child; },
      emit: function (ev, arg) { (listeners[ev] || []).slice().forEach(function (f) { f(arg); }); }
    };
    setTimeout(function () {
      if (p.mode === 'hang') return;                                   // 永不结束 → 触发超时
      if (p.mode === 'error') { child.emit('error', new Error('ENOENT: 假 spawn 起不来')); return; }
      if (p.mode === 'nofile') { child.emit('close', 0); return; }      // 退出了但没留截图
      if (p.mode === 'notpng') { fs.writeFileSync(rec.shotPath, Buffer.from('<html>不是 PNG</html>')); child.emit('close', 0); return; }
      fs.writeFileSync(rec.shotPath, p.png || makePng(OG_WIDTH, OG_HEIGHT, 0));
      child.emit('close', 0);
    }, p.delay === undefined ? 5 : p.delay);
    return child;
  };
  fn.calls = calls;
  return fn;
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async function (url, init) { calls.push({ url: url, init: init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}

/** 假 Response：只实现 og.js 用到的那几个字段（ok / status / arrayBuffer）。 */
function respOf(bytes, status) {
  const st = status === undefined ? 200 : status;
  const b = bytes || Buffer.alloc(0);
  return {
    ok: st >= 200 && st < 300,
    status: st,
    arrayBuffer: async function () { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  };
}

// 假 spawn 用的小环境：临时目录固定在系统临时目录下的自建子目录，跑完自己清掉
const FAKE_TMP = path.join(os.tmpdir(), 'og-raster-test-' + process.pid);
fs.mkdirSync(FAKE_TMP, { recursive: true });

const CHROME_FAKE = 'C:/fake/chrome.exe';
function fakeRasterizer(over) {
  const opts = Object.assign({
    driver: 'chrome',
    env: {},                                  // 显式空 env：不让本机 CHROME_PATH 之类影响断言
    spawn: fakeSpawn({ png: makePng(OG_WIDTH, OG_HEIGHT, 0) }),
    browserCandidates: [CHROME_FAKE],
    browserExists: function () { return true; },
    tmpDir: FAKE_TMP,
    timeoutMs: 3000
  }, over || {});
  const rz = createRasterizer(opts);
  rz.spawnCalls = opts.spawn.calls;
  return rz;
}

/* ================================== 跑 ================================== */

console.log('真实位图 OG 图自测（src/og.js + tools/og-detect.mjs）');

/* ---- ① 入参校验 ---- */
console.log('· ① 入参校验（绝不抛异常，只回错误码）');
{
  const rz = createRasterizer({ driver: 'browser', env: {}, fetch: fakeFetch(async function () { return respOf(makePng(10, 10, 0)); }) });
  const r1 = await rz.png(undefined);
  ok('不传 req → invalid_svg 且不抛', r1.ok === false && r1.error === 'invalid_svg', JSON.stringify(r1));
  const r2 = await rz.png({ kind: 'replay', key: 1, svg: 123 });
  ok('svg 是数字 → invalid_svg', r2.error === 'invalid_svg', JSON.stringify(r2));
  const r3 = await rz.png({ svg: '' });
  ok('svg 空串 → invalid_svg', r3.error === 'invalid_svg');
  const r4 = await rz.png({ svg: '   \n  ' });
  ok('svg 纯空白 → invalid_svg', r4.error === 'invalid_svg');
  const r5 = await rz.png({ svg: { toString: function () { return '<svg/>'; } } });
  ok('svg 是对象 → invalid_svg（不吃 toString 的亏）', r5.error === 'invalid_svg');
  const r6 = await rz.png({ svg: SVG_CARD, width: 4 });
  ok('宽越界（4px）→ bad_size', r6.error === 'bad_size', JSON.stringify(r6));
  const r7 = await rz.png({ svg: SVG_CARD, height: 99999 });
  ok('高越界 → bad_size', r7.error === 'bad_size');
  const s = rz.stats();
  ok('7 次失败全部计进 stats.failures', s.failures === 7, 'failures=' + s.failures);
  ok('失败不入缓存（entries=0）', s.entries === 0 && s.renders === 0);
  ok('lastError 记的是最后一次错误码', s.lastError === 'bad_size', s.lastError);
}

/* ---- ② chrome 驱动（假 spawn） ---- */
console.log('· ② chrome 驱动：无头浏览器截图（假 spawn 走通，真机在 ⑦）');
{
  const shot = makePng(OG_WIDTH, OG_HEIGHT, 0);
  const rz = fakeRasterizer();
  const r = await rz.png({ kind: 'replay', key: 12, svg: SVG_CARD });
  ok('假 spawn 下出图成功', r.ok === true && r.cached === false, JSON.stringify(r));
  ok('回的是真 PNG（魔数 + IHDR 宽高）', isPng(r.bytes) && pngSize(r.bytes).width === OG_WIDTH && pngSize(r.bytes).height === OG_HEIGHT);
  ok('bytesLen 与字节长度一致', r.bytesLen === shot.length && r.bytes.length === shot.length);
  ok('driver 标 chrome', r.driver === 'chrome' && rz.stats().driverUsed === 'chrome');
  ok('cache key 形如 kind:key:宽x高', r.key === 'replay:12:1200x630', r.key);
  ok('pngWidth/pngHeight 从 IHDR 解析', r.pngWidth === 1200 && r.pngHeight === 630);
  ok('正常体积不标 oversized', r.oversized === false);

  const call = rz.spawnCalls[0];
  ok('用的就是候选表里的浏览器路径', call.bin === CHROME_FAKE, call.bin);
  ok('参数含 --window-size=1200,630', call.args.indexOf('--window-size=1200,630') >= 0, call.args.join(' ').slice(0, 200));
  ok('参数含 --screenshot=（落在临时目录）', call.args.some(function (a) { return String(a).indexOf('--screenshot=') === 0 && String(a).indexOf('og-raster-') > 0; }));
  ok('参数含 --headless=new / --disable-gpu / --hide-scrollbars', call.args.indexOf('--headless=new') >= 0 && call.args.indexOf('--disable-gpu') >= 0 && call.args.indexOf('--hide-scrollbars') >= 0);
  ok('末参是临时 HTML 的 file:// 地址', call.htmlUrl.indexOf('file:///') === 0 && call.htmlUrl.indexOf('card.html') > 0, call.htmlUrl);
  ok('HTML 的 img src 用 data:image/svg+xml;base64, 前缀', call.html.indexOf('src="data:image/svg+xml;base64,') > 0);
  const m = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(call.html);
  ok('base64 解回来就是原始 SVG 字节（中文没走样）', !!m && Buffer.from(m[1], 'base64').toString('utf8') === SVG_CARD);
  ok('HTML 与 svgToHtml() 输出完全一致', call.html === svgToHtml(SVG_CARD, OG_WIDTH, OG_HEIGHT));
  ok('HTML 里 margin 归零、画布钉死 1200x630', call.html.indexOf('html,body{margin:0;padding:0;') > 0 && call.html.indexOf('width:1200px;height:630px;') > 0);
  ok('渲染完临时目录已清掉', fs.existsSync(path.dirname(call.htmlPath)) === false, path.dirname(call.htmlPath));
  const s = rz.stats();
  ok('stats：renders=1 / misses=1 / hits=0', s.renders === 1 && s.misses === 1 && s.hits === 0, JSON.stringify(s));
}
{
  const rz = fakeRasterizer({ spawn: fakeSpawn({ mode: 'hang' }), timeoutMs: 150 });
  const r = await rz.png({ svg: SVG_CARD });
  ok('子进程不退出 → timeout（不抛异常）', r.ok === false && r.error === 'timeout', JSON.stringify(r));
  ok('超时后自己 spawn 的子进程被杀掉', rz.spawnCalls[0].killed === true);
  ok('超时也不留临时目录', fs.existsSync(path.dirname(rz.spawnCalls[0].htmlPath)) === false);
}
{
  const rz = fakeRasterizer({ spawn: fakeSpawn({ mode: 'error' }) });
  ok('子进程报 error 事件 → spawn_failed', (await rz.png({ svg: SVG_CARD })).error === 'spawn_failed');
}
{
  const rz = fakeRasterizer({ spawn: function () { throw new Error('boom'); } });
  const r = await rz.png({ svg: SVG_CARD });
  ok('spawn 同步抛错 → spawn_failed（不冒泡）', r.ok === false && r.error === 'spawn_failed', JSON.stringify(r));
}
{
  const rz = fakeRasterizer({ spawn: fakeSpawn({ mode: 'nofile' }) });
  ok('浏览器退出但没留截图 → no_output', (await rz.png({ svg: SVG_CARD })).error === 'no_output');
}
{
  const rz = fakeRasterizer({ spawn: fakeSpawn({ mode: 'notpng' }) });
  ok('截图不是 PNG → bad_png', (await rz.png({ svg: SVG_CARD })).error === 'bad_png');
}
{
  // 尺寸不符：只计数不失败（卡片壳允许别的尺寸，调用方自己决定要不要在意）
  const rz = fakeRasterizer({ spawn: fakeSpawn({ png: makePng(800, 400, 0) }) });
  const r = await rz.png({ svg: SVG_CARD, width: 800, height: 400 });
  ok('尺寸 800x400 的卡照常出图', r.ok === true && pngSize(r.bytes).width === 800);
  const r2 = await rz.png({ svg: SVG_CARD, kind: 'k', key: 'x', width: 800, height: 400 });
  ok('同尺寸但换了 kind/key → 另算一条，重新渲染', r2.cached === false && rz.spawnCalls.length === 2);
  const r3 = await rz.png({ svg: SVG_CARD, width: 800, height: 400 });
  ok('原 key 仍命中（LRU 没把它挤掉）', r3.cached === true && rz.spawnCalls.length === 2);
}
{
  const rz = fakeRasterizer({ spawn: fakeSpawn({ png: makePng(OG_WIDTH, OG_HEIGHT, 0) }) });
  const r = await rz.png({ svg: SVG_CARD, width: 640, height: 320 });
  ok('自定义 640x320：--window-size 跟着请求走', rz.spawnCalls[0].args.indexOf('--window-size=640,320') >= 0, rz.spawnCalls[0].args.join(' ').slice(0, 160));
  ok('自定义尺寸下 IHDR 不符会记 sizeMismatch', rz.stats().sizeMismatch === 1 && r.ok === true);
}
{
  const rz = fakeRasterizer();
  const custom = '<!doctype html><html><head><meta charset="utf-8"></head><body>调用方自己的壳</body></html>';
  const r = await rz.png({ svg: SVG_CARD, html: custom });
  ok('req.html 给了就直接用（不再包一遍壳）', r.ok === true && rz.spawnCalls.length === 1 && rz.spawnCalls[0].html === custom);
  const r2 = await rz.png({ svg: SVG_CARD, html: custom, kind: 'h', key: 'custom' });
  ok('用自带 html 出图同样满足结果契约（真 PNG）', r2.ok === true && isPng(r2.bytes) && r2.pngWidth === 1200);
}

/* ---- ③ 没浏览器 / auto 回退 ---- */
console.log('· ③ 没浏览器时的回退（不抛异常，回错误码）');
{
  const rz = createRasterizer({ driver: 'chrome', env: {}, browserCandidates: [CHROME_FAKE], browserExists: function () { return false; }, tmpDir: FAKE_TMP });
  const r = await rz.png({ svg: SVG_CARD });
  ok('driver:chrome 没浏览器 → no_browser', r.ok === false && r.error === 'no_browser', JSON.stringify(r));
  const r2 = await rz.png({ svg: SVG_CARD });
  ok('回退路径也计入 failures', r2.error === 'no_browser' && rz.stats().failures === 2);
}
{
  const rz = createRasterizer({ driver: 'auto', env: {}, browserCandidates: [CHROME_FAKE], browserExists: function () { return false; }, tmpDir: FAKE_TMP });
  const r = await rz.png({ svg: SVG_CARD });
  ok('driver:auto 没浏览器 → not_configured', r.ok === false && r.error === 'not_configured', JSON.stringify(r));
  ok('auto 下 browserPath() 回空串', (await rz.browserPath()) === '');
}
{
  const rz = createRasterizer({ driver: 'chrome', env: {}, browserCandidates: [], browserExists: function () { return false; } });
  ok('候选表为空也照样 no_browser（不炸）', (await rz.png({ svg: SVG_CARD })).error === 'no_browser');
}
{
  const list = browserCandidates({ CHROME_PATH: 'C:/x/custom.exe' });
  ok('env 覆盖排在候选表最前', list[0] === 'C:/x/custom.exe', list[0]);
  ok('候选表去重（env 与候选撞车时只留一条）', browserCandidates({ CHROME_PATH: BROWSER_CANDIDATES[0] }).length === BROWSER_CANDIDATES.length
    && list.length === BROWSER_CANDIDATES.length + 1 && list.length === new Set(list).size, 'len=' + list.length);
  ok('tools/og-detect.mjs 的探测函数可独立调用（注入 isFile）', detectBrowser({}, function () { return false; }) === '' && detectBrowser({ CHROME_PATH: 'C:/x/custom.exe' }, function (p) { return p === 'C:/x/custom.exe'; }) === 'C:/x/custom.exe');
}
{
  const sp = fakeSpawn({ png: makePng(OG_WIDTH, OG_HEIGHT, 0) });
  const rz = createRasterizer({
    driver: 'chrome', env: {}, chromePath: CHROME_FAKE, tmpDir: FAKE_TMP,
    spawn: sp,
    browserCandidates: ['C:/另一个/candidate.exe'],
    browserExists: function () { return true; }
  });
  const r = await rz.png({ svg: SVG_CARD });
  ok('chromePath 参数优先于候选表', r.ok === true && !!sp.calls[0] && sp.calls[0].bin === CHROME_FAKE, sp.calls[0] && sp.calls[0].bin);
}
{
  // 显式配的路径不存在时，不要死在那儿——继续往候选表里找（可配置 + 可回退）
  const sp2 = fakeSpawn({ png: makePng(OG_WIDTH, OG_HEIGHT, 0) });
  const rz = createRasterizer({
    driver: 'chrome', env: {}, chromePath: 'C:/nope/gone.exe', tmpDir: FAKE_TMP,
    spawn: sp2,
    browserCandidates: [CHROME_FAKE],
    browserExists: function (p) { return p === CHROME_FAKE; }
  });
  const r = await rz.png({ svg: SVG_CARD });
  ok('显式路径不存在时退到候选表里的可用浏览器', r.ok === true && !!sp2.calls[0] && sp2.calls[0].bin === CHROME_FAKE, JSON.stringify(r));
}
{
  // 显式路径与候选都不存在 → no_browser（不是 spawn_failed，调用方据此回退 SVG）
  const rz = createRasterizer({ driver: 'chrome', env: {}, chromePath: 'C:/nope/gone.exe', browserCandidates: [CHROME_FAKE], browserExists: function () { return false; } });
  ok('显式路径与候选都不可用 → no_browser', (await rz.png({ svg: SVG_CARD })).error === 'no_browser');
}

/* ---- ④ browser 驱动（假 fetch） ---- */
console.log('· ④ browser 驱动：渲染端点（Worker 线，假 fetch 走通）');
{
  const png = makePng(OG_WIDTH, OG_HEIGHT, 0);
  const f = fakeFetch(async function () { return respOf(png); });
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://render.example/og', token: 'tk_123', fetch: f });
  const r = await rz.png({ kind: 'profile', key: 'alice', svg: SVG_CARD });
  ok('假 fetch 下出图成功', r.ok === true && r.driver === 'browser', JSON.stringify(r));
  ok('回的就是端点给的字节', r.bytesLen === png.length && isPng(r.bytes));
  const call = f.calls[0];
  ok('POST 到配置的端点', call.url === 'https://render.example/og' && call.init.method === 'POST', call.url);
  ok('请求头带 Bearer token', call.init.headers.authorization === 'Bearer tk_123', JSON.stringify(call.init.headers));
  ok('接受 image/png', call.init.headers.accept === 'image/png' && call.init.headers['content-type'] === 'application/json');
  let body = null;
  try { body = JSON.parse(call.init.body); } catch (e) { body = null; }
  ok('请求体是 {html}，html 里有内联 SVG 的 base64', !!body && typeof body.html === 'string' && body.html.indexOf('data:image/svg+xml;base64,') > 0);
  ok('请求体 html 与 svgToHtml 输出一致', !!body && body.html === svgToHtml(SVG_CARD, OG_WIDTH, OG_HEIGHT));
}
{
  const f = fakeFetch(async function () { return respOf(makePng(10, 10, 0)); });
  const rz = createRasterizer({ driver: 'browser', env: {}, fetch: f });
  const r = await rz.png({ svg: SVG_CARD });
  ok('没配端点 → not_configured，且根本不发请求', r.ok === false && r.error === 'not_configured' && f.calls.length === 0, JSON.stringify(r));
}
{
  // 环境变量兜底：Worker 侧只会给 env
  const f = fakeFetch(async function () { return respOf(makePng(OG_WIDTH, OG_HEIGHT, 0)); });
  const rz = createRasterizer({ driver: 'browser', env: { CLOUDFLARE_BROWSER_RENDERING_URL: 'https://cf.example/render', BROWSER_RENDERING_TOKEN: 'env_tk' }, fetch: f });
  const r = await rz.png({ svg: SVG_CARD });
  ok('从 env 读 CLOUDFLARE_BROWSER_RENDERING_URL', r.ok === true && f.calls[0].url === 'https://cf.example/render', f.calls[0] && f.calls[0].url);
  ok('从 env 读 BROWSER_RENDERING_TOKEN', f.calls[0].init.headers.authorization === 'Bearer env_tk');
  ok('stats 里 endpointConfigured=true', rz.stats().endpointConfigured === true);
}
{
  const f = fakeFetch(async function () { return respOf(makePng(OG_WIDTH, OG_HEIGHT, 0)); });
  const rz = createRasterizer({ driver: 'browser', env: { BROWSER_RENDERING_URL: 'https://generic.example/r' }, fetch: f });
  await rz.png({ svg: SVG_CARD });
  ok('通用的 BROWSER_RENDERING_URL 也认', f.calls[0].url === 'https://generic.example/r');
}
{
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', fetch: fakeFetch(async function () { return respOf(Buffer.from('{}'), 500); }) });
  const r = await rz.png({ svg: SVG_CARD });
  ok('端点 500 → render_failed 且带 status', r.ok === false && r.error === 'render_failed' && r.status === 500, JSON.stringify(r));
}
{
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', fetch: fakeFetch(async function () { throw new Error('ECONNREFUSED'); }) });
  const r = await rz.png({ svg: SVG_CARD });
  ok('fetch 抛错 → render_failed（status=0，不冒泡）', r.ok === false && r.error === 'render_failed' && r.status === 0, JSON.stringify(r));
}
{
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', fetch: fakeFetch(async function () { return respOf(Buffer.from('<html>404 not found</html>')); }) });
  ok('端点回了 HTML 而不是 PNG → bad_png', (await rz.png({ svg: SVG_CARD })).error === 'bad_png');
}
{
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', fetch: fakeFetch(async function () { return respOf(Buffer.alloc(0)); }) });
  const r = await rz.png({ svg: SVG_CARD });
  ok('端点 200 但空响应 → render_failed', r.ok === false && r.error === 'render_failed', JSON.stringify(r));
}
{
  const slowFetch = fakeFetch(function (url, init) {
    return new Promise(function (resolve, reject) {
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', function () { reject(new Error('aborted')); });
      }
      setTimeout(function () { resolve(respOf(makePng(10, 10, 0))); }, 400);
    });
  });
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', timeoutMs: 80, fetch: slowFetch });
  const r = await rz.png({ svg: SVG_CARD });
  ok('端点超时 → timeout（AbortController 掐断）', r.ok === false && r.error === 'timeout', JSON.stringify(r));
}
{
  const f = fakeFetch(async function () { return respOf(makePng(OG_WIDTH, OG_HEIGHT, 0)); });
  const rz = createRasterizer({ driver: 'browser', env: {}, endpoint: 'https://r/og', token: '', fetch: f });
  await rz.png({ svg: SVG_CARD });
  ok('不配 token 就不带 Authorization 头', rz.stats().renders === 1 && f.calls[0].init.headers.authorization === undefined, JSON.stringify(f.calls[0].init.headers));
}

/* ---- ⑤ 缓存：命中 / LRU / TTL / 上限 / 体积标记 ---- */
console.log('· ⑤ 缓存（命中不重渲染、LRU 淘汰、TTL 过期、体积标记）');
{
  const rz = fakeRasterizer();
  const a1 = await rz.png({ kind: 'replay', key: '7', svg: SVG_CARD });
  const a2 = await rz.png({ kind: 'replay', key: '7', svg: SVG_CARD });
  ok('第二次同 key 直接命中缓存', a1.cached === false && a2.cached === true);
  ok('命中回的是同一份字节对象', a2.bytes === a1.bytes);
  ok('命中不重复渲染（renders=1 / hits=1 / spawn 只调一次）', rz.stats().renders === 1 && rz.stats().hits === 1 && rz.spawnCalls.length === 1, JSON.stringify(rz.stats()));
  const a3 = await rz.png({ kind: 'replay', key: '7', svg: SVG_CARD, width: 600, height: 300 });
  ok('尺寸进了 key：换尺寸要重新渲染', a3.ok === true && a3.cached === false && rz.spawnCalls.length === 2);
  ok('key 把 kind:key:宽x高 三段都写清', a3.key === 'replay:7:600x300', a3.key);
  const a4 = await rz.png({ kind: 'profile', key: '7', svg: SVG_CARD });
  ok('kind 不同也是不同条目', a4.key === 'profile:7:1200x630' && a4.cached === false && rz.spawnCalls.length === 3);
  ok('clear() 回清掉的条目数并清空', rz.clear() === 3 && rz.stats().entries === 0);
  ok('clear 后同 key 要重新渲染', (await rz.png({ kind: 'replay', key: '7', svg: SVG_CARD })).cached === false && rz.spawnCalls.length === 4);
  ok('stats 默认值：ttl 6 小时 / 上限 64', rz.stats().ttlMs === DEFAULT_TTL_MS && rz.stats().maxEntries === DEFAULT_MAX_ENTRIES);
}
{
  const rz = fakeRasterizer({ maxEntries: 2 });
  await rz.png({ kind: 'r', key: '1', svg: SVG_CARD });
  await rz.png({ kind: 'r', key: '2', svg: SVG_CARD });
  await rz.png({ kind: 'r', key: '3', svg: SVG_CARD });
  const s = rz.stats();
  ok('LRU：超过上限淘汰最久没命中的那条', s.entries === 2 && s.evictions === 1, JSON.stringify(s));
  const l1 = await rz.png({ kind: 'r', key: '1', svg: SVG_CARD });
  ok('被淘汰的 key 要重新渲染', l1.cached === false && rz.spawnCalls.length === 4);
  const l3 = await rz.png({ kind: 'r', key: '3', svg: SVG_CARD });
  ok('还留着的 key 仍然命中', l3.cached === true && rz.spawnCalls.length === 4);
}
{
  let clock = 1000000;
  const rz = fakeRasterizer({ ttlMs: 60000, now: function () { return clock; } });
  await rz.png({ kind: 'daily', key: '2026-10-20', svg: SVG_CARD });
  clock += 30000;
  ok('TTL 内命中', (await rz.png({ kind: 'daily', key: '2026-10-20', svg: SVG_CARD })).cached === true && rz.spawnCalls.length === 1);
  clock += 61000; // 累计 91 秒 > 60 秒
  const t3 = await rz.png({ kind: 'daily', key: '2026-10-20', svg: SVG_CARD });
  ok('TTL 过期要重新渲染并计入 expired', t3.cached === false && rz.spawnCalls.length === 2 && rz.stats().expired === 1, JSON.stringify(rz.stats()));
  ok('过期后新条目顶替旧位置（entries 仍为 1）', rz.stats().entries === 1);
}
{
  const rz = fakeRasterizer({ ttlMs: 0 });
  await rz.png({ svg: SVG_CARD });
  await rz.png({ svg: SVG_CARD });
  ok('ttlMs<=0 表示不缓存：每次都渲染', rz.spawnCalls.length === 2 && rz.stats().entries === 0 && rz.stats().hits === 0);
}
{
  const big = makePng(OG_WIDTH, OG_HEIGHT, OVERSIZE_BYTES + 1024);
  const rz = fakeRasterizer({ spawn: fakeSpawn({ png: big }) });
  const r = await rz.png({ kind: 'replay', key: 'big', svg: SVG_CARD });
  ok('体积超 400 KB：结果标 oversized', r.ok === true && r.oversized === true && r.bytesLen > OVERSIZE_BYTES, r.bytesLen + ' 字节');
  ok('超限不自动降质（字节原样回）', r.bytes.length === big.length);
  ok('stats：oversized 布尔 + oversizedCount 计数', rz.stats().oversized === true && rz.stats().oversizedCount === 1 && rz.stats().limitBytes === OVERSIZE_BYTES);
  const r2 = await rz.png({ kind: 'replay', key: 'big', svg: SVG_CARD });
  ok('超限图也能命中缓存（bytesLen 一致）', r2.cached === true && r2.oversized === true && r2.bytesLen === r.bytesLen);
}

/* ---- ⑥ ogMeta（纯函数） ---- */
console.log('· ⑥ ogMeta：位图就绪走 og.png，没就绪回退既有的 card.svg');
{
  ok('replay + png → /play/12/og.png', ogMeta('https://g.example', 'replay', 12, { png: true }) === 'https://g.example/play/12/og.png');
  ok('replay 默认 → /play/12/card.svg（行为与现在一致）', ogMeta('https://g.example', 'replay', 12, {}) === 'https://g.example/play/12/card.svg');
  ok('profile + png → /u/<名字>/og.png（名字 URL 编码）', ogMeta('https://g.example', 'profile', 'a b/中', { png: true }) === 'https://g.example/u/' + encodeURIComponent('a b/中') + '/og.png');
  ok('profile 默认 → /u/<名字>/card.svg', ogMeta('https://g.example', 'profile', 'alice') === 'https://g.example/u/alice/card.svg');
  ok('daily + png → /daily/og.png（没有 id 段）', ogMeta('https://g.example', 'daily', null, { png: true }) === 'https://g.example/daily/og.png');
  ok('daily 默认 → /daily/card.svg', ogMeta('https://g.example', 'daily', null) === 'https://g.example/daily/card.svg');
  ok('origin 末尾斜杠被吃掉', ogMeta('https://g.example/', 'replay', 1, { png: true }) === 'https://g.example/play/1/og.png');
  ok('kind 别名 play / user / day 都认', ogMeta('https://g.example', 'play', 1, { png: true }) === 'https://g.example/play/1/og.png'
    && ogMeta('https://g.example', 'user', 'u1', {}) === 'https://g.example/u/u1/card.svg'
    && ogMeta('https://g.example', 'day', null, { png: true }) === 'https://g.example/daily/og.png');
  ok('认不出的 kind → 空串（调用方回退站内默认 OG 图）', ogMeta('https://g.example', 'nope', 1, { png: true }) === '');
  ok('png 传假值 → 仍然是 card.svg', ogMeta('https://g.example', 'replay', 12, { png: false }) === 'https://g.example/play/12/card.svg');
}

/* ---- ⑦ 真机渲染 ---- */
console.log('· ⑦ 真机渲染：本机无头浏览器把 replayCardSvg 拍成 PNG');
let realPngPath = '';
{
  const browser = detectBrowser();
  if (!browser) {
    skipCase('真机渲染 replayCardSvg → PNG', '本机没找到 Chrome / Edge（先跑 node tools/og-detect.mjs 看候选表，可设 CHROME_PATH 指定）');
  } else {
    const rz = createRasterizer({ driver: 'chrome', timeoutMs: 60000 });
    ok('本机浏览器探测与 tools/og-detect.mjs 口径一致', (await rz.browserPath()) === browser, browser);
    const svg = replayCardSvg({
      replay: {
        id: 12, game: 'gomoku', code: 'ABC123', hostName: '小明', guestName: '小红',
        result: 'host', winner: '小明', moveCount: 3,
        moves: [{ seq: 1, seat: 0, move: '7,7' }, { seq: 2, seat: 1, move: '8,8' }, { seq: 3, seat: 0, move: '7,8' }],
        createdAt: Date.UTC(2026, 9, 20, 8, 11)
      },
      game: { slug: 'gomoku', title: '五子棋', emoji: '⚫', accent: '#6366f1', accent2: '#8b5cf6', category: { slug: 'board', name: '棋牌' } },
      origin: 'https://game.example.com'
    });
    const t0 = Date.now();
    const r = await rz.png({ kind: 'replay', key: 12, svg: svg });
    const cost = Date.now() - t0;
    ok('真机：无头浏览器渲染成功（' + browser.replace(/^.*[\\/]/, '') + '，' + cost + 'ms）', r.ok === true, JSON.stringify(r).slice(0, 200));
    if (r.ok) {
      ok('真机：真 PNG 魔数（137 80 78 71 13 10 26 10）', r.bytes[0] === 137 && r.bytes[1] === 80 && r.bytes[2] === 78 && r.bytes[3] === 71 && r.bytes[4] === 13 && r.bytes[5] === 10 && r.bytes[6] === 26 && r.bytes[7] === 10);
      ok('真机：IHDR 解析出 1200x630', r.pngWidth === 1200 && r.pngHeight === 630, r.pngWidth + 'x' + r.pngHeight);
      ok('真机：体积 < 400 KB', r.bytesLen < OVERSIZE_BYTES && r.oversized === false, Math.round(r.bytesLen / 1024) + ' KB');
      ok('真机：缓存命中不重渲染（第二次同 key）', (await rz.png({ kind: 'replay', key: 12, svg: svg })).cached === true && rz.stats().renders === 1);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(OUT_PNG, Buffer.from(r.bytes));
      realPngPath = OUT_PNG;
      ok('真机：PNG 落盘供人工查看', fs.existsSync(OUT_PNG) && fs.statSync(OUT_PNG).size === r.bytesLen, OUT_PNG);
      console.log('        产物：' + OUT_PNG + '（' + Math.round(r.bytesLen / 1024) + ' KB，' + r.pngWidth + 'x' + r.pngHeight + '，driver=' + r.driver + '）');
    } else {
      fail++;
      console.log('  FAIL 真机渲染失败，后 4 条断言无法判定：' + JSON.stringify(r).slice(0, 200));
    }
  }
}

/* ------------------------------- 收尾 ------------------------------- */

try { fs.rmSync(FAKE_TMP, { recursive: true, force: true }); } catch (e) { /* Windows 句柄没放就下次再说 */ }

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (skip ? '，跳过 ' + skip + ' 项' : ''));
if (SKIPPED.length) {
  for (const s of SKIPPED) console.log('  跳过：' + s);
}
if (realPngPath) console.log('真机产物：' + realPngPath);
process.exit(fail ? 1 : 0);
