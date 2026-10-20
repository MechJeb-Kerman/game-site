#!/usr/bin/env node
/**
 * 静态封面生图：20 款游戏 → public/covers/<slug>.svg + public/covers/manifest.json
 *
 * 跑法：
 *   node tools/gen-covers.mjs            生成 / 增量更新（内容没变就不动盘，字节与 mtime 都不变）
 *   node tools/gen-covers.mjs --check    只校验：清单与磁盘一致 exit 0；缺文件 / 多余文件 / 内容漂移 exit 1
 *   node tools/gen-covers.mjs --quiet    少说话
 *   node tools/gen-covers.mjs --help     用法
 *
 * 边界与环境变量：
 *   · slug / alt / palette 全部读 src/covers.js（唯一事实来源，本文件不另存第二份）；
 *   · games/ 存在时校验 slug 与目录一一对应，不齐就 exit 2；games/ 不存在只警告继续
 *     （最小副本里也能跑，tools/cover-test.mjs 用的就是 COVERS_ROOT 换根 + 补一份 games/ 名字）；
 *   · COVERS_ROOT=<dir> 换根（默认本文件的上两级），自测靠它建临时树，绝不碰真仓库的 public/covers/。
 *
 * 产物口径：1200×675 纯几何 SVG —— 没有 <text>、没有任何字体引用、没有外链，整个文件是 ASCII，
 *   文字由页面渲染（卡片标题 / img alt），理由见 src/covers.js 顶部注释；viewBox 缩放不失真。
 *   单文件硬上限 12 KB（本套实际 4.3~10.6 KB）。同一 slug 同一次输入 → 字节完全相同（无随机、无时间戳进 SVG）。
 *
 * 出口码：0 成功 / 一致；1 --check 发现差异；2 用法或结构错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.COVERS_ROOT ? path.resolve(process.env.COVERS_ROOT) : path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'public', 'covers');
const GAMES_DIR = path.join(ROOT, 'games');
const MANIFEST_NAME = 'manifest.json';
const W = 1200;
const H = 675;
const MAX_BYTES = 12 * 1024;
const CX = W / 2;
const CY = H / 2;

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const QUIET = argv.includes('--quiet');
const HELP = argv.includes('--help') || argv.includes('-h');
const KNOWN_FLAGS = ['--check', '--quiet', '--help', '-h'];

function log(msg) { if (!QUIET) console.log(msg); }
function say(msg) { console.log(msg); }

function printUsage() {
  console.log([
    '用法：node tools/gen-covers.mjs [--check] [--quiet]',
    '',
    '  （无参数）  生成 / 增量更新 public/covers/<slug>.svg 与 manifest.json',
    '  --check     只比对清单与磁盘，不写盘；一致 exit 0，缺文件 / 多余文件 / 内容漂移 exit 1',
    '  --quiet     不打印进度（--check 的结论照打）',
    '  --help      本用法',
    '',
    '环境变量：COVERS_ROOT=<dir> 换根目录（默认仓库根，即本文件的上两级）。',
    '出口码：0 通过；1 --check 有差异；2 用法错误或结构不齐（缺配色 / 缺母题 / games 与 slugs 对不上）。'
  ].join('\n'));
}

const bad = argv.filter(function (a) { return a.startsWith('-') && KNOWN_FLAGS.indexOf(a) === -1; });
if (bad.length) {
  console.error('未知参数：' + bad.join(' '));
  printUsage();
  process.exit(2);
}
if (HELP) {
  printUsage();
  process.exit(0);
}

const coversMod = await import(pathToFileURL(path.join(ROOT, 'src', 'covers.js')).href);
const COVERS = coversMod.COVERS;
if (!COVERS || typeof COVERS !== 'object') {
  console.error('src/covers.js 没有导出 COVERS 表：' + path.join(ROOT, 'src', 'covers.js'));
  process.exit(2);
}

/* ============================== 颜色与几何小工具 ============================== */

function hexRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function toHex(rgb) {
  return '#' + rgb.map(function (v) {
    const x = Math.max(0, Math.min(255, Math.round(v)));
    return (x < 16 ? '0' : '') + x.toString(16);
  }).join('');
}
function mix(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
function lighten(c, t) { return mix(c, '#ffffff', t); }
function darken(c, t) { return mix(c, '#000000', t); }

function n(x) { return Math.round(x * 10) / 10; }
function attrs(o) {
  let s = '';
  const keys = Object.keys(o || {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let v = o[k];
    if (v === null || v === undefined || v === false) continue;
    /* 省字节的等价短写：白/黑三字节缩成 #fff / #000，0.xx 去掉前导 0（SVG 数字允许） */
    if (v === '#ffffff') v = '#fff';
    else if (v === '#000000') v = '#000';
    if (typeof v === 'string' && v.length > 1 && v.charCodeAt(0) === 48 && v.charCodeAt(1) === 46) v = v.slice(1);
    s += ' ' + k + '="' + v + '"';
  }
  return s;
}
function tag(name, o, inner) {
  const a = attrs(o);
  if (inner === undefined) return '<' + name + a + '/>';
  return '<' + name + a + '>' + inner + '</' + name + '>';
}
function rect(x, y, w, h, fill, a) { return tag('rect', Object.assign({ x: n(x), y: n(y), width: n(w), height: n(h), fill: fill }, a)); }
function rrect(x, y, w, h, rx, fill, a) { return tag('rect', Object.assign({ x: n(x), y: n(y), width: n(w), height: n(h), rx: n(rx), fill: fill }, a)); }
function circle(cx, cy, r, fill, a) { return tag('circle', Object.assign({ cx: n(cx), cy: n(cy), r: n(r), fill: fill }, a)); }
function ring(cx, cy, r, stroke, sw, a) { return tag('circle', Object.assign({ cx: n(cx), cy: n(cy), r: n(r), fill: 'none', stroke: stroke, 'stroke-width': n(sw) }, a)); }
function ellipse(cx, cy, rx, ry, fill, a) { return tag('ellipse', Object.assign({ cx: n(cx), cy: n(cy), rx: n(rx), ry: n(ry), fill: fill }, a)); }
function pathEl(d, a) { return tag('path', Object.assign({ d: d }, a)); }
/* 无样式矩形：样式由外层 <g> 统一给，用来省掉重复属性 */
function bareRect(x, y, w, h, rx) { return tag('rect', { x: n(x), y: n(y), width: n(w), height: n(h), rx: n(rx) }); }
function line(x1, y1, x2, y2, a) { return tag('line', Object.assign({ x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2) }, a)); }
function poly(pts, a) {
  return tag('polygon', Object.assign({ points: pts.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join(' ') }, a));
}
function group(kids, a) { return tag('g', a || {}, kids.join('')); }
function rot(deg, cx, cy) { return 'rotate(' + n(deg) + ' ' + n(cx) + ' ' + n(cy) + ')'; }
function glowAt(cx, cy, r) { return circle(cx, cy, r, 'url(#glow)'); }
function glowAt2(cx, cy, r) { return circle(cx, cy, r, 'url(#glow2)'); }

function sparkle(cx, cy, r, fill, op) {
  const k = r * 0.3;
  return poly([[cx, cy - r], [cx + k, cy - k], [cx + r, cy], [cx + k, cy + k], [cx, cy + r], [cx - k, cy + k], [cx - r, cy], [cx - k, cy - k]], { fill: fill, 'fill-opacity': op === undefined ? 0.9 : op });
}
function arrow(x1, y1, x2, y2, color, w) {
  const ang = Math.atan2(y2 - y1, x2 - x1), s = 26;
  const l = [x2 - Math.cos(ang - 0.42) * s, y2 - Math.sin(ang - 0.42) * s];
  const r = [x2 - Math.cos(ang + 0.42) * s, y2 - Math.sin(ang + 0.42) * s];
  return line(x1, y1, x2, y2, { stroke: color, 'stroke-width': w || 4, 'stroke-linecap': 'round' }) + poly([[x2, y2], l, r], { fill: color });
}
function pips(cx, cy, k, r, fill, op) {
  const spots = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const order = [4, 0, 8, 2, 6, 1, 3, 5, 7];
  const unit = r * 2.7, out = [];
  for (let i = 0; i < k && i < 9; i++) {
    const s = spots[order[i]];
    out.push(circle(cx + s[0] * unit, cy + s[1] * unit, r, fill, { 'fill-opacity': op === undefined ? 0.92 : op }));
  }
  return out.join('');
}
function symbol(kind, cx, cy, size, color, op) {
  const o = { fill: color, 'fill-opacity': op === undefined ? 0.85 : op };
  if (kind === 'circle') return ring(cx, cy, size, color, size * 0.32, { 'stroke-opacity': op === undefined ? 0.85 : op }) + circle(cx, cy, size * 0.26, color, { 'fill-opacity': op === undefined ? 0.9 : op });
  if (kind === 'diamond') return poly([[cx, cy - size], [cx + size, cy], [cx, cy + size], [cx - size, cy]], o);
  if (kind === 'triangle') return poly([[cx, cy - size], [cx + size * 0.92, cy + size * 0.72], [cx - size * 0.92, cy + size * 0.72]], o);
  if (kind === 'square') return rrect(cx - size * 0.82, cy - size * 0.82, size * 1.64, size * 1.64, size * 0.22, color, { 'fill-opacity': op === undefined ? 0.85 : op });
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = Math.PI / 180 * (60 * i - 90);
    pts.push([cx + Math.cos(ang) * size, cy + Math.sin(ang) * size]);
  }
  return poly(pts, o);
}

