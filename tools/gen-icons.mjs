/**
 * 生成 PWA 图标到 public/icons/（可重复运行，覆盖旧文件）。
 *
 *   node tools/gen-icons.mjs          # 或 pnpm gen:icons
 * 环境变量：CHROME（浏览器路径）、CDP_PORT（默认 9381）
 *
 * 做法与仓库既有探针一致：起一个无头 Edge/Chrome，用 CDP 打开一段**纯 CSS** 图形再截图。
 * 不引用任何外部字体、外部图片、CDN，图形全部由 CSS 画（几何形状 + 纯色块 + 圆角）。
 *
 * 截完图后还会做两件事，都是无损的，只用 Node 标准库：
 *   1) 重压：Edge 的编码器几乎不做行滤波，同样像素它给 20KB；按行挑最优滤波 + deflate(9) 之后只要 5KB 上下。
 *      重压后会解码回来逐像素比对，不一致就退回原图（不会把图形改坏）。
 *   2) 同步：把 4 张图的 base64 写进 worker/app.js 的 PWA-ICONS 标记块。CF 生产线的静态资源来自
 *      dist-cf，而 tools/build-pages.mjs 的产出白名单里没有 icons，Worker 又没有磁盘，只能内联。
 *      所以「public/icons/*.png 是唯一事实来源，跑一次本脚本两条线就同步」。
 *
 * 为什么不用中文站名做字标：无头环境不保证装得下中文字形（PingFang SC / 微软雅黑都只存在于
 * 特定系统），而 192px 与 maskable 安全区里的字标本来就看不清。几何图形的渲染结果是确定性的。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(ROOT, 'public', 'icons');
const PORT = Number(process.env.CDP_PORT || 9381);
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const CHROME = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) { console.error('找不到 Chrome / Edge，可用 CHROME 环境变量指定'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 四种图标：any 两个尺寸走圆角透明角；maskable 与 apple-touch 必须满幅不透明（由系统自己裁形状） */
const ICONS = [
  { name: 'icon-192.png', size: 192, shape: 'any' },
  { name: 'icon-512.png', size: 512, shape: 'any' },
  { name: 'icon-maskable-512.png', size: 512, shape: 'maskable' },
  { name: 'apple-touch-icon-180.png', size: 180, shape: 'apple' }
];

/** 站点配色（与 public/css/style.css 的 :root 一致） */
const BRAND = '#6366f1';
const BRAND2 = '#a855f7';
const SKY = '#38bdf8';
const HOT = '#f97316';

/**
 * 一个图标 = 一整页。页面尺寸就是图标尺寸，图形的左上角在 (0,0)，
 * 截图时按 size×size 裁剪，所以不需要考虑滚动或居中。
 */
