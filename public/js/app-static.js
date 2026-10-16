/* 静态版前端脚本（GitHub Pages 用）：没有服务端，只做播放器控制、列表排序、搜索过滤。
   播放器逻辑对应 public/js/app.js 里的全屏/重开/收藏/评分/评论，静态版把服务端相关的都去掉了。 */
(function () {
  "use strict";

  var frame = document.getElementById("gameFrame");
  var player = document.getElementById("player");
  var params = new URLSearchParams(location.search);

  /* 顶部搜索框回填 */
  var q = params.get("q") || "";
  var input = document.querySelector(".search input[name=q]");
  if (input && q) input.value = q;

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

  /* 搜索页：服务端没有查询参数可用，改成前端过滤这一页已渲染的卡片 */
  if (q) {
    var needle = q.toLowerCase();
    var shown = 0;
    cards.forEach(function (c) {
      var hay = (str(c, "title") + " " + str(c, "sub") + " " + str(c, "tags") + " " + c.textContent).toLowerCase();
      var hit = hay.indexOf(needle) >= 0;
      c.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    var h1 = head.querySelector("h1");
    if (h1) h1.textContent = "「" + q + "」的搜索结果";
    var count = head.querySelector(".page-count");
    if (count) count.textContent = "共找到 " + shown + " 款游戏";
    document.title = (h1 ? h1.textContent : q) + " - 趣玩小游戏";
    if (!shown) {
      var tip = document.createElement("p");
      tip.className = "empty";
      tip.textContent = "😢 没有找到「" + q + "」相关的小游戏，换个关键词试试";
      grid.parentNode.insertBefore(tip, grid);
    }
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
})();
