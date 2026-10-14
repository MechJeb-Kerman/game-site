/**
 * 把 Express + SQLite 的站点预渲染成纯静态文件，用于 GitHub Pages / 任意静态托管。
 *
 * 用法：
 *   node tools/build-pages.mjs --base=/仓库名/ --origin=https://用户名.github.io/仓库名
 *
 * 参数：
 *   --base    部署子路径。用户/组织站点或自定义域名用 /（默认），仓库站点用 /仓库名/
 *   --origin  站点绝对地址（canonical、og:url、JSON-LD 用）。不传就用占位域名
 *   --out     输出目录，默认项目根下的 dist
 *   --cf      额外输出 Cloudflare Pages 的 _headers（安全头 + 缓存策略）
 *
 * 输出：首页、列表、搜索、分类、标签、每个游戏详情、404、封面 SVG、游戏本体副本、
 *       robots.txt、sitemap.xml、.nojekyll、data/games.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, GAMES_DIR, PUBLIC_DIR, migrate } from "../src/db.js";
import { seed } from "../src/seed.js";
import { coverSvg, ogSvg } from "../src/cover.js";
import * as data from "../src/data.js";
import * as ui from "../src/views.js";

const NL = String.fromCharCode(10);
const Q = String.fromCharCode(34);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const hit = argv.find(function (a) { return a === "--" + name || a.startsWith("--" + name + "="); });
  if (!hit) return fallback;
  const i = hit.indexOf("=");
  return i < 0 ? "" : hit.slice(i + 1);
}
const segs = String(opt("base", "/")).split("/").filter(Boolean);
const base = "/" + segs.join("/") + (segs.length ? "/" : "");
const baseNoSlash = base.length > 1 ? base.slice(0, -1) : "";
let origin = String(opt("origin", "https://YOUR-USER.github.io" + baseNoSlash));
while (origin.length > 1 && origin.endsWith("/")) origin = origin.slice(0, -1);
const PLACEHOLDER = origin.indexOf("YOUR-USER") >= 0;
const OUT = path.resolve(opt("out", path.join(ROOT, "dist")));
const CF_MODE = argv.indexOf("--cf") >= 0;

/* ---------- URL 重写：/game/x -> /base/game/x.html 之类 ---------- */
// mapRel(p)：p 以 / 开头、不含 base 前缀，返回重写后的路径（仍以 / 开头）
function mapRel(p) {
  const qi = p.indexOf("?");
  const q = qi < 0 ? "" : p.slice(qi);
  const only = qi < 0 ? p : p.slice(0, qi);
  const seg = only.split("/").filter(Boolean);
  let out;
  if (!seg.length) out = "/";
  else if (seg.length === 1 && seg[0] === "games") out = "/games.html";
  else if (seg.length === 1 && seg[0] === "search") out = "/search.html";
  else if (seg.length === 1 && seg[0] === "404") out = "/404.html";
  else if (seg.length === 2 && (seg[0] === "category" || seg[0] === "tag" || seg[0] === "game")) out = "/" + seg[0] + "/" + seg[1] + ".html";
  else out = "/" + seg.join("/");
  return out + q;
}
// mapPath(p)：页面里的根绝对链接，补上部署子路径
function mapPath(p) {
  const rel = mapRel(p);
  return rel === "/" ? base : base + rel.slice(1);
}

const ATTR = /(href|src|action)="([^"]*)"/g;
function isEndChar(ch) {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  return c <= 32 || c === 34 || c === 39 || c === 60 || c === 62;
}
function staticize(html) {
  let out = html.replace(ATTR, function (m, attr, url) {
    if (url.charAt(0) !== "/") return m;
    return attr + "=" + Q + mapPath(url) + Q;
  });
  // canonical / og:url / JSON-LD 里的绝对地址也补上 .html
  const key = origin + "/";
  let i = out.indexOf(key);
  while (i >= 0) {
    let j = i + key.length;
    while (!isEndChar(out.charAt(j))) j++;
    const mapped = mapRel("/" + out.slice(i + key.length, j));
    out = out.slice(0, i) + origin + mapped + out.slice(j);
    i = out.indexOf(key, i + origin.length + mapped.length);
  }
  return out;
}

