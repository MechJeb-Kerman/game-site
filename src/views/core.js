import { isUploadedUrl, UPLOAD_LABEL } from '../upload.js';
import { CHANGELOG, CHANGELOG_GENERATED, CHANGELOG_TOTAL } from '../changelog-data.js';
import { makeupCheck } from '../daily.js';
import { rewardsOf, rewardSummary } from '../rewards.js';
import { groupedSites, siteUrl } from '../sites.js';
import { coverFor } from '../covers.js';
import { gameJsonLd, websiteJsonLd } from '../seo.js';

export { isUploadedUrl, UPLOAD_LABEL, CHANGELOG, CHANGELOG_GENERATED, CHANGELOG_TOTAL, makeupCheck, rewardsOf, rewardSummary, groupedSites, siteUrl, coverFor, gameJsonLd, websiteJsonLd };
/** 服务端 HTML 模板（纯字符串渲染，零模板引擎依赖） */
// 更新说明页的数据源：由 tools/gen-changelog.mjs 从 git 提交历史生成
// 每日挑战的实质奖励（8 档，快照口径）：经验与徽章经验叠加算等级
// 导航页的数据源：fishport.cn 下能打开的站点清单（三条线共用一份）
// 23 款游戏的静态封面（public/covers/*.svg）：命中就用真封面，没命中回落动态 /cover/:slug.svg
// 结构化数据（WebSite / VideoGame）只留一份定义在 seo.js，服务端渲染与静态导出共用

export const SITE = {
  name: '趣玩小游戏',
  tagline: '免费在线小游戏，即点即玩，无需下载',
  logo: '🎮',
  icp: '本站游戏均为自研或已获授权，仅供学习交流使用',
  contact: 'maohong0831@outlook.com'
};

// 静态导出（GitHub Pages）模式：没有服务端，账号/评分/评论/收藏/游玩统计一律不渲染
export let STATIC_MODE = false;

export function setStaticMode(on) { STATIC_MODE = !!on; }

export const isStaticMode = () => STATIC_MODE;

