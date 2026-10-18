// 三款棋类游戏（五子棋 / 中国象棋 / 国际象棋）的浏览器端验收：
//   1) 人机模式：真的点棋盘落子，AI 会应一手（用页面暴露的 window.BOARD 读数）；
//   2) 联机模式：开两个标签页，A 开房间、B 用 ?room= 加入，A 落子后 B 的棋盘要跟着变。
// 前置条件：站点已在 BASE（默认 http://127.0.0.1:3000）跑起来。
//   node tools/board-games-test.mjs        # 或 pnpm test:boards
// 环境变量：BASE、CHROME、SHOTS_DIR。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const OUT = process.env.SHOTS_DIR || path.join(HERE, '..', 'docs', 'screens');
const PORT = Number(process.env.CDP_PORT || 9231);
/* 线上（远程 BASE）比本机慢：页面多等一会儿再读状态，联机面板与接口也多给几轮 */
const REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);
const SETTLE = REMOTE ? 1500 : 700;
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const CHROME = CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) { console.error('找不到 Chrome / Edge，可用 CHROME 环境变量指定'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const GAMES = [
  { slug: 'gomoku', w: 640, h: 720, label: '五子棋' },
  { slug: 'xiangqi', w: 780, h: 720, label: '中国象棋' },
  { slug: 'chess', w: 780, h: 720, label: '国际象棋' }
];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--disable-extensions', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud, 'about:blank'
], { stdio: 'ignore' });
process.on('exit', function () { try { chrome.kill(); } catch (e) {} });

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
      setTimeout(function () { if (self.pending.has(id)) { self.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
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

async function evalOn(c, expr) {
  // CDP 偶发超时（页面正忙/渲染进程抖动）重试一次，别把它当成页面断言失败
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await evalOnce(c, expr);
    if (!r || typeof r !== "object" || !r.__err || !/^timeout /.test(String(r.__err))) return r;
    await new Promise(function (res) { setTimeout(res, 800); });
  }
  return evalOnce(c, expr);
}
async function evalOnce(c, expr) {
  try {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result ? r.result.value : undefined;
  } catch (e) { return { __err: String(e.message || e) }; }
}

async function load(c, url) {
  c.events.length = 0;
  const done = new Promise(function (res) {
    const iv = setInterval(function () {
      if (c.events.some(function (e) { return e.method === 'Page.loadEventFired'; })) { clearInterval(iv); res(); }
    }, 50);
    setTimeout(function () { clearInterval(iv); res(); }, REMOTE ? 25000 : 10000);
  });
  await c.send('Page.navigate', { url: url });
  await done;
  await sleep(SETTLE);
}

function problems(c) {
  const out = [];
  for (const e of c.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
    }
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      out.push('console.error ' + e.params.args.map(function (a) { return a.value != null ? a.value : (a.description || ''); }).join(' '));
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      /* 线上每页都会多出 Cloudflare 边缘注入的 RUM beacon 那条日志（CSP 已放行）；
         它不属于页面自身报错，跳过，否则线上跑必然假失败 */
      if (String(e.params.entry.text).indexOf('cloudflareinsights.com') >= 0) continue;
      out.push('LOG ' + e.params.entry.text);
    }
  }
  return out;
}

async function click(c, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await c.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
  await sleep(30);
  await c.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
}

async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/** 等 window.BOARD 出现（线上首次加载慢，脚本可能还没执行到尾） */
async function waitBoard(c, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await boardState(c);
    if (st && !st.__err) return st;
    await sleep(250);
  }
  return boardState(c);
}

async function boardState(c) {
  return evalOn(c, '(function(){ try { var b = window.BOARD; if (!b) return null;' +
    ' return { slug: b.slug, mode: b.mode(), moves: b.moveCount(), turn: b.turnText(), over: !!b.over(),' +
    ' rect: b.rect() }; } catch (e) { return { __err: String(e && e.message || e) }; } })()');
}

/** 让页面自己给出「一手能真正走成的点击点」（BOARD.sampleClicks），照它点；没有这个钩子就退化成扫点 */
async function playOneMove(c, tries) {
  const st = await boardState(c);
  if (!st || st.__err || !st.rect) return { ok: false, why: st && st.__err ? st.__err : '拿不到 BOARD.rect()' };
  const before = st.moves;
  for (let round = 0; round < 3; round++) {
    const pts = await evalOn(c, '(function(){ try { var b = window.BOARD;' +
      ' if (!b || !b.sampleClicks) return null; var p = b.sampleClicks(); return (p && p.length) ? p : null;' +
      ' } catch (e) { return null; } })()');
    if (!pts) break;
    for (const p of pts) { await click(c, p.x, p.y); await sleep(260); }
    await sleep(260);
    const now = await boardState(c);
    if (now && !now.__err && now.moves > before) return { ok: true, moves: now.moves, turn: now.turn };
  }
  /* 兜底：在棋盘上扫点（对单点的游戏如五子棋够用） */
  const R = st.rect;
  const cols = 5, rows = 5;
  for (let i = 0; i < (tries || 30); i++) {
    const gx = (i % cols + 0.5) / cols, gy = (Math.floor(i / cols) % rows + 0.5) / rows;
    await click(c, R.left + R.width * gx, R.top + R.height * gy);
    await sleep(220);
    const now = await boardState(c);
    if (now && !now.__err && now.moves > before) return { ok: true, moves: now.moves, turn: now.turn };
  }
  return { ok: false, why: '点了很多次都没有落子（走子数一直是 ' + before + '）' };
}

