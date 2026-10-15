// 静态版（GitHub Pages）浏览器冒烟：自己起静态服务器托管 dist，再用无头 Chrome 真实打开、
// 真实操作，检查控制台报错 / 资源 404 / 关键断言，并把截图存到 docs/screens。
//
//   node tools/pages-smoke.mjs --base=/仓库名/ --port=4300
//
// 环境变量：CHROME（浏览器路径）、SHOTS_DIR（截图目录）、CDP_PORT
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStatic, normalizeBase } from "./serve-dist.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const hit = argv.find(function (a) { return a === "--" + name || a.startsWith("--" + name + "="); });
  if (!hit) return fallback;
  const i = hit.indexOf("=");
  return i < 0 ? "" : hit.slice(i + 1);
}
const base = normalizeBase(opt("base", "/"));
const OUT = path.resolve(opt("out", path.join(ROOT, "dist")));
const PORT = Number(opt("port", "4300"));
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, "docs", "screens");
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const BASE = "http://127.0.0.1:" + PORT + base;
const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const CHROME = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) { console.error("找不到 Chrome / Edge，可用 CHROME 环境变量指定"); process.exit(1); }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* ---------- 静态服务器 ---------- */
const server = await startStatic({ out: OUT, base: base, port: PORT });
console.log("静态站点：" + BASE);

