/** 服务端 HTML 模板（纯字符串渲染，零模板引擎依赖） */

export const SITE = {
  name: '趣玩小游戏',
  tagline: '免费在线小游戏，即点即玩，无需下载',
  logo: '🎮',
  icp: '本站游戏均为自研或已获授权，仅供学习交流使用'
};

// 静态导出（GitHub Pages）模式：没有服务端，账号/评分/评论/收藏/游玩统计一律不渲染
let STATIC_MODE = false;
export function setStaticMode(on) { STATIC_MODE = !!on; }

export const isStaticMode = () => STATIC_MODE;

const HINTS = {
  '2048': '方向键 ↑↓←→ 或 WASD 移动，手机端直接滑动屏幕',
  snake: '方向键 / WASD 控制方向，手机端滑动屏幕',
  memory: '点击卡片翻开，找出两张相同的图案',
  whack: '点击或触摸地鼠即可敲击，金色地鼠双倍得分',
  tictactoe: '点击空格落子，先连成三子的一方获胜',
  tetris: '← → 移动，↑ 旋转，↓ 加速下落，空格直接落下'
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

function layout({ origin = '', title, description, path = '/', content, jsonLd = null, preload = '', user = null, noindex = false }) {
  const full = title ? title + ' - ' + SITE.name : SITE.name;
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
<meta property="og:image" content="${esc(origin)}/static/img/og.svg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎮</text></svg>">
<link rel="stylesheet" href="/static/css/style.css?v=3">
${preload}${ld}
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
${header(user)}
<main id="main">${content}</main>
${footer()}
<script src="/static/js/app.js?v=3" defer></script>
</body>
</html>`;
}

function header(user = null) {
  // 登录态直接体现到导航：没登录给「登录 / 注册」，登录了给昵称 + 收藏夹 + 退出
  const account = STATIC_MODE
    ? ''
    : user
    ? '<span class="who"><b>' + esc(user.name) + '</b>' + (user.role === 'admin' ? '<i>站长</i>' : '') + '</span>' +
      '<a href="/favorites">收藏夹</a>' +
      (user.role === 'admin' ? '<a href="/admin">后台</a>' : '') +
      '<form class="inline" action="/logout" method="post"><button class="linkbtn" type="submit">退出</button></form>'
    : '<a href="/login">登录</a>' +
      '<a class="nav-cta" href="/register">注册</a>';
  return `<header class="hdr">
  <div class="wrap hdr-in">
    <a class="logo" href="/" aria-label="${esc(SITE.name)}首页">
      <span class="logo-ico">${SITE.logo}</span>
      <span class="logo-txt">趣玩<em>小游戏</em></span>
    </a>
    <form class="search" action="/search" method="get" role="search">
      <input type="search" name="q" placeholder="搜索游戏，如 2048 / 贪吃蛇" aria-label="搜索游戏" autocomplete="off">
      <button type="submit" aria-label="搜索">🔍</button>
    </form>
    <nav class="nav" aria-label="主导航">
      <a href="/">首页</a>
      <a href="/games">全部游戏</a>
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

function footer() {
  return `<footer class="ftr">
  <div class="wrap">
    <p class="ftr-note">${esc(SITE.name)} · ${esc(SITE.tagline)}</p>
    <p class="ftr-note">${esc(SITE.icp)}</p>
    <p class="ftr-links"><a href="/sitemap.xml">网站地图</a><span>·</span><a href="/robots.txt">robots.txt</a>${STATIC_MODE ? '' : '<span>·</span><a href="/api/games">开放接口</a>'}</p>
  </div>
</footer>`;
}

export function gameCard(g) {
  const votes = Number(g.rating_count) || 0;
  const score = votes ? '⭐ ' + Number(g.rating).toFixed(1) : '☆ 未评';
  const scoreTip = votes ? votes + ' 人评分' : '还没有人评分';
  return `<a class="card" href="/game/${esc(g.slug)}" data-slug="${esc(g.slug)}" data-title="${esc(g.title)}" data-sub="${esc(g.subtitle || '')}" data-tags="${esc(Array.isArray(g.tags) ? g.tags.join(' ') : '')}" data-plays="${Number(g.plays) || 0}" data-rating="${Number(g.rating) || 0}" data-votes="${votes}" data-created="${esc(String(g.created_at || '').slice(0, 10))}">
  <span class="card-cover" style="--a:${esc(g.accent)};--b:${esc(g.accent2)}">
    <img src="/cover/${esc(g.slug)}.svg" alt="${esc(g.title)}封面" loading="lazy" decoding="async" width="320" height="200">
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

function section(title, icon, list, moreHref) {
  if (!list.length) return '';
  return `<section class="sec">
  <div class="sec-head">
    <h2>${icon} ${esc(title)}</h2>
    ${moreHref ? `<a class="more" href="${moreHref}">更多 ›</a>` : ''}
  </div>
  ${gameGrid(list)}
</section>`;
}

export function homePage({ origin, featured, hot, newest, categories, tags, stats, user = null }) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: origin + '/',
    description: SITE.tagline,
    potentialAction: {
      '@type': 'SearchAction',
      target: origin + '/search?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  };

  const chips = categories
    .filter((c) => c.total > 0)
    .map((c) => `<a class="chip" href="/category/${esc(c.slug)}">${esc(c.icon)} ${esc(c.name)} <b>${c.total}</b></a>`)
    .join('');

  const tagCloud = tags.length
    ? `<section class="sec"><div class="sec-head"><h2>🏷️ 热门标签</h2></div>
       <div class="tags">${tags.map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t.name)}">${esc(t.name)}</a>`).join('')}</div></section>`
    : '';

  const hero = featured
    ? `<section class="hero" style="--a:${esc(featured.accent)};--b:${esc(featured.accent2)}">
        <div class="hero-txt">
          <span class="hero-kicker">🔥 今日最热</span>
          <h1>${esc(featured.title)}</h1>
          <p>${esc(featured.description || featured.subtitle || '')}</p>
          <div class="hero-btns">
            <a class="btn btn-primary" href="/game/${esc(featured.slug)}">▶ 立即开玩</a>
            <a class="btn" href="/games">浏览全部游戏</a>
          </div>
          <p class="hero-stat">已累计 <b>${fmtNum(stats.plays)}</b> 次游玩 · 共 <b>${stats.games}</b> 款游戏</p>
        </div>
        <a class="hero-art" href="/game/${esc(featured.slug)}" tabindex="-1" aria-hidden="true">
          <img src="/cover/${esc(featured.slug)}.svg" alt="" width="420" height="262">
        </a>
      </section>`
    : '';

  const content = `
${hero}
<section class="sec">
  <div class="sec-head"><h2>🧭 游戏分类</h2></div>
  <div class="chips">${chips}</div>
</section>
${section('热门推荐', '🔥', hot, '/games?sort=hot')}
${section('最新上架', '🆕', newest, '/games?sort=new')}
${tagCloud}
<section class="sec">
  <div class="cta">
    <h2>想做自己的小游戏站？</h2>
    <p>本站是 <b>纯 HTML + Express + node:sqlite</b> 的开源骨架：把游戏放进 <code>games/</code>，往数据库插一条记录，就上架了。</p>
    <p class="cta-code"><code>GET /api/games</code> · <code>POST /api/games/:slug/play</code> · <code>GET /game/:slug</code></p>
  </div>
</section>`;

  return layout({ origin, user, title: '', description: SITE.tagline, path: '/', content, jsonLd: ld });
}

export function listPage({ origin, path, heading, sub, list, total, query = '', sort = 'hot', base = '/games', user = null }) {
  const tabs = [['hot', '最热'], ['new', '最新'], ['rating', '好评'], ['title', '名称']];
  const tabBar = `<div class="tabs">${tabs
    .map(([k, label]) => `<a class="tab${k === sort ? ' on' : ''}" href="${base}?${query ? 'q=' + encodeURIComponent(query) + '&' : ''}sort=${k}">${label}</a>`)
    .join('')}</div>`;

  return layout({
    origin,
    user,
    title: heading,
    description: heading + ' - ' + SITE.tagline,
    path,
    content: `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>${esc(heading)}</b></nav>
  <div class="page-head">
    <h1>${esc(heading)}</h1>
    ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}
    <p class="page-count">共找到 <b>${total}</b> 款游戏</p>
  </div>
  ${tabBar}
  ${gameGrid(list)}
</div>`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: heading,
      url: origin + path,
      numberOfItems: total
    }
  });
}