/* ---------- 输出 ---------- */
const written = [];
function put(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push([rel, Buffer.byteLength(content)]);
}
function page(rel, html) { put(rel, staticize(html)); }

/* ---------- 数据 ---------- */
migrate();
seed();
ui.setStaticMode(true);
const categories = data.listCategories();
const games = data.listGames({ sort: "new", limit: 500 });
const tags = data.listTags(200);
const stats = data.siteStats();
console.log("游戏 " + games.length + " 款 / 分类 " + categories.length + " 个 / 标签 " + tags.length + " 个");

/* ---------- 页面 ---------- */
page("index.html", ui.homePage({
  origin: origin, user: null,
  featured: data.listGames({ sort: "hot", limit: 1 })[0] || null,
  hot: data.listGames({ sort: "hot", limit: 8 }),
  newest: data.listGames({ sort: "new", limit: 8 }),
  categories: categories, tags: data.listTags(20), stats: stats
}));

page("games.html", ui.listPage({
  origin: origin, path: "/games", heading: "全部游戏",
  sub: "按热度、评分或上架时间浏览全部小游戏",
  list: games, total: games.length, query: "", sort: "hot", base: "/games", user: null
}));

page("search.html", ui.listPage({
  origin: origin, path: "/search", heading: "搜索游戏",
  sub: "输入游戏名、类型或标签进行搜索",
  list: games, total: games.length, query: "", sort: "hot", base: "/search", user: null
}));

for (const c of categories) {
  const list = data.listGames({ category: c.slug, sort: "hot", limit: 200 });
  if (!list.length) continue;
  page("category/" + c.slug + ".html", ui.listPage({
    origin: origin, path: "/category/" + c.slug,
    heading: c.icon + " " + c.name + "小游戏",
    sub: "在线免费玩" + c.name + "类小游戏，即点即玩",
    list: list, total: list.length, query: "", sort: "hot",
    base: "/category/" + c.slug, user: null
  }));
}

for (const t of tags) {
  const list = data.listGames({ tag: t.name, sort: "hot", limit: 200 });
  if (!list.length) continue;
  const enc = encodeURIComponent(t.name);
  page("tag/" + t.name + ".html", ui.listPage({
    origin: origin, path: "/tag/" + enc, heading: "#" + t.name,
    sub: "带有「" + t.name + "」标签的小游戏",
    list: list, total: list.length, query: "", sort: "hot",
    base: "/tag/" + enc, user: null
  }));
}

for (const g of games) {
  page("game/" + g.slug + ".html", ui.gamePage({
    origin: origin, game: g, related: data.relatedGames(g, 6),
    myStars: 0, user: null, favorited: false,
    favCount: data.favoriteCount(g.slug), comments: [], commentTotal: 0
  }));
}

page("404.html", ui.notFoundPage({ origin: origin, user: null }));

