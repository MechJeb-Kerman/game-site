/* 手柄支持自测：往 Chrome 里注入一个假手柄（Gamepad API 探针），真实点击/按键跑一遍 7 款游戏。
 *
 * 用法（先起服务器）：
 *   node tools/gamepad-test.mjs
 *   BASE=http://127.0.0.1:8790 node tools/gamepad-test.mjs        # 打 D1 / Workers 版
 *   ONLY=gamepad-memory node tools/gamepad-test.mjs               # 只跑一个用例
 * 环境变量：BASE / CHROME / SHOTS_DIR / CDP_PORT / PROFILE / ONLY
 *
 * 假手柄怎么做的：用 Page.addScriptToEvaluateOnNewDocument 在每个文档（含 iframe）开跑前覆盖
 * navigator.getGamepads()，返回一个从 window.top.__padState 读取状态的假 pad —— 状态放在 top 上，
 * 所以父页面调 window.__pad.set(...) 就等于在按 iframe 里那台手柄，能验证真实详情页路径。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const CHROME = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) { console.error("找不到 Chrome / Edge，可用 CHROME 环境变量指定"); process.exit(1); }
const SHOTS = process.env.SHOTS_DIR || "D:/CODE/game-site/docs/screens";
const PORT = Number(process.env.CDP_PORT || 9225);
const PROFILE = process.env.PROFILE || "D:/CODE/shots/_gpprofile";
const ONLY = process.env.ONLY || "";

const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 注入到每个页面的假手柄 ---------- */
const FAKE = [
"(function () {",
"  var T;",
"  try { T = window.top || window; } catch (e) { T = window; }",
"  if (!T.__padState) {",
"    var st = { axes: [0, 0, 0, 0], buttons: [], timestamp: 0 };",
"    for (var i = 0; i < 17; i++) st.buttons.push({ pressed: false, touched: false, value: 0 });",
"    T.__padState = st;",
"  }",
"  var S = T.__padState;",
"  if (!T.__pad) {",
"    T.__pad = {",
"      set: function (ax, ay, list) {",
"        S.axes[0] = ax || 0; S.axes[1] = ay || 0;",
"        for (var i = 0; i < S.buttons.length; i++) {",
"          var on = !!(list && list.indexOf(i) >= 0);",
"          S.buttons[i].pressed = on;",
"          S.buttons[i].value = on ? 1 : 0;",
"        }",
"        S.timestamp = Date.now();",
"        return true;",
"      },",
"      reset: function () { return T.__pad.set(0, 0, []); }",
"    };",
"  }",
"  window.__pad = T.__pad;",
"  var pad = { id: 'Fake Pad (gamepad-test)', index: 0, mapping: 'standard', connected: true };",
"  Object.defineProperty(pad, 'axes', { get: function () { return S.axes; } });",
"  Object.defineProperty(pad, 'buttons', { get: function () { return S.buttons; } });",
"  Object.defineProperty(pad, 'timestamp', { get: function () { return S.timestamp; } });",
"  navigator.getGamepads = function () { return [pad]; };",
"})();"
].join(NL);

/* ---------- 页面内驱动手柄的小工具 ---------- */
const HELPERS = [
"window.__hold = async function (list, ms) {",
"  window.__pad.set(0, 0, list);",
"  await new Promise(function (r) { setTimeout(r, ms || 400); });",
"  window.__pad.set(0, 0, []);",
"  return true;",
"};",
"window.__tap = async function (btn, ms) {",
"  window.__pad.set(0, 0, [btn]);",
"  await new Promise(function (r) { setTimeout(r, ms || 140); });",
"  window.__pad.set(0, 0, []);",
"  await new Promise(function (r) { setTimeout(r, 130); });",
"  return true;",
"};",
"window.__steer = async function (sel, maxMs) {",
"  var t0 = Date.now();",
"  while (Date.now() - t0 < (maxMs || 6000)) {",
"    var els = document.querySelectorAll(sel), el = null;",
"    for (var i = 0; i < els.length; i++) {",
"      var q = els[i].getBoundingClientRect();",
"      if (q.width > 2 && q.height > 2) { el = els[i]; break; }",
"    }",
"    if (!el) { window.__pad.set(0, 0, []); return 'no-target'; }",
"    var r = el.getBoundingClientRect(), c = window.__gp.pos();",
"    var dx = (r.left + r.width / 2) - c.x, dy = (r.top + r.height / 2) - c.y;",
"    var under = document.elementFromPoint(c.x, c.y);",
"    if (under && (under === el || el.contains(under))) { window.__pad.set(0, 0, []); return 'ok'; }",
"    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) { window.__pad.set(0, 0, []); return 'ok'; }",
"    window.__pad.set(Math.max(-1, Math.min(1, dx / 45)), Math.max(-1, Math.min(1, dy / 45)), []);",
"    await new Promise(function (r) { setTimeout(r, 30); });",
"  }",
"  window.__pad.set(0, 0, []);",
"  return 'timeout';",
"};",
"window.__tapAt = async function (sel, maxMs) {",
"  var st = await window.__steer(sel, maxMs);",
"  if (st !== 'ok') return st;",
"  await window.__tap(0, 130);",
"  return 'ok';",
"};"
].join(NL);

