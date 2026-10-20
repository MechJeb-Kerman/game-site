/* 后台同步队列 —— 离线打卡 / 离线投稿先入队，恢复网络再补传。
 * 传统脚本（非 ES module）、零依赖，挂 window.OfflineQueue；自测 tools/offline-queue-test.mjs。
 *
 * API（全部返回 Promise）：
 *   OfflineQueue.enqueue(entry)   entry = { method?, url, body?, tag?, createdAt?, attempts?, headers?, contentType? }
 *   OfflineQueue.list()           待提交条目（createdAt 升序，返回副本）
 *   OfflineQueue.failed()         永久失败条目（含 failedAt）
 *   OfflineQueue.pendingCount()   待提交条数
 *   OfflineQueue.flush(opts?)     opts = { reason?, force?, now?, max? }
 *   OfflineQueue.onChange(fn)     订阅变更，返回退订函数
 *   OfflineQueue.clear()          清空 queue 与 failed
 *   OfflineQueue.storage()        'idb' | 'memory'
 *   OfflineQueue.stats()          { storage, pending, failed, flushing, lastFlush, dbError, nextAt, config }
 *   OfflineQueue.config(patch?)   读 / 改配置（baseDelayMs、maxDelayMs、requestTimeoutMs…）
 *
 * 存储（IndexedDB）：
 *   库名  qw-offline-queue    版本 1
 *   表    queue    待提交，keyPath 'id'
 *   表    failed   永久失败，keyPath 'id'（数据保留，不再重试）
 *   记录字段（两表同构，failed 多一个 failedAt）：
 *     id          string  队列内唯一（q + 时间戳36进制 + 序号 + 随机）
 *     tag         string  去重键，默认 'METHOD url'
 *     method      string  默认 POST
 *     url         string  站内路径（'/daily/makeup'）或绝对地址
 *     createdAt   number  入队毫秒时间戳，flush 按它升序
 *     attempts    number  真发出过几次请求
 *     nextAt      number  下次最早可尝试时间（退避；now < nextAt 则跳过）
 *     updatedAt   number  正文最后一次变化时间（同 tag 被替换时刷新）
 *     headers     object|null
 *     contentType string  空串 = 按 bodyKind 取默认
 *     bodyKind    string  'none' | 'text' | 'formdata'
 *     bodyText    string  bodyKind=text：原样字符串（本站打卡 / 投稿都是表单编码体）
 *     formPairs   array   bodyKind=formdata：[[name, value]]（File 靠结构化克隆存）
 *     lastStatus  number|null  上次 HTTP 状态码
 *     lastError   string  上次失败原因（截 200 字）
 *     lastAt      number  上次尝试时间
 *
 * 语义：
 *   · body：string / URLSearchParams / FormData（可含 File）/ 普通对象（自动编码成表单体，空格转 +，与 URLSearchParams 一致）。
 *     text 体默认 Content-Type: application/x-www-form-urlencoded;charset=UTF-8；formdata 体不设 Content-Type（boundary 交给浏览器）。
 *   · 去重：同 tag 的「未提交」条目只留最新一条——新条目沿用原 id 与 createdAt（保住排队位置），正文与头以新的为准，
 *     attempts 归 0、退避与 lastError 清空。failed 表里的不算未提交，同 tag 再入队是全新一条。
 *   · 顺序：flush 按 createdAt 升序逐条串行（上一条回了才发下一条），单条失败不阻断后面的条目，同一趟里每条最多试一次。
 *   · 退避：delay = min(maxDelayMs, baseDelayMs * 2 的 (attempts-1) 次方)，写进 nextAt；到点之前 flush 会跳过（force 无视）。
 *   · 判定：2xx 成功 → 删除；408 / 425 / 429 与 5xx、status 0、网络异常、超时 → 保留重试；
 *     其余 4xx → 永久失败，搬 failed 表且保留数据。注意 fetch 会跟随 302：会话过期被重定向到 /login 时看到的是 200，
 *     会被当成成功——要更严的判定就传 config({ judge: function (res, rec) { return 'ok' | 'retry' | 'fail'; } })。
 *   · 响应体不读（省内存）：lastError 只记状态码或异常文本。
 *   · 并发：flush 有单飞锁，进行中再调用返回同一个 Promise，绝不并发两趟；online / 可见性触发的都是这条路径上的轻量 flush。
 *   · 持久化：内存副本是权威视图，IndexedDB 只做写穿持久化——隐私模式开不了库、配额写不进时不丢当前会话里已入队的条目，
 *     只是 storage() 从 'idb' 变 'memory'，不再跨会话保留。写 failed 成功后才删 queue；万一崩溃在这中间，下次加载以
 *     failed 为准（同 id 去重）。
 */