function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngOf(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================== 每款游戏的「骨架参数」 ============================== */
/* 这里只放背景（渐变角、光晕位置、底纹）。母题在下面的 MOTIFS 里，key 一律用 slug，
   不写数组、不写顺序，避免 COVERS 增删时错位。SPEC 与 COVERS 必须一一对应，缺一个就 exit 2。 */

const SPEC = {
  '2048':       { angle: 135, glow: [0.72, 0.28], texture: 'dots' },
  blackhole:    { angle: 200, glow: [0.50, 0.62], texture: 'rays' },
  chess:        { angle: 90,  glow: [0.70, 0.35], texture: 'grid' },
  connect4:     { angle: 160, glow: [0.50, 0.30], texture: 'dots' },
  draughts:     { angle: 45,  glow: [0.62, 0.62], texture: 'grid' },
  gomoku:       { angle: 120, glow: [0.66, 0.34], texture: 'dots' },
  idiom:        { angle: 210, glow: [0.50, 0.35], texture: 'none' },
  linkup:       { angle: 315, glow: [0.68, 0.32], texture: 'dots' },
  match3:       { angle: 250, glow: [0.50, 0.55], texture: 'rays' },
  memory:       { angle: 30,  glow: [0.62, 0.36], texture: 'dots' },
  minesweeper:  { angle: 180, glow: [0.70, 0.60], texture: 'grid' },
  reversi:      { angle: 0,   glow: [0.60, 0.30], texture: 'grid' },
  snake:        { angle: 150, glow: [0.75, 0.60], texture: 'grid' },
  sokoban:      { angle: 60,  glow: [0.50, 0.40], texture: 'grid' },
  solitaire:    { angle: 240, glow: [0.72, 0.62], texture: 'none' },
  sudoku:       { angle: 300, glow: [0.60, 0.35], texture: 'grid' },
  tetris:       { angle: 100, glow: [0.50, 0.30], texture: 'grid' },
  tictactoe:    { angle: 220, glow: [0.55, 0.45], texture: 'dots' },
  whack:        { angle: 70,  glow: [0.50, 0.72], texture: 'dots' },
  xiangqi:      { angle: 15,  glow: [0.50, 0.60], texture: 'grid' }
};

function ctxOf(slug) {
  const entry = COVERS[slug];
  const p = entry.palette[0], s = entry.palette[1], a = entry.palette[2];
  return {
    slug: slug,
    alt: entry.alt,
    p: p, s: s, a: a,
    pd: darken(p, 0.45),        /* 深一档的主色：做描边 / 阴影 */
    pl: lighten(p, 0.42),       /* 浅一档：做内部高光 */
    pll: lighten(p, 0.72),      /* 很浅：做纸面 / 底纹 */
    soft: lighten(p, 0.55),
    bg0: mix('#05070e', p, 0.18),
    bg1: mix('#02030a', s, 0.06),
    ink: '#f8fafc',
    dark: '#070a12'
  };
}

/* ============================== 背景：渐变 + 底纹 + 星点 ============================== */

function defsOf(c, spec) {
  const rad = spec.angle * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const reach = 760;
  const x1 = CX - dx * reach, y1 = CY - dy * reach;
  const x2 = CX + dx * reach, y2 = CY + dy * reach;
  const parts = [];
  parts.push(tag('linearGradient', { id: 'bg', gradientUnits: 'userSpaceOnUse', x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2) },
    tag('stop', { offset: '0', 'stop-color': c.bg0 }) +
    tag('stop', { offset: '0.55', 'stop-color': mix(c.bg0, c.bg1, 0.55) }) +
    tag('stop', { offset: '1', 'stop-color': c.bg1 })));
  const g1x = spec.glow[0], g1y = spec.glow[1];
  parts.push(tag('radialGradient', { id: 'glow', gradientUnits: 'objectBoundingBox', cx: g1x, cy: g1y, r: 0.5 },
    tag('stop', { offset: '0', 'stop-color': c.p, 'stop-opacity': '0.42' }) +
    tag('stop', { offset: '0.55', 'stop-color': c.p, 'stop-opacity': '0.14' }) +
    tag('stop', { offset: '1', 'stop-color': c.p, 'stop-opacity': '0' })));
  parts.push(tag('radialGradient', { id: 'glow2', gradientUnits: 'objectBoundingBox', cx: 1 - g1x, cy: 1 - g1y, r: 0.5 },
    tag('stop', { offset: '0', 'stop-color': c.s, 'stop-opacity': '0.26' }) +
    tag('stop', { offset: '1', 'stop-color': c.s, 'stop-opacity': '0' })));
  if (spec.texture === 'dots') {
    parts.push(tag('pattern', { id: 'tex', patternUnits: 'userSpaceOnUse', width: 34, height: 34 },
      circle(17, 17, 1.7, '#ffffff', { 'fill-opacity': '0.07' })));
  } else if (spec.texture === 'grid') {
    parts.push(tag('pattern', { id: 'tex', patternUnits: 'userSpaceOnUse', width: 48, height: 48 },
      pathEl('M48 0H0V48', { fill: 'none', stroke: '#ffffff', 'stroke-opacity': '0.045', 'stroke-width': '1.2' })));
  }
  return '<defs>' + parts.join('') + '</defs>';
}

function textureOf(c, spec) {
  if (spec.texture === 'rays') {
    const cx = spec.glow[0] * W, cy = spec.glow[1] * H;
    const d = ['', ''];
    for (let i = 0; i < 22; i++) {
      const ang = Math.PI * 2 * i / 22 + 0.12;
      d[i % 2] += 'M' + Math.round(cx + Math.cos(ang) * 150) + ' ' + Math.round(cy + Math.sin(ang) * 150) +
        'L' + Math.round(cx + Math.cos(ang) * 980) + ' ' + Math.round(cy + Math.sin(ang) * 980);
    }
    return pathEl(d[1], { stroke: '#fff', 'stroke-opacity': '0.045', 'stroke-width': '2.4', 'stroke-linecap': 'round' }) +
      pathEl(d[0], { stroke: '#fff', 'stroke-opacity': '0.022', 'stroke-width': '1.2', 'stroke-linecap': 'round' });
  }
  if (spec.texture === 'none') return '';
  return rect(0, 0, W, H, 'url(#tex)');
}

/* 70 颗星点：不用 70 个 <circle>（一个约 76 字节），改成三条「零长线段 + 圆头」的 path，
   每颗星约 12 字节；粗细 / 透明度分三档保持疏密层次。坐标取整 → 又省一截。 */
function starsOf(slug) {
  const rnd = rngOf(seedOf('stars:' + slug));
  const bands = ['', '', ''];
  for (let i = 0; i < 70; i++) {
    const x = Math.round(rnd() * W), y = Math.round(rnd() * H);
    bands[i % 3] += 'M' + x + ' ' + y + 'h0.6';
  }
  const sw = ['1.5', '2.2', '3'], op = ['0.2', '0.3', '0.42'], out = [];
  for (let b = 0; b < 3; b++) {
    out.push(pathEl(bands[b], { stroke: '#fff', 'stroke-width': sw[b], 'stroke-linecap': 'round', 'stroke-opacity': op[b] }));
  }
  return out.join('');
}

/* ============================== 20 个母题 ============================== */
/* 每个母题都只用几何图元拼：没有文字、没有字体、没有外链。用色一律取自 c.p / c.s / c.a
   （主色 / 副色 / 点缀色），所以 20 张互不相同的观感来自「配色 + 构图」两件事。
   所有坐标都是写死的常数（不经随机数），保证同一次输入 → 字节完全一致。 */