/* ---------- CDP ---------- */
let seq = 0, ws = null, sid = null;
const pending = new Map();
const errors = [];

function cdp(method, params, sessionId) {
  const id = ++seq;
  const msg = { id, method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error("CDP 超时: " + method)); }
    }, 25000);
  });
}
function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error("CDP 错误 " + m.method + ": " + m.error.message));
    else p.res(m.result);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params && m.params.exceptionDetails;
    errors.push("异常: " + ((d && d.exception && d.exception.description) || (d && d.text) || "?"));
  } else if (m.method === "Runtime.consoleAPICalled" && m.params && m.params.type === "error") {
    errors.push("console.error: " + (m.params.args || []).map((a) => a.value === undefined ? a.description : a.value).join(" "));
  }
}
async function ev(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("页面脚本报错: " + ((d.exception && d.exception.description) || d.text));
  }
  return r.result ? r.result.value : undefined;
}
/* 截图：SHOTS_DIR 里的 gamepad-*.png，用来人工复核虚拟光标与游戏画面 */
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" }, sid);
  fs.writeFileSync(SHOTS + "/" + name + ".png", Buffer.from(r.data, "base64"));
}
async function goto(url) {
  errors.length = 0;
  await cdp("Page.navigate", { url }, sid);
  for (let i = 0; i < 60; i++) {
    try { if (await ev("document.readyState") === "complete") break; } catch (e) { }
    await sleep(150);
  }
  await sleep(400);
  const here = await ev("location.href");
  if (typeof here !== "string" || here.indexOf(BASE) !== 0) {
    throw new Error("页面没打开成功（当前地址 " + here + "）—— 服务器起来了吗？" + BASE);
  }
}
function want(ok, msg) { if (!ok) throw new Error(msg); }

