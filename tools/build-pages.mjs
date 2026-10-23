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
 *       robots.txt、sitemap.xml、.nojekyll、data/games.json，以及 PWA 三件套
 *       （manifest.webmanifest / sw.js / icons/，直接搬 public/ 下的原始文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, GAMES_DIR, PUBLIC_DIR, migrate } from "../src/db.js";
import { MIN_SOURCES, minAssetsReady, minOutRel, swapMinRefs } from "../src/assets.js";
import { seed } from "../src/seed.js";
import { coverSvg, ogSvg } from "../src/cover.js";
import * as data from "../src/data.js";
import * as hot from "../src/hot.js";
import * as ui from "../src/views.js";
import { buildSearchIndex } from "../src/pinyin.js";

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
const CF_MODE = argv.indexOf("--cf") >= 0;
/* --cf 写 dist-cf、否则写 dist。两个目录同时存在（dist = GitHub Pages / Workers 备用，
   dist-cf = Cloudflare Pages 与 wrangler 的 assets 目录），漏写 --out 会把对方的产物覆盖掉
   （踩过一次：--cf 忘了 --out，结果 GitHub Pages 的 dist 被覆盖、dist-cf 还是旧版本），
   所以让模式自己决定默认目录。 */
const OUT = path.resolve(opt("out", path.join(ROOT, CF_MODE ? "dist-cf" : "dist")));

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
  /* 公告与更新说明：列表 / 详情 / 更新记录都导出成 .html。
     公告 slug 允许中文（postSlug 保留中文），所以文件名要 decode 回原始字符，
     否则浏览器请求 /notice/<百分号编码>.html 会和磁盘上字面量的百分号文件名对不上 */
  else if (seg.length === 1 && seg[0] === "notice") out = "/notice.html";
  else if (seg.length === 1 && seg[0] === "changelog") out = "/changelog.html";
  else if (seg.length === 2 && (seg[0] === "category" || seg[0] === "tag" || seg[0] === "game")) out = "/" + seg[0] + "/" + seg[1] + ".html";
  /* 排行榜：导航里的 /rank 落到今日榜，榜单切换链接是 /rank/<kind>（views.js 在 STATIC_MODE 下这么发） */
  else if (seg.length === 2 && seg[0] === "notice") out = "/notice/" + decodeURIComponent(seg[1]) + ".html";
  else if (seg.length === 1 && seg[0] === "rank") out = "/rank/today.html";
  else if (seg.length === 2 && seg[0] === "rank") out = "/rank/" + seg[1] + ".html";
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
/* 压缩产物齐备就让页面引用 *.min.*（产物由 tools/minify.mjs 生成并入库，跟着导出） */
const useMinAssets = minAssetsReady(PUBLIC_DIR);
ui.setMinAssets(useMinAssets);
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
  categories: categories, tags: data.listTags(20), stats: stats,
  notice: data.latestNotice()
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

/* 法律页面：纯文本，静态版照样导出（页脚每一页都链过来） */
page("privacy.html", ui.privacyPage({ origin: origin, user: null }));
page("terms.html", ui.termsPage({ origin: origin, user: null }));

/* 公告：只导出已发布的（撤回的只有站长后台看得到），首页横幅也只在有已发布公告时出现。
   公告评论要服务端，静态版整块不渲染（commentPanel 在 STATIC_MODE 下返回空） */
const notices = data.listPosts({ status: 1, limit: 200 });
const noticeCount = data.countPosts(1);
page("notice.html", ui.noticeListPage({
  origin: origin, user: null, items: notices, total: noticeCount,
  page: 1, pages: 1, banner: null
}));
for (const p of notices) {
  page("notice/" + p.slug + ".html", ui.noticePage({
    origin: origin, user: null, post: p, thread: null, commentTotal: 0
  }));
}

/* 更新说明：读 src/changelog-data.js（由 tools/gen-changelog.mjs 从 git log 生成） */
page("changelog.html", ui.changelogPage({ origin: origin, user: null }));

/* 导航页：fishport.cn 的子域清单（src/sites.js），静态导出里也在；
   静态版没有服务端，卡片全是外链，所以照样能点 */
