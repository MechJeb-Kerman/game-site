/**
 * 投稿上传的单文件 HTML 游戏：只校验三件事——扩展名、尺寸、是不是文本 HTML。
 * Express（node:sqlite）与 Workers（D1）两条线共用这一份规则，避免两边判定不一致。
 * 注意这里不能用 Buffer：Workers 运行时没有 Buffer，统一用 TextEncoder。
 */

// 附件的校验与存储适配层在 ./attachments.js。它顶层没有任何 node: 静态导入，
// 所以 Worker 这条线（worker/data.js → src/upload.js → src/attachments.js）引用它不会被带死。
import {
  validateAttachment as checkAttachment,
  ATTACH_KINDS,
  ATTACH_EXT_LIST,
  ATTACH_MIME_LIST,
  ATTACH_MAX,
  ATTACH_MAX_LABEL
} from './attachments.js';

/** 单个 .html 文件的大小上限（字节）。D1 单个值上限约 1MB，留出余量；存 TEXT 不存 BLOB */
export const UPLOAD_MAX = 512 * 1024;

/** 给表单/报错文案用的可读上限 */
export const UPLOAD_LABEL = '512 KB';

/** 看着像一份 HTML 文档的最小证据（自包含小游戏几乎都命中其中一条） */
const HTML_HINT = /<\s*(!doctype|html|head|body|script|div|canvas|svg|style|title|meta|p|span|a|button|section|main|h1)\b/i;

/** 上传文件的托管路径前缀：/ugc/<slug>.html */
export const UGC_PREFIX = '/ugc/';

/** 判断一个 game_url 是不是指向投稿上传的文件 */
export function isUploadedUrl(url) {
  return String(url || '').indexOf(UGC_PREFIX) === 0;
}

/**
 * @param {string} filename 原始文件名（只取扩展名）
 * @param {string} html 文件正文
 * @returns {{ok:true,size:number}|{error:string}}
 */
export function validateHtmlUpload(filename, html) {
  const name = String(filename || '');
  const text = html === undefined || html === null ? '' : String(html);
  if (!/\.html?$/i.test(name)) return { error: '只能上传 .html / .htm 单文件游戏（多文件请先打包成一个自包含的 HTML）' };
  if (!text.trim()) return { error: '这个文件是空的' };
  const size = new TextEncoder().encode(text).length;
  if (size > UPLOAD_MAX) return { error: '文件 ' + Math.round(size / 1024) + ' KB，超过上限 ' + UPLOAD_LABEL };
  if (text.indexOf('\u0000') >= 0) return { error: '这个文件不是文本，请上传单文件 HTML5 游戏' };
  if (!HTML_HINT.test(text)) return { error: '文件里没有找到 HTML 标签，请确认是自包含的单文件游戏' };
  return { ok: true, size: size };
}

/* ================= 上传类型总表：游戏投稿 + 论坛附件 ================= */

/**
 * 两类上传的限制放在一处：表单文案、Express 服务端校验、Worker 都从这里取，避免三处各写一份。
 *   game       —— 单文件 HTML5 游戏，512 KB，正文是文本，走 validateHtmlUpload（看扩展名 + 有没有 HTML 标签）
 *   attachment —— 论坛附件，四档上限（图片 2 MB / 文本 256 KB / 压缩包 4 MB，绝对上限 4 MB），
 *                 走 validateAttachment（扩展名 + 声明类型 + 魔数三重校验）
 * 每条都带 validate，调用方不用记哪个扩展名归谁。
 */
export const UPLOAD_KINDS = {
  game: {
    key: 'game',
    label: '单文件 HTML 游戏',
    exts: ['.html', '.htm'],
    max: UPLOAD_MAX,
    maxLabel: UPLOAD_LABEL,
    mime: ['text/html', 'application/xhtml+xml', 'text/plain'],
    body: 'text',
    validate: validateHtmlUpload
  },
  attachment: {
    key: 'attachment',
    label: '论坛附件',
    exts: ATTACH_EXT_LIST,
    max: ATTACH_MAX,
    maxLabel: ATTACH_MAX_LABEL,
    mime: ATTACH_MIME_LIST,
    body: 'bytes',
    groups: ATTACH_KINDS,
    validate: validateAttachment
  }
};

/**
 * 论坛附件校验的薄封装：语义、返回形状全部来自 src/attachments.js（那边是唯一实现），
 * 这里只是把入口挂在 upload.js 上，让「上传」这件事只有一个 import 来源。
 *
 * @param {string} filename 原始文件名（会被清洗）
 * @param {string} [mime] 浏览器声明的类型
 * @param {Uint8Array|ArrayBuffer|string|number} bytes 内容，或只给字节数（跳过魔数检查）
 * @returns {{ok:true,size:number,kind:string,ext:string,mime:string,name:string}|{error:string}}
 */
export function validateAttachment(filename, mime, bytes) {
  return checkAttachment(filename, mime, bytes);
}
