/* 离线兜底接线（第十五批）——断网时把带 data-offline 的表单先塞进 OfflineQueue，联网后自动补传。
 * 传统脚本（非 ES module）、零依赖，挂 window.OfflineWire；真正排队/退避/重试的是
 * public/js/offline-queue.js（window.OfflineQueue）。自测 tools/offline-wire-test.mjs。
 *
 * 用法：给表单加 data-offline="打卡"（这个值只用来拼人话提示），页面里可选放一个
 * <p data-offline-note hidden></p> 当提示位；脚本在 DOMContentLoaded 自动接管站点里所有
 * form[data-offline]。只在 navigator.onLine === false 时接管：在线时原样让浏览器提交，
 * 一行都不改老路径（表单校验、必填、附件都还是浏览器原生行为）。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window) return;
  if (window.OfflineWire && window.OfflineWire.__v === 1) return;

  var SELECTOR = 'form[data-offline]';
  var NOTE_ATTR = 'data-offline-note';
  var V = 1;

  function queue() { return window.OfflineQueue || null; }
  function d() { return window.document || null; }
  function offline() { return !!(window.navigator && window.navigator.onLine === false); }

  /** 提交目标一律折成站内路径：队列里存 '/daily/makeup' 而不是整条 URL（换域名也不作废） */
  function actionOf(form) {
    var raw = String((form && form.getAttribute && form.getAttribute('action')) || '');
    var href = (window.location && window.location.href) || 'http://localhost/';
    if (!raw) raw = (window.location && window.location.pathname) || '/';
    try {
      var u = new window.URL(raw, href);
      return u.pathname + (u.search || '');
    } catch (e) { return raw; }
  }

  function methodOf(form) {
    return String((form && form.getAttribute && form.getAttribute('method')) || 'POST').toUpperCase();
  }

  function labelOf(form) {
    var l = String((form && form.getAttribute && form.getAttribute('data-offline')) || '').trim();
    return l || '这次操作';
  }

  function noteTarget(form) {
    var root = d();
    if (root && root.querySelector) {
      var el = root.querySelector('[' + NOTE_ATTR + ']');
      if (el) return el;
    }
    return form && form.querySelector ? form.querySelector('[' + NOTE_ATTR + ']') : null;
  }

  function note(form, text) {
    var el = noteTarget(form);
    if (el) { el.textContent = text; el.hidden = false; }
    else if (window.console && window.console.info) window.console.info('[offline] ' + text);
  }

  function bodyOf(form) {
    var FD = window.FormData;
    if (!FD || !form) return null;
    try { return new FD(form); } catch (e) { return null; }
  }

  /** 断网提交：入队并接管这次提交；返回 true 表示「已接管」，false 表示「让浏览器自己走」 */
  function handleSubmit(form, ev) {
    var Q = queue();
    if (!Q || !offline()) return false;
    if (ev && ev.preventDefault) ev.preventDefault();
    var url = actionOf(form);
    var body = bodyOf(form);
    var entry = {
      method: methodOf(form),
      url: url,
      body: body || '',
      tag: 'offline ' + methodOf(form) + ' ' + url
    };
    try {
      Promise.resolve(Q.enqueue(entry)).then(function () {
        note(form, '🌐 当前离线：' + labelOf(form) + '已排队，联网后会自动补传（别关这个页面也没关系）');
      }).catch(function () {
        note(form, '离线排队失败，请联网后重试');
      });
    } catch (e) {
      note(form, '离线排队失败，请联网后重试');
    }
    return true;
  }

  /** 给单个表单挂上断网兜底（在线时完全透明） */
  function wire(form) {
    if (!form || !form.addEventListener) return null;
    if (form.__offlineWired === V) return form;
    form.__offlineWired = V;
    form.addEventListener('submit', function (ev) { handleSubmit(form, ev); });
    return form;
  }

  function wireAll(root) {
    var el = root || d();
    if (!el || !el.querySelectorAll) return 0;
    var list = el.querySelectorAll(SELECTOR);
    var n = 0;
    for (var i = 0; i < list.length; i++) if (wire(list[i])) n += 1;
    return n;
  }

  function pendingText(n) {
    if (!n) return '';
    return '⏳ 有 ' + n + ' 条离线操作待补传，联网后自动重试';
  }

  /** 待传条数刷到提示位上（没有提示位就静默） */
  function paint(n) {
    var root = d();
    if (!root || !root.querySelector) return;
    var el = root.querySelector('[' + NOTE_ATTR + ']');
    if (!el) return;
    var text = pendingText(n);
    if (text) { el.textContent = text; el.hidden = false; }
  }

  /** 手动催一趟（联网后由队列自己的 online 监听触发，这里给按钮用） */
  function flush() {
    var Q = queue();
    if (!Q || !Q.flush) return Promise.resolve(null);
    return Promise.resolve(Q.flush({ reason: 'wire' }));
  }

  function refresh() {
    var Q = queue();
    if (!Q || !Q.pendingCount) return;
    Promise.resolve(Q.pendingCount()).then(paint).catch(function () {});
  }

  var booted = false;
  /** 自动接线只跑一次（重复调用不叠监听；后加的表单用 wireAll 显式补挂） */
  function boot() {
    if (booted) return false;
    booted = true;
    wireAll(d());
    refresh();
    var Q = queue();
    if (Q && Q.onChange) Q.onChange(function () { refresh(); });
    return true;
  }

  var api = {
    __v: V, SELECTOR: SELECTOR, NOTE_ATTR: NOTE_ATTR,
    offline: offline, actionOf: actionOf, methodOf: methodOf, labelOf: labelOf,
    bodyOf: bodyOf, note: note, handleSubmit: handleSubmit, wire: wire, wireAll: wireAll,
    pendingText: pendingText, paint: paint, flush: flush, refresh: refresh, boot: boot
  };
  window.OfflineWire = api;

  var root = d();
  if (root) {
    if (root.readyState === 'loading' && root.addEventListener) root.addEventListener('DOMContentLoaded', boot);
    else if (root.readyState) boot();
  }
})();