page("nav.html", ui.portalPage({ origin: origin, user: null }));

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

/* 排行榜：热玩/评分/收藏/新作共 7 个榜单，各导出一个静态页（排行榜是纯读快照，静态版完全可用） */
const boardTabs = Object.entries(data.BOARD_KINDS).map(function (e) { return { kind: e[0], label: e[1].label }; });
for (const t of boardTabs) {
  const board = data.leaderboard(t.kind, 20);
  page("rank/" + t.kind + ".html", ui.rankPage({
    origin: origin, user: null, kind: board.kind, label: board.label, metric: board.metric,
    rows: board.rows, boards: boardTabs
  }));
}

/* 热度榜：静态版是构建时的快照（与排行榜同性质），数据取自本机 games.db 的 play_logs。
   注意静态页里 /hot 的「实时重算」做不到，所以把口径写进 windowLabel，别让读者以为是活的 */
const hotRows = hot.hotGames({ limit: 20 });
page("hot.html", ui.hotPage({
  origin: origin, user: null, rows: hotRows,
  updatedAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  windowLabel: "静态快照 · 每次构建按今日 / 近 3 天 / 近 7 天播放量重新计算"
}));

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
/* 注意：静态版前端叫 app-static.js，动态版叫 app.js，两个文件名不能互相顶掉。
   以前这里把 app-static.js 写成 app.js —— 纯 Pages 上没问题，但 dist/ 同时还是 Workers/D1 版的
   ASSETS 目录，动态页面上就会加载到静态版前端，导致游玩上报、评分、评论、收藏全部静默失效。 */
