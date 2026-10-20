#!/usr/bin/env node
/**
 * 生成 public/precache.json —— PWA「真离线」清单的单一事实来源。
 *
 * 做什么：
 *   1. 扫描仓库里离线必需的资源：20 款游戏页 /games/<slug>/index.html、/static/js/*、
 *      /static/css/*、/icons/*.png、/favicon.ico、/favicon.svg、/manifest.webmanifest、离线壳 /；
 *   2. 逐条算内容哈希（revision），再把「URL + revision」串起来算整份清单的 version
 *      —— 任何一条内容变了 version 就变；Service Worker 靠它换缓存名、activate 时清旧桶；
 *   3. 写出 public/precache.json（纯 JSON、UTF-8、结尾带换行）；
 *   4. 把 version 与 URL 数组同步进 public/sw.js 的 PRECACHE:BEGIN/END 生成块（兜底用：
 *      sw.js 在 install 时优先拉线上 /precache.json，拉不到才用这块内置清单）。
 *
 * 用法：
 *   node tools/gen-precache.mjs          # 生成/刷新
 *   node tools/gen-precache.mjs --check  # 只比对（磁盘现状 vs precache.json vs sw.js 生成块），不一致退出码 1
 *   node tools/gen-precache.mjs --quiet  # 只打一行结论
 *
 * 退出码：0 一致 / 1 --check 发现差异 / 2 用法或结构错误（sw.js 缺生成块标记）。
 *
 * 注意：precache.json 是产物，不要手改；sw.js 里生成块之外的代码是手写的，本工具只替换
 *       BEGIN/END 之间的内容。改了扫描范围就同步改这里的 collectEntries()。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GAMES_DIR = path.join(ROOT, 'games');
const OUT_FILE = path.join(PUBLIC_DIR, 'precache.json');
const SW_FILE = path.join(PUBLIC_DIR, 'sw.js');

/* sw.js 生成块的标记（本工具只动这两行之间的内容） */
const BLOCK_BEGIN = '/* PRECACHE:BEGIN';
const BLOCK_END = '/* PRECACHE:END */';

/* 单文件超过这个大小就在报告里点名（不阻止生成，只提示取舍） */
const BIG_FILE_WARN = 200 * 1024;

/* ---------------------------------------------------------------- 小工具（纯函数优先） */

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function shortHash(text) {
  return sha1(text).slice(0, 12);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/* 目录里指定后缀的文件名（不递归，按名字排序；目录不存在返回空数组） */
function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => e.name)
    .sort();
}

/* 静态文件条目：内容哈希 + 字节数 */
function staticEntry(url, abs, kind) {
  const buf = fs.readFileSync(abs);
  return {
    url: url,
    kind: kind,
    revision: shortHash(buf.toString('base64')),
    bytes: buf.length,
    file: rel(abs)
  };
}

/* 动态条目：内容由服务端运行时生成（没有磁盘文件），用一个稳定的占位 revision */
function dynamicEntry(url, kind, note) {
  return { url: url, kind: kind, revision: 'dynamic:' + sha1(note).slice(0, 12), bytes: null, file: null };
}

/* ---------------------------------------------------------------- 扫描（清单的唯一来源） */

function collectEntries() {
  const out = [];

  /* 离线壳 = 首页 HTML（Express 与 Workers 两线都由服务端渲染，磁盘上没有对应文件） */
  out.push(dynamicEntry('/', 'shell', 'server-rendered-home'));

  /* 20 款游戏页：games/<slug>/index.html → /games/<slug>/index.html */
  const slugs = fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((s) => fs.existsSync(path.join(GAMES_DIR, s, 'index.html')))
    .sort();
  for (const slug of slugs) {
    out.push(staticEntry('/games/' + slug + '/index.html', path.join(GAMES_DIR, slug, 'index.html'), 'game'));
  }

  /* 静态资源：Express 线 /static/* 挂的就是 public/ 根目录 */
  for (const name of listFiles(path.join(PUBLIC_DIR, 'js'), '.js')) {
    out.push(staticEntry('/static/js/' + name, path.join(PUBLIC_DIR, 'js', name), 'script'));
  }
  for (const name of listFiles(path.join(PUBLIC_DIR, 'css'), '.css')) {
    out.push(staticEntry('/static/css/' + name, path.join(PUBLIC_DIR, 'css', name), 'style'));
  }
  for (const name of listFiles(path.join(PUBLIC_DIR, 'icons'), '.png')) {
    out.push(staticEntry('/icons/' + name, path.join(PUBLIC_DIR, 'icons', name), 'icon'));
  }

  /* 两条线的 favicon 都是内联 SVG（server.js / worker/app.js 里 route 出来的），无磁盘文件 */
  out.push(dynamicEntry('/favicon.ico', 'icon', 'inline-svg'));
  out.push(dynamicEntry('/favicon.svg', 'icon', 'inline-svg'));

  out.push(staticEntry('/manifest.webmanifest', path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'manifest'));

  return out;
}

