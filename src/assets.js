/**
 * 建置期压缩产物（public 下的 *.min.*）的清单与就位探测。
 *
 * 清单只放这里：tools/minify.mjs 照单生成，server.js 与 tools/build-pages.mjs 照单探测。
 * 缺任何一份就整体回退到源文件 —— 半套 .min 只会让页面拿到 404，不如不切。
 *
 * 本模块读磁盘（node:fs），只给 Node 线用；Workers 线不 import 它，动态版继续引用源文件
 * （dist 里源文件与产物都会导出，两边都能工作）。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 要压缩的源文件（相对 public/）—— 只收页面真的会引用的那些；
 * offline-queue.js 故意不在列：它由 offline-wire.js 在断网时按需加载，链路更长，先不动。 */
export const MIN_SOURCES = [
  'css/style.css',
  'js/app.js',
  'js/app-static.js',
  'js/offline-wire.js',
  'js/gamepad.js',
  'js/net-play.js'
];

/** 源文件相对路径 → 产物相对路径（css/style.css → css/style.min.css） */
export function minOutRel(rel) {
  return rel.replace(/\.(css|js)$/, '.min.$1');
}

/** 产物是否齐备：缺一个就返回 false，调用方据此整体回退到源文件 */
export function minAssetsReady(publicDir) {
  return MIN_SOURCES.every((rel) => fs.existsSync(path.join(publicDir, minOutRel(rel))));
}

/* 页面里的源文件引用 → 产物引用。主站页面走 src/views/core.js 的 asset()，
 * 但 games/ 下是自包含的静态 HTML（直接写 /static/js/gamepad.js），碰不到模板，
 * 由 server.js 在响应前、tools/build-pages.mjs 在导出前调用本函数替换。
 * 只认「根路径 + MIN_SOURCES 里列出的文件」，查询串（?v=1）原样保留。 */
const MIN_URLS = new Set(MIN_SOURCES.map((rel) => '/static/' + rel));

export function swapMinRefs(html) {
  return html.replace(/(\b(?:src|href)\s*=\s*)(["'])([^"']*)\2/g, (whole, pre, quote, url) => {
    const cut = url.search(/[?#]/);
    const pathPart = cut < 0 ? url : url.slice(0, cut);
    if (!MIN_URLS.has(pathPart)) return whole;
    const tail = cut < 0 ? '' : url.slice(cut);
    return pre + quote + '/static/' + minOutRel(pathPart.slice('/static/'.length)) + tail + quote;
  });
}
