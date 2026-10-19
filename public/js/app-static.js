/* 静态版前端脚本（GitHub Pages 用）：没有服务端，只做播放器控制、列表排序、搜索过滤。
   播放器逻辑对应 public/js/app.js 里的全屏/重开/收藏/评分/评论，静态版把服务端相关的都去掉了。 */
(function () {
  "use strict";

  /* 公告横幅：关掉后同一条不再弹（关闭状态记在浏览器本地） */
  (function () {
    var bar = document.getElementById('noticeBar');
    if (!bar) return;
    var key = 'noticeOff:' + (bar.dataset.slug || '');
    try { if (localStorage.getItem(key)) { bar.remove(); return; } } catch (e) { }
    var btn = document.getElementById('noticeClose');
    if (btn) btn.addEventListener('click', function () {
      try { localStorage.setItem(key, '1'); } catch (e) { }
      bar.remove();
    });
  })();

  var frame = document.getElementById("gameFrame");
  var player = document.getElementById("player");
  var params = new URLSearchParams(location.search);

  /* 顶部搜索框回填 */
  var q = params.get("q") || "";
  var input = document.querySelector(".search input[name=q]");
  if (input && q) input.value = q;

  /* ---------- 静态版搜索增强：浏览器里补「拼音 / 首字母 / 相关度」 ----------
     静态版没有服务端接口，用构建时导出的 data/games.json（每款游戏带 py = 全拼 + 首字母）做：
     1) 顶部搜索框下拉建议（和动态版 /api/search/suggest 一样的观感）
     2) 搜索页按相关度重排 / 过滤卡片，中文、全拼（tanchishe）、首字母（tcs）都能命中 */
  var BASE = (function () {
    var el = document.currentScript;
    var src = (el && el.getAttribute("src")) || "/static/js/app-static.js";
    var cut = src.indexOf("static/js/app-static.js");
    return cut > 0 ? src.slice(0, cut) : "/";
  })();
  var GAMES = null, loading = null, indexMap = {};

  function loadGames() {
    if (GAMES) return Promise.resolve(GAMES);
    if (loading) return loading;
    loading = fetch(BASE + "data/games.json")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        GAMES = (d.games || []).map(function (g) {
          var tags = Array.isArray(g.tags) ? g.tags.join(" ") : (g.tags || "");
          return {
            slug: g.slug, title: g.title, emoji: g.emoji,
            category: g.category_name || "",
            plays: Number(g.plays) || 0,
            hay: [g.title, g.subtitle, tags, g.py].filter(Boolean).join(" ").toLowerCase()
          };
        });
        GAMES.forEach(function (g) { indexMap[g.slug] = g.hay; });
        return GAMES;
      })
      .catch(function () { GAMES = []; return GAMES; });
    return loading;
  }

  /* 相关度：标题完全相同 < 标题前缀 < 标题包含 < 拼音/其它命中，同档按游玩次数排 */
  function scoreOf(g, text) {
    var t = (g.title || "").toLowerCase();
    if (t === text) return 0;
    if (t.indexOf(text) === 0) return 1;
    if (t.indexOf(text) >= 0) return 2;
    if (g.hay.indexOf(text) >= 0) return 3;
    return 9;
  }
  function matchGames(text) {
    var words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (GAMES || []).filter(function (g) {
      return words.every(function (w) { return g.hay.indexOf(w) >= 0; });
    }).sort(function (a, b) {
      return scoreOf(a, text.toLowerCase()) - scoreOf(b, text.toLowerCase()) || b.plays - a.plays;
    });
  }

  var sugBox = document.getElementById("sug");
  if (sugBox && input) {
    (function () {
      var rows = [], cur = -1, timer = null, want = "";
      function clear() { while (sugBox.firstChild) sugBox.removeChild(sugBox.firstChild); rows = []; cur = -1; }
      function close() { clear(); sugBox.hidden = true; }
      function mark(i) {
        for (var k = 0; k < rows.length; k++) rows[k].classList.toggle("on", k === i);
        cur = i;
      }
      function open(list) {
        clear();
        if (!list.length) {
          var none = document.createElement("div");
          none.className = "s-none";
          none.textContent = "没有匹配的游戏，回车看全部结果";
          sugBox.appendChild(none);
          sugBox.hidden = false;
          return;
        }
        list.slice(0, 6).forEach(function (g) {
          var a = document.createElement("a");
          a.href = BASE + "game/" + encodeURIComponent(g.slug) + ".html";
          var ico = document.createElement("span");
          ico.className = "s-ico";
          ico.textContent = g.emoji || "🎮";
          var t = document.createElement("span");
          t.className = "s-t";
          t.textContent = g.title || "";
          var m = document.createElement("span");
          m.className = "s-m";
          m.textContent = [g.category, g.plays ? g.plays + " 次" : ""].filter(Boolean).join(" · ");
          a.appendChild(ico); a.appendChild(t); a.appendChild(m);
          a.addEventListener("mouseenter", function () { mark(rows.indexOf(a)); });
          sugBox.appendChild(a);
          rows.push(a);
        });
        sugBox.hidden = false;
        mark(-1);
      }
      function load(text) {
        want = text;
        loadGames().then(function () {
          if (want === text) open(matchGames(text));
        });
      }
      input.addEventListener("input", function () {
        var text = (input.value || "").trim();
        clearTimeout(timer);
        if (!text) { close(); return; }
        timer = setTimeout(function () { load(text); }, 120);
      });
      input.addEventListener("keydown", function (e) {
        if (sugBox.hidden || !rows.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); mark(cur + 1 >= rows.length ? 0 : cur + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); mark(cur - 1 < 0 ? rows.length - 1 : cur - 1); }
        else if (e.key === "Enter") {
          if (cur >= 0) { e.preventDefault(); location.href = rows[cur].href; }
          else close();
        } else if (e.key === "Escape") { close(); }
      });
      input.addEventListener("blur", function () { setTimeout(close, 150); });
      document.addEventListener("click", function (e) {
        if (!sugBox.hidden && e.target !== input && !sugBox.contains(e.target)) close();
      });
    })();
  }


  /* 播放器按钮：全屏 / 重开 */
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document.body && !(el.getAttribute && el.getAttribute("data-act"))) el = el.parentNode;
    if (!el || !el.getAttribute) return;
    var act = el.getAttribute("data-act");
    if (act === "fullscreen") {
      var stage = document.getElementById("stage") || player;
      if (stage && stage.requestFullscreen) {
        var p = stage.requestFullscreen();
        if (p && p.then) p.then(function () {
          /* 横屏比例的游戏：手机上进全屏顺手锁横屏，失败就保持原样 */
          try {
            var ply = document.getElementById("player");
            if (ply && ply.className.indexOf("player--wide") >= 0 &&
              screen.orientation && screen.orientation.lock &&
              window.matchMedia("(pointer:coarse)").matches) {
              var lk = screen.orientation.lock("landscape");
              if (lk && lk.catch) lk.catch(function () {});
            }
          } catch (err) {}
        });
        if (p && p.catch) p.catch(function () {});
      }
    } else if (act === "reload" && frame) {
      frame.src = frame.getAttribute("src");
    }
  });

  /* 列表页（有 .page-head 的才是列表页）：排序 + 搜索过滤 */
  var head = document.querySelector(".page-head");
  var grid = document.querySelector(".grid");
  if (!head || !grid) return;
  var cards = Array.prototype.slice.call(grid.children);

  function num(card, key) { return parseFloat(card.getAttribute("data-" + key)) || 0; }
  function str(card, key) { return card.getAttribute("data-" + key) || ""; }
  function byHot(a, b) { return num(b, "plays") - num(a, "plays"); }
  function byNew(a, b) { return str(b, "created").localeCompare(str(a, "created")); }
  function byRating(a, b) { return num(b, "rating") - num(a, "rating") || num(b, "votes") - num(a, "votes"); }
  function byTitle(a, b) { return str(a, "title").localeCompare(str(b, "title"), "zh-Hans-CN"); }
  var sorters = { hot: byHot, new: byNew, rating: byRating, title: byTitle };
  var sort = params.get("sort") || "hot";
  if (!sorters[sort]) sort = "hot";
  cards.slice().sort(sorters[sort]).forEach(function (c) { grid.appendChild(c); });

  var tabs = document.querySelectorAll(".tabs .tab");
  Array.prototype.forEach.call(tabs, function (t) {
    t.classList.toggle("on", (t.getAttribute("href") || "").indexOf("sort=" + sort) >= 0);
  });

  /* 搜索页：服务端没有查询参数可用，改成前端过滤这一页已渲染的卡片；
     拼音索引（data/games.json 的 py）到了以后再算一遍，顺便按相关度重排。 */
  var noHitTip = null;
  function cardHay(c) {
    var slug = c.getAttribute("data-slug") || "";
    return (str(c, "title") + " " + str(c, "sub") + " " + str(c, "tags") + " " + c.textContent + " " + (indexMap[slug] || "")).toLowerCase();
  }
  function cardScore(c, text) {
    var t = str(c, "title").toLowerCase();
    if (t === text) return 0;
    if (t.indexOf(text) === 0) return 1;
    if (t.indexOf(text) >= 0) return 2;
    return 3;
  }
  function applyFilter() {
    var text = (q || "").toLowerCase();
    var words = text.split(/\s+/).filter(Boolean);
    var hits = cards.filter(function (c) {
      var hay = cardHay(c);
      return words.length && words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
    cards.forEach(function (c) { c.style.display = "none"; });
    hits.sort(function (a, b) {
      return cardScore(a, text) - cardScore(b, text) || num(b, "plays") - num(a, "plays");
    }).forEach(function (c) { c.style.display = ""; grid.appendChild(c); });
    if (noHitTip) { noHitTip.remove(); noHitTip = null; }
    if (!hits.length) {
      noHitTip = document.createElement("p");
      noHitTip.className = "empty";
      noHitTip.textContent = "😢 没有找到「" + q + "」相关的小游戏，换个关键词试试";
      grid.parentNode.insertBefore(noHitTip, grid);
    }
    return hits.length;
  }
  if (q) {
    var h1 = head.querySelector("h1");
    if (h1) h1.textContent = "「" + q + "」的搜索结果";
    var count = head.querySelector(".page-count");
    document.title = (h1 ? h1.textContent : q) + " - 趣玩小游戏";
    var shown0 = applyFilter();
    if (count) count.textContent = "共找到 " + shown0 + " 款游戏";
    loadGames().then(function () {
      var shown = applyFilter();
      if (count) count.textContent = "共找到 " + shown + " 款游戏";
    });
  }

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

  /* 手机端顶栏折叠菜单：点导航项 / 按 Esc 后自动收起 */
  (function () {
    var cb = document.getElementById("mnavToggle");
    if (!cb) return;
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!cb.checked || !t || !t.closest) return;
      var hit = t.closest(".nav a,.acct a,.acct button,form.inline button");
      if (hit || t.closest("main,.ftr,.skip")) cb.checked = false;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && cb.checked) cb.checked = false;
    });
  })();

  /* ---------- PWA：注册 Service Worker ----------
     动态线（Express / Cloudflare Worker）由 src/views.js 的 head 内联脚本负责；
     静态线（STATIC_MODE 不输出内联脚本）由这里负责，两处互补且幂等。
     只在 https 或 localhost 注册；失败静默 —— 没有 /sw.js 也只是安静跳过，不影响任何功能。
     只在根路径部署（BASE === "/"）注册：public/sw.js 的内部路径全是根相对的（离线壳取 "/"、
     静态前缀是 /static/、/games/…），子路径部署（GitHub Pages 仓库站点）注册它只会把父站点首页
     当成离线壳缓存下来 —— 那种场景只享受 manifest 与图标。 */
  (function () {
    if (window.__pwaSW) return;
    if (BASE !== "/") return;
    if (!("serviceWorker" in navigator)) return;
    var h = location.hostname;
    var local = location.protocol === "http:" && (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1");
    if (location.protocol !== "https:" && !local) return;
    window.__pwaSW = 1;
    addEventListener("load", function () {
      navigator.serviceWorker.register(BASE + "sw.js").catch(function () { });
    });
  })();
})();
