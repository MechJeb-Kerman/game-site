#!/usr/bin/env node
/**
 * 生成 src/pinyin-data.js：一张覆盖 U+4E00..U+9FFF 的紧凑拼音表。
 *
 * 数据源：mozillazg/pinyin-data 的 pinyin.txt（MIT），格式是每行
 *   U+XXXX: han1,han2,...   # 注释
 * 只取第一个读音（多音字取常用音），ü 归一成 v（律 = lv），丢掉声调，
 * 只保留 ^[a-z]{1,7}$ 的音节；没有读音的码位在表里记成 '..'。
 *
 * 用法：
 *   node tools/gen-pinyin.mjs --download     # 没下过数据源时先下（约 12MB，慢）
 *   node tools/gen-pinyin.mjs                # 读 .pinyin-src.txt 生成 src/pinyin-data.js
 *   node tools/gen-pinyin.mjs --src=别的路径 --out=别的路径
 *
 * 仓库里已经带了生成结果，平时不需要跑；数据源不用提交（.gitignore 里有 .pinyin-src.txt）。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC_URL = 'https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const SRC = path.resolve(ROOT, arg('src', '.pinyin-src.txt'));
const OUT = path.resolve(ROOT, arg('out', 'src/pinyin-data.js'));
const LO = 0x4e00, HI = 0x9fff;

if (process.argv.includes('--download')) {
  process.stdout.write('下载 ' + SRC_URL + ' → ' + SRC + ' …（十几兆，可能要一两分钟）\n');
  const res = await fetch(SRC_URL, { redirect: 'follow' });
  if (!res.ok) { console.error('下载失败：HTTP ' + res.status); process.exit(1); }
  fs.writeFileSync(SRC, Buffer.from(await res.arrayBuffer()));
  process.stdout.write('下载完成 ' + (fs.statSync(SRC).size / 1048576).toFixed(1) + 'MB\n');
}
if (!fs.existsSync(SRC)) {
  console.error('没找到数据源 ' + SRC + '，先跑一次：node tools/gen-pinyin.mjs --download');
  process.exit(1);
}

const raw = fs.readFileSync(SRC, 'utf8');
const map = new Map();
for (const line of raw.split('\n')) {
  const m = /^U\+([0-9A-Fa-f]+):\s*([^#]+?)\s*(#.*)?$/.exec(line.trim());
  if (!m) continue;
  const cp = parseInt(m[1], 16);
  const first = m[2].split(',')[0].trim();
  if (!first) continue;
  const py = first.normalize('NFD').replace(/u\u0308/g, 'v').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/^[a-z]{1,7}$/.test(py)) continue;
  map.set(cp, py);
}

const cps = [];
for (let c = LO; c <= HI; c++) cps.push(c);
const syls = [...new Set(cps.map((c) => map.get(c)).filter(Boolean))].sort();
const idx = new Map(syls.map((s, i) => [s, i]));
// 64 个可打印字符当字母表：每个码位固定 2 个字符，第 1 个是高位、第 2 个是低位
const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~";
const B = ALPHA.length;
const enc = (i) => ALPHA[Math.floor(i / B)] + ALPHA[i % B];
const miss = cps.filter((c) => !map.has(c)).length;
const table = cps.map((c) => (map.has(c) ? enc(idx.get(map.get(c))) : '..')).join('');

const out = [
  '// 由 mozillazg/pinyin-data (pinyin.txt, MIT) 生成的紧凑拼音表，勿手改。',
  '// 覆盖 U+4E00..U+9FFF 共 ' + cps.length + ' 个码位（其中 ' + miss + ' 个无读音记为 ..）。',
  '// PY_TAB 每 2 个字符 = 1 个码位，取值是 PY_SYL 音节表的下标；重新生成用 tools/gen-pinyin.mjs。',
  'export const PY_LO = 0x4e00;',
  'export const PY_SYL = ' + JSON.stringify(syls.join(',')) + ';',
  'export const PY_TAB = ' + JSON.stringify(table) + ';',
  ''
].join('\n');
fs.writeFileSync(OUT, out);
console.log('写入 ' + path.relative(ROOT, OUT) + '：' + (out.length / 1024).toFixed(1) + 'KB，音节 ' + syls.length + ' 个，命中 ' + (cps.length - miss) + '/' + cps.length);
console.log('自检：' + ['女', '律', '略', '吕', '单', '重', '龙', '蛇', '贪', '吃'].map((ch) => ch + '=' + (map.get(ch.codePointAt(0)) || '?')).join(' '));