export const HINTS = {
  '2048': '方向键 ↑↓←→ 或 WASD 移动，手机端滑动屏幕，手柄用十字键 / 左摇杆',
  snake: '方向键 / WASD 控制方向，手机端滑动屏幕，手柄用十字键 / 左摇杆，A 或 Start 开始 / 暂停',
  memory: '点击卡片翻开，找出两张相同的图案，手柄用左摇杆移动光标 + A 键翻牌',
  whack: '点击或触摸地鼠即可敲击，金色地鼠双倍得分，手柄用左摇杆移动光标 + A 键敲',
  tictactoe: '点击空格落子，先连成三子的一方获胜，手柄用左摇杆移动光标 + A 键落子',
  tetris: '← → 移动，↑ 旋转，↓ 加速下落，空格直接落下，手柄用十字键 / 左摇杆 + A 键速降 + Start 暂停',
  gomoku: '点击棋盘落子，横竖斜先连成五子者胜；人机模式可选难度，联机模式开房间或用房间码加入，手柄用左摇杆移动光标 + A 键落子',
  xiangqi: '点击己方棋子选中、再点目标位置走子；人机模式可选难度，联机模式开房间或用房间码加入，手柄用左摇杆移动光标 + A 键选子 / 落子',
  chess: '点击己方棋子选中（绿点是可走位置）、再点目标格走子；人机模式可选难度，联机模式开房间或用房间码加入，手柄用左摇杆移动光标 + A 键选子 / 落子',
  blackhole: '拖拽 / WASD / 方向键移动黑洞，吃掉更小的天体变大；空格冲刺、Q 无敌、E 引力爆发、F 引力炸弹、P 暂停、F3 帮助，手柄用左摇杆 + A / B / X / Y'
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

/* PWA：注册 Service Worker。静态导出线由 public/js/app-static.js 里等价的兜底逻辑覆盖，两处互补。
   只在 https 或 localhost 注册；失败静默，绝不影响页面。 */
export function pwaRegisterScript() {
  return `<script>
(function () {
  if (window.__pwaSW) return;
  if (!('serviceWorker' in navigator)) return;
  var h = location.hostname;
  var local = location.protocol === 'http:' && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1');
  if (location.protocol !== 'https:' && !local) return;
  window.__pwaSW = 1;
  addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
})();
</script>`;
}

/**
 * 页面骨架。
 * ogImage：社交平台预览图，必须是**绝对地址**（如 origin + '/play/1/card.svg'）；不传就退回站内默认图
 * origin + '/static/img/og.svg'，其它页面的输出与改动前逐字节一致。
 */
/* 浏览器推送的开关面板：只在通知中心出现，服务端没配 VAPID 时整段退化成一行说明。
   订阅走 /api/push/{key,subscribe,unsubscribe}，加密在服务端做，浏览器只交 PushSubscription。 */
export function pushScript() {
  return `<script>
(function () {
  var box = document.getElementById('pushBox');
  var btn = document.getElementById('pushToggle');
  var hint = document.getElementById('pushHint');
  if (!box || !btn || !hint) return;
  box.hidden = false;
  function say(t) { hint.textContent = t; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say('当前浏览器不支持网页推送（需要 HTTPS 站点与现代浏览器）。');
    return;
  }
  var state = { on: false, configured: false, key: '' };
  function b64uToBytes(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function paint() {
    if (!state.configured) {
      btn.hidden = true;
      say('站点还没配置推送密钥（VAPID），暂时只能在站内看通知。');
      return;
    }
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = state.on ? '关闭浏览器推送' : '开启浏览器推送';
    say(state.on
      ? '已开启：有人回复、@你、关注你或有新私信时，浏览器会主动弹出提醒（可在系统通知设置里关掉）。'
      : '开启后，别人回复你、在帖子里 @你、关注你或给你发私信时，浏览器会主动提醒——不必一直守着页面。');
  }
  function load() {
    fetch('/api/push/key', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        state.configured = !!(d && d.configured && d.publicKey);
        state.key = (d && d.publicKey) || '';
        state.on = !!(d && d.subscribed);
        paint();
      })
      .catch(function () { say('读取推送配置失败，稍后刷新再试。'); });
  }
  btn.addEventListener('click', function () {
    btn.disabled = true;
    if (state.on) {
      navigator.serviceWorker.ready
        .then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (sub) {
          var ep = sub ? sub.endpoint : '';
          return (sub ? sub.unsubscribe() : Promise.resolve(true)).then(function () {
            return fetch('/api/push/unsubscribe', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ endpoint: ep })
            });
          });
        })
        .then(function () { state.on = false; paint(); })
        .catch(function () { paint(); });
      return;
    }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') {
        say('浏览器拒绝了通知权限：可以在地址栏左侧的站点设置里重新允许，然后再点一次。');
        btn.disabled = false;
        return null;
      }
      return navigator.serviceWorker.ready
        .then(function (reg) {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(state.key) });
        })
        .then(function (sub) {
          return fetch('/api/push/subscribe', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() })
          });
        })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.ok) { state.on = true; paint(); return; }
          say('订阅失败：' + ((d && d.error) || '服务器拒绝了这次订阅'));
          btn.disabled = false;
        });
    }).catch(function () { btn.disabled = false; });
  });
  load();
})();
</script>`;
}

export function layout({ origin = '', title, description, path = '/', content, jsonLd = null, preload = '', user = null, noindex = false, chrome = 'site', titleSuffix = true, bodyClass = '', ogImage = '' }) {
  const bare = chrome === 'none';
  const full = title ? (titleSuffix ? title + ' - ' + SITE.name : title) : SITE.name;
  const ld = jsonLd
    ? '<script type="application/ld+json">' + JSON.stringify(jsonLd).replace(/</g, '\\u003c') + '</script>'
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description || SITE.tagline)}">
<meta name="theme-color" content="#0b1020">
${noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<link rel="canonical" href="${esc(origin + path)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description || SITE.tagline)}">
<meta property="og:url" content="${esc(origin + path)}">
<meta property="og:image" content="${esc(ogImage || origin + '/static/img/og.svg')}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png">
<link rel="stylesheet" href="/static/css/style.css?v=10">
${preload}${ld}${STATIC_MODE ? '' : pwaRegisterScript()}
<script>try{if(localStorage.getItem('railOff')==='1')document.documentElement.classList.add('rail-off')}catch(e){}</script>
</head>
<body${bodyClass ? ' class="' + bodyClass + '"' : ''}>
<a class="skip" href="#main">跳到主要内容</a>
${bare ? '' : pageRail()}
${bare ? '' : header(user)}
<main id="main">${content}</main>
${bare ? '' : footer()}
<script src="/static/js/${STATIC_MODE ? "app-static" : "app"}.js?v=10" defer></script>
<script src="/static/js/offline-wire.js?v=10" defer></script>
</body>
</html>`;
}

export function header(user = null) {
  // 登录态直接体现到导航：没登录给「登录 / 注册」，登录了给昵称 + 收藏夹 + 退出
  const account = STATIC_MODE
    ? ''
    : user
    ? '<span class="who"><b>' + esc(user.name) + '</b>' + (user.role === 'admin' ? '<i>站长</i>' : '') +
        (user.email && !user.email_verified ? '<i class="warn" title="邮箱还没验证">邮箱未验证</i>' : '') + '</span>' +
      '<a href="/favorites">收藏夹</a>' +
      '<a href="/feed">好友动态</a>' +
      // 未读数由 app.js 拉 /api/notifications/unread 与 /api/messages/unread 填，红点默认藏着
      '<a href="/notifications" data-unread="notifications">通知<em class="dot" hidden></em></a>' +
      '<a href="/messages" data-unread="messages">私信<em class="dot" hidden></em></a>' +
      '<a href="/account">账号</a>' +
      (user.role === 'admin' ? '<a href="/admin">后台</a>' : '') +
      '<form class="inline" action="/logout" method="post"><button class="linkbtn" type="submit">退出</button></form>'
    : '<a href="/login">登录</a>' +
      '<a class="nav-cta" href="/register">注册</a>';
  return `<header class="hdr">
  <div class="wrap hdr-in">
    <input type="checkbox" id="mnavToggle" class="mnav-cb">
    <label class="mnav-btn" for="mnavToggle" title="展开导航菜单"><span aria-hidden="true">☰</span><b>菜单</b></label>
    <a class="logo" href="/" aria-label="${esc(SITE.name)}首页">
      <span class="logo-ico">${SITE.logo}</span>
      <span class="logo-txt">趣玩<em>小游戏</em></span>
    </a>
    <div class="search-wrap">
      <form class="search" action="/search" method="get" role="search">
        <input type="search" name="q" placeholder="搜索游戏，如 2048 / 贪吃蛇" aria-label="搜索游戏" autocomplete="off" enterkeyhint="search" autocapitalize="off" spellcheck="false">
        <button type="submit" aria-label="搜索">🔍</button>
      </form>
      <div class="sug" id="sug" hidden></div>
    </div>
    <nav class="nav" aria-label="主导航">
      <a href="/">首页</a>
      <a href="/games">全部游戏</a>
      <a href="/hot">热度榜</a>
      <a href="/rank">排行榜</a>
      ${STATIC_MODE ? '' : '<a href="/daily">每日挑战</a>'}
      <a href="/notice">公告</a>
      ${STATIC_MODE ? '' : '<a href="/forum">论坛</a>'}
      <a href="/category/action">动作</a>
      <a href="/category/puzzle">益智</a>
      <a href="/category/casual">休闲</a>
      <a href="/category/board">棋牌</a>
      ${STATIC_MODE ? '' : '<a href="/submit">投稿</a>'}
    </nav>
    <div class="acct">${account}</div>
  </div>
</header>`;
}

/* 页面栏：桌面端左侧可折叠导航。移动端仍用顶栏的 ☰ 抽屉，两者互不干扰。
   分组顺序按使用频率排：发现 → 分类 → 社区；STATIC_MODE 下没有服务端路由的项自动隐藏。 */
export function pageRail() {
  const groups = [
    { title: '发现', items: [
      ['/', '🏠', '首页'], ['/games', '🎮', '全部游戏'], ['/hot', '🔥', '热度榜'], ['/rank', '🏆', '排行榜']
    ] },
    { title: '分类', items: [
      ['/category/action', '🕹', '动作'], ['/category/puzzle', '🧩', '益智'],
      ['/category/casual', '☕', '休闲'], ['/category/board', '♟', '棋牌']
    ] },
    { title: '社区', items: [
      STATIC_MODE ? null : ['/daily', '🎯', '每日挑战'],
      ['/notice', '📢', '公告'],
      STATIC_MODE ? null : ['/forum', '💬', '论坛'],
      STATIC_MODE ? null : ['/submit', '✍️', '投稿']
    ] }
  ];
  const body = groups.map((g) => {
    const links = g.items.filter(Boolean).map(([href, ico, label]) =>
      '<a href="' + href + '" title="' + label + '"><span class="ri" aria-hidden="true">' + ico + '</span>' +
      '<span class="rl">' + label + '</span></a>').join('');
    return '<p class="rail-h">' + g.title + '</p>' + links;
  }).join('');
  return `<aside class="rail" id="rail">
  <button class="rail-toggle" id="railToggle" type="button" aria-controls="railNav" aria-expanded="true" title="折叠页面栏">
    <span class="ri" aria-hidden="true">☰</span><span class="rl">页面</span>
  </button>
  <nav class="rail-nav" id="railNav" aria-label="页面栏">${body}</nav>
</aside>`;
}

/* 排名涨跌的小标签：move > 0 上升，move < 0 下降，hasPrev 为假说明是本期新上榜 */
export function moveTag(r) {
  if (!r.hasPrev) return '<span class="mv new">新上榜</span>';
  const m = Number(r.move) || 0;
  if (m > 0) return '<span class="mv up" title="较上一周期上升">▲' + m + '</span>';
  if (m < 0) return '<span class="mv down" title="较上一周期下降">▼' + Math.abs(m) + '</span>';
  return '<span class="mv flat">—</span>';
}

export const BOARD_UNIT = { plays: '次', plays_all: '次', rating: '分', fav: '人收藏', new: '款' };

/** 排行榜页：热玩榜按时间窗统计 play_logs，评分/收藏/新作榜是现状快照 */
export function trendTag(trend) {
  if (trend === 'up') return '<span class="mv up" title="今日播放高于近两天的日均">▲ 升温</span>';
  if (trend === 'down') return '<span class="mv down" title="今日播放低于近两天的日均">▼ 降温</span>';
  return '<span class="mv flat">—</span>';
}

/**
 * 热度榜页。和 /rank 的热玩榜不同：这里不是「窗口内累计次数」，而是把
 * 今日 / 近 3 天 / 近 7 天三档动量做递减加权，再乘评分质量与上架衰减，
 * 所以刚火起来的游戏能立刻冒头，而长期没人玩的会自己沉下去。
 * 分数由 src/hot.js 现算（60 秒进程内缓存），三档原始播放量一并摊开便于判断走势。
 */
export function footer() {
  return `<footer class="ftr">
  <div class="wrap">
    <p class="ftr-note">${esc(SITE.name)} · ${esc(SITE.tagline)}</p>
    <p class="ftr-note">${esc(SITE.icp)}</p>
    <p class="ftr-links"><a href="/privacy">隐私政策</a><span>·</span><a href="/terms">用户协议</a><span>·</span><a href="/changelog">更新说明</a><span>·</span><a href="/sitemap.xml">网站地图</a><span>·</span><a href="/robots.txt">robots.txt</a>${STATIC_MODE ? '' : '<span>·</span><a href="/api/games">开放接口</a>'}</p>
  </div>
</footer>`;
}

export function gameCard(g) {
  const votes = Number(g.rating_count) || 0;
  const score = votes ? '⭐ ' + Number(g.rating).toFixed(1) : '☆ 未评';
  const scoreTip = votes ? votes + ' 人评分' : '还没有人评分';
  return `<a class="card" href="/game/${esc(g.slug)}" data-slug="${esc(g.slug)}" data-title="${esc(g.title)}" data-sub="${esc(g.subtitle || '')}" data-tags="${esc(Array.isArray(g.tags) ? g.tags.join(' ') : '')}" data-plays="${Number(g.plays) || 0}" data-rating="${Number(g.rating) || 0}" data-votes="${votes}" data-created="${esc(String(g.created_at || '').slice(0, 10))}">
  <span class="card-cover" style="--a:${esc(g.accent)};--b:${esc(g.accent2)}">
    <img src="${esc((coverFor(g.slug) || {}).src || '/cover/' + g.slug + '.svg')}" alt="${esc((coverFor(g.slug) || {}).alt || g.title + '封面')}" loading="lazy" decoding="async" width="320" height="200">
    <span class="card-badge">${esc(g.category ? g.category.icon + ' ' + g.category.name : '游戏')}</span>
  </span>
  <span class="card-body">
    <span class="card-title">${esc(g.title)}</span>
    <span class="card-meta"><em title="${esc(scoreTip)}">${score}</em><i>🔥 ${fmtNum(g.plays)}</i></span>
  </span>
</a>`;
}

export function gameGrid(list) {
  if (!list.length) return '<p class="empty">😢 暂时没有找到相关游戏，换个关键词试试</p>';
  return '<div class="grid">' + list.map(gameCard).join('') + '</div>';
}

export function section(title, icon, list, moreHref) {
  if (!list.length) return '';
  return `<section class="sec">
  <div class="sec-head">
    <h2>${icon} ${esc(title)}</h2>
    ${moreHref ? `<a class="more" href="${moreHref}">更多 ›</a>` : ''}
  </div>
  ${gameGrid(list)}
</section>`;
}

/** 正文摘要：公告列表与 meta description 用 */
export function excerpt(text, n = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 首页顶部的公告横幅：可关掉，关闭状态记在浏览器本地（同一条不再弹） */
export function noticeBanner(post) {
  if (!post) return '';
  return `<div class="notice-bar" id="noticeBar" data-slug="${esc(post.slug)}">
  <span class="nb-tag">📢 公告</span>
  <a class="nb-txt" href="/notice/${encodeURIComponent(post.slug)}">${esc(post.title)}${Number(post.pinned) ? '<i class="nb-pin">置顶</i>' : ''}</a>
  <button class="nb-close" id="noticeClose" type="button" aria-label="关闭公告">✕</button>
</div>`;
}
