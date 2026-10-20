#!/usr/bin/env node
/**
 * 封面自测：20 张静态 SVG（public/covers/）+ 清单一致性 + src/covers.js 的导出面 + 生成器 --check 的两种出口码。
 *
 * 跑法：
 *   node tools/cover-test.mjs            跑全部断言；失败数 0 → exit 0，否则 exit 1
 *   node tools/cover-test.mjs --keep     留下临时树（默认跑完删掉），排查用
 *
 * 边界：
 *   · 只读真仓库的 public/covers/ 与 src/covers.js，不写盘；
 *   · 生成器 / --check 的全部写盘与漂移用例都在 os.tmpdir() 的临时根里跑（COVERS_ROOT 换根，见 gen-covers.mjs 头注释），
 *     临时根里自带 src/covers.js 副本与 20 个 games/<slug>/ 空目录；
 *   · XML 解析优先用 .NET XmlDocument（C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe，
 *     本机 pwsh 不在 PATH 上），拿不到 PowerShell 时退到内置的良构性检查器并在报告里注明用的哪一种；
 *   · 不新增任何依赖：只用 node 内置模块。
 *
 * 覆盖的验收点：20 个 slug 齐全（以 games/ 目录为准）· 逐个能被 XML 解析 · 无文字 / 字体 / 外链 / 位图 ·
 *   单文件 < 12 KB · 20 个主色两两可辨（CIE76 ΔE ≥ 20）· manifest 与磁盘一致（字节 + sha256 指纹）·
 *   --check 一致 exit 0、缺文件 / 多余文件 / 内容漂移 exit 1 · 重跑幂等（字节不变）· coverFor 未知 slug 回 null。
 *
 * 出口码：0 全部通过；1 有失败断言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'public', 'covers');
const GEN = path.join(HERE, 'gen-covers.mjs');
const GAMES_DIR = path.join(ROOT, 'games');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const MAX_BYTES = 12 * 1024;
const MIN_DELTA_E = 20;
const KEEP = process.argv.includes('--keep');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
  return !!cond;
}
function skipCase(name, why) { skip++; console.log('  SKIP ' + name + '  ' + why); }
function section(t) { console.log('\n' + t); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

/* ------------------------------ XML ------------------------------ */

/* 首选 .NET XmlDocument：真解析器，能抓出良构性问题。整批一次调用。 */
function xmlParseViaDotNet(files) {
  if (!fs.existsSync(PS)) return null;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$bad = New-Object System.Collections.ArrayList",
    "Get-ChildItem -LiteralPath '" + OUT_DIR + "' -Filter *.svg | Sort-Object Name | ForEach-Object {",
    "  try { $d = New-Object System.Xml.XmlDocument; $d.Load($_.FullName) } catch { [void]$bad.Add($_.Name + ': ' + $_.Exception.Message) }",
    "}",
    "if ($bad.Count -eq 0) { Write-Output 'XML_OK' } else { Write-Output ('XML_BAD ' + ($bad -join ' || ')) }"
  ].join('; ');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  if (out === 'XML_OK') return { parser: '.NET XmlDocument', problems: [] };
  return { parser: '.NET XmlDocument', problems: out.replace(/^XML_BAD\s*/, '').split(' || ') };
}

