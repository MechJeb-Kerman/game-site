/* offline-queue-test.mjs —— OfflineQueue（后台同步队列）自测
 * 用法：node tools/offline-queue-test.mjs
 *
 * A 段（Node 侧，不需要浏览器）：最小假 IndexedDB + 假 fetch + vm 沙箱，
 *   覆盖 API/写穿/去重/顺序与串行/退避/4xx 进 failed/5xx 与网络异常重试/
 *   配额与开库失败降级/跨会话持久化/打卡与投稿两种载荷/单飞锁/自动触发/事件流。
 * B 段（真浏览器侧）：自起无头 Edge（CDP 9391）+ 自带收集器服务（127.0.0.1:3123），
 *   覆盖真 IndexedDB 路径/真 fetch 的表单编码体与 multipart 体/刷新后持久化/
 *   断网重试与 online 事件触发 flush/串行顺序/4xx 进 failed。
 *
 * 端口只占 3123 / 9391，绝不碰 3000 / 4400，也不读真实 data/games.db。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_FILE = path.join(ROOT, 'public', 'js', 'offline-queue.js');
const MODULE_SRC = fs.readFileSync(MODULE_FILE, 'utf8');
const HTTP_PORT = 3123;
const CDP_PORT = 9391;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
}
function section(title) { console.log(''); console.log('== ' + title + ' =='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 200 ? s.slice(0, 200) + '…(截断)' : s;
}

/* ---------- A 段工具：最小假 IndexedDB ---------- */
function idbState() {
  return { data: { queue: new Map(), failed: new Map() }, stores: new Set() };
}
function fakeIDB(state, opts) {
  const o = Object.assign({ openError: null, txDelayMs: 0 }, opts || {});
  const log = { open: 0, close: 0, put: 0, del: 0, clear: 0, getAll: 0, tx: 0, abort: 0 };
  let putError = null;
  function later(fn) { setTimeout(fn, o.txDelayMs); }
  function makeReq(run, err) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      if (err) { req.error = err; if (req.onerror) req.onerror({ target: req }); return; }
      try { req.result = run(); if (req.onsuccess) req.onsuccess({ target: req }); }
      catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); }
    });
    return req;
  }
  function makeTx(name, mode) {
    log.tx += 1;
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null, mode };
    let pending = 0, aborted = false, done = false;
    function settle() {
      if (done) return;
      done = true;
      later(() => {
        if (aborted) { log.abort += 1; if (tx.onabort) tx.onabort({ target: tx }); }
        else if (tx.oncomplete) tx.oncomplete({ target: tx });
      });
    }
    function wrap(req) {
      pending += 1;
      const ok = req.onsuccess, bad = req.onerror;
      req.onsuccess = (ev) => { if (ok) ok(ev); pending -= 1; if (pending === 0) settle(); };
      req.onerror = (ev) => { if (bad) bad(ev); pending -= 1; aborted = true; tx.error = req.error; settle(); };
      return req;
    }
    tx.objectStore = (n) => {
      const map = state.data[n];
      return {
        getAll() { log.getAll += 1; return wrap(makeReq(() => Array.from(map.values()).map((r) => JSON.parse(JSON.stringify(r))))); },
        put(rec) { log.put += 1; const err = putError; putError = null; return wrap(makeReq(() => { map.set(rec.id, JSON.parse(JSON.stringify(rec))); return rec.id; }, err)); },
        delete(id) { log.del += 1; return wrap(makeReq(() => { map.delete(id); return undefined; })); },
        clear() { log.clear += 1; return wrap(makeReq(() => { map.clear(); return undefined; })); }
      };
    };
    return tx;
  }
  return {
    log,
    state,
    failPut(err) { putError = err || new Error('QuotaExceededError: 配额不足'); },
    open(name, version) {
      log.open += 1;
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      later(() => {
        if (o.openError) { req.error = o.openError; if (req.onerror) req.onerror({ target: req }); return; }
        const fresh = state.stores.size === 0;
        req.result = {
          name,
          objectStoreNames: { contains: (n) => state.stores.has(n) },
          createObjectStore: (n) => { state.stores.add(n); if (!state.data[n]) state.data[n] = new Map(); return { name: n }; },
          transaction: makeTx,
          close() { log.close += 1; }
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    }
  };
}

/* ---------- A 段工具：假 fetch / 假 FormData / vm 沙箱 ---------- */
function makeFetcher(handler) {
  const calls = [];
  function fetcher(url, init) {
    const call = { url, method: init && init.method, headers: (init && init.headers) || {}, body: init && init.body, t: Date.now() };
    calls.push(call);
    /* 用 then 链而不是直接取 r.status：handler 写成 async 时也要等它真的结束 */
    return Promise.resolve()
      .then(() => (handler ? handler(call, calls.length) : { status: 200 }))
      .then((r) => {
        if (r instanceof Error) throw r;
        const status = r && typeof r.status === 'number' ? r.status : 200;
        return { ok: status >= 200 && status < 300, status, url, headers: { get: () => null }, text: () => Promise.resolve('') };
      });
  }
  fetcher.calls = calls;
  return fetcher;
}
function FakeFormData() { this.pairs = []; }
FakeFormData.prototype.append = function (n, v) { this.pairs.push([n, v]); };
FakeFormData.prototype.getAll = function (n) { return this.pairs.filter((p) => p[0] === n).map((p) => p[1]); };
FakeFormData.prototype.entries = function () {
  let i = 0;
  const p = this.pairs;
  return { next: () => (i < p.length ? { done: false, value: p[i++] } : { done: true }) };
};
function loadModule(env) {
  const e = env || {};
  const win = { __events: {} };
  win.window = win;
  win.console = console;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.URLSearchParams = URLSearchParams;
  win.AbortController = AbortController;
  win.fetch = e.fetch || null;
  win.FormData = e.FormData;
  win.OFFLINE_QUEUE_CFG = e.cfg || null;
  if (e.indexedDBThrow) {
    Object.defineProperty(win, 'indexedDB', { configurable: true, get() { throw new Error('PrivacyMode: indexedDB 被禁用'); } });
  } else {
    win.indexedDB = e.indexedDB;
  }
  win.addEventListener = (t, fn) => { (win.__events[t] = win.__events[t] || []).push(fn); };
  win.dispatchEvent = (ev) => { const list = win.__events[ev.type] || []; for (const fn of list) fn(ev); return true; };
  const docEvents = {};
  win.document = {
    visibilityState: e.visibilityState || 'visible',
    addEventListener(t, fn) { (docEvents[t] = docEvents[t] || []).push(fn); }
  };
  win.__doc = { dispatch(type) { const list = docEvents[type] || []; for (const fn of list) fn({ type }); } };
  vm.runInContext(MODULE_SRC, vm.createContext(win), { filename: 'public/js/offline-queue.js' });
  return win;
}
const A_CFG = { autoFlushOnLoad: false };
function seedRecord(over) {
  return Object.assign({
    id: 'seed-1', tag: 'seed', method: 'POST', url: '/seeded', createdAt: 5, attempts: 0, nextAt: 5,
    updatedAt: 5, headers: null, contentType: '', bodyKind: 'text', bodyText: 'a=1', formPairs: null,
    lastStatus: null, lastError: '', lastAt: 0
  }, over || {});
}

/* ---------- A 段测试 ---------- */
async function sectionA() {
  section('A 段（Node 侧）：假 IndexedDB + 假 fetch + vm 沙箱');

  /* A1 API 面 / 写穿 */
  {
    const st = idbState();
    const fetcher = makeFetcher(() => ({ status: 200 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: A_CFG });
    const Q = win.OfflineQueue;
    check('A1 规定方法齐全（enqueue/list/pendingCount/flush/onChange/clear + storage/stats/config/failed）',
      !!Q && typeof Q.enqueue === 'function' && typeof Q.list === 'function' && typeof Q.pendingCount === 'function'
      && typeof Q.flush === 'function' && typeof Q.onChange === 'function' && typeof Q.clear === 'function'
      && typeof Q.storage === 'function' && typeof Q.stats === 'function' && typeof Q.config === 'function' && typeof Q.failed === 'function');
    await Q.pendingCount();
    check('A1 存储通道 = idb', Q.storage() === 'idb', Q.storage());
    check('A1 建了 queue / failed 两张表', st.stores.has('queue') && st.stores.has('failed'), Array.from(st.stores).join(','));
    const rec = await Q.enqueue({ url: '/daily/makeup', body: 'day=2026-10-20', tag: 'daily:2026-10-20' });
    const stored = Array.from(st.data.queue.values());
    check('A1 入队即写穿 IndexedDB', stored.length === 1 && stored[0].bodyText === 'day=2026-10-20' && stored[0].tag === 'daily:2026-10-20', '表内=' + stored.length);
    check('A1 enqueue 返回字段完整（method/tag/createdAt/attempts/nextAt/bodyKind）',
      rec.method === 'POST' && rec.tag === 'daily:2026-10-20' && typeof rec.createdAt === 'number' && rec.attempts === 0
      && rec.nextAt === rec.createdAt && rec.bodyKind === 'text' && rec.deduped === false, brief(rec));
    const l = await Q.list();
    l[0].bodyText = '被外部改坏了';
    check('A1 list() 返回副本，改不动内部记录', (await Q.list())[0].bodyText === 'day=2026-10-20');
    check('A1 pendingCount 与 list 一致', (await Q.pendingCount()) === 1 && (await Q.list()).length === 1);
    check('A1 默认配置可见', Q.config().baseDelayMs === 2000 && Q.config().maxDelayMs === 300000, brief(Q.config()).slice(0, 80));
  }

  /* A2 同 tag 去重 */
  {
    const st = idbState();
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: makeFetcher(() => ({ status: 200 })), cfg: A_CFG });
    const Q = win.OfflineQueue;
    const a = await Q.enqueue({ url: '/forum/new', body: 'title=1', tag: 'draft:forum' });
    const b = await Q.enqueue({ url: '/forum/new', body: 'title=2', tag: 'draft:forum' });
    const l = await Q.list();
    check('A2 同 tag 未提交只留最新一条', l.length === 1 && l[0].bodyText === 'title=2' && b.deduped === true && a.deduped === false, '条数=' + l.length);
    check('A2 去重沿用原 id 与 createdAt（保住排队位置）', l[0].id === a.id && l[0].createdAt === a.createdAt, brief({ id: l[0].id === a.id, createdAt: l[0].createdAt }));
    check('A2 去重后 attempts 归零、退避清空', l[0].attempts === 0 && l[0].nextAt === l[0].createdAt && l[0].lastError === '');
    check('A2 去重后 IndexedDB 里也只有一条', st.data.queue.size === 1);
    await Q.enqueue({ url: '/forum/new', body: 'title=3', tag: 'other' });
    check('A2 不同 tag 互不影响', (await Q.pendingCount()) === 2);
  }

  /* A3 顺序 + 串行 */
  {
    const st = idbState();
    const seq = [];
    const fetcher = makeFetcher(async (call) => {
      seq.push('start:' + call.url);
      await sleep(15);
      seq.push('end:' + call.url);
      return { status: 200 };
    });
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.enqueue({ url: '/first', body: 'a=1', tag: 't1', createdAt: 3000 });
    await Q.enqueue({ url: '/third', body: 'a=3', tag: 't3', createdAt: 5000 });
    await Q.enqueue({ url: '/second', body: 'a=2', tag: 't2', createdAt: 4000 });
    const res = await Q.flush({ reason: 'order' });
    check('A3 flush 按 createdAt 升序（乱序入队也按序发）', fetcher.calls.map((c) => c.url).join(',') === '/first,/second,/third', fetcher.calls.map((c) => c.url).join(','));
    check('A3 串行：上一条回来才发下一条', seq.join('|') === 'start:/first|end:/first|start:/second|end:/second|start:/third|end:/third', seq.join('|'));
    check('A3 成功即删除（内存 + IndexedDB）', res.sent.length === 3 && (await Q.pendingCount()) === 0 && st.data.queue.size === 0);
    const one = await Q.enqueue({ url: '/only', body: 'a=9', tag: 'only' });
    await Q.flush({ reason: 'one' });
    check('A3 成功后队列里没有它', (await Q.list()).every((r) => r.id !== one.id));
  }

  /* A4 指数退避 */
  {
    const st = idbState();
    const fetcher = makeFetcher(() => ({ status: 500 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: { autoFlushOnLoad: false, baseDelayMs: 100, maxDelayMs: 1000 } });
    const Q = win.OfflineQueue;
    const T0 = 2000000;
    await Q.enqueue({ url: '/boom', body: 'a=1', tag: 'b', createdAt: T0 });
    await Q.flush({ reason: 'b1', now: T0 });
    let rec = (await Q.list())[0];
    check('A4 首次失败 → attempts=1、nextAt=now+baseDelay', rec.attempts === 1 && rec.lastStatus === 500 && rec.nextAt === T0 + 100, brief({ a: rec.attempts, d: rec.nextAt - T0, e: rec.lastError }));
    const r2 = await Q.flush({ reason: 'b2', now: T0 + 99 });
    check('A4 退避未到 → 跳过不发', r2.skipped.length === 1 && fetcher.calls.length === 1, 'skipped=' + r2.skipped.length + ' calls=' + fetcher.calls.length);
    await Q.flush({ reason: 'b3', now: T0 + 100 });
    rec = (await Q.list())[0];
    check('A4 到点再试 → attempts=2、退避翻倍', rec.attempts === 2 && rec.nextAt === T0 + 100 + 200, brief({ a: rec.attempts, d: rec.nextAt - (T0 + 100) }));
    const r4 = await Q.flush({ reason: 'b4', now: T0 + 150, force: true });
    rec = (await Q.list())[0];
    check('A4 force 无视退避窗口', r4.retried.length === 1 && rec.attempts === 3, 'attempts=' + rec.attempts);
    check('A4 退避状态写穿 IndexedDB', st.data.queue.get(rec.id).attempts === 3 && st.data.queue.get(rec.id).nextAt === rec.nextAt);
    await Q.clear();
    await Q.enqueue({ url: '/cap', body: 'a=1', tag: 'cap', createdAt: T0, attempts: 5 });
    await Q.flush({ reason: 'cap', now: T0 });
    rec = (await Q.list())[0];
    check('A4 退避封顶 maxDelayMs', rec.attempts === 6 && rec.nextAt === T0 + 1000, 'delay=' + (rec.nextAt - T0));
  }

  /* A5 状态码判定：4xx 永久失败 / 5xx 与网络异常重试 */
  {
    const st = idbState();
    const plan = { '/ok200': 200, '/ok204': 204, '/redir302': 302, '/bad400': 400, '/auth401': 401, '/notfound404': 404, '/unprocessable422': 422, '/timeout408': 408, '/early425': 425, '/rate429': 429, '/server500': 500, '/unavail503': 503 };
    const fetcher = makeFetcher((call) => {
      if (call.url === '/neterr') throw new TypeError('Failed to fetch');
      return { status: plan[call.url] === undefined ? 200 : plan[call.url] };
    });
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: A_CFG });
    const Q = win.OfflineQueue;
    const T0 = 1000000;
    const urls = Object.keys(plan).concat(['/neterr']);
    for (let i = 0; i < urls.length; i += 1) await Q.enqueue({ url: urls[i], body: 'a=' + (i + 1), tag: 'v:' + urls[i], createdAt: T0 - urls.length + i });
    const res = await Q.flush({ reason: 'verdicts', now: T0 });
    check('A5 2xx（200/204）算成功并删除', res.sent.length === 2, 'sent=' + res.sent.length);
    check('A5 400/401/404/422 永久失败', res.permanent.length === 4, 'permanent=' + res.permanent.length);
    check('A5 302/408/425/429/500/503/网络异常 保留重试', res.retried.length === 7, 'retried=' + res.retried.length);
    const failedList = await Q.failed();
    check('A5 failed 列表内容正确（保留数据不放回队列）', failedList.map((r) => r.url).sort().join(',') === '/auth401,/bad400,/notfound404,/unprocessable422', failedList.map((r) => r.url).join(','));
    const bad = failedList.filter((r) => r.url === '/bad400')[0];
    check('A5 failed 记录带 lastStatus/lastError/failedAt 与原文', bad.bodyText === 'a=4' && bad.lastStatus === 400 && bad.lastError === 'HTTP 400' && typeof bad.failedAt === 'number', brief({ b: bad.bodyText, s: bad.lastStatus, e: bad.lastError }));
    check('A5 failed 落盘、待提交只剩重试的', st.data.failed.size === 4 && (await Q.pendingCount()) === 7, 'failed表=' + st.data.failed.size + ' queue表=' + st.data.queue.size);
    const res2 = await Q.flush({ reason: 'again', now: T0 });
    check('A5 永久失败的不再重发（bad400 只被请求过一次）', res2.permanent.length === 0 && fetcher.calls.filter((c) => c.url === '/bad400').length === 1, 'bad400 次数=' + fetcher.calls.filter((c) => c.url === '/bad400').length);
    check('A5 重试的还在队列里', (await Q.list()).filter((r) => r.url === '/bad400').length === 0 && (await Q.list()).length === 7);
  }

  /* A6 打卡 / 投稿两种载荷 */
  {
    const st = idbState();
    const fetcher = makeFetcher(() => ({ status: 200 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, FormData: FakeFormData, cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.enqueue({ url: '/daily/makeup', body: 'day=2026-10-20', tag: 'daily:2026-10-20' });
    const fd = new FakeFormData();
    fd.append('title', '离线投稿');
    fd.append('body', '断网时写的正文');
    fd.append('tags', 'a');
    fd.append('tags', 'b');
    fd.append('files', { name: 'note.txt', size: 3 });
    await Q.enqueue({ url: '/forum/new', body: fd, tag: 'forum:draft' });
    await Q.enqueue({ url: '/quiz/submit', body: { title: '离 线!投稿' }, tag: 'obj' });
    await Q.enqueue({ url: '/params', body: new URLSearchParams({ day: '2026-10-21' }), tag: 'params' });
    const res = await Q.flush({ reason: 'payload' });
    const c1 = fetcher.calls[0];
    check('A6 打卡：urlencoded 文本体 + 默认 Content-Type', c1.url === '/daily/makeup' && c1.method === 'POST' && c1.body === 'day=2026-10-20' && c1.headers['Content-Type'] === 'application/x-www-form-urlencoded;charset=UTF-8', brief({ u: c1.url, b: c1.body, ct: c1.headers['Content-Type'] }));
    const c2 = fetcher.calls[1];
    const rebuilt = c2.body;
    check('A6 投稿：还原成 FormData（多值 + 文件都在）', c2.url === '/forum/new' && rebuilt instanceof FakeFormData && rebuilt.pairs.length === 5 && rebuilt.getAll('tags').join(',') === 'a,b' && rebuilt.getAll('files')[0].name === 'note.txt', brief(rebuilt.pairs));
    check('A6 投稿：不手写 Content-Type（boundary 交给浏览器）', c2.headers['Content-Type'] === undefined, brief(c2.headers));
    check('A6 对象体自动编码（空格转 +、! 转义）', fetcher.calls[2].body === 'title=%E7%A6%BB+%E7%BA%BF%21%E6%8A%95%E7%A8%BF', fetcher.calls[2].body);
    check('A6 URLSearchParams 体原样发出', fetcher.calls[3].body === 'day=2026-10-21', fetcher.calls[3].body);
    check('A6 四种载荷都成功提交', res.sent.length === 4 && (await Q.pendingCount()) === 0, 'sent=' + res.sent.length);
  }
}

/* ---------- A 段测试（续）：降级 / 持久化 / 单飞 / 自动触发 / 判定覆盖 ---------- */
async function sectionA2() {
  section('A 段（续）：降级 / 持久化 / 单飞 / 自动触发 / 判定覆盖');

  /* A7 配额爆了 → 内存兜底 */
  {
    const st = idbState();
    const idb = fakeIDB(st);
    const win = loadModule({ indexedDB: idb, fetch: makeFetcher(() => ({ status: 200 })), cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.pendingCount();
    check('A7 退化前 storage = idb', Q.storage() === 'idb', Q.storage());
    idb.failPut(new Error('QuotaExceededError: 配额不足'));
    const rec = await Q.enqueue({ url: '/daily/makeup', body: 'day=q', tag: 'quota' });
    check('A7 配额写失败 → 退化为 memory，条目没丢', Q.storage() === 'memory' && (await Q.pendingCount()) === 1 && !!rec.id, Q.storage() + ' pending=' + (await Q.pendingCount()));
    const putsBefore = idb.log.put;
    await Q.enqueue({ url: '/after', body: 'a=1', tag: 'after' });
    check('A7 退化后不再碰 IndexedDB', idb.log.put === putsBefore, 'put 次数=' + idb.log.put);
    const s = await Q.stats();
    check('A7 stats 暴露 storage 与 dbError', s.storage === 'memory' && typeof s.dbError === 'string' && s.dbError.indexOf('QuotaExceededError') >= 0, brief(s.dbError));
    const res = await Q.flush({ reason: 'mem' });
    check('A7 退化后照常提交', res.sent.length === 2 && res.storage === 'memory' && (await Q.pendingCount()) === 0, brief({ sent: res.sent.length, storage: res.storage }));
  }

  /* A7b 开库失败（隐私模式） */
  {
    const st = idbState();
    const win = loadModule({ indexedDB: fakeIDB(st, { openError: new Error('InvalidStateError: 隐私模式禁用 IndexedDB') }), fetch: makeFetcher(() => ({ status: 200 })), cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.pendingCount();
    const s = await Q.stats();
    check('A7b 开库失败 → memory 兜底并记 dbError', Q.storage() === 'memory' && s.dbError.indexOf('隐私模式') >= 0, brief(s.dbError));
    await Q.enqueue({ url: '/x', body: 'a=1', tag: 'x' });
    check('A7b 该环境下仍能入队与提交', (await Q.flush({ reason: 'x' })).sent.length === 1);
  }

  /* A7c 取 window.indexedDB 直接抛（Firefox / Safari 隐私模式） */
  {
    const win = loadModule({ indexedDBThrow: true, fetch: makeFetcher(() => ({ status: 200 })), cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.pendingCount();
    const s = await Q.stats();
    check('A7c 触碰 indexedDB 抛异常也不崩 → memory', Q.storage() === 'memory' && s.dbError.indexOf('用不了 indexedDB') >= 0, brief(s.dbError));
    await Q.enqueue({ url: '/x', body: 'a=1', tag: 'x' });
    check('A7c 仍能入队与提交', (await Q.flush({ reason: 'x' })).sent.length === 1);
  }

  /* A8 跨会话持久化（模拟刷新：新沙箱 + 同一份 IndexedDB） */
  {
    const st = idbState();
    const fetcher1 = makeFetcher((call) => ({ status: call.url === '/bad' ? 400 : 200 }));
    const win1 = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher1, FormData: FakeFormData, cfg: A_CFG });
    const Q1 = win1.OfflineQueue;
    await Q1.enqueue({ url: '/daily/makeup', body: 'day=2026-10-19', tag: 'd:19', createdAt: 10 });
    await Q1.enqueue({ url: '/bad', body: 'a=bad', tag: 'bad', createdAt: 20 });
    await Q1.flush({ reason: 'first', now: 100 });
    check('A8 第一段：成功 1 条、永久失败 1 条', (await Q1.pendingCount()) === 0 && (await Q1.failed()).length === 1);
    const fd = new FakeFormData();
    fd.append('title', '草稿');
    fd.append('tags', 'x');
    await Q1.enqueue({ url: '/forum/new', body: fd, tag: 'draft:x', createdAt: 30 });
    const before = Array.from(st.data.queue.values())[0];
    const fetcher2 = makeFetcher(() => ({ status: 200 }));
    const win2 = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher2, FormData: FakeFormData, cfg: A_CFG });
    const Q2 = win2.OfflineQueue;
    const l2 = await Q2.list();
    check('A8 刷新后待提交从 IndexedDB 恢复', l2.length === 1 && l2[0].id === before.id && l2[0].url === '/forum/new', brief(l2.map((r) => r.url)));
    check('A8 恢复出 formdata 体（formPairs 完整）', l2[0].bodyKind === 'formdata' && l2[0].formPairs.length === 2 && l2[0].formPairs[0][1] === '草稿', brief(l2[0].formPairs));
    check('A8 failed 表也恢复', (await Q2.failed()).length === 1 && (await Q2.failed())[0].bodyText === 'a=bad');
    const res = await Q2.flush({ reason: 'second' });
    check('A8 刷新后能接着补传', res.sent.length === 1 && res.sent[0] === before.id && fetcher2.calls[0].url === '/forum/new', brief(res.sent));
  }

  /* A9 环境没有 FormData → 永久失败而不是无限重试 */
  {
    const st = idbState();
    const fetcher = makeFetcher(() => ({ status: 200 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: A_CFG });
    const Q = win.OfflineQueue;
    const fd = new FakeFormData();
    fd.append('title', 'x');
    await Q.enqueue({ url: '/forum/new', body: fd, tag: 'fd' });
    const res = await Q.flush({ reason: 'nofd' });
    const f = await Q.failed();
    check('A9 没有 FormData → 直接进 failed（不重试、连请求都不发）', res.permanent.length === 1 && f.length === 1 && fetcher.calls.length === 0, brief({ permanent: res.permanent.length, calls: fetcher.calls.length }));
    check('A9 失败原因记下来了', f.length === 1 && f[0].lastError.indexOf('FormData') >= 0, brief(f[0] && f[0].lastError));
  }

  /* A10 自动触发：online / 可见性 */
  {
    const st = idbState();
    const fetcher = makeFetcher(() => ({ status: 200 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: { autoFlushOnLoad: false, autoFlushMax: 2 } });
    const Q = win.OfflineQueue;
    const events = [];
    Q.onChange((ev) => events.push(ev.type));
    await Q.enqueue({ url: '/e1', body: 'a=1', tag: 'e1' });
    win.dispatchEvent({ type: 'online' });
    await sleep(30);
    let s = await Q.stats();
    check('A10 online 事件触发轻量 flush', !!s.lastFlush && s.lastFlush.reason === 'online' && fetcher.calls.length === 1, brief({ r: s.lastFlush && s.lastFlush.reason, calls: fetcher.calls.length }));
    await Q.enqueue({ url: '/e2', body: 'a=2', tag: 'e2' });
    win.dispatchEvent({ type: 'online' });
    await sleep(30);
    s = await Q.stats();
    check('A10 只注册了一个 online 监听（不重复触发）', win.__events.online.length === 1 && fetcher.calls.length === 2, 'listener=' + win.__events.online.length + ' calls=' + fetcher.calls.length);
    await Q.enqueue({ url: '/e3', body: 'a=3', tag: 'e3' });
    win.document.visibilityState = 'hidden';
    win.__doc.dispatch('visibilitychange');
    await sleep(25);
    check('A10 页面隐藏时可见性变化不 flush', fetcher.calls.length === 2, 'calls=' + fetcher.calls.length);
    win.document.visibilityState = 'visible';
    win.__doc.dispatch('visibilitychange');
    await sleep(30);
    s = await Q.stats();
    check('A10 页面可见时触发 flush', s.lastFlush.reason === 'visible' && fetcher.calls.length === 3, brief({ r: s.lastFlush.reason, calls: fetcher.calls.length }));
    check('A10 事件流含 enqueue / sent', events.indexOf('enqueue') >= 0 && events.indexOf('sent') >= 0, events.join(','));
  }

  /* A10b autoFlushOnLoad + 轻量上限 */
  {
    const st = idbState();
    st.data.queue.set('seed-1', seedRecord());
    const fetcher = makeFetcher(() => ({ status: 200 }));
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: { autoFlushOnLoad: true, autoFlushMax: 1 } });
    const Q = win.OfflineQueue;
    await Q.enqueue({ url: '/load2', body: 'a=2', tag: 'load2' });
    await sleep(60);
    const s = await Q.stats();
    check('A10b 加载后自动来一趟轻量 flush（reason=load，最多 autoFlushMax 条）', !!s.lastFlush && s.lastFlush.reason === 'load' && s.lastFlush.sent.length === 1 && s.pending === 1, brief({ r: s.lastFlush && s.lastFlush.reason, sent: s.lastFlush && s.lastFlush.sent.length, pending: s.pending }));
    check('A10b 剩下的没被吞掉', (await Q.list()).filter((r) => r.url === '/load2').length === 1);
  }

  /* A11 单飞锁 */
  {
    const st = idbState();
    let inflight = 0;
    let maxInflight = 0;
    const fetcher = makeFetcher(async () => {
      inflight += 1;
      if (inflight > maxInflight) maxInflight = inflight;
      await sleep(20);
      inflight -= 1;
      return { status: 200 };
    });
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: fetcher, cfg: A_CFG });
    const Q = win.OfflineQueue;
    await Q.enqueue({ url: '/s1', body: 'a=1', tag: 's1' });
    await Q.enqueue({ url: '/s2', body: 'a=2', tag: 's2' });
    const p1 = Q.flush({ reason: 'one' });
    const p2 = Q.flush({ reason: 'two' });
    check('A11 并发 flush 返回同一个 Promise', p1 === p2, 'p1===p2: ' + (p1 === p2));
    const r1 = await p1;
    const r2 = await p2;
    check('A11 两趟其实是同一趟（reason 取先到的）', r1 === r2 && r1.reason === 'one' && r1.sent.length === 2, brief({ reason: r1.reason, sent: r1.sent.length }));
    check('A11 同一时刻只有一个请求在飞', maxInflight === 1, 'maxInflight=' + maxInflight);
    const r3 = await Q.flush({ reason: 'after' });
    check('A11 flush 结束后能再 flush（空队列返回空结果）', r3.reason === 'after' && r3.sent.length === 0 && r3.skipped.length === 0 && r3.retried.length === 0);
  }

  /* A12 judge 覆盖 + clear + 退订 */
  {
    const st = idbState();
    const win = loadModule({ indexedDB: fakeIDB(st), fetch: makeFetcher(() => ({ status: 200 })), cfg: { autoFlushOnLoad: false, judge: (res) => (res.status === 200 ? 'fail' : 'retry') } });
    const Q = win.OfflineQueue;
    await Q.enqueue({ url: '/login-redirect', body: 'a=1', tag: 'j' });
    const res = await Q.flush({ reason: 'judge' });
    const f = await Q.failed();
    check('A12 config({judge}) 能覆盖判定（302 跟进成 200 也算失败）', res.permanent.length === 1 && f.length === 1 && f[0].lastError === 'HTTP 200', brief(f[0] && f[0].lastError));
    check('A12 config() 读写配置', Q.config({ maxFlushEntries: 7 }).maxFlushEntries === 7 && Q.config().baseDelayMs === 2000);
    await Q.clear();
    check('A12 clear 清空内存与两张表', (await Q.pendingCount()) === 0 && (await Q.failed()).length === 0 && st.data.queue.size === 0 && st.data.failed.size === 0);
    const evs = [];
    const off = Q.onChange((ev) => evs.push(ev.type));
    await Q.enqueue({ url: '/x', body: 'a=1', tag: 'x' });
    off();
    await Q.enqueue({ url: '/y', body: 'a=1', tag: 'y' });
    check('A12 onChange 返回的退订函数有效', evs.length === 1 && evs[0] === 'enqueue', evs.join(','));
  }
}

/* ---------- B 段工具：收集器服务（127.0.0.1:3123） ---------- */
const NL = String.fromCharCode(10);
const HARNESS_CFG = 'window.OFFLINE_QUEUE_CFG = { autoFlushOnLoad: false, baseDelayMs: 300, maxDelayMs: 3000 };';
const HARNESS_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>offline-queue harness</title></head><body>',
  '<h1>offline-queue harness</h1>',
  '<script>' + HARNESS_CFG + '</script>',
  '<script src="/js/offline-queue.js"></script>',
  '<script src="/harness.js"></script>',
  '</body></html>'
].join('');
const NODB_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>offline-queue harness (no indexedDB)</title></head><body>',
  '<h1>no indexedDB harness</h1>',
  '<script>try { Object.defineProperty(window, "indexedDB", { configurable: true, get: function () { throw new Error("PrivacyMode: indexedDB 被禁用"); } }); } catch (e) { window.__nodbErr = String(e); }</script>',
  '<script>' + HARNESS_CFG + '</script>',
  '<script src="/js/offline-queue.js"></script>',
  '<script src="/harness.js"></script>',
  '</body></html>'
].join('');
const HARNESS_JS = [
  'window.__t = {',
  '  q: function () { return window.OfflineQueue; },',
  '  wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },',
  '  online: function () { window.dispatchEvent(new Event("online")); return true; },',
  '  idb: function (store) { return new Promise(function (res, rej) {',
  '    var r = indexedDB.open("qw-offline-queue", 1);',
  '    r.onerror = function () { rej(r.error || new Error("open 失败")); };',
  '    r.onsuccess = function () {',
  '      var d = r.result;',
  '      var tx = d.transaction(store, "readonly");',
  '      var g = tx.objectStore(store).getAll();',
  '      tx.oncomplete = function () { d.close(); res(g.result); };',
  '      tx.onerror = function () { d.close(); rej(tx.error); };',
  '    };',
  '  }); },',
  '  dump: function (store) { return __t.idb(store).then(function (a) { return a.map(function (r) { return { id: r.id, tag: r.tag, url: r.url, bodyKind: r.bodyKind, bodyText: r.bodyText, attempts: r.attempts, nextAt: r.nextAt, formPairs: r.formPairs }; }); }); }',
  '};'
].join(NL);

function startCollector() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1:' + HTTP_PORT);
      const p = u.pathname;
      const page = (html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
      if (p === '/seen') {
        const body = JSON.stringify(seen);
        if (u.searchParams.get('reset') === '1') seen.length = 0;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (p === '/js/offline-queue.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(MODULE_SRC);
        return;
      }
      if (p === '/harness.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(HARNESS_JS);
        return;
      }
      if (p === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
      if (p === '/') { page(HARNESS_HTML); return; }
      if (p === '/nodb.html') { page(NODB_HTML); return; }
      const rec = { n: seen.length + 1, method: req.method, url: req.url, path: p, ct: req.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8'), tStart: Date.now(), tEnd: 0 };
      seen.push(rec);
      const delay = Number(u.searchParams.get('delay') || 0);
      const status = p === '/boom400' ? 400 : Number(u.searchParams.get('status') || 200);
      setTimeout(() => {
        rec.tEnd = Date.now();
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: status < 400, n: rec.n }));
      }, delay);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error('收集器服务起不来（' + HTTP_PORT + '）：' + e.message)));
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve({
      port: HTTP_PORT,
      take() {
        return new Promise((res2, rej2) => {
          const req = http.get('http://127.0.0.1:' + HTTP_PORT + '/seen?reset=1', (r) => {
            let b = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { b += c; });
            r.on('end', () => { try { res2(JSON.parse(b)); } catch (e) { rej2(e); } });
          });
          req.on('error', rej2);
        });
      },
      close() { return new Promise((r2) => server.close(() => r2())); }
    }));
  });
}

