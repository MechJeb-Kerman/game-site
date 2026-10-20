#!/usr/bin/env node
/**
 * 本机浏览器路径探测（配合 src/og.js 出「真实位图 OG 图」）
 *
 * 跑法：
 *   node tools/og-detect.mjs            # 人看的清单与结论
 *   node tools/og-detect.mjs --json     # 一行 JSON（给脚本 / CI 用）
 *   node tools/og-detect.mjs --quiet    # 只打印命中的那条路径（没有就打印空行）
 *
 * 候选表与顺序只有一处出处：src/og.js 的 browserCandidates()
 * （环境变量 CHROME_PATH / EDGE_PATH 排在最前，显式覆盖优先于候选路径）。
 * 出口码：找到 0，没找到 1——脚本里可以用它判断本机能不能出位图。
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { browserCandidates, OG_HEIGHT, OG_WIDTH, DEFAULT_TIMEOUT_MS } from '../src/og.js';

/** 候选清单（环境变量覆盖在前），带来源标注，去重保序 */
export function browserEntries(env = process.env) {
  const raw = browserCandidates(env);
  const chromep = typeof env.CHROME_PATH === 'string' ? env.CHROME_PATH.trim() : '';
  const edgep = typeof env.EDGE_PATH === 'string' ? env.EDGE_PATH.trim() : '';
  return raw.map((p) => ({
    path: p,
    source: p && p === chromep ? 'CHROME_PATH' : (p && p === edgep ? 'EDGE_PATH' : '候选'),
    exists: exists(p)
  }));
}

/** 文件在不在（任何异常都当不存在，探测本身不能把脚本搞崩） */
function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

/** 按候选顺序挑第一个存在的浏览器；没有就回空串 */
export function detectBrowser(env = process.env, isFile = exists) {
  for (const p of browserCandidates(env)) {
    if (isFile(p)) return p;
  }
  return '';
}

function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const entries = browserEntries(env);
  const found = detectBrowser(env);

  if (argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({
      ok: !!found, path: found, width: OG_WIDTH, height: OG_HEIGHT, timeoutMs: DEFAULT_TIMEOUT_MS,
      env: { CHROME_PATH: env.CHROME_PATH || '', EDGE_PATH: env.EDGE_PATH || '' },
      candidates: entries
    }));
  } else if (argv.indexOf('--quiet') >= 0) {
    console.log(found);
  } else {
    console.log('真实位图 OG 图：本机浏览器探测（目标 ' + OG_WIDTH + 'x' + OG_HEIGHT + ' PNG，单次超时 ' + DEFAULT_TIMEOUT_MS + 'ms）');
    console.log('  环境变量覆盖：CHROME_PATH=' + (env.CHROME_PATH || '（未设）') + '   EDGE_PATH=' + (env.EDGE_PATH || '（未设）'));
    console.log('  候选清单（' + entries.length + ' 条，按顺序取第一个存在的）：');
    for (const e of entries) console.log('    [' + (e.exists ? '有' : '缺') + '] ' + e.path + '   （' + e.source + '）');
    console.log('  ----------------------------------------');
    if (found) {
      console.log('  结论：找到 ' + found);
      console.log('  → src/og.js 的 createRasterizer({ driver: \'chrome\' }) 可以出位图；Express 侧不用再配环境变量。');
      console.log('  → Workers 侧出不了位图（没有本地浏览器），要配渲染端点，见 src/og.js 顶部注释。');
    } else {
      console.log('  结论：没找到 Chrome / Edge，本机出不了位图。');
      console.log('  → 可以设 CHROME_PATH 或 EDGE_PATH 指向浏览器可执行文件。');
    }
  }
  process.exit(found ? 0 : 1);
}

/* 被别的脚本 import 时不要跑 main（也不要在 import 时 exit） */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
