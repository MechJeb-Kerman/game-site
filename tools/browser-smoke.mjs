// 浏览器端冒烟测试：用无头 Chrome + CDP 真实操作每个游戏，截图并检查 console 报错。
// 前置条件：站点已在 BASE 上跑起来（默认 http://127.0.0.1:3000）。
//   node tools/browser-smoke.mjs        # 或 pnpm smoke
// 环境变量：BASE（站点地址）、CHROME（Chrome 路径）、SHOTS_DIR（截图目录）
//
// 注意：auth 相关目标会用默认管理员 admin / admin123 真登录，并对 2048 投一票、加一次收藏，
// 所以跑完数据库里会多出用户会话与一条评分。想回到干净状态就停掉服务删除 data/games.db 再启动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

// 这些是浏览器策略提示，不是页面故障：
//  - navigator.vibrate 需要真实用户手势，CDP 合成触摸不算手势（真机上点一下就会震）
//  - 无头 Chrome 取 favicon 失败之类
const BENIGN_LOG = [/Blocked call to navigator\.vibrate/, /favicon/i];

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
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' &&
      !BENIGN_LOG.some(function (re) { return re.test(e.params.entry.text); })) {
      out.push('LOG ' + e.params.entry.text);
    }
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

/* 临时探针服务器：验证 CSP 的 frame-src 真的放行「别的 origin」的页面。
 * 响应故意不带 X-Frame-Options；页面一旦被载入就把 PROBE_OK 抛给父页面 ——
 * 被 CSP 挡掉的 frame 根本不会执行脚本，所以在父页面等不到这条消息就是回归。
 */
