#!/usr/bin/env node
/**
 * 生成 public/ 下 CSS / JS 的 *.min.* 压缩产物 —— 「建置期压缩」的唯一入口。
 *
 * 为什么要有这一层：
 *   线上已经开了 brotli/gzip（server.js 的 compress 中间件），CSS 从 51 KB 压到 9 KB。
 *   minify 是在压之前先把「空白、注释、缩进」这些传输层压不动的部分去掉，
 *   再交给 brotli —— 两者不冲突，顺序也固定：先 minify（磁盘产物），后 compress（线上）。
 *
 * 为什么产物入库、而不是每次构建现算：
 *   1. Express 线直接读 public/，Workers 线与 GitHub Pages 从产物目录搬，三边必须看到同一份；
 *   2. PWA 的 precache.json 要按内容算 revision，产物必须稳定、可 diff、可审计；
 *   3. CI 用 --check 就能挡住「改了源文件忘了重新生成」这种漂移。
 *
 * 用法：
 *   node tools/minify.mjs           # 生成/刷新 *.min.css / *.min.js
 *   node tools/minify.mjs --check   # 只比对（磁盘产物 vs 源文件重算结果），不一致退出码 1
 *   node tools/minify.mjs --report  # 只打印压缩前后体积，不写文件
 *
 * 退出码：0 一致/成功 / 1 --check 发现差异 / 2 结构错误。
 *
 * 压缩策略（保守，宁少省几个字节也不冒运行时风险）：
 *   CSS：去注释、折叠空白、去 `{ } ; : , > ~` 周围空格、去 `;}`、保留字符串与 calc() 里的 + - 空格。
 *   JS ：串/正则感知地去掉注释，按行去缩进与行尾空白、丢空行，**保留换行**（不拼行 —— 拼行是 ASI 风险的来源）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

import { MIN_SOURCES, minOutRel } from '../src/assets.js';

/* 清单与产物命名只在 src/assets.js 维护一份，这里重导出给老调用方 */
export const SOURCES = MIN_SOURCES;

const outPathOf = minOutRel;

/* ---------------------------------------------------------------- CSS */

/** CSS 压缩：字符串感知，`calc()` 里必须留空的 + - * / 一律不动 */
export function minifyCss(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  const tight = '{};:,>~';

  while (i < n) {
    const c = src[i];

    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue; }

    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      let j = i;
      while (j < n && /[ \t\n\r\f]/.test(src[j])) j += 1;
      const prev = out[out.length - 1];
      const next = src[j];
      if (prev && next && !tight.includes(prev) && !tight.includes(next)) out += ' ';
      i = j;
      continue;
    }

    out += c;
    i += 1;
  }

  return out.replace(/;}/g, '}').trim();
}

/* ---------------------------------------------------------------- JS */

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await'
]);

/**
 * JS 压缩：注释与缩进。
 * 用一个小状态机区分「字符串 / 正则 / 注释 / 普通代码」——正则和除号的歧义靠前一个有意义字符判断，
 * 这是唯一需要小心的地方（regex 里出现 `//` 会把后面半行当注释吃掉）。
 */
export function minifyJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = '';        // 上一个有意义的字符
  let lastWord = '';       // 上一个标识符（判断 return / typeof 后面的 / 是不是正则）
  let pendingSpace = false;

  const push = (s) => { out += s; };

  while (i < n) {
    const c = src[i];

    /* 行注释 */
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    /* 块注释 */
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      /* 块注释整体当空格：两侧的标识符不能因此粘成一个词 */
      if (out && !/[\s({[,;:+\-*/%=<>!&|?~^]$/.test(out)) pendingSpace = true;
      continue;
    }
    /* 字符串 */
    if (c === '"' || c === "'" || c === '`') {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      const q = c;
      push(c); i += 1;
      while (i < n) {
        const d = src[i];
        push(d);
        if (d === '\\') { push(src[i + 1] || ''); i += 2; continue; }
        i += 1;
        if (d === q) break;
      }
      lastSig = q; lastWord = '';
      continue;
    }
    /* 正则字面量 */
    if (c === '/' && (lastSig === '' || /[([{,;:=!&|?+\-*%^~<>]/.test(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord))) {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      push('/'); i += 1;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        push(d);
        if (d === '\\') { push(src[i + 1] || ''); i += 2; continue; }
        i += 1;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
      }
      while (i < n && /[a-z]/i.test(src[i])) { push(src[i]); i += 1; }
      lastSig = '/'; lastWord = '';
      continue;
    }

    /* 换行与空白：行首缩进直接丢，行内多个空白折叠成一个（保留换行 —— ASI 安全） */
    if (c === '\n') {
      out = out.replace(/[ \t]+$/, '');
      if (out && !out.endsWith('\n')) out += '\n';
      pendingSpace = false;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j += 1;
      pendingSpace = true;
      i = j;
      continue;
    }

    if (pendingSpace) {
      if (out && !out.endsWith('\n') && !/[\s({[,;:+\-*/%=<>!&|?~^]$/.test(out)) out += ' ';
      pendingSpace = false;
    }

    push(c);
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      push(word.slice(1));
      lastWord = word;
      lastSig = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) { lastSig = c; if (!/[A-Za-z0-9_$]/.test(c)) lastWord = ''; }
    i += 1;
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, ''))
    .filter((line) => line.length > 0)
    .join('\n')
    .trim() + '\n';
}

/* ---------------------------------------------------------------- 主流程 */

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function pct(before, after) {
  return before === 0 ? '0%' : '-' + (((before - after) / before) * 100).toFixed(1) + '%';
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const report = argv.includes('--report');
  let fail = 0;
  let beforeTotal = 0;
  let afterTotal = 0;
  const rows = [];

  for (const rel of SOURCES) {
    const abs = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(abs)) {
      console.error('!! 源文件不存在：' + rel);
      process.exit(2);
    }
    const src = fs.readFileSync(abs, 'utf8');
    const isCss = rel.endsWith('.css');
    const out = isCss ? minifyCss(src) : minifyJs(src);
    const outRel = outPathOf(rel);
    const outAbs = path.join(PUBLIC_DIR, outRel);
    const before = Buffer.byteLength(src, 'utf8');
    const after = Buffer.byteLength(out, 'utf8');
    beforeTotal += before;
    afterTotal += after;

    if (check) {
      const current = fs.existsSync(outAbs) ? fs.readFileSync(outAbs, 'utf8') : null;
      if (current !== out) {
        fail += 1;
        console.log('✗ ' + outRel + ' 与源文件不一致（先跑 node tools/minify.mjs）');
      } else {
        console.log('✓ ' + outRel + ' ' + kb(before) + ' → ' + kb(after) + ' ' + pct(before, after));
      }
      continue;
    }

    if (!report) fs.writeFileSync(outAbs, out);
    rows.push([outRel, before, after]);
  }

  if (!check) {
    for (const [rel, before, after] of rows) {
      console.log('  ' + rel.padEnd(26) + kb(before).padStart(9) + ' → ' + kb(after).padStart(8) + '  ' + pct(before, after));
    }
    console.log('  合计' + ' '.repeat(20) + kb(beforeTotal).padStart(11) + ' → ' + kb(afterTotal).padStart(8) + '  ' + pct(beforeTotal, afterTotal));
    if (!report) console.log('✓ 已写入 ' + rows.length + ' 个 *.min.* 产物');
  }

  if (check && fail) {
    console.log('✗ ' + fail + ' 个产物过期');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
