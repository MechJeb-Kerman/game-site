#!/usr/bin/env node
/**
 * 零依赖「轻量 lint」——不做风格争论，只抓真正会咬人的四类问题：
 *
 *   1. 相对 import 指向不存在的文件（改文件名后最常见的漏改）
 *   2. 同一个模块里重复导出同名符号（拆分模板时真的踩过：BOARD_UNIT 被两份同时导出）
 *   3. BOM / 文件缺结尾换行 / 用 CRLF（跨平台 diff 噪音与 worker 解析问题）
 *   4. 残留 debugger
 *
 * 风格类问题（行尾空白、Tab 缩进、超长行）只统计、不判失败——想清就清，不阻塞 CI。
 *
 * 用法：
 *   node tools/lint.mjs           # 全量检查，有硬错误 exit 1
 *   node tools/lint.mjs --quiet   # 只打印失败项
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const TARGETS = ['server.js', 'src', 'worker', 'public/js', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-cf', '.tools', 'data', 'docs', '.wrangler']);

const problems = []; // 硬错误
const notes = []; // 提醒（不失败）
let files = 0;
let bytes = 0;
const style = { trailingWs: 0, tabs: 0, longLine: 0 };

function walk(target, out = []) {
  const abs = join(ROOT, target);
  if (!existsSync(abs)) return out;
  const st = statSync(abs);
  if (st.isFile()) {
    if (['.js', '.mjs'].includes(extname(abs))) out.push(target);
    return out;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    walk(join(target, entry.name).split('\\').join('/'), out);
  }
  return out;
}

const IMPORT_RE = /(?:^|[\s;])(?:import\s[^'"()]*?from\s*|import\s*|export\s[^'"()]*?from\s*|import\s*\()\s*['"]([^'"]+)['"]/gm;
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function resolveImport(fromFile, spec) {
  const base = resolve(ROOT, dirname(fromFile), spec);
  const candidates = [base, base + '.js', base + '.mjs', base + '.json', join(base, 'index.js'), join(base, 'index.mjs')];
  return candidates.some((p) => existsSync(p) && statSync(p).isFile());
}

/** 解析 `export * from` 不算重复；这里只查「本文件自己声明的导出名」是否重名 */
function checkFile(rel) {
  const abs = join(ROOT, rel);
  const buf = readFileSync(abs);
  files++;
  bytes += buf.length;

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push(`${rel}: 文件带 UTF-8 BOM`);
  }

  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.endsWith('\n')) problems.push(`${rel}: 文件结尾没有换行`);
  if (text.includes('\r\n')) problems.push(`${rel}: 使用了 CRLF 行尾（仓库统一 LF）`);
  if (/^\s*debugger\s*;?\s*$/m.test(text)) problems.push(`${rel}: 残留 debugger`);

  for (const [i, line] of text.split('\n').entries()) {
    if (/[ \t]+$/.test(line)) style.trailingWs++;
    if (/^\t/.test(line)) style.tabs++;
    if (line.length > 160) style.longLine++;
    if (line.trim().length > 3 && line.length > 300) notes.push(`${rel}:${i + 1} 超长行 ${line.length} 字符`);
  }

  // 1) 相对 import 是否存在
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    if (!resolveImport(rel, spec)) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${rel}:${line} import '${spec}' 指向的文件不存在`);
    }
  }

  // 2) 重复导出
  const seen = new Map();
  for (const m of text.matchAll(EXPORT_RE)) {
    const name = m[1];
    const line = text.slice(0, m.index).split('\n').length;
    if (seen.has(name)) {
      problems.push(`${rel}:${line} 重复导出 '${name}'（首次在 ${seen.get(name)} 行）`);
    } else {
      seen.set(name, line);
    }
  }
}

const list = [];
for (const target of TARGETS) walk(target, list);
const unique = [...new Set(list)];
for (const rel of unique) checkFile(rel);

if (!QUIET) {
  console.log(`扫描 ${unique.length} 个 JS/MJS 文件 · ${(bytes / 1024).toFixed(1)} KB`);
  console.log(
    `风格统计（不判失败）：行尾空白 ${style.trailingWs} 处 · Tab 缩进 ${style.tabs} 行 · 超长行(>160) ${style.longLine} 行`,
  );
  if (notes.length) {
    console.log(`超长行 >300 字符：${notes.length} 处`);
    for (const n of notes.slice(0, 5)) console.log('  · ' + n);
    if (notes.length > 5) console.log(`  · …还有 ${notes.length - 5} 处`);
  }
}

if (problems.length) {
  console.log(`\n✗ 硬错误 ${problems.length} 项：`);
  for (const p of problems) console.log('  · ' + p);
  process.exit(1);
}

console.log('\n✓ lint 通过：import 路径可解析、无重复导出、无 BOM / CRLF / debugger、文件均以换行结尾');