/* 退路：内置良构性检查器（标签配对 / 属性引号 / 转义 / 单根）。 */
function xmlWellFormed(src) {
  const problems = [];
  const stack = [];
  let i = 0, roots = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (src.slice(i).indexOf('>') !== -1) problems.push('游离的 >');
      break;
    }
    const between = src.slice(i, lt);
    if (between.indexOf('>') !== -1) problems.push('标签外的 >');
    if ((between.match(/&/g) || []).length !== (between.match(/&(?:[a-zA-Z][\w.-]*|#[0-9]+|#x[0-9a-fA-F]+);/g) || []).length) {
      problems.push('未转义的 &');
    }
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e === -1) { problems.push('注释未闭合'); break; } i = e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); if (e === -1) { problems.push('处理指令未闭合'); break; } i = e + 2; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); if (e === -1) { problems.push('CDATA 未闭合'); break; } i = e + 3; continue; }
    const gt = src.indexOf('>', lt);
    if (gt === -1) { problems.push('标签没有 >'); break; }
    const raw = src.slice(lt + 1, gt);
    const m = /^(\/?)([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(raw);
    if (!m) { problems.push('标签名非法：<' + raw.slice(0, 30) + '>'); break; }
    const closing = m[1] === '/', name = m[2];
    let rest = m[3], selfClose = false;
    if (/\/\s*$/.test(rest)) { selfClose = true; rest = rest.replace(/\/\s*$/, ''); }
    const attrRe = /\s+([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let consumed = '', am;
    while ((am = attrRe.exec(rest)) !== null) consumed += am[0];
    if (consumed.replace(/\s+/g, '') !== rest.replace(/\s+/g, '')) problems.push('属性写法可疑：<' + raw.slice(0, 40) + '>');
    if (closing) {
      const top = stack.pop();
      if (top !== name) problems.push('闭合不匹配：</' + name + '> 对 ' + top);
    } else if (!selfClose) {
      stack.push(name);
      if (stack.length === 1) roots++;
    }
    i = gt + 1;
  }
  if (stack.length) problems.push('未闭合：' + stack.join(' '));
  if (roots !== 1) problems.push('根元素个数 = ' + roots);
  return problems;
}

function xmlProblems(files) {
  const dotnet = xmlParseViaDotNet(files);
  if (dotnet) return dotnet;
  const problems = [];
  for (let i = 0; i < files.length; i++) {
    const p = files[i];
    const pr = xmlWellFormed(fs.readFileSync(p, 'utf8'));
    for (let k = 0; k < pr.length; k++) problems.push(path.basename(p) + ': ' + pr[k]);
  }
  return { parser: '内置良构性检查器（没有 PowerShell）', problems: problems };
}

/* ------------------------------ 颜色 ------------------------------ */

function hexRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function srgbToLab(hex) {
  const c = hexRgb(hex).map(function (v) {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const X = (c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047;
  const Y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  const Z = (c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883;
  const f = function (t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; };
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a, b) {
  const A = srgbToLab(a), B = srgbToLab(b);
  return Math.sqrt(Math.pow(A[0] - B[0], 2) + Math.pow(A[1] - B[1], 2) + Math.pow(A[2] - B[2], 2));
}

/* ------------------------------ 子进程 ------------------------------ */

function runGen(args, cwd, env) {
  const r = spawnSync(process.execPath, [GEN].concat(args), {
    cwd: cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }, env || {}),
    timeout: 180000
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function listing(dir) {
  const out = {};
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (let i = 0; i < names.length; i++) {
    const p = path.join(dir, names[i]);
    if (!fs.statSync(p).isFile()) continue;
    const buf = fs.readFileSync(p);
    out[names[i]] = { bytes: buf.length, sha: sha256(buf) };
  }
  return out;
}

/* ============================== 开始 ============================== */

console.log('封面自测：' + rel(OUT_DIR) + ' + ' + rel(path.join(ROOT, 'src', 'covers.js')) + ' + ' + rel(GEN));

const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'covers.js')).href);
const COVERS = mod.COVERS;
const coverFor = mod.coverFor;
const slugs = Object.keys(COVERS || {}).sort();

const gameDirs = fs.existsSync(GAMES_DIR)
  ? fs.readdirSync(GAMES_DIR, { withFileTypes: true }).filter(function (d) { return d.isDirectory(); }).map(function (d) { return d.name; }).sort()
  : [];

let manifest = null;
let manifestRaw = '';
try { manifestRaw = fs.readFileSync(MANIFEST, 'utf8'); manifest = JSON.parse(manifestRaw); } catch (e) { manifest = null; }

section('1) slug 齐不齐（以 games/ 目录为准）');
ok('games/ 下正好 20 个目录', gameDirs.length === 20, gameDirs.length + ' 个');
ok('COVERS 的 key 与 games/ 目录一一对应', gameDirs.length > 0 && slugs.join(' ') === gameDirs.join(' '),
  gameDirs.length === 0 ? '（games/ 不存在，跳过比对）' : 'covers.js ' + slugs.length + ' 个');
const missingCovers = slugs.filter(function (s) { return !COVERS[s] || typeof COVERS[s] !== 'object'; });
ok('每个 slug 都有覆盖条目', missingCovers.length === 0, missingCovers.length ? missingCovers.join(' ') : '');
const badPalette = slugs.filter(function (s) {
  const e = COVERS[s];
  return !Array.isArray(e.palette) || e.palette.length < 2 ||
    e.palette.some(function (c) { return !/^#[0-9a-f]{6}$/.test(String(c)); }) ||
    typeof e.alt !== 'string' || e.alt.length === 0 || /[<>&]/.test(e.alt) ||
    e.src !== '/covers/' + s + '.svg';
});
ok('每条都有 src=/covers/<slug>.svg、非空 alt、合法 palette', badPalette.length === 0, badPalette.join(' '));
ok('COVERS / 每条 / palette 都是冻结的（防两线写坏）',
  Object.isFrozen(COVERS) && slugs.every(function (s) {
    return Object.isFrozen(COVERS[s]) && Object.isFrozen(COVERS[s].palette);
  }));

section('2) 产物文件：在、够小、纯 ASCII、能被 XML 解析');
const files = slugs.map(function (s) { return path.join(OUT_DIR, s + '.svg'); });
const onDisk = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).sort() : [];
const missingFiles = files.filter(function (p) { return !fs.existsSync(p); });
ok('20 个 <slug>.svg 都在盘上', missingFiles.length === 0, missingFiles.map(function (p) { return path.basename(p); }).join(' '));
ok('目录里没有清单外的杂物', onDisk.length === 21 && onDisk.indexOf('manifest.json') !== -1,
  onDisk.filter(function (f) { return f !== 'manifest.json' && slugs.indexOf(f.replace(/\.svg$/, '')) === -1; }).join(' ') || onDisk.length + ' 个文件');

const sizes = {};
const overCap = [], nonAscii = [];
if (missingFiles.length === 0) {
  for (let i = 0; i < files.length; i++) {
    const buf = fs.readFileSync(files[i]);
    const slug = slugs[i];
    sizes[slug] = buf.length;
    if (buf.length >= MAX_BYTES) overCap.push(slug + '(' + kb(buf.length) + ')');
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(buf.toString('utf8'))) nonAscii.push(slug);
  }
}
ok('每张都 < ' + kb(MAX_BYTES) + '（实测最大 ' + kb(Math.max.apply(null, slugs.map(function (s) { return sizes[s] || 0; }))) + '）',
  missingFiles.length === 0 && overCap.length === 0, overCap.join(' '));
ok('产物是纯 ASCII（不夹带任何非 ASCII 字节）', nonAscii.length === 0, nonAscii.join(' '));

const FORBIDDEN = [
  [/<\s*text[\s/>]/i, '有 <text> 文字元素'],
  [/<\s*tspan[\s/>]/i, '有 <tspan>'],
  [/<\s*textPath[\s/>]/i, '有 <textPath>'],
  [/<\s*style[\s/>]/i, '有 <style>'],
  [/<\s*image[\s/>]/i, '有 <image> 位图'],
  [/<\s*script[\s/>]/i, '有 <script>'],
  [/<\s*foreignObject[\s/>]/i, '有 <foreignObject>'],
  [/font/i, '提到 font'],
  [/xlink:/i, '有 xlink: 引用'],
  [/\shref\s*=/i, '有 href= 外链'],
  [/\ssrc\s*=/i, '有 src= 外链'],
  [/@import/i, '有 @import'],
  [/url\(\s*['"]?(?:https?:|data:|\/\/)/i, '有 url(...) 外链或内嵌数据'],
  [/<!DOCTYPE/i, '有 DOCTYPE'],
  [/<\?xml-stylesheet/i, '有 xml-stylesheet']
];
const hits = [];
if (missingFiles.length === 0) {
  for (let i = 0; i < files.length; i++) {
    const src = fs.readFileSync(files[i], 'utf8');
    for (let k = 0; k < FORBIDDEN.length; k++) {
      if (FORBIDDEN[k][0].test(src)) hits.push(path.basename(files[i]) + '：' + FORBIDDEN[k][1]);
    }
  }
}
ok('没有文字 / 字体 / 外链 / 位图 / 样式表 / 脚本（' + FORBIDDEN.length + ' 条禁则）', hits.length === 0, hits.slice(0, 5).join('；'));
ok('都有 viewBox="0 0 1200 675" 与 1200×675 尺寸（缩放不失真）', missingFiles.length === 0 && files.every(function (p) {
  const src = fs.readFileSync(p, 'utf8');
  return src.indexOf('viewBox="0 0 1200 675"') !== -1 && /width="1200"/.test(src) && /height="675"/.test(src);
}));

if (missingFiles.length === 0) {
  const xr = xmlProblems(files);
  ok('20 个文件都能被 XML 解析（' + xr.parser + '）', xr.problems.length === 0, xr.problems.slice(0, 3).join('；'));
} else {
  skipCase('XML 解析', '有文件缺失，先补文件');
}

section('3) 配色：格式合法、主色两两可辨');
let tightest = { a: '', b: '', d: Infinity };
for (let i = 0; i < slugs.length; i++) {
  for (let k = i + 1; k < slugs.length; k++) {
    const d = deltaE(COVERS[slugs[i]].palette[0], COVERS[slugs[k]].palette[0]);
    if (d < tightest.d) tightest = { a: slugs[i], b: slugs[k], d: d };
  }
}
const primaries = slugs.map(function (s) { return COVERS[s].palette[0].toLowerCase(); });
ok('20 个主色互不相同（十六进制层面）', new Set(primaries).size === primaries.length,
  new Set(primaries).size + '/' + primaries.length);
ok('20 个主色两两可辨（CIE76 ΔE ≥ ' + MIN_DELTA_E + '）', tightest.d >= MIN_DELTA_E,
  '最接近的一对 ' + tightest.a + ' ↔ ' + tightest.b + ' ΔE=' + tightest.d.toFixed(1));

section('4) manifest 与磁盘 / covers.js 一致');
ok('manifest.json 在且是合法 JSON', !!manifest, manifest ? 'count=' + manifest.count : '缺文件或解析失败');
if (manifest) {
  ok('generator / 尺寸 / 数量对得上',
    manifest.generator === 'tools/gen-covers.mjs' && manifest.width === 1200 && manifest.height === 675 && manifest.count === slugs.length,
    manifest.generator + ' ' + manifest.width + '×' + manifest.height + ' count=' + manifest.count);
  ok('generatedAt 是 ISO 时间戳', typeof manifest.generatedAt === 'string' && !isNaN(Date.parse(manifest.generatedAt)), String(manifest.generatedAt));
  const mk = Object.keys(manifest.covers || {}).sort();
  ok('manifest 的 slug 集合与 COVERS 一致', mk.join(' ') === slugs.join(' '), mk.length + ' 条');
  const mism = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i], e = (manifest.covers || {})[slug], src = COVERS[slug];
    if (!e) { mism.push(slug + '：清单缺条目'); continue; }
    const buf = fs.existsSync(path.join(OUT_DIR, slug + '.svg')) ? fs.readFileSync(path.join(OUT_DIR, slug + '.svg')) : null;
    if (!buf) { mism.push(slug + '：盘上没文件'); continue; }
    if (e.file !== slug + '.svg') mism.push(slug + '：file');
    if (e.src !== src.src) mism.push(slug + '：src');
    if (e.bytes !== buf.length) mism.push(slug + '：bytes ' + e.bytes + '≠' + buf.length);
    if (e.fingerprint !== sha256(buf).slice(0, 16)) mism.push(slug + '：指纹');
    if (e.primary !== src.palette[0]) mism.push(slug + '：primary');
    if (JSON.stringify(e.palette) !== JSON.stringify(src.palette)) mism.push(slug + '：palette');
    if (e.alt !== src.alt) mism.push(slug + '：alt');
  }
  ok('每条的 file/src/bytes/指纹/主色/配色/alt 都与磁盘和 covers.js 对得上', mism.length === 0, mism.slice(0, 4).join('；'));
}

section('5) coverFor()：未知 slug 回 null、不抛');
ok('20 个已知 slug 都能取到对象', slugs.every(function (s) {
  const g = coverFor(s);
  return g && g.src === '/covers/' + s + '.svg' && Array.isArray(g.palette);
}));
const weird = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'not-a-game', '2048 ', ' 2048', '2048.svg', 'CHESS', ''];
const badWeird = weird.filter(function (w) { return coverFor(w) !== null; });
ok('未知 slug 回 null（含原型链上的名字）', badWeird.length === 0, badWeird.join(' '));
let threw = null, nonString = [null, undefined, 0, 42, true, {}, [], function () {}, Symbol('x')];
for (let i = 0; i < nonString.length; i++) {
  try { if (coverFor(nonString[i]) !== null) threw = String(nonString[i]); } catch (e) { threw = 'throw: ' + e.message; }
}
ok('非字符串入参回 null、不抛异常', threw === null, threw || '');

section('6) 生成器：临时根里重跑幂等 + --check 两种出口码');
let tmpRoot = null;
try {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'covers.js'), path.join(tmpRoot, 'src', 'covers.js'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'cover-test-tmp', private: true, type: 'module' }, null, 2) + '\n');
  for (let i = 0; i < slugs.length; i++) fs.mkdirSync(path.join(tmpRoot, 'games', slugs[i]), { recursive: true });
  const env = { COVERS_ROOT: tmpRoot };
  const tmpCovers = path.join(tmpRoot, 'public', 'covers');

  const g1 = runGen([], ROOT, env);
  ok('生成器首跑 exit 0', g1.code === 0, 'exit=' + g1.code + (g1.err ? ' ' + g1.err.split('\n')[0] : ''));
  const list1 = listing(tmpCovers);
  const c1 = runGen(['--check'], ROOT, env);
  const c2 = runGen(['--check'], ROOT, env);
  ok('首跑后 --check exit 0（连跑两遍）', c1.code === 0 && c2.code === 0, 'exit1=' + c1.code + ' exit2=' + c2.code);

  const g2 = runGen([], ROOT, env);
  const list2 = listing(tmpCovers);
  ok('重跑幂等：写盘结果逐字节不变', g2.code === 0 && JSON.stringify(list1) === JSON.stringify(list2),
    Object.keys(list2).length + ' 个文件');
  ok('重跑报告「写入 0 个」', /写入 0 个/.test(g2.out), (g2.out.match(/\d+ 张：写入[^\n]*/) || [''])[0]);

  const tmpManifest = JSON.parse(fs.readFileSync(path.join(tmpCovers, 'manifest.json'), 'utf8'));
  const sameFp = slugs.every(function (s) {
    return manifest && manifest.covers && manifest.covers[s] && tmpManifest.covers[s] &&
      manifest.covers[s].fingerprint === tmpManifest.covers[s].fingerprint;
  });
  ok('换根生成的内容指纹与真仓库清单一致（生成与路径无关）', sameFp);

  fs.unlinkSync(path.join(tmpCovers, slugs[0] + '.svg'));
  const c3 = runGen(['--check'], ROOT, env);
  ok('缺文件时 --check exit 1', c3.code === 1, 'exit=' + c3.code + ' ' + (c3.out.split('\n').filter(function (l) { return /x /.test(l); })[0] || ''));
  runGen([], ROOT, env);

  fs.writeFileSync(path.join(tmpCovers, 'stray.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const c4 = runGen(['--check'], ROOT, env);
  ok('多余文件时 --check exit 1', c4.code === 1, 'exit=' + c4.code + ' ' + (c4.out.split('\n').filter(function (l) { return /x /.test(l); })[0] || ''));
  fs.unlinkSync(path.join(tmpCovers, 'stray.svg'));

  const victim = path.join(tmpCovers, slugs[1] + '.svg');
  const tampered = fs.readFileSync(victim, 'utf8').replace('</svg>', '<rect x="1" y="1" width="2" height="2" fill="#fff"/></svg>');
  fs.writeFileSync(victim, tampered);
  const c5 = runGen(['--check'], ROOT, env);
  ok('内容漂移时 --check exit 1', c5.code === 1, 'exit=' + c5.code + ' ' + (c5.out.split('\n').filter(function (l) { return /x /.test(l); })[0] || ''));
  runGen([], ROOT, env);
  const c6 = runGen(['--check'], ROOT, env);
  ok('重新生成后 --check 又回 exit 0', c6.code === 0, 'exit=' + c6.code);

  const gamesExtra = path.join(tmpRoot, 'games', 'not-a-game');
  fs.mkdirSync(gamesExtra, { recursive: true });
  const gx = runGen([], ROOT, env);
  ok('games/ 多一个目录时生成器 exit 2（结构错，不硬写）', gx.code === 2, 'exit=' + gx.code);
  fs.rmdirSync(gamesExtra);
} finally {
  if (tmpRoot && !KEEP) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.log('  （临时树没删掉：' + tmpRoot + '）'); }
  } else if (tmpRoot) {
    console.log('  临时树留着：' + tmpRoot);
  }
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skip);
process.exitCode = fail === 0 ? 0 : 1;