function iconHtml(size, shape) {
  const full = shape === 'maskable' || shape === 'apple';
  const radius = full ? 0 : Math.round(size * 0.22);
  // maskable 的内容要落在中心安全区内（圆形蒙版最多裁掉边缘），所以图形更小
  const plate = Math.round(size * (shape === 'maskable' ? 0.58 : shape === 'apple' ? 0.76 : 0.72));
  const pad = Math.round(plate * 0.1);
  const gap = Math.round(plate * 0.07);
  const tile = Math.round((plate - pad * 2 - gap) / 2);
  const tileR = Math.round(tile * 0.26);
  const plateR = Math.round(plate * 0.24);
  const line = Math.max(1, Math.round(size / 256));
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}',
    // 只用纯色块（没有渐变）：PNG 里大片同色，deflate 后极小 —— Worker 线要把图标 base64 内联进 worker/app.js，
    // 体积直接决定这条路走不走得通（渐变版单张 145KB，内联不可行；纯色版单张 5KB 左右）。
    '#ico{position:relative;width:' + size + 'px;height:' + size + 'px;border-radius:' + radius + 'px;overflow:hidden;',
    'background:#0b1020}',
    '#ico::after{content:"";position:absolute;inset:0;border-radius:inherit;',
    'box-shadow:inset 0 0 0 ' + Math.max(1, Math.round(size / 160)) + 'px rgba(255,255,255,.10)}',
    '.plate{position:absolute;left:50%;top:50%;width:' + plate + 'px;height:' + plate + 'px;transform:translate(-50%,-50%);',
    'background:#151d38;border-radius:' + plateR + 'px;padding:' + pad + 'px;box-sizing:border-box;',
    'display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:' + gap + 'px;',
    'box-shadow:inset 0 0 0 ' + line + 'px rgba(255,255,255,.09)}',
    '.t{border-radius:' + tileR + 'px;box-shadow:inset 0 ' + line + 'px 0 rgba(255,255,255,.26)}',
    '.t1{background:' + BRAND + '}.t2{background:' + BRAND2 + '}.t3{background:' + SKY + '}.t4{background:' + HOT + '}',
    '</style></head><body><div id="ico"><div class="plate">',
    '<i class="t t1"></i><i class="t t2"></i><i class="t t3"></i><i class="t t4"></i>',
    '</div></div></body></html>'
  ].join('');
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    const self = this;
    return new Promise(function (res, rej) {
      self.ws = new WebSocket(self.url);
      self.ws.onopen = function () { res(); };
      self.ws.onerror = function () { rej(new Error('WebSocket 连接失败')); };
      self.ws.onmessage = function (m) {
        const msg = JSON.parse(m.data);
        if (msg.id && self.pending.has(msg.id)) {
          const p = self.pending.get(msg.id);
          self.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        } else if (msg.method) { self.events.push(msg); }
      };
    });
  }
  send(method, params) {
    const self = this;
    const id = ++this.id;
    return new Promise(function (resolve, reject) {
      self.pending.set(id, { resolve: resolve, reject: reject });
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (self.pending.has(id)) { self.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/** 只解析 PNG 的 IHDR，用来证明产物是「真 PNG」且尺寸就是我们要的 */
function pngInfo(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25]
  };
}

const MAX_BYTES = 200 * 1024;

/* ---------------- PNG 编解码：只为无损重压 ---------------- */
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

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/** 解出 8bit/无隔行的 RGB 或 RGBA 像素（本脚本只产出这两种）。失败返回 null。 */
function pngDecode(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let off = 8, hdr = null;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      hdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!hdr || hdr.bitDepth !== 8 || hdr.interlace !== 0 || !idat.length) return null;
  const bpp = hdr.colorType === 6 ? 4 : (hdr.colorType === 2 ? 3 : 0);
  if (!bpp) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = hdr.width * bpp;
  const px = Buffer.alloc(stride * hdr.height);
  let p = 0;
  for (let y = 0; y < hdr.height; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      out[x] = v & 0xff;
    }
  }
  return { width: hdr.width, height: hdr.height, colorType: hdr.colorType, bpp, pixels: px };
}

