/**
 * 分享卡片 SVG 生成器（服务端，纯函数）。
 *
 * 三张卡：
 *   replayCardSvg()  —— 棋谱分享图：标题、双方昵称、结果、手数、对局时间 + 棋盘缩略图；
 *   profileCardSvg() —— 徽章 / 等级分享卡：昵称、称号、等级与 XP 进度条、徽章墙、公开统计；
 *   dailyCardSvg()   —— 每日挑战成绩卡：日期、今日题、打卡状态、连续天数与最近 14 天。
 *
 * 硬约束（画法与 src/cover.js 同一套，别在别处另起一套）：
 *   · 纯函数：不读时钟、不掷随机，同一份输入永远输出同一段字符串。对局时间按 **UTC** 格式化，
 *     同一份棋谱在两台时区不同的机器上生成出的图完全一致（Express 本机 / Workers 上不会漂）。
 *   · 零外部资源：只用系统字体栈、渐变、圆角矩形与字符；不引外链字体、图片、脚本，
 *     所以整张图直接能当 <img src="..."> / og:image，也能右键另存。
 *   · 零 npm 依赖：只 import 共享纯函数模块（src/badges.js 的等级与徽章口径、src/daily.js 的日期加减），
 *     Express 线与 Workers 线都能直接调用。
 *   · 注入防护：所有用户数据（昵称、标题、徽章名、origin）一律过 esc()；颜色只接受 #hex，
 *     因为投稿游戏的 accent 入库时只做了截长（src/data.js），没做字符校验。
 *
 * 渐变 id（bg / shine / xp / av / ring）是固定的：一张卡片就是一个独立 SVG 文档，不会撞名。
 * 设计基准 1200×630（OG 标准尺寸）；换 width/height 会把整套版面等比缩放，不会溢出。
 */
import { badgesOf, levelOf, titleOf } from './badges.js';
import { shiftDay } from './daily.js';

/** 站点名（与 src/views.js 的 SITE.name 一致；不 import 那个模块，免得把整个视图层拖进纯 SVG 生成器） */
const SITE_NAME = '趣玩小游戏';
/** 系统字体栈：与 src/cover.js 一致，不引任何外链字体 */
const FONT = "'PingFang SC','Microsoft YaHei',system-ui,sans-serif";

const DEFAULT_W = 1200;
const DEFAULT_H = 630;
/** 尺寸护栏：太小看不清、太大是异常调用（也顺手挡住 NaN） */
const MIN_SIDE = 200;
const MAX_SIDE = 4096;
/** 单个文本字段的显示上限（CJK 按字符数截断，超出补省略号） */
const MAX_TITLE = 13;
/** 与 src/play.js 的 MAX_NAME_LEN 一致 */
const MAX_NAME = 12;
/** 棋盘缩略图最多画多少枚棋子（棋谱最多 2000 手，图不用全画，输出大小才有上限） */
const MAX_MARKS = 240;
/** 背景网点上限（卡片越大点越多，封顶保证字符串长度可控） */
const MAX_DOTS = 400;
/** 徽章墙：已解锁最多 8 枚、未解锁灰显最多 4 枚（6 列 × 2 行） */
const MAX_OWNED = 8;
const MAX_LOCKED = 4;
const GRID_SLOTS = 12;

/** 结果码 → 中文（服务端只照单转发客户端声明，这里只做展示口径，与 src/views.js 回放页一致） */
const RESULT_LABEL = { host: '房主胜', guest: '挑战者胜', draw: '和棋' };

const ENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** XML 转义：用户名、标题、徽章名、origin 都必须过这里再进 SVG */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ENTS[c]);
}

/* ---------- 取值与格式化（全部容错，绝不抛错） ---------- */

/** 有限数字，否则给默认值；顺带保留两位小数，输出更短也更稳定 */
function n(v, dflt = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : dflt;
}

/** 取第一个有限数字（用不到 p.level 为 0 这类「合法零值」时也安全） */
function pick(v, dflt, min) {
  const x = Number(v);
  if (!Number.isFinite(x)) return dflt;
  return min === undefined ? x : Math.max(min, x);
}

