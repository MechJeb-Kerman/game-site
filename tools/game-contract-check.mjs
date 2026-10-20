#!/usr/bin/env node
/**
 * 游戏页契约检查器 —— 一个 games/<slug>/index.html 只要通过这里，就满足了「能被 smoke 与 PWA 收下」的那层硬约束。
 *
 * 用法：
 *   node tools/game-contract-check.mjs             # 巡检 games/ 下全部（老游戏缺 window.GAME 只算 warning）
 *   node tools/game-contract-check.mjs breakout    # 点名检查 → 严格模式，window.GAME 缺失即 FAIL
 *
 * 检查项（每条都是踩过坑才留下的）：
 *   ① 单文件自足：除 /static/js/gamepad.js（联机款可加 /static/js/net-play.js）外不引任何外部脚本 / 样式 / 图片；
 *      页面里不出现 http(s) 字面量（xmlns 的 w3.org 命名空间与 data: 内联资源放行）。
 *   ② window.GAMEPAD 必须在引入 gamepad.js 之前设置好（手柄模式 keys / pointer / dpad）。
 *   ③ window.GAME = { slug, state(), restart() } 且 slug 与目录名一致 —— smoke 的 gameCase() 靠它断言。
 *   ④ 内联脚本语法能过 new Function()（不执行，只做语法编译），把「一改就白屏」挡在提交前。
 *   ⑤ 有 <title> 与 viewport meta（移动端不缩放、全屏可用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = path.join(ROOT, 'games');
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const STRICT = ONLY.length > 0;   /* 点名即严格：新写的游戏必须满足 window.GAME 契约 */

const ALLOWED_SCRIPTS = [
  /^\/static\/js\/gamepad\.js(\?v=\d+)?$/,
  /^\/static\/js\/net-play\.js(\?v=\d+)?$/
];
const isAllowedRef = (u) => ALLOWED_SCRIPTS.some((re) => re.test(u)) || /^data:/.test(u);

const slugs = ONLY.length
  ? ONLY
  : fs.readdirSync(GAMES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

let bad = 0, warned = 0;
for (const slug of slugs) {
  const file = path.join(GAMES, slug, 'index.html');
  const fails = [], warns = [];
  if (!fs.existsSync(file)) { console.log('FAIL ' + slug + '：文件不存在 ' + path.relative(ROOT, file)); bad++; continue; }
  const html = fs.readFileSync(file, 'utf8');

  /* ① 外部资源 */
  const externals = [];
  let m;
  const reScript = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = reScript.exec(html))) if (!isAllowedRef(m[1])) externals.push(m[1]);
  const reLink = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  while ((m = reLink.exec(html))) if (!isAllowedRef(m[1])) externals.push(m[1]);
  const reImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = reImg.exec(html))) if (!isAllowedRef(m[1])) externals.push(m[1]);
  if (externals.length) fails.push('引用了契约外的外部资源：' + JSON.stringify(externals));

  const httpHits = (html.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((u) => !/^https?:\/\/www\.w3\.org\//.test(u));
  if (httpHits.length) fails.push('出现 http(s) 字面量：' + JSON.stringify(httpHits.slice(0, 3)));

  /* ② GAMEPAD */
  const gpIdx = html.indexOf('window.GAMEPAD');
  const gpSrcIdx = html.search(/<script\b[^>]*\bsrc\s*=\s*["']\/static\/js\/gamepad\.js/);
  if (gpIdx < 0) (STRICT ? fails : warns).push('没有设置 window.GAMEPAD');
  else if (gpSrcIdx >= 0 && gpIdx > gpSrcIdx) fails.push('window.GAMEPAD 必须在引入 gamepad.js 之前设置');

  /* ③ window.GAME 契约 —— 取最后一处 `window.GAME = {`：文件头注释里常写着
     `window.GAME = { slug, state(), restart() }` 这行说明，先命中注释就会拿错位置（connect4 就踩过）。 */
  const gRe = /window\.GAME\s*=\s*\{/g;
  let gIdx = -1, gm;
  while ((gm = gRe.exec(html))) gIdx = gm.index;
  if (gIdx < 0) (STRICT ? fails : warns).push('没有定义 window.GAME = { slug, state, restart }');
  else {
    const tail = html.slice(gIdx);
    /* slug 允许三种写法：'x' / "x" / 常量名（reversi、sokoban 写的是 slug: SLUG）。常量形式回查一次定义处。 */
    const slugLit = (tail.match(/slug\s*:\s*['"]([^'"]+)['"]/) || [])[1];
    const slugId = (tail.match(/slug\s*:\s*([A-Za-z_$][\w$]*)/) || [])[1];
    if (!slugLit && !slugId) fails.push('window.GAME 缺 slug 字段');
    else if (slugLit && slugLit !== slug) fails.push('GAME.slug 是 "' + slugLit + '"，与目录名 "' + slug + '" 不一致');
    else if (!slugLit && slugId) {
      const def = new RegExp('(?:var|let|const)\\s+' + slugId.replace(/\$/g, '\\$') + '\\s*=\\s*[\'"]' + slug + '[\'"]');
      if (!def.test(html)) warns.push('slug 用的是常量 ' + slugId + '，没找到与目录名一致的字符串定义（运行时以 smoke 断言为准）');
    }
    /* state / restart 允许 function 字面量、箭头函数或具名函数引用（solitaire 写 restart: restart） */
    if (!/\bstate\s*:/.test(tail)) fails.push('window.GAME 缺 state()');
    if (!/\brestart\s*:/.test(tail)) fails.push('window.GAME 缺 restart()');
  }

  /* ④ 内联脚本语法 */
  const reInline = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let n = 0;
  while ((m = reInline.exec(html))) {
    n++;
    const code = m[1];
    if (!code.trim()) continue;
    try { new Function(code); } catch (e) { fails.push('第 ' + n + ' 段内联脚本语法错误：' + e.message); }
  }

  /* ⑤ head 基础 */
  if (!/<title>[^<]*<\/title>/i.test(html)) fails.push('缺 <title>');
  if (!/name=["']viewport["']/i.test(html)) fails.push('缺 viewport meta');

  if (fails.length) { bad++; console.log('FAIL ' + slug); fails.forEach((f) => console.log('  ✗ ' + f)); }
  else if (warns.length) { warned++; console.log('WARN ' + slug + '  (' + html.split('\n').length + ' 行)'); warns.forEach((w) => console.log('  ! ' + w)); }
  else console.log('OK   ' + slug + '  (' + html.split('\n').length + ' 行, ' + n + ' 段内联脚本)');
}

console.log('');
console.log(bad ? ('✗ ' + bad + '/' + slugs.length + ' 个游戏页不满足契约' + (warned ? '（另有 ' + warned + ' 个老页面只有 warning）' : ''))
  : ('✓ ' + slugs.length + ' 个游戏页全部满足契约' + (warned ? '（其中 ' + warned + ' 个老页面没有 window.GAME，仅 warning）' : '')));
process.exit(bad ? 1 : 0);