/* ---------- 用例 ---------- */
const CASES = [
{
  name: "gamepad-2048",
  desc: "十字键让棋盘变化",
  run: async () => {
    await goto(BASE + "/games/2048/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { var before = document.getElementById("tiles").innerHTML; var dirs = [15, 12, 14, 13]; for (var i = 0; i < dirs.length; i++) { await window.__hold([dirs[i]], 520); var now = document.getElementById("tiles").innerHTML; if (now !== before) return { ok: true, dir: dirs[i], tiles: document.querySelectorAll(".tile").length }; before = now; } return { ok: false, tiles: document.querySelectorAll(".tile").length }; })()');
    await shot("gamepad-2048");
    want(r && r.ok, "2048：按了四个方向手柄键，棋盘都没变化");
    return "第 " + r.dir + " 号键生效 · " + r.tiles + " 个方块";
  }
},
{
  name: "gamepad-snake",
  desc: "A 开始 / 暂停 / 继续",
  run: async () => {
    await goto(BASE + "/games/snake/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { var ov = document.getElementById("ov"); var onStart = ov.classList.contains("on"); await window.__tap(0); var running = !ov.classList.contains("on"); await window.__tap(0); var title = document.getElementById("ovTitle").textContent; var paused = ov.classList.contains("on") && title.indexOf("暂停") >= 0; await window.__tap(0); var resumed = !ov.classList.contains("on"); return { onStart: onStart, running: running, title: title, paused: paused, resumed: resumed }; })()');
    want(r && r.onStart, "贪吃蛇：开局遮罩不是显示状态");
    want(r.running, "贪吃蛇：按 A 没有开始游戏");
    want(r.paused, "贪吃蛇：再按 A 没有暂停（标题是「" + (r && r.title) + "」）");
    want(r.resumed, "贪吃蛇：第三次按 A 没有继续");
    return "开局遮罩 → A 开始 → A 暂停（" + r.title + "）→ A 继续";
  }
},
{
  name: "gamepad-tetris",
  desc: "A 开始、Start 暂停 / 继续",
  run: async () => {
    await goto(BASE + "/games/tetris/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { var ov = document.getElementById("ov"); var onStart = !ov.classList.contains("hide"); await window.__tap(0); var started = ov.classList.contains("hide"); await window.__tap(9); await new Promise(function (x) { setTimeout(x, 250); }); var paused = !ov.classList.contains("hide"); await window.__tap(9); await new Promise(function (x) { setTimeout(x, 250); }); var resumed = ov.classList.contains("hide"); return { onStart: onStart, started: started, paused: paused, resumed: resumed, ovText: ov.textContent.slice(0, 20) }; })()');
    want(r && r.onStart, "俄罗斯方块：开局遮罩不是显示状态");
    want(r.started, "俄罗斯方块：按 A 没有开始游戏");
    want(r.paused, "俄罗斯方块：按 Start 没有暂停");
    want(r.resumed, "俄罗斯方块：再按 Start 没有继续（遮罩文字 " + (r && r.ovText) + "）");
    return "A 开始 → Start 暂停 → Start 继续";
  }
},
{
  name: "gamepad-tictactoe",
  desc: "摇杆移动光标 + A 落子",
  run: async () => {
    await goto(BASE + "/games/tictactoe/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { var has = !!document.getElementById("gpCursor"); var st = await window.__tapAt(".cell", 7000); var cell = document.querySelectorAll(".cell")[0]; return { cursor: has, steer: st, cls: cell ? cell.className : "", mark: cell ? cell.textContent : "" }; })()');
    await shot("gamepad-tictactoe");
    want(r && r.cursor, "井字棋：手柄连上了但没有出现虚拟光标");
    want(r.steer === "ok", "井字棋：光标没能移到棋格上（" + (r && r.steer) + "）");
    want(/x|o/.test(r.cls) || /[✕◯XO]/.test(r.mark), "井字棋：A 键没能在光标处落子（第 1 格 class=" + (r && r.cls) + " 内容「" + (r && r.mark) + "」）");
    return "光标出现，移动到第 1 格按 A 落子「" + r.mark + "」（" + r.cls + "）";
  }
},
{
  name: "gamepad-memory",
  desc: "摇杆移动光标 + A 翻牌",
  run: async () => {
    await goto(BASE + "/games/memory/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { var st = await window.__tapAt(".card", 7000); var c = document.querySelector(".card"); return { steer: st, cls: c ? c.className : "" }; })()');
    await shot("gamepad-memory");
    want(r && r.steer === "ok", "记忆翻牌：光标没能移到卡片上（" + (r && r.steer) + "）");
    want(/flip/.test(r.cls), "记忆翻牌：A 键没有翻开卡片（class=" + r.cls + "）");
    return "光标移到卡片按 A 翻牌 → " + r.cls;
  }
},
{
  name: "gamepad-whack",
  desc: "Start 开始挑战、摇杆追地鼠按 A 敲",
  run: async () => {
    await goto(BASE + "/games/whack/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { await window.__tap(9); await new Promise(function (x) { setTimeout(x, 350); }); var started = document.getElementById("ov").classList.contains("hide"); if (!started) return { started: false, score: 0, tries: 0 }; var t0 = Date.now(), score = 0, tries = 0; while (Date.now() - t0 < 12000) { var up = document.querySelector(".mole.up"); if (!up) { window.__pad.set(0, 0, []); await new Promise(function (x) { setTimeout(x, 70); }); continue; } var q = up.getBoundingClientRect(), c = window.__gp.pos(); var dx = (q.left + q.width / 2) - c.x, dy = (q.top + q.height / 2) - c.y; if (Math.abs(dx) < 32 && Math.abs(dy) < 32) { tries++; await window.__tap(0, 110); score = Number(document.getElementById("score").textContent) || 0; if (score > 0) break; } else { window.__pad.set(Math.max(-1, Math.min(1, dx / 45)), Math.max(-1, Math.min(1, dy / 45)), []); await new Promise(function (x) { setTimeout(x, 30); }); } } window.__pad.set(0, 0, []); return { started: true, score: score, tries: tries }; })()');
    await shot("gamepad-whack");
    want(r && r.started, "打地鼠：按 Start 没有开始挑战");
    want(r.score > 0, "打地鼠：摇杆追着地鼠按 A，12 秒内一次都没敲中（敲了 " + (r && r.tries) + " 次）");
    return "Start 开始挑战 → 光标追上地鼠按 A，得分 " + r.score;
  }
},
{
  name: "gamepad-blackhole",
  desc: "A 关教学、左摇杆推动黑洞（自带手柄轮询，不走站内 shim）",
  run: async () => {
    await goto(BASE + "/games/blackhole/index.html");
    await ev(HELPERS);
    const r = await ev('(async function () { await window.__tap(0); var closed = !G.tutorial_open; var x0 = G.hole.x, y0 = G.hole.y, t0 = G.time; var t = Date.now(); while (Date.now() - t < 1200) { window.__pad.set(1, 0, []); await new Promise(function (x) { setTimeout(x, 40); }); } window.__pad.set(0, 0, []); await new Promise(function (x) { setTimeout(x, 250); }); return { closed: closed, moved: Math.round(G.hole.x - x0), down: Math.round(G.hole.y - y0), ran: +(G.time - t0).toFixed(2), used: !!G.used_gamepad }; })()');
    await shot("gamepad-blackhole");
    want(r && r.closed, "黑洞：按手柄 A 没有关掉教学遮罩");
    want(r && r.ran > 0.4, "黑洞：主循环没跑（G.time 没涨）" + JSON.stringify(r));
    want(r && r.moved > 10, "黑洞：左摇杆推了 1.2 秒，黑洞没往右走 " + JSON.stringify(r));
    want(r && r.used, "黑洞：摇杆输入没有被识别（G.used_gamepad 还是假）" + JSON.stringify(r));
    return "A 关教学 → 左摇杆右推，黑洞 x +" + r.moved + "（G.time +" + r.ran + "）";
  }
},
{
  name: "gamepad-detail-iframe",
  desc: "详情页：手柄连上后自动把焦点交给 iframe，且 iframe 里的游戏收到手柄输入",
  run: async () => {
    await goto(BASE + "/game/2048");
    const r = await ev('(async function () { var fr = document.getElementById("gameFrame"); if (!fr) return { frame: false }; if (!window.__pad) return { frame: true, pad: false }; for (var i = 0; i < 40; i++) { if (document.activeElement === fr) break; await new Promise(function (x) { setTimeout(x, 250); }); } var focused = document.activeElement === fr; var doc = fr.contentDocument; if (!doc || !doc.getElementById("tiles")) return { frame: true, pad: true, focused: focused, inner: false }; var dirs = [15, 12, 14, 13], used = 0, changed = false; var before = doc.getElementById("tiles").innerHTML; for (var k = 0; k < dirs.length && !changed; k++) { window.__pad.set(0, 0, [dirs[k]]); await new Promise(function (x) { setTimeout(x, 550); }); window.__pad.set(0, 0, []); var now = doc.getElementById("tiles").innerHTML; if (now !== before) { changed = true; used = dirs[k]; } before = now; } return { frame: true, pad: true, inner: true, focused: focused, changed: changed, dir: used, hint: (document.querySelector(".player-hint") || {}).textContent || "" }; })()');
    await shot("gamepad-detail-iframe");
    want(r && r.frame, "详情页：没有找到 #gameFrame");
    want(r.pad, "详情页：假手柄没注入");
    want(r.focused, "详情页：检测到手柄后没有把焦点交给游戏 iframe");
    want(r.inner, "详情页：拿不到 iframe 里的棋盘（同源失败？）");
    want(r.changed, "详情页：在 iframe 里按方向键，棋盘没变化");
    want(/手柄/.test(r.hint), "详情页：操作提示里没有提到手柄（现在：" + r.hint + "）");
    return "自动聚焦 iframe ✓ · iframe 内第 " + r.dir + " 号键生效 · 提示「" + r.hint.slice(0, 40) + "」";
  }
}
];

/* ---------- 跑 ---------- */
async function main() {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/api/me"); if (r.ok) { up = true; break; } } catch (e) { }
    await sleep(500);
  }
  if (!up) throw new Error("服务器连不上：" + BASE + "（先在 game-site 目录起 node server.js）");
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--remote-debugging-port=" + String(PORT),
    "--user-data-dir=" + PROFILE, "about:blank"], { stdio: "ignore" });
  let info = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/version");
      if (res.ok) { info = await res.json(); break; }
    } catch (e) { }
    await sleep(250);
  }
  if (!info) { proc.kill(); throw new Error("Chrome 没起来（CDP " + PORT + "）"); }
  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (e) => onMessage(typeof e.data === "string" ? e.data : String(e.data)));

  const t = await cdp("Target.createTarget", { url: "about:blank" });
  const a = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  sid = a.sessionId;
  await cdp("Page.enable", {}, sid);
  await cdp("Runtime.enable", {}, sid);
  await cdp("Network.enable", {}, sid);
  await cdp("Network.setCacheDisabled", { cacheDisabled: true }, sid);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: FAKE }, sid);

  let bad = 0;
  const list = ONLY ? CASES.filter((c) => c.name.indexOf(ONLY) >= 0) : CASES;
  for (const c of list) {
    try {
      const note = await c.run();
      if (errors.length) throw new Error("页面有报错：" + errors.slice(0, 3).join(" | "));
      console.log("ok   " + c.name.padEnd(22) + " " + c.desc + " → " + note);
    } catch (e) {
      bad++;
      console.log("FAIL " + c.name.padEnd(22) + " " + c.desc);
      console.log("     " + (e && e.message ? e.message : String(e)));
    }
  }
  await cdp("Browser.close").catch(() => { });
  ws.close();
  proc.kill();
  await sleep(120);
  console.log("");
  console.log(bad ? "手柄自测失败 " + bad + " / " + list.length + " 项" : "手柄自测全部通过（" + list.length + " 项）");
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error("手柄自测跑挂了: " + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
});
