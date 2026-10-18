/* 联机对战小部件（共享静态资源，任意游戏页都可以引）
 * ------------------------------------------------------------------
 * 服务端只做两件事：轮流 + 走法中继（见 src/play.js、src/play-store.js）。
 * 它不判棋、不校验走法合法性 —— 胜负由客户端自己判定后用 result 声明。
 *
 * 游戏页用法：
 *   <script src="/static/js/net-play.js"></script>
 *   <script>
 *     var np = NetPlay.mount({
 *       game: 'gomoku',                 // 必须与服务端 play_rooms.game 一致（种子里的 slug）
 *       onMove: function (e, info) {},  // 新走法（含自己刚下的那手）：{ seq, seat, move, mine }
 *       onReset: function (info) {},    // 开新局 / 再来一局：请清盘重画
 *       onStatus: function (info) {},   // 状态变化（等待/对局/结束/出错）
 *       onNotice: function (text) {}    // 想提示一句话（可省略）
 *     });
 *     np.send('7,7');            // 落子（走法格式由各游戏自己定，服务端只当中继字符串）
 *     np.send('7,7', 'host');    // 落子并声明胜负：'host' | 'guest' | 'draw'（自己赢了就填自己的座位）
 *     np.resign();               // 认输
 *     np.rematch();              // 再来一局（双方都点才重开）
 *     np.leave();                // 离开（会关掉房间，对手下一次轮询看到 closed）
 *     np.state();                // { state, seat, code, myTurn, result, players, name, game }
 *   </script>
 *
 * 人机模式不需要这个文件，游戏页自己实现即可。
 * 设计取舍：不用 WebSocket，客户端 1.2 秒轮询增量（since = 已应用的最大 seq）；
 *   send() 成功后立刻用服务端返回的 seq 应用本地那一手（本地即时反馈），
 *   轮询再拿到同一个 seq 时按 seq 去重，不会重复落子。
 * 昵称存在 localStorage('np:name')；页面带 ?room=CODE 打开会自动加入。
 * 关页/刷新时会用 keepalive 请求离开（房间关闭，对手能在轮询里看到），
 *   所以刷新页面等于退出这一局 —— 棋盘状态不跨页面保存。
 */
