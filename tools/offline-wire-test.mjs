/* offline-wire-test.mjs —— OfflineWire（离线兜底接线）自测
 * 用法：node tools/offline-wire-test.mjs
 * 在 vm 沙箱里同时载入 public/js/offline-queue.js 与 public/js/offline-wire.js：
 * A 段用假 window/FormData 验接线的取舍（在线透明 / 断网接管 / 去重键 / 只挂一次 / 提示位）；
 * B 段验真队列模块在没 IndexedDB 的宿主里降级 memory 后仍能 enqueue/list/onChange。
 * 不开端口、不碰真库、不碰浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_SRC = fs.readFileSync(path.join(ROOT, 'public/js/offline-queue.js'), 'utf8');
const WIRE_SRC = fs.readFileSync(path.join(ROOT, 'public/js/offline-wire.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name + (detail === undefined ? '' : '   [' + detail + ']')); }
  else { fail += 1; console.log('  FAIL ' + name + ' :: ' + (detail === undefined ? '' : detail)); }
}
const section = (t) => { console.log(''); console.log('== ' + t + ' =='); };

/* ---------- 沙箱：假 window / document / FormData ---------- */
function makeForm(action, method, label) {
  const attrs = { action: action, method: method || 'post', 'data-offline': label === undefined ? '打卡' : label };
  return {
    __listeners: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
    querySelector() { return null; },
    fire(type, ev) { (this.__listeners[type] || []).forEach((fn) => fn(ev)); }
  };
}
function makeHarness(opts = {}) {
  const noteEl = { textContent: '', hidden: true };
  const forms = opts.forms || [];
  const enqueued = [];
  const onChangeFns = [];
  const document = {
    readyState: 'complete',
    addEventListener() {},
    querySelector(sel) { return sel === '[data-offline-note]' ? noteEl : null; },
    querySelectorAll(sel) { return sel === 'form[data-offline]' ? forms : []; }
  };
  const queue = opts.queue === undefined ? {
    enqueue(entry) { enqueued.push(entry); return Promise.resolve({ id: 'q1' }); },
    pendingCount() { return Promise.resolve(opts.pending || 0); },
    flush(o) { this.flushed = o; return Promise.resolve({ done: 1 }); },
    onChange(fn) { onChangeFns.push(fn); return () => {}; }
  } : opts.queue;
  const win = {
    navigator: { onLine: opts.online !== false },
    location: { href: 'https://game-site.fishport.cn/daily', pathname: '/daily' },
    document, URL, FormData: opts.FormData || FakeFormData, Promise, console,
    OfflineQueue: queue
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(WIRE_SRC, ctx, { filename: 'offline-wire.js' });
  return { win, noteEl, forms, enqueued, onChangeFns, queue };
}
function FakeFormData(form) {
  this.form = form;
  this._pairs = [['day', '2026-10-18'], ['action', 'makeup']];
}
FakeFormData.prototype.append = function (k, v) { this._pairs.push([k, v]); };
FakeFormData.prototype.entries = function () { return this._pairs.slice(); };

/* ---------- A 段：接线的取舍 ---------- */
section('A 接线取舍');
{
  const form = makeForm('/daily/makeup', 'post', '补做打卡');
  const h = makeHarness({ forms: [form], online: true });
  const W = h.win.OfflineWire;
  check('A1 模块挂上 window.OfflineWire', !!W && W.__v === 1);
  check('A2 选择器就是 form[data-offline]', W.SELECTOR === 'form[data-offline]', W.SELECTOR);

  let prevented = 0;
  const ev = { preventDefault() { prevented += 1; } };
  const took = W.handleSubmit(form, ev);
  check('A3 在线时不接管（返回 false、不拦提交）', took === false && prevented === 0, 'took=' + took + ' prevented=' + prevented);
  check('A4 在线时一条都不入队', h.enqueued.length === 0, 'n=' + h.enqueued.length);
}
{
  const form = makeForm('/daily/makeup', 'post', '补做打卡');
  const h = makeHarness({ forms: [form], online: false });
  const W = h.win.OfflineWire;
  let prevented = 0;
  const ev = { preventDefault() { prevented += 1; } };
  const took = W.handleSubmit(form, ev);
  check('A5 断网时接管（返回 true、拦下提交）', took === true && prevented === 1, 'took=' + took + ' prevented=' + prevented);
  check('A6 入队恰好一条', h.enqueued.length === 1, 'n=' + h.enqueued.length);
  const e = h.enqueued[0] || {};
  check('A7 url 折成站内路径', e.url === '/daily/makeup', String(e.url));
  check('A8 method 大写', e.method === 'POST', String(e.method));
  check('A9 去重键 = offline METHOD url', e.tag === 'offline POST /daily/makeup', String(e.tag));
  check('A10 body 是表单体（FormData）', e.body instanceof FakeFormData, String(e.body && e.body.constructor && e.body.constructor.name));
  check('A11 action 缺省时回落当前路径', W.actionOf(makeForm('', 'post')) === '/daily', W.actionOf(makeForm('', 'post')));
  check('A12 带查询串的 action 保留 search', W.actionOf(makeForm('/forum/t/7/reply?from=x')) === '/forum/t/7/reply?from=x', W.actionOf(makeForm('/forum/t/7/reply?from=x')));
}
{
  const form = makeForm('/forum/new', 'post', '发帖');
  const h = makeHarness({ forms: [form], online: false });
  const W = h.win.OfflineWire;
  const n1 = W.wire(form);
  const n2 = W.wire(form);
  const l1 = form.__listeners.submit.length;
  W.wire(form);
  check('A13 wire 返回表单本身', n1 === form && n2 === form);
  check('A14 同一个表单只挂一次监听', l1 === 1 && form.__listeners.submit.length === 1, 'listeners=' + form.__listeners.submit.length);
  let prevented = 0;
  form.fire('submit', { preventDefault() { prevented += 1; } });
  check('A15 监听真的走 handleSubmit（断网拦下并入队）', prevented === 1 && h.enqueued.length === 1, 'prevented=' + prevented + ' n=' + h.enqueued.length);
  check('A16 wireAll 数出带标记的表单', W.wireAll(h.win.document) === 1, String(W.wireAll(h.win.document)));
}
{
  const forms = [makeForm('/daily/makeup', 'post'), makeForm('/forum/new', 'post', '发帖')];
  const h = makeHarness({ forms, online: false, pending: 3 });
  const W = h.win.OfflineWire;
  check('A17 pendingText(0) 是空串', W.pendingText(0) === '');
  check('A18 pendingText(3) 说清条数', /3 条/.test(W.pendingText(3)), W.pendingText(3));
  await new Promise((r) => setTimeout(r, 5));
  W.boot();
  await new Promise((r) => setTimeout(r, 10));
  check('A19 boot 把待传条数画到提示位', /3 条/.test(h.noteEl.textContent) && h.noteEl.hidden === false, h.noteEl.textContent);
  check('A20 boot 订阅了 onChange', h.onChangeFns.length === 1, 'n=' + h.onChangeFns.length);
  check('A21 boot 接管了全部标记表单', forms.every((f) => (f.__listeners.submit || []).length === 1));
  await W.flush();
  check('A22 flush 透传到队列（reason=wire）', h.queue.flushed && h.queue.flushed.reason === 'wire', JSON.stringify(h.queue.flushed));
}
{
  const h = makeHarness({ forms: [], online: false, queue: null });
  const W = h.win.OfflineWire;
  const form = makeForm('/daily/makeup');
  check('A23 没有 OfflineQueue 时安静退回（不接管、不抛）', W.handleSubmit(form, { preventDefault() {} }) === false);
  check('A24 没有队列时 flush 回 null 而不是抛', await W.flush() === null);
}

/* ---------- B 段：真队列模块在沙箱里降级 memory ---------- */
section('B 真队列模块（无 IndexedDB 宿主）');
{
  const win = {
    navigator: { onLine: true },
    location: { href: 'https://game-site.fishport.cn/daily', pathname: '/daily' },
    document: { readyState: 'complete', addEventListener() {} },
    URL, FormData: FakeFormData, Promise, console,
    setTimeout, clearTimeout, Date, JSON, Math, Object, Array, String, Number, Error
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(QUEUE_SRC, ctx, { filename: 'offline-queue.js' });
  const Q = win.OfflineQueue;
  check('B1 真队列挂上 window.OfflineQueue', !!Q && Q.__v === 1);
  const api = ['enqueue', 'list', 'failed', 'pendingCount', 'flush', 'onChange', 'clear', 'storage', 'stats', 'config'];
  check('B2 公开 API 齐全', api.every((k) => typeof Q[k] === 'function'), api.filter((k) => typeof Q[k] !== 'function').join(',') || 'all');
  const st = await Q.stats();
  check('B3 没有 IndexedDB 时降级 memory', Q.storage() === 'memory' && st.storage === 'memory', Q.storage());
  const r = await Q.enqueue({ url: '/daily/makeup', body: 'day=2026-10-18&action=makeup', tag: 'offline POST /daily/makeup' });
  check('B4 enqueue 回条目 id', !!r && !!r.id, String(r && r.id));
  const list = await Q.list();
  check('B5 list 拿得到刚入队的条目', list.length === 1 && list[0].url === '/daily/makeup', 'n=' + list.length);
  const n = await Q.pendingCount();
  check('B6 pendingCount 计数正确', n === 1, 'n=' + n);
  await Q.enqueue({ url: '/daily/makeup', body: 'day=2026-10-18&action=makeup', tag: 'offline POST /daily/makeup' });
  const list2 = await Q.list();
  check('B7 同 tag 未提交条目去重只留一条（沿用原 id）', list2.length === 1 && list2[0].id === list[0].id, 'n=' + list2.length);
  let seen = 0;
  const off = Q.onChange(() => { seen += 1; });
  await Q.enqueue({ url: '/forum/new', body: 'title=x', tag: 'offline POST /forum/new' });
  check('B8 onChange 订阅能收到变更', seen > 0, 'seen=' + seen);
  off();
  const before = seen;
  await Q.enqueue({ url: '/forum/new', body: 'title=y', tag: 'offline POST /forum/new' });
  check('B9 退订后不再收到变更', seen === before, 'before=' + before + ' after=' + seen);
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
