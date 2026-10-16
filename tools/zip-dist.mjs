#!/usr/bin/env node
/* 把一个静态导出目录打成 zip（默认 dist-cf -> cloudflare-pages.zip）。
 *
 * 为什么不用 Compress-Archive / .NET CreateFromDirectory：在 Windows 上它们写出来的
 * 条目名用反斜杠（games\tetris\index.html 这种），Cloudflare Pages 拖拽上传会解出
 * 一堆带反斜杠的文件名。这里手工写 zip，条目名一律用 /，并且始终置上 UTF-8 名字标志
 * （标签页里有中文文件名，比如 tag/益智.html）。
 *
 * 用法：node tools/zip-dist.mjs [--dir=dist-cf] [--out=cloudflare-pages.zip]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args[m[1]] = m[2];
}
const dir = path.resolve(ROOT, args.dir || "dist-cf");
const out = path.resolve(ROOT, args.out || "cloudflare-pages.zip");
if (!fs.existsSync(dir)) { console.error("找不到目录：" + dir + "（先跑 node tools/build-pages.mjs --cf）"); process.exit(1); }

/* ---------- CRC32 ---------- */
const TABLE = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/* ---------- 收集文件（条目名一律用 /，不出现反斜杠） ---------- */
const entries = [];
(function walk(abs, rel) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childAbs = path.join(abs, e.name);
    const childRel = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(childAbs, childRel);
    else if (e.isFile()) entries.push({ rel: childRel, abs: childAbs });
  }
})(dir, "");

/* ---------- 写 zip ---------- */
const locals = [];
const centrals = [];
let offset = 0;
let raw = 0, packed = 0;
for (const ent of entries) {
  const data = fs.readFileSync(ent.abs);
  const body = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(ent.rel, "utf8");
  const t = dosTime(fs.statSync(ent.abs).mtime);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);        /* UTF-8 名字 */
  local.writeUInt16LE(8, 8);             /* deflate */
  local.writeUInt16LE(t.time, 10);
  local.writeUInt16LE(t.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  locals.push(local, body);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014B50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(t.time, 12);
  central.writeUInt16LE(t.date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  nameBuf.copy(central, 46);
  centrals.push(central);
  offset += local.length + body.length;
  raw += data.length;
  packed += body.length;
}
const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054B50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);
const zip = Buffer.concat([...locals, cdBuf, eocd]);
fs.writeFileSync(out, zip);

const nonAscii = entries.filter((e) => /[^\x00-\x7F]/.test(e.rel)).length;
console.log("已打包：" + path.relative(ROOT, out));
console.log("  文件 " + entries.length + " 个（其中非 ASCII 名字 " + nonAscii + " 个）");
console.log("  原始 " + (raw / 1024).toFixed(1) + " KB → 压缩后 " + (packed / 1024).toFixed(1) + " KB → zip " + (zip.length / 1024).toFixed(1) + " KB");
console.log("  条目名分隔符：/（无反斜杠）");