export function gamePage({ origin, game, related, myStars = 0, user = null, favorited = false, favCount = 0, comments = [], commentTotal = 0 }) {
  const path = '/game/' + game.slug;
  const votes = Number(game.rating_count) || 0;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: game.title,
    description: game.description,
    url: origin + path,
    image: origin + '/cover/' + game.slug + '.svg',
    genre: game.category ? game.category.name : '休闲',
    gamePlatform: 'Web Browser',
    applicationCategory: 'Game',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY', availability: 'https://schema.org/InStock' }
  };
  // schema.org 要求 ratingCount >= 1，没人评分时宁可不带这个字段，也不造数
  if (votes > 0) {
    ld.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(game.rating).toFixed(1),
      ratingCount: votes,
      bestRating: '5',
      worstRating: '1'
    };
  }

  const tagLinks = game.tags
    .map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');

  const hint = HINTS[game.slug] || '支持键盘与触屏操作，点击全屏获得最佳体验';

  const starBtns = [1, 2, 3, 4, 5]
    .map((n) => '<button class="star' + (n <= myStars ? ' on' : '') + '" type="button" data-star="' + n +
      '" role="radio" aria-checked="' + (n === myStars) + '" aria-label="' + n + ' 星">★</button>')
    .join('');
  const rateInfo = (votes
    ? '<b>' + Number(game.rating).toFixed(1) + '</b> 分 · ' + votes + ' 人评分'
    : '还没有人评分，来做第一个') + (myStars ? ' · 你已评 ' + myStars + ' 星' : '');

  // 登录后才给可点的星级；游客看到的是只读星级 + 登录引导；静态导出只展示分数
  const loginHref = '/login?next=' + encodeURIComponent(path);
  const rateBox = STATIC_MODE
    ? '<div class="rate-row">' +
        '<div class="stars locked">' + starBtns + '</div>' +
        '<p class="rate-info">' + rateInfo + '</p>' +
      '</div>' +
      '<p class="rate-tip">静态演示版没有服务端，评分与评论已关闭</p>'
    : user
    ? '<div class="rate-row">' +
        '<div class="stars" id="stars" role="radiogroup" aria-label="评分（1 到 5 星）">' + starBtns + '</div>' +
        '<p class="rate-info" id="rateInfo">' + rateInfo + '</p>' +
      '</div>' +
      '<p class="rate-tip">一人一票，评分随时可以改</p>'
    : '<div class="rate-row">' +
        '<div class="stars locked">' + starBtns + '</div>' +
        '<p class="rate-info">' + (votes ? '<b>' + Number(game.rating).toFixed(1) + '</b> 分 · ' + votes + ' 人评分' : '还没有人评分') + '</p>' +
      '</div>' +
      '<p class="rate-tip"><a href="' + loginHref + '">登录</a> 后即可评分，一人一票</p>';

  const commentItems = comments.length
    ? comments.map((c) =>
        '<li class="cmt"><div class="cmt-head"><b>' + esc(c.name) + '</b>' +
        '<time>' + esc(String(c.created_at).slice(0, 16)) + '</time></div>' +
        '<p>' + esc(c.body) + '</p></li>').join('')
    : '<li class="cmt-empty">还没有人评论，来抢沙发 🛋️</li>';
  const commentForm = user
    ? '<form class="cmt-form" id="cmtForm" data-slug="' + esc(game.slug) + '">' +
        '<textarea id="cmtBody" maxlength="500" rows="3" placeholder="说点什么…（最多 500 字）"></textarea>' +
        '<button class="btn btn-primary" type="submit">发表评论</button>' +
      '</form>'
    : '<p class="cmt-login"><a href="' + loginHref + '">登录</a> 后参与评论</p>';

  const content = `<div class="wrap page">
  <nav class="crumb">
    <a href="/">首页</a><span>›</span>
    ${game.category ? `<a href="/category/${esc(game.category.slug)}">${esc(game.category.icon)} ${esc(game.category.name)}</a><span>›</span>` : ''}
    <b>${esc(game.title)}</b>
  </nav>

  <div class="game-layout">
    <div class="game-main">
      <h1 class="game-title">${esc(game.title)} <small>${esc(game.subtitle || '')}</small></h1>
      <div class="player" id="player" data-slug="${esc(game.slug)}" data-url="${esc(game.game_url)}" style="--a:${esc(game.accent)}">
        <div class="player-bar">
          <button class="btn" data-act="fullscreen" type="button">⛶ 全屏</button>
          <button class="btn" data-act="reload" type="button">↻ 重开</button>
          <a class="btn" href="${esc(game.game_url)}" target="_blank" rel="noopener noreferrer">↗ 新窗口</a>
          ${STATIC_MODE ? '' : '<button class="btn fav" id="favBtn" type="button" data-slug="' + esc(game.slug) + '" data-on="' + (favorited ? 1 : 0) + '" aria-pressed="' + favorited + '">' + (favorited ? '♥ 已收藏' : '♡ 收藏') + ' <b id="favCount">' + favCount + '</b></button>'}
          ${STATIC_MODE ? '' : '<span class="player-views">🔥 已玩 <b id="playCount">' + fmtNum(game.plays) + '</b> 次</span>'}
        </div>
        <div class="player-stage" id="stage" style="--ar:${game.width}/${game.height}">
          <iframe id="gameFrame"
                  src="${esc(game.game_url)}"
                  title="${esc(game.title)} 在线玩"
                  sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock allow-popups"
                  allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope"
                  loading="eager" referrerpolicy="no-referrer"></iframe>
        </div>
        <p class="player-hint">🎮 ${esc(hint)}</p>
      </div>

      <div class="panel rate-panel" id="ratePanel" data-slug="${esc(game.slug)}" data-my="${myStars}" data-auth="${user ? 1 : 0}">
        <h2>给这个游戏打分</h2>
        ${rateBox}
      </div>

      ${STATIC_MODE ? '' : '<div class="panel" id="cmtPanel" data-slug="' + esc(game.slug) + '" data-auth="' + (user ? 1 : 0) + '">'
        + '<h2>玩家评论 <small class="cmt-count" id="cmtCount">' + commentTotal + '</small></h2>'
        + commentForm
        + '<ul class="cmt-list" id="cmtList">' + commentItems + '</ul>'
        + '</div>'}

      <div class="panel">
        <h2>游戏介绍</h2>
        <p class="desc">${esc(game.description)}</p>
        <div class="tags">${tagLinks}</div>
        <ul class="meta-list">
          <li><span>类型</span><b>${esc(game.category ? game.category.name : '休闲')}</b></li>
          <li><span>评分</span><b>${votes ? '⭐ ' + Number(game.rating).toFixed(1) + ' / 5 · ' + votes + ' 人评分' : '☆ 还没有人评分'}</b></li>
          <li><span>授权</span><b>${esc(game.license)}</b></li>
          <li><span>上架时间</span><b>${esc(String(game.created_at).slice(0, 10))}</b></li>
        </ul>
      </div>
    </div>

    <aside class="game-side">
      <h2 class="side-title">🎯 相关推荐</h2>
      <div class="grid grid-side">${related.map(gameCard).join('')}</div>
    </aside>
  </div>
</div>`;

  return layout({ origin, user, title: game.title + ' - 在线玩', description: game.description, path, content, jsonLd: ld });
}

