/** 服务端 HTML 模板（纯字符串渲染，零模板引擎依赖） */
import { isUploadedUrl, UPLOAD_LABEL } from './upload.js';

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
  '2048': '方向键 ↑↓←→ 或 WASD 移动，手机端滑动屏幕，手柄用十字键 / 左摇杆',
  snake: '方向键 / WASD 控制方向，手机端滑动屏幕，手柄用十字键 / 左摇杆，A 或 Start 开始 / 暂停',
  memory: '点击卡片翻开，找出两张相同的图案，手柄用左摇杆移动光标 + A 键翻牌',
  whack: '点击或触摸地鼠即可敲击，金色地鼠双倍得分，手柄用左摇杆移动光标 + A 键敲',
  tictactoe: '点击空格落子，先连成三子的一方获胜，手柄用左摇杆移动光标 + A 键落子',
  tetris: '← → 移动，↑ 旋转，↓ 加速下落，空格直接落下，手柄用十字键 / 左摇杆 + A 键速降 + Start 暂停'
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
<link rel="stylesheet" href="/static/css/style.css?v=4">
${preload}${ld}
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
${header(user)}
<main id="main">${content}</main>
${footer()}
<script src="/static/js/${STATIC_MODE ? "app-static" : "app"}.js?v=4" defer></script>
</body>
</html>`;
}

function header(user = null) {
  // 登录态直接体现到导航：没登录给「登录 / 注册」，登录了给昵称 + 收藏夹 + 退出
  const account = STATIC_MODE
    ? ''
    : user
    ? '<span class="who"><b>' + esc(user.name) + '</b>' + (user.role === 'admin' ? '<i>站长</i>' : '') +
        (user.email && !user.email_verified ? '<i class="warn" title="邮箱还没验证">邮箱未验证</i>' : '') + '</span>' +
      '<a href="/favorites">收藏夹</a>' +
      '<a href="/account">账号</a>' +
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
    <div class="search-wrap">
      <form class="search" action="/search" method="get" role="search">
        <input type="search" name="q" placeholder="搜索游戏，如 2048 / 贪吃蛇" aria-label="搜索游戏" autocomplete="off">
        <button type="submit" aria-label="搜索">🔍</button>
      </form>
      <div class="sug" id="sug" hidden></div>
    </div>
    <nav class="nav" aria-label="主导航">
      <a href="/">首页</a>
      <a href="/games">全部游戏</a>
      <a href="/rank">排行榜</a>
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

/* 排名涨跌的小标签：move > 0 上升，move < 0 下降，hasPrev 为假说明是本期新上榜 */
function moveTag(r) {
  if (!r.hasPrev) return '<span class="mv new">新上榜</span>';
  const m = Number(r.move) || 0;
  if (m > 0) return '<span class="mv up" title="较上一周期上升">▲' + m + '</span>';
  if (m < 0) return '<span class="mv down" title="较上一周期下降">▼' + Math.abs(m) + '</span>';
  return '<span class="mv flat">—</span>';
}

const BOARD_UNIT = { plays: '次', plays_all: '次', rating: '分', fav: '人收藏', new: '款' };

/** 排行榜页：热玩榜按时间窗统计 play_logs，评分/收藏/新作榜是现状快照 */
export function rankPage({ origin, user = null, kind = 'today', label = '', desc = '', rows = [], boards = [], metric = 'plays' }) {
  const tabs = boards
    .map((b) => '<a class="tab' + (b.kind === kind ? ' on' : '') + '" href="' +
      (STATIC_MODE ? '/rank/' + esc(b.kind) : '/rank?kind=' + esc(b.kind)) + '">' + esc(b.label) + '</a>')
    .join('');

  const body = rows.length
    ? '<ol class="rk-list">' + rows.map((r) => {
        const sub = [r.category ? esc(r.category) : '小游戏',
          Number(r.rating_count) ? '⭐ ' + Number(r.rating).toFixed(1) : null,
          fmtNum(r.plays) + ' 次游玩'].filter(Boolean).join(' · ');
        return '<li class="rk-row">' +
          '<span class="rk-no n' + Math.min(3, r.rank) + '">' + r.rank + '</span>' +
          '<a class="rk-cover" href="/game/' + esc(r.slug) + '" tabindex="-1" aria-hidden="true" style="--a:' + esc(r.accent || '#6366f1') + ';--b:' + esc(r.accent2 || '#8b5cf6') + '">' +
            '<img src="/cover/' + esc(r.slug) + '.svg" alt="" loading="lazy" decoding="async" width="120" height="75"></a>' +
          '<span class="rk-body"><a class="rk-title" href="/game/' + esc(r.slug) + '">' + esc(r.emoji || '🎮') + ' ' + esc(r.title) + '</a>' +
            '<small class="dim">' + sub + '</small></span>' +
          '<span class="rk-val"><b>' + (metric === 'rating' ? Number(r.value).toFixed(1) : fmtNum(r.value)) + '</b><small>' + (BOARD_UNIT[metric] || '') + '</small></span>' +
          (metric === 'plays' ? moveTag(r) : '') +
        '</li>';
      }).join('') + '</ol>'
    : '<p class="empty">这个榜单还没有数据，先去玩两局吧 🎮</p>';

  const content = '<div class="wrap page">' +
    '<nav class="crumb"><a href="/">首页</a><span>›</span><b>排行榜</b></nav>' +
    '<div class="page-head"><h1>🏆 排行榜</h1><p class="page-sub">' + esc(desc || '看看大家都在玩什么') + '</p>' +
    '<p class="page-count">榜单：<b>' + esc(label) + '</b> · 共 ' + rows.length + ' 款</p></div>' +
    '<div class="tabs">' + tabs + '</div>' + body +
    '<p class="rank-note">热玩榜按真实游玩记录统计，评分 / 收藏 / 新作榜为当前快照；名次变化对比上一个统计周期。</p>' +
    '</div>';

  return layout({
    origin, user, title: label + ' - 排行榜', description: '小游戏' + label + '与最新上榜游戏',
    path: STATIC_MODE ? '/rank/' + kind : '/rank?kind=' + kind, content,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: label,
      url: origin + '/rank?kind=' + kind,
      itemListElement: rows.slice(0, 10).map((r) => ({
        '@type': 'ListItem',
        position: r.rank,
        url: origin + '/game/' + r.slug,
        name: r.title
      }))
    }
  });
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

/* 举报原因与 data.js 的 REPORT_REASONS 保持一致（模板层不 import 数据层，两条线各留一份） */
const REPORT_REASONS = [['spam', '垃圾广告'], ['abuse', '辱骂攻击'], ['spoiler', '剧透'], ['other', '其他']];
const REPORT_LABEL = Object.fromEntries(REPORT_REASONS);

/** 评论正文 + 回复 / 举报操作条。举报用原生 form，禁用 JS 也能提交 */
function cmtActions(id, path, user) {
  if (!user) return '';
  const reasonOpts = REPORT_REASONS.map(([v, t]) => '<option value="' + v + '">' + esc(t) + '</option>').join('');
  return '<span class="cmt-act">' +
    '<button class="linkbtn" type="button" data-reply="' + Number(id) + '">回复</button>' +
    '<form class="inline report-form" method="post" action="/comments/' + Number(id) + '/report">' +
      '<input type="hidden" name="next" value="' + esc(path) + '">' +
      '<select name="reason" aria-label="举报原因">' + reasonOpts + '</select>' +
      '<button class="linkbtn danger" type="submit">举报</button>' +
    '</form>' +
  '</span>';
}

/** 单条评论（含它的回复）。parent_id 只存两层：回复的回复也挂到同一顶层 */
function commentItem(c, { user, path }) {
  const replies = (c.replies || []).map((rep) =>
    '<li class="cmt-reply" data-id="' + Number(rep.id) + '">' +
      '<div class="cmt-head"><b>' + esc(rep.name) + '</b><time>' + esc(String(rep.created_at).slice(0, 16)) + '</time></div>' +
      '<p>' + esc(rep.body) + '</p>' +
      cmtActions(rep.id, path, user) +
    '</li>');
  const extra = Number(c.reply_total) - replies.length;
  if (extra > 0) replies.push('<li class="cmt-more">还有 ' + extra + ' 条回复未展开</li>');
  return '<li class="cmt" id="cmt' + Number(c.id) + '" data-id="' + Number(c.id) + '">' +
    '<div class="cmt-head"><b>' + esc(c.name) + '</b><time>' + esc(String(c.created_at).slice(0, 16)) + '</time></div>' +
    '<p>' + esc(c.body) + '</p>' +
    cmtActions(c.id, path, user) +
    (replies.length ? '<ul class="cmt-replies">' + replies.join('') + '</ul>' : '') +
  '</li>';
}

export function gamePage({ origin, game, related, myStars = 0, user = null, favorited = false, favCount = 0, comments = [], commentTotal = 0, thread = null, preview = false, cmtNotice = '' }) {
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

  // 评论：服务端就分好页（?cpage=N，无 JS 也能翻页），楼中楼只做两级
  if (!thread) {
    thread = { items: (comments || []).map((c) => ({ ...c, replies: [], reply_total: 0 })), total: commentTotal, page: 1, pages: 1 };
  }
  const cmtPath = path + (thread.page > 1 ? '?cpage=' + thread.page : '') + '#cmtPanel';
  const commentItems = thread.items.length
    ? thread.items.map((c) => commentItem(c, { user, path: cmtPath })).join('')
    : '<li class="cmt-empty">还没有人评论，来抢沙发 🛋️</li>';
  const pager = thread.pages > 1
    ? '<nav class="pager" aria-label="评论分页">' +
        (thread.page > 1
          ? '<a class="pg" href="' + esc(path) + '?cpage=' + (thread.page - 1) + '#cmtPanel" rel="prev">‹ 上一页</a>'
          : '<span class="pg off">‹ 上一页</span>') +
        '<span class="pg-info">' + thread.page + ' / ' + thread.pages + ' 页</span>' +
        (thread.page < thread.pages
          ? '<a class="pg" href="' + esc(path) + '?cpage=' + (thread.page + 1) + '#cmtPanel" rel="next">下一页 ›</a>'
          : '<span class="pg off">下一页 ›</span>') +
      '</nav>'
    : '';
  const commentForm = user
    ? '<form class="cmt-form" id="cmtForm" data-slug="' + esc(game.slug) + '">' +
        '<textarea id="cmtBody" maxlength="500" rows="3" placeholder="说点什么…（最多 500 字）"></textarea>' +
        '<div class="cmt-form-foot">' +
          '<span class="cmt-reply-hint" id="cmtReplyHint" hidden>正在回复 <b id="cmtReplyName"></b>' +
          '<button class="linkbtn" type="button" id="cmtReplyCancel">取消</button></span>' +
          '<input type="hidden" id="cmtParent" value="">' +
          '<button class="btn btn-primary" type="submit">发表评论</button>' +
        '</div>' +
      '</form>'
    : '<p class="cmt-login"><a href="' + loginHref + '">登录</a> 后参与评论</p>';

  // 投稿上传的 HTML 由站内托管，播放时不给 allow-same-origin（沙箱 CSP 也会再兜一层）
  const ugcHtml = isUploadedUrl(game.game_url);

  const previewBar = preview
    ? '<div class="preview-bar">👀 预览模式：这是 <b>' + esc(game.title) + '</b>（' + esc(STATUS_LABEL[Number(game.status)] || '未知') + '）的公开效果，' +
      '访客看不到这一条。<a href="/admin">返回后台</a></div>'
    : '';

  const content = `<div class="wrap page">
  ${previewBar}
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
                  sandbox="${ugcHtml ? 'allow-scripts allow-pointer-lock allow-orientation-lock' : 'allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock allow-popups'}"
                  allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope"
                  loading="eager" referrerpolicy="no-referrer"></iframe>
        </div>
        <p class="player-hint">🎮 ${esc(hint)}</p>
      </div>

      <div class="panel rate-panel" id="ratePanel" data-slug="${esc(game.slug)}" data-my="${myStars}" data-auth="${user ? 1 : 0}">
        <h2>给这个游戏打分</h2>
        ${rateBox}
      </div>

      ${STATIC_MODE ? '' : '<div class="panel" id="cmtPanel" data-slug="' + esc(game.slug) + '" data-auth="' + (user ? 1 : 0) + '" data-page="' + thread.page + '">'
        + '<h2>玩家评论 <small class="cmt-count" id="cmtCount">' + commentTotal + '</small></h2>'
        + (cmtNotice ? '<p class="auth-ok">' + esc(cmtNotice) + '</p>' : '')
        + commentForm
        + '<ul class="cmt-list" id="cmtList">' + commentItems + '</ul>'
        + pager
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

/* ================= 账号设置 / 找回密码 ================= */

const ACCOUNT_OK = {
  email: '邮箱已保存，请去收件箱点验证链接（开发模式下页面会直接给你链接）',
  verified: '邮箱验证成功，账号安全等级 +1 ✅',
  resent: '验证邮件已重新发送',
  password: '密码已更新，其它设备上的登录已全部退出',
  unlink: '已解除第三方绑定'
};
const ACCOUNT_ERR = {
  email: '邮箱格式不对，或者已经被别的账号绑定了',
  email_same: '这个邮箱就是当前绑定的邮箱',
  verified: '验证链接无效或已过期，请重新发送',
  resend: '这个账号还没有绑定邮箱，或者已经验证过了',
  password: '原密码不对，或者新密码不符合要求（6~72 位）',
  unlink: '解绑失败，请稍后再试',
  login: '请先登录',
  oauth: '第三方登录失败，换一种方式再试',
  oauth_state: '登录状态校验失败，请重新发起一次'
};

/** 邮箱验证状态小标签 */
function emailPill(user) {
  if (!user.email) return '<span class="pill s0">未绑定</span>';
  return Number(user.email_verified)
    ? '<span class="pill s1">已验证</span>'
    : '<span class="pill s2">待验证</span>';
}

export function accountPage({ origin, user, providers = [], links = [], notice = '', error = '', devLink = '' }) {
  const okMsg = ACCOUNT_OK[notice] || '';
  const errMsg = ACCOUNT_ERR[error] || '';
  const devBox = devLink
    ? '<p class="auth-ok">🧪 开发模式（没有配邮件服务）：直接点这个链接走完流程<br><a href="' + esc(devLink) + '">' + esc(devLink) + '</a></p>'
    : '';

  const bindForm = providers.length
    ? '<div class="acct-links">' + providers.map((p) =>
        '<a class="btn" href="/auth/' + esc(p.key) + '?next=' + encodeURIComponent('/account') + '">' + p.icon + ' 用 ' + esc(p.label) + ' 登录</a>'
      ).join('') + '</div>'
    : '<p class="dim">没有可用的第三方登录（配置 GITHUB_CLIENT_ID / GOOGLE_CLIENT_ID 后会出现在这里）</p>';

  const boundList = links.length
    ? '<ul class="meta-list">' + links.map((l) =>
        '<li><span>' + esc(l.label) + '</span><b>' + esc(l.name || l.provider_uid) + '</b>' +
        '<form class="inline" method="post" action="/account/unlink"><input type="hidden" name="provider" value="' + esc(l.provider) + '">' +
        '<button class="btn btn-sm danger" type="submit">解绑</button></form></li>'
      ).join('') + '</ul>'
    : '<p class="dim">还没有绑定任何第三方账号</p>';

  const body = `
    ${okMsg ? '<p class="auth-ok">✅ ' + esc(okMsg) + '</p>' : ''}
    ${errMsg ? '<p class="auth-err">⚠️ ' + esc(errMsg) + '</p>' : ''}
    ${devBox}

    <section class="acct-sec">
      <h2>邮箱 <small>${emailPill(user)}</small></h2>
      <p class="dim">绑定邮箱后可以找回密码，也不会被人抢注昵称。</p>
      <form class="auth-form" method="post" action="/account/email">
        <label>邮箱<input type="email" name="email" value="${esc(user.email)}" placeholder="you@example.com" maxlength="120" required></label>
        <button class="btn btn-primary" type="submit">${user.email ? '更换邮箱' : '绑定邮箱'}</button>
      </form>
      ${user.email && !Number(user.email_verified)
        ? '<form class="inline" method="post" action="/account/resend"><button class="btn btn-sm" type="submit">重新发送验证邮件</button></form>'
        : ''}
    </section>

    <section class="acct-sec">
      <h2>修改密码</h2>
      <form class="auth-form" method="post" action="/account/password">
        <label>原密码<input type="password" name="old" autocomplete="current-password" required maxlength="72"></label>
        <label>新密码<input type="password" name="password" autocomplete="new-password" required maxlength="72"><small>至少 6 位</small></label>
        <button class="btn btn-primary" type="submit">保存新密码</button>
      </form>
      <p class="dim">改完密码后，包括当前设备在内的所有登录都会被退出，请用新密码重新登录。</p>
    </section>

    <section class="acct-sec">
      <h2>第三方账号</h2>
      ${boundList}
      <h3 class="sub">绑定更多</h3>
      ${bindForm}
    </section>

    <section class="acct-sec">
      <h2>账号信息</h2>
      <ul class="meta-list">
        <li><span>用户名</span><b>${esc(user.username)}</b></li>
        <li><span>昵称</span><b>${esc(user.name)}</b></li>
        <li><span>角色</span><b>${user.role === 'admin' ? '站长' : '玩家'}</b></li>
        <li><span>注册时间</span><b>${esc(String(user.created_at || '').slice(0, 10))}</b></li>
      </ul>
    </section>`;

  return authCard({ origin, user, title: '账号设置', heading: '账号设置', sub: '邮箱、密码与第三方登录', body, path: '/account' });
}

export function forgotPage({ origin, user = null, error = '', done = false, devLink = '' }) {
  const body = done
    ? `
    <p class="auth-ok">✅ 如果这个账号存在，我们已经把重置链接发到它的邮箱了（30 分钟内有效）。</p>
    ${devLink ? '<p class="auth-ok">🧪 开发模式：没有配邮件服务，直接点这里<br><a href="' + esc(devLink) + '">' + esc(devLink) + '</a></p>' : ''}
    <p class="auth-foot"><a href="/login">返回登录</a></p>`
    : `
    ${error ? '<p class="auth-err">⚠️ ' + esc(error) + '</p>' : ''}
    <form class="auth-form" method="post" action="/forgot">
      <label>用户名或邮箱<input name="account" required maxlength="120" autofocus></label>
      <button class="btn btn-primary" type="submit">发送重置链接</button>
    </form>
    <p class="auth-foot"><a href="/login">想起密码了，去登录</a></p>`;
  return authCard({ origin, user, title: '找回密码', heading: '找回密码', sub: '填用户名或邮箱，我们给你发一条重置链接', body, path: '/forgot' });
}

export function resetPage({ origin, user = null, token = '', error = '' }) {
  const body = `
    ${error ? '<p class="auth-err">⚠️ ' + esc(error) + '</p>' : ''}
    <form class="auth-form" method="post" action="/reset">
      <input type="hidden" name="token" value="${esc(token)}">
      <label>新密码<input type="password" name="password" autocomplete="new-password" required maxlength="72" autofocus><small>至少 6 位</small></label>
      <label>再输一次<input type="password" name="password2" autocomplete="new-password" required maxlength="72"></label>
      <button class="btn btn-primary" type="submit">设置新密码</button>
    </form>
    <p class="auth-foot"><a href="/forgot">重新申请一条链接</a></p>`;
  return authCard({ origin, user, title: '设置新密码', heading: '设置新密码', sub: '设置成功后所有设备都需要重新登录', body, path: '/reset' });
}

export function messagePage({ origin, user = null, title, heading, sub = '', body = '', path = '/' }) {
  return authCard({ origin, user, title, heading, sub, body: body + '<p class="auth-foot"><a href="/">回到首页</a></p>', path });
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
    <form class="auth-form wide" method="post" action="/submit" enctype="multipart/form-data">
      <label>游戏名称 <em>*</em><input name="title" value="${v('title')}" required maxlength="40"></label>
      <label>一句话简介<input name="subtitle" value="${v('subtitle')}" maxlength="60" placeholder="如：30 秒极限手速挑战"></label>
      <label>上传单文件 HTML 游戏<input type="file" name="game_file" accept=".html,.htm,text/html"><small>自包含的一整个 .html（CSS/JS 都写在里面），上限 ${UPLOAD_LABEL}；上传后由本站托管，站长通过就能直接玩</small></label>
      <label>或者填已有的游戏地址<input name="game_url" value="${v('game_url')}" maxlength="300" placeholder="/games/xxx/index.html 或 https://…"><small>两边都填时以上传的文件为准；站内路径形如 /games/xxx/index.html</small></label>
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

export function adminPage({
  origin, user, stats, pending, managed, comments,
  reports = [], users = [], audit = [], categories = [], filter = {},
  outbox = [], mailTransport = 'outbox', notice = ''
}) {
  const NOTICE = {
    batch: '批量操作已完成',
    ban: '用户状态已更新',
    report: '举报已处理',
    comment: '评论状态已更新',
    email: '邮箱验证状态已更新'
  };

  const gameRow = (g) => `<tr>
    <td class="pick"><input type="checkbox" name="slug" value="${esc(g.slug)}" aria-label="选择 ${esc(g.title)}"></td>
    <td><b>${esc(g.emoji)} ${esc(g.title)}</b><br><small class="dim">${esc(g.slug)} · ${esc(g.game_url)}</small></td>
    <td>${esc(g.category ? g.category.name : '—')}</td>
    <td>${fmtNum(g.plays)}</td>
    <td>${Number(g.rating_count) ? Number(g.rating).toFixed(1) + ' <small class="dim">(' + g.rating_count + ')</small>' : '<small class="dim">—</small>'}</td>
    <td>${statusPill(g.status)}</td>
    <td class="act">${statusForms(g)}<a class="btn btn-sm" href="/admin/preview/${esc(g.slug)}">预览</a></td>
  </tr>`;

  const commentRow = (c) => `<tr>
    <td>${esc(c.name)}${c.parent_id ? ' <small class="dim">回复</small>' : ''}<br><small class="dim">${esc(String(c.created_at).slice(0, 16))}</small></td>
    <td><a href="/game/${esc(c.slug)}" target="_blank">${esc(c.title)}</a></td>
    <td class="cmt-cell">${esc(c.body)}${Number(c.reports) ? ' <span class="pill s2">被举报 ' + Number(c.reports) + '</span>' : ''}</td>
    <td>${Number(c.status) ? '<span class="pill s1">显示中</span>' : '<span class="pill s0">已隐藏</span>'}</td>
    <td class="act"><form class="inline" method="post" action="/admin/comments/${c.id}/status">
      <input type="hidden" name="status" value="${Number(c.status) ? 0 : 1}">
      <button class="btn btn-sm" type="submit">${Number(c.status) ? '隐藏' : '恢复'}</button></form></td>
  </tr>`;

  const reportRow = (r) => `<tr>
    <td><span class="pill s2">${esc(REPORT_LABEL[r.reason] || r.reason)}</span><br><small class="dim">${esc(String(r.created_at).slice(0, 16))}</small></td>
    <td>${esc(r.reporter)}${r.detail ? '<br><small class="dim">' + esc(r.detail) + '</small>' : ''}</td>
    <td class="cmt-cell">${esc(r.body)}<br><small class="dim">作者：${esc(r.author)} · <a href="/game/${esc(r.slug)}" target="_blank">${esc(r.title)}</a></small></td>
    <td class="act"><form class="inline" method="post" action="/admin/reports/${r.id}/status">
      <button class="btn btn-sm ok" name="status" value="1" type="submit">已处理</button>
      <button class="btn btn-sm" name="status" value="2" type="submit">忽略</button></form>
      <form class="inline" method="post" action="/admin/comments/${r.comment_id}/status">
      <input type="hidden" name="status" value="0"><button class="btn btn-sm danger" type="submit">隐藏评论</button></form></td>
  </tr>`;

  const userRow = (u) => `<tr>
    <td><b>${esc(u.name)}</b><br><small class="dim">${esc(u.username)} · ${u.role === 'admin' ? '站长' : '玩家'}</small></td>
    <td>${esc(u.email || '—')}${u.email ? ' ' + (Number(u.email_verified) ? '<span class="pill s1">已验证</span>' : '<span class="pill s2">待验证</span>') : ''}</td>
    <td>${u.comments} / ${u.submissions}</td>
    <td>${Number(u.banned) ? '<span class="pill s0">已封禁</span>' + (u.banned_reason ? '<br><small class="dim">' + esc(u.banned_reason) + '</small>' : '') : '<span class="pill s1">正常</span>'}</td>
    <td class="act">${u.email && !Number(u.email_verified)
      ? '<form class="inline" method="post" action="/admin/users/' + u.id + '/verify"><button class="btn btn-sm ok" type="submit">标记已验证</button></form>'
      : ''}${u.role === 'admin'
      ? '<small class="dim">站长账号不可封禁</small>'
      : '<form class="inline" method="post" action="/admin/users/' + u.id + '/ban">' +
        '<input type="hidden" name="banned" value="' + (Number(u.banned) ? 0 : 1) + '">' +
        (Number(u.banned) ? '' : '<input name="reason" placeholder="封禁原因（可留空）" maxlength="40" class="mini">') +
        '<button class="btn btn-sm ' + (Number(u.banned) ? 'ok' : 'danger') + '" type="submit">' + (Number(u.banned) ? '解封' : '封禁') + '</button></form>'}</td>
  </tr>`;

  const auditRow = (a) => `<tr>
    <td><small class="dim">${esc(String(a.created_at).slice(0, 16))}</small></td>
    <td>${esc(a.actor_name || '系统')}</td>
    <td><span class="pill s1">${esc(a.action)}</span></td>
    <td>${esc(a.target || '—')}${a.detail ? '<br><small class="dim">' + esc(a.detail) + '</small>' : ''}</td>
  </tr>`;

  const catOpts = ['<option value="">全部分类</option>']
    .concat(categories.map((c) => '<option value="' + esc(c.slug) + '"' + (filter.category === c.slug ? ' selected' : '') + '>' + esc(c.name) + '</option>'))
    .join('');
  const statusOpts = [['', '全部状态'], ['1', '已上架'], ['2', '待审核'], ['0', '已下架']]
    .map(([v, t]) => '<option value="' + v + '"' + (String(filter.status === undefined ? '' : filter.status) === v ? ' selected' : '') + '>' + t + '</option>').join('');

  const wrapTable = (head, rows, empty) => rows.length
    ? '<div class="table-wrap"><table class="tbl"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<p class="empty">' + empty + '</p>';

  const mailBox = mailTransport === 'outbox' && outbox.length
    ? '<section class="sec"><div class="sec-head"><h2>📮 开发发件箱 <b>' + outbox.length + '</b></h2>' +
      '<span class="dim">没配邮件服务时，验证/重置邮件只会落在这里（配 RESEND_API_KEY 或 MAIL_API_URL 即真实发送）</span></div>' +
      '<ul class="mail-list">' + outbox.map((m) =>
        '<li><b>' + esc(m.subject) + '</b><small class="dim"> → ' + esc(m.to) + ' · ' + esc(m.at) + '</small>' +
        (m.link ? '<br><a href="' + esc(m.link) + '">' + esc(m.link) + '</a>' : '') + '</li>').join('') + '</ul></section>'
    : '';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>后台</b></nav>
  <div class="page-head">
    <h1>🛠 管理后台</h1>
    <p class="page-sub">${esc(user.name)}，站长视角：审核投稿、批量上下架、处理举报、封禁用户，所有操作都会记进日志</p>
  </div>
  ${notice ? '<p class="auth-ok">✅ ' + esc(NOTICE[notice] || notice) + '</p>' : ''}

  <div class="stats">
    <div class="stat${stats.pending ? ' hot' : ''}"><b>${stats.pending}</b><span>待审核</span></div>
    <div class="stat"><b>${stats.published}</b><span>已上架</span></div>
    <div class="stat"><b>${stats.offline}</b><span>已下架</span></div>
    <div class="stat"><b>${stats.users}</b><span>注册用户</span></div>
    <div class="stat${stats.banned ? ' hot' : ''}"><b>${stats.banned}</b><span>封禁</span></div>
    <div class="stat"><b>${stats.comments}</b><span>评论</span></div>
    <div class="stat${stats.reports ? ' hot' : ''}"><b>${stats.reports}</b><span>待处理举报</span></div>
    <div class="stat"><b>${stats.favorites}</b><span>收藏</span></div>
  </div>

  <section class="sec">
    <div class="sec-head"><h2>⏳ 待审核投稿 <b>${pending.length}</b></h2><span class="dim">先点「预览」按玩家视角看一眼，再决定上不上架</span></div>
    ${wrapTable('<th>选</th><th>游戏</th><th>分类</th><th>游玩</th><th>评分</th><th>状态</th><th>操作</th>', pending.map(gameRow).join(''), '没有待审核的投稿')}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>🎮 游戏管理 <b>${managed.length}</b></h2></div>
    <form class="filters" method="get" action="/admin">
      <input name="q" value="${esc(filter.q || '')}" placeholder="按标题 / 拼音 / slug 搜" maxlength="40">
      <select name="status">${statusOpts}</select>
      <select name="category">${catOpts}</select>
      <button class="btn btn-sm" type="submit">筛选</button>
      ${filter.q || filter.status || filter.category ? '<a class="btn btn-sm" href="/admin">清空</a>' : ''}
    </form>
    <form method="post" action="/admin/games/batch" id="batchForm">
      <div class="batch-bar">
        <label class="check"><input type="checkbox" id="pickAll"> 全选本页</label>
        <button class="btn btn-sm ok" type="submit" name="status" value="1">⬆ 批量上架</button>
        <button class="btn btn-sm danger" type="submit" name="status" value="0">⬇ 批量下架</button>
        <span class="dim">一次最多 200 条</span>
      </div>
      ${wrapTable('<th>选</th><th>游戏</th><th>分类</th><th>游玩</th><th>评分</th><th>状态</th><th>操作</th>', managed.map(gameRow).join(''), '没有匹配的游戏')}
    </form>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>🚨 举报处理 <b>${reports.length}</b></h2><span class="dim">处理完记得隐藏评论或忽略举报</span></div>
    ${wrapTable('<th>原因</th><th>举报人</th><th>被举报内容</th><th>操作</th>', reports.map(reportRow).join(''), '暂时没有待处理的举报 🎉')}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>👥 用户管理 <b>${users.length}</b></h2><span class="dim">封禁会立刻踢掉该用户的登录态，并拦下后续登录</span></div>
    ${wrapTable('<th>用户</th><th>邮箱</th><th>评论/投稿</th><th>状态</th><th>操作</th>', users.map(userRow).join(''), '没有匹配的用户')}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>💬 最新评论 <b>${comments.length}</b></h2></div>
    ${wrapTable('<th>用户</th><th>游戏</th><th>内容</th><th>状态</th><th>操作</th>', comments.map(commentRow).join(''), '还没有评论')}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>🧾 操作日志 <b>${audit.length}</b></h2><span class="dim">谁在什么时候动了什么，都在这里</span></div>
    ${wrapTable('<th>时间</th><th>操作人</th><th>动作</th><th>对象</th>', audit.map(auditRow).join(''), '还没有操作记录')}
  </section>

  ${mailBox}
</div>`;
  return layout({ origin, user, title: '管理后台', description: '站长后台', path: '/admin', content, noindex: true });
}
