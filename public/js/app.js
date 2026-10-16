/* 趣玩小游戏 — 前端交互（原生 JS，零依赖） */
(function () {
  'use strict';

  /* ---------- 应用内提示条 ---------- */
  function toast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:36px', 'transform:translateX(-50%)',
      'background:rgba(20,26,48,.96)', 'color:#e9edfa', 'padding:10px 20px',
      'border-radius:999px', 'border:1px solid rgba(255,255,255,.16)',
      'font-size:14px', 'z-index:999', 'pointer-events:none',
      'box-shadow:0 10px 30px rgba(0,0,0,.5)', 'transition:opacity .4s'
    ].join(';');
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; }, 1800);
    setTimeout(function () { el.remove(); }, 2400);
  }

  /* ---------- 搜索框回填 ---------- */
  var params = new URLSearchParams(location.search);
  var q = params.get('q');
  var input = document.querySelector('.search input[name="q"]');
  if (q && input) input.value = q;

  /* ---------- 搜索建议：中文 / 全拼 / 首字母都能提示 ---------- */
  (function () {
    var box = document.getElementById('sug');
    if (!box || !input) return;
    var timer = null, rows = [], cur = -1, want = '';

    function clear() { while (box.firstChild) box.removeChild(box.firstChild); rows = []; cur = -1; }
    function close() { clear(); box.hidden = true; }
    function mark(i) {
      for (var k = 0; k < rows.length; k++) rows[k].classList.toggle('on', k === i);
      cur = i;
    }
    function open(list) {
      clear();
      if (!list.length) {
        var none = document.createElement('div');
        none.className = 's-none';
        none.textContent = '没有匹配的游戏，回车看全部结果';
        box.appendChild(none);
        box.hidden = false;
        return;
      }
      list.forEach(function (it) {
        var a = document.createElement('a');
        a.href = '/game/' + encodeURIComponent(it.slug);
        var ico = document.createElement('span');
        ico.className = 's-ico';
        ico.textContent = it.emoji || '🎮';
        var t = document.createElement('span');
        t.className = 's-t';
        t.textContent = it.title || '';
        var m = document.createElement('span');
        m.className = 's-m';
        m.textContent = [it.category, it.plays ? it.plays + ' 次' : ''].filter(Boolean).join(' · ');
        a.appendChild(ico); a.appendChild(t); a.appendChild(m);
        a.addEventListener('mouseenter', function () { mark(rows.indexOf(a)); });
        box.appendChild(a);
        rows.push(a);
      });
      box.hidden = false;
      mark(-1);
    }
    function load(text) {
      want = text;
      fetch('/api/search/suggest?q=' + encodeURIComponent(text))
        .then(function (r) { return r.json(); })
        .then(function (d) { if (want === text) open((d && d.items) || []); })
        .catch(function () { if (want === text) close(); });
    }

    input.addEventListener('input', function () {
      var text = (input.value || '').trim();
      clearTimeout(timer);
      if (!text) { close(); return; }
      timer = setTimeout(function () { load(text); }, 160);
    });
    input.addEventListener('keydown', function (e) {
      if (box.hidden || !rows.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mark(cur + 1 >= rows.length ? 0 : cur + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mark(cur - 1 < 0 ? rows.length - 1 : cur - 1); }
      else if (e.key === 'Enter') {
        if (cur >= 0) { e.preventDefault(); location.href = rows[cur].href; }
        else close();
      } else if (e.key === 'Escape') { close(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    document.addEventListener('click', function (e) {
      if (!box.hidden && e.target !== input && !box.contains(e.target)) close();
    });
  })();

  /* ---------- 后台：批量选择（全选 / 空选择拦截 / 二次确认） ---------- */
  (function () {
    var form = document.getElementById('batchForm');
    if (!form) return;
    var all = document.getElementById('pickAll');
    function boxes() { return Array.prototype.slice.call(form.querySelectorAll('input[name="slug"]')); }
    if (all) {
      all.addEventListener('change', function () {
        boxes().forEach(function (b) { b.checked = all.checked; });
      });
    }
    form.addEventListener('submit', function (ev) {
      var picked = boxes().filter(function (b) { return b.checked; });
      if (!picked.length) { ev.preventDefault(); toast('先勾选要处理的游戏'); return; }
      if (!window.confirm('确定要批量处理这 ' + picked.length + ' 款游戏吗？')) ev.preventDefault();
    });
  })();

  /* ---------- 游戏播放器 ---------- */
  var player = document.getElementById('player');
  if (!player) return;

  var slug = player.dataset.slug;
  var frame = document.getElementById('gameFrame');
  var stage = document.getElementById('stage');
  var countEl = document.getElementById('playCount');

  /* 1) 上报一次游玩（后端 30 秒内同 IP 同游戏去重） */
  fetch('/api/games/' + encodeURIComponent(slug) + '/play', { method: 'POST' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !countEl) return;
      var n = d.plays;
      countEl.textContent = n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n);
    })
    .catch(function () { /* 离线也不影响游戏 */ });

  /* 1.5) 评分：点星星即刻写入，一人一票、可改票 */
  var ratePanel = document.getElementById('ratePanel');
  var starsBox = document.getElementById('stars');
  var rateInfo = document.getElementById('rateInfo');

  if (ratePanel && starsBox && rateInfo) {
    var starEls = [].slice.call(starsBox.querySelectorAll('.star'));
    var mine = Number(ratePanel.dataset.my) || 0;

    function paint(n) {
      starEls.forEach(function (el) {
        var v = Number(el.dataset.star);
        el.classList.toggle('on', v <= n);
        el.setAttribute('aria-checked', String(v === n));
      });
    }

    function say(avg, count, my) {
      rateInfo.innerHTML = (count
        ? '<b>' + Number(avg).toFixed(1) + '</b> 分 · ' + count + ' 人评分'
        : '还没有人评分，来做第一个') + (my ? ' · 你已评 ' + my + ' 星' : '');
    }

    /* 悬停预览，移开恢复成自己的票 */
    starsBox.addEventListener('mouseover', function (e) {
      var el = e.target.closest('.star');
      if (el) paint(Number(el.dataset.star));
    });
    starsBox.addEventListener('mouseleave', function () { paint(mine); });

    starsBox.addEventListener('click', function (e) {
      var el = e.target.closest('.star');
      if (!el) return;
      // 评分需要登录：未登录直接引导去登录页，登录后回到本页
      if (ratePanel.dataset.auth !== '1') {
        location.href = '/login?next=' + encodeURIComponent(location.pathname);
        return;
      }
      var want = Number(el.dataset.star);
      starEls.forEach(function (s) { s.disabled = true; });

      fetch('/api/games/' + encodeURIComponent(ratePanel.dataset.slug) + '/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stars: want })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            if (res.d.error === 'login_required') {
              location.href = '/login?next=' + encodeURIComponent(location.pathname);
              return;
            }
            throw new Error(res.d.error || 'rate failed');
          }
          mine = res.d.stars;
          ratePanel.dataset.my = String(mine);
          paint(mine);
          say(res.d.rating, res.d.count, mine);
          toast(res.d.isNew ? '感谢评分 ⭐' + mine : '已改成 ⭐' + mine);
        })
        .catch(function () { toast('评分失败，稍后再试'); paint(mine); })
        .finally(function () { starEls.forEach(function (s) { s.disabled = false; }); });
    });

    /* 键盘：左右方向键调票数 */
    starsBox.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = Math.min(5, Math.max(1, mine + (e.key === 'ArrowRight' ? 1 : -1)));
      var btn = starEls[next - 1];
      if (btn) btn.focus();
      paint(next);
    });
  }

  /* 1.5.1) 游客：星级是只读的（服务端给游客渲染的是 .stars.locked，没有 #stars / #rateInfo，
     所以上面的整块逻辑会被跳过），点一下直接送去登录页 —— 免得星星看着能点、点了却没反应（用户报的「无法打星」）。 */
  var lockedStars = document.querySelector(".stars.locked");
  if (lockedStars) {
    lockedStars.addEventListener("click", function () {
      location.href = "/login?next=" + encodeURIComponent(location.pathname);
    });
  }

  /* 1.6) 收藏：登录才能用，未登录引导去登录页 */
  var favBtn = document.getElementById('favBtn');
  if (favBtn) {
    favBtn.addEventListener('click', function () {
      favBtn.disabled = true;
      fetch('/api/games/' + encodeURIComponent(favBtn.dataset.slug) + '/favorite', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.d && res.d.error === 'login_required') {
            location.href = '/login?next=' + encodeURIComponent(location.pathname);
            return;
          }
          if (!res.ok) throw new Error('fav failed');
          var on = !!res.d.favorited;
          favBtn.dataset.on = on ? '1' : '0';
          favBtn.setAttribute('aria-pressed', String(on));
          favBtn.innerHTML = (on ? '♥ 已收藏' : '♡ 收藏') + ' <b id="favCount">' + res.d.count + '</b>';
          toast(on ? '已加入收藏夹' : '已取消收藏');
        })
        .catch(function () { toast('操作失败，稍后再试'); })
        .finally(function () { favBtn.disabled = false; });
    });
  }

  /* 1.7) 发表评论 / 回复：成功后把新内容插进列表，不刷新页面 */
  var cmtForm = document.getElementById('cmtForm');
  if (cmtForm) {
    var cmtParent = 0;
    var ta = document.getElementById('cmtBody');
    var parentBox = document.getElementById('cmtParent');
    var replyHint = document.getElementById('cmtReplyHint');
    var replyName = document.getElementById('cmtReplyName');

    function setReply(id, name) {
      cmtParent = Number(id) || 0;
      if (parentBox) parentBox.value = cmtParent ? String(cmtParent) : '';
      if (replyName) replyName.textContent = name || '';
      if (replyHint) replyHint.hidden = !cmtParent;
    }

    // 点「回复」：带上楼层作者名，方便用户知道在回谁
    var cmtPanel = document.getElementById('cmtPanel');
    if (cmtPanel) {
      cmtPanel.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-reply]') : null;
        if (!btn) return;
        var li = btn.closest('.cmt');
        var who = li && li.querySelector('.cmt-head b');
        setReply(btn.dataset.reply, who ? who.textContent : '');
        if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      });
    }
    var cancelBtn = document.getElementById('cmtReplyCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { setReply(0); });

    // 作者名与正文都走 textContent，防止评论内容注入标签
    function makeItem(item, isReply) {
      var li = document.createElement('li');
      li.className = isReply ? 'cmt-reply new' : 'cmt new';
      li.dataset.id = String(item.id);
      if (!isReply) li.id = 'cmt' + item.id;
      var head = document.createElement('div');
      head.className = 'cmt-head';
      var b = document.createElement('b');
      b.textContent = item.name || '';
      var time = document.createElement('time');
      time.textContent = '刚刚';
      head.appendChild(b);
      head.appendChild(time);
      var p = document.createElement('p');
      p.textContent = item.body || '';
      li.appendChild(head);
      li.appendChild(p);
      return li;
    }

    function insert(item) {
      var list = document.getElementById('cmtList');
      if (!list) return;
      var empty = list.querySelector('.cmt-empty');
      if (empty) empty.remove();
      var pid = Number(item.parent_id) || 0;
      var root = pid ? list.querySelector('li.cmt[data-id="' + pid + '"]') : null;
      if (!root) { list.insertBefore(makeItem(item, false), list.firstChild); return; }
      var ul = root.querySelector('.cmt-replies');
      if (!ul) {
        ul = document.createElement('ul');
        ul.className = 'cmt-replies';
        root.appendChild(ul);
      }
      ul.appendChild(makeItem(item, true));
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    cmtForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = (ta.value || '').trim();
      if (!text) { toast('先写点什么吧'); return; }
      var btn = cmtForm.querySelector('button[type="submit"]') || cmtForm.querySelector('button');
      btn.disabled = true;
      var payload = cmtParent ? { body: text, parent_id: cmtParent } : { body: text };
      fetch('/api/games/' + encodeURIComponent(cmtForm.dataset.slug) + '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.d && res.d.error === 'login_required') {
            location.href = '/login?next=' + encodeURIComponent(location.pathname);
            return;
          }
          if (!res.ok) throw new Error(res.d.hint || 'comment failed');
          insert(res.d);
          var c = document.getElementById('cmtCount');
          if (c) c.textContent = String((Number(c.textContent) || 0) + 1);
          ta.value = '';
          setReply(0);
          toast(res.d.parent_id ? '回复已发表' : '评论已发表');
        })
        .catch(function (err) { toast(err && err.message ? err.message : '发表失败，稍后再试'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  /* 2) 工具栏按钮 */
  player.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.dataset.act;

    if (act === 'reload') {
      // 重建 iframe 才能真正重置游戏状态
      var clone = frame.cloneNode(false);
      clone.src = player.dataset.url + '?_t=' + Date.now();
      frame.replaceWith(clone);
      frame = clone;
      toast('已重新开始');
    }

    if (act === 'fullscreen') {
      var box = player;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (box.requestFullscreen) {
        box.requestFullscreen().catch(function () { toast('当前浏览器不支持全屏'); });
      } else if (frame.requestFullscreen) {
        frame.requestFullscreen();
      } else {
        toast('当前浏览器不支持全屏');
      }
    }
  });

  /* 3) 全屏时同步按钮文案 */
  document.addEventListener('fullscreenchange', function () {
    var btn = player.querySelector('[data-act="fullscreen"]');
    if (btn) btn.textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏';
  });

  /* 4) 键盘：F 全屏，R 重开（不在输入框里时） */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'f' || e.key === 'F') {
      var btn = player.querySelector('[data-act="fullscreen"]');
      if (btn) btn.click();
    }
    if (e.key === 'r' || e.key === 'R') {
      var rb = player.querySelector('[data-act="reload"]');
      if (rb) rb.click();
    }
  });

  /* 5) 键盘操作时别让页面跟着滚动 */
  window.addEventListener('keydown', function (e) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) === -1) return;
    if (!document.activeElement || document.activeElement.tagName !== 'IFRAME') {
      if (document.fullscreenElement === player) e.preventDefault();
    }
  }, { passive: false });

  /* 手柄：检测到手柄就把焦点交给游戏 iframe，手柄输入才进得去（游戏页里的映射见 public/js/gamepad.js） */
  (function () {
    var gf = document.getElementById('gameFrame');
    if (!gf || !navigator.getGamepads) return;
    var focusFrame = function () {
      var ae = document.activeElement;
      if (ae && ae !== document.body && ae !== gf) return;   /* 用户正在别处输入，别抢焦点 */
      try { gf.focus(); } catch (e) { }
    };
    window.addEventListener('gamepadconnected', focusFrame);
    var tries = 0;
    var timer = setInterval(function () {
      if (++tries > 150) { clearInterval(timer); return; }
      var pads = navigator.getGamepads(), has = false;
      for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) has = true;
      if (has) focusFrame();
    }, 1000);
  })();
})();
