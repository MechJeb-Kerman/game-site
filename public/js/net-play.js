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
 * 昵称存在 localStorage('np:name')；URL 参数有三种玩法（都由本文件自动接管，游戏页不用写代码）：
 *   ?room=CODE   用房间码自动加入
 *   ?watch=KEY   观战（KEY = 房间内分享出来的观战钥匙，只看不走）
 *   ?replay=ID   看棋谱回放（从 /api/replays/ID 取整局走法，本地播放，带进度/播放/调速）
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
  var REPLAY_API = ROOT + '/api/replays/';

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
    bad_token: '座位凭证失效了，请重新加入',
    bad_watch: '观战钥匙无效或这一局已经结束太久'
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
      '.np-watch-tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font:600 11px/1.6 inherit;',
      'color:#0b1220;background:linear-gradient(135deg,#a5f3fc,#7dd3fc)}',
      '.np-prog{height:6px;border-radius:999px;background:rgba(148,163,184,.25);overflow:hidden;margin:8px 0 4px}',
      '.np-prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,#0ea5e9,#6366f1);transition:width .15s}',
      '.np-replay-info{color:#bae6fd}',
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
      '  <div class="np-row"><button class="np-btn" data-act="replay-open" hidden>看棋谱回放</button></div>',
      '  <div class="np-row"><button class="np-btn" data-act="rematch">再来一局</button>',
      '    <button class="np-btn" data-act="resign">认输</button>',
      '    <button class="np-btn" data-act="leave">离开</button></div>',
      '</div>',
      '<div class="np-replay" hidden>',
      '  <div class="np-replay-info"></div>',
      '  <div class="np-prog"><i></i></div>',
      '  <div class="np-turn np-replay-at"></div>',
      '  <div class="np-row"><button class="np-btn" data-act="r-first" title="回到开局">⏮</button>',
      '    <button class="np-btn" data-act="r-prev" title="上一手">◀</button>',
      '    <button class="np-btn np-primary" data-act="r-toggle">▶ 播放</button>',
      '    <button class="np-btn" data-act="r-next" title="下一手">▶︎</button>',
      '    <button class="np-btn" data-act="r-last" title="跳到终局">⏭</button></div>',
      '  <div class="np-row"><button class="np-btn" data-act="r-speed">速度 1×</button>',
      '    <button class="np-btn" data-act="r-copy">复制回放链接</button></div>',
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
    var elReplay = panel.querySelector('.np-replay');
    var elReplayInfo = panel.querySelector('.np-replay-info');
    var elReplayAt = panel.querySelector('.np-replay-at');
    var elProg = panel.querySelector('.np-prog i');

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
      timer: 0,
      // 'play' = 自己在房间里下棋；'watch' = 观战；'replay' = 看棋谱回放
      mode: 'play',
      watchKey: '',
      replay: null,
      at: 0,
      speed: 1,
      playing: false,
      playTimer: 0,
      replayId: 0
    };

    try { S.name = localStorage.getItem(NAME_KEY) || ''; } catch (e) { S.name = ''; }
    elName.value = S.name;

    function info() {
      return {
        state: S.state, game: S.game, name: S.name, code: S.code, seat: S.seat,
        myTurn: S.myTurn, result: S.result, rematch: S.rematch,
        mode: S.mode, watch: S.mode === 'watch', replay: S.mode === 'replay',
        at: S.at, total: S.replay ? S.replay.moves.length : 0, playing: S.playing,
        players: S.players.map(function (p) { return { name: p.name, joined: p.joined, me: p.seat === S.seat }; })
      };
    }

    function message(text, isInfo) {
      elMsg.textContent = text || '';
      elMsg.className = 'np-msg' + (isInfo ? ' np-info' : '');
    }

    function render() {
      if (S.mode === 'replay') { renderReplay(); return; }
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
      else if (S.state === 'done') {
        if (S.result === 'draw') txt = '和棋';
        else if (S.mode === 'watch') txt = (playerName(S.result) || '对手') + ' 获胜';
        else txt = resultMine() ? '你赢了 🎉' : '你输了';
      } else if (S.state === 'closed') txt = '房间已关闭';
      if (S.mode === 'watch') txt = txt ? '观战中 · ' + txt : '观战中';
      if (S.state === 'done' && S.rematch) {
        var mineBit = S.seat === 0 ? 1 : 2;
        txt += (S.rematch & mineBit) ? '（已准备再来一局，等对手）' : '（对手想再来一局）';
      }
      elTurn.textContent = txt;
      var watching = S.mode === 'watch';
      panel.querySelector('.np-title').innerHTML = (watching ? '观战' : '联机对战') +
        (watching ? '<span class="np-watch-tag">只看不走</span>' : '');
      panel.querySelector('[data-act="rematch"]').disabled = S.state !== 'done' || watching;
      panel.querySelector('[data-act="resign"]').disabled = watching || S.state === 'waiting' || S.state === 'closed';
      panel.querySelector('[data-act="leave"]').hidden = watching;
      panel.querySelector('[data-act="copy"]').textContent = watching ? '复制观战链接' : '复制邀请链接';
      panel.querySelector('[data-act="join"]').disabled = watching;
      panel.querySelector('[data-act="replay-open"]').hidden = !S.replayId;
      pill.textContent = watching ? '观战中 ' + S.code : (S.state === 'idle' ? '联机对战' : (S.state === 'waiting' ? '等待对手…' : '对局中 ' + S.code));
      pill.hidden = !panel.hidden;
      if (typeof opts.onStatus === 'function') opts.onStatus(info());
    }

    /** 「host」/「guest」换成玩家名字（观战与回放都要显示谁赢了） */
    function playerName(seatResult) {
      if (seatResult === 'host') return (S.players[0] && S.players[0].name) || '房主';
      if (seatResult === 'guest') return (S.players[1] && S.players[1].name) || '挑战者';
      return '';
    }

    function renderReplay() {
      var r = S.replay;
      var total = r ? r.moves.length : 0;
      elReplay.hidden = false;
      elIdle.hidden = true;
      elRoom.hidden = true;
      elReplayInfo.innerHTML = r
        ? esc(r.hostName) + ' <i style="font-style:normal;color:#64748b">vs</i> ' + esc(r.guestName) +
          '<div class="np-player"><b>' + (r.result === 'draw' ? '和棋' : esc(r.winner || '对局结束') + ' 获胜') + '</b>' +
          '<i>' + esc(r.game) + ' · ' + total + ' 手</i></div>'
        : '棋谱加载中…';
      elReplayAt.textContent = total ? '第 ' + S.at + ' / ' + total + ' 手' + (S.at >= total ? '（终局）' : '') : '';
      elProg.style.width = (total ? Math.round((S.at / total) * 100) : 0) + '%';
      panel.querySelector('[data-act="r-toggle"]').textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
      panel.querySelector('[data-act="r-speed"]').textContent = '速度 ' + S.speed + '×';
      pill.textContent = total ? '棋谱回放 ' + S.at + '/' + total : '棋谱回放';
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
      if (S.mode !== 'play') return;   // 观战/回放没有房间可退，失败提示后保持原样
      S.state = 'idle'; S.code = ''; S.id = 0; S.token = ''; S.seat = -1;
      S.myTurn = false; S.result = ''; S.rematch = 0; S.players = []; S.maxSeq = 0; S.replayId = 0;
      elCodeIn.value = '';
      render();
    }

    /* ---------- 轮询 ---------- */
    function stopPoll() { if (S.timer) { clearTimeout(S.timer); S.timer = 0; } }

    function adopt(room, seat) {
      var before = S.state;
      S.code = room.code; S.seat = seat; S.myTurn = room.myTurn;
      S.id = Number(room.id) || S.id;
      S.replayId = Number(room.replayId || 0);
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
      if (S.mode === 'watch') { if (S.watchKey) S.timer = setTimeout(watchTick, POLL_MS); return; }
      if (!S.id || !S.token) return;
      S.timer = setTimeout(tick, POLL_MS);
    }

    /** 观战：和轮询同一个节奏，只是走只读接口（不占座位、不能落子） */
    function watchTick() {
      S.timer = 0;
      post('watch', { key: S.watchKey, since: S.maxSeq }).then(function (r) {
        if (r.status === 200 && r.data && r.data.room) {
          adopt(r.data.room, -1);
          applyMoves(r.data.moves);
          if (S.state === 'closed' || S.state === 'done') {
            message(S.state === 'closed' ? '这一局已经关闭' : '对局结束，可以看棋谱回放', true);
            stopPoll();
            return;
          }
        } else { fail(r, '观战失败'); return; }
        startPoll();
      }).catch(function () { message('网络不稳定，重试中…'); startPoll(); });
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

    /* ---------- 分享 ---------- */
    function shareUrl(title, url) {
      if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); }
      else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { message('链接已复制', true); }, function () { message('链接：' + url, true); });
      } else message('链接：' + url, true);
    }

    /* ---------- 观战（只读轮询） ---------- */
    function loadWatch(key) {
      S.mode = 'watch';
      S.watchKey = String(key || '');
      panel.hidden = false;
      render();
      if (!S.watchKey) { message('观战链接不完整'); return; }
      message('正在进入观战…', true);
      watchTick();
    }

    /* ---------- 棋谱回放（整局一次取回，本地播放） ---------- */
    function loadReplay(id) {
      S.mode = 'replay';
      panel.hidden = false;
      render();
      return fetch(REPLAY_API + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
        .then(function (res) { return res.json().then(function (d) { return { status: res.status, data: d }; }); })
        .then(function (r) {
          var rep = r.data && r.data.replay;
          if (r.status !== 200 || !rep) { message('棋谱不存在或已过期'); return null; }
          S.replay = {
            id: Number(rep.id) || Number(id) || 0,
            game: rep.game || '',
            hostName: rep.hostName || '房主',
            guestName: rep.guestName || '挑战者',
            result: rep.result || '',
            winner: rep.winner || '',
            moves: (rep.moves || []).map(function (m, i) {
              return { seq: Number(m.seq) || i + 1, seat: Number(m.seat) || 0, move: m.move == null ? '' : String(m.move) };
            })
          };
          S.players = [{ seat: 0, name: S.replay.hostName, joined: true }, { seat: 1, name: S.replay.guestName, joined: true }];
          S.result = S.replay.result; S.state = 'done';
          message('');
          seek(0);
          return S.replay;
        })
        .catch(function () { message('棋谱加载失败，检查网络后重试'); return null; });
    }

    function stopPlay() { if (S.playTimer) { clearTimeout(S.playTimer); S.playTimer = 0; } S.playing = false; }

    /** 跳到第 n 手：往回跳要先把棋盘复位再从头按序喂（走法必须按序应用） */
    function seek(n) {
      if (S.mode !== 'replay' || !S.replay) return S.at;
      var moves = S.replay.moves;
      n = Math.max(0, Math.min(Number(n) || 0, moves.length));
      if (n <= S.maxSeq) {
        S.maxSeq = 0;
        if (typeof opts.onReset === 'function') opts.onReset(info());
      }
      applyMoves(moves.slice(S.maxSeq, n));
      S.maxSeq = n; S.at = n;
      renderReplay();
      return n;
    }

    function step() {
      S.playTimer = 0;
      if (!S.replay || S.at >= S.replay.moves.length) { stopPlay(); renderReplay(); return; }
      seek(S.at + 1);
      if (S.playing) S.playTimer = setTimeout(step, Math.round(900 / S.speed));
    }

    function play() {
      if (S.mode !== 'replay' || !S.replay || !S.replay.moves.length) return;
      stopPlay();
      if (S.at >= S.replay.moves.length) seek(0);
      S.playing = true;
      renderReplay();
      S.playTimer = setTimeout(step, Math.round(900 / S.speed));
    }

    function pause() { stopPlay(); renderReplay(); }

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
      watch: loadWatch,
      replay: {
        load: loadReplay,
        play: play,
        pause: pause,
        toggle: function () { if (S.playing) pause(); else play(); },
        seek: seek,
        next: function () { pause(); seek(S.at + 1); return S.at; },
        prev: function () { pause(); seek(S.at - 1); return S.at; },
        first: function () { pause(); seek(0); return S.at; },
        last: function () { pause(); if (S.replay) seek(S.replay.moves.length); return S.at; },
        speed: function (v) {
          S.speed = v ? Number(v) : (S.speed >= 2 ? 0.5 : S.speed * 2);
          renderReplay();
          if (S.playing) { stopPlay(); play(); }
          return S.speed;
        }
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
        if (S.mode === 'watch') shareUrl('来看这局', location.origin + location.pathname + '?watch=' + S.watchKey);
        else shareUrl('来一局', location.origin + location.pathname + '?room=' + S.code);
      } else if (what === 'r-first') ctl.replay.first();
      else if (what === 'r-prev') ctl.replay.prev();
      else if (what === 'r-toggle') ctl.replay.toggle();
      else if (what === 'r-next') ctl.replay.next();
      else if (what === 'r-last') ctl.replay.last();
      else if (what === 'r-speed') ctl.replay.speed();
      else if (what === 'r-copy') {
        if (S.replay) shareUrl('棋谱回放', location.origin + location.pathname + '?replay=' + S.replay.id);
      } else if (what === 'replay-open') {
        window.open(location.origin + '/replay/' + S.replayId, '_blank');
      } else if (what === 'rematch') ctl.rematch();
      else if (what === 'resign') ctl.resign();
      else if (what === 'leave') ctl.leave();
      else if (what === 'close') ctl.close();
    });
    panel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target === elCodeIn) { ev.preventDefault(); ctl.join(); return; }
      if (S.mode === 'replay') {
        if (ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); ctl.replay.toggle(); }
        else if (ev.key === 'ArrowLeft') { ev.preventDefault(); ctl.replay.prev(); }
        else if (ev.key === 'ArrowRight') { ev.preventDefault(); ctl.replay.next(); }
      }
    });
    pill.addEventListener('click', function () { ctl.open(); });

    /* 关页/刷新 = 退出这一局（对手下一次轮询会看到「对方已离开」） */
    window.addEventListener('pagehide', function () {
      if (S.mode === 'play' && S.id && S.token && S.state !== 'closed') post('leave', { id: S.id, token: S.token }, true).catch(function () {});
    });

    /* URL 参数：?room=CODE 自动加入 / ?watch=KEY 观战 / ?replay=ID 看棋谱 */
    var m = /[?&]room=([A-Za-z0-9]{4,8})/.exec(location.search);
    var mw = /[?&]watch=([\w-]{6,80})/.exec(location.search);
    var mr = /[?&]replay=(\d{1,10})/.exec(location.search);
    if (mw && game) {
      panel.hidden = false;
      loadWatch(mw[1]);
    } else if (mr && game) {
      panel.hidden = false;
      loadReplay(mr[1]);
    } else if (m && game) {
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