const probe = http.createServer(function (req, res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>probe</title><script>parent.postMessage("PROBE_OK", "*")</script>');
});
await new Promise(function (r) { probe.listen(0, '127.0.0.1', r); });
const PROBE_URL = 'http://127.0.0.1:' + probe.address().port + '/';

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
  {
    n: 'rank', w: 1280, h: 1100, u: BASE + '/rank',
    js: "(function(){ var tabs = [].slice.call(document.querySelectorAll('.tabs .tab'));" +
        " if (!/排行榜/.test(document.querySelector('h1').textContent)) throw new Error('榜单页没有标题');" +
        " if (tabs.length !== 7) throw new Error('榜单切换应为 7 个，实际 ' + tabs.length);" +
        " var bad = tabs.filter(function(a){ return (a.getAttribute('href') || '').indexOf('/rank?kind=') < 0; });" +
        " if (bad.length) throw new Error('榜单切换链接不对：' + bad.map(function(a){ return a.getAttribute('href'); }).join(','));" +
        " var rows = document.querySelectorAll('.rk-row');" +
        " if (!rows.length && !document.querySelector('.empty')) throw new Error('榜单既没有排行行也没有空状态');" +
        " if (rows.length && !document.querySelector('.rk-val small')) throw new Error('排行行缺少单位');" +
        " return { tabs: tabs.length, rows: rows.length, on: (document.querySelector('.tab.on') || {}).textContent || ''," +
        "   first: (document.querySelector('.rk-title') || {}).textContent || '', mv: (document.querySelector('.mv') || {}).textContent || '' }; })()"
  },
  {
    n: 'search-suggest', w: 1280, h: 1000, u: HOME,
    js: "(async function(){" +
        " function type(v){ var i = document.querySelector('.search input[name=q]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }" +
        " function read(){ var b = document.getElementById('sug'); return { hidden: b.hidden, rows: [].slice.call(b.querySelectorAll('a')).map(function(a){ return { t: (a.querySelector('.s-t') || {}).textContent || '', href: a.getAttribute('href') }; }) }; }" +
        " function must(one, how){ if (one.hidden) throw new Error(how + '：建议框没出现');" +
        "   if (!one.rows.some(function(r){ return /贪吃蛇/.test(r.t); })) throw new Error(how + '：建议里没有贪吃蛇 ' + JSON.stringify(one.rows)); }" +
        " type('tcs'); await new Promise(function(r){ setTimeout(r, 700); }); var a = read();" +
        " type('tanchishe'); await new Promise(function(r){ setTimeout(r, 600); }); var b = read();" +
        " type('贪吃蛇'); await new Promise(function(r){ setTimeout(r, 600); }); var c = read();" +
        " type('2048'); await new Promise(function(r){ setTimeout(r, 600); }); var e = read();" +
        " type('zzzz'); await new Promise(function(r){ setTimeout(r, 600); }); var d = read();" +
        " must(a, '首字母 tcs'); must(b, '全拼 tanchishe'); must(c, '中文');" +
        " if (!/snake/.test(a.rows[0].href)) throw new Error('建议链接不对：' + a.rows[0].href);" +
        " if (!e.rows.length || !/2048/.test(e.rows[0].t)) throw new Error('相关度排序不对，2048 应排第一：' + JSON.stringify(e.rows));" +
        " if (d.rows.length) throw new Error('没有结果时不该有建议链接：' + JSON.stringify(d.rows));" +
        " return { initials: a.rows[0].t, full: b.rows[0].t, cn: c.rows[0].t, top: e.rows[0].t, none: d.hidden ? 'hidden' : 'empty-tip' }; })()"
  },
  {
    n: 'changelog', w: 1280, h: 1200, u: BASE + '/changelog',
    js: "(function(){ var items = [].slice.call(document.querySelectorAll('.log-list li'));" +
        " if (!/更新说明/.test(document.querySelector('h1').textContent)) throw new Error('更新说明没有标题：' + document.querySelector('h1').textContent);" +
        " if (!items.length) throw new Error('更新说明一条提交都没有');" +
        " if (!document.querySelectorAll('.log-kind').length) throw new Error('更新说明没有提交类型标签');" +
        " if (!document.querySelectorAll('.log-list code').length) throw new Error('更新说明没有提交短哈希');" +
        " return { rows: items.length, kinds: document.querySelectorAll('.log-kind').length, head: (document.querySelector('.page-count') || {}).textContent || '' }; })()"
  },
  {
    n: 'notice', w: 1280, h: 1000, u: BASE + '/notice',
    js: "(function(){ var items = [].slice.call(document.querySelectorAll('.notice-item'));" +
        " if (!/公告/.test(document.querySelector('h1').textContent)) throw new Error('公告页没有标题：' + document.querySelector('h1').textContent);" +
        " var bad = items.filter(function(li){ var a = li.querySelector('a'); return !a || (a.getAttribute('href') || '').indexOf('/notice/') !== 0; });" +
        " if (bad.length) throw new Error('公告条目链接不对');" +
        " return { items: items.length, first: items.length ? (items[0].querySelector('.ni-title') || {}).textContent || '' : ''," +
        "   pinned: document.querySelectorAll('.notice-item.pinned').length }; })()"
  },
  {
    n: 'notice-banner', w: 1280, h: 1050, u: HOME,
    js: "(async function(){ var bar = document.querySelector('.notice-bar');" +
        " if (!bar) return { banner: false };" +
        " var slug = bar.getAttribute('data-slug') || '';" +
        " bar.querySelector('.nb-close').click();" +
        " await new Promise(function(r){ setTimeout(r, 250); });" +
        " var gone = !document.querySelector('.notice-bar') || getComputedStyle(document.querySelector('.notice-bar')).display === 'none';" +
        " var off = localStorage.getItem('noticeOff:' + slug);" +
        " if (!gone) throw new Error('点了关闭横幅还在');" +
        " if (!off) throw new Error('关闭没写 localStorage：noticeOff:' + slug);" +
        " return { banner: true, slug: slug, off: off, href: (bar.querySelector('.nb-txt') || {}).getAttribute ? bar.querySelector('.nb-txt').getAttribute('href') : '' }; })()"
  },
  {
    n: 'forum', w: 1280, h: 1100, u: BASE + '/forum',
    js: "(function(){ var h1 = (document.querySelector('h1') || {}).textContent || '';" +
        " if (!/论坛/.test(h1)) throw new Error('论坛首页没有标题：' + h1);" +
        " var boards = [].slice.call(document.querySelectorAll('.fboards li a'));" +
        " if (boards.length < 4) throw new Error('板块导航不对：' + boards.length);" +
        " if (!boards.some(function(a){ return /综合讨论/.test(a.textContent); })) throw new Error('没有综合讨论板块');" +
        " if (!document.querySelector('a[href$=\"/forum/new\"]')) throw new Error('没有「发新帖」入口');" +
        " if (!document.querySelector('.forum-search')) throw new Error('论坛没有搜索框');" +
        " return { boards: boards.length, threads: document.querySelectorAll('.thr').length, h1: h1.trim() }; })()"
  },
  {
    n: 'forum-thread', w: 1280, h: 1100, u: BASE + '/forum',
    js: "(async function(){ var a = document.querySelector('.thr-link');" +
        " if (!a) return { threads: 0, mode: 'empty' };" +
        " var href = a.getAttribute('href');" +
        " var html = await (await fetch(href)).text();" +
        " var doc = new DOMParser().parseFromString(html, 'text/html');" +
        " var form = doc.querySelector('form.fpost-form');" +
        " var gate = doc.querySelector('.forum-gate');" +
        " if (!form && !gate) throw new Error('主题页既没有回复表单也没有说明为什么不能发帖');" +
        " if (!form) return { href: href, posts: doc.querySelectorAll('.fpost').length, mode: 'gate', why: gate.textContent.trim().slice(0, 30) };" +
        " var tok = form.querySelector('input[name=form_token]');" +
        " if (!tok || !/^[0-9a-f]{32}$/.test(tok.value)) throw new Error('回复表单没有一次性令牌：' + (tok && tok.value));" +
        " var hp = form.querySelector('.hp');" +
        " var hpInput = hp ? hp.querySelector('input') : null;" +
        " if (!hpInput) throw new Error('回复表单没有蜜罐字段');" +
        " if (!hp.hasAttribute('hidden')) throw new Error('蜜罐字段没藏起来（浏览器里应该看不见）');" +
        " return { href: href, posts: doc.querySelectorAll('.fpost').length, mode: 'form', hp: hpInput.name, token: tok.value.slice(0, 6) + '…' }; })()"
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
  },
  {
    n: 'game-blackhole', w: 1120, h: 760, u: BASE + '/games/blackhole/index.html',
    /* 黑洞是第 7 款、自带手柄轮询，这里只验「主循环真的在跑」：按任意键关教学 → 方向键移动 →
       G.time 必须增长（暂停时它不涨），G.hole 坐标必须真的变。 */
    js: '(async function(){' +
        ' var before = G.time;' +
        " document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true}));" +
        ' await new Promise(function(r){setTimeout(r,320)});' +
        ' var tutorial = G.tutorial_open;' +
        ' var x0 = G.hole.x, y0 = G.hole.y;' +
        press(['ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowDown']) +
        " document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));" +
        " document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',bubbles:true}));" +
        ' await new Promise(function(r){setTimeout(r,400)});' +
        ' var res = { ran: +(G.time - before).toFixed(2), tutorial: tutorial, moved: Math.round(Math.abs(G.hole.x - x0) + Math.abs(G.hole.y - y0)), mass: +G.hole.mass.toFixed(1), state: G.state };' +
        " if (res.tutorial) throw new Error('按任意键没关掉教学遮罩 ' + JSON.stringify(res));" +
        " if (!(res.ran > 0.4)) throw new Error('主循环没跑（G.time 没涨）' + JSON.stringify(res));" +
        " if (!(res.moved > 8)) throw new Error('方向键没能移动黑洞 ' + JSON.stringify(res));" +
        ' return res; })()'
  },
  {
    /* 导航页：门户主机（fishport.cn / www）的根路径直接渲染它，这里走同一条渲染路径（/nav）。
       卡片必须全是外站 https 直链，mc / send / rsend 不出现在链接里。 */
    n: 'nav', w: 1180, h: 1000, u: BASE + '/nav',
    js: "(function(){" +
        " var links = [].slice.call(document.querySelectorAll('a.pf-link'));" +
        " if (links.length < 5) throw new Error('导航卡片太少：' + links.length);" +
        " var hosts = links.map(function(a){ return a.href.replace(/^https:\\/\\//, '').replace(/\\/$/, ''); });" +
        " var bad = hosts.filter(function(h){ return /^(mc|send|rsend)\\./.test(h) || !/^https:/.test('https://' + h); });" +
        " if (bad.length) throw new Error('导航里混进了不该导航的主机：' + JSON.stringify(bad));" +
        " if (!links.every(function(a){ return a.target === '_blank' && a.rel.indexOf('noopener') >= 0; })) throw new Error('导航卡片不是新窗口外链');" +
        " var groups = [].slice.call(document.querySelectorAll('.pf-group h2')).map(function(h){ return h.textContent.trim(); });" +
        " if (!groups.length) throw new Error('导航页没有分组');" +
        " return { cards: links.length, hosts: hosts, groups: groups }; })()"
  },
  {
    n: 'game-gomoku', w: 640, h: 720, u: BASE + '/games/gomoku/index.html',
    js: "(async function(){ var b = window.BOARD; if (!b) throw new Error('五子棋：没有 window.BOARD 调试句柄');" +
        " if (b.slug !== 'gomoku') throw new Error('五子棋：BOARD.slug 不对：' + b.slug);" +
        " var R = b.rect(); if (!R || R.width < 120 || R.height < 120) throw new Error('五子棋：棋盘区域太小 ' + JSON.stringify(R));" +
        " if (!window.NetPlay) throw new Error('五子棋：net-play.js 没加载');" +
        /* 联机小部件可能懒挂载（点了「联机对战」才出现），所以按用户的方式切过去再验，而不是要求一进页面就有 */
        " b.setMode('online');" +
        " await new Promise(function(r){ setTimeout(r, 500); });" +
        " if (!document.querySelector('.np-pill')) throw new Error('五子棋：切到联机模式后没有联机入口');" +
        " return { mode: b.mode(), moves: b.moveCount(), turn: b.turnText(), rect: Math.round(R.width) + 'x' + Math.round(R.height) }; })()"
  },
  {
    n: 'game-xiangqi', w: 780, h: 720, u: BASE + '/games/xiangqi/index.html',
    js: "(async function(){ var b = window.BOARD; if (!b) throw new Error('中国象棋：没有 window.BOARD 调试句柄');" +
        " if (b.slug !== 'xiangqi') throw new Error('中国象棋：BOARD.slug 不对：' + b.slug);" +
        " var R = b.rect(); if (!R || R.width < 120 || R.height < 120) throw new Error('中国象棋：棋盘区域太小 ' + JSON.stringify(R));" +
        " if (!window.NetPlay) throw new Error('中国象棋：net-play.js 没加载');" +
        /* 联机小部件可能懒挂载（点了「联机对战」才出现），所以按用户的方式切过去再验，而不是要求一进页面就有 */
        " b.setMode('online');" +
        " await new Promise(function(r){ setTimeout(r, 500); });" +
        " if (!document.querySelector('.np-pill')) throw new Error('中国象棋：切到联机模式后没有联机入口');" +
        " return { mode: b.mode(), moves: b.moveCount(), turn: b.turnText(), rect: Math.round(R.width) + 'x' + Math.round(R.height) }; })()"
  },
  {
    n: 'game-chess', w: 780, h: 720, u: BASE + '/games/chess/index.html',
    js: "(async function(){ var b = window.BOARD; if (!b) throw new Error('国际象棋：没有 window.BOARD 调试句柄');" +
        " if (b.slug !== 'chess') throw new Error('国际象棋：BOARD.slug 不对：' + b.slug);" +
        " var R = b.rect(); if (!R || R.width < 120 || R.height < 120) throw new Error('国际象棋：棋盘区域太小 ' + JSON.stringify(R));" +
        " if (!window.NetPlay) throw new Error('国际象棋：net-play.js 没加载');" +
        /* 联机小部件可能懒挂载（点了「联机对战」才出现），所以按用户的方式切过去再验，而不是要求一进页面就有 */
        " b.setMode('online');" +
        " await new Promise(function(r){ setTimeout(r, 500); });" +
        " if (!document.querySelector('.np-pill')) throw new Error('国际象棋：切到联机模式后没有联机入口');" +
        " return { mode: b.mode(), moves: b.moveCount(), turn: b.turnText(), rect: Math.round(R.width) + 'x' + Math.round(R.height) }; })()"
  },
  {
    /* 守住线上那个 bug：投稿可以填外站地址，父页面 CSP 的 frame-src 必须放行 http(s)，
       否则外站游戏框整块变成「该内容被屏蔽了」。探针 = 另一个 origin（127.0.0.1:随机端口）。 */
    n: 'frame-src', w: 800, h: 520, u: BASE + '/game/2048',
    js: "(async function(){" +
        " var got = []; window.addEventListener('message', function(e){ got.push(String(e.data)); });" +
        " var f = document.createElement('iframe'); f.setAttribute('id', 'csp-probe'); f.src = " + JSON.stringify(PROBE_URL) + ";" +
        " document.body.appendChild(f);" +
        " for (var i = 0; i < 60 && got.indexOf('PROBE_OK') < 0; i++) await new Promise(function(r){ setTimeout(r, 100); });" +
        " if (got.indexOf('PROBE_OK') < 0) throw new Error('外站 iframe 没能加载，frame-src 可能又锁回 self 了：收到 ' + JSON.stringify(got));" +
        " return { framed: true, got: got.length }; })()"
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

probe.close();

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
