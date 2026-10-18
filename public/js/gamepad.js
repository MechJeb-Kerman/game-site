/* 手柄支持（Gamepad API）—— 前 6 款小游戏共用（黑洞吞噬自制轮询），零依赖。
 *
 * 游戏页在引入本文件之前设置 window.GAMEPAD：
 *   window.GAMEPAD = { mode: 'keys', a: ' ', b: 'r', start: 'p' };  // 键盘型游戏
 *   window.GAMEPAD = { mode: 'pointer' };                          // 指针型游戏
 * 按键映射既可以写成 window.GAMEPAD.keys = { a: ' ', start: 'p' }，也可以直接写在顶层（a / b / start / up / down / left / right），两种都认。
 *
 * keys 模式：十字键 / 左摇杆 / A / B / Start 合成键盘事件，游戏本体一行都不用改。
 * pointer 模式：屏幕出现虚拟光标，左摇杆或十字键移动，A 键在光标处发一次真实点击
 *              （pointerdown + mousedown + pointerup + mouseup + click）。
 * Start 键在任何模式下都会先找当前可见的「开始 / 再来一局」按钮并点它。
 *
 * 自测：tools/gamepad-test.mjs 会注入一个假手柄跑全套验证。说明见 README.md 的「## 手柄支持」。
 */