/* ---------- 资源与游戏本体 ---------- */
put(".nojekyll", "");
for (const g of games) put("cover/" + g.slug + ".svg", coverSvg(g));
put("static/img/og.svg", ogSvg());
put("static/css/style.css", fs.readFileSync(path.join(PUBLIC_DIR, "css", "style.css"), "utf8"));
put("static/js/app.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "app-static.js"), "utf8"));
const FAVICON = "<svg xmlns=" + Q + "http://www.w3.org/2000/svg" + Q + " viewBox=" + Q + "0 0 64 64" + Q + "><rect width=" + Q + "64" + Q + " height=" + Q + "64" + Q + " rx=" + Q + "22" + Q + " fill=" + Q + "#6366f1" + Q + "/><text x=" + Q + "32" + Q + " y=" + Q + "43" + Q + " font-size=" + Q + "34" + Q + " text-anchor=" + Q + "middle" + Q + ">🎮</text></svg>";
put("favicon.svg", FAVICON);

const HEAD = /<head[^>]*>/i;
for (const g of games) {
  const src = path.join(GAMES_DIR, g.slug, "index.html");
  if (!fs.existsSync(src)) { console.log("!! 跳过缺失的游戏文件：" + src); continue; }
  let html = fs.readFileSync(src, "utf8");
  if (html.indexOf("rel=" + Q + "icon" + Q) < 0) {
    const link = NL + "<link rel=" + Q + "icon" + Q + " href=" + Q + base + "favicon.svg" + Q + ">";
    html = HEAD.test(html) ? html.replace(HEAD, function (m) { return m + link; }) : link + html;
  }
  put("games/" + g.slug + "/index.html", html);
}

/* ---------- SEO 与数据 ---------- */
const robots = ["User-agent: *", "Allow: /", "Disallow: /admin", "Sitemap: " + origin + mapRel("/sitemap.xml"), ""].join(NL);
put("robots.txt", robots);

const locs = [origin + mapRel("/")];
for (const c of categories) if (c.total) locs.push({ loc: origin + mapRel("/category/" + c.slug), pri: "0.8", last: "" });
for (const g of games) locs.push({ loc: origin + mapRel("/game/" + g.slug), pri: "0.9", last: String(g.created_at || "").slice(0, 10) });
const sitemap = ["<?xml version=" + Q + "1.0" + Q + " encoding=" + Q + "UTF-8" + Q + "?>",
  "<urlset xmlns=" + Q + "http://www.sitemaps.org/schemas/sitemap/0.9" + Q + ">"]
  .concat(locs.map(function (u) {
    const o = typeof u === "string" ? { loc: u, pri: "1.0", last: "" } : u;
    return "<url><loc>" + o.loc + "</loc>" + (o.last ? "<lastmod>" + o.last + "</lastmod>" : "") + "<priority>" + o.pri + "</priority></url>";
  }))
  .concat(["</urlset>", ""]).join(NL);
put("sitemap.xml", sitemap);

put("data/games.json", JSON.stringify({
  site: { name: ui.SITE.name, tagline: ui.SITE.tagline },
  origin: origin, base: base, generated_at: new Date().toISOString(),
  stats: stats, categories: categories, tags: tags, games: games
}, null, 2) + NL);

/* ---------- Cloudflare Pages 专用文件（_headers） ---------- */
if (CF_MODE) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
  put("_headers", [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  X-Frame-Options: SAMEORIGIN",
    "  Permissions-Policy: geolocation=(), microphone=(), camera=()",
    "  Content-Security-Policy: " + csp,
    "",
    "# 静态资源长缓存；改了 CSS/JS 记得把 views.js 里的 ?v= 版本号加一",
    "/static/*",
    "  Cache-Control: public, max-age=604800",
    "",
    "/cover/*",
    "  Cache-Control: public, max-age=86400",
    "",
    "/games/*",
    "  Cache-Control: public, max-age=3600",
    ""
  ].join(NL));
}

/* ---------- 汇报 ---------- */
const totalBytes = written.reduce(function (s, w) { return s + w[1]; }, 0);
console.log("静态站点已生成：" + OUT);
console.log("  base   = " + base);
console.log("  origin = " + origin + (PLACEHOLDER ? "   <== 占位域名！发布前请用 --origin 换成真实地址" : ""));
console.log("  文件 " + written.length + " 个，合计 " + (totalBytes / 1024).toFixed(1) + " KB");
console.log("  页面：index / games / search / 404" + (categories.length ? " / " + categories.filter(function (c) { return c.total; }).length + " 个分类" : "") + " / " + tags.length + " 个标签 / " + games.length + " 个游戏详情");
console.log("");
console.log("本地预览：node tools/serve-dist.mjs --base=" + base + "   然后打开 http://127.0.0.1:4173" + base);
console.log(CF_MODE
  ? "发布：把 dist 里的全部文件上传到 Cloudflare Pages（拖 zip 或 Git 集成），见 DEPLOY-CLOUDFLARE.md"
  : "发布：把 dist 里的全部文件推到 GitHub 仓库根目录，Settings > Pages 选 main / (root)");