/** 长度护栏：压平空白 + 按字符数截断（[…str] 保证 emoji 不被腰斩） */
function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : t;
}

/** 颜色只认 #hex（3/4/6/8 位），其余给默认色：投稿游戏的 accent 是用户可控的 */
function color(v, dflt) {
  const s = String(v == null ? '' : v).trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : dflt;
}

/** 卡片边长：非法值 / 超范围都退回默认值 */
function side(v, dflt) {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(Math.max(x, MIN_SIDE), MAX_SIDE) : dflt;
}

/** 等比缩放系数：把 1200×630 的设计稿铺到任意尺寸上 */
function ratioOf(w, h) {
  return Math.min(Math.max(Math.min(w / DEFAULT_W, h / DEFAULT_H), 0.4), 3);
}

/** origin → 只留主机名（去掉协议与路径）；这样 SVG 里不会出现 http(s):// 被当成外链 */
function hostOf(origin) {
  return String(origin == null ? '' : origin)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .slice(0, 40);
}

/** 时间戳 → 'YYYY-MM-DD HH:mm'（UTC，见文件头「确定性」说明） */
export function fmtTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/** 千分位（与 src/views.js 的 fmtNum 同口径） */
function fmtNum(v) {
  return String(Math.round(n(v, 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 文本估算宽度：CJK 按 1em、ASCII 按 0.56em —— 不依赖字体度量，保证确定性 */
function textWidth(str, size) {
  let units = 0;
  for (const ch of String(str == null ? '' : str)) units += /^[\x00-\xff]$/.test(ch) ? 0.56 : 1;
  return units * size;
}

/* ---------- SVG 原子（参数都是「最终尺寸」，缩放由调用方做） ---------- */

function rect(x, y, w, h, o = {}) {
  return '<rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"' +
    (o.rx ? ' rx="' + n(o.rx) + '"' : '') +
    ' fill="' + (o.fill || '#ffffff') + '"' +
    (o.opacity === undefined || o.opacity === 1 ? '' : ' fill-opacity="' + n(o.opacity) + '"') +
    (o.stroke ? ' stroke="' + o.stroke + '" stroke-opacity="' + n(o.strokeOpacity === undefined ? 1 : o.strokeOpacity) +
      '" stroke-width="' + n(o.strokeWidth || 1) + '"' : '') +
    '/>';
}

function circle(cx, cy, r, o = {}) {
  return '<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r) + '" fill="' + (o.fill || '#ffffff') + '"' +
    (o.opacity === undefined || o.opacity === 1 ? '' : ' fill-opacity="' + n(o.opacity) + '"') +
    (o.stroke ? ' stroke="' + o.stroke + '" stroke-opacity="' + n(o.strokeOpacity === undefined ? 1 : o.strokeOpacity) +
      '" stroke-width="' + n(o.strokeWidth || 1) + '"' : '') +
    '/>';
}

function line(x1, y1, x2, y2, o = {}) {
  return '<line x1="' + n(x1) + '" y1="' + n(y1) + '" x2="' + n(x2) + '" y2="' + n(y2) + '"' +
    ' stroke="' + (o.stroke || '#ffffff') + '" stroke-opacity="' + n(o.strokeOpacity === undefined ? 0.16 : o.strokeOpacity) +
    '" stroke-width="' + n(o.strokeWidth || 1) + '"' +
    (o.dash ? ' stroke-dasharray="' + o.dash + '"' : '') + '/>';
}

/** 一行文字：内容是用户数据，必须 esc；其余属性都是我们自己的白名单值 */
function text(x, y, str, o = {}) {
  return '<text x="' + n(x) + '" y="' + n(y) + '" font-family="' + FONT + '"' +
    ' font-size="' + n(o.size || 24) + '"' +
    (o.weight && o.weight !== 400 ? ' font-weight="' + n(o.weight) + '"' : '') +
    ' fill="' + (o.fill || '#ffffff') + '"' +
    (o.opacity === undefined || o.opacity === 1 ? '' : ' fill-opacity="' + n(o.opacity) + '"') +
    (o.anchor && o.anchor !== 'start' ? ' text-anchor="' + o.anchor + '"' : '') +
    (o.spacing ? ' letter-spacing="' + n(o.spacing) + '"' : '') +
    '>' + esc(str) + '</text>';
}

/** 圆角标签：宽度按字符数估算，返回 {w, svg} 便于在同一行里续排 */
function pill(x, y, label, o = {}) {
  const s = String(label == null ? '' : label);
  const size = n(o.size, 20);
  const h = n(o.h, 40);
  const padX = n(o.padX, 18);
  const w = Math.round(textWidth(s, size) + padX * 2);
  const svg = rect(x, y, w, h, { rx: h / 2, fill: o.fill || '#ffffff', opacity: o.fillOpacity === undefined ? 0.16 : o.fillOpacity }) +
    text(x + padX, y + h / 2 + size * 0.34, s, { size: size, weight: o.weight || 600, fill: o.color || '#ffffff', opacity: o.textOpacity });
  return { w: w, svg: svg };
}

/* ---------- 卡片外壳：渐变底 + 网点 + 高光 + 玻璃面板 + 页脚 ---------- */

function shell({ w, h, s, accent, accent2, aria, origin, body }) {
  const dots = [];
  for (let y = 48; y < h - 24 && dots.length < MAX_DOTS; y += 48) {
    for (let x = 48; x < w - 24 && dots.length < MAX_DOTS; x += 48) {
      dots.push(circle(x, y, Math.max(1.5, s(2)), { fill: '#ffffff', opacity: 0.1 }));
    }
  }
  const host = hostOf(origin);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
    '" role="img" aria-label="' + esc(aria) + '">' +
    '<defs>' +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + accent + '"/><stop offset="1" stop-color="' + accent2 + '"/></linearGradient>' +
    '<radialGradient id="shine" cx="50%" cy="26%" r="78%">' +
    '<stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="xp" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="' + accent + '"/><stop offset="1" stop-color="' + accent2 + '"/></linearGradient>' +
    '<linearGradient id="av" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + accent + '"/><stop offset="1" stop-color="' + accent2 + '"/></linearGradient>' +
    '<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="' + accent2 + '"/></linearGradient>' +
    '</defs>' +
    rect(0, 0, w, h, { fill: 'url(#bg)' }) +
    dots.join('') +
    rect(0, 0, w, h, { fill: 'url(#shine)' }) +
    rect(s(28), s(28), w - s(56), h - s(56), {
      rx: s(32), fill: '#0b1220', opacity: 0.42, stroke: '#ffffff', strokeOpacity: 0.16, strokeWidth: Math.max(1, s(1.5))
    }) +
    body +
    line(s(72), h - s(74), w - s(72), h - s(74), { strokeOpacity: 0.14, strokeWidth: Math.max(1, s(1.5)) }) +
    text(s(72), h - s(46), SITE_NAME, { size: s(22), weight: 600, opacity: 0.9 }) +
    (host ? text(w - s(72), h - s(46), host, { size: s(22), opacity: 0.75, anchor: 'end' }) : '') +
    '</svg>';
}

/* ---------- 棋盘缩略图：把 replay.moves 重放成示意图 ---------- */

/**
 * 各游戏的棋盘与走法编码（口径来自各游戏页面的联机模块，见 games/<slug>/index.html）：
 *   gomoku   'x,y'           15×15，seat 0 = 黑
 *   reversi  'r,c'            8×8，seat 0 = 黑
 *   connect4 'c'（或 'c,r'）   7×6，按列从底部往上叠
 *   chess    'e2e4'           8×8，取落点
 *   xiangqi  'x1,y1-x2,y2'    9×10，取落点
 *   draughts '52-41-30'       8×8，取末段落点
 *   tictactoe '0'..'8'        3×3，格号（页面暂无联机，兼容而已）
 * 只做示意图：坐标一律按「格心」画，认不出的游戏退回 8×8 空盘，认不出的走法直接跳过。
 */
const BOARDS = {
  gomoku: { cols: 15, rows: 15, style: 'stone', parse: parseXY },
  reversi: { cols: 8, rows: 8, style: 'stone', checker: true, parse: parseRC },
  connect4: { cols: 7, rows: 6, style: 'disc', drop: true, parse: parseCol },
  tictactoe: { cols: 3, rows: 3, style: 'stone', parse: parseIndex },
  chess: { cols: 8, rows: 8, style: 'pin', checker: true, parse: parseUci },
  xiangqi: { cols: 9, rows: 10, style: 'pin', parse: parseXQ },
  draughts: { cols: 8, rows: 8, style: 'pin', checker: true, parse: parsePathStr }
};

/** 每方棋子的配色：seat 0 / seat 1 */
const SEAT_COLOR = {
  stone: ['#0f172a', '#f8fafc'],
  disc: ['#ef4444', '#facc15'],
  pin: ['#fbbf24', '#38bdf8']
};

/** 'x,y' → 格心 {col:x, row:y}（五子棋） */
function parseXY(s) {
  const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

/** 'r,c' → {col:c, row:r}（黑白棋；行列与 'x,y' 正好反过来） */
function parseRC(s) {
  const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
  return m ? { col: Number(m[2]), row: Number(m[1]) } : null;
}

/** 'c' 或 'c,r' → 列号（四子棋，行由落子顺序推） */
function parseCol(s) {
  const m = /^\s*(\d)(?:\s*,\s*\d)?\s*$/.exec(String(s == null ? '' : s));
  return m ? { col: Number(m[1]), row: 0 } : null;
}

/** '0'..'8' → 3×3 格号；也兼容 'x,y' */
function parseIndex(s) {
  const m = /^\s*(\d)\s*$/.exec(String(s == null ? '' : s));
  if (!m) return parseXY(s);
  const i = Number(m[1]);
  return i >= 0 && i <= 8 ? { col: i % 3, row: Math.floor(i / 3) } : null;
}

/** 'e2e4' / 'e7e8q' → 落点（国际象棋，取后两字符的目标格） */
function parseUci(s) {
  const m = /^\s*([a-hA-H])([1-8])([a-hA-H])([1-8])/.exec(String(s == null ? '' : s));
  return m ? { col: m[3].toLowerCase().charCodeAt(0) - 97, row: 8 - Number(m[4]) } : null;
}

/** 'x1,y1-x2,y2' → 落点（中国象棋） */
function parseXQ(s) {
  const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*-\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
  return m ? { col: Number(m[3]), row: Number(m[4]) } : null;
}

/** '52-41-30' → 末段落点（国际跳棋，连吃只看吃到哪） */
function parsePathStr(s) {
  const parts = String(s == null ? '' : s).trim().split('-');
  const m = /^([0-7])([0-7])$/.exec(String(parts[parts.length - 1] || '').trim());
  return m ? { col: Number(m[2]), row: Number(m[1]) } : null;
}

/** 重放走法 → 棋盘模型（容错：认不出的走法跳过，绝不抛错） */
function boardModel(slug, moves) {
  const spec = BOARDS[String(slug == null ? '' : slug).toLowerCase()] ||
    { cols: 8, rows: 8, style: 'stone', parse: null };
  const cols = spec.cols;
  const rows = spec.rows;
  const marks = [];
  const stack = [];
  for (let i = 0; i < cols; i++) stack.push(0);
  const list = Array.isArray(moves) ? moves : [];
  for (const mv of list) {
    const p = spec.parse ? spec.parse(mv && mv.move) : null;
    if (!p || !Number.isFinite(p.col)) continue;
    let row = p.row;
    if (spec.drop) {
      if (p.col < 0 || p.col >= cols || stack[p.col] >= rows) continue;
      row = rows - 1 - stack[p.col];   // 从最底一排往上叠
      stack[p.col]++;
    }
    if (!(p.col >= 0 && p.col < cols && row >= 0 && row < rows)) continue;
    marks.push({ col: p.col, row: row, seat: n(mv && mv.seat, 0) === 1 ? 1 : 0 });
  }
  return {
    cols: cols, rows: rows, style: spec.style, checker: !!spec.checker,
    marks: marks.slice(Math.max(0, marks.length - MAX_MARKS)), total: marks.length
  };
}

/** 棋盘缩略图：圆角深底 + 网格（+ 棋盘格）+ 棋子 */
function boardSvg(model, x, y, size, s) {
  const pad = size * 0.045;
  const inner = size - pad * 2;
  const cw = inner / model.cols;
  const ch = inner / model.rows;
  const parts = [rect(x, y, size, size, {
    rx: size * 0.05, fill: '#0b1220', opacity: 0.38, stroke: '#ffffff', strokeOpacity: 0.14, strokeWidth: Math.max(1, s(1.5))
  })];
  if (model.checker) {
    for (let r = 0; r < model.rows; r++) {
      for (let c = 0; c < model.cols; c++) {
        if ((r + c) % 2) parts.push(rect(x + pad + c * cw, y + pad + r * ch, cw, ch, { fill: '#ffffff', opacity: 0.055 }));
      }
    }
  }
  for (let c = 0; c <= model.cols; c++) parts.push(line(x + pad + c * cw, y + pad, x + pad + c * cw, y + pad + inner, { strokeOpacity: 0.16 }));
  for (let r = 0; r <= model.rows; r++) parts.push(line(x + pad, y + pad + r * ch, x + pad + inner, y + pad + r * ch, { strokeOpacity: 0.16 }));
  const colors = SEAT_COLOR[model.style] || SEAT_COLOR.stone;
  const rad = Math.min(cw, ch) * 0.4;
  for (const m of model.marks) {
    const cx = x + pad + (m.col + 0.5) * cw;
    const cy = y + pad + (m.row + 0.5) * ch;
    parts.push(circle(cx, cy, rad, {
      fill: colors[m.seat], stroke: model.style === 'disc' ? '#0b1220' : '#ffffff',
      strokeOpacity: model.style === 'disc' ? 0.35 : 0.75, strokeWidth: Math.max(1, s(1.2))
    }));
  }
  return parts.join('');
}

/* ---------- 棋谱分享图 ---------- */

/**
 * 棋谱分享卡片。
 * @param {{replay?: object, game?: object, origin?: string, width?: number, height?: number}} o
 *   replay 用 src/play-store.js / worker/play-store.js 的 replay() 返回值（含 moves）；
 *   game 用 src/data.js 的 getGame() 返回值（title / emoji / accent / category）。
 * @returns {string} 完整 SVG 字符串
 */
export function replayCardSvg({ replay, game, origin, width = DEFAULT_W, height = DEFAULT_H } = {}) {
  const r = replay || {};
  const g = game || {};
  const w = side(width, DEFAULT_W);
  const h = side(height, DEFAULT_H);
  const k = ratioOf(w, h);
  const s = (v) => Math.round(v * k * 100) / 100;
  const accent = color(g.accent, '#6366f1');
  const accent2 = color(g.accent2, '#8b5cf6');

  const gameTitle = clip(g.title || r.game || '对局回放', MAX_TITLE);
  const host = clip(r.hostName || '房主', MAX_NAME);
  const guest = clip(r.guestName || '挑战者', MAX_NAME);
  const moves = Array.isArray(r.moves) ? r.moves : [];
  const moveCount = Math.max(0, Math.round(n(r.moveCount, moves.length)));
  const result = String(r.result || '');
  const winner = clip(r.winner, MAX_NAME);
  const when = fmtTime(r.createdAt);

  const label = clip((g.category && g.category.name) || '棋谱回放', 8);
  const labelPill = pill(s(72), s(76), '🎬 ' + label, { size: s(20), h: s(40) });
  const resultText = result === 'draw' ? '🤝 和棋' : (winner ? '🏆 ' + winner + ' 获胜' : '对局结束');
  const resultPill = pill(s(72), s(340), resultText, { size: s(24), h: s(52), weight: 700 });

  const meta = ['共 ' + moveCount + ' 手'];
  if (result) meta.push('结果：' + (RESULT_LABEL[result] || result));
  if (when) meta.push(when);

  let model;
  try { model = boardModel(r.game || g.slug, moves); } catch (e) { model = boardModel('', []); }
  const bs = s(Math.min(400, Math.max(160, Math.min(h / k - 230, (w / k) * 0.36))));
  const bx = w - s(72) - bs;
  const by = s(120);

  const body = labelPill.svg +
    text(s(72), s(172), gameTitle, { size: s(52), weight: 800 }) +
    circle(s(84), s(236), s(9), { fill: accent }) +
    text(s(108), s(246), host, { size: s(34), weight: 700 }) +
    text(s(108), s(300), guest, { size: s(28), opacity: 0.85 }) +
    resultPill.svg +
    text(s(72), s(444), meta.join(' · '), { size: s(23), opacity: 0.78 }) +
    text(bx + bs / 2, by - s(20), '棋盘示意 · ' + model.total + ' 手', { size: s(20), opacity: 0.6, anchor: 'middle' }) +
    boardSvg(model, bx, by, bs, s);

  return shell({ w: w, h: h, s: s, accent: accent, accent2: accent2, origin: origin,
    aria: gameTitle + ' 棋谱：' + host + ' 对 ' + guest, body: body });
}

/* ---------- 徽章 / 等级分享卡 ---------- */

/** 一枚徽章小卡：dim=true 是未解锁的灰显态（带 now/need 进度） */
function badgeChip(x, y, w, h, b, dim, s) {
  const icon = clip((b && b.icon) || '🏅', 2);
  const name = clip((b && b.name) || '徽章', 5);
  const now = Math.round(n(b && b.now, 0));
  const need = Math.max(1, Math.round(n(b && b.need, 1)));
  const parts = [rect(x, y, w, h, {
    rx: s(16), fill: '#ffffff', opacity: dim ? 0.05 : 0.09, stroke: '#ffffff', strokeOpacity: dim ? 0.08 : 0.16, strokeWidth: Math.max(1, s(1))
  })];
  parts.push(text(x + s(16), y + h * 0.66, icon, { size: s(24), opacity: dim ? 0.5 : 1 }));
  parts.push(text(x + s(52), y + h * 0.46, name, { size: s(18), weight: 600, opacity: dim ? 0.5 : 1 }));
  if (dim) parts.push(text(x + s(52), y + h * 0.76, now + '/' + need, { size: s(14), opacity: 0.5 }));
  return parts.join('');
}

/**
 * 徽章 / 等级分享卡片。
 * @param {{profile?: object, origin?: string, width?: number, height?: number}} o
 *   profile 用 src/social.js / worker/social.js 的 profileOf() 返回值；
 *   只给统计字段（statsOf 的形状）也能用 —— 等级、称号、徽章会按 src/badges.js 现算。
 * @returns {string} 完整 SVG 字符串
 */
export function profileCardSvg({ profile, origin, width = DEFAULT_W, height = DEFAULT_H } = {}) {
  const p = profile || {};
  const w = side(width, DEFAULT_W);
  const h = side(height, DEFAULT_H);
  const k = ratioOf(w, h);
  const s = (v) => Math.round(v * k * 100) / 100;
  const accent = color(p.accent, '#6366f1');
  const accent2 = color(p.accent2, '#22d3ee');

  const name = clip(p.name || p.username || '玩家', MAX_NAME);
  const computed = levelOf(p);
  const level = Math.round(pick(p.level, computed.level, 1));
  const xp = Math.round(pick(p.xp, computed.xp, 0));
  const floor = Math.round(pick(p.xpFloor, computed.floor, 0));
  const next = Math.round(pick(p.xpNext, computed.next, computed.next));
  const need = Math.max(0, next - xp);
  const title = clip(p.title || titleOf(level), 8);

  const list = Array.isArray(p.badges) ? p.badges : badgesOf(p);
  const owned = list.filter((b) => b && b.done);
  const locked = list.filter((b) => !(b && b.done));
  const ownedShown = owned.slice(0, MAX_OWNED);
  const lockedShown = locked.slice(0, Math.max(0, Math.min(MAX_LOCKED, GRID_SLOTS - ownedShown.length)));
  const hidden = (owned.length - ownedShown.length) + (locked.length - lockedShown.length);

  // 进度条口径与 src/views.js 个人主页一致：保底 4% 才看得见
  const span = Math.max(1, next - floor);
  const pct = Math.max(4, Math.min(100, Math.round((xp - floor) / span * 100)));

  const initial = clip([...name][0] || '?', 1);
  const nameW = textWidth(name, s(40));
  const barX = s(212);
  const barW = w - s(72) - barX;
  const stats = [
    { v: p.comments, l: '评论' },
    { v: p.favorites, l: '收藏' },
    { v: p.ratings, l: '评分' },
    { v: p.streak, l: '连续打卡（天）' }
  ];
  const gap = s(24);
  const slotW = (w - s(144) - gap * 3) / 4;
  const bgap = s(16);
  // 6 列 × 2 行；用「整段宽度均分」而不是累加，避免浮点误差堆到最后一列
  const bw = (w - s(144) - bgap * 5) / 6;
  const bh = s(64);

  // 头像左缘与正文左边距（72）对齐，避免整张卡的左侧参差
  const avX = s(126);
  const avR = s(54);
  const body = circle(avX, s(118), avR, { fill: 'url(#av)' }) +
    text(avX, s(118) + s(16), initial, { size: s(44), weight: 800, anchor: 'middle' }) +
    text(barX, s(104), name, { size: s(40), weight: 800 }) +
    pill(barX + nameW + s(18), s(70), title, { size: s(20), h: s(40), fillOpacity: 0.2 }).svg +
    text(barX, s(152), 'Lv.' + level + ' · ' + fmtNum(xp) + ' 经验 · ' + (need > 0 ? '距下一级还差 ' + fmtNum(need) : '已满级'),
      { size: s(22), opacity: 0.8 }) +
    rect(barX, s(168), barW, s(16), { rx: s(8), fill: '#ffffff', opacity: 0.14 }) +
    rect(barX, s(168), Math.max(s(16), barW * pct / 100), s(16), { rx: s(8), fill: 'url(#xp)' }) +
    text(w - s(72), s(206), fmtNum(xp) + ' / ' + fmtNum(next) + ' 经验', { size: s(18), opacity: 0.7, anchor: 'end' }) +
    stats.map((st, i) => {
      const x = s(72) + i * (slotW + gap);
      return rect(x, s(230), slotW, s(84), { rx: s(18), fill: '#ffffff', opacity: 0.07, stroke: '#ffffff', strokeOpacity: 0.12, strokeWidth: Math.max(1, s(1)) }) +
        text(x + s(22), s(280), fmtNum(st.v), { size: s(34), weight: 800 }) +
        text(x + s(22), s(304), st.l, { size: s(20), opacity: 0.72 });
    }).join('') +
    text(s(72), s(356), '🏅 成就徽章', { size: s(26), weight: 700 }) +
    text(w - s(72), s(356), owned.length + ' / ' + list.length + ' 枚已解锁' + (hidden > 0 ? ' · 还有 ' + hidden + ' 枚未展示' : ''),
      { size: s(21), opacity: 0.74, anchor: 'end' }) +
    ownedShown.concat(lockedShown).map((b, i) => {
      const x = s(72) + (i % 6) * (bw + bgap);
      const y = s(386) + Math.floor(i / 6) * (bh + s(16));
      return badgeChip(x, y, bw, bh, b, !(b && b.done), s);
    }).join('');

  return shell({ w: w, h: h, s: s, accent: accent, accent2: accent2, origin: origin,
    aria: name + ' 的徽章与等级卡片', body: body });
}

/* ---------- 每日挑战成绩卡 ---------- */

/**
 * 每日挑战成绩卡片。
 * @param {{day?: string, game?: object, stats?: object, origin?: string, width?: number, height?: number}} o
 *   day 是 'YYYY-MM-DD'；game 是当天那款游戏；stats 用 src/social.js 的 dailyStats() 返回值
 *   （total / streak / doneToday / done 日期数组）。
 * @returns {string} 完整 SVG 字符串
 */
export function dailyCardSvg({ day, game, stats, origin, width = DEFAULT_W, height = DEFAULT_H } = {}) {
  const g = game || {};
  const st = stats || {};
  const w = side(width, DEFAULT_W);
  const h = side(height, DEFAULT_H);
  const k = ratioOf(w, h);
  const s = (v) => Math.round(v * k * 100) / 100;
  const accent = color(g.accent, '#f59e0b');
  const accent2 = color(g.accent2, '#ec4899');

  const dayKeyStr = /^\d{4}-\d{2}-\d{2}$/.test(String(day == null ? '' : day)) ? String(day) : '';
  const total = Math.max(0, Math.round(n(st.total, 0)));
  const streak = Math.max(0, Math.round(n(st.streak, 0)));
  const doneToday = !!st.doneToday;
  const gameTitle = clip(g.title || '今日题目', MAX_TITLE);
  const emoji = clip(g.emoji || '🎯', 2);

  // 最近 14 天：日期由 shiftDay 纯函数算，done 里的日期键取前 10 位（与 src/views.js 每日挑战页一致）
  const doneSet = new Set((Array.isArray(st.done) ? st.done : []).map((d) => String(d).slice(0, 10)));
  const strip = [];
  if (dayKeyStr) {
    for (let i = 13; i >= 0; i--) {
      const d = shiftDay(dayKeyStr, -i);
      if (d) strip.push({ day: d, done: doneSet.has(d) });
    }
  }
  const doneInStrip = strip.filter((x) => x.done).length;

  // 连续天数环：满 30 天画满（周长 2πr，用 dasharray 画弧，避免三角函数带来的浮点抖动）
  const ringR = s(112);
  const ringC = Math.round(2 * Math.PI * ringR * 100) / 100;
  const ringPct = Math.max(0, Math.min(1, streak / 30));
  const ringDash = Math.round(ringPct * ringC * 100) / 100;
  const cx = w - s(72) - s(200);
  const cy = s(250);

  const stripW = s(22);
  const stripGap = s(6);
  const stripTotal = strip.length * stripW + Math.max(0, strip.length - 1) * stripGap;
  const stripY = s(430);

  const statusPill = doneToday
    ? pill(s(72), s(314), '✅ 今天已打卡', { size: s(24), h: s(52), weight: 700, fill: '#22c55e', fillOpacity: 0.26 })
    : pill(s(72), s(314), '⏳ 今天还没打卡', { size: s(24), h: s(52), weight: 700, fill: '#f59e0b', fillOpacity: 0.26 });

  const body = pill(s(72), s(76), '📅 每日挑战', { size: s(20), h: s(40) }).svg +
    text(s(72), s(196), dayKeyStr || '今日挑战', { size: s(64), weight: 800, spacing: s(1) }) +
    text(s(72), s(268), emoji, { size: s(40) }) +
    text(s(130), s(268), gameTitle, { size: s(36), weight: 700 }) +
    statusPill.svg +
    text(s(72), s(420), '累计打卡 ' + total + ' 天 · 连续 ' + streak + ' 天', { size: s(24), opacity: 0.82 }) +
    circle(cx, cy, ringR, { fill: 'none', stroke: '#ffffff', strokeOpacity: 0.16, strokeWidth: s(18) }) +
    '<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(ringR) + '" fill="none" stroke="url(#ring)" stroke-width="' + n(s(18)) +
      '" stroke-linecap="round" stroke-dasharray="' + ringDash + ' ' + ringC + '" transform="rotate(-90 ' + n(cx) + ' ' + n(cy) + ')"/>' +
    text(cx, s(206), '🔥', { size: s(38), anchor: 'middle' }) +
    text(cx, s(272), String(streak), { size: s(76), weight: 800, anchor: 'middle' }) +
    text(cx, s(314), '连续打卡（天）', { size: s(20), opacity: 0.75, anchor: 'middle' }) +
    strip.map((x, i) => rect(cx - stripTotal / 2 + i * (stripW + stripGap), stripY, stripW, s(44), {
      rx: s(8),
      fill: x.done ? 'url(#ring)' : '#ffffff',
      opacity: x.done ? 1 : 0.1,
      stroke: '#ffffff',
      strokeOpacity: x.done ? 0.5 : 0.16,
      strokeWidth: Math.max(1, s(1))
    })).join('') +
    (strip.length ? text(cx, s(506), '最近 14 天打卡 ' + doneInStrip + ' 天', { size: s(20), opacity: 0.62, anchor: 'middle' }) : '');

  return shell({ w: w, h: h, s: s, accent: accent, accent2: accent2, origin: origin,
    aria: (dayKeyStr || '每日挑战') + ' 成绩卡：连续 ' + streak + ' 天', body: body });
}