(function () {
  'use strict';
  if (window.__gpShimOn) return;
  window.__gpShimOn = true;

  var CFG = window.GAMEPAD || {};
  var MODE = CFG.mode === 'pointer' ? 'pointer' : 'keys';
  var DEAD = typeof CFG.deadzone === 'number' ? CFG.deadzone : 0.35;   /* 摇杆死区 */
  var REPEAT = typeof CFG.repeatMs === 'number' ? CFG.repeatMs : 150;  /* 按住重复间隔 ms */
  var SPEED = typeof CFG.speed === 'number' ? CFG.speed : 660;         /* 光标速度 px/s */
  var STEP = typeof CFG.step === 'number' ? CFG.step : 48;             /* 十字键单步 px */
  /* 按键映射：写 window.GAMEPAD.keys = {...}，也可以直接把 a/b/start 写在顶层，两种都认 */
  var MAP = (CFG.keys && typeof CFG.keys === 'object') ? CFG.keys : CFG;
  var ACT = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9,
              up: 12, down: 13, left: 14, right: 15 };
  var KEY = {
    up: MAP.up || 'ArrowUp', down: MAP.down || 'ArrowDown',
    left: MAP.left || 'ArrowLeft', right: MAP.right || 'ArrowRight',
    a: MAP.a === undefined ? ' ' : MAP.a,
    b: MAP.b === undefined ? '' : MAP.b,
    start: MAP.start === undefined ? '' : MAP.start
  };
  /* 方向单字符（l/r/u/d）到 KEY 字段（left/right/up/down）的映射——曾经这里是 KEY[k] 直接取，
     结果 KEY['r'] 是 undefined，fireKey 里的 if (!key) return 把四个方向全吞了 */
  var DIRKEY = { l: 'left', r: 'right', u: 'up', d: 'down' };
  var START_SEL = CFG.startSelector || '.overlay .btn, .overlay button, #ovBtn, #again, #start';

  /* ---------- 读手柄 ---------- */
  function firstPad() {
    if (!navigator.getGamepads) return null;
    var list = navigator.getGamepads();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].connected !== false) return list[i];
    return null;
  }
  function axis(p, i) {
    var v = p.axes && p.axes[i];
    v = typeof v === 'number' ? v : 0;
    return v > -DEAD && v < DEAD ? 0 : v;
  }
  function held(p, i) {
    var b = p.buttons && p.buttons[i];
    if (!b) return false;
    return typeof b === 'object' ? !!b.pressed : !!b;
  }
  function dirs(p) {
    var ax = axis(p, 0), ay = axis(p, 1);
    return {
      l: ax < 0 || held(p, ACT.left), r: ax > 0 || held(p, ACT.right),
      u: ay < 0 || held(p, ACT.up), d: ay > 0 || held(p, ACT.down),
      ax: ax, ay: ay
    };
  }
  function one(d) { return d.l ? 'l' : d.r ? 'r' : d.u ? 'u' : d.d ? 'd' : ''; }

  /* ---------- 提示条 ---------- */
  var toast = null, toastT = 0;
  function say(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gpToast';
      toast.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;'
        + 'background:rgba(17,24,39,.94);color:#e9edfa;border:1px solid rgba(99,102,241,.6);'
        + 'padding:7px 14px;border-radius:999px;font:13px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;'
        + 'pointer-events:none;opacity:0;transition:opacity .2s;box-shadow:0 8px 24px rgba(0,0,0,.5)';
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toastT);
    toastT = setTimeout(function () { toast.style.opacity = '0'; }, 2600);
  }

  /* ---------- 虚拟光标（pointer 模式） ---------- */
  var cur = null, cx = 0, cy = 0;
  function place() {
    if (cur) cur.style.transform = 'translate(' + Math.round(cx) + 'px,' + Math.round(cy) + 'px)';
  }
  function clamp() {
    cx = Math.max(3, Math.min(window.innerWidth - 3, cx));
    cy = Math.max(3, Math.min(window.innerHeight - 3, cy));
  }
  function ensureCursor() {
    if (cur) return cur;
    cur = document.createElement('div');
    cur.id = 'gpCursor';
    cur.setAttribute('aria-hidden', 'true');
    cur.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;'
      + 'width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;opacity:0;transition:opacity .18s;'
      + 'border:2px solid #fff;box-shadow:0 0 0 2px rgba(99,102,241,.95),0 0 18px rgba(99,102,241,.8),'
      + 'inset 0 0 10px rgba(255,255,255,.45)';
    (document.body || document.documentElement).appendChild(cur);
    cx = window.innerWidth / 2;
    cy = window.innerHeight / 2;
    place();
    return cur;
  }

  /* ---------- 合成事件 ---------- */
  function fireKey(kind, key) {
    if (!key) return;
    var code = key === ' ' ? 'Space' : (key.length === 1 ? 'Key' + key.toUpperCase() : key);
    document.dispatchEvent(new KeyboardEvent(kind, {
      key: key, code: code, bubbles: true, cancelable: true
    }));
  }
  function fireAt(el, x, y) {
    var PE = window.PointerEvent || window.MouseEvent;
    var base = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, detail: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true };
    var seq = [['pointerdown', 1], ['mousedown', 1], ['pointerup', 0], ['mouseup', 0], ['click', 0]];
    for (var i = 0; i < seq.length; i++) {
      var name = seq[i][0], opts = {}, k;
      for (k in base) opts[k] = base[k];
      opts.buttons = seq[i][1];
      el.dispatchEvent(name.indexOf('pointer') === 0 ? new PE(name, opts) : new MouseEvent(name, opts));
    }
  }
  function visible(el) {
    if (!el || el.disabled) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  function realClick(el) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (MODE === 'pointer') { cx = x; cy = y; clamp(); place(); }
    fireAt(el, x, y);
  }
  function clickStart() {
    var list = document.querySelectorAll(START_SEL);
    for (var i = 0; i < list.length; i++) if (visible(list[i])) { realClick(list[i]); return true; }
    return false;
  }
  function clickPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return false;
    fireAt(el, x, y);
    return true;
  }

  /* ---------- 连接 / 断开 ---------- */
  var seen = false, connectedId = '';
  function onConnect(p) {
    connectedId = String((p && p.id) || '');
    say('🎮 手柄已连接' + (MODE === 'pointer' ? '：摇杆或十字键移动光标，A 键点击' : '：十字键 / 摇杆 / A / Start 操作'));
    ensure2();
    try { window.focus(); } catch (e) {}
  }
  function ensure2() { if (MODE === 'pointer') ensureCursor().style.opacity = '1'; }
  function onDisconnect() {
    if (cur) cur.style.opacity = '0';
    say('🎮 手柄已断开');
  }
  window.addEventListener('gamepadconnected', function (e) {
    if (seen) return;
    seen = true;
    onConnect(e.gamepad || {});
  });
  window.addEventListener('gamepaddisconnected', function () {
    if (!seen) return;
    seen = false;
    onDisconnect();
  });

  /* ---------- 主循环 ---------- */
  var last = 0, prev = { k: '', a: false, b: false, st: false, t: 0 };
  function step(p, ts) {
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
    last = ts;
    var d = dirs(p);
    var a = held(p, ACT.a), b = held(p, ACT.b), st = held(p, ACT.start);
    var k = one(d);
    if (MODE === 'pointer') {
      if (d.ax || d.ay) { cx += d.ax * SPEED * dt; cy += d.ay * SPEED * dt; clamp(); place(); }
      if (k && (prev.k !== k || ts - prev.t > REPEAT)) {
        prev.t = ts;
        if (k === 'l') cx -= STEP; else if (k === 'r') cx += STEP;
        else if (k === 'u') cy -= STEP; else cy += STEP;
        clamp(); place();
      }
      if (a && !prev.a) clickPoint(cx, cy);
      if (b && !prev.b) clickPoint(cx, cy);
    } else {
      if (k) {
        if (prev.k !== k || ts - prev.t > REPEAT) { prev.t = ts; fireKey('keydown', KEY[DIRKEY[k]]); }
      } else if (prev.k) {
        fireKey('keyup', KEY[DIRKEY[prev.k]]);
      }
      if (a && !prev.a) { if (!clickStart()) { fireKey('keydown', KEY.a); fireKey('keyup', KEY.a); } }
      if (b && !prev.b && KEY.b) { fireKey('keydown', KEY.b); fireKey('keyup', KEY.b); }
    }
    if (st && !prev.st && !clickStart() && MODE === 'keys') {
      fireKey('keydown', KEY.start);
      fireKey('keyup', KEY.start);
    }
    prev.k = k; prev.a = a; prev.b = b; prev.st = st;
  }
  function loop(ts) {
    var p = firstPad();
    if (p && !seen) { seen = true; onConnect(p); }
    else if (!p && seen) { seen = false; onDisconnect(); }
    if (p) { try { step(p, ts); } catch (e) {} }
    requestAnimationFrame(loop);
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(loop);

  /* 调试与自测钩子 */
  window.__gp = {
    mode: MODE, key: KEY,
    pos: function () { return { x: cx, y: cy }; },
    cursor: function () { return cur; },
    click: function (x, y) { return clickPoint(x, y); },
    start: function () { return clickStart(); },
    id: function () { return connectedId; }
  };
})();