(function () {
  'use strict';
  if (window.OfflineQueue && window.OfflineQueue.__v === 1) return;

  var DEFAULTS = {
    dbName: 'qw-offline-queue',
    dbVersion: 1,
    storeQueue: 'queue',
    storeFailed: 'failed',
    baseDelayMs: 2000,
    maxDelayMs: 300000,
    maxFlushEntries: 100,
    autoFlushMax: 10,
    requestTimeoutMs: 20000,
    autoFlushOnLoad: true,
    autoFlushOnOnline: true,
    autoFlushOnVisible: true,
    credentials: 'same-origin',
    fetch: null,
    judge: null
  };
  var cfg = {};
  function copyInto(dst, src) {
    if (!src) return dst;
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
    return dst;
  }
  copyInto(cfg, DEFAULTS);
  if (window.OFFLINE_QUEUE_CFG) copyInto(cfg, window.OFFLINE_QUEUE_CFG);

  /* 内存副本是权威视图，IndexedDB 只是写穿持久化 */
  var mem = { queue: [], failed: [] };
  var mode = 'idb';
  var db = null;
  var dbFailure = null;
  var readyP = null;
  var flushing = null;
  var lastFlush = null;
  var listeners = [];
  var idSeq = 0;

  function nowMs() { return Date.now(); }
  function newId() {
    idSeq += 1;
    return 'q' + nowMs().toString(36) + '-' + idSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function cloneRec(rec) {
    var out = {}, k;
    for (k in rec) if (Object.prototype.hasOwnProperty.call(rec, k)) out[k] = rec[k];
    return out;
  }
  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function errText(e) {
    if (!e) return '';
    var s = (e.name ? e.name + ': ' : '') + (e.message || String(e));
    return s.slice(0, 200);
  }
  function emit(type, rec, extra) {
    var ev = {
      type: type,
      id: rec ? rec.id : null,
      tag: rec ? rec.tag : null,
      url: rec ? rec.url : null,
      status: rec && typeof rec.lastStatus === 'number' ? rec.lastStatus : null,
      attempts: rec ? rec.attempts : 0,
      nextAt: rec ? rec.nextAt : 0,
      pending: mem.queue.length,
      failed: mem.failed.length,
      storage: mode
    };
    if (extra) copyInto(ev, extra);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) { /* 监听器自己的错误不该拖垮队列 */ }
    }
    return ev;
  }

  /* application/x-www-form-urlencoded 编码（与 URLSearchParams 一致：空格转 +，!'()~ 也转义） */
  function encForm(v) {
    return encodeURIComponent(String(v))
      .replace(/%20/g, '+')
      .replace(/[!'()~]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
  }
  function formFromObject(obj) {
    var parts = [], k, v, i;
    for (k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      v = obj[k];
      if (v === undefined || v === null) continue;
      if (isArray(v)) {
        for (i = 0; i < v.length; i++) parts.push(encForm(k) + '=' + encForm(v[i]));
      } else {
        parts.push(encForm(k) + '=' + encForm(v));
      }
    }
    return parts.join('&');
  }
  function isFormDataLike(b) {
    if (!b || typeof b !== 'object') return false;
    if (typeof window.FormData === 'function' && b instanceof window.FormData) return true;
    return typeof b.append === 'function' && typeof b.getAll === 'function' && typeof b.entries === 'function';
  }
  function isSearchParams(b) {
    return !!b && typeof b === 'object' && Object.prototype.toString.call(b) === '[object URLSearchParams]';
  }
  function formPairsOf(fd) {
    var out = [], it, step;
    try { it = fd.entries(); } catch (e) { return out; }
    step = it.next();
    while (!step.done) { out.push([step.value[0], step.value[1]]); step = it.next(); }
    return out;
  }
  function bodyOf(entry) {
    var b = entry.body;
    var ct = typeof entry.contentType === 'string' ? entry.contentType : '';
    var headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : null;
    if (b === undefined || b === null || b === '') return { kind: 'none', headers: headers, contentType: ct };
    if (typeof b === 'string') return { kind: 'text', bodyText: b, headers: headers, contentType: ct };
    if (isSearchParams(b)) return { kind: 'text', bodyText: String(b), headers: headers, contentType: ct };
    if (isFormDataLike(b)) return { kind: 'formdata', formPairs: formPairsOf(b), headers: headers, contentType: ct };
    if (Object.prototype.toString.call(b) === '[object Object]') {
      return { kind: 'text', bodyText: formFromObject(b), headers: headers, contentType: ct };
    }
    throw new Error('OfflineQueue: body 只认 字符串 / URLSearchParams / FormData / 普通对象，收到 ' + Object.prototype.toString.call(b));
  }
  function normalize(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('OfflineQueue.enqueue: 需要 entry 对象');
    if (!entry.url || typeof entry.url !== 'string') throw new Error('OfflineQueue.enqueue: entry.url 必填（字符串）');
    var method = String(entry.method || 'POST').toUpperCase();
    var b = bodyOf(entry);
    var createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : nowMs();
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
      tag: entry.tag ? String(entry.tag) : method + ' ' + entry.url,
      method: method,
      url: entry.url,
      createdAt: createdAt,
      attempts: typeof entry.attempts === 'number' && entry.attempts > 0 ? Math.floor(entry.attempts) : 0,
      nextAt: createdAt,
      updatedAt: nowMs(),
      headers: b.headers,
      contentType: b.contentType || '',
      bodyKind: b.kind,
      bodyText: b.bodyText || '',
      formPairs: b.formPairs || null,
      lastStatus: null,
      lastError: '',
      lastAt: 0
    };
  }
  function pub(rec, extra) {
    var out = cloneRec(rec);
    if (extra) copyInto(out, extra);
    return out;
  }

  /* ---------- IndexedDB：只做写穿持久化，内存副本才是权威视图 ---------- */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = window.indexedDB.open(cfg.dbName, cfg.dbVersion); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(cfg.storeQueue)) d.createObjectStore(cfg.storeQueue, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(cfg.storeFailed)) d.createObjectStore(cfg.storeFailed, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB.open 失败')); };
      req.onblocked = function () { reject(new Error('indexedDB.open 被阻塞')); };
    });
  }
  function idbRun(store, readonly, fn) {
    return new Promise(function (resolve, reject) {
      var tx, req;
      try {
        tx = db.transaction(store, readonly ? 'readonly' : 'readwrite');
        req = fn(tx.objectStore(store));
      } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(req && typeof req === 'object' ? req.result : undefined); };
      tx.onerror = function () { reject(tx.error || (req && req.error) || new Error(store + ' 事务失败')); };
      tx.onabort = function () { reject(tx.error || new Error(store + ' 事务中止')); };
    });
  }
  function idbAll(store) { return idbRun(store, true, function (os) { return os.getAll(); }); }
  function idbPut(store, rec) { return idbRun(store, false, function (os) { return os.put(rec); }); }
  function idbDel(store, id) { return idbRun(store, false, function (os) { return os.delete(id); }); }
  function idbClear(store) { return idbRun(store, false, function (os) { return os.clear(); }); }

  function degrade(e) {
    if (mode === 'memory') return;
    mode = 'memory';
    dbFailure = errText(e) || 'unknown';
    try { if (db) db.close(); } catch (x) {}
    db = null;
    emit('degrade', null, { error: dbFailure });
  }
  function persist(op, store, arg) {
    if (mode === 'memory' || !db) return Promise.resolve(false);
    var p;
    if (op === 'put') p = idbPut(store, arg);
    else if (op === 'del') p = idbDel(store, arg);
    else p = idbClear(store);
    return p.then(function () { return true; }, function (e) { degrade(e); return false; });
  }
  function sanitize(list) {
    var out = [], i, r, rec;
    if (!isArray(list)) return out;
    for (i = 0; i < list.length; i++) {
      r = list[i];
      if (!r || typeof r !== 'object' || !r.id || !r.url) continue;
      rec = {
        id: String(r.id),
        tag: typeof r.tag === 'string' && r.tag ? r.tag : String(r.method || 'POST') + ' ' + String(r.url),
        method: String(r.method || 'POST').toUpperCase(),
        url: String(r.url),
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
        attempts: typeof r.attempts === 'number' && r.attempts > 0 ? Math.floor(r.attempts) : 0,
        nextAt: typeof r.nextAt === 'number' ? r.nextAt : 0,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
        headers: r.headers && typeof r.headers === 'object' ? r.headers : null,
        contentType: typeof r.contentType === 'string' ? r.contentType : '',
        bodyKind: r.bodyKind === 'text' || r.bodyKind === 'formdata' ? r.bodyKind : 'none',
        bodyText: typeof r.bodyText === 'string' ? r.bodyText : '',
        formPairs: isArray(r.formPairs) ? r.formPairs : null,
        lastStatus: typeof r.lastStatus === 'number' ? r.lastStatus : null,
        lastError: typeof r.lastError === 'string' ? r.lastError : '',
        lastAt: typeof r.lastAt === 'number' ? r.lastAt : 0
      };
      if (typeof r.failedAt === 'number') rec.failedAt = r.failedAt;
      out.push(rec);
    }
    return out;
  }
  function byCreated(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }
  function sorted() { return mem.queue.slice().sort(byCreated); }

  function hydrate() {
    var hasIDB = false;
    /* 隐私模式下光是取 window.indexedDB 就可能抛（Firefox / Safari），所以整体兜住 */
    try { hasIDB = !!(window.indexedDB && typeof window.indexedDB.open === 'function'); } catch (e) { hasIDB = false; }
    if (!hasIDB) {
      degrade(new Error('这个环境用不了 indexedDB'));
      return Promise.resolve();
    }
    return idbOpen().then(function (d) {
      db = d;
      try { db.onversionchange = function () { try { db.close(); } catch (e) {} }; } catch (e) {}
      return Promise.all([idbAll(cfg.storeQueue), idbAll(cfg.storeFailed)]);
    }).then(function (lists) {
      var failedList = sanitize(lists[1]);
      var failedIds = {};
      for (var i = 0; i < failedList.length; i++) failedIds[failedList[i].id] = 1;
      /* 崩溃在「写 failed 成功、删 queue 还没做」之间时，以 failed 为准 */
      mem.queue = sanitize(lists[0]).filter(function (r) { return !failedIds[r.id]; });
      mem.failed = failedList;
    }, function (e) {
      degrade(e);
    });
  }
  function ready() {
    if (!readyP) readyP = hydrate();
    return readyP;
  }

  /* ---------- 入队 / 查询 ---------- */
  function enqueue(entry) {
    return ready().then(function () {
      var rec = normalize(entry);
      var i, same = -1;
      for (i = 0; i < mem.queue.length; i++) if (mem.queue[i].tag === rec.tag) { same = i; break; }
      if (same >= 0) {
        rec.id = mem.queue[same].id;
        rec.createdAt = mem.queue[same].createdAt;
        rec.attempts = 0;
        rec.nextAt = rec.createdAt;
        rec.lastStatus = null;
        rec.lastError = '';
        rec.lastAt = 0;
        mem.queue[same] = rec;
        emit('dedupe', rec, { deduped: true });
        return persist('put', cfg.storeQueue, rec).then(function () { return pub(rec, { deduped: true }); });
      }
      mem.queue.push(rec);
      emit('enqueue', rec, { deduped: false });
      return persist('put', cfg.storeQueue, rec).then(function () { return pub(rec, { deduped: false }); });
    });
  }
  function list() {
    return ready().then(function () {
      return sorted().map(function (r) { return cloneRec(r); });
    });
  }
  function failedList() {
    return ready().then(function () {
      return mem.failed.slice().sort(byCreated).map(function (r) { return cloneRec(r); });
    });
  }
  function pendingCount() {
    return ready().then(function () { return mem.queue.length; });
  }
  function removeFrom(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { arr.splice(i, 1); return true; }
    return false;
  }

  /* ---------- 提交 ---------- */
  var RETRY_STATUS = { 0: 1, 408: 1, 425: 1, 429: 1 };
  function classify(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 400 && status < 500 && !RETRY_STATUS[status]) return 'fail';
    return 'retry';
  }
  function delayFor(attempts) {
    var d = cfg.baseDelayMs * Math.pow(2, Math.max(1, attempts) - 1);
    if (!isFinite(d) || d > cfg.maxDelayMs) d = cfg.maxDelayMs;
    return d;
  }
  function permanentError(msg) {
    var e = new Error(msg);
    e.permanent = true;
    return e;
  }
  function buildInit(rec) {
    var init = { method: rec.method, credentials: cfg.credentials, redirect: 'follow', headers: {} };
    copyInto(init.headers, rec.headers || {});
    var hasCT = !!(init.headers['Content-Type'] || init.headers['content-type']);
    if (rec.contentType && !hasCT) { init.headers['Content-Type'] = rec.contentType; hasCT = true; }
    if (rec.bodyKind === 'text') {
      if (!hasCT) init.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      init.body = rec.bodyText;
    } else if (rec.bodyKind === 'formdata') {
      if (typeof window.FormData !== 'function') throw permanentError('这个环境没有 FormData，还原不了 multipart 体');
      var fd = new window.FormData();
      var pairs = rec.formPairs || [];
      for (var i = 0; i < pairs.length; i++) {
        try { fd.append(pairs[i][0], pairs[i][1]); }
        catch (e) { throw permanentError('FormData 字段还原失败：' + errText(e)); }
      }
      init.body = fd; /* 不设 Content-Type：boundary 交给浏览器 */
    }
    return init;
  }
  function request(rec) {
    var fetcher = cfg.fetch;
    if (!fetcher) {
      if (typeof window.fetch !== 'function') return Promise.reject(new Error('这个环境没有 fetch'));
      fetcher = function (u, init) { return window.fetch(u, init); };
    }
    var init, ctrl = null, timer = null;
    try { init = buildInit(rec); } catch (e) { return Promise.reject(e); }
    if (typeof window.AbortController === 'function') {
      try { ctrl = new window.AbortController(); init.signal = ctrl.signal; } catch (e) { ctrl = null; }
    }
    var fetchP = Promise.resolve().then(function () { return fetcher(rec.url, init); });
    var raced = fetchP;
    if (typeof setTimeout === 'function' && cfg.requestTimeoutMs > 0) {
      raced = Promise.race([fetchP, new Promise(function (resolve, reject) {
        timer = setTimeout(function () { reject(new Error('请求超时 ' + cfg.requestTimeoutMs + 'ms')); }, cfg.requestTimeoutMs);
      })]);
    }
    return raced.then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (ctrl) { try { ctrl.abort(); } catch (x) {} }
      throw e;
    });
  }
  function attempt(rec, now) {
    var out = { id: rec.id, tag: rec.tag, url: rec.url, method: rec.method, status: '', httpStatus: null, attempts: rec.attempts + 1, error: '', nextAt: 0, at: now };
    return request(rec).then(function (res) {
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var verdict;
      out.httpStatus = status;
      if (typeof cfg.judge === 'function') {
        try { verdict = cfg.judge(res, pub(rec)); } catch (e) { verdict = 'retry'; }
        if (verdict !== 'ok' && verdict !== 'fail' && verdict !== 'retry') verdict = 'retry';
      } else {
        verdict = classify(status);
      }
      if (verdict === 'ok') return finishOk(rec, out, status, now);
      if (verdict === 'fail') return finishPermanent(rec, out, status, 'HTTP ' + status, now);
      return finishRetry(rec, out, status, 'HTTP ' + status, now);
    }, function (e) {
      var text = errText(e);
      if (e && e.permanent) return finishPermanent(rec, out, null, text, now);
      return finishRetry(rec, out, null, text, now);
    });
  }
  function finishOk(rec, out, status, now) {
    removeFrom(mem.queue, rec.id);
    rec.attempts += 1;
    rec.lastStatus = status;
    rec.lastError = '';
    rec.lastAt = now;
    rec.nextAt = 0;
    out.status = 'sent';
    out.attempts = rec.attempts;
    emit('sent', rec);
    return persist('del', cfg.storeQueue, rec.id).then(function () { return out; });
  }
  function finishRetry(rec, out, status, err, now) {
    rec.attempts += 1;
    rec.lastStatus = status;
    rec.lastError = err;
    rec.lastAt = now;
    rec.nextAt = now + delayFor(rec.attempts);
    rec.updatedAt = nowMs();
    out.status = 'retried';
    out.attempts = rec.attempts;
    out.error = err;
    out.nextAt = rec.nextAt;
    emit('retry', rec);
    return persist('put', cfg.storeQueue, rec).then(function () { return out; });
  }
  function finishPermanent(rec, out, status, err, now) {
    removeFrom(mem.queue, rec.id);
    rec.attempts += 1;
    rec.lastStatus = status;
    rec.lastError = err;
    rec.lastAt = now;
    rec.nextAt = 0;
    rec.failedAt = now;
    mem.failed.push(rec);
    out.status = 'permanent';
    out.attempts = rec.attempts;
    out.error = err;
    emit('permanent', rec);
    /* 先落 failed 再删 queue：崩在中间也不会丢数据（下次加载以 failed 为准） */
    return persist('put', cfg.storeFailed, rec).then(function () {
      return persist('del', cfg.storeQueue, rec.id);
    }).then(function () { return out; });
  }
  function inQueue(rec) {
    for (var i = 0; i < mem.queue.length; i++) if (mem.queue[i] === rec) return true;
    return false;
  }

  /* 一趟：按 createdAt 升序串行，每条最多试一次；max 只数「真发出去的尝试」，退避未到的跳过不占额度 */
  function pass(opts, reason) {
    var now = typeof opts.now === 'number' ? opts.now : nowMs();
    var force = !!opts.force;
    var max = typeof opts.max === 'number' && opts.max > 0 ? Math.floor(opts.max) : cfg.maxFlushEntries;
    var snapshot = sorted();
    var res = { reason: reason, at: now, sent: [], permanent: [], retried: [], skipped: [], entries: [], storage: mode };
    var i = 0, tried = 0;
    function step() {
      if (i >= snapshot.length || tried >= max) return Promise.resolve();
      var rec = snapshot[i];
      i += 1;
      /* 快照之后被删掉、或被同 tag 的新条目换掉，就跳过 */
      if (!inQueue(rec)) return step();
      if (!force && rec.nextAt && rec.nextAt > now) {
        res.skipped.push(rec.id);
        res.entries.push({ id: rec.id, tag: rec.tag, url: rec.url, method: rec.method, status: 'skipped', httpStatus: null, attempts: rec.attempts, error: '', nextAt: rec.nextAt, at: now });
        return step();
      }
      tried += 1;
      return attempt(rec, now).then(function (out) {
        res.entries.push(out);
        if (out.status === 'sent') res.sent.push(out.id);
        else if (out.status === 'permanent') res.permanent.push(out.id);
        else res.retried.push(out.id);
        return step();
      });
    }
    return step().then(function () { res.storage = mode; return res; });
  }
  /* 单飞锁：进行中再调用直接拿同一个 Promise，绝不并发两趟 */
  function flush(opts) {
    opts = opts || {};
    if (flushing) return flushing;
    var reason = opts.reason || 'manual';
    var chain = ready().then(function () {
      return pass(opts, reason);
    }, function (e) {
      return { reason: reason, at: nowMs(), sent: [], permanent: [], retried: [], skipped: [], entries: [], storage: mode, error: errText(e) };
    }).then(function (res) {
      res.storage = mode;
      lastFlush = res;
      flushing = null;
      return res;
    });
    flushing = chain;
    return chain;
  }

  /* ---------- 维护 / 观测 ---------- */
  function clear() {
    return ready().then(function () {
      mem.queue = [];
      mem.failed = [];
      emit('clear', null);
      return Promise.all([persist('clear', cfg.storeQueue), persist('clear', cfg.storeFailed)]).then(function () { return true; });
    });
  }
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
  function storage() { return mode; }
  function configApi(patch) {
    if (patch && typeof patch === 'object') copyInto(cfg, patch);
    var out = {};
    copyInto(out, cfg);
    return out;
  }
  function stats() {
    return ready().then(function () {
      var s = sorted();
      return {
        storage: mode,
        pending: mem.queue.length,
        failed: mem.failed.length,
        flushing: !!flushing,
        lastFlush: lastFlush,
        dbError: dbFailure,
        nextAt: s.length ? s[0].nextAt : 0,
        config: configApi()
      };
    });
  }

  /* ---------- 自动触发：online / 页面可见 / 首次加载，各一次轻量 flush ---------- */
  function docVisible() {
    var d = window.document;
    if (!d) return true;
    return !d.visibilityState || d.visibilityState === 'visible';
  }
  function autoFlush(reason) {
    return flush({ reason: reason, max: cfg.autoFlushMax });
  }
  function onOnline() { if (cfg.autoFlushOnOnline) autoFlush('online'); }
  function onVisible() { if (cfg.autoFlushOnVisible && docVisible()) autoFlush('visible'); }

  if (typeof window.addEventListener === 'function') window.addEventListener('online', onOnline);
  if (window.document && typeof window.document.addEventListener === 'function') {
    window.document.addEventListener('visibilitychange', onVisible);
  }
  if (cfg.autoFlushOnLoad && typeof setTimeout === 'function') {
    setTimeout(function () { if (docVisible()) autoFlush('load'); }, 0);
  }

  window.OfflineQueue = {
    __v: 1,
    enqueue: enqueue,
    list: list,
    failed: failedList,
    pendingCount: pendingCount,
    flush: flush,
    onChange: onChange,
    clear: clear,
    storage: storage,
    stats: stats,
    config: configApi
  };
})();