export function notFoundPage({ origin, user = null }) {
  return layout({
    origin,
    user,
    title: '页面不存在',
    description: '抱歉，没有找到这个页面',
    path: '/404',
    content: `<div class="wrap page notfound">
  <h1>404</h1>
  <p>这个游戏好像被别的玩家藏起来了 🕵️</p>
  <p><a class="btn btn-primary" href="/">返回首页</a></p>
</div>`
  });
}

/* ================= 账号页面 ================= */

const STATUS_LABEL = { 0: '已下架', 1: '已上架', 2: '待审核' };

function authCard({ origin, user, title, heading, sub, body, path }) {
  return layout({
    origin, user, title, description: sub, path, noindex: true,
    content: `<div class="wrap page auth">
  <div class="auth-card">
    <h1>${esc(heading)}</h1>
    <p class="auth-sub">${esc(sub)}</p>
    ${body}
  </div>
</div>`
  });
}

export function loginPage({ origin, user = null, next = '/', error = '', username = '' }) {
  const body = `
    ${error ? `<p class="auth-err">⚠️ ${esc(error)}</p>` : ''}
    <form class="auth-form" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required maxlength="16" autofocus></label>
      <label>密码<input type="password" name="password" autocomplete="current-password" required maxlength="72"></label>
      <button class="btn btn-primary" type="submit">登录</button>
    </form>
    <p class="auth-foot">还没有账号？<a href="/register?next=${encodeURIComponent(next)}">立即注册</a></p>`;
  return authCard({ origin, user, title: '登录', heading: '登录', sub: '登录后可以评分、评论和收藏游戏', body, path: '/login' });
}