/* ---------- B 段工具：无头浏览器 + CDP ---------- */
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('http 超时')));
  });
}
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const events = [];
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    events.push(msg);
  });
  function send(method, params, sessionId) {
    seq += 1;
    const id = seq;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 调用超时：' + method)); }
      }, 20000);
    });
  }
  return { send, events, close() { try { ws.close(); } catch (e) { /* 忽略 */ } } };
}
async function startBrowser(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-cdp-'));
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--mute-audio', '--disable-background-networking', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let version = null;
  for (let i = 0; i < 120 && !version; i += 1) {
    try { version = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); }
    catch (e) { await sleep(150); }
  }
  if (!version) throw new Error('无头浏览器没起来（CDP ' + CDP_PORT + ' 不可达）');
  const client = await cdpConnect(version.webSocketDebuggerUrl);
  return { proc, client, profile, version };
}
async function openPage(client, url) {
  const t = await client.send('Target.createTarget', { url });
  const a = await client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await client.send('Page.enable', {}, sid);
  await client.send('Runtime.enable', {}, sid);
  await client.send('Network.enable', {}, sid);
  await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sid);
  return { targetId: t.targetId, sid };
}
async function evalIn(client, sid, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面内异常：' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result ? r.result.value : undefined;
}
async function waitIn(client, sid, expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalIn(client, sid, expr); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(100);
  }
}

