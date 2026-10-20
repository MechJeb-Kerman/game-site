#!/usr/bin/env node
/**
 * 把 public/sw.js 同步进 worker/app.js 的内联常量 PWA_SW。
 *
 * Workers 没有磁盘，public/ 下的 Service Worker 只能在 worker/app.js 里内联一份；
 * 两份必须逐字节一致（tools/pwa-test.mjs 会校验），所以改完 public/sw.js 就跑一次这里。
 *
 * 行尾：Windows 上 core.autocrlf=true 时工作树里 worker/app.js 是 CRLF、public/sw.js 常是 LF，
 * 逐字节比会假报不一致（内容其实一样），所以比对前把两边都归一化成 LF，写入也用 LF。
 *
 * 用法：
 *   node tools/gen-sw.mjs          写入（内容没变就什么都不做）
 *   node tools/gen-sw.mjs --check  只比对，不一致时退出码 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SW = path.join(ROOT, "public", "sw.js");
const WORKER = path.join(ROOT, "worker", "app.js");
const CHECK = process.argv.includes("--check");
const BT = String.fromCharCode(96);

/* 模板字符串里需要转义的只有反斜杠、反引号与插值开头 */
function escapeTpl(s) {
  return s.replace(/\\/g, "\\\\").replace(new RegExp(BT, "g"), "\\" + BT).replace(/\$\{/g, "\\${");
}
function unescapeTpl(s) {
  return s.replace(/\\\$\{/g, "${").replace(new RegExp("\\\\" + BT, "g"), BT).replace(/\\\\/g, "\\");
}

/* 工作树行尾（autocrlf）与结尾空行都可能与内联副本不同，比对前统一归一化：CRLF → LF + 去掉结尾空白 */
const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const sw = norm(fs.readFileSync(SW, "utf8"));
const want = escapeTpl(sw);
const src = fs.readFileSync(WORKER, "utf8");
const startMark = "const PWA_SW = " + BT;
const i = src.indexOf(startMark);
if (i < 0) { console.error("worker/app.js 里找不到 PWA_SW 内联常量"); process.exit(2); }
const bodyStart = i + startMark.length;
const end = src.indexOf("\n" + BT + ";", bodyStart);
if (end < 0) { console.error("PWA_SW 结束标记（换行 + 反引号分号）找不到"); process.exit(2); }
const current = src.slice(bodyStart, end);
const same = norm(unescapeTpl(current)) === sw;
if (CHECK) {
  if (same) { console.log("PWA_SW 与 public/sw.js 一致（" + sw.length + " 字节）"); process.exit(0); }
  console.error("PWA_SW 与 public/sw.js 不一致：跑 node tools/gen-sw.mjs 同步");
  process.exit(1);
}
if (same) { console.log("PWA_SW 已是最新（public/sw.js " + sw.length + " 字节）"); process.exit(0); }
fs.writeFileSync(WORKER, src.slice(0, bodyStart) + want + src.slice(end));
console.log("PWA_SW 已同步：" + current.length + " -> " + want.length + " 字节");