const MOTIFS = {

  /* 合成数字块：用点阵数量暗示 2 / 4 / 8 / 16… 的层级 */
  '2048': function (c) {
    const cell = 116, gap = 10, unit = cell + gap;
    const ox = CX - unit * 2 + gap / 2, oy = CY - unit * 2 + gap / 2;
    const out = [];
    out.push(rrect(ox - 16, oy - 16, unit * 4 + 12, unit * 4 + 12, 28, mix(c.dark, c.p, 0.16), { stroke: c.p, 'stroke-opacity': '0.24', 'stroke-width': 2 }));
    const grid = [
      [0, 0, 0, 4],
      [0, 0, 8, 0],
      [0, 16, 0, 0],
      [64, 0, 16, 128]
    ];
    const fillOf = function (v) {
      if (v >= 128) return c.p;
      if (v >= 64) return lighten(c.p, 0.1);
      if (v >= 16) return mix(c.dark, c.p, 0.55);
      if (v >= 8) return mix(c.dark, c.p, 0.36);
      return mix(c.dark, c.p, 0.24);
    };
    const pipOf = function (v) { return v >= 64 ? 5 : v >= 16 ? 3 : v >= 8 ? 2 : 1; };
    for (let r = 0; r < 4; r++) {
      for (let q = 0; q < 4; q++) {
        const v = grid[r][q];
        const x = ox + q * unit, y = oy + r * unit;
        if (!v) {
          out.push(rrect(x, y, cell, cell, 16, 'none', { stroke: '#ffffff', 'stroke-opacity': '0.06', 'stroke-width': 2 }));
          continue;
        }
        if (v >= 128) out.push(glowAt(x + cell / 2, y + cell / 2, 130));
        out.push(rrect(x, y, cell, cell, 16, fillOf(v), { stroke: lighten(c.p, v >= 64 ? 0.3 : 0.12), 'stroke-opacity': v >= 64 ? '0.55' : '0.22', 'stroke-width': 2 }));
        out.push(rrect(x + 7, y + 7, cell - 14, cell - 14, 11, 'none', { stroke: '#ffffff', 'stroke-opacity': v >= 64 ? '0.22' : '0.1', 'stroke-width': 1.5 }));
        out.push(pips(x + cell / 2, y + cell / 2, pipOf(v), v >= 64 ? 6.4 : 5.6, v >= 64 ? '#ffffff' : c.pll, 0.95));
      }
    }
    out.push(arrow(ox + unit * 2 + cell / 2, oy + unit * 3 + cell / 2, ox + unit * 3 - 8, oy + unit * 3 + cell / 2, c.a, 6));
    const gw = [[ox + unit * 3 + cell / 2, oy + unit * 3 + cell / 2]];
    for (let i = 0; i < 4; i++) {
      const ang = Math.PI / 2 * i + 0.5;
      gw.push(sparkle(gw[0][0] + Math.cos(ang) * 96, gw[0][1] + Math.sin(ang) * 96, 16 - i, '#ffffff', 0.5));
    }
    out.push(gw.slice(1).join(''));
    out.push(pathEl('M560 74 L600 40 L640 74', { fill: 'none', stroke: c.a, 'stroke-width': 7, 'stroke-opacity': '0.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    out.push(pathEl('M560 96 L600 62 L640 96', { fill: 'none', stroke: c.a, 'stroke-width': 7, 'stroke-opacity': '0.22', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return out.join('');
  },

  /* 黑洞：事件视界 + 吸积盘 + 两极喷流 */
  blackhole: function (c) {
    const cx = CX, cy = CY, out = [];
    out.push(circle(cx, cy, 300, 'url(#glow)'));
    out.push(ellipse(cx, cy, 268, 96, 'none', { stroke: c.p, 'stroke-width': 2, 'stroke-opacity': '0.28', transform: rot(-16, cx, cy) }));
    out.push(ellipse(cx, cy, 232, 78, 'none', { stroke: c.s, 'stroke-width': 1.6, 'stroke-opacity': '0.22', transform: rot(-16, cx, cy) }));
    const rnd = rngOf(seedOf('blackhole:debris'));
    for (let i = 0; i < 9; i++) {
      const t = rnd() * Math.PI * 2;
      const rx = 268, ry = 96;
      const px = cx + Math.cos(t) * rx, py = cy + Math.sin(t) * ry;
      const rot2 = rot(-16, cx, cy);
      out.push(group([
        circle(px, py, 4 + rnd() * 5, c.pl, { 'fill-opacity': 0.75 }),
        ellipse(px, py, 26, 7, c.p, { 'fill-opacity': 0.3 })
      ], { transform: rot2 }));
    }
    out.push(poly([[cx - 15, cy - 118], [cx + 15, cy - 118], [cx + 3, cy - 330], [cx - 3, cy - 330]], { fill: c.s, 'fill-opacity': '0.24' }));
    out.push(poly([[cx - 15, cy + 118], [cx + 15, cy + 118], [cx + 3, cy + 330], [cx - 3, cy + 330]], { fill: c.s, 'fill-opacity': '0.24' }));
    const swirl = [];
    for (let i = 0; i < 5; i++) {
      const a0 = -0.5 + i * 0.9, r0 = 156 + i * 5;
      const x1 = cx + Math.cos(a0) * r0, y1 = cy + Math.sin(a0) * r0 * 0.44;
      const x2 = cx + Math.cos(a0 + 1.5) * (r0 + 26), y2 = cy + Math.sin(a0 + 1.5) * (r0 + 26) * 0.44;
      swirl.push(pathEl('M' + n(x1) + ' ' + n(y1) + ' Q' + n((x1 + x2) / 2) + ' ' + n((y1 + y2) / 2 - 26) + ' ' + n(x2) + ' ' + n(y2), { fill: 'none', stroke: i % 2 ? c.a : c.pl, 'stroke-width': 5, 'stroke-opacity': '0.45', 'stroke-linecap': 'round' }));
    }
    out.push(group(swirl, { transform: rot(-16, cx, cy) }));
    out.push(circle(cx, cy, 152, c.dark));
    out.push(ring(cx, cy, 152, c.pd, 40, { 'stroke-opacity': '0.9' }));
    out.push(ring(cx, cy, 132, c.s, 9, { 'stroke-opacity': '0.85' }));
    out.push(ring(cx, cy, 172, c.p, 3, { 'stroke-opacity': '0.5' }));
    out.push(circle(cx - 46, cy - 52, 12, '#ffffff', { 'fill-opacity': '0.5' }));
    return out.join('');
  },

  /* 国际象棋：棋盘 + 马 + 一步将杀 */
  chess: function (c) {
    const size = 520, cell = size / 8, bx = CX - size / 2, by = CY - size / 2 + 8;
    const out = [];
    out.push(rrect(bx - 10, by - 10, size + 20, size + 20, 14, mix(c.dark, c.p, 0.18), { stroke: c.pl, 'stroke-opacity': '0.3', 'stroke-width': 3 }));
    for (let r = 0; r < 8; r++) {
      for (let q = 0; q < 8; q++) {
        const light = (r + q) % 2 === 0;
        out.push(rect(bx + q * cell, by + r * cell, cell, cell, light ? mix(c.p, '#f8fafc', 0.8) : mix(c.pd, '#0b1220', 0.5), { 'fill-opacity': light ? '0.86' : '0.92' }));
      }
    }
    const fx = bx + 1.5 * cell, fy = by + 6.5 * cell, tx = bx + 4.5 * cell, ty = by + 3.5 * cell;
    out.push(pathEl('M' + n(fx) + ' ' + n(fy) + ' L' + n(tx) + ' ' + n(ty), { fill: 'none', stroke: c.a, 'stroke-width': 6, 'stroke-dasharray': '18 14', 'stroke-opacity': '0.8', 'stroke-linecap': 'round' }));
    out.push(ring(fx, fy, 22, c.a, 4, { 'stroke-opacity': '0.7' }));
    out.push(glowAt(tx, ty, 130));
    out.push(circle(tx, ty, 30, c.a, { 'fill-opacity': '0.16' }));
    out.push(arrow(tx - 46, ty + 46, tx - 8, ty + 8, c.a, 5));
    out.push(circle(bx + 0.5 * cell, by + 0.5 * cell, 15, c.s, { 'fill-opacity': '0.5' }));
    const kx = CX, ky = CY - 26;
    out.push(ellipse(kx, ky + 96, 92, 20, '#000000', { 'fill-opacity': '0.35' }));
    out.push(rrect(kx - 46, ky + 62, 92, 26, 9, c.ink, { 'fill-opacity': '0.94' }));
    out.push(rrect(kx - 34, ky + 44, 68, 22, 7, c.ink, { 'fill-opacity': '0.86' }));
    out.push(pathEl('M' + n(kx - 22) + ' ' + n(ky + 46) + ' L' + n(kx - 27) + ' ' + n(ky - 4) + ' C' + n(kx - 27) + ' ' + n(ky - 26) + ' ' + n(kx - 12) + ' ' + n(ky - 38) + ' ' + n(kx + 4) + ' ' + n(ky - 40) + ' L' + n(kx + 22) + ' ' + n(ky - 42) + ' L' + n(kx + 12) + ' ' + n(ky - 58) + ' L' + n(kx + 34) + ' ' + n(ky - 50) + ' C' + n(kx + 42) + ' ' + n(ky - 30) + ' ' + n(kx + 28) + ' ' + n(ky - 6) + ' ' + n(kx + 16) + ' ' + n(ky + 10) + ' L' + n(kx + 26) + ' ' + n(ky + 46) + ' Z', { fill: c.ink, 'fill-opacity': '0.95' }));
    out.push(circle(kx + 14, ky - 30, 4.4, c.dark));
    out.push(pathEl('M' + n(kx + 30) + ' ' + n(ky - 40) + ' L' + n(kx + 40) + ' ' + n(ky - 44), { stroke: c.ink, 'stroke-width': 4, 'stroke-linecap': 'round' }));
    out.push(sparkle(kx + 74, ky - 74, 20, c.a, 0.85));
    out.push(sparkle(kx - 82, ky + 20, 13, c.pl, 0.6));
    return out.join('');
  },

  /* 四子棋：竖板 + 四连斜线 + 落子中 */
  connect4: function (c) {
    const x0 = 300, x1 = 900, y0 = 70, y1 = 610, cols = 7, rows = 6;
    const dx = (x1 - x0) / cols, dy = (y1 - y0) / rows, r = 29;
    const cxOf = function (q) { return x0 + dx * (q + 0.5); };
    const cyOf = function (k) { return y0 + dy * (k + 0.5); };
    const out = [];
    out.push(rrect(x0 - 18, y0 - 18, (x1 - x0) + 36, (y1 - y0) + 36, 28, mix(c.dark, c.p, 0.18), { stroke: c.pl, 'stroke-opacity': '0.3', 'stroke-width': 2 }));
    for (let k = 0; k < rows; k++) for (let q = 0; q < cols; q++) out.push(circle(cxOf(q), cyOf(k), r, '#04060c', { 'fill-opacity': '0.85' }));
    const disc = function (q, k, fill, glow, win) {
      const x = cxOf(q), y = cyOf(k), o = [];
      if (glow) o.push(glowAt(x, y, 96));
      o.push(circle(x, y, r, fill));
      o.push(ring(x, y, r, lighten(fill, 0.45), 3, { 'stroke-opacity': '0.55' }));
      o.push(ring(x, y, r * 0.62, darken(fill, 0.35), 3, { 'stroke-opacity': '0.4' }));
      o.push(circle(x - 9, y - 10, 6, '#ffffff', { 'fill-opacity': '0.35' }));
      if (win) o.push(ring(x, y, r + 7, c.a, 4, { 'stroke-opacity': '0.9' }));
      return o.join('');
    };
    const winLine = [[1, 5], [2, 4], [3, 3], [4, 2]];
    for (let q = 0; q < cols; q++) if (q !== 1) out.push(disc(q, 5, c.p, false, false));
    out.push(disc(5, 4, c.p, false, false));
    out.push(disc(6, 4, c.p, false, false));
    for (let i = 0; i < winLine.length; i++) out.push(disc(winLine[i][0], winLine[i][1], c.s, true, true));
    out.push(circle(cxOf(4), 26, r, c.s, { 'fill-opacity': '0.85' }));
    out.push(line(cxOf(4), 30, cxOf(4), cyOf(2) - r - 10, { stroke: c.a, 'stroke-width': 4, 'stroke-dasharray': '12 12', 'stroke-opacity': '0.5' }));
    out.push(sparkle(cxOf(4) + 62, cyOf(2) - 46, 18, c.a, 0.8));
    return out.join('');
  },

  /* 国际跳棋：深浅格 + 王冠棋子 + 吃子 */
  draughts: function (c) {
    const size = 512, cell = size / 8, bx = CX - size / 2, by = CY - size / 2 + 8;
    const out = [];
    const darkF = mix(c.pd, '#1a1206', 0.45), lightF = mix(c.p, '#fef3c7', 0.78);
    const cxOf = function (q) { return bx + q * cell + cell / 2; };
    const cyOf = function (r) { return by + r * cell + cell / 2; };
    out.push(rrect(bx - 12, by - 12, size + 24, size + 24, 16, mix(c.dark, c.p, 0.16), { stroke: c.pl, 'stroke-opacity': '0.3', 'stroke-width': 3 }));
    for (let r = 0; r < 8; r++) {
      for (let q = 0; q < 8; q++) {
        const dark = (r + q) % 2 === 1;
        out.push(rect(bx + q * cell, by + r * cell, cell, cell, dark ? darkF : lightF, { 'fill-opacity': dark ? '0.95' : '0.8' }));
      }
    }
    const piece = function (q, r, light, king, glow) {
      const x = cxOf(q), y = cyOf(r), o = [];
      const body = light ? mix(c.p, '#f8e7c8', 0.82) : mix(c.pd, '#2a1a06', 0.4);
      const rim = light ? c.pd : lighten(c.p, 0.35);
      if (glow) o.push(glowAt(x, y, 92));
      o.push(ellipse(x, y + 24, 26, 8, '#000000', { 'fill-opacity': '0.35' }));
      o.push(circle(x, y, 25, body));
      o.push(ring(x, y, 25, rim, 4, { 'stroke-opacity': '0.85' }));
      o.push(ring(x, y, 16, rim, 2, { 'stroke-opacity': '0.45' }));
      if (king) {
        o.push(ring(x, y, 9.5, c.a, 4, { 'stroke-opacity': '0.95' }));
        o.push(circle(x, y, 3.4, c.a));
        o.push(sparkle(x + 44, y - 44, 16, c.a, 0.85));
        o.push(sparkle(x - 40, y - 30, 10, '#ffffff', 0.5));
      }
      return o.join('');
    };
    out.push(piece(0, 1, true, false, false));
    out.push(piece(2, 1, true, false, false));
    out.push(piece(1, 2, false, false, false));
    out.push(piece(3, 4, true, false, false));
    out.push(piece(6, 6, false, false, false));
    out.push(piece(4, 3, false, true, true));
    out.push(pathEl('M' + n(cxOf(3)) + ' ' + n(cyOf(4)) + ' L' + n(cxOf(1)) + ' ' + n(cyOf(2)), { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-dasharray': '16 13', 'stroke-opacity': '0.75', 'stroke-linecap': 'round' }));
    out.push(arrow(cxOf(2) + 6, cyOf(3) - 6, cxOf(1) + 14, cyOf(2) + 14, c.a, 5));
    out.push(ring(cxOf(5), cyOf(4), 24, c.a, 4, { 'stroke-opacity': '0.55', 'stroke-dasharray': '10 10' }));
    return out.join('');
  },

  /* 五子棋：棋盘 + 点阵 + 五连 */
  gomoku: function (c) {
    const span = 38, ox = CX - span * 7, oy = CY - span * 7;
    const out = [];
    const X = function (q) { return ox + q * span; };
    const Y = function (r) { return oy + r * span; };
    out.push(rrect(X(0) - 28, Y(0) - 28, span * 14 + 56, span * 14 + 56, 16, mix(c.dark, c.p, 0.14), { stroke: c.pl, 'stroke-opacity': '0.28', 'stroke-width': 2 }));
    for (let i = 0; i < 15; i++) {
      out.push(line(X(i), Y(0), X(i), Y(14), { stroke: c.pl, 'stroke-width': 1.5, 'stroke-opacity': '0.28' }));
      out.push(line(X(0), Y(i), X(14), Y(i), { stroke: c.pl, 'stroke-width': 1.5, 'stroke-opacity': '0.28' }));
    }
    const stars = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
    for (let i = 0; i < stars.length; i++) out.push(circle(X(stars[i][0]), Y(stars[i][1]), 4.4, c.pl, { 'fill-opacity': '0.5' }));
    const win = [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]];
    const white = [[3, 4], [4, 5], [5, 6], [6, 3], [7, 4], [2, 2]];
    out.push(pathEl('M' + n(X(3)) + ' ' + n(Y(3)) + ' L' + n(X(7)) + ' ' + n(Y(7)), { stroke: c.a, 'stroke-width': 7, 'stroke-opacity': '0.55', 'stroke-linecap': 'round' }));
    const stone = function (q, r, dark, glow) {
      const x = X(q), y = Y(r), o = [];
      const fill = dark ? '#0b1220' : '#f1f5f9';
      if (glow) o.push(glowAt(x, y, 74));
      o.push(ellipse(x + 1, y + 3, 15, 14, '#000000', { 'fill-opacity': '0.4' }));
      o.push(circle(x, y, 15.5, fill));
      o.push(ring(x, y, 15.5, dark ? '#4b5563' : '#cbd5e1', 1.6, { 'stroke-opacity': '0.9' }));
      o.push(circle(x - 5, y - 5.5, 4.6, '#ffffff', { 'fill-opacity': dark ? '0.35' : '0.85' }));
      if (glow) o.push(ring(x, y, 19, c.a, 3, { 'stroke-opacity': '0.85' }));
      return o.join('');
    };
    for (let i = 0; i < white.length; i++) out.push(stone(white[i][0], white[i][1], false, false));
    for (let i = 0; i < win.length; i++) out.push(stone(win[i][0], win[i][1], true, true));
    out.push(sparkle(X(7) + 40, Y(7) - 40, 17, c.a, 0.8));
    return out.join('');
  },

  /* 猜成语：以「格数」暗示字数，色块 = 命中 / 错位 / 未中 */
  idiom: function (c) {
    const tile = 74, gap = 12, unit = tile + gap, cols = 4, rows = 5;
    const ox = CX - (cols * unit - gap) / 2, oy = CY - (rows * unit - gap) / 2;
    const grid = [
      [1, 1, 0, 2],
      [0, 2, 1, 0],
      [2, 0, 0, 1],
      [0, 1, 2, 0],
      [3, 3, 3, 3]
    ];
    const out = [];
    out.push(glowAt(ox + (cols * unit - gap) / 2, oy + unit * 0.5, 240));
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const kind = grid[r][q];
        const x = ox + q * unit, y = oy + r * unit;
        const cx = x + tile / 2, cy = y + tile / 2;
        if (kind === 3) {
          out.push(rrect(x, y, tile, tile, 14, 'none', { stroke: c.a, 'stroke-width': 3, 'stroke-dasharray': '12 9', 'stroke-opacity': '0.6' }));
          if (q === 0) {
            out.push(rrect(x, y, tile, tile, 14, c.p, { 'fill-opacity': '0.42' }));
            out.push(rect(cx + 1, y + 16, 4, tile - 32, '#ffffff', { 'fill-opacity': '0.85' }));
          }
          continue;
        }
        if (kind === 2) {
          out.push(rrect(x, y, tile, tile, 14, mix(c.dark, c.s, 0.7), { stroke: lighten(c.s, 0.3), 'stroke-opacity': '0.5', 'stroke-width': 2 }));
          out.push(ring(cx, cy, 11, '#ffffff', 3.4, { 'stroke-opacity': '0.42' }));
          continue;
        }
        if (kind === 1) {
          out.push(rrect(x, y, tile, tile, 14, mix(c.dark, c.p, 0.76), { stroke: lighten(c.p, 0.35), 'stroke-opacity': '0.6', 'stroke-width': 2 }));
          out.push(rrect(x + 11, y + 11, tile - 22, tile - 22, 9, 'none', { stroke: '#ffffff', 'stroke-opacity': '0.35', 'stroke-width': 2 }));
          continue;
        }
        out.push(rrect(x, y, tile, tile, 14, mix(c.dark, c.p, 0.16), { stroke: '#ffffff', 'stroke-opacity': '0.09', 'stroke-width': 2 }));
        out.push(line(x + 20, cy, x + tile - 20, cy, { stroke: '#ffffff', 'stroke-width': 4, 'stroke-opacity': '0.16', 'stroke-linecap': 'round' }));
      }
    }
    out.push(sparkle(ox + cols * unit - gap + 34, oy + unit * 0.5, 20, c.a, 0.8));
    out.push(sparkle(ox - 34, oy + unit * 2.5, 14, c.p, 0.55));
    return out.join('');
  },

  /* 连连看：把同款图案用折线连起来 */
  linkup: function (c) {
    const tile = 88, gap = 12, unit = tile + gap, cols = 6, rows = 4;
    const ox = CX - (cols * unit - gap) / 2, oy = CY - (rows * unit - gap) / 2;
    const kinds = ['circle', 'diamond', 'triangle', 'square', 'hex', 'circle'];
    const grid = [
      [0, 1, 2, 3, 0, 2],
      [4, 5, 0, 1, 3, 5],
      [1, 3, 5, 0, 2, 4],
      [5, 0, 3, 2, 1, 0]
    ];
    const X = function (q) { return ox + q * unit + tile / 2; };
    const Y = function (r) { return oy + r * unit + tile / 2; };
    const out = [];
    out.push(pathEl('M' + n(X(0)) + ' ' + n(Y(1)) + ' L' + n(X(4)) + ' ' + n(Y(1)) + ' L' + n(X(4)) + ' ' + n(Y(3)) + ' L' + n(X(5)) + ' ' + n(Y(3)), { fill: 'none', stroke: c.a, 'stroke-width': 8, 'stroke-opacity': '0.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    out.push(circle(X(4), Y(1), 9, c.a));
    out.push(circle(X(4), Y(3), 9, c.a));
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const x = ox + q * unit, y = oy + r * unit;
        const isEnd = (r === 1 && q === 0) || (r === 3 && q === 5);
        const empty = (r === 2 && q === 0) || (r === 0 && q === 5);
        if (empty) {
          out.push(rrect(x, y, tile, tile, 18, 'none', { stroke: c.pl, 'stroke-opacity': '0.22', 'stroke-width': 2.6, 'stroke-dasharray': '13 10' }));
          continue;
        }
        if (isEnd) out.push(glowAt(x + tile / 2, y + tile / 2, 118));
        out.push(rrect(x, y, tile, tile, 18, isEnd ? mix(c.dark, c.a, 0.4) : mix(c.dark, c.p, 0.22), { stroke: isEnd ? lighten(c.a, 0.25) : '#ffffff', 'stroke-opacity': isEnd ? '0.75' : '0.1', 'stroke-width': 2.4 }));
        out.push(symbol(kinds[grid[r][q]], x + tile / 2, y + tile / 2, 24, isEnd ? '#ffffff' : (grid[r][q] % 2 ? c.pl : c.soft), isEnd ? 0.95 : 0.55));
      }
    }
    out.push(sparkle(X(0) - 46, Y(1) - 40, 16, c.a, 0.8));
    return out.join('');
  },

  /* 三消：宝石菱面 + 一条将消的三连 */
  match3: function (c) {
    const cols = 6, rows = 4, stepX = 96, stepY = 112;
    const ox = CX - (cols - 1) * stepX / 2, oy = CY - (rows - 1) * stepY / 2 - 6;
    const out = [];
    const colorOf = function (q, r) {
      const k = (q * 2 + r * 3) % 3;
      return k === 0 ? c.p : k === 1 ? c.s : c.a;
    };
    const gem = function (x, y, color, big, glow) {
      const o = [], hw = big ? 42 : 38, hh = big ? 50 : 46;
      if (glow) o.push(glowAt(x, y, 116));
      o.push(poly([[x, y - hh], [x + hw, y], [x, y + hh], [x - hw, y]], { fill: color, 'fill-opacity': '0.92' }));
      o.push(poly([[x, y - hh], [x + hw, y], [x - hw, y]], { fill: lighten(color, 0.45), 'fill-opacity': '0.3' }));
      o.push(poly([[x, y - hh + 14], [x + 13, y - 6], [x, y + 6], [x - 13, y - 6]], { fill: '#fff', 'fill-opacity': '0.35' }));
      return o.join('');
    };
    out.push(rrect(ox + stepX - 52, oy + 2 * stepY - 58, stepX * 2 + 104, 116, 30, c.a, { 'fill-opacity': '0.13' }));
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const x = ox + q * stepX, y = oy + r * stepY;
        const inRow = r === 2 && q >= 1 && q <= 3;
        out.push(gem(x, y, colorOf(q, r), inRow, inRow));
        if (inRow) out.push(ring(x, y, 54, '#ffffff', 3, { 'stroke-opacity': '0.55' }));
      }
    }
    out.push(pathEl('M' + n(ox + 40) + ' ' + n(oy - 62) + ' Q' + n(ox + 96) + ' ' + n(oy - 126) + ' ' + n(ox + 152) + ' ' + n(oy - 62), { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-opacity': '0.7', 'stroke-linecap': 'round' }));
    out.push(poly([[ox + 152, oy - 46], [ox + 164, oy - 72], [ox + 140, oy - 68]], { fill: c.a, 'fill-opacity': '0.85' }));
    out.push(sparkle(ox + stepX * 4 - 30, oy + 2 * stepY - 74, 18, '#ffffff', 0.7));
    out.push(sparkle(ox + stepX - 60, oy + 2 * stepY + 66, 13, c.a, 0.7));
    return out.join('');
  },

  /* 记忆翻牌：同款两张翻开配对 */
  memory: function (c) {
    const cw = 150, ch = 190, stepX = 180, stepY = 230, cols = 3, rows = 2;
    const ox = CX - (cols * stepX - (stepX - cw)) / 2, oy = CY - (rows * stepY - (stepY - ch)) / 2;
    const out = [];
    const back = function (x, y, rotDeg) {
      const o = [];
      o.push(rrect(x, y, cw, ch, 16, mix(c.dark, c.p, 0.32), { stroke: lighten(c.p, 0.25), 'stroke-opacity': '0.45', 'stroke-width': 2.4 }));
      o.push(rrect(x + 12, y + 12, cw - 24, ch - 24, 10, 'none', { stroke: c.a, 'stroke-opacity': '0.28', 'stroke-width': 2 }));
      o.push(line(x + 20, y + 24, x + cw - 20, y + ch - 24, { stroke: c.pl, 'stroke-width': 1.6, 'stroke-opacity': '0.3' }));
      o.push(line(x + cw - 20, y + 24, x + 20, y + ch - 24, { stroke: c.pl, 'stroke-width': 1.6, 'stroke-opacity': '0.3' }));
      o.push(symbol('diamond', x + cw / 2, y + ch / 2, 26, c.pl, 0.5));
      return group(o, { transform: rot(rotDeg, x + cw / 2, y + ch / 2) });
    };
    const face = function (x, y, rotDeg) {
      const o = [];
      o.push(rrect(x, y, cw, ch, 16, '#f8fafc', { 'fill-opacity': '0.96', stroke: c.pd, 'stroke-opacity': '0.3', 'stroke-width': 2.4 }));
      o.push(symbol('circle', x + cw / 2, y + ch / 2, 30, c.p, 0.9));
      const corners = [[x + 22, y + 24], [x + cw - 22, y + 24], [x + 22, y + ch - 24], [x + cw - 22, y + ch - 24]];
      for (let i = 0; i < 4; i++) o.push(symbol('diamond', corners[i][0], corners[i][1], 11, c.s, 0.85));
      return group(o, { transform: rot(rotDeg, x + cw / 2, y + ch / 2) });
    };
    const ax = ox + cw / 2, ay = oy + ch / 2;
    const bx2 = ox + 2 * stepX + cw / 2, by2 = oy + ch / 2;
    out.push(glowAt(ax, ay, 190));
    out.push(glowAt(bx2, by2, 190));
    out.push(back(ox, oy + stepY, 2));
    out.push(back(ox + stepX, oy + stepY, -4));
    out.push(back(ox + 2 * stepX, oy + stepY, 0));
    out.push(pathEl('M' + n(ax + 80) + ' ' + n(ay - 60) + ' Q' + n(CX) + ' ' + n(ay - 150) + ' ' + n(bx2 - 80) + ' ' + n(by2 - 60), { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-dasharray': '16 13', 'stroke-opacity': '0.75', 'stroke-linecap': 'round' }));
    out.push(face(ox, oy, -7));
    out.push(face(ox + 2 * stepX, oy, 7));
    out.push(back(ox + stepX, oy, 4));
    out.push(sparkle(CX, ay - 150, 22, c.a, 0.85));
    return out.join('');
  },

  /* 扫雷：暗格 + 数字提示 + 两颗雷 */
  minesweeper: function (c) {
    const size = 88, gap = 6, unit = size + gap, cols = 6, rows = 5;
    const ox = CX - (cols * unit - gap) / 2, oy = CY - (rows * unit - gap) / 2;
    const grid = [
      ['up', 'p1', 'up', 'up', 'p2', 'up'],
      ['up', 'up', 'flag', 'up', 'up', 'up'],
      ['mine', 'up', 'up', 'p3', 'up', 'up'],
      ['up', 'up', 'up', 'up', 'flag', 'up'],
      ['up', 'p2', 'up', 'mine', 'up', 'up']
    ];
    const out = [];
    /* 三类格子各攒成一个 <g>（公共样式只写一次），凸起描边攒成一条 path —— 逐个写全套属性会撑到 20 KB */
    const flatCells = [], upCells = [], decors = [], bevelL = [], bevelD = [];
    const flat = function (x, y) {
      flatCells.push(bareRect(x, y, size, size, 10));
    };
    const mine = function (x, y) {
      const cx = x + size / 2, cy = y + size / 2, o = [];
      o.push(glowAt(cx, cy, 92));
      let spokes = '';
      for (let i = 0; i < 8; i++) {
        const ang = Math.PI / 4 * i;
        spokes += 'M' + n(cx + Math.cos(ang) * 12) + ' ' + n(cy + Math.sin(ang) * 12) + 'L' + n(cx + Math.cos(ang) * 32) + ' ' + n(cy + Math.sin(ang) * 32);
      }
      o.push(pathEl(spokes, { stroke: '#0b0f18', 'stroke-width': 7, 'stroke-linecap': 'round' }));
      o.push(circle(cx, cy, 24, '#0b0f18'));
      o.push(ring(cx, cy, 24, darken(c.p, 0.2), 2, { 'stroke-opacity': '0.6' }));
      o.push(circle(cx - 7, cy - 7, 5.4, '#ffffff', { 'fill-opacity': '0.42' }));
      o.push(circle(cx + 7, cy + 5, 9, c.a, { 'fill-opacity': '0.18' }));
      return o.join('');
    };
    const flag = function (x, y) {
      const cx = x + size / 2, cy = y + size / 2, o = [];
      o.push(line(cx - 12, cy + 24, cx - 12, cy - 24, { stroke: c.a, 'stroke-width': 5, 'stroke-linecap': 'round' }));
      o.push(poly([[cx - 10, cy - 24], [cx + 22, cy - 12], [cx - 10, cy + 2]], { fill: c.a, 'fill-opacity': '0.95' }));
      o.push(rrect(cx - 26, cy + 22, 28, 8, 4, c.a, { 'fill-opacity': '0.9' }));
      o.push(glowAt(cx, cy, 76));
      return o.join('');
    };
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const kind = grid[r][q], x = ox + q * unit, y = oy + r * unit;
        if (kind === 'up') {
          upCells.push(bareRect(x, y, size, size, 10));
          bevelL.push('M' + n(x + 5) + ' ' + n(y + size - 7) + 'L' + n(x + 5) + ' ' + n(y + 5) + 'L' + n(x + size - 7) + ' ' + n(y + 5));
          bevelD.push('M' + n(x + size - 5) + ' ' + n(y + 8) + 'L' + n(x + size - 5) + ' ' + n(y + size - 5) + 'L' + n(x + 8) + ' ' + n(y + size - 5));
          continue;
        }
        flat(x, y);
        if (kind === 'mine') decors.push(mine(x, y));
        else if (kind === 'flag') decors.push(flag(x, y));
        else decors.push(pips(x + size / 2, y + size / 2, Number(kind.slice(1)), 6, c.p, 0.95));
      }
    }
    out.push(group(upCells, { fill: mix(c.dark, c.p, 0.3), stroke: lighten(c.p, 0.2), 'stroke-opacity': '0.28', 'stroke-width': 2 }));
    out.push(group(flatCells, { fill: mix(c.dark, c.p, 0.1), stroke: darken(c.p, 0.6), 'stroke-opacity': '0.35', 'stroke-width': 1.6 }));
    out.push(pathEl(bevelL.join(''), { fill: 'none', stroke: lighten(c.p, 0.55), 'stroke-width': 3.4, 'stroke-opacity': '0.4', 'stroke-linecap': 'round' }));
    out.push(pathEl(bevelD.join(''), { fill: 'none', stroke: '#000', 'stroke-width': 3.4, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(decors.join(''));
    out.push(sparkle(ox - 34, oy + 40, 15, c.a, 0.7));
    return out.join('');
  },

  /* 黑白棋：翻面那一刻 */
  reversi: function (c) {
    const size = 496, cell = size / 8, bx = CX - size / 2, by = CY - size / 2 + 8;
    const out = [];
    const cxOf = function (q) { return bx + q * cell + cell / 2; };
    const cyOf = function (r) { return by + r * cell + cell / 2; };
    out.push(rrect(bx - 14, by - 14, size + 28, size + 28, 18, mix(c.dark, c.p, 0.2), { stroke: c.pl, 'stroke-opacity': '0.3', 'stroke-width': 3 }));
    for (let r = 0; r < 8; r++) {
      for (let q = 0; q < 8; q++) {
        out.push(rect(bx + q * cell, by + r * cell, cell, cell, (r + q) % 2 ? mix(c.pd, '#04140f', 0.4) : mix(c.p, '#e6fffa', 0.55), { 'fill-opacity': (r + q) % 2 ? '0.9' : '0.5' }));
      }
    }
    const disc = function (q, r, dark, glow) {
      const x = cxOf(q), y = cyOf(r), o = [];
      if (glow) o.push(glowAt(x, y, 88));
      o.push(circle(x, y, 24, dark ? '#0b1220' : '#f8fafc'));
      o.push(ring(x, y, 24, dark ? '#475569' : '#cbd5e1', 2, { 'stroke-opacity': '0.9' }));
      o.push(circle(x - 8, y - 8, 6.5, '#ffffff', { 'fill-opacity': dark ? '0.28' : '0.85' }));
      return o.join('');
    };
    const flipping = function (q, r, deg) {
      const x = cxOf(q), y = cyOf(r), o = [];
      o.push(glowAt(x, y, 110));
      o.push(circle(x, y, 24, '#f8fafc'));
      o.push(pathEl('M' + n(x) + ' ' + n(y - 24) + ' A 24 24 0 0 1 ' + n(x) + ' ' + n(y + 24) + ' Z', { fill: '#0b1220' }));
      o.push(ring(x, y, 24, c.a, 3, { 'stroke-opacity': '0.75' }));
      o.push(pathEl('M' + n(x - 40) + ' ' + n(y - 30) + ' A 50 50 0 0 1 ' + n(x + 40) + ' ' + n(y - 30), { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-opacity': '0.8', 'stroke-linecap': 'round' }));
      o.push(poly([[x + 44, y - 22], [x + 24, y - 34], [x + 40, y - 46]], { fill: c.a, 'fill-opacity': '0.9' }));
      return group(o, { transform: rot(deg, x, y) });
    };
    const darkCells = [[2, 2], [3, 3], [4, 4], [5, 5]];
    const lightCells = [[2, 3], [3, 4], [4, 5], [5, 2]];
    for (let i = 0; i < lightCells.length; i++) out.push(disc(lightCells[i][0], lightCells[i][1], false, false));
    for (let i = 0; i < darkCells.length; i++) out.push(disc(darkCells[i][0], darkCells[i][1], true, false));
    out.push(flipping(3, 2, 24));
    out.push(flipping(5, 4, -38));
    out.push(sparkle(cxOf(3) + 54, cyOf(2) - 54, 18, c.a, 0.85));
    out.push(sparkle(cxOf(5) - 50, cyOf(4) + 52, 13, '#ffffff', 0.5));
    return out.join('');
  },

  /* 贪吃蛇：折线身体 + 蛇头 + 果实 */
  snake: function (c) {
    const pts = [[300, 470], [300, 250], [520, 250], [520, 430], [740, 430], [740, 210], [900, 210]];
    const d = 'M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L');
    const out = [];
    out.push(pathEl(d, { fill: 'none', stroke: darken(c.p, 0.62), 'stroke-width': 58, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    out.push(pathEl(d, { fill: 'none', stroke: c.p, 'stroke-width': 44, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    out.push(pathEl(d, { fill: 'none', stroke: lighten(c.p, 0.42), 'stroke-width': 15, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': '0.4' }));
    const segs = [0.18, 0.42, 0.66, 0.88];
    for (let i = 0; i < segs.length; i++) {
      const t = segs[i] * (pts.length - 1);
      const k = Math.min(pts.length - 2, Math.floor(t)), f = t - k;
      const x = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f;
      const y = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f;
      out.push(circle(x, y, 9, darken(c.p, 0.35), { 'fill-opacity': '0.5' }));
    }
    out.push(poly([[300, 470], [264, 508], [312, 512]], { fill: darken(c.p, 0.2) }));
    out.push(glowAt(900, 210, 120));
    out.push(circle(900, 210, 30, lighten(c.p, 0.12)));
    out.push(ring(900, 210, 30, darken(c.p, 0.5), 3.4, { 'stroke-opacity': '0.8' }));
    out.push(circle(888, 198, 10.5, '#ffffff'));
    out.push(circle(913, 198, 10.5, '#ffffff'));
    out.push(circle(890, 199, 5.2, '#0b1220'));
    out.push(circle(915, 199, 5.2, '#0b1220'));
    out.push(pathEl('M930 216 L954 214 M930 224 L952 228', { fill: 'none', stroke: c.a, 'stroke-width': 4, 'stroke-linecap': 'round' }));
    out.push(ring(1012, 210, 34, c.s, 3, { 'stroke-opacity': '0.35', 'stroke-dasharray': '10 9' }));
    out.push(circle(1012, 210, 19, c.s));
    out.push(ring(1012, 210, 19, darken(c.s, 0.4), 2.4, { 'stroke-opacity': '0.6' }));
    out.push(circle(1006, 204, 5, '#ffffff', { 'fill-opacity': '0.6' }));
    out.push(pathEl('M1014 191 q 10 -14 22 -8 q -6 12 -22 8 Z', { fill: c.a, 'fill-opacity': '0.9' }));
    out.push(line(1012, 191, 1010, 182, { stroke: c.a, 'stroke-width': 3.4, 'stroke-linecap': 'round' }));
    return out.join('');
  },

  /* 推箱子：箱子 / 目标点 / 推的方向 */
  sokoban: function (c) {
    const size = 92;
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push(rrect(214 + i * size, 56, size - 6, size - 6, 10, mix(c.pd, '#2a1608', 0.5), { stroke: lighten(c.p, 0.2), 'stroke-opacity': '0.28', 'stroke-width': 2 }));
      out.push(rrect(214 + i * size, 520, size - 6, size - 6, 10, mix(c.pd, '#2a1608', 0.5), { stroke: lighten(c.p, 0.2), 'stroke-opacity': '0.28', 'stroke-width': 2 }));
      out.push(rect(214 + i * size, 56, size - 6, 8, lighten(c.p, 0.45), { 'fill-opacity': '0.3' }));
      out.push(rect(214 + i * size, 520, size - 6, 8, lighten(c.p, 0.45), { 'fill-opacity': '0.3' }));
    }
    const crate = function (x, y, onTarget) {
      const o = [];
      if (onTarget) o.push(glowAt(x + size / 2, y + size / 2, 130));
      o.push(rrect(x, y, size - 4, size - 4, 12, mix(c.pd, '#f59e0b', 0.5), { stroke: darken(c.p, 0.55), 'stroke-width': 5 }));
      o.push(rrect(x + 10, y + 10, size - 24, size - 24, 8, 'none', { stroke: lighten(c.p, 0.4), 'stroke-opacity': '0.3', 'stroke-width': 2 }));
      o.push(line(x + 12, y + 12, x + size - 16, y + size - 16, { stroke: darken(c.p, 0.5), 'stroke-width': 9, 'stroke-opacity': '0.75' }));
      o.push(line(x + size - 16, y + 12, x + 12, y + size - 16, { stroke: darken(c.p, 0.5), 'stroke-width': 9, 'stroke-opacity': '0.75' }));
      const bolts = [[x + 14, y + 14], [x + size - 18, y + 14], [x + 14, y + size - 18], [x + size - 18, y + size - 18]];
      for (let i = 0; i < 4; i++) o.push(circle(bolts[i][0], bolts[i][1], 4.6, lighten(c.p, 0.6), { 'fill-opacity': '0.8' }));
      if (onTarget) o.push(poly([[x + 26, y + size / 2], [x + 40, y + size / 2 + 16], [x + 68, y + size / 2 - 20]], { fill: 'none', stroke: '#ffffff', 'stroke-width': 7, 'stroke-opacity': '0.85', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      return o.join('');
    };
    const target = function (x, y) {
      return group([
        ring(x + size / 2, y + size / 2, 34, c.a, 5, { 'stroke-opacity': '0.85', 'stroke-dasharray': '14 10' }),
        circle(x + size / 2, y + size / 2, 9, c.a, { 'fill-opacity': '0.55' })
      ]);
    };
    out.push(target(522, 296));
    out.push(target(714, 200));
    out.push(crate(522, 200 - 92, true));
    out.push(crate(330, 296, false));
    out.push(crate(714, 200, true));
    out.push(poly([[404, 322], [440, 342], [404, 362]], { fill: 'none', stroke: c.a, 'stroke-width': 7, 'stroke-opacity': '0.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    out.push(poly([[560, 322], [596, 342], [560, 362]], { fill: 'none', stroke: c.a, 'stroke-width': 7, 'stroke-opacity': '0.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    out.push(glowAt(280, 320, 110));
    out.push(circle(280, 268, 20, c.pl, { 'fill-opacity': '0.95' }));
    out.push(circle(272, 264, 3.6, c.dark));
    out.push(circle(288, 264, 3.6, c.dark));
    out.push(rrect(256, 288, 48, 54, 14, c.pl, { 'fill-opacity': '0.8' }));
    out.push(rrect(262, 342, 16, 14, 6, darken(c.p, 0.3), { 'fill-opacity': '0.9' }));
    out.push(rrect(282, 342, 16, 14, 6, darken(c.p, 0.3), { 'fill-opacity': '0.9' }));
    return out.join('');
  },

  /* 纸牌接龙：扇形手牌 + 牌堆 + 飞牌 */
  solitaire: function (c) {
    const cw = 160, ch = 228, R = 150, px = 380, py = 500;
    const out = [];
    const cardShadow = function (x, y, w, h, r) { return rrect(x + 5, y + 7, w, h, r, '#000000', { 'fill-opacity': '0.35' }); };
    const backArt = function (x, y, w, h, rx) {
      const o = [];
      o.push(cardShadow(x, y, w, h, rx));
      o.push(rrect(x, y, w, h, rx, mix(c.p, '#06251c', 0.55), { stroke: lighten(c.p, 0.3), 'stroke-opacity': '0.5', 'stroke-width': 2.4 }));
      o.push(rrect(x + 10, y + 10, w - 20, h - 20, rx - 6, 'none', { stroke: c.a, 'stroke-opacity': '0.3', 'stroke-width': 2 }));
      o.push(line(x + 18, y + 20, x + w - 18, y + h - 20, { stroke: c.pl, 'stroke-width': 1.4, 'stroke-opacity': '0.35' }));
      o.push(line(x + w - 18, y + 20, x + 18, y + h - 20, { stroke: c.pl, 'stroke-width': 1.4, 'stroke-opacity': '0.35' }));
      o.push(symbol('diamond', x + w / 2, y + h / 2, 24, c.pl, 0.45));
      return o.join('');
    };
    const facePips = function (x, y, w, h, rx, k, glow) {
      const o = [];
      o.push(cardShadow(x, y, w, h, rx));
      o.push(rrect(x, y, w, h, rx, '#f8fafc', { 'fill-opacity': '0.97', stroke: c.pd, 'stroke-opacity': '0.3', 'stroke-width': 2.2 }));
      o.push(symbol('diamond', x + 24, y + 26, 10, c.p, 0.9));
      o.push(symbol('diamond', x + w - 24, y + h - 26, 10, c.p, 0.9));
      o.push(pips(x + w / 2, y + h / 2, k, 11, c.s, 0.9));
      if (glow) o.push(sparkle(x + w - 6, y + 8, 18, c.a, 0.85));
      return o.join('');
    };
    out.push(backArt(880, 96, cw, ch, 16));
    out.push(group([backArt(900, 118, cw, ch, 16)], { transform: rot(6, 980, 230) }));
    out.push(rrect(880, 430, cw, ch, 16, 'none', { stroke: c.a, 'stroke-width': 4, 'stroke-dasharray': '16 12', 'stroke-opacity': '0.7' }));
    out.push(symbol('diamond', 960, 544, 34, c.a, 0.5));
    const rots = [-18, -9, 0, 9, 18];
    const cards = [];
    for (let i = 0; i < rots.length; i++) {
      const a = rots[i] * Math.PI / 180;
      const x = px + Math.sin(a) * R - cw / 2;
      const y = py - (1 - Math.cos(a)) * R - ch / 2;
      if (i === 0) cards.push(group([backArt(x, y, cw, ch, 16)], { transform: rot(rots[i] + 180, x + cw / 2, y + ch / 2) }));
      else cards.push(group([facePips(x, y, cw, ch, 16, [0, 3, 1, 5][i] || 1, i === 4)], { transform: rot(rots[i], x + cw / 2, y + ch / 2) }));
    }
    out.push(cards.join(''));
    out.push(glowAt(px + 150, py - 210, 180));
    const fx = 700, fy = 300;
    out.push(pathEl('M' + n(900) + ' ' + n(210) + ' Q' + n(780) + ' ' + n(140) + ' ' + n(fx + 40) + ' ' + n(fy - 40), { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-dasharray': '16 13', 'stroke-opacity': '0.7', 'stroke-linecap': 'round' }));
    out.push(group([facePips(fx - cw / 2, fy - ch / 2, cw, ch, 16, 1, false)], { transform: rot(-14, fx, fy) }));
    out.push(arrow(fx + 70, fy - 90, fx + 118, fy - 132, c.a, 5));
    return out.join('');
  },

  /* 数独：宫格 + 点阵提示 + 焦点格 */
  sudoku: function (c) {
    const cell = 56, size = cell * 9, ox = CX - size / 2, oy = CY - size / 2;
    const out = [];
    out.push(rrect(ox - 18, oy - 18, size + 36, size + 36, 16, mix(c.dark, c.p, 0.14), { stroke: c.pl, 'stroke-opacity': '0.28', 'stroke-width': 2 }));
    out.push(rect(ox, oy + 4 * cell, size, cell, c.a, { 'fill-opacity': '0.12' }));
    for (let i = 0; i <= 9; i++) {
      const thick = i % 3 === 0;
      const sw = thick ? 4 : 1.4;
      const op = thick ? '0.5' : '0.2';
      out.push(line(ox + i * cell, oy, ox + i * cell, oy + size, { stroke: c.pl, 'stroke-width': sw, 'stroke-opacity': op }));
      out.push(line(ox, oy + i * cell, ox + size, oy + i * cell, { stroke: c.pl, 'stroke-width': sw, 'stroke-opacity': op }));
    }
    const given = [
      [0, 1, 3], [0, 4, 1], [0, 7, 2],
      [1, 2, 2], [1, 5, 3],
      [2, 0, 1], [2, 6, 2], [2, 8, 3],
      [3, 3, 2], [3, 7, 1],
      [4, 0, 3], [4, 1, 1], [4, 2, 2], [4, 6, 3], [4, 7, 2], [4, 8, 1],
      [5, 2, 1], [5, 5, 2],
      [6, 1, 2], [6, 4, 3],
      [7, 3, 2], [7, 7, 1],
      [8, 0, 2], [8, 4, 3], [8, 6, 1]
    ];
    for (let i = 0; i < given.length; i++) {
      const r = given[i][0], q = given[i][1], k = given[i][2];
      const x = ox + q * cell + cell / 2, y = oy + r * cell + cell / 2;
      out.push(pips(x, y, k, 5, c.pll, 0.85));
    }
    const hx = ox + 7 * cell, hy = oy + 4 * cell;
    out.push(glowAt(hx + cell / 2, hy + cell / 2, 120));
    out.push(rect(hx, hy, cell, cell, c.a, { 'fill-opacity': '0.22' }));
    out.push(rrect(hx + 2, hy + 2, cell - 4, cell - 4, 8, 'none', { stroke: c.a, 'stroke-width': 4, 'stroke-opacity': '0.95' }));
    out.push(pips(hx + cell / 2, hy + cell / 2, 2, 6.4, '#ffffff', 0.98));
    out.push(pips(ox + 7 * cell + cell / 2, oy + 4 * cell + cell / 2, 2, 5, c.p, 0.5));
    out.push(sparkle(ox + size + 34, oy + 60, 15, c.a, 0.75));
    out.push(sparkle(ox - 32, oy + size - 50, 12, c.p, 0.6));
    return out.join('');
  },

  /* 俄罗斯方块：井 + 堆叠 + 下落中 + 待消行 */
  tetris: function (c) {
    const bw = 60, cols = 6, rows = 9;
    const x0 = CX - bw * cols / 2, y0 = 70;
    const out = [];
    const stack = [
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 1, 1, 1, 0],
      [2, 2, 0, 3, 3, 0],
      [3, 1, 2, 3, 1, 2]
    ];
    const pal = function (k) { return k === 1 ? c.p : k === 2 ? c.s : c.a; };
    const block = function (x, y, color, op) {
      const o = [];
      o.push(rrect(x + 2, y + 2, bw - 4, bw - 4, 9, color, { 'fill-opacity': op === undefined ? '0.95' : op }));
      o.push(rect(x + 6, y + 6, bw - 12, 9, lighten(color, 0.4), { 'fill-opacity': '0.5' }));
      return o.join('');
    };
    out.push(rrect(x0 - 12, y0 - 12, bw * cols + 24, bw * rows + 24, 16, mix(c.dark, c.p, 0.12), { stroke: c.pl, 'stroke-opacity': '0.28', 'stroke-width': 2 }));
    /* 井格原来是 54 个 <rect>（约 5 KB），改成一条网格 path（约 340 字节） */
    let gd = '';
    for (let q = 1; q < cols; q++) gd += 'M' + (x0 + q * bw) + ' ' + y0 + 'V' + (y0 + rows * bw);
    for (let r = 1; r < rows; r++) gd += 'M' + x0 + ' ' + (y0 + r * bw) + 'H' + (x0 + cols * bw);
    out.push(pathEl(gd, { stroke: '#fff', 'stroke-opacity': '0.06', 'stroke-width': '1.4' }));
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const k = stack[r][q];
        if (!k) continue;
        out.push(block(x0 + q * bw, y0 + r * bw, pal(k)));
      }
    }
    const ghost = [[4, 3], [5, 2], [5, 3], [5, 4]];
    const ghostCells = [];
    for (let i = 0; i < ghost.length; i++) ghostCells.push(bareRect(x0 + ghost[i][1] * bw + 4, y0 + ghost[i][0] * bw + 4, bw - 8, bw - 8, 8));
    out.push(group(ghostCells, { fill: 'none', stroke: c.a, 'stroke-width': 3, 'stroke-dasharray': '10 8', 'stroke-opacity': '0.55' }));
    const falling = [[0, 2], [0, 3], [0, 4], [1, 3]];
    out.push(glowAt(x0 + 3 * bw, y0 + 1.5 * bw, 150));
    for (let i = 0; i < falling.length; i++) {
      out.push(block(x0 + falling[i][1] * bw, y0 + falling[i][0] * bw - 34, c.a, '0.95'));
    }
    out.push(line(x0 + 3 * bw + 30, y0 - 8, x0 + 3 * bw + 30, y0 + 108, { stroke: c.a, 'stroke-width': 4, 'stroke-dasharray': '10 12', 'stroke-opacity': '0.45' }));
    out.push(line(x0 + 3 * bw + 6, y0 - 6, x0 + 3 * bw + 6, y0 + 12, { stroke: '#ffffff', 'stroke-width': 4, 'stroke-opacity': '0.22', 'stroke-linecap': 'round' }));
    out.push(line(x0 + 3 * bw + 54, y0 - 6, x0 + 3 * bw + 54, y0 + 12, { stroke: '#ffffff', 'stroke-width': 4, 'stroke-opacity': '0.22', 'stroke-linecap': 'round' }));
    out.push(rect(x0 + 2, y0 + 8 * bw + 2, bw * cols - 4, bw - 4, '#ffffff', { 'fill-opacity': '0.32' }));
    out.push(sparkle(x0 + bw * 1.2, y0 + bw * 8.5, 22, '#ffffff', 0.85));
    out.push(sparkle(x0 + bw * 4.8, y0 + bw * 8.5, 16, '#ffffff', 0.7));
    out.push(sparkle(x0 + bw * 3, y0 + bw * 8.5, 12, c.a, 0.8));
    return out.join('');
  },

  /* 井字棋：一局三连 */
  tictactoe: function (c) {
    const cell = 160, ox = CX - cell * 1.5, oy = CY - cell * 1.5;
    const out = [];
    const X = function (q) { return ox + q * cell + cell / 2; };
    const Y = function (r) { return oy + r * cell + cell / 2; };
    out.push(rrect(ox - 22, oy - 22, cell * 3 + 44, cell * 3 + 44, 20, mix(c.dark, c.p, 0.12), { stroke: c.pl, 'stroke-opacity': '0.25', 'stroke-width': 2 }));
    out.push(line(ox + cell, oy, ox + cell, oy + cell * 3, { stroke: c.pl, 'stroke-width': 14, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(ox + cell * 2, oy, ox + cell * 2, oy + cell * 3, { stroke: c.pl, 'stroke-width': 14, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(ox, oy + cell, ox + cell * 3, oy + cell, { stroke: c.pl, 'stroke-width': 14, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(ox, oy + cell * 2, ox + cell * 3, oy + cell * 2, { stroke: c.pl, 'stroke-width': 14, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    const drawX = function (q, r, color, win) {
      const x = X(q), y = Y(r), s = 46, o = [];
      if (win) o.push(glowAt(x, y, 150));
      o.push(line(x - s, y - s, x + s, y + s, { stroke: color, 'stroke-width': 21, 'stroke-linecap': 'round' }));
      o.push(line(x + s, y - s, x - s, y + s, { stroke: color, 'stroke-width': 21, 'stroke-linecap': 'round' }));
      o.push(line(x - s, y - s, x + s, y + s, { stroke: lighten(color, 0.45), 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-opacity': '0.6' }));
      if (win) o.push(ring(x, y, 64, c.a, 3, { 'stroke-opacity': '0.8' }));
      return o.join('');
    };
    const drawO = function (q, r, color, win) {
      const x = X(q), y = Y(r), o = [];
      if (win) o.push(glowAt(x, y, 150));
      o.push(ring(x, y, 56, color, 19, { 'stroke-opacity': '0.95' }));
      o.push(ring(x, y, 56, lighten(color, 0.45), 5, { 'stroke-opacity': '0.5', 'stroke-dasharray': '60 220' }));
      if (win) o.push(ring(x, y, 70, c.a, 3, { 'stroke-opacity': '0.8' }));
      return o.join('');
    };
    out.push(drawX(0, 0, c.p, true));
    out.push(drawO(1, 0, c.s, false));
    out.push(drawX(2, 0, c.p, false));
    out.push(drawO(0, 1, c.s, false));
    out.push(drawX(1, 1, c.p, true));
    out.push(drawO(2, 1, c.s, false));
    out.push(drawX(2, 2, c.p, true));
    out.push(pathEl('M' + n(X(0) - 40) + ' ' + n(Y(0) - 40) + ' L' + n(X(2) + 40) + ' ' + n(Y(2) + 40), { stroke: c.a, 'stroke-width': 9, 'stroke-dasharray': '28 20', 'stroke-opacity': '0.75', 'stroke-linecap': 'round' }));
    out.push(sparkle(X(2) + 96, Y(2) + 96, 22, c.a, 0.85));
    out.push(sparkle(X(0) - 86, Y(0) - 86, 15, c.a, 0.6));
    return out.join('');
  },

  /* 打地鼠：草地 + 洞 + 冒头 + 锤子 */
  whack: function (c) {
    const out = [];
    const ground = mix(c.pd, '#3a1c05', 0.5);
    out.push(rect(0, 468, W, H - 468, ground));
    out.push(ellipse(340, 486, 320, 70, lighten(ground, 0.12), { 'fill-opacity': '0.6' }));
    out.push(ellipse(880, 496, 300, 74, lighten(ground, 0.1), { 'fill-opacity': '0.45' }));
    const hole = function (x, y, rx) {
      return ellipse(x, y, rx, rx * 0.34, '#120705') + ellipse(x, y, rx, rx * 0.34, 'none', { stroke: lighten(ground, 0.2), 'stroke-width': 4, 'stroke-opacity': '0.7' });
    };
    out.push(hole(300, 520, 66));
    out.push(hole(600, 520, 70));
    out.push(hole(900, 520, 66));
    out.push(hole(450, 626, 78));
    out.push(hole(760, 626, 78));
    out.push(hole(300, 520, 66));
    const body = mix(c.p, '#8b5a2b', 0.55);
    out.push(glowAt(600, 470, 180));
    out.push(ellipse(600, 456, 50, 58, body));
    out.push(ellipse(600, 472, 31, 33, lighten(body, 0.3), { 'fill-opacity': '0.55' }));
    out.push(circle(560, 412, 14, body));
    out.push(circle(640, 412, 14, body));
    out.push(circle(560, 412, 7, darken(body, 0.35), { 'fill-opacity': '0.7' }));
    out.push(circle(640, 412, 7, darken(body, 0.35), { 'fill-opacity': '0.7' }));
    out.push(ellipse(600, 468, 23, 17, lighten(body, 0.42)));
    out.push(circle(600, 460, 7.4, '#2a1206'));
    out.push(line(578, 466, 546, 458, { stroke: '#ffffff', 'stroke-width': 3, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(578, 474, 546, 482, { stroke: '#ffffff', 'stroke-width': 3, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(622, 466, 654, 458, { stroke: '#ffffff', 'stroke-width': 3, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(line(622, 474, 654, 482, { stroke: '#ffffff', 'stroke-width': 3, 'stroke-opacity': '0.5', 'stroke-linecap': 'round' }));
    out.push(circle(580, 438, 7, '#150a04'));
    out.push(circle(620, 438, 7, '#150a04'));
    out.push(circle(582, 436, 2.6, '#ffffff', { 'fill-opacity': '0.8' }));
    out.push(circle(622, 436, 2.6, '#ffffff', { 'fill-opacity': '0.8' }));
    const headColor = mix(c.p, '#cbd5e1', 0.42);
    out.push(group([
      rrect(766, 300, 30, 200, 15, c.a, { 'fill-opacity': '0.95' }),
      rrect(700, 248, 168, 76, 18, headColor, { stroke: darken(headColor, 0.4), 'stroke-width': 4 }),
      rect(712, 258, 144, 14, '#ffffff', { 'fill-opacity': '0.4' }),
      rrect(700, 248, 40, 76, 18, darken(headColor, 0.25), { 'fill-opacity': '0.8' }),
      rrect(828, 248, 40, 76, 18, darken(headColor, 0.25), { 'fill-opacity': '0.8' })
    ], { transform: rot(-30, 780, 300) }));
    out.push(pathEl('M640 208 A 180 180 0 0 1 830 146', { fill: 'none', stroke: c.p, 'stroke-width': 7, 'stroke-opacity': '0.5', 'stroke-linecap': 'round', 'stroke-dasharray': '26 18' }));
    out.push(pathEl('M676 168 A 240 240 0 0 1 900 132', { fill: 'none', stroke: c.a, 'stroke-width': 5, 'stroke-opacity': '0.32', 'stroke-linecap': 'round', 'stroke-dasharray': '18 16' }));
    out.push(glowAt(600, 392, 150));
    out.push(sparkle(600, 396, 40, c.a, 0.85));
    out.push(sparkle(520, 356, 20, c.a, 0.6));
    out.push(sparkle(676, 352, 16, c.a, 0.5));
    out.push(line(548, 420, 566, 402, { stroke: c.a, 'stroke-width': 5, 'stroke-opacity': '0.7', 'stroke-linecap': 'round' }));
    out.push(line(652, 420, 634, 402, { stroke: c.a, 'stroke-width': 5, 'stroke-opacity': '0.7', 'stroke-linecap': 'round' }));
    return out.join('');
  },

  /* 中国象棋：河界棋盘 + 对子 + 一步走子 */
  xiangqi: function (c) {
    const sp = 56, cols = 9, rows = 10;
    const ox = CX - sp * (cols - 1) / 2, oy = CY - sp * (rows - 1) / 2;
    const out = [];
    const X = function (q) { return ox + q * sp; };
    const Y = function (r) { return oy + r * sp; };
    out.push(rrect(X(0) - 34, Y(0) - 34, sp * 8 + 68, sp * 9 + 68, 14, mix(c.dark, c.p, 0.14), { stroke: c.pl, 'stroke-opacity': '0.28', 'stroke-width': 2 }));
    for (let i = 0; i < 9; i++) {
      if (i === 0 || i === 8) {
        out.push(line(X(i), Y(0), X(i), Y(9), { stroke: c.pl, 'stroke-width': 2.2, 'stroke-opacity': '0.45' }));
      } else {
        out.push(line(X(i), Y(0), X(i), Y(4), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
        out.push(line(X(i), Y(5), X(i), Y(9), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
      }
    }
    for (let r = 0; r < 10; r++) out.push(line(X(0), Y(r), X(8), Y(r), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
    out.push(rect(X(0), Y(4), sp * 8, sp, c.a, { 'fill-opacity': '0.09' }));
    out.push(pathEl('M' + n(X(0) + 16) + ' ' + n(Y(4) + 28) + ' q 30 -14 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0', { fill: 'none', stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.28' }));
    out.push(pathEl('M' + n(X(0) + 16) + ' ' + n(Y(4) + 40) + ' q 30 12 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0', { fill: 'none', stroke: c.pl, 'stroke-width': 1.6, 'stroke-opacity': '0.2' }));
    out.push(line(X(3), Y(0), X(5), Y(2), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
    out.push(line(X(5), Y(0), X(3), Y(2), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
    out.push(line(X(3), Y(7), X(5), Y(9), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
    out.push(line(X(5), Y(7), X(3), Y(9), { stroke: c.pl, 'stroke-width': 2, 'stroke-opacity': '0.4' }));
    const piece = function (q, r, red, glow) {
      const x = X(q), y = Y(r), o = [];
      const rim = red ? mix(c.s, '#dc2626', 0.5) : mix(c.pd, '#1f2937', 0.6);
      if (glow) o.push(glowAt(x, y, 104));
      o.push(ellipse(x + 2, y + 6, 26, 9, '#000000', { 'fill-opacity': '0.4' }));
      o.push(circle(x, y, 26, '#f6e7c8', { 'fill-opacity': '0.96' }));
      o.push(ring(x, y, 26, rim, 4, { 'stroke-opacity': '0.9' }));
      o.push(ring(x, y, 19, rim, 2, { 'stroke-opacity': '0.5' }));
      o.push(circle(x, y, 7.6, rim, { 'fill-opacity': '0.75' }));
      return o.join('');
    };
    out.push(piece(4, 0, false, false));
    out.push(piece(2, 3, true, false));
    out.push(piece(4, 3, true, false));
    out.push(piece(6, 5, true, false));
    out.push(piece(4, 6, false, false));
    out.push(piece(4, 9, false, false));
    out.push(piece(4, 4, false, true));
    out.push(pathEl('M' + n(X(4)) + ' ' + n(Y(6)) + ' L' + n(X(4)) + ' ' + n(Y(4)), { fill: 'none', stroke: c.a, 'stroke-width': 6, 'stroke-dasharray': '16 13', 'stroke-opacity': '0.8', 'stroke-linecap': 'round' }));
    out.push(arrow(X(4), Y(5) + 10, X(4), Y(4) + 34, c.a, 5));
    out.push(sparkle(X(4) + 70, Y(4) - 60, 18, c.a, 0.85));
    return out.join('');
  }
};

/* ============================== 组装一张封面 ============================== */

function buildSvg(slug) {
  const spec = SPEC[slug];
  const c = ctxOf(slug);
  const motif = MOTIFS[slug];
  if (typeof motif !== 'function') return null;
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img">');
  parts.push(defsOf(c, spec));
  parts.push(rect(0, 0, W, H, 'url(#bg)'));
  parts.push(textureOf(c, spec));
  parts.push(glowAt(spec.glow[0] * W, spec.glow[1] * H, 620));
  parts.push(glowAt2((1 - spec.glow[0]) * W, (1 - spec.glow[1]) * H, 470));
  parts.push(starsOf(slug));
  parts.push(motif(c));
  parts.push(rrect(16, 16, W - 32, H - 32, 28, 'none', { stroke: '#ffffff', 'stroke-opacity': '0.06', 'stroke-width': 2 }));
  parts.push('</svg>');
  return parts.join('');
}

/* ============================== 磁盘、清单、比对 ============================== */

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function fingerprintOf(buf) { return sha256(buf).slice(0, 16); }
function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

/* 递归列出目录下的文件（相对路径，正斜杠）。目录不存在返回空数组。 */
function listDirFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = function (abs, rel) {
    const items = fs.readdirSync(abs, { withFileTypes: true });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) walk(path.join(abs, it.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function readManifest() {
  const p = path.join(OUT_DIR, MANIFEST_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    return { raw: fs.readFileSync(p, 'utf8'), json: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { raw: null, json: null, error: e.message };
  }
}

/* games/ 与 slug 的一一对应。games/ 不存在时只提示（最小副本里跑测试用）。 */
function verifyGames(slugs) {
  if (!fs.existsSync(GAMES_DIR)) {
    log('提示：' + GAMES_DIR + ' 不存在，跳过 games/ 目录与 slug 的比对');
    return true;
  }
  const dirs = fs.readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory(); })
    .map(function (d) { return d.name; })
    .sort();
  const a = dirs.join(' '), b = slugs.slice().sort().join(' ');
  if (a !== b) {
    const missing = slugs.filter(function (s) { return dirs.indexOf(s) === -1; });
    const extra = dirs.filter(function (d) { return slugs.indexOf(d) === -1; });
    console.error('games/ 与 src/covers.js 的 slug 对不上，先对齐再生成：');
    if (missing.length) console.error('  只在 covers.js 里：' + missing.join(' '));
    if (extra.length) console.error('  只在 games/ 里：' + extra.join(' '));
    return false;
  }
  return true;
}

function buildAll(slugs) {
  const built = {};
  const tooBig = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const svg = buildSvg(slug);
    if (svg === null) { built[slug] = null; continue; }
    const buf = Buffer.from(svg, 'utf8');
    const entry = COVERS[slug];
    const rec = {
      slug: slug,
      svg: svg,
      buf: buf,
      bytes: buf.length,
      fingerprint: fingerprintOf(buf),
      file: slug + '.svg',
      src: '/covers/' + slug + '.svg',
      primary: entry.palette[0],
      palette: entry.palette.slice(),
      alt: entry.alt
    };
    if (rec.bytes > MAX_BYTES) tooBig.push(slug + '（' + kb(rec.bytes) + ' > ' + kb(MAX_BYTES) + '）');
    built[slug] = rec;
  }
  return { built: built, tooBig: tooBig };
}

/* ------------------------------ 写盘 ------------------------------ */

function writeAll(slugs, built, tooBig) {
  if (tooBig.length) {
    console.error('封面超过单文件上限 ' + kb(MAX_BYTES) + '：' + tooBig.join('、'));
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prev = readManifest();
  const prevJson = prev && prev.json ? prev.json : null;
  const nowIso = new Date().toISOString();
  const covers = {};
  let wrote = 0, kept = 0, totalBytes = 0, biggest = null;
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i], b = built[slug];
    const abs = path.join(OUT_DIR, b.file);
    const prevEntry = prevJson && prevJson.covers ? prevJson.covers[slug] : null;
    let same = false;
    if (prevEntry && prevEntry.bytes === b.bytes && prevEntry.fingerprint === b.fingerprint && fs.existsSync(abs)) {
      same = fingerprintOf(fs.readFileSync(abs)) === b.fingerprint;
    }
    const generatedAt = same && prevEntry.generatedAt ? prevEntry.generatedAt : nowIso;
    if (!same) {
      fs.writeFileSync(abs, b.buf);
      wrote++;
      log('  + ' + b.file + '  ' + kb(b.bytes) + '  主色 ' + b.primary);
    } else {
      kept++;
    }
    totalBytes += b.bytes;
    if (!biggest || b.bytes > biggest.bytes) biggest = b;
    covers[slug] = {
      file: b.file,
      src: b.src,
      bytes: b.bytes,
      primary: b.primary,
      palette: b.palette,
      alt: b.alt,
      fingerprint: b.fingerprint,
      generatedAt: generatedAt
    };
  }
  const manifest = {
    generator: 'tools/gen-covers.mjs',
    width: W,
    height: H,
    count: slugs.length,
    generatedAt: nowIso,
    covers: covers
  };
  const unchangedManifest = prevJson && prevJson.generator === manifest.generator && prevJson.width === W &&
    prevJson.height === H && prevJson.count === slugs.length &&
    JSON.stringify(prevJson.covers) === JSON.stringify(covers);
  if (unchangedManifest && prevJson.generatedAt) manifest.generatedAt = prevJson.generatedAt;
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSame = !!prev && prev.raw === json;
  if (!manifestSame) fs.writeFileSync(path.join(OUT_DIR, MANIFEST_NAME), json);
  say('封面产物 → ' + path.relative(ROOT, OUT_DIR).split(path.sep).join('/') + '/');
  say('  ' + slugs.length + ' 张：写入 ' + wrote + ' 个，未变 ' + kept + ' 个；合计 ' + kb(totalBytes) + '，最大 ' + kb(biggest.bytes) + '（' + biggest.file + '）');
  say('  ' + MANIFEST_NAME + '：' + (manifestSame ? '未变' : '已更新') + '（count=' + manifest.count + '，' + W + '×' + H + '）');
  const expected = slugs.map(function (s) { return s + '.svg'; }).concat([MANIFEST_NAME]);
  const extras = listDirFiles(OUT_DIR).filter(function (f) { return expected.indexOf(f) === -1; });
  if (extras.length) say('  注意：目录里还有清单外的文件（本工具不删）：' + extras.join(' '));
  return 0;
}

/* ------------------------------ --check ------------------------------ */

function checkAll(slugs, built, tooBig) {
  const problems = [];
  const manifestPath = path.join(OUT_DIR, MANIFEST_NAME);
  const m = readManifest();
  if (!m) {
    problems.push('缺 ' + MANIFEST_NAME + '（先跑一次 node tools/gen-covers.mjs）');
  } else if (m.error) {
    problems.push(MANIFEST_NAME + ' 不是合法 JSON：' + m.error);
  }
  const prev = m && m.json ? m.json : null;
  const expected = slugs.map(function (s) { return s + '.svg'; }).concat([MANIFEST_NAME]).sort();
  const actual = listDirFiles(OUT_DIR);
  for (let i = 0; i < expected.length; i++) if (actual.indexOf(expected[i]) === -1) problems.push('缺文件：' + expected[i]);
  for (let i = 0; i < actual.length; i++) if (expected.indexOf(actual[i]) === -1) problems.push('多余文件：' + actual[i]);
  for (let i = 0; i < tooBig.length; i++) problems.push('超上限：' + tooBig[i]);
  if (prev) {
    if (prev.generator !== 'tools/gen-covers.mjs') problems.push('清单 generator 不是 tools/gen-covers.mjs：' + prev.generator);
    if (prev.count !== slugs.length) problems.push('清单 count=' + prev.count + '，应为 ' + slugs.length);
    if (prev.width !== W || prev.height !== H) problems.push('清单尺寸 ' + prev.width + '×' + prev.height + '，应为 ' + W + '×' + H);
    const mc = prev.covers && typeof prev.covers === 'object' ? prev.covers : {};
    const mk = Object.keys(mc).sort();
    for (let i = 0; i < slugs.length; i++) if (!mc[slugs[i]]) problems.push('清单缺条目：' + slugs[i]);
    for (let i = 0; i < mk.length; i++) if (slugs.indexOf(mk[i]) === -1) problems.push('清单多条目：' + mk[i] + '（covers.js 里没有）');
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i], b = built[slug], e = mc[slug];
      if (!b || !e) continue;
      const abs = path.join(OUT_DIR, b.file);
      if (e.file !== b.file) problems.push(slug + '：清单 file=' + e.file + '，应为 ' + b.file);
      if (e.src !== b.src) problems.push(slug + '：清单 src=' + e.src + '，应为 ' + b.src);
      if (e.bytes !== b.bytes) problems.push(slug + '：清单 bytes=' + e.bytes + '，重新生成是 ' + b.bytes);
      if (e.fingerprint !== b.fingerprint) problems.push(slug + '：清单指纹 ' + e.fingerprint + ' ≠ 重新生成 ' + b.fingerprint);
      if (e.primary !== b.primary) problems.push(slug + '：清单 primary=' + e.primary + '，covers.js 是 ' + b.primary);
      if (e.alt !== b.alt) problems.push(slug + '：清单 alt 与 covers.js 不一致');
      if (JSON.stringify(e.palette) !== JSON.stringify(b.palette)) problems.push(slug + '：清单 palette 与 covers.js 不一致');
      if (!fs.existsSync(abs)) continue;
      const disk = fs.readFileSync(abs);
      if (disk.length !== b.bytes) problems.push(slug + '.svg 盘上 ' + disk.length + ' 字节，重新生成是 ' + b.bytes + ' 字节（内容漂移）');
      const dfp = fingerprintOf(disk);
      if (dfp !== b.fingerprint) problems.push(slug + '.svg 盘上指纹 ' + dfp + ' ≠ 重新生成 ' + b.fingerprint + '（内容漂移）');
      if (e.fingerprint !== dfp) problems.push(slug + '.svg 清单指纹 ' + e.fingerprint + ' ≠ 盘上 ' + dfp);
    }
  }
  if (problems.length) {
    say('--check 不通过：' + problems.length + ' 处问题');
    for (let i = 0; i < problems.length; i++) say('  x ' + problems[i]);
    return 1;
  }
  const actualSvg = actual.filter(function (f) { return f.slice(-4) === '.svg'; });
  say('--check 通过：清单与磁盘一致（' + actualSvg.length + ' 张 svg + ' + MANIFEST_NAME + '）');
  return 0;
}

/* ============================== main ============================== */

function main() {
  const slugs = Object.keys(COVERS).sort();
  if (!slugs.length) {
    console.error('src/covers.js 的 COVERS 是空的，没有可生成的封面');
    return 2;
  }
  const noSpec = slugs.filter(function (s) { return !SPEC[s] || typeof MOTIFS[s] !== 'function'; });
  if (noSpec.length) {
    console.error('这些 slug 缺骨架参数或母题（SPEC / MOTIFS）：' + noSpec.join(' '));
    return 2;
  }
  const stale = Object.keys(SPEC).filter(function (k) { return slugs.indexOf(k) === -1; })
    .concat(Object.keys(MOTIFS).filter(function (k) { return slugs.indexOf(k) === -1; }));
  if (stale.length) {
    console.error('SPEC / MOTIFS 里有 covers.js 里不存在的 slug（死条目）：' + stale.join(' '));
    return 2;
  }
  if (!verifyGames(slugs)) return 2;
  const pack = buildAll(slugs);
  const missing = slugs.filter(function (s) { return !pack.built[s]; });
  if (missing.length) {
    console.error('这些 slug 生成失败：' + missing.join(' '));
    return 2;
  }
  log('根目录：' + ROOT + '；slug ' + slugs.length + ' 个');
  return CHECK ? checkAll(slugs, pack.built, pack.tooBig) : writeAll(slugs, pack.built, pack.tooBig);
}

process.exitCode = main();



