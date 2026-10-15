// 浏览器端冒烟测试：用无头 Chrome + CDP 真实操作每个游戏，截图并检查 console 报错。
// 前置条件：站点已在 BASE 上跑起来（默认 http://127.0.0.1:3000）。
//   node tools/browser-smoke.mjs        # 或 pnpm smoke
// 环境变量：BASE（站点地址）、CHROME（Chrome 路径）、SHOTS_DIR（截图目录）
//
// 注意：auth 相关目标会用默认管理员 admin / admin123 真登录，并对 2048 投一票、加一次收藏，
// 所以跑完数据库里会多出用户会话与一条评分。想回到干净状态就停掉服务删除 data/games.db 再启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const OUT = process.env.SHOTS_DIR || path.join(HERE, '..', 'docs', 'screens');
const PORT = Number(process.env.CDP_PORT || 9223);
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const CHROME = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) { console.error('找不到 Chrome / Edge，可用 CHROME 环境变量指定'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-extensions', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud, 'about:blank'
], { stdio: 'ignore' });

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Chrome DevTools 端口没能启动');
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    const self = this;
    return new Promise(function (res, rej) {
      self.ws = new WebSocket(self.url);
      self.ws.onopen = function () { res(); };
      self.ws.onerror = function () { rej(new Error('WebSocket 连接失败')); };
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
      setTimeout(function () { if (self.pending.has(id)) { self.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function newPage(width, height) {
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false });
  return c;
}

async function load(c, url) {
  const done = new Promise(function (res) {
    const iv = setInterval(function () {
      if (c.events.some(function (e) { return e.method === 'Page.loadEventFired'; })) { clearInterval(iv); res(); }
    }, 60);
    setTimeout(function () { clearInterval(iv); res(); }, 8000);
  });
  await c.send('Page.navigate', { url: url });
  await done;
  await sleep(500);
}

function problems(c) {
  const out = [];
  for (const e of c.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
    }
    if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].indexOf(e.params.type) >= 0) {
      out.push(e.params.type.toUpperCase() + ' ' + e.params.args.map(function (a) { return a.value != null ? a.value : (a.description || ''); }).join(' '));
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') out.push('LOG ' + e.params.entry.text);
  }
  return out;
}

/** 在当前页面上下文里跑一段表达式，返回它的值 */
async function evalOn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result ? r.result.value : undefined;
}

/** 用默认管理员账号登录一次（cookie 存在浏览器 profile 里，后续标签页共享） */
async function loginAdmin() {
  const c = await newPage(1280, 900);
  await load(c, BASE + '/login');
  const submitted = await evalOn(c, "(function(){ var f = document.querySelector('form.auth-form'); if (!f) return 'no-form'; f.querySelector('input[name=username]').value = 'admin'; f.querySelector('input[name=password]').value = 'admin123'; f.submit(); return 'submitted'; })()");
  await sleep(1800);
  const me = await evalOn(c, "fetch('/api/me').then(function(r){ return r.text(); })");
  const who = me && me.indexOf('"username":"admin"') >= 0 ? 'admin' : '';
  c.close();
  if (!who) throw new Error('管理员登录失败，无法跑需要登录的截图项：' + String(submitted) + ' / ' + String(me));
  console.log('已用默认管理员登录（admin / admin123）');
}

// 生成一段「按下若干方向键」的页面内代码
function press(keys) {
  let out = '';
  for (const k of keys) {
    out += 'document.dispatchEvent(new KeyboardEvent(\'keydown\',{key:' + JSON.stringify(k) + ',bubbles:true}));';
    out += 'await new Promise(function(r){setTimeout(r,150)});';
  }
  return out;
}

