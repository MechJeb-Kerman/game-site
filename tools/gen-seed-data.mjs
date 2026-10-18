/**
 * 把 src/seed.js 里的 CATEGORIES / GAMES 同步到 worker/seed-data.js。
 * Worker（D1）线不能直接 import src/seed.js —— 那边没有 node:sqlite，而且需要纯数据。
 * 以前是靠手抄，容易漏；现在一条命令重生成，两边保证一致。
 *   node tools/gen-seed-data.mjs      （或 pnpm run gen:seed）
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, GAMES } from '../src/seed.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'worker', 'seed-data.js');
const NL = '\n';

const body = [
  '/** D1 版种子数据：由 src/seed.js 导出生成，两边内容必须保持一致。 */',
  '',
  'export const CATEGORIES = ' + JSON.stringify(CATEGORIES, null, 2) + ';',
  '',
  'export const GAMES = ' + JSON.stringify(GAMES, null, 2) + ';',
  ''
].join(NL);

writeFileSync(OUT, body, 'utf8');
console.log('已生成 worker/seed-data.js：' + CATEGORIES.length + ' 个分类 / ' + GAMES.length + ' 款游戏');