/* ---------- 无头浏览器 ---------- */
fs.mkdirSync(SHOTS, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-pages-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--disable-extensions", "--no-first-run", "--mute-audio",
  "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + ud, "about:blank"
], { stdio: "ignore" });

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version"); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools 端口没能启动");
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    const self = this;
    return new Promise(function (res, rej) {
      self.ws = new WebSocket(self.url);
      self.ws.onopen = function () { res(); };
      self.ws.onerror = function () { rej(new Error("WebSocket 连接失败")); };
      self.ws.onmessage = function (m) {
        const msg = JSON.parse(m.data);
        if (msg.id && self.pending.has(msg.id)) {
          const p = self.pending.get(msg.id);
          self.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        } else if (msg.method) { self.events.push(msg); }
      };
    });
  }
  send(method, params) {
    const self = this;
    const id = ++this.id;
    return new Promise(function (resolve, reject) {
      self.pending.set(id, { resolve: resolve, reject: reject });
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (self.pending.has(id)) { self.pending.delete(id); reject(new Error("timeout " + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function newPage(width, height) {
  const t = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/new?about:blank", { method: "PUT" })).json();
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Log.enable");
  await c.send("Network.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: width, height: height, deviceScaleFactor: 1, mobile: false });
  return c;
}

async function load(c, url) {
  const done = new Promise(function (res) {
    const iv = setInterval(function () {
      if (c.events.some(function (e) { return e.method === "Page.loadEventFired"; })) { clearInterval(iv); res(); }
    }, 60);
    setTimeout(function () { clearInterval(iv); res(); }, 10000);
  });
  await c.send("Page.navigate", { url: url });
  await done;
  await sleep(600);
}

function problems(c) {
  const out = [];
  for (const e of c.events) {
    if (e.method === "Runtime.exceptionThrown") {
      const d = e.params.exceptionDetails;
      out.push("EXCEPTION " + ((d.exception && d.exception.description) || d.text));
    }
    if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
      out.push("ERROR " + e.params.args.map(function (a) { return a.value != null ? a.value : (a.description || ""); }).join(" "));
    }
    if (e.method === "Log.entryAdded" && e.params.entry.level === "error") out.push("LOG " + e.params.entry.text);
    if (e.method === "Network.loadingFailed" && String(e.params.errorText).indexOf("ERR_ABORTED") < 0) {
      out.push("NETFAIL " + e.params.type + " " + e.params.errorText);
    }
    if (e.method === "Network.responseReceived" && e.params.response.status >= 400) {
      out.push("HTTP " + e.params.response.status + " " + e.params.response.url.slice(BASE.length - base.length));
    }
  }
  return out;
}

/* ---------- 断言 ---------- */
function has(s, needle) { return String(s).indexOf(needle) >= 0; }

const TARGETS = [
  {
    n: "pages-home", w: 1280, h: 1050, u: BASE,
    js: `(function(){ var acct = document.querySelector(".acct"); return { cards: document.querySelectorAll(".card").length, h1: (document.querySelector("h1")||{}).textContent || "", sections: document.querySelectorAll(".sec").length, submit: has = /投稿/.test(document.body.innerHTML), acct: acct ? acct.textContent.trim() : null, iframe: !!document.querySelector("iframe") }; })()`,
    want: function (s) { var e = []; if (s.cards !== 12) e.push("首页卡片应为 12 张，实际 " + s.cards); if (s.sections < 2) e.push("首页区块太少：" + s.sections); if (s.submit) e.push("静态版不应有投稿入口"); if (s.acct) e.push("静态版不应有账号区：" + s.acct); if (s.iframe) e.push("首页不应有 iframe"); return e; }
  },
  {
    n: "pages-list", w: 1280, h: 1000, u: BASE + "games.html?sort=title",
    js: `(function(){ var cards = [].slice.call(document.querySelectorAll(".grid .card")); return { n: cards.length, on: (document.querySelector(".tab.on")||{}).textContent || "", onCount: document.querySelectorAll(".tab.on").length, order: cards.map(function(c){ return c.getAttribute("data-title"); }) }; })()`,
    want: function (s) {
      var e = [];
      if (s.n !== 6) e.push("列表页卡片应为 6 张，实际 " + s.n);
      if (s.onCount !== 1 || s.on !== "名称") e.push("排序标签高亮不对：" + s.onCount + " / " + s.on);
      var sorted = s.order.slice().sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
      if (s.order.join("|") !== sorted.join("|")) e.push("按名称排序没生效：" + s.order.join(" > "));
      return e;
    }
  },
  {
    n: "pages-search", w: 1280, h: 1000, u: BASE + "search.html?q=" + encodeURIComponent("2048"),
    js: `(function(){ var cards = [].slice.call(document.querySelectorAll(".grid .card")); var vis = cards.filter(function(c){ return c.style.display !== "none"; }); return { h1: document.querySelector(".page-head h1").textContent, count: document.querySelector(".page-count").textContent.trim(), total: cards.length, visible: vis.length, titles: vis.map(function(c){ return c.getAttribute("data-title"); }) }; })()`,
    want: function (s) {
      var e = [];
      if (s.h1 !== "「2048」的搜索结果") e.push("搜索标题不对：" + s.h1);
      if (s.visible < 1) e.push("搜索 2048 没有结果");
      if (s.visible >= s.total) e.push("搜索没有过滤掉任何卡片：" + s.visible + "/" + s.total);
      if (s.titles.indexOf("2048") < 0) e.push("结果里没有 2048：" + s.titles.join(","));
      if (!has(s.count, String(s.visible))) e.push("结果计数不对：" + s.count);
      return e;
    }
  },
  {
    n: "pages-tag", w: 1280, h: 1000, u: BASE + "tag/" + encodeURIComponent("益智") + ".html",
    js: `(function(){ return { h1: document.querySelector(".page-head h1").textContent, cards: document.querySelectorAll(".grid .card").length, sub: document.querySelector(".page-sub").textContent }; })()`,
    want: function (s) { var e = []; if (s.h1 !== "#益智") e.push("标签页标题不对：" + s.h1); if (s.cards < 1) e.push("标签页没有游戏"); return e; }
  },
  {
    n: "pages-detail", w: 1280, h: 1100, u: BASE + "game/tetris.html",
    js: `(function(){ var f = document.getElementById("gameFrame"); var ld = document.querySelector("script[type='application/ld+json']"); return { h1: document.querySelector(".game-title").textContent, fav: !!document.getElementById("favBtn"), cmt: !!document.getElementById("cmtPanel"), stars: !!document.getElementById("stars"), tip: (document.querySelector("#ratePanel .rate-tip")||{}).textContent || "", info: (document.querySelector("#ratePanel .rate-info")||{}).textContent || "", views: !!document.querySelector(".player-views"), related: document.querySelectorAll(".game-side .card").length, iframe: f ? f.getAttribute("src") : "", ld: ld ? ld.textContent.slice(0, 80) : "", scripts: [].slice.call(document.querySelectorAll("script[src]")).map(function(x){ return x.getAttribute("src"); }).join(" ") }; })()`,
    want: function (s) {
      var e = [];
      if (s.fav || s.cmt || s.stars || s.views) e.push("静态版不该渲染收藏/评论/可点星级/游玩次数：" + [s.fav, s.cmt, s.stars, s.views].join(","));
      if (!has(s.tip, "静态演示版")) e.push("缺少静态版提示：" + s.tip);
      if (!s.info) e.push("评分信息为空");
      if (!has(s.iframe, base + "games/")) e.push("iframe 地址没重写：" + s.iframe);
      if (s.related < 1) e.push("没有相关推荐");
      if (!has(s.ld, "VideoGame")) e.push("缺少 VideoGame 结构化数据");
      if (s.scripts.indexOf("app-static.js") < 0) e.push("静态页面没有引用 static/js/app-static.js：" + s.scripts);
      if (new RegExp("js/app[.]js").test(String(s.scripts).replace(new RegExp("app-static[.]js", "g"), ""))) e.push("静态页面引用了动态前端 static/js/app.js：" + s.scripts);
      return e;
    }
  },
  {
    n: "pages-play", w: 560, h: 760, u: BASE + "game/2048.html",
    js: `(async function(){ await new Promise(function(r){ setTimeout(r, 900); }); var f = document.getElementById("gameFrame"); var d = f.contentDocument; if (!d) return { error: "no contentDocument" }; var keys = ["ArrowLeft","ArrowUp","ArrowRight","ArrowDown","ArrowLeft","ArrowUp"]; var before = (d.getElementById("score")||{}).textContent; for (var i = 0; i < keys.length; i++) { d.dispatchEvent(new KeyboardEvent("keydown", { key: keys[i], bubbles: true })); await new Promise(function(r){ setTimeout(r, 160); }); } return { src: f.getAttribute("src"), title: d.title, before: before, score: (d.getElementById("score")||{}).textContent, tiles: d.querySelectorAll(".tile").length }; })()`,
    want: function (s) {
      var e = [];
      if (s.error) return [s.error];
      if (!has(s.src, base + "games/2048/index.html")) e.push("iframe 地址不对：" + s.src);
      if (!s.tiles) e.push("iframe 里的游戏没渲染出方块");
      if (s.before === s.score) e.push("在详情页里按键后 2048 分数没变：" + s.score);
      return e;
    }
  },
  {
    n: "pages-game-tetris", w: 560, h: 760, u: BASE + "games/tetris/index.html",
    js: `(async function(){ document.getElementById("start").click(); await new Promise(function(r){ setTimeout(r, 320); }); var keys = ["ArrowLeft","ArrowUp","ArrowLeft"," "]; for (var i = 0; i < keys.length; i++) { document.dispatchEvent(new KeyboardEvent("keydown", { key: keys[i], bubbles: true })); await new Promise(function(r){ setTimeout(r, 160); }); } await new Promise(function(r){ setTimeout(r, 500); }); return { score: document.getElementById("score").textContent, level: document.getElementById("level").textContent }; })()`,
    want: function (s) { var e = []; if (!s.score) e.push("俄罗斯方块没出分数"); return e; }
  },
  {
    n: "pages-404", w: 1280, h: 800, u: BASE + "nope.html", allow404: true,
    js: `(function(){ return { h1: (document.querySelector("h1")||{}).textContent || "", home: !!document.querySelector("a[href$='index.html']") }; })()`,
    want: function (s) { var e = []; if (s.h1 !== "404") e.push("404 页面标题不对：" + s.h1); return e; }
  },
  {
    n: "pages-mobile", w: 390, h: 844, u: BASE,
    js: `(function(){ return { cards: document.querySelectorAll(".card").length, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }; })()`,
    want: function (s) { var e = []; if (s.cards < 1) e.push("手机端没有卡片"); if (s.scrollW > s.clientW + 2) e.push("手机端横向溢出：" + s.scrollW + " > " + s.clientW); return e; }
  }
];

/* ---------- 跑起来 ---------- */
await ready();
const results = [];
for (const t of TARGETS) {
  const c = await newPage(t.w, t.h);
  await load(c, t.u);
  let state = null;
  let evalError = null;
  try {
    const r = await c.send("Runtime.evaluate", { expression: t.js, awaitPromise: true, returnByValue: true });
    state = r.result && r.result.value;
    if (r.exceptionDetails) evalError = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
  } catch (e) { evalError = String(e.message); }
  await sleep(250);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, t.n + ".png"), Buffer.from(shot.data, "base64"));
  let probs = problems(c);
  if (t.allow404) probs = probs.filter(function (p) { return p.indexOf("404") < 0; });
  let fails = t.want && state ? t.want(state) : [];
  results.push({ name: t.n, state: state, evalError: evalError, problems: probs, fails: fails });
  c.close();
}

let bad = 0;
for (const r of results) {
  const isBad = !!(r.evalError || r.problems.length || r.fails.length);
  if (isBad) bad++;
  console.log((isBad ? "FAIL" : "ok  ") + " " + r.name.padEnd(20) + JSON.stringify(r.state === undefined ? null : r.state));
  if (r.evalError) console.log("       eval error:", r.evalError);
  for (const f of r.fails) console.log("       断言失败:", f);
  for (const p of r.problems) console.log("       ", p);
}
console.log("");
console.log("截图目录：" + SHOTS);
console.log(bad ? bad + " 项有问题" : "全部通过");

chrome.kill();
server.close();
try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
