/**
 * 本地预览 dist 静态站点，模拟 GitHub Pages 的子路径部署。
 *
 *   node tools/serve-dist.mjs --base=/仓库名/ --port=4173
 *
 * 目录自动补 index.html；找不到的文件返回 dist/404.html（HTTP 404）。
 * 也可以被别的脚本 import：normalizeBase / createStaticHandler / startStatic。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

/** "/仓库名"、"/仓库名/"、"//" 之类都归一成 "/仓库名/" 或 "/" */
export function normalizeBase(raw) {
  const segs = String(raw == null ? "/" : raw).split("/").filter(Boolean);
  return "/" + segs.join("/") + (segs.length ? "/" : "");
}

export function createStaticHandler(opts) {
  const out = path.resolve(opts.out);
  const base = normalizeBase(opts.base);
  return function (req, res) {
    const url = String(req.url || "/");
    const qi = url.indexOf("?");
    const pathname = qi < 0 ? url : url.slice(0, qi);
    let p;
    try { p = decodeURIComponent(pathname); } catch (e) { p = pathname; }

    function send(code, file) {
      res.writeHead(code, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(file));
    }
    function notFound() {
      const nf = path.join(out, "404.html");
      if (fs.existsSync(nf)) send(404, nf);
      else { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404"); }
    }

    const bare = base.slice(0, -1);
    if (p !== bare && !p.startsWith(base)) return notFound();
    let rel = p.slice(base.length);
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(out, rel);
    if (file.startsWith(out) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, file);
    notFound();
  };
}

export function startStatic(opts) {
  const server = http.createServer(createStaticHandler(opts));
  return new Promise(function (done) {
    server.listen(opts.port || 4173, "127.0.0.1", function () { done(server); });
  });
}

function opt(argv, name, fallback) {
  const hit = argv.find(function (a) { return a === "--" + name || a.startsWith("--" + name + "="); });
  if (!hit) return fallback;
  const i = hit.indexOf("=");
  return i < 0 ? "" : hit.slice(i + 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = normalizeBase(opt(process.argv, "base", "/"));
  const out = path.resolve(opt(process.argv, "out", path.join(ROOT, "dist")));
  const port = Number(opt(process.argv, "port", "4173"));
  if (!fs.existsSync(path.join(out, "index.html"))) {
    console.error("没找到 " + path.join(out, "index.html") + "，先跑：node tools/build-pages.mjs --base=" + base);
    process.exit(1);
  }
  startStatic({ out: out, base: base, port: port }).then(function () {
    console.log("静态预览已启动：http://127.0.0.1:" + port + base);
    console.log("目录 " + out + "   base " + base + "   （Ctrl+C 结束）");
  });
}