async function waitMove(c, baseline, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await boardState(c);
    if (st && !st.__err && st.moves > baseline) return st;
    await sleep(180);
  }
  const st = await boardState(c);
  return st && st.moves > baseline ? st : null;
}

/** 通过联机面板开一间房，返回房间码（建房有 1 秒限速，撞上 429 时重试） */
async function createRoom(c) {
  await evalOn(c, "(function(){ var p = document.querySelector('.np-pill'); if (p) p.click(); })()");
  await sleep(REMOTE ? 900 : 250);
  for (let i = 0; i < 3; i++) {
    await evalOn(c, "(function(){ var b = document.querySelector('.np-panel [data-act=create]'); if (b) b.click(); })()");
    /* 只点一次，然后长轮询等房码：远程建房响应可能超过 1 秒，过去「读不到就再点」会开出第二间房，
       房主页面的状态跟着第二间走、访客却加入了第一间，于是房主永远停在「等待对手加入」、落子无效。 */
    const t0 = Date.now();
    const budget = REMOTE ? 9000 : 3000;
    while (Date.now() - t0 < budget) {
      const code = await evalOn(c, "(function(){ var e = document.querySelector('.np-panel .np-code'); return e ? e.textContent.trim() : ''; })()");
      if (code && /^[A-Z0-9]{6}$/.test(code)) return code;
      await sleep(300);
    }
    /* 等足时间仍没有房码：多半是撞上建房限速，过掉限速窗再试一次 */
    await sleep(1200);
  }
  return '';
}

async function onlineCheck(game) {
  const w = game.w, h = game.h;
  const a = await newPage(w, h);
  const b = await newPage(w, h);
  try {
    await load(a, BASE + '/games/' + game.slug + '/index.html');
    /* 用户的实际操作是先在页面上切到「联机」，再开房 */
    await evalOn(a, "(function(){ window.BOARD.setMode('online'); })()");
    await sleep(500);
    const code = await createRoom(a);
    ok(game.label + ' 联机：开房间拿到 6 位房间码', !!code, code);
    if (!code) return;
    await load(b, BASE + '/games/' + game.slug + '/index.html?room=' + code);
    await sleep(REMOTE ? 5000 : 2500);
    await waitBoard(b, REMOTE ? 12000 : 3000);
    const sb = await boardState(b);
    const bcode = await evalOn(b, "(function(){ var e = document.querySelector('.np-code'); return e ? e.textContent.trim() : ''; })()");
    ok(game.label + ' 联机：第二位玩家用 ?room= 自动加入并进入对局', !!sb && !sb.__err && sb.mode === 'online' && bcode === code, { state: sb, guestCode: bcode, code: code });
    const before = (await boardState(b)).moves;
    const move = await playOneMove(a, 30);
    ok(game.label + ' 联机：房主在棋盘上落子成功', move.ok, move);
    const got = await waitMove(b, before, REMOTE ? 14000 : 8000);
    ok(game.label + ' 联机：对手的棋盘同步到这一手', !!got, { before: before, after: got && got.moves });
    await shot(a, 'board-' + game.slug + '-online-host');
    await shot(b, 'board-' + game.slug + '-online-guest');
  } finally {
    a.close(); b.close();
  }
}

async function aiCheck(game) {
  const c = await newPage(game.w, game.h);
  try {
    await load(c, BASE + '/games/' + game.slug + '/index.html');
    const errs = problems(c);
    ok(game.label + ' 页面加载无 JS 报错', errs.length === 0, errs.slice(0, 3));
    const st0 = await waitBoard(c, REMOTE ? 12000 : 3000);
    ok(game.label + ' 暴露了 window.BOARD 调试句柄', !!st0 && !st0.__err, st0);
    if (!st0 || st0.__err) return;
    await evalOn(c, "(function(){ window.BOARD.setMode('ai'); })()");
    await sleep(300);
    const before = (await boardState(c)).moves;
    const mine = await playOneMove(c, 30);
    ok(game.label + ' 人机：在棋盘上点一下能落子', mine.ok, mine);
    if (!mine.ok) return;
    /* 我方一手 + AI 一手 = 走子数至少 +2（AI 可能在我读状态前就应完了） */
    const reply = await waitMove(c, before + 1, 9000);
    ok(game.label + ' 人机：AI 应了一手', !!reply, { before: before, after: mine.moves, now: reply && reply.moves });
    ok(game.label + ' 人机：提示文案能读出轮到谁', !!String((await boardState(c)).turn).length, (await boardState(c)).turn);
    await shot(c, 'board-' + game.slug + '-ai');
    ok(game.label + ' 人机：跑完没有新增 JS 报错', problems(c).length === 0, problems(c).slice(0, 2));
  } finally { c.close(); }
}

async function main() {
  await ready();
  console.log('棋类游戏浏览器验收：' + BASE);
  const home = await newPage(900, 700);
  try {
    await load(home, BASE + '/');
    const h = await evalOn(home, "document.querySelector('.grid') ? document.querySelectorAll('.grid .card').length : -1");
    ok('首页仍能正常打开（拿到游戏卡片数）', typeof h === 'number' && h > 0, h);
  } finally { home.close(); }
  for (const g of GAMES) {
    console.log('');
    console.log('== ' + g.label + '（' + g.slug + '）==');
    await aiCheck(g);
    await onlineCheck(g);
  }
  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
}

main().catch(function (e) { console.error('测试脚本自身出错：', e); process.exit(2); });