const HOME = BASE + '/';
const TARGETS = [
  { n: 'home', w: 1280, h: 1050, u: HOME, js: null },
  { n: 'detail', w: 1280, h: 1000, u: BASE + '/game/tetris', js: null },
  { n: 'login', w: 1280, h: 900, u: BASE + '/login', js: "(function(){ return { title: document.querySelector('h1').textContent, fields: document.querySelectorAll('.auth-form input').length, noindex: /noindex/.test(document.head.innerHTML) }; })()" },
  { n: 'register', w: 1280, h: 900, u: BASE + '/register', js: "(function(){ return { title: document.querySelector('h1').textContent, fields: document.querySelectorAll('.auth-form input').length }; })()" },
  {
    n: 'rating', w: 1280, h: 1000, u: BASE + '/game/2048', auth: true,
    js: '(async function(){' +
        ' var stars = document.querySelectorAll("#stars .star");' +
        ' var before = document.getElementById("rateInfo").textContent;' +
        ' var startOn = document.querySelectorAll("#stars .star.on").length;' +
        ' stars[3].click();' +
        ' await new Promise(function(r){setTimeout(r,800)});' +
        ' document.getElementById("ratePanel").scrollIntoView({ block: "center" });' +
        ' await new Promise(function(r){setTimeout(r,350)});' +
        ' return { startOn: startOn, before: before,' +
        ' on: document.querySelectorAll("#stars .star.on").length,' +
        ' info: document.getElementById("rateInfo").textContent,' +
        ' hasAgg: /aggregateRating/.test(document.documentElement.innerHTML),' +
        ' fav: (document.getElementById("favBtn") ? (document.getElementById("favBtn").click(), true) : false) }; })()'
  },
  {
    n: 'favorites', w: 1280, h: 900, u: BASE + '/favorites', auth: true,
    js: "(function(){ return { heading: document.querySelector('.page-head h1').textContent, cards: document.querySelectorAll('.grid .card').length, sub: document.querySelector('.page-sub').textContent }; })()"
  },
  {
    n: 'submit', w: 1280, h: 1100, u: BASE + '/submit', auth: true,
    js: "(function(){ return { heading: document.querySelector('h1').textContent, fields: document.querySelectorAll('.auth-form input, .auth-form select, .auth-form textarea').length }; })()"
  },
  {
    n: 'admin', w: 1280, h: 1200, u: BASE + '/admin', auth: true,
    js: "(function(){ return { heading: document.querySelector('h1').textContent, stats: [].slice.call(document.querySelectorAll('.stat')).map(function(s){ return s.textContent.trim(); }), rows: document.querySelectorAll('.tbl tbody tr').length, comments: document.querySelectorAll('.cmt-cell').length }; })()"
  },
  { n: 'mobile', w: 390, h: 844, u: HOME, js: null },
  {
    n: 'game-2048', w: 560, h: 760, u: BASE + '/games/2048/index.html',
    js: '(async function(){' + press(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) +
        " return { score: document.getElementById('score').textContent, tiles: document.querySelectorAll('.tile').length }; })()"
  },
  {
    // 2026-10 线上事故：贪吃蛇初始化没给遮罩加 on，开始按钮 display:none、主循环永远不进，
    // 画面静止、按键全无效。这里必须断言「真能开局、真的在跑」，只看 score 抓不到这种 bug。
    n: 'game-snake', w: 560, h: 700, u: BASE + '/games/snake/index.html',
    js: '(async function(){' +
        " var ov = document.querySelector('.overlay');" +
        " var btn = document.getElementById('ovBtn');" +
        " var startVisible = !!(btn && ov.classList.contains('on') && btn.getBoundingClientRect().height > 5);" +
        " if (btn) btn.click();" +
        " await new Promise(function(r){setTimeout(r,350)});" +
        " var started = !document.querySelector('.overlay.on');" +
        press(['ArrowDown', 'ArrowRight']) +
        " document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));" +
        " await new Promise(function(r){setTimeout(r,300)});" +
        " var pausedTitle = document.getElementById('ovTitle').textContent;" +
        " document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));" +
        " await new Promise(function(r){setTimeout(r,300)});" +
        " var res = { startVisible: startVisible, started: started, pausedTitle: pausedTitle," +
        "   running: !document.querySelector('.overlay.on'), score: document.getElementById('score').textContent };" +
        " if (!res.startVisible) throw new Error('开局没有可见的开始按钮 ' + JSON.stringify(res));" +
        " if (!res.started) throw new Error('点了开始按钮遮罩没消失 ' + JSON.stringify(res));" +
        " if (res.pausedTitle !== '已暂停') throw new Error('运行中按空格没暂停，主循环没跑 ' + JSON.stringify(res));" +
        " if (!res.running) throw new Error('恢复后遮罩还在 ' + JSON.stringify(res));" +
        " return res; })()"
  },
  {
    n: 'game-tetris', w: 560, h: 760, u: BASE + '/games/tetris/index.html',
    js: '(async function(){ document.getElementById(\'start\').click(); await new Promise(function(r){setTimeout(r,320)});' +
        press(['ArrowLeft', 'ArrowUp', 'ArrowLeft', ' ']) +
        " await new Promise(function(r){setTimeout(r,500)}); return { score: document.getElementById('score').textContent, level: document.getElementById('level').textContent }; })()"
  },
  {
    n: 'game-tictactoe', w: 560, h: 760, u: BASE + '/games/tictactoe/index.html',
    js: '(async function(){ var snap=function(){ return [].slice.call(document.querySelectorAll(\'.cell\')).map(function(c){ return c.textContent || \'.\'; }).join(\'\'); };' +
        ' var steps=[]; for (const i of [0,4,6]) { document.querySelectorAll(\'.cell\')[i].click(); await new Promise(function(r){setTimeout(r,900)}); steps.push(snap()); }' +
        " return { steps: steps, status: document.getElementById('status').textContent, marks: snap() }; })()"
  },
  {
    n: 'game-memory', w: 560, h: 700, u: BASE + '/games/memory/index.html',
    js: '(async function(){ var all=function(){ return [].slice.call(document.querySelectorAll(\'.card\')); };' +
        ' var bySym={}; all().forEach(function(c){ (bySym[c.dataset.sym]=bySym[c.dataset.sym]||[]).push(c); });' +
        ' var pair=Object.values(bySym)[0]; pair[0].click(); await new Promise(function(r){setTimeout(r,260)}); pair[1].click(); await new Promise(function(r){setTimeout(r,600)});' +
        " return { pairs: document.getElementById('pairs').textContent, done: document.querySelectorAll('.card.done').length, moves: document.getElementById('moves').textContent }; })()"
  },
  {
    n: 'game-whack', w: 560, h: 700, u: BASE + '/games/whack/index.html',
    js: '(async function(){ document.getElementById(\'start\').click(); await new Promise(function(r){setTimeout(r,900)});' +
        ' var hits=0; for (let i=0;i<12;i++){ var up=document.querySelector(\'.mole.up\'); if(up){ up.dispatchEvent(new PointerEvent(\'pointerdown\',{bubbles:true})); hits++; } await new Promise(function(r){setTimeout(r,220)}); }' +
        " return { score: document.getElementById('score').textContent, hits: hits }; })()"
  }
];