/* ---------- B 段：真浏览器（无头 Edge + 真 IndexedDB + 真 fetch） ---------- */
const CONF = 'Network.emulateNetworkConditions';
const PAGE_URL = 'http://127.0.0.1:' + HTTP_PORT + '/';

async function sectionB() {
  section('B 段（真浏览器侧）：无头 Edge + 真 IndexedDB + 真 fetch，收集器 ' + PAGE_URL);
  const exe = findBrowser();
  if (!exe) {
    check('B0 找到 Edge/Chrome 可执行文件', false, '四个候选路径都不存在');
    return;
  }
  check('B0 找到无头浏览器可执行文件', true, exe);
  let collector = null;
  let browser = null;
  try {
    collector = await startCollector();
    check('B0 自带收集器服务起在 ' + HTTP_PORT + '（不碰 3000 / 4400）', true, PAGE_URL);
    browser = await startBrowser(exe);
    check('B0 无头浏览器 CDP 就绪（' + CDP_PORT + '）', !!browser.version.webSocketDebuggerUrl, brief(browser.version['Browser']));
    const client = browser.client;

    /* --- B1 打卡：真 IndexedDB 通道 + 端到端提交 --- */
    const page = await openPage(client, PAGE_URL);
    const sid = page.sid;
    await waitIn(client, sid, 'typeof window.OfflineQueue === "object" && typeof window.__t === "object"', 20000, '模块与探针就绪');
    await collector.take();
    const b1 = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' await q.enqueue({ url: "/daily/makeup", body: "day=2026-10-20", tag: "daily:2026-10-20" });'
      + ' var inIdb = await window.__t.dump("queue");'
      + ' var res = await q.flush({ reason: "b1" });'
      + ' var afterIdb = await window.__t.dump("queue");'
      + ' return { storage: q.storage(), inIdb: inIdb, sent: res.sent.length, reason: res.reason, afterIdb: afterIdb.length, pending: await q.pendingCount() };'
      + ' })()');
    const seen1 = await collector.take();
    check('B1 真浏览器走 IndexedDB 通道（storage() = idb）', b1.storage === 'idb', b1.storage);
    check('B1 打卡条目写进真 IndexedDB 的 queue 表', b1.inIdb.length === 1 && b1.inIdb[0].bodyText === 'day=2026-10-20' && b1.inIdb[0].tag === 'daily:2026-10-20', brief(b1.inIdb[0]));
    check('B1 真 fetch：POST /daily/makeup + 表单编码体 + 默认 Content-Type',
      seen1.length === 1 && seen1[0].method === 'POST' && seen1[0].path === '/daily/makeup'
      && seen1[0].body === 'day=2026-10-20' && seen1[0].ct.indexOf('application/x-www-form-urlencoded') === 0,
      brief(seen1[0] && { p: seen1[0].path, body: seen1[0].body, ct: seen1[0].ct }));
    check('B1 提交成功后删除：pending=0 且真 IndexedDB 里也没了',
      b1.pending === 0 && b1.sent === 1 && b1.afterIdb === 0,
      brief({ pending: b1.pending, sent: b1.sent, idb: b1.afterIdb }));

    /* --- B2 投稿：真 FormData → 真 multipart --- */
    await collector.take();
    const b2 = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' var fd = new FormData();'
      + ' fd.append("title", "离线投稿");'
      + ' fd.append("body", "断网时写的正文");'
      + ' fd.append("tags", "a");'
      + ' fd.append("tags", "b");'
      + ' fd.append("files", new File(["hello-file"], "note.txt", { type: "text/plain" }));'
      + ' await q.enqueue({ url: "/forum/new", body: fd, tag: "forum:draft" });'
      + ' var inIdb = await window.__t.dump("queue");'
      + ' var res = await q.flush({ reason: "b2" });'
      + ' return { inIdb: inIdb, sent: res.sent.length, pending: await q.pendingCount() };'
      + ' })()');
    const seen2 = await collector.take();
    const raw2 = seen2.length === 1 ? seen2[0].body : '';
    check('B2 真浏览器里 FormData 以真 multipart 发出（字段与文件都在）',
      seen2.length === 1 && seen2[0].path === '/forum/new' && seen2[0].ct.indexOf('multipart/form-data') === 0
      && raw2.indexOf('name="title"') >= 0 && raw2.indexOf('离线投稿') >= 0
      && raw2.indexOf('name="files"') >= 0 && raw2.indexOf('filename="note.txt"') >= 0 && raw2.indexOf('hello-file') >= 0,
      brief(seen2[0] && { ct: seen2[0].ct, len: raw2.length }));
    check('B2 multipart 体在 IndexedDB 里存成 formPairs（不是 blob）',
      b2.inIdb.length === 1 && b2.inIdb[0].bodyKind === 'formdata' && b2.inIdb[0].formPairs.length === 5,
      brief(b2.inIdb[0] && b2.inIdb[0].formPairs));
    check('B2 投稿提交成功后清空', b2.sent === 1 && b2.pending === 0, brief({ sent: b2.sent, pending: b2.pending }));

    /* --- B3 刷新存活：真 IndexedDB 跨文档持久化 --- */
    await collector.take();
    const b3a = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' var r = await q.enqueue({ url: "/daily/makeup", body: "day=2026-10-22", tag: "daily:2026-10-22" });'
      + ' return { id: r.id };'
      + ' })()');
    await client.send('Page.reload', {}, sid);
    await waitIn(client, sid, 'typeof window.OfflineQueue === "object" && typeof window.__t === "object"', 20000, '刷新后模块就绪');
    const b3b = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' var l = await q.list();'
      + ' var st = await q.stats();'
      + ' return { list: l.map(function (r) { return { id: r.id, url: r.url, bodyText: r.bodyText }; }), pending: await q.pendingCount(), lastFlush: st.lastFlush };'
      + ' })()');
    const seen3 = await collector.take();
    check('B3 刷新（新文档）后待提交条目从真 IndexedDB 恢复',
      b3b.list.length === 1 && b3b.list[0].id === b3a.id && b3b.list[0].bodyText === 'day=2026-10-22',
      brief(b3b.list));
    check('B3 autoFlushOnLoad=false 时刷新不会偷偷补传', b3b.pending === 1 && seen3.filter(function (r) { return r.method === 'POST'; }).length === 0
      && !(b3b.lastFlush && b3b.lastFlush.reason === 'load'),
      brief({ pending: b3b.pending, seen: seen3.length, last: b3b.lastFlush && b3b.lastFlush.reason }));

    /* --- B4 真断网（CDP offline）→ 保留重试 → online 事件自动补传 --- */
    await collector.take();
    await client.send(CONF, { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sid);
    const b4a = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' await q.enqueue({ url: "/daily/makeup", body: "day=2026-10-23", tag: "daily:2026-10-23" });'
      + ' var res = await q.flush({ reason: "b4-offline" });'
      + ' var l = await q.list();'
      + ' return { retried: res.retried.length, sent: res.sent.length, permanent: res.permanent.length,'
      + '   err: l[0] && l[0].lastError, attempts: l[0] && l[0].attempts, nextAt: l[0] && l[0].nextAt, pending: await q.pendingCount() };'
      + ' })()');
    const seenOff = await collector.take();
    check('B4 CDP 断网：请求失败 → 保留重试、记错误、attempts=1',
      b4a.retried === 1 && b4a.sent === 0 && b4a.permanent === 0 && b4a.pending === 1 && b4a.attempts === 1 && !!b4a.err,
      brief(b4a));
    check('B4 断网时收集器确实没收到请求', seenOff.length === 0, '收到 ' + seenOff.length + ' 条');
    await client.send(CONF, { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sid);
    await sleep(500);
    const b4b = await evalIn(client, sid, '(async function () {'
      + ' window.__t.online();'
      + ' await window.__t.wait(600);'
      + ' var q = window.OfflineQueue;'
      + ' var st = await q.stats();'
      + ' return { pending: await q.pendingCount(), reason: st.lastFlush && st.lastFlush.reason, sent: st.lastFlush ? st.lastFlush.sent.length : -1 };'
      + ' })()');
    const seenBack = await collector.take();
    check('B4 online 事件触发自动补传（真 fetch 打到服务器）',
      seenBack.length === 1 && seenBack[0].path === '/daily/makeup' && seenBack[0].body === 'day=2026-10-23',
      brief(seenBack[0] && { p: seenBack[0].path, body: seenBack[0].body }));
    check('B4 补传后队列清空且 flush reason = online',
      b4b.pending === 0 && b4b.reason === 'online' && b4b.sent === 1,
      brief({ pending: b4b.pending, reason: b4b.reason, sent: b4b.sent }));

    /* --- B5 真浏览器里的顺序与串行 --- */
    await collector.take();
    const b5 = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' await q.enqueue({ url: "/daily/makeup?delay=250&n=1", body: "day=1", tag: "o1", createdAt: 1000 });'
      + ' await q.enqueue({ url: "/daily/makeup?delay=0&n=2", body: "day=2", tag: "o2", createdAt: 2000 });'
      + ' var res = await q.flush({ reason: "b5" });'
      + ' return { sent: res.sent.length };'
      + ' })()');
    const seen5 = await collector.take();
    check('B5 真浏览器里按 createdAt 升序提交',
      b5.sent === 2 && seen5.length === 2 && seen5[0].url.indexOf('n=1') > 0 && seen5[1].url.indexOf('n=2') > 0,
      brief(seen5.map(function (r) { return r.url; })));
    check('B5 真浏览器里串行：第二条在第一条返回之后才发出（tStart >= tEnd）',
      seen5.length === 2 && seen5[1].tStart >= seen5[0].tEnd,
      brief({ r1: seen5[0] && [seen5[0].tStart, seen5[0].tEnd], r2: seen5[1] && [seen5[1].tStart, seen5[1].tEnd] }));

    /* --- B6 4xx：真浏览器里进 failed 表（保留数据，不重试） --- */
    await collector.take();
    const b6 = await evalIn(client, sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' await q.clear();'
      + ' await q.enqueue({ url: "/boom400", body: "a=1", tag: "b400" });'
      + ' var res = await q.flush({ reason: "b6" });'
      + ' var f = await q.failed();'
      + ' var inIdb = await window.__t.dump("failed");'
      + ' var res2 = await q.flush({ reason: "b6-again" });'
      + ' return { permanent: res.permanent.length, sent: res.sent.length, retried: res.retried.length,'
      + '   f: f.map(function (r) { return { url: r.url, lastStatus: r.lastStatus, bodyText: r.bodyText, failedAt: r.failedAt }; }),'
      + '   idbFailed: inIdb.length, again: res2.entries.length, pending: await q.pendingCount() };'
      + ' })()');
    const seen6 = await collector.take();
    check('B6 4xx 判永久失败：进 failed、只请求一次、不留在重试队列',
      b6.permanent === 1 && b6.f.length === 1 && b6.f[0].lastStatus === 400 && b6.f[0].bodyText === 'a=1'
      && b6.pending === 0 && seen6.length === 1 && b6.again === 0,
      brief(b6.f));
    check('B6 failed 落在真 IndexedDB 的 failed 表（数据没丢）',
      b6.idbFailed === 1 && !!b6.f[0] && typeof b6.f[0].failedAt === 'number',
      'failed 表 ' + b6.idbFailed + ' 条');

    /* --- B7 真页面禁用 indexedDB → memory 兜底仍能提交 --- */
    const page2 = await openPage(client, 'http://127.0.0.1:' + HTTP_PORT + '/nodb.html');
    await waitIn(client, page2.sid, 'typeof window.OfflineQueue === "object" && typeof window.__t === "object"', 20000, 'nodb 页面模块就绪');
    await collector.take();
    const b7 = await evalIn(client, page2.sid, '(async function () {'
      + ' var q = window.OfflineQueue;'
      + ' var pending0 = await q.pendingCount();'
      + ' var st = await q.stats();'
      + ' await q.enqueue({ url: "/daily/makeup", body: "day=mem", tag: "mem" });'
      + ' var res = await q.flush({ reason: "b7" });'
      + ' return { storage: q.storage(), dbError: st.dbError, sent: res.sent.length, pending: await q.pendingCount(), pending0: pending0 };'
      + ' })()');
    const seen7 = await collector.take();
    check('B7 真页面里 indexedDB 取属性即抛 → 降级 memory 并暴露 storage()="memory"',
      b7.storage === 'memory' && typeof b7.dbError === 'string' && b7.dbError.length > 0,
      brief({ storage: b7.storage, dbError: b7.dbError }));
    check('B7 memory 兜底下照样能真提交（不因为存不了就不发）',
      b7.sent === 1 && b7.pending === 0 && seen7.length === 1 && seen7[0].body === 'day=mem',
      brief({ sent: b7.sent, seen: seen7.length, body: seen7[0] && seen7[0].body }));
  } finally {
    if (browser) {
      try { await browser.client.send('Browser.close'); } catch (e) { /* 忽略 */ }
      try { browser.client.close(); } catch (e) { /* 忽略 */ }
      try { browser.proc.kill(); } catch (e) { /* 忽略 */ }
    }
    if (browser) { try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch (e) { /* 浏览器可能还占着句柄，留给系统清理 */ } }
    if (collector) { try { await collector.close(); } catch (e) { /* 忽略 */ } }
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  const lines = MODULE_SRC.split(NL).length;
  console.log('OfflineQueue 自测开始：模块 ' + path.relative(ROOT, MODULE_FILE) + '（' + lines + ' 行），端口 HTTP ' + HTTP_PORT + ' / CDP ' + CDP_PORT);
  await sectionA();
  await sectionA2();
  await sectionB();
  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.log('');
  console.log('测试脚本自身异常：' + (e && e.stack ? e.stack : String(e)));
  console.log('通过 ' + pass + ' / 失败 ' + fail + '（脚本异常中断）');
  process.exitCode = 1;
});