/** 逐行在 5 种滤波里挑绝对值和最小的（optipng 的老办法），再 deflate(9)。 */
function pngEncode(img) {
  const stride = img.width * img.bpp;
  const raw = Buffer.alloc((stride + 1) * img.height);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < img.height; y++) {
    const line = img.pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? img.pixels.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= img.bpp ? line[x - img.bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = (prev && x >= img.bpp) ? prev[x - img.bpp] : 0;
        let v;
        if (f === 0) v = line[x];
        else if (f === 1) v = line[x] - a;
        else if (f === 2) v = line[x] - b;
        else if (f === 3) v = line[x] - ((a + b) >> 1);
        else v = line[x] - paeth(a, b, c);
        v &= 0xff;
        out[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = img.colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 解码 -> 重编码 -> 再解码比对像素；不一致或没变小就返回 null（调用方退回原图）。 */
function pngOptimize(buf) {
  const img = pngDecode(buf);
  if (!img) return null;
  const out = pngEncode(img);
  const back = pngDecode(out);
  if (!back || back.width !== img.width || back.height !== img.height || !back.pixels.equals(img.pixels)) return null;
  return { img, buf: out.length < buf.length ? out : buf };
}

/** 取某点 alpha；没有 alpha 通道的 PNG 视为完全不透明。 */
function alphaAt(img, x, y) {
  if (img.colorType !== 6) return 255;
  return img.pixels[(y * img.width + x) * 4 + 3];
}

/* ---------------- 把图标同步进 worker/app.js ---------------- */
const WORKER = path.join(ROOT, 'worker', 'app.js');
const SYNC_BEGIN = '/* PWA-ICONS:BEGIN */';
const SYNC_END = '/* PWA-ICONS:END */';

function syncWorkerIcons(icons) {
  const src = fs.readFileSync(WORKER, 'utf8');
  const i = src.indexOf(SYNC_BEGIN);
  const j = src.indexOf(SYNC_END);
  if (i < 0 || j < i) return 'worker/app.js 里没有 PWA-ICONS 标记块，跳过内联同步';
  const body = icons.map(function (ic) {
    return "  '" + ic.url + "':\n    '" + ic.buf.toString('base64') + "'";
  }).join(',\n');
  const block = SYNC_BEGIN + '\nconst PWA_ICONS = {\n' + body + '\n};\n' + SYNC_END;
  const next = src.slice(0, i) + block + src.slice(j + SYNC_END.length);
  if (next === src) return 'worker/app.js 的内联图标已是最新（内容逐字节一致）';
  fs.writeFileSync(WORKER, next);
  return '已把 ' + icons.length + ' 张图标 base64 同步进 worker/app.js';
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-icons-'));
  const files = ICONS.map(function (ic, i) {
    const f = path.join(tmp, 'icon-' + i + '.html');
    fs.writeFileSync(f, iconHtml(ic.size, ic.shape));
    return f;
  });

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-icons-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--mute-audio',
    '--force-device-scale-factor=1', '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const rows = [];
  const written = [];
  const problems = [];
  try {
    let ok = false;
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) { ok = true; break; } } catch (e) {}
      await sleep(200);
    }
    if (!ok) throw new Error('浏览器 DevTools 端口没能启动：' + PORT);

    const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = new CDP(t.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (let i = 0; i < ICONS.length; i++) {
      const ic = ICONS[i];
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: ic.size, height: ic.size, deviceScaleFactor: 1, mobile: false
      });
      await cdp.send('Page.navigate', { url: 'file:///' + files[i].replace(/\\/g, '/') });
      for (let k = 0; k < 60; k++) {
        const st = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (st.result && st.result.value === 'complete') break;
        await sleep(100);
      }
      await sleep(120);
      // 透明背景：any 形状的圆角外面必须真透明（否则截出来是不透明的黑角）。
      // maskable / apple 形状整幅不透明，这个覆盖对它们没有影响。
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: ic.size, height: ic.size, scale: 1 }
      });
      const raw = Buffer.from(shot.data, 'base64');
      const dest = path.join(OUT, ic.name);
      const opt = pngOptimize(raw);
      if (!opt) {
        const info = pngInfo(raw);
        problems.push(ic.name + '：截图不是可无损重压的真 PNG'
          + (info ? '（' + info.width + 'x' + info.height + '，位深 ' + info.bitDepth + '，colorType ' + info.colorType + '）' : '（IHDR 缺失）'));
      } else {
        const img = opt.img;
        const corner = alphaAt(img, 0, 0);
        if (img.width !== ic.size || img.height !== ic.size) {
          problems.push(ic.name + '：尺寸 ' + img.width + 'x' + img.height + '，应为 ' + ic.size + 'x' + ic.size);
        } else if (ic.shape === 'any' && corner !== 0) {
          problems.push(ic.name + '：any 形状的圆角必须透明，实测角像素 alpha=' + corner + '（colorType ' + img.colorType + '）');
        } else if (ic.shape !== 'any' && corner !== 255) {
          problems.push(ic.name + '：' + ic.shape + ' 形状必须整幅不透明，实测角像素 alpha=' + corner);
        } else if (opt.buf.length > MAX_BYTES) {
          problems.push(ic.name + '：' + opt.buf.length + ' 字节，超过 200KB');
        } else {
          fs.writeFileSync(dest, opt.buf);
          written.push({ url: '/icons/' + ic.name, buf: opt.buf });
        }
        rows.push({
          file: path.relative(ROOT, dest).replace(/\\/g, '/'),
          png: img.width + 'x' + img.height,
          depth: '8/c' + img.colorType,
          bytes: opt.buf.length,
          rawBytes: raw.length
        });
      }
    }
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    for (let i = 0; i < 40; i++) { if (chrome.exitCode !== null || chrome.killed) break; await sleep(50); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }

  for (const r of rows) {
    const cut = r.rawBytes && r.rawBytes > r.bytes ? '  （Edge 原图 ' + (r.rawBytes / 1024).toFixed(1) + ' KB，重压 -' + Math.round(100 - r.bytes / r.rawBytes * 100) + '%）' : '';
    console.log('  ' + r.file.padEnd(38) + r.png.padEnd(10) + r.depth.padEnd(9) + (r.bytes / 1024).toFixed(1) + ' KB' + cut);
  }
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log('  ✗ ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log('  ✓ ' + rows.length + ' 个图标已写入 public/icons/（真 PNG，IHDR 尺寸与文件名一致，角像素 alpha 已校验，单张 <200KB）');
  console.log('  ✓ ' + syncWorkerIcons(written) + ' —— 两条线的图标由此保持同源');
}

main().catch(function (e) {
  console.error('gen-icons 失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
