// 汉字拼音工具：给搜索做「全拼 / 首字母」索引。纯 ESM、不依赖 node API，
// Express（src/）与 Workers（worker/）两条线共用。
import { PY_LO, PY_SYL, PY_TAB } from './pinyin-data.js';

// 与生成脚本一致的 2 位下标字母表
const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~';
const B = ALPHA.length;
const POS = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B; i++) m[ALPHA.charCodeAt(i)] = i;
  return m;
})();

const SYLS = PY_SYL.split(',');
let cache = null;

/** 把 PY_TAB 解码成「按码位偏移取音节」的数组，第一次用到时才算 */
function table() {
  if (cache) return cache;
  const n = Math.floor(PY_TAB.length / 2);
  const arr = new Array(n).fill('');
  for (let i = 0; i < n; i++) {
    const a = POS[PY_TAB.charCodeAt(i * 2)] ?? -1;
    const b = POS[PY_TAB.charCodeAt(i * 2 + 1)] ?? -1;
    if (a >= 0 && b >= 0) arr[i] = SYLS[a * B + b] || '';
  }
  cache = arr;
  return cache;
}

/** 单个汉字的拼音（无声调，ü 写作 v）；非汉字或表外字符返回 '' */
export function charPinyin(ch) {
  const cp = typeof ch === 'number' ? ch : String(ch).codePointAt(0);
  const off = cp - PY_LO;
  const t = table();
  return off >= 0 && off < t.length ? t[off] : '';
}

const isAscii = (ch) => /[a-z0-9]/.test(ch);
const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 把一段文本转成拼音检索用的两串：全拼 + 首字母（ASCII 原文照抄，其它分隔成空格）。
 * 例：'贪吃蛇 Snake 2048' → { full: 'tanchishe snake 2048', initials: 'tcs snake 2048' }
 */
export function pinyinTokens(text) {
  const t = String(text || '').toLowerCase();
  let full = '';
  let initials = '';
  for (const ch of t) {
    const p = charPinyin(ch);
    if (p) {
      full += p;
      initials += p[0];
    } else if (isAscii(ch)) {
      full += ch;
      initials += ch;
    } else {
      full += ' ';
      initials += ' ';
    }
  }
  return { full: squeeze(full), initials: squeeze(initials) };
}

export const isCJK = (ch) => !!charPinyin(ch);

/**
 * 给一条记录生成存进 games.search_pinyin 的检索串：全拼与首字母都进来，
 * 另外补一条 ü 的 u 写法（nv → nu），让两种输入都能命中。
 */
export function buildSearchIndex(parts, maxLen = 400) {
  const toks = [];
  for (const p of [].concat(parts)) {
    const { full, initials } = pinyinTokens(p);
    if (full) toks.push(full);
    if (initials && initials !== full) toks.push(initials);
  }
  let s = [...new Set(toks)].join(' ');
  if (s.includes('v')) s += ' ' + s.replace(/v/g, 'u');
  return s.slice(0, maxLen);
}

/** 查询词归一：仅中文查询需要额外生成拼音形态，拉丁查询直接用 */
export function queryVariants(q) {
  const raw = String(q || '').trim().toLowerCase();
  if (!raw) return [];
  const out = [raw];
  const { full, initials } = pinyinTokens(raw);
  for (const v of [full, initials]) if (v && v !== raw && !out.includes(v)) out.push(v);
  return out;
}