await ready();
const results = [];
let loggedIn = false;
for (const t of TARGETS) {
  if (t.auth && !loggedIn) { await loginAdmin(); loggedIn = true; }
  const c = await newPage(t.w, t.h);
  await load(c, t.u);
  let state = null;
  let evalError = null;
  if (t.js) {
    try {
      const r = await c.send('Runtime.evaluate', { expression: t.js, awaitPromise: true, returnByValue: true });
      state = r.result && r.result.value;
      if (r.exceptionDetails) evalError = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
    } catch (e) { evalError = String(e.message); }
  }
  await sleep(250);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, t.n + '.png'), Buffer.from(shot.data, 'base64'));
  results.push({ name: t.n, state: state, evalError: evalError, problems: problems(c) });
  c.close();
}

let bad = 0;
for (const r of results) {
  const isBad = !!(r.evalError || r.problems.length);
  if (isBad) bad++;
  console.log((isBad ? 'FAIL' : 'ok  '), r.name.padEnd(16), JSON.stringify(r.state === null ? null : r.state));
  if (r.evalError) console.log('      eval error:', r.evalError);
  for (const p of r.problems) console.log('       ', p);
}
console.log('');
console.log('截图目录：' + OUT);
console.log(bad ? bad + ' 项有问题' : '全部通过');
console.log('提示：auth 相关项会留下一次管理员登录、一条 2048 评分与一条收藏记录。');

chrome.kill();
try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