/* 清单版本：URL + revision 排序后一起哈希 —— 内容变则版本变 */
function manifestVersion(entries) {
  const lines = entries
    .map((e) => e.url + '\t' + e.revision)
    .sort()
    .join('\n');
  return 'p1-' + shortHash(lines);
}

function buildManifest(entries, generatedAt) {
  const staticBytes = entries.filter((e) => typeof e.bytes === 'number');
  const totalBytes = staticBytes.reduce((sum, e) => sum + e.bytes, 0);
  const max = staticBytes.reduce((best, e) => (best && best.bytes >= e.bytes ? best : e), null);
  return {
    version: manifestVersion(entries),
    generatedAt: generatedAt,
    generator: 'tools/gen-precache.mjs',
    note: 'PWA 离线清单：sw.js 在 install 时按 urls 逐条预缓存（单条失败只计数，不整体失败）',
    count: entries.length,
    bytes: totalBytes,
    maxBytes: max ? max.bytes : 0,
    urls: entries
  };
}

/* ---------------------------------------------------------------- 比对（--check 与生成共用） */

/* 只比「清单身份」：version + 每条 url/kind/revision/bytes；generatedAt 每次都变，不参与比对 */
function diffManifests(oldManifest, fresh) {
  const problems = [];
  if (!oldManifest || typeof oldManifest !== 'object') return ['precache.json 不存在或不是 JSON 对象'];
  if (oldManifest.version !== fresh.version) {
    problems.push('version 不一致：磁盘 ' + oldManifest.version + ' / 现状 ' + fresh.version);
  }
  const oldList = Array.isArray(oldManifest.urls) ? oldManifest.urls : [];
  const oldMap = new Map();
  for (const item of oldList) {
    const url = typeof item === 'string' ? item : item && item.url;
    if (url) oldMap.set(url, item);
  }
  const freshUrls = new Set(fresh.urls.map((e) => e.url));
  for (const entry of fresh.urls) {
    const before = oldMap.get(entry.url);
    if (!before) {
      problems.push('缺少条目：' + entry.url);
      continue;
    }
    if (typeof before === 'string') continue; /* 旧格式只写 URL 的也算一致 */
    if (before.revision !== entry.revision) problems.push('内容已变：' + entry.url + '（' + before.revision + ' → ' + entry.revision + '）');
    if (typeof before.bytes === 'number' && typeof entry.bytes === 'number' && before.bytes !== entry.bytes) {
      problems.push('字节数已变：' + entry.url + '（' + before.bytes + ' → ' + entry.bytes + '）');
    }
  }
  for (const url of oldMap.keys()) {
    if (!freshUrls.has(url)) problems.push('多余条目（文件已删或不该缓存）：' + url);
  }
  return problems;
}

/* ---------------------------------------------------------------- sw.js 生成块 */

function renderBlock(manifest) {
  const big = manifest.urls.filter((e) => typeof e.bytes === 'number' && e.bytes >= BIG_FILE_WARN).length;
  const lines = [];
  lines.push(BLOCK_BEGIN + ' —— 本块由 tools/gen-precache.mjs 生成，不要手改（跑 node tools/gen-precache.mjs 刷新） */');
  lines.push('/* ' + manifest.count + ' 条 · ' + kbytes(manifest.bytes) + ' · 最大单文件 ' + kbytes(manifest.maxBytes) + (big ? ' · 超 ' + kbytes(BIG_FILE_WARN) + ' 的 ' + big + ' 条' : '') + ' */');
  lines.push("const PRECACHE_VERSION = '" + manifest.version + "';");
  lines.push('const PRECACHE_FALLBACK = [');
  lines.push(manifest.urls.map((e) => "  '" + e.url + "'").join(',\n'));
  lines.push('];');
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/* 从 sw.js 里取出生成块与 PRECACHE_VERSION（没有块返回 null） */
function readBlock(swText) {
  const begin = swText.indexOf(BLOCK_BEGIN);
  const end = swText.indexOf(BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) return null;
  const text = swText.slice(begin, end + BLOCK_END.length);
  const m = text.match(/const PRECACHE_VERSION = '([^']+)'/);
  const urls = [...text.matchAll(/^\s*'([^']+)',?$/gm)].map((x) => x[1]);
  return { text: text, version: m ? m[1] : '', urls: urls };
}