export function registerPage({ origin, user = null, next = '/', error = '', username = '', displayName = '' }) {
  const body = `
    ${error ? `<p class="auth-err">⚠️ ${esc(error)}</p>` : ''}
    <form class="auth-form" method="post" action="/register">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required maxlength="16" autofocus><small>2~16 位中文、字母、数字、下划线或短横线</small></label>
      <label>昵称（可选）<input name="display_name" value="${esc(displayName)}" maxlength="20"><small>留空就用用户名</small></label>
      <label>密码<input type="password" name="password" autocomplete="new-password" required maxlength="72"><small>至少 6 位</small></label>
      <button class="btn btn-primary" type="submit">注册并登录</button>
    </form>
    <p class="auth-foot">已经有账号？<a href="/login?next=${encodeURIComponent(next)}">去登录</a></p>`;
  return authCard({ origin, user, title: '注册', heading: '注册', sub: '注册后即可评分、评论和收藏', body, path: '/register' });
}

export function favoritesPage({ origin, user, list, total }) {
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>我的收藏</b></nav>
  <div class="page-head">
    <h1>♥ 我的收藏</h1>
    <p class="page-sub">${esc(user.name)}，你收藏了 ${total} 款游戏</p>
  </div>
  ${total
      ? gameGrid(list)
      : '<p class="empty">还没有收藏。去 <a href="/games">全部游戏</a> 逛逛，在详情页点「♡ 收藏」加进来。</p>'}
</div>`;
  return layout({ origin, user, title: '我的收藏', description: '我收藏的小游戏', path: '/favorites', content, noindex: true });
}

/* ================= 投稿 ================= */

export function submitPage({ origin, user, categories = [], error = '', values = {}, done = '' }) {
  const v = (k, d = '') => esc(values[k] === undefined || values[k] === null ? d : values[k]);
  const catOpts = categories
    .map((c) => `<option value="${esc(c.slug)}"${values.category === c.slug ? ' selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`)
    .join('');
  const body = `
    ${error ? `<p class="auth-err">⚠️ ${esc(error)}</p>` : ''}
    ${done ? `<p class="auth-ok">✅ 投稿成功（编号 <b>${esc(done)}</b>），已进入待审核队列，站长通过后就会出现在 <a href="/games">全部游戏</a> 里。</p>` : ''}
    <form class="auth-form wide" method="post" action="/submit">
      <label>游戏名称 <em>*</em><input name="title" value="${v('title')}" required maxlength="40"></label>
      <label>一句话简介<input name="subtitle" value="${v('subtitle')}" maxlength="60" placeholder="如：30 秒极限手速挑战"></label>
      <label>游戏地址 <em>*</em><input name="game_url" value="${v('game_url', '/games/')}" required maxlength="300" placeholder="/games/xxx/index.html"><small>站内路径或 http(s) 链接；单文件 HTML5 游戏请放到 games/ 目录</small></label>
      <label>分类<select name="category">${catOpts}</select></label>
      <div class="row2">
        <label>画布宽<input type="number" name="width" value="${v('width', 800)}" min="200" max="2000"></label>
        <label>画布高<input type="number" name="height" value="${v('height', 600)}" min="200" max="2000"></label>
      </div>
      <div class="row2">
        <label>图标 emoji<input name="emoji" value="${v('emoji', '🎮')}" maxlength="4"></label>
        <label>授权说明<input name="license" value="${v('license', '投稿')}" maxlength="40"></label>
      </div>
      <label>标签（逗号分隔，最多 6 个）<input name="tags" value="${v('tags')}" placeholder="益智, 休闲"></label>
      <label class="top">游戏介绍<textarea name="description" rows="4" maxlength="600">${v('description')}</textarea></label>
      <label class="check"><input type="checkbox" required> 我确认该游戏为原创或已获授权，不含侵权、违规内容</label>
      <button class="btn btn-primary" type="submit">提交审核</button>
    </form>`;
  return authCard({ origin, user, title: '投稿游戏', heading: '投稿游戏', sub: '提交后进入待审核队列，站长通过后公开上架', body, path: '/submit' });
}

/* ================= 后台 ================= */

function statusPill(s) {
  return '<span class="pill s' + Number(s) + '">' + esc(STATUS_LABEL[Number(s)] || '未知') + '</span>';
}

function statusForms(g) {
  const f = (status, label, cls) =>
    '<form class="inline" method="post" action="/admin/games/' + esc(g.slug) + '/status">' +
    '<input type="hidden" name="status" value="' + status + '">' +
    '<button class="btn btn-sm ' + (cls || '') + '" type="submit">' + label + '</button></form>';
  const s = Number(g.status);
  if (s === 2) return f(1, '✅ 通过上架', 'ok') + f(0, '✖ 拒绝', 'danger');
  if (s === 1) return f(0, '⬇ 下架', 'danger');
  return f(1, '⬆ 重新上架', 'ok');
}

export function adminPage({ origin, user, stats, pending, managed, comments }) {
  const gameRow = (g) => `<tr>
    <td><b>${esc(g.emoji)} ${esc(g.title)}</b><br><small class="dim">${esc(g.slug)} · ${esc(g.game_url)}</small></td>
    <td>${esc(g.category ? g.category.name : '—')}</td>
    <td>${fmtNum(g.plays)}</td>
    <td>${Number(g.rating_count) ? Number(g.rating).toFixed(1) + ' <small class="dim">(' + g.rating_count + ')</small>' : '<small class="dim">—</small>'}</td>
    <td>${statusPill(g.status)}</td>
    <td class="act">${statusForms(g)}</td>
  </tr>`;

  const commentRow = (c) => `<tr>
    <td>${esc(c.name)}<br><small class="dim">${esc(String(c.created_at).slice(0, 16))}</small></td>
    <td><a href="/game/${esc(c.slug)}" target="_blank">${esc(c.title)}</a></td>
    <td class="cmt-cell">${esc(c.body)}</td>
    <td>${Number(c.status) ? '<span class="pill s1">显示中</span>' : '<span class="pill s0">已隐藏</span>'}</td>
    <td class="act"><form class="inline" method="post" action="/admin/comments/${c.id}/status">
      <input type="hidden" name="status" value="${Number(c.status) ? 0 : 1}">
      <button class="btn btn-sm" type="submit">${Number(c.status) ? '隐藏' : '恢复'}</button></form></td>
  </tr>`;

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>后台</b></nav>
  <div class="page-head">
    <h1>🛠 管理后台</h1>
    <p class="page-sub">${esc(user.name)}，这里是站长视角：审核投稿、上下架游戏、管理评论</p>
  </div>

  <div class="stats">
    <div class="stat"><b>${stats.pending}</b><span>待审核</span></div>
    <div class="stat"><b>${stats.published}</b><span>已上架</span></div>
    <div class="stat"><b>${stats.offline}</b><span>已下架</span></div>
    <div class="stat"><b>${stats.users}</b><span>注册用户</span></div>
    <div class="stat"><b>${stats.comments}</b><span>评论</span></div>
    <div class="stat"><b>${stats.favorites}</b><span>收藏</span></div>
  </div>

  <section class="sec">
    <div class="sec-head"><h2>⏳ 待审核投稿 <b>${pending.length}</b></h2></div>
    ${pending.length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>游戏</th><th>分类</th><th>游玩</th><th>评分</th><th>状态</th><th>操作</th></tr></thead><tbody>' + pending.map(gameRow).join('') + '</tbody></table></div>'
      : '<p class="empty">没有待审核的投稿</p>'}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>🎮 游戏管理 <b>${managed.length}</b></h2></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>游戏</th><th>分类</th><th>游玩</th><th>评分</th><th>状态</th><th>操作</th></tr></thead><tbody>${managed.map(gameRow).join('')}</tbody></table></div>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>💬 最新评论 <b>${comments.length}</b></h2></div>
    ${comments.length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>用户</th><th>游戏</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>' + comments.map(commentRow).join('') + '</tbody></table></div>'
      : '<p class="empty">还没有评论</p>'}
  </section>
</div>`;
  return layout({ origin, user, title: '管理后台', description: '站长后台', path: '/admin', content, noindex: true });
}