put("static/js/app.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "app.js"), "utf8"));
put("static/js/app-static.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "app-static.js"), "utf8"));
put("static/js/gamepad.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "gamepad.js"), "utf8"));
/* 联机对战小部件：棋类游戏页会引它，静态导出必须一起带上 */
put("static/js/net-play.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "net-play.js"), "utf8"));
/* 离线兜底：views.js 无条件引 offline-wire.js（它再按需用 offline-queue.js），
   静态托管上少一个就是 404 + console 报错，所以两件都得跟着产物导出 */
put("static/js/offline-queue.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "offline-queue.js"), "utf8"));
put("static/js/offline-wire.js", fs.readFileSync(path.join(PUBLIC_DIR, "js", "offline-wire.js"), "utf8"));
/* 建置期压缩产物：页面启用时引用的是 *.min.*，产物目录必须同时带上，否则静态托管直接 404 */
if (useMinAssets) {
  for (const rel of MIN_SOURCES) {
    put("static/" + minOutRel(rel), fs.readFileSync(path.join(PUBLIC_DIR, minOutRel(rel)), "utf8"));
  }
}
const FAVICON = "<svg xmlns=" + Q + "http://www.w3.org/2000/svg" + Q + " viewBox=" + Q + "0 0 64 64" + Q + "><rect width=" + Q + "64" + Q + " height=" + Q + "64" + Q + " rx=" + Q + "22" + Q + " fill=" + Q + "#6366f1" + Q + "/><text x=" + Q + "32" + Q + " y=" + Q + "43" + Q + " font-size=" + Q + "34" + Q + " text-anchor=" + Q + "middle" + Q + ">🎮</text></svg>";
put("favicon.svg", FAVICON);

/* PWA 三件套：manifest、Service Worker、图标。
   页面 head 里（src/views.js）无条件链了 /manifest.webmanifest 与 apple-touch-icon，
   所以这两样必须跟着导出，否则静态托管上必然 404；根路径部署时 Service Worker 也真能用。
   注意：public/sw.js 的内部路径全是根相对的（/、/static/、/games/…），
   所以子路径部署（GitHub Pages 仓库站点）下 app-static.js 不会注册它 —— 见 public/js/app-static.js 的注释。 */
const PWA_ICONS = ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon-180.png"];
put("manifest.webmanifest", fs.readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest")));
put("sw.js", fs.readFileSync(path.join(PUBLIC_DIR, "sw.js")));
/* PWA 真离线：预缓存清单由 tools/gen-precache.mjs 扫描仓库生成，sw.js 在 install 时拉取。
   Express 线直接读 public/，Workers 线与静态托管都从产物目录拿，所以它必须跟着导出。 */
const PRECACHE_SRC = path.join(PUBLIC_DIR, "precache.json");
if (fs.existsSync(PRECACHE_SRC)) put("precache.json", fs.readFileSync(PRECACHE_SRC));
else console.log("!! 缺少 public/precache.json（PWA 真离线清单）：先跑 node tools/gen-precache.mjs");
for (const ic of PWA_ICONS) put("icons/" + ic, fs.readFileSync(path.join(PUBLIC_DIR, "icons", ic)));
/* 静态封面（第二十批）：卡片 / 排行榜小图 / 首页 hero 都引 /covers/<slug>.svg，
   由 tools/gen-covers.mjs 生成（连同一份 manifest.json），产物里必须齐 */
const COVERS_DIR = path.join(PUBLIC_DIR, "covers");
if (fs.existsSync(COVERS_DIR)) {
  for (const f of fs.readdirSync(COVERS_DIR).sort()) put("covers/" + f, fs.readFileSync(path.join(COVERS_DIR, f)));
} else {
  console.log("!! 缺少 public/covers/（静态封面）：先跑 node tools/gen-covers.mjs");
}

const HEAD = /<head[^>]*>/i;
for (const g of games) {
  const src = path.join(GAMES_DIR, g.slug, "index.html");
  if (!fs.existsSync(src)) { console.log("!! 跳过缺失的游戏文件：" + src); continue; }
  let html = fs.readFileSync(src, "utf8");
  if (html.indexOf("rel=" + Q + "icon" + Q) < 0) {
    /* 这里必须写根相对路径：下面的 staticize() 会统一补 base 前缀。以前这里自己拼了 base，
       结果被 staticize 再拼一次，导出成 /<base>/<base>/favicon.svg 而 404。 */
    const link = NL + "<link rel=" + Q + "icon" + Q + " href=" + Q + "/favicon.svg" + Q + ">";
    html = HEAD.test(html) ? html.replace(HEAD, function (m) { return m + link; }) : link + html;
  }
  /* 游戏本体是自包含单文件，直接写 /static/js/gamepad.js、net-play.js；压缩产物齐备时换成 .min
     （必须在 staticize 之前换，换的是根路径，之后由 staticize 统一补 base 前缀）。 */
  if (useMinAssets) html = swapMinRefs(html);
  put("games/" + g.slug + "/index.html", staticize(html));
}

/* ---------- SEO 与数据 ---------- */
const robots = ["User-agent: *", "Allow: /",
  "Disallow: /admin", "Disallow: /account", "Disallow: /forgot", "Disallow: /reset",
  "Disallow: /auth", "Disallow: /comments",
  "Sitemap: " + origin + mapRel("/sitemap.xml"), ""].join(NL);
put("robots.txt", robots);

const locs = [origin + mapRel("/")];
locs.push({ loc: origin + mapRel("/privacy"), pri: "0.3", last: "" });
locs.push({ loc: origin + mapRel("/terms"), pri: "0.3", last: "" });
locs.push({ loc: origin + mapRel("/changelog"), pri: "0.4", last: "" });
locs.push({ loc: origin + mapRel("/nav"), pri: "0.5", last: "" });
locs.push({ loc: origin + mapRel("/notice"), pri: "0.6", last: "" });
for (const p of notices) locs.push({ loc: origin + mapRel("/notice/" + encodeURIComponent(p.slug)), pri: "0.6", last: "" });
for (const t of boardTabs) locs.push({ loc: origin + mapRel("/rank/" + t.kind), pri: "0.7", last: "" });
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

/* games.json 里每款游戏多带一个 py（全拼 + 首字母索引）：静态版前端没有服务端搜索，
   靠它把「拼音 / 首字母 / 中文」三种搜法在浏览器里补齐。 */
const gamesJson = games.map(function (g) {
  return Object.assign({}, g, {
    py: buildSearchIndex([g.title, g.subtitle || "",
      (Array.isArray(g.tags) ? g.tags.join(" ") : (g.tags || "")),
      String(g.description || "").slice(0, 120)])
  });
});
put("data/games.json", JSON.stringify({
  site: { name: ui.SITE.name, tagline: ui.SITE.tagline },
  origin: origin, base: base, generated_at: new Date().toISOString(),
  stats: stats, categories: categories, tags: tags,
  boards: boardTabs,
  games: gamesJson
}, null, 2) + NL);

/* ---------- Cloudflare Pages 专用文件（_headers） ---------- */
if (CF_MODE) {
  /* frame-src 放行 http(s)：投稿允许填任意外站地址，外站游戏靠 iframe 载入；
     script-src/connect-src 放行 Cloudflare 边缘自动注入的 RUM beacon */
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://cloudflareinsights.com",
    "frame-src 'self' https: http:",
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
    "/covers/*",
    "  Cache-Control: public, max-age=604800",
    "",
    "/games/*",
    "  Cache-Control: public, max-age=3600",
    "",
    "# PWA：Service Worker 不许被缓存（改一版要立刻生效），manifest 短缓存，图标长缓存",
    "/sw.js",
    "  Cache-Control: no-cache",
    "  Service-Worker-Allowed: /",
    "",
    "/manifest.webmanifest",
    "  Cache-Control: public, max-age=3600",
    "",
    "/precache.json",
    "  Cache-Control: public, max-age=600",
    "",
    "/icons/*",
    "  Cache-Control: public, max-age=2592000",
    ""
  ].join(NL));
}

/* ---------- 构建自检 ----------
   2026-10 线上事故：以前这里把「静态版前端」写成了 static/js/app.js，而 dist-cf 同时又是
   Workers/D1 版（wrangler.d1.toml 的 [assets] directory）的 ASSETS 目录 → 动态页面上加载到的
   是没有 /play 上报、没有评分/评论/收藏逻辑的 app-static.js，于是「游玩次数不变、打不了星、发不出评论」，
   而本机 Express 版直接服务 public/js/app.js、完全正常 —— 测试全过、线上全废。
   规则：static/js/app.js = 动态版（public/js/app.js），static/js/app-static.js = 静态版；
   静态页面（STATIC_MODE）只能引 app-static.js。改坏了就在这里直接失败。 */
(function verifyAssets() {
  const problems = [];
  const rels = written.map(function (w) { return w[0]; });
  /* 页面可能引原始文件，也可能引压缩产物（MIN_ASSETS 生效时），自检两种都认。
     压缩产物必须随产物导出，否则线上就是 404。 */
  function hasAsset(html, rel) {
    return html.indexOf(base + rel) >= 0 || html.indexOf(base + minOutRel(rel)) >= 0;
  }
  if (useMinAssets) {
    MIN_SOURCES.forEach(function (rel) {
      if (rels.indexOf("static/" + minOutRel(rel)) < 0) {
        problems.push("没有产出 static/" + minOutRel(rel) + "（页面已启用压缩产物，静态托管会 404）");
      }
    });
  }
  if (rels.indexOf("static/js/app.js") < 0) problems.push("没有产出 static/js/app.js");
  else {
    const dyn = fs.readFileSync(path.join(OUT, "static", "js", "app.js"), "utf8");
    if (dyn.indexOf("/api/games/") < 0 || dyn.indexOf("ratePanel") < 0) {
      problems.push("static/js/app.js 不是动态前端（缺 /api/games/ 上报或 ratePanel 评分逻辑）—— 它必须是 public/js/app.js");
    }
  }
  if (rels.indexOf("static/js/app-static.js") < 0) problems.push("没有产出 static/js/app-static.js");
  if (rels.indexOf("static/js/gamepad.js") < 0) problems.push("没有产出 static/js/gamepad.js（手柄支持）");
  if (rels.indexOf("static/js/net-play.js") < 0) problems.push("没有产出 static/js/net-play.js（联机对战小部件）");
  if (rels.indexOf("static/js/offline-queue.js") < 0) problems.push("没有产出 static/js/offline-queue.js（离线队列）");
  if (rels.indexOf("static/js/offline-wire.js") < 0) problems.push("没有产出 static/js/offline-wire.js（离线兜底接线）");
  const coverRels = rels.filter(function (r) { return r.indexOf("covers/") === 0 && /[.]svg$/.test(r); });
  if (coverRels.length < games.length) {
    problems.push("covers/ 只导出了 " + coverRels.length + " 张封面（应为 " + games.length + " 张，先跑 node tools/gen-covers.mjs）");
  }
  /* PWA 三件套：页面 head（src/views.js）无条件链了 /manifest.webmanifest 与 apple-touch-icon，
     产物里必须都有，否则静态托管上就是 404 */
  if (rels.indexOf("manifest.webmanifest") < 0) problems.push("没有产出 manifest.webmanifest（PWA）");
  if (rels.indexOf("sw.js") < 0) problems.push("没有产出 sw.js（PWA Service Worker）");
  if (rels.indexOf("precache.json") < 0) problems.push("没有产出 precache.json（PWA 真离线清单，先跑 gen:precache）");
  ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon-180.png"].forEach(function (ic) {
    if (rels.indexOf("icons/" + ic) < 0) problems.push("没有产出 icons/" + ic + "（PWA 图标）");
  });
  /* 排行榜静态页：标题栏的「排行榜」链接必须落到 rank/today.html，tabs 必须是 /rank/<kind> 静态路径 */
  if (rels.indexOf("rank/today.html") < 0) problems.push("没有产出 rank/today.html（排行榜静态页）");
  else {
    const rk = fs.readFileSync(path.join(OUT, "rank", "today.html"), "utf8");
    if (rk.indexOf("rk-row") < 0 && rk.indexOf('class="empty"') < 0) problems.push("rank/today.html 里没有榜单内容");
    if (rk.indexOf(base + "rank/week.html") < 0) problems.push("rank/today.html 的榜单切换链接不是静态路径（应为 " + base + "rank/week.html）");
  }
  const idxHtml = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
  if (idxHtml.indexOf(base + "rank/today.html") < 0) problems.push("首页导航的排行榜链接没有指向 " + base + "rank/today.html");
  if (idxHtml.indexOf(base + "manifest.webmanifest") < 0) problems.push("首页 head 的 manifest 链接没有指向 " + base + "manifest.webmanifest");
  if (idxHtml.indexOf(base + "icons/apple-touch-icon-180.png") < 0) problems.push("首页 head 的 apple-touch-icon 没有指向 " + base + "icons/apple-touch-icon-180.png");
  if (idxHtml.indexOf(base + "covers/") < 0) problems.push("首页封面没带 base 前缀（应为 " + base + "covers/…）——子路径部署会 404");
  if (!hasAsset(idxHtml, "static/js/offline-wire.js")) problems.push("首页没引 " + base + "static/js/offline-wire.js（或其 .min.js 压缩产物，离线兜底）");
  const gpWant = base + "static/js/gamepad.js";
  const gpWantMin = base + "static/js/gamepad.min.js";
  const gamePages = rels.filter(function (r) { return r.indexOf("games/") === 0 && /index[.]html$/.test(r); });
  if (!gamePages.length) problems.push("没有产出任何游戏本体页");
  gamePages.forEach(function (rel) {
    const html = fs.readFileSync(path.join(OUT, rel), "utf8");
    /* 页面自带手柄轮询时可以免引共享 shim：在 <head> 里写 <meta name="gamepad" content="self">（黑洞吞噬就是这种） */
    const selfGp = /<meta\s+name="gamepad"\s+content="self"/i.test(html);
    if (!selfGp && html.indexOf(gpWant) < 0 && html.indexOf(gpWantMin) < 0) {
      problems.push(rel + " 没有引用手柄脚本（应为 " + gpWant + " 或压缩产物；自带手柄轮询的页面请加 <meta name=\"gamepad\" content=\"self\">）");
    }
    if (useMinAssets && !selfGp && html.indexOf(gpWantMin) < 0) {
      problems.push(rel + " 手柄脚本没换成压缩产物（应为 " + gpWantMin + "）");
    }
    /* base = "/" 时 base 前缀就是根路径本身，不算问题；只有子路径部署才要求已经被补上前缀 */
    if (base !== "/" && html.indexOf("\"/static/js/gamepad.js\"") >= 0) {
      problems.push(rel + " 手柄脚本用的是根路径 /static/js/gamepad.js，没带 base 前缀 —— 子路径部署会 404");
    }
  });
  /* 联机小部件同理：游戏页里只能写根路径 /static/js/net-play.js，由 staticize 补 base 前缀 */
  if (useMinAssets) {
    var npMinWant = base + "static/js/net-play.min.js";
    gamePages.forEach(function (rel) {
      var html = fs.readFileSync(path.join(OUT, rel), "utf8");
      if (/<script[^>]+src=[^>]*net-play[^>]*>/.test(html) && html.indexOf(npMinWant) < 0) {
        problems.push(rel + " 的联机小部件没换成压缩产物（应为 " + npMinWant + "）");
      }
    });
  }
  if (base !== "/") {
    var npRoot = Q + "/static/js/net-play.js" + Q;
    var npWant = base + "static/js/net-play.js";
    gamePages.forEach(function (rel) {
      var html = fs.readFileSync(path.join(OUT, rel), "utf8");
      if (html.indexOf(npRoot) >= 0) {
        problems.push(rel + "的联机小部件用的是根路径 /static/js/net-play.js，没带 base 前缀 —— 子路径部署会 404");
      } else if (html.indexOf("net-play.js") >= 0 && html.indexOf(npWant) < 0 && html.indexOf(npMinWant) < 0) {
        problems.push(rel + " 引了 net-play.js 但路径不对（应为 " + npWant + "）");
      }
    });
  }
  rels.forEach(function (rel) {
    if (!/.html$/.test(rel)) return;
    if (rel.indexOf("games/") === 0) return; // 游戏本体是自包含的单文件页，不引主站前端
    const html = fs.readFileSync(path.join(OUT, rel), "utf8");
    if (!hasAsset(html, "static/js/app-static.js")) problems.push(rel + " 没有引用 static/js/app-static.js（或其 .min.js 压缩产物）");
    /* 先把静态版（含压缩产物）抹掉，剩下的 js/app.js 或 js/app.min.js 就是误引动态前端 */
    var rest = html.replace(/app-static(\.min)?\.js/g, "");
    if (/js\/app(\.min)?\.js/.test(rest)) {
      problems.push(rel + " 引用了动态前端 static/js/app(.min).js（静态页面应该只引 app-static.js）");
    }
  });
  if (problems.length) {
    console.error("");
    console.error("构建自检失败：");
    problems.forEach(function (p) { console.error("  - " + p); });
    process.exitCode = 1;
  } else {
    console.log("  自检：app.js 是动态前端、app-static.js 已就位、全部 HTML 只引 app-static.js、手柄脚本 / 离线兜底 / 封面与 PWA 三件套已随产物导出");
  }
})();

/* ---------- 汇报 ---------- */
const totalBytes = written.reduce(function (s, w) { return s + w[1]; }, 0);
console.log("静态站点已生成：" + OUT);
console.log("  base   = " + base);
console.log("  origin = " + origin + (PLACEHOLDER ? "   <== 占位域名！发布前请用 --origin 换成真实地址" : ""));
console.log("  文件 " + written.length + " 个，合计 " + (totalBytes / 1024).toFixed(1) + " KB");
console.log("  页面：index / games / search / 404 / " + boardTabs.length + " 个排行榜" + (notices.length ? " / " + notices.length + " 条公告" : "") + " / changelog / nav" + (categories.length ? " / " + categories.filter(function (c) { return c.total; }).length + " 个分类" : "") + " / " + tags.length + " 个标签 / " + games.length + " 个游戏详情");
console.log("");
console.log("本地预览：node tools/serve-dist.mjs --base=" + base + "   然后打开 http://127.0.0.1:4173" + base);
console.log(CF_MODE
  ? "发布：把 dist 里的全部文件上传到 Cloudflare Pages（拖 zip 或 Git 集成），见 DEPLOY-CLOUDFLARE.md"
  : "发布：把 dist 里的全部文件推到 GitHub 仓库根目录，Settings > Pages 选 main / (root)");