function syncSwText(swText, manifest) {
  const block = readBlock(swText);
  if (!block) return null;
  return swText.slice(0, swText.indexOf(BLOCK_BEGIN)) + renderBlock(manifest) + swText.slice(swText.indexOf(BLOCK_END) + BLOCK_END.length);
}

/* ---------------------------------------------------------------- 报告 */

function kbytes(n) {
  return (n / 1024).toFixed(1) + ' KB';
}

function printSummary(manifest, quiet) {
  const statics = manifest.urls.filter((e) => typeof e.bytes === 'number').sort((a, b) => b.bytes - a.bytes);
  const byKind = {};
  for (const e of manifest.urls) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  if (!quiet) {
    console.log('  版本：' + manifest.version);
    console.log('  条目：' + manifest.count + '（' + Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(' · ') + '）');
    console.log('  体积：' + kbytes(manifest.bytes) + '（' + statics.length + ' 个磁盘文件）· 最大单文件 ' + kbytes(manifest.maxBytes));
    console.log('  最大的 5 个：');
    for (const e of statics.slice(0, 5)) console.log('    ' + kbytes(e.bytes).padStart(9) + '  ' + e.url);
    const big = statics.filter((e) => e.bytes >= BIG_FILE_WARN);
    if (big.length) {
      console.log('  ⚠ 超 ' + kbytes(BIG_FILE_WARN) + ' 的文件 ' + big.length + ' 个：' + big.map((e) => e.url).join('、'));
      console.log('    取舍策略：单页过大时从 urls 里剔掉它（unmodified 页面退回 network-first + 离线壳页），');
      console.log('    或把该游戏的内联脚本/样式抽到 /static 下单独进清单；别整套放弃预缓存。');
    }
  }
}

/* ---------------------------------------------------------------- 主流程 */

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const quiet = argv.includes('--quiet');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/gen-precache.mjs [--check] [--quiet]');
    return 0;
  }

  const entries = collectEntries();
  const fresh = buildManifest(entries, new Date().toISOString());
  if (fresh.count < 20) {
    console.error('✗ 只扫到 ' + fresh.count + ' 条资源，20 款游戏页没扫全，检查 ' + rel(GAMES_DIR) + ' 目录');
    return 2;
  }

  const swText = fs.readFileSync(SW_FILE, 'utf8');
  const block = readBlock(swText);
  if (!block) {
    console.error('✗ ' + rel(SW_FILE) + ' 里找不到 ' + BLOCK_BEGIN + ' … ' + BLOCK_END + ' 生成块标记');
    return 2;
  }

  if (check) {
    const problems = [];
    let onDisk = null;
    try {
      onDisk = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    } catch (e) {
      problems.push('读不到 ' + rel(OUT_FILE) + '（' + (e && e.message ? e.message : e) + '）—— 先跑 node tools/gen-precache.mjs');
    }
    problems.push(...diffManifests(onDisk, fresh));
    if (block.version !== fresh.version) {
      problems.push('sw.js 生成块的 PRECACHE_VERSION（' + block.version + '）与现状（' + fresh.version + '）不一致 —— 跑 node tools/gen-precache.mjs 刷新');
    }
    const freshUrls = fresh.urls.map((e) => e.url).join('\n');
    if (block.urls.join('\n') !== freshUrls) {
      problems.push('sw.js 生成块的 URL 数组与现状不一致（' + block.urls.length + ' 条 vs ' + fresh.urls.length + ' 条）');
    }
    if (problems.length) {
      console.error('✗ precache 清单与磁盘不一致（' + problems.length + ' 处）：');
      for (const p of problems.slice(0, 20)) console.error('  · ' + p);
      if (problems.length > 20) console.error('  · …还有 ' + (problems.length - 20) + ' 处');
      console.error('  修法：node tools/gen-precache.mjs');
      return 1;
    }
    console.log('✓ precache 清单与磁盘一致：' + fresh.count + ' 条 · ' + kbytes(fresh.bytes) + ' · ' + fresh.version);
    return 0;
  }

  const swNext = syncSwText(swText, fresh);
  const jsonText = JSON.stringify(fresh, null, 2) + '\n';
  let changed = [];
  let before = '';
  try {
    before = fs.readFileSync(OUT_FILE, 'utf8');
  } catch (err) {
    before = '';
  }
  if (before !== jsonText) changed.push(rel(OUT_FILE));
  if (swNext !== swText) changed.push(rel(SW_FILE) + ' 生成块');
  fs.writeFileSync(OUT_FILE, jsonText);
  if (swNext !== swText) fs.writeFileSync(SW_FILE, swNext);
  console.log((changed.length ? '✓ 已刷新 ' + changed.join(' + ') : '✓ 无变化（清单与 sw.js 生成块都是最新的）'));
  printSummary(fresh, quiet);
  return 0;
}

process.exitCode = main();