(function () {
  'use strict';

  var POLL_MS = 1200;
  var NAME_KEY = 'np:name';
  var STYLE_ID = 'np-style';

  /* 站点可能部署在子路径下（/game-site/…），从本脚本自己的 URL 反推 API 前缀 */
  var SELF = document.currentScript;
  var ROOT = '';
  try {
    if (SELF && SELF.src) ROOT = new URL('../../', SELF.src).pathname.replace(/\/+$/, '');
  } catch (e) { ROOT = ''; }
  var API = ROOT + '/api/play/';

  function post(path, body, keepalive) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      keepalive: !!keepalive
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        return { status: res.status, data: data };
      });
    });
  }

  var HINTS = {
    bad_game: '这个游戏没有联机支持',
    busy: '太频繁了，等一秒再试',
    bad_code: '房间码是 6 位字母数字',
    not_found: '房间不存在或已经解散',
    full: '这间房已经满员了',
    closed: '房间已关闭',
    done: '这一局已经结束了',
    not_playing: '对局还没开始',
    not_your_turn: '还没轮到你',
    bad_move: '这步棋服务端没收下',
    bad_token: '座位凭证失效了，请重新加入'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function css() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.np-pill{position:fixed;right:14px;bottom:14px;z-index:9998;border:0;border-radius:999px;padding:10px 16px;',
      'font:600 14px/1 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;color:#e6f9ff;cursor:pointer;',
      'background:linear-gradient(135deg,#0ea5e9,#6366f1);box-shadow:0 6px 20px rgba(2,132,199,.45)}',
      '.np-pill:hover{filter:brightness(1.08)}',
      '.np-pill[hidden]{display:none}',
      '.np-panel{position:fixed;right:14px;bottom:14px;z-index:9999;width:288px;max-width:calc(100vw - 28px);',
      'border-radius:16px;padding:12px;color:#dbf8ff;background:rgba(8,20,32,.96);border:1px solid rgba(56,189,248,.35);',
      'box-shadow:0 18px 50px rgba(0,0,0,.55);font:13px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif}',
      '.np-panel[hidden]{display:none}',
      '.np-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
      '.np-title{font-weight:700;letter-spacing:.5px;color:#7dd3fc}',
      '.np-x{border:0;background:transparent;color:#94a3b8;font-size:16px;cursor:pointer;padding:0 4px}',
      '.np-row{display:flex;gap:6px;margin-top:8px}',
      '.np-row>*{flex:1}',
      '.np-panel button.np-btn{border:1px solid rgba(56,189,248,.45);background:rgba(56,189,248,.12);color:#dbf8ff;',
      'border-radius:10px;padding:7px 8px;cursor:pointer;font:600 12px/1.2 inherit}',
      '.np-panel button.np-btn:hover{background:rgba(56,189,248,.24)}',
      '.np-panel button.np-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.np-panel button.np-primary{border-color:transparent;background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#f8fcff}',
      '.np-panel input{width:100%;box-sizing:border-box;margin-top:8px;border-radius:10px;padding:7px 9px;',
      'border:1px solid rgba(148,163,184,.35);background:rgba(2,10,20,.7);color:#e6f6ff;font:13px inherit}',
      '.np-panel input:focus{outline:1px solid rgba(56,189,248,.7)}',
      '.np-code{font:700 20px/1.3 ui-monospace,Menlo,Consolas,monospace;letter-spacing:3px;color:#a5f3fc}',
      '.np-players{display:flex;flex-direction:column;gap:4px;margin:6px 0}',
      '.np-player{display:flex;justify-content:space-between;gap:8px}',
      '.np-player b{font-weight:600}',
      '.np-player i{font-style:normal;color:#64748b;font-size:12px}',
      '.np-me{color:#7dd3fc}',
      '.np-turn{color:#a7f3d0;min-height:19px}',
      '.np-msg{color:#fca5a5;min-height:18px;margin-top:6px}',
      '.np-msg.np-info{color:#93c5fd}',
      '@media (max-width:520px){.np-panel{left:8px;right:8px;bottom:8px;width:auto}}'
    ].join('');
    document.head.appendChild(st);
  }

  function mount(opts) {
    opts = opts || {};
    var game = String(opts.game || '');
    var say = typeof opts.onNotice === 'function' ? opts.onNotice : function () {};

    css();
    var pill = document.createElement('button');
    pill.className = 'np-pill';
    pill.textContent = '联机对战';
    var panel = document.createElement('div');
    panel.className = 'np-panel';
    panel.hidden = true;
    panel.innerHTML = [
      '<div class="np-head"><span class="np-title">联机对战</span><button class="np-x" data-act="close" title="收起">✕</button></div>',
      '<div class="np-idle">',
      '  <input class="np-name" maxlength="12" placeholder="你的昵称（可留空）">',
      '  <div class="np-row"><button class="np-btn np-primary" data-act="quick">快速匹配</button>',
      '    <button class="np-btn" data-act="create">开房间</button></div>',
      '  <div class="np-row"><input class="np-code-in" maxlength="6" placeholder="房间码" style="margin-top:0">',
      '    <button class="np-btn" data-act="join" style="flex:0 0 64px">加入</button></div>',
      '</div>',
      '<div class="np-room" hidden>',
      '  <div>房间码 <span class="np-code"></span></div>',
      '  <div class="np-players"></div>',
      '  <div class="np-turn"></div>',
      '  <div class="np-row"><button class="np-btn" data-act="copy">复制邀请链接</button></div>',
      '  <div class="np-row"><button class="np-btn" data-act="rematch">再来一局</button>',
      '    <button class="np-btn" data-act="resign">认输</button>',
      '    <button class="np-btn" data-act="leave">离开</button></div>',
      '</div>',
      '<div class="np-msg"></div>'
    ].join('');
    document.body.appendChild(pill);
    document.body.appendChild(panel);

    var elIdle = panel.querySelector('.np-idle');
    var elRoom = panel.querySelector('.np-room');
    var elName = panel.querySelector('.np-name');
    var elCodeIn = panel.querySelector('.np-code-in');
    var elCode = panel.querySelector('.np-code');
    var elPlayers = panel.querySelector('.np-players');
    var elTurn = panel.querySelector('.np-turn');
    var elMsg = panel.querySelector('.np-msg');

    var S = {
      state: 'idle',   // idle | waiting | playing | done | closed
      game: game,
      name: '',
      code: '',
      id: 0,
      token: '',
      seat: -1,
      myTurn: false,
      result: '',
      rematch: 0,
      players: [],
      maxSeq: 0,
      busy: false,
      timer: 0
    };

    try { S.name = localStorage.getItem(NAME_KEY) || ''; } catch (e) { S.name = ''; }
    elName.value = S.name;

    function info() {
      return {
        state: S.state, game: S.game, name: S.name, code: S.code, seat: S.seat,
        myTurn: S.myTurn, result: S.result, rematch: S.rematch,
        players: S.players.map(function (p) { return { name: p.name, joined: p.joined, me: p.seat === S.seat }; })
      };
    }

    function message(text, isInfo) {
      elMsg.textContent = text || '';
      elMsg.className = 'np-msg' + (isInfo ? ' np-info' : '');
    }

    function render() {
      elCode.textContent = S.code;
      elCodeIn.value = S.code && S.state === 'idle' ? S.code : elCodeIn.value;
      elRoom.hidden = S.state === 'idle';
      elIdle.hidden = S.state !== 'idle';
      var me = S.seat;
      elPlayers.innerHTML = S.players.map(function (p) {
        var tag = p.seat === 0 ? '房主' : '对手';
        var who = p.joined ? esc(p.name || tag) : '<i>等待加入…</i>';
        return '<div class="np-player' + (p.seat === me ? ' np-me' : '') + '"><b>' + who + '</b><i>' +
          (p.seat === me ? '我' : tag) + '</i></div>';
      }).join('');
      var txt = '';
      if (S.state === 'waiting') txt = '等待对手加入…把房间码发给朋友';
      else if (S.state === 'playing') txt = S.myTurn ? '轮到你落子' : '等对手落子…';
      else if (S.state === 'done') txt = S.result === 'draw' ? '和棋' : (resultMine() ? '你赢了 🎉' : '你输了');
      else if (S.state === 'closed') txt = '房间已关闭';
      if (S.state === 'done' && S.rematch) {
        var mineBit = S.seat === 0 ? 1 : 2;
        txt += (S.rematch & mineBit) ? '（已准备再来一局，等对手）' : '（对手想再来一局）';
      }
      elTurn.textContent = txt;
      panel.querySelector('[data-act="rematch"]').disabled = S.state !== 'done';
      panel.querySelector('[data-act="resign"]').disabled = S.state === 'waiting' || S.state === 'closed';
      pill.textContent = S.state === 'idle' ? '联机对战' : (S.state === 'waiting' ? '等待对手…' : '对局中 ' + S.code);
      pill.hidden = !panel.hidden;
      if (typeof opts.onStatus === 'function') opts.onStatus(info());
    }

    function resultMine() {
      return (S.result === 'host' && S.seat === 0) || (S.result === 'guest' && S.seat === 1);
    }

    function notify() { if (typeof opts.onStatus === 'function') opts.onStatus(info()); }

    function fail(r, fallback) {
      var code = r && r.data && r.data.error;
      message((code && HINTS[code]) || fallback || '操作失败，请稍后再试');
      if (code === 'not_found' || code === 'closed') reset();
      return code || 'error';
    }

    function reset(keepName) {
      stopPoll();
      S.state = 'idle'; S.code = ''; S.id = 0; S.token = ''; S.seat = -1;
      S.myTurn = false; S.result = ''; S.rematch = 0; S.players = []; S.maxSeq = 0;
      elCodeIn.value = '';
      render();
    }

    /* ---------- 轮询 ---------- */
    function stopPoll() { if (S.timer) { clearTimeout(S.timer); S.timer = 0; } }

    function adopt(room, seat) {
      var before = S.state;
      S.code = room.code; S.seat = seat; S.myTurn = room.myTurn;
      S.players = room.players.map(function (p, i) { return { seat: i, name: p.name, joined: p.joined }; });
      S.result = room.result || '';
      S.rematch = room.rematch || 0;
      S.state = room.status;
      if (before !== 'playing' && S.state === 'playing') {
        // 新的一局开始：从零开始应用走法
        S.maxSeq = 0;
        if (typeof opts.onReset === 'function') opts.onReset(info());
      }
      if (S.state === 'done' && before !== 'done' && typeof opts.onEnd === 'function') opts.onEnd(info());
      render();
    }

    function applyMoves(list) {
      if (!list || !list.length) return;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (Number(m.seq) <= S.maxSeq) continue;
        S.maxSeq = Number(m.seq);
        if (typeof opts.onMove === 'function') {
          opts.onMove({ seq: Number(m.seq), seat: Number(m.seat), move: m.move, mine: Number(m.seat) === S.seat }, info());
        }
      }
    }

    function startPoll() {
      stopPoll();
      if (!S.id || !S.token) return;
      S.timer = setTimeout(tick, POLL_MS);
    }

    function tick() {
      S.timer = 0;
      post('poll', { id: S.id, token: S.token, since: S.maxSeq }).then(function (r) {
        if (r.status === 200 && r.data && r.data.room) {
          adopt(r.data.room, r.data.seat);
          applyMoves(r.data.moves);
          if (S.state === 'closed') { message('对手离开了这一局', true); stopPoll(); return; }
        } else if (r.status === 404 || (r.data && (r.data.error === 'not_found' || r.data.error === 'bad_token'))) {
          fail(r);
          return;
        }
        startPoll();
      }).catch(function () {
        message('网络不稳定，重试中…');
        startPoll();
      });
    }

    /* ---------- 动作 ---------- */
    function enter(data) {
      if (!data || !data.room) return false;
      S.id = data.room.id; S.token = data.token;
      S.maxSeq = 0; S.state = 'idle'; S.seat = -1;
      try { localStorage.setItem(NAME_KEY, S.name); } catch (e) { /* 隐私模式 */ }
      adopt(data.room, data.seat);
      message('');
      startPoll();
      return true;
    }

    function call(kind, body) {
      if (S.busy) return Promise.resolve('busy');
      S.busy = true;
      return post(kind, body || {}).then(function (r) {
        S.busy = false;
        if (r.status >= 200 && r.status < 300 && r.data && r.data.ok !== false && !(r.data && r.data.error)) return r;
        return r;
      }, function () {
        S.busy = false;
        message('网络请求失败，请稍后再试');
        return { status: 0, data: null };
      });
    }

    function act(kind, body, onOk) {
      return call(kind, body).then(function (r) {
        if (r.status >= 200 && r.status < 300 && r.data && !r.data.error) return onOk ? onOk(r.data) : r.data;
        if (r.status) fail(r);
        return null;
      });
    }

    function curName() {
      S.name = String(elName.value || '').slice(0, 12);
      return S.name;
    }

    var ctl = {
      game: game,
      state: function () { return info(); },
      open: function () { panel.hidden = false; render(); },
      close: function () { panel.hidden = true; render(); },
      quick: function () {
        return act('quick', { game: game, name: curName() }, function (d) {
          enter(d); message('正在匹配…', true); return d;
        });
      },
      create: function () {
        return act('create', { game: game, name: curName() }, function (d) {
          enter(d); message('房间已开好，把邀请链接发出去', true); return d;
        });
      },
      join: function (code) {
        var c = String(code || elCodeIn.value || '').trim();
        if (!c || c.length !== 6) { message('房间码是 6 位'); return Promise.resolve(null); }
        return act('join', { code: c, name: curName() }, function (d) { enter(d); message('进入房间', true); return d; });
      },
      /** 落子：move 是各游戏自己的走法字符串；result 可选（'host' | 'guest' | 'draw'），填了就是这局的终局声明 */
      send: function (move, result) {
        if (S.state !== 'playing') { message('现在还不能落子'); return Promise.resolve(null); }
        if (!S.myTurn) { message('还没轮到你'); return Promise.resolve(null); }
        return act('move', { id: S.id, token: S.token, move: move, result: result || '' }, function (d) {
          if (d.room) {
            // 本地即时反馈：直接用服务端给的 seq 应用自己这一手，轮询拿到同一 seq 会被去重
            if (Number(d.seq) > S.maxSeq) {
              S.maxSeq = Number(d.seq);
              if (typeof opts.onMove === 'function') opts.onMove({ seq: Number(d.seq), seat: S.seat, move: String(move), mine: true }, info());
            }
            adopt(d.room, d.seat);
            if (d.finished && typeof opts.onEnd === 'function') opts.onEnd(info());
          }
          message('');
          return d;
        });
      },
      resign: function () {
        return act('resign', { id: S.id, token: S.token }, function (d) {
          if (d.room) adopt(d.room, d.seat);
          message('你认输了', true);
          if (typeof opts.onEnd === 'function') opts.onEnd(info());
          return d;
        });
      },
      rematch: function () {
        return act('rematch', { id: S.id, token: S.token }, function (d) {
          if (d.room) adopt(d.room, d.seat);
          message(d.restarted ? '新的一局开始了' : '已准备，等对手同意', true);
          return d;
        });
      },
      leave: function () {
        if (!S.id) { reset(); return Promise.resolve(null); }
        var id = S.id, token = S.token;
        return post('leave', { id: id, token: token }, true).then(function () {
          reset();
          message('已离开房间', true);
          return null;
        });
      }
    };

    /* ---------- 面板交互 ---------- */
    panel.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      var what = btn.getAttribute('data-act');
      if (what === 'quick') ctl.quick();
      else if (what === 'create') ctl.create();
      else if (what === 'join') ctl.join();
      else if (what === 'copy') {
        var url = location.origin + location.pathname + '?room=' + S.code;
        if (navigator.share) { navigator.share({ title: '来一局', url: url }).catch(function () {}); }
        else if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function () { message('邀请链接已复制', true); }, function () { message('链接：' + url, true); });
        } else message('链接：' + url, true);
      } else if (what === 'rematch') ctl.rematch();
      else if (what === 'resign') ctl.resign();
      else if (what === 'leave') ctl.leave();
      else if (what === 'close') ctl.close();
    });
    panel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target === elCodeIn) { ev.preventDefault(); ctl.join(); }
    });
    pill.addEventListener('click', function () { ctl.open(); });

    /* 关页/刷新 = 退出这一局（对手下一次轮询会看到「对方已离开」） */
    window.addEventListener('pagehide', function () {
      if (S.id && S.token && S.state !== 'closed') post('leave', { id: S.id, token: S.token }, true).catch(function () {});
    });

    /* URL 带房间码自动加入 */
    var m = /[?&]room=([A-Za-z0-9]{4,8})/.exec(location.search);
    if (m && game) {
      panel.hidden = false;
      elCodeIn.value = m[1].toUpperCase();
      render();
      ctl.join(elCodeIn.value);
    } else {
      render();
    }

    return ctl;
  }

  window.NetPlay = { mount: mount, API: API };
})();
