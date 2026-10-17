/** 服务端 HTML 模板（纯字符串渲染，零模板引擎依赖） */
import { isUploadedUrl, UPLOAD_LABEL } from './upload.js';
// 更新说明页的数据源：由 tools/gen-changelog.mjs 从 git 提交历史生成
import { CHANGELOG, CHANGELOG_GENERATED, CHANGELOG_TOTAL } from './changelog-data.js';

export const SITE = {
  name: '趣玩小游戏',
  tagline: '免费在线小游戏，即点即玩，无需下载',
  logo: '🎮',
  icp: '本站游戏均为自研或已获授权，仅供学习交流使用',
  contact: 'maohong0831@outlook.com'
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

/** 正文摘要：公告列表与 meta description 用 */
function excerpt(text, n = 140) {
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

export function homePage({ origin, featured, hot, newest, categories, tags, stats, user = null, notice = null }) {
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
${noticeBanner(notice)}
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

/** 评论区整块：游戏详情页与公告详情页共用（服务端分页 ?cpage=N，无 JS 也能翻页，楼中楼只做两级） */
function commentPanel({ thread, total = 0, user = null, path, slug, endpoint, loginHref, notice = '', heading = '玩家评论', empty = '还没有人评论，来抢沙发 🛋️' }) {
  if (STATIC_MODE) return '';
  const t = thread || { items: [], total: 0, page: 1, pages: 1 };
  const cmtPath = path + (t.page > 1 ? '?cpage=' + t.page : '') + '#cmtPanel';
  const items = t.items.length
    ? t.items.map((c) => commentItem(c, { user, path: cmtPath })).join('')
    : '<li class="cmt-empty">' + esc(empty) + '</li>';
  const pager = t.pages > 1
    ? '<nav class="pager" aria-label="评论分页">' +
        (t.page > 1
          ? '<a class="pg" href="' + esc(path) + '?cpage=' + (t.page - 1) + '#cmtPanel" rel="prev">‹ 上一页</a>'
          : '<span class="pg off">‹ 上一页</span>') +
        '<span class="pg-info">' + t.page + ' / ' + t.pages + ' 页</span>' +
        (t.page < t.pages
          ? '<a class="pg" href="' + esc(path) + '?cpage=' + (t.page + 1) + '#cmtPanel" rel="next">下一页 ›</a>'
          : '<span class="pg off">下一页 ›</span>') +
      '</nav>'
    : '';
  const form = user
    ? '<form class="cmt-form" id="cmtForm" data-slug="' + esc(slug) + '" data-endpoint="' + esc(endpoint) + '">' +
        '<textarea id="cmtBody" maxlength="500" rows="3" placeholder="说点什么…（最多 500 字）"></textarea>' +
        '<div class="cmt-form-foot">' +
          '<span class="cmt-reply-hint" id="cmtReplyHint" hidden>正在回复 <b id="cmtReplyName"></b>' +
          '<button class="linkbtn" type="button" id="cmtReplyCancel">取消</button></span>' +
          '<input type="hidden" id="cmtParent" value="">' +
          '<button class="btn btn-primary" type="submit">发表评论</button>' +
        '</div>' +
      '</form>'
    : '<p class="cmt-login"><a href="' + loginHref + '">登录</a> 后参与评论</p>';
  return '<div class="panel" id="cmtPanel" data-slug="' + esc(slug) + '" data-auth="' + (user ? 1 : 0) + '" data-page="' + t.page + '">' +
    '<h2>' + esc(heading) + ' <small class="cmt-count" id="cmtCount">' + Number(total || 0) + '</small></h2>' +
    (notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : '') +
    form +
    '<ul class="cmt-list" id="cmtList">' + items + '</ul>' +
    pager +
  '</div>';
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

      ${commentPanel({ thread, total: commentTotal, user, path, slug: game.slug, endpoint: '/api/games/' + encodeURIComponent(game.slug) + '/comments', loginHref, notice: cmtNotice })}

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

/* ---------- 公告 ---------- */

/** 公告分页导航（列表页用） */
function noticePager(page, pages) {
  if (pages <= 1) return '';
  return '<nav class="pager" aria-label="公告分页">' +
    (page > 1 ? '<a class="pg" href="/notice?page=' + (page - 1) + '" rel="prev">‹ 上一页</a>' : '<span class="pg off">‹ 上一页</span>') +
    '<span class="pg-info">' + page + ' / ' + pages + ' 页</span>' +
    (page < pages ? '<a class="pg" href="/notice?page=' + (page + 1) + '" rel="next">下一页 ›</a>' : '<span class="pg off">下一页 ›</span>') +
  '</nav>';
}

/** 公告列表：只列已发布的；撤回的只有站长在后台看得到 */
export function noticeListPage({ origin, user = null, items = [], total = 0, page = 1, pages = 1, banner = null }) {
  const rows = items.length
    ? items.map((p) => `<li class="notice-item${Number(p.pinned) ? ' pinned' : ''}">
  <div class="ni-head">
    <a class="ni-title" href="/notice/${encodeURIComponent(p.slug)}">${Number(p.pinned) ? '📌 ' : ''}${esc(p.title)}</a>
    <time>${esc(String(p.published_at || p.created_at || '').slice(0, 16))}</time>
  </div>
  <p class="ni-excerpt">${esc(excerpt(p.body, 150))}</p>
  <p class="ni-meta"><span>💬 ${Number(p.comments) || 0} 条评论</span>${p.updated_at ? '<span>最后修改 ' + esc(String(p.updated_at).slice(0, 16)) + '</span>' : ''}</p>
</li>`).join('')
    : '<li class="cmt-empty">还没有公告</li>';
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>公告</b></nav>
  <div class="page-head">
    <h1>📢 公告</h1>
    <p class="page-sub">站长的公告、活动与站点消息都在这里，每条公告都能评论</p>
    <p class="page-count">共 <b>${Number(total) || 0}</b> 条公告</p>
  </div>
  ${banner ? banner : ''}
  <ul class="notice-list">${rows}</ul>
  ${noticePager(page, pages)}
</div>`;
  return layout({ origin, user, title: '公告', description: '站点公告与活动通知', path: '/notice', content });
}

/** 公告详情：正文 + 共用评论区 */
export function noticePage({ origin, user = null, post, thread = null, commentTotal = 0, cmtNotice = '' }) {
  const path = '/notice/' + post.slug;
  const paras = String(post.body || '').split(/\n{2,}/).filter((s) => s.trim()).map((s) => '<p>' + esc(s).replace(/\n/g, '<br>') + '</p>').join('');
  /* updated_at 只在真的改过正文/标题后才写（发布/撤回不算），所以有值就是改过 */
  const edited = !!post.updated_at;
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><a href="/notice">公告</a><span>›</span><b>${esc(post.title)}</b></nav>
  <article class="panel post-body">
    <h1 class="post-title">${Number(post.pinned) ? '📌 ' : ''}${esc(post.title)}</h1>
    <p class="post-meta">发布于 ${esc(String(post.published_at || post.created_at || '').slice(0, 16))}${edited ? ' · 最后修改 ' + esc(String(post.updated_at).slice(0, 16)) : ''}</p>
    <div class="post-text">${paras}</div>
  </article>
  ${commentPanel({ thread, total: commentTotal, user, path, slug: post.slug, endpoint: '/api/notices/' + encodeURIComponent(post.slug) + '/comments', loginHref: '/login?next=' + encodeURIComponent(path), notice: cmtNotice })}
</div>`;
  return layout({ origin, user, title: post.title, description: excerpt(post.body, 120), path, content });
}

/** 更新说明：从 git 提交历史生成（tools/gen-changelog.mjs），按天分组 */
export function changelogPage({ origin, user = null }) {
  const days = [];
  const byDay = new Map();
  CHANGELOG.forEach((e) => {
    if (!byDay.has(e.day)) { byDay.set(e.day, []); days.push(e.day); }
    byDay.get(e.day).push(e);
  });
  const blocks = days.length ? days.map((day) => `<section class="sec">
  <div class="sec-head"><h2>${esc(day)}</h2><span class="dim">${byDay.get(day).length} 条改动</span></div>
  <ul class="log-list">${byDay.get(day).map((e) => `<li>
    <span class="log-kind k-${esc(e.kind || 'other')}">${esc(e.kindLabel)}</span>
    <b>${esc(e.subject)}</b>
    <code>${esc(e.hash)}</code>
  </li>`).join('')}</ul>
</section>`).join('') : '<p class="empty">还没有提交记录</p>';
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>更新说明</b></nav>
  <div class="page-head">
    <h1>📝 更新说明</h1>
    <p class="page-sub">这一页直接读 <code>git log</code> 生成：每次改动都在这里留痕，不靠手写</p>
    <p class="page-count">共 <b>${Number(CHANGELOG_TOTAL) || 0}</b> 条提交 · 生成于 ${esc(String(CHANGELOG_GENERATED || ''))}</p>
  </div>
  ${blocks}
</div>`;
  return layout({ origin, user, title: '更新说明', description: '站点更新记录：从 git 提交历史生成', path: '/changelog', content });
}

/** 后台写公告 / 改公告（新建时 post 为 null） */
export function postFormPage({ origin, user = null, post = null, error = '' }) {
  const v = post || { title: '', body: '', pinned: 0, slug: '', status: 1 };
  const isNew = !post;
  const action = isNew ? '/admin/posts/new' : '/admin/posts/' + encodeURIComponent(v.slug) + '/edit';
  const ERR = {
    title_empty: '标题不能为空',
    title_long: '标题太长（最多 80 字）',
    body_empty: '正文不能为空',
    body_long: '正文太长（最多 10000 字）'
  };
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><a href="/admin">后台</a><span>›</span><b>${isNew ? '写公告' : '改公告'}</b></nav>
  <div class="page-head">
    <h1>${isNew ? '📢 写一条公告' : '✏️ 修改公告'}</h1>
    <p class="page-sub">${isNew ? '发布后导航的「公告」页和首页横幅都会出现，玩家还能在公告下面评论' : '改完保存即生效；撤回 / 再发布在后台公告列表里操作'}</p>
  </div>
  ${error ? '<p class="auth-err">' + esc(ERR[error] || error) + '</p>' : ''}
  <form class="post-form" method="post" action="${action}">
    <label>标题
      <input name="title" value="${esc(v.title || '')}" maxlength="80" required placeholder="例如：国庆活动：新游戏上线 + 评论抽奖">
    </label>
    <label>正文
      <textarea name="body" rows="16" maxlength="10000" required placeholder="正文支持空行分段，纯文本，不用写 HTML">${esc(v.body || '')}</textarea>
    </label>
    <label class="check"><input type="checkbox" name="pinned" value="1"${Number(v.pinned) ? ' checked' : ''}> 置顶（排在公告列表最前，也会优先上首页横幅）</label>
    ${isNew ? '<label class="check"><input type="checkbox" name="draft" value="1"> 先存着不发布（存下来是「已撤回」，随时能发布）</label>' : '<p class="dim">当前状态：' + (Number(v.status) ? '已发布' : '已撤回') + '</p>'}
    <div class="post-actions">
      <button class="btn btn-primary" type="submit">${isNew ? '保存公告' : '保存修改'}</button>
      <a class="btn" href="/admin">回后台</a>
      ${isNew ? '' : '<a class="btn" href="/notice/' + encodeURIComponent(v.slug) + '" target="_blank">看前台效果</a>'}
    </div>
  </form>
</div>`;
  return layout({ origin, user, title: isNew ? '写公告' : '修改公告', description: '站长公告编辑', path: '/admin/posts', content, noindex: true });
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

/** 第三方登录按钮（登录页、注册页共用）：没配的 Provider 不会出现 */
function oauthButtons(providers, next) {
  if (!providers || !providers.length) return '';
  const q = '?next=' + encodeURIComponent(next || '/');
  return '<div class="oauth-box"><p class="oauth-sep">或者用第三方账号</p>' +
    providers.map(function (p) {
      const text = p.key === 'dev' ? '🧪 演示登录' : esc(p.icon || '') + ' 用 ' + esc(p.label) + ' 登录';
      return '<a class="btn oauth-btn" href="/auth/' + esc(p.key) + q + '">' + text + '</a>';
    }).join('') + '</div>';
}

export function loginPage({ origin, user = null, next = '/', error = '', username = '', providers = [] }) {
  const body = `
    ${error ? `<p class="auth-err">⚠️ ${esc(error)}</p>` : ''}
    <form class="auth-form" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required maxlength="16" autofocus></label>
      <label>密码<input type="password" name="password" autocomplete="current-password" required maxlength="72"></label>
      <button class="btn btn-primary" type="submit">登录</button>
    </form>
    ${oauthButtons(providers, next)}
    <p class="auth-foot">还没有账号？<a href="/register?next=${encodeURIComponent(next)}">立即注册</a></p>`;
  return authCard({ origin, user, title: '登录', heading: '登录', sub: '登录后可以评分、评论和收藏游戏', body, path: '/login' });
}

export function registerPage({ origin, user = null, next = '/', error = '', username = '', displayName = '', providers = [] }) {
  const body = `
    ${error ? `<p class="auth-err">⚠️ ${esc(error)}</p>` : ''}
    <form class="auth-form" method="post" action="/register">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required maxlength="16" autofocus><small>2~16 位中文、字母、数字、下划线或短横线</small></label>
      <label>昵称（可选）<input name="display_name" value="${esc(displayName)}" maxlength="20"><small>留空就用用户名</small></label>
      <label>密码<input type="password" name="password" autocomplete="new-password" required maxlength="72"><small>至少 6 位</small></label>
      <label class="check agree"><input type="checkbox" name="agree" value="1" required><span>我已阅读并同意 <a href="/terms" target="_blank" rel="noopener">《用户协议》</a>与<a href="/privacy" target="_blank" rel="noopener">《隐私政策》</a></span></label>
      <button class="btn btn-primary" type="submit">注册并登录</button>
    </form>
    ${oauthButtons(providers, next)}
    <p class="auth-foot">已经有账号？<a href="/login?next=${encodeURIComponent(next)}">去登录</a></p>`;
  return authCard({ origin, user, title: '注册', heading: '注册', sub: '注册后即可评分、评论和收藏', body, path: '/register' });
}

/* ================= 法律页面（隐私政策 / 用户协议） ================= */

const LEGAL_UPDATED = '2026-10-17';

const PRIVACY_SECTIONS = [
  { h: '1. 这份政策管什么', p: [
    '本站是 ' + SITE.name + '（' + SITE.tagline + '），一个免费在线小游戏站。这份政策说明：你用本站时我们会拿到哪些信息、拿来做什么、存在哪里、你能怎么处理。它适用于本站所有页面以及各游戏的试玩页；页面里嵌入的第三方网站（比如投稿者自己域名下的游戏）由对方负责，不适用这份政策。'
  ] },
  { h: '2. 我们收集哪些信息', p: [
    '<b>账号信息</b>：注册时你填的用户名、昵称，以及可选填的邮箱；密码只保存加盐哈希，我们看不到也无法还原你的明文密码。',
    '<b>使用记录</b>：你的评分、评论与回复、收藏、投稿内容，以及每款游戏的游玩次数。',
    '<b>技术信息</b>：IP 地址（只用于限流防刷：同一 IP 对同一游戏 30 秒内只计一次游玩、发表评论 10 秒一条、举报一人一条），以及浏览器 Cookie 里的会话标识。本站没有埋点统计，也不采集设备指纹。'
  ] },
  { h: '3. Cookie', p: [
    '本站只用两个必要的 Cookie：<code>sid</code> 保存登录态（登录后才有，最长 30 天），<code>oauth_state</code> 用于第三方登录时的临时校验（10 分钟）。没有广告 Cookie，也没有第三方分析脚本。清掉浏览器 Cookie 会退出登录，不影响浏览与游玩。'
  ] },
  { h: '4. 第三方登录', p: [
    '用 GitHub 或 Google 登录时，我们只会拿到该平台返回的用户 ID、昵称和邮箱，用来创建账号或绑定到你已有的账号；你在那边的密码不会经过本站，我们也拿不到。<a href="/account">账号设置</a>里可以随时解绑。'
  ] },
  { h: '5. 邮件', p: [
    '只有在你绑定邮箱、重新发送验证邮件或申请找回密码时，本站才会往你的邮箱发信；收件地址会经过邮件服务商（Resend 或本站自建的发信接口）。我们不会用邮箱做推广。'
  ] },
  { h: '6. 这些信息拿来做什么', p: [
    '展示你的昵称与评论、统计评分与游玩热度、生成排行榜、防止刷分与灌水、处理举报与后台运营、发送验证与密码重置邮件。除此之外不做其他用途。'
  ] },
  { h: '7. 存在哪里、留多久', p: [
    '数据存在本站服务器与云端数据库中。站长在后台可以<strong>彻底删除</strong>一款游戏，删除时会连带它的评论与回复、评论举报、评分、收藏、游玩记录和上传的游戏文件一起删掉；不再需要的举报与日志也会按运营需要清理。要注销账号或导出自己的数据，发邮件给站长即可。'
  ] },
  { h: '8. 你的权利', p: [
    '在 <a href="/account">账号设置</a>里可以改密码、绑定或更换邮箱、解绑第三方登录。想删除账号、更正信息或了解自己有哪些数据，联系站长处理。'
  ] },
  { h: '9. 未成年人', p: [
    '注册本站不需要填写真实姓名、手机号或身份证件；评论与投稿会公开展示。未满 14 周岁的用户请在监护人同意后使用；监护人若发现未成年人注册，可以联系站长删除账号与内容。'
  ] },
  { h: '10. 政策更新', p: [
    '政策有变化时会在本页更新「最后更新」日期，重大变更会在站内公告。继续使用本站即视为接受更新后的版本。'
  ] },
  { h: '11. 联系方式', p: [
    '站长邮箱：<a href="mailto:' + SITE.contact + '">' + esc(SITE.contact) + '</a>。'
  ] }
];

const TERMS_SECTIONS = [
  { h: '1. 接受条款', p: [
    '注册、登录或以其他方式使用 ' + SITE.name + '，即表示你已阅读并同意本协议与<a href="/privacy">《隐私政策》</a>。注册页必须勾选同意后才能提交。如果你不同意，请不要注册或使用本站。'
  ] },
  { h: '2. 你的账号', p: [
    '用户名不得冒充他人、不得包含违法或不良信息；请不要与他人共用账号。账号下发生的操作视为你本人所为，密码请自行保管好，怀疑被盗用请立即改密码并联系站长。'
  ] },
  { h: '3. 你发布的内容', p: [
    '评论、回复与投稿都由你负责。你保证对这些内容拥有权利，并且不上传违法、侵权、含恶意代码、赌博、诱导分享或骚扰他人的内容。评论区一人一条、同一游戏 10 秒一条，刷屏或灌水会被清理。'
  ] },
  { h: '4. 投稿与授权', p: [
    '投稿的单文件 HTML 游戏会保存在本站、在隔离环境中试玩（沙箱不允许它读取本站数据）。游戏上架即表示你授权本站免费展示、缓存并向访客提供试玩；下架或彻底删除后该授权终止，服务器日志与备份可能再短期保留一段时间。请只在游戏里放游戏本身，不要放隐私数据或密钥。'
  ] },
  { h: '5. 我们保留的权利', p: [
    '站长可以审核、下架或彻底删除任何游戏、评论与投稿，也可以封禁违规账号（封禁会在账号页给出理由，封禁后无法登录）。发现误判可以发邮件申诉。'
  ] },
  { h: '6. 举报与处理', p: [
    '游戏详情页与评论区都可以举报（垃圾广告、辱骂攻击、剧透、其他），同一人对同一条内容只计一次，处理结果在站长后台留档。'
  ] },
  { h: '7. 第三方内容', p: [
    '本站可能嵌入第三方地址的游戏、使用第三方登录（GitHub / Google）。这些服务由对方提供与维护，其内容、可用性和数据处理不归本站管，请自行判断。'
  ] },
  { h: '8. 免责', p: [
    '本站免费、按「现状」提供，不对数据丢失、服务中断或第三方内容承担责任；游戏进度一般只存在你的浏览器里，清缓存可能丢失。上传的单文件 HTML 上架后任何人都能取到，请不要在里面存放敏感数据。'
  ] },
  { h: '9. 服务变更与终止', p: [
    '本站可以随时调整、暂停或停止部分功能；重要变更会在站内公告或本页说明。你如果不再同意本协议，可以停止使用并联系站长删除账号。'
  ] },
  { h: '10. 其他', p: [
    '本协议适用中华人民共和国法律。发生争议双方先友好协商；协商不成，由站长所在地有管辖权的法院处理。'
  ] },
  { h: '11. 联系方式', p: [
    '站长邮箱：<a href="mailto:' + SITE.contact + '">' + esc(SITE.contact) + '</a>。'
  ] }
];

function legalSection(s) {
  return '<h2>' + esc(s.h) + '</h2>' + s.p.map(function (t) { return '<p>' + t + '</p>'; }).join('');
}

function legalPage({ origin, user = null, title, heading, sub, path, sections }) {
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>${esc(heading)}</b></nav>
  <div class="page-head">
    <h1>${esc(heading)}</h1>
    <p class="page-sub">${esc(sub)}</p>
  </div>
  <article class="prose">
    <p class="legal-updated">最后更新：${LEGAL_UPDATED}</p>
    ${sections.map(legalSection).join('')}
  </article>
</div>`;
  return layout({ origin, user, title, description: sub, path, content });
}

export function privacyPage({ origin, user = null }) {
  return legalPage({
    origin, user, path: '/privacy', title: '隐私政策', heading: '隐私政策',
    sub: '本站会拿到哪些信息、怎么用、你怎么处理', sections: PRIVACY_SECTIONS
  });
}

export function termsPage({ origin, user = null }) {
  return legalPage({
    origin, user, path: '/terms', title: '用户协议', heading: '用户协议',
    sub: '注册与使用本站的规则', sections: TERMS_SECTIONS
  });
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
  outbox = [], mailTransport = 'outbox', notice = '', integrations = null, posts = []
}) {
  const NOTICE = {
    batch: '批量操作已完成',
    ban: '用户状态已更新',
    report: '举报已处理',
    comment: '评论状态已更新',
    email: '邮箱验证状态已更新',
    purge: '游戏已彻底删除（连同评分、评论、收藏、游玩记录与上传文件）',
    post: '公告已保存',
    postStatus: '公告状态已更新（撤回只是前台隐藏，评论都还在）'
  };

  const gameRow = (g) => `<tr>
    <td class="pick"><input type="checkbox" name="slug" value="${esc(g.slug)}" aria-label="选择 ${esc(g.title)}"></td>
    <td><b>${esc(g.emoji)} ${esc(g.title)}</b><br><small class="dim">${esc(g.slug)} · ${esc(g.game_url)}</small></td>
    <td>${esc(g.category ? g.category.name : '—')}</td>
    <td>${fmtNum(g.plays)}</td>
    <td>${Number(g.rating_count) ? Number(g.rating).toFixed(1) + ' <small class="dim">(' + g.rating_count + ')</small>' : '<small class="dim">—</small>'}</td>
    <td>${statusPill(g.status)}</td>
    <td class="act">${statusForms(g)}<a class="btn btn-sm" href="/admin/preview/${esc(g.slug)}">预览</a>${
      Number(g.status) === 1
        ? '<small class="dim">下架后可彻底删除</small>'
        : '<a class="btn btn-sm danger" href="/admin/games/' + esc(g.slug) + '/delete">🗑 彻底删除</a>'}</td>
  </tr>`;

  // 评论挂在游戏或公告上：按 target 生成对应前台的链接
  const atHref = (r) => (r.target === 'post' ? '/notice/' : '/game/') + encodeURIComponent(r.slug || '');

  const postRow = (p) => `<tr>
    <td><b>${esc(p.title)}</b><br><small class="dim">${esc(p.slug)} · ${esc(String(p.published_at || p.created_at || '').slice(0, 16))}</small>
      <br><small class="dim">${esc(excerpt(p.body, 60))}</small></td>
    <td>${Number(p.pinned) ? '<span class="pill s1">置顶</span>' : '<small class="dim">—</small>'}</td>
    <td>${Number(p.comments) || 0}</td>
    <td>${Number(p.status) ? '<span class="pill s1">已发布</span>' : '<span class="pill s0">已撤回</span>'}</td>
    <td class="act">${Number(p.status) ? '<a class="btn btn-sm" href="/notice/' + encodeURIComponent(p.slug) + '" target="_blank">查看</a>' : '<small class="dim">已撤回，前台看不到</small>'}
      <a class="btn btn-sm" href="/admin/posts/${encodeURIComponent(p.slug)}/edit">编辑</a>
      <form class="inline" method="post" action="/admin/posts/${encodeURIComponent(p.slug)}/status">
      <input type="hidden" name="status" value="${Number(p.status) ? 0 : 1}">
      <button class="btn btn-sm ${Number(p.status) ? '' : 'ok'}" type="submit">${Number(p.status) ? '撤回' : '发布'}</button></form></td>
  </tr>`;

  const commentRow = (c) => `<tr>
    <td>${esc(c.name)}${c.parent_id ? ' <small class="dim">回复</small>' : ''}<br><small class="dim">${esc(String(c.created_at).slice(0, 16))}</small></td>
    <td><a href="${atHref(c)}" target="_blank">${esc(c.title)}</a></td>
    <td class="cmt-cell">${esc(c.body)}${Number(c.reports) ? ' <span class="pill s2">被举报 ' + Number(c.reports) + '</span>' : ''}</td>
    <td>${Number(c.status) ? '<span class="pill s1">显示中</span>' : '<span class="pill s0">已隐藏</span>'}</td>
    <td class="act"><form class="inline" method="post" action="/admin/comments/${c.id}/status">
      <input type="hidden" name="status" value="${Number(c.status) ? 0 : 1}">
      <button class="btn btn-sm" type="submit">${Number(c.status) ? '隐藏' : '恢复'}</button></form></td>
  </tr>`;

  const reportRow = (r) => `<tr>
    <td><span class="pill s2">${esc(REPORT_LABEL[r.reason] || r.reason)}</span><br><small class="dim">${esc(String(r.created_at).slice(0, 16))}</small></td>
    <td>${esc(r.reporter)}${r.detail ? '<br><small class="dim">' + esc(r.detail) + '</small>' : ''}</td>
    <td class="cmt-cell">${esc(r.body)}<br><small class="dim">作者：${esc(r.author)} · <a href="${atHref(r)}" target="_blank">${esc(r.title)}</a></small></td>
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

  const integ = integrations || null;
  const integSection = integ ? (function () {
    const m = integ.mail || {};
    const label = m.transport === 'resend' ? 'Resend' : (m.transport === 'http' ? '自建 HTTP 邮件服务' : '开发发件箱');
    const live = m.transport === 'resend' || m.transport === 'http';
    let hint = '没配邮件服务：验证信、重置信只会落进开发发件箱，玩家收不到。配 RESEND_API_KEY，或 MAIL_API_URL + MAIL_API_KEY 之后即真实发送。';
    if (m.transport === 'resend') hint = '走 Resend API 真实发送，发件人 ' + m.from + '。';
    else if (m.transport === 'http') hint = 'POST ' + (m.endpoint || '(未填 MAIL_API_URL)') + '，令牌' + (m.keySet ? '已配' : '未配') + '，发件人 ' + m.from + '。';
    const box = ['<div class="integ-row"><b>📮 邮件通道</b><span class="pill ' + (live ? 's1' : 's2') + '">' + esc(label) + '</span><small class="dim">' + esc(hint) + '</small></div>'];
    (integ.oauth || []).forEach(function (p) {
      const tail = p.key === 'dev'
        ? '开发环境自动可用，生产环境要 OAUTH_DEV=1 才开。'
        : 'client_id ' + (p.idSet ? '✅ 有' : '❌ 无') + ' · secret ' + (p.secretSet ? '✅ 有' : '❌ 无') +
          (p.enabled ? '' : '；去设 ' + (p.env || '')) +
          (p.callback ? '<br>回调地址（照这串填到第三方后台）：<code>' + esc(p.callback) + '</code>' : '');
      box.push('<div class="integ-row"><b>' + esc((p.icon || '') + ' ' + p.label) + '</b><span class="pill ' +
        (p.enabled ? 's1' : 's2') + '">' + (p.enabled ? '已开启' : '未配置') + '</span><small class="dim">' + tail + '</small></div>');
    });
    return '<section class="sec"><div class="sec-head"><h2>🔌 集成自检</h2>' +
      '<span class="dim">邮件与第三方登录的配置状态；密钥只看有没有配，不显示内容</span></div>' +
      '<div class="integ">' + box.join('') + '</div></section>';
  })() : '';

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
    <div class="stat"><b>${Number(stats.posts) || 0}</b><span>已发布公告</span></div>
  </div>

  <section class="sec">
    <div class="sec-head"><h2>📢 公告管理 <b>${posts.length}</b></h2><span class="dim">发布、编辑、撤回；撤回只是前台隐藏，评论都留着 <a class="btn btn-sm" href="/admin/posts/new">➕ 写公告</a></span></div>
    ${wrapTable('<th>公告</th><th>置顶</th><th>评论</th><th>状态</th><th>操作</th>', posts.map(postRow).join(''), '还没有公告，点右上角写一条')}
  </section>

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

  ${integSection}
  ${mailBox}
</div>`;
  return layout({ origin, user, title: '管理后台', description: '站长后台', path: '/admin', content, noindex: true });
}

/** 彻底删除确认页：列出会被连带删掉的数据量，上架中的游戏不让删 */
export function deleteGamePage({ origin, user = null, game, counts = {} }) {
  const rows = [
    ['评论（含回复）', counts.comments || 0],
    ['评论举报', counts.reports || 0],
    ['评分', counts.ratings || 0],
    ['收藏', counts.favorites || 0],
    ['游玩记录', counts.plays || 0],
    ['上传的 HTML 文件', counts.file || 0]
  ];
  const body = `
    <p class="auth-err">⚠️ 这一步不可撤销。<b>${esc(game.title)}</b>（${esc(game.slug)}）连同下面这些数据一起从库里删掉：</p>
    <ul class="purge-list">${rows.map((r) => '<li><span>' + esc(r[0]) + '</span><b>' + fmtNum(r[1]) + '</b></li>').join('')}</ul>
    <p class="auth-sub">用户账号、操作日志会保留，方便以后追查。上架中的游戏要先下架才能删。</p>
    <form class="auth-form" method="post" action="/admin/games/${esc(game.slug)}/delete">
      <button class="btn danger" type="submit">确认彻底删除</button>
    </form>
    <p class="auth-foot"><a href="/admin">算了，回后台</a></p>`;
  return authCard({
    origin, user, title: '彻底删除 ' + game.title, heading: '🗑 彻底删除游戏',
    sub: Number(game.status) === 1 ? '这个游戏还在上架中，先下架再删' : '删除前请再核对一遍下面的数据量',
    body, path: '/admin'
  });
}



/* ==================== 论坛 ==================== */
/* 论坛挂两种路径：游戏站的 /forum/*，以及 forum.fishport.cn 的根路径。
   所以论坛正文的链接一律用路由传进来的 base（'' 或 '/forum'）拼，别写死；
   后台的路由固定是 /forum/admin（两种挂载下都存在，见 server.js / worker/app.js 的重写规则）。 */

const FT_STATUS = { 0: '待审核', 1: '已发布', 2: '已下架' };
const FP_STATUS = { 0: '待审核', 1: '已发布', 2: '已隐藏' };
const FR_STATUS = { 0: '待处理', 1: '已处理', 2: '已忽略' };
const FR_LABEL = { spam: '垃圾广告', ad: '推广刷屏', abuse: '人身攻击', illegal: '违法内容', other: '其他' };

function ftime(v) {
  return esc(String(v || '').slice(0, 16));
}

function ftext(body) {
  return esc(body).replace(/\r?\n/g, '<br>');
}

function fpill(status, map) {
  return '<span class="pill f' + Number(status) + '">' + esc(map[Number(status)] || '未知') + '</span>';
}

/** 论坛分页：基址与查询串由调用方给，两种挂载路径共用一个实现 */
function forumPager(base, path, page, pages, qs = '') {
  if (pages <= 1) return '';
  const href = (p) => base + path + '?page=' + p + (qs ? '&' + qs : '');
  return '<nav class="pager" aria-label="分页">' +
    (page > 1 ? '<a class="pg" href="' + esc(href(page - 1)) + '" rel="prev">‹ 上一页</a>' : '<span class="pg off">‹ 上一页</span>') +
    '<span class="pg-info">' + page + ' / ' + pages + ' 页</span>' +
    (page < pages ? '<a class="pg" href="' + esc(href(page + 1)) + '" rel="next">下一页 ›</a>' : '<span class="pg off">下一页 ›</span>') +
  '</nav>';
}

/** 人机校验：一次性令牌（服务端签发、一人一用、30 分钟过期）+ 蜜罐字段 */
function antispamFields(form = {}) {
  return '<input type="hidden" name="form_token" value="' + esc(form.token || '') + '">' +
    '<div class="hp" aria-hidden="true" hidden><label>网址（这一栏请留空）' +
    '<input type="text" name="' + esc(form.honeypot || 'website') + '" tabindex="-1" autocomplete="off"></label></div>';
}

/** 不能发帖时给一句话说明，并把去路指清楚 */
function gateBox(gate, base, next) {
  const err = gate && gate.error ? gate.error : 'login';
  const login = '/login?next=' + encodeURIComponent((base || '') + (next || '/'));
  const map = {
    login: '<a href="' + esc(login) + '">登录</a>或<a href="/register">注册</a>后才能发帖',
    banned: '你的账号已被封禁，无法发言',
    muted: '你正在被禁言',
    email: '<a href="/account">去「账号」页验证邮箱</a>后才能发帖'
  };
  return '<p class="forum-gate">🔒 ' + (map[err] || esc((gate && gate.message) || '现在不能发帖')) +
    (err === 'muted' && gate && gate.message ? '<small>' + esc(gate.message) + '</small>' : '') + '</p>';
}

function threadItem(t, base) {
  return '<li class="thr' + (Number(t.pinned) ? ' pinned' : '') + '">' +
    '<a class="thr-link" href="' + base + '/t/' + Number(t.id) + '">' +
      '<span class="thr-title">' + (Number(t.pinned) ? '📌 ' : '') + (Number(t.locked) ? '🔒 ' : '') + esc(t.title) + '</span>' +
      '<span class="thr-meta">' + esc(t.forum_name || '') + ' · ' + esc(t.name || t.username || '—') + ' · ' + ftime(t.last_reply_at || t.created_at) +
      ' · ' + fmtNum(t.reply_count) + ' 回复 · ' + fmtNum(t.view_count) + ' 浏览</span>' +
    '</a>' +
    (Number(t.status) !== 1 ? fpill(t.status, FT_STATUS) : '') +
    '</li>';
}

/** 论坛首页：板块导航 + 最新主题 + 搜索 */
export function forumHomePage({ origin, user = null, forums = [], threads = [], stats = {}, q = '', page = 1, pages = 1, total = 0, base = '/forum', notice = '' }) {
  const cards = forums.length
    ? '<ul class="fboards">' + forums.map((f) =>
      '<li><a href="' + base + '/f/' + encodeURIComponent(f.slug) + '">' +
      '<span class="fb-ico">' + esc(f.icon || '💬') + '</span>' +
      '<span class="fb-name">' + esc(f.name) + '</span>' +
      '<span class="fb-desc">' + esc(f.description || '') + '</span>' +
      '<span class="fb-count">' + fmtNum(f.thread_count) + ' 主题 / ' + fmtNum(f.post_count) + ' 回复</span>' +
      '</a></li>').join('') + '</ul>'
    : '<p class="cmt-empty">还没有板块</p>';
  const list = threads.length
    ? '<ul class="thr-list">' + threads.map((t) => threadItem(t, base)).join('') + '</ul>' +
      forumPager(base, '/', page, pages, q ? 'q=' + encodeURIComponent(q) : '')
    : '<p class="cmt-empty">' + (q ? '没有搜到相关主题' : '还没有主题，来发第一帖吧') + '</p>';
  const content = `<div class="wrap forum">
  <div class="forum-head">
    <h1>💬 论坛</h1>
    <p class="forum-sub">${esc(SITE.name)}的玩家讨论区：攻略、求助、站务都在这儿。发帖用游戏站账号；新账号的前 3 帖会先进待审队列，站长放行后大家才看得到。</p>
    <div class="forum-stats">
      <span><b>${fmtNum(stats.threads)}</b> 主题</span>
      <span><b>${fmtNum(stats.posts)}</b> 回复</span>
      <span><b>${fmtNum(stats.today)}</b> 今日新增</span>
      ${user && user.role === 'admin' ? '<span><b>' + fmtNum((stats.pendingThreads || 0) + (stats.pendingPosts || 0)) + '</b> 待审</span><span><b>' + fmtNum(stats.reports) + '</b> 待处理举报</span>' : ''}
    </div>
    <div class="forum-actions">
      <a class="btn ok" href="${base}/new">✏️ 发新帖</a>
      ${user && user.role === 'admin' ? '<a class="btn" href="/forum/admin">🛡 论坛管理</a>' : ''}
      ${notice ? '<span class="forum-notice">' + esc(notice) + '</span>' : ''}
    </div>
    <form class="forum-search" method="get" action="${base}/" role="search">
      <input type="search" name="q" value="${esc(q)}" placeholder="搜主题标题或正文" aria-label="搜索帖子">
      <button type="submit">搜索</button>
    </form>
  </div>
  <section class="sec"><div class="sec-head"><h2>板块</h2></div>${cards}</section>
  <section class="sec">
    <div class="sec-head"><h2>${q ? '搜索结果' : '最新主题'}</h2>${q ? '<span class="more">「' + esc(q) + '」共 ' + fmtNum(total) + ' 条</span>' : ''}</div>
    ${list}
  </section>
</div>`;
  return layout({ origin, user, title: '论坛', description: '玩家论坛：攻略心得、求助答疑与站务反馈', path: base + '/', content });
}

/** 单个板块的主题列表 */
export function forumBoardPage({ origin, user = null, forum, threads = [], q = '', page = 1, pages = 1, total = 0, base = '/forum' }) {
  const list = threads.length
    ? '<ul class="thr-list">' + threads.map((t) => threadItem(t, base)).join('') + '</ul>' +
      forumPager(base, '/f/' + encodeURIComponent(forum.slug), page, pages, q ? 'q=' + encodeURIComponent(q) : '')
    : '<p class="cmt-empty">这个板块还没有主题，来发第一帖吧</p>';
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <span>${esc(forum.name)}</span></nav>
  <div class="forum-head">
    <h1>${esc(forum.icon || '💬')} ${esc(forum.name)}</h1>
    <p class="forum-sub">${esc(forum.description || '')}</p>
    <div class="forum-actions">
      <a class="btn ok" href="${base}/new?forum=${encodeURIComponent(forum.slug)}">✏️ 在本板块发帖</a>
    </div>
    <form class="forum-search" method="get" action="${base}/f/${encodeURIComponent(forum.slug)}" role="search">
      <input type="search" name="q" value="${esc(q)}" placeholder="搜这个板块的主题" aria-label="搜索帖子">
      <button type="submit">搜索</button>
    </form>
  </div>
  <section class="sec">
    <div class="sec-head"><h2>主题</h2><span class="more">共 ${fmtNum(total)} 条${q ? '（搜索：' + esc(q) + '）' : ''}</span></div>
    ${list}
  </section>
</div>`;
  return layout({ origin, user, title: forum.name, description: forum.description || forum.name, path: base + '/f/' + forum.slug, content });
}

/** 一个楼层：左边作者信息，右边正文与操作（回复 / 编辑 / 举报） */
function forumPostItem(p, { user, base }) {
  const mine = !!user && Number(p.user_id) === Number(user.id);
  const isAdmin = !!user && user.role === 'admin';
  const pending = Number(p.status) !== 1;
  const report = user && !mine
    ? '<details class="rp"><summary>举报</summary><form method="post" action="' + base + '/report">' +
      '<input type="hidden" name="target_type" value="post"><input type="hidden" name="target_id" value="' + Number(p.id) + '">' +
      '<select name="reason" aria-label="举报理由">' + Object.keys(FR_LABEL).map((k) => '<option value="' + k + '">' + esc(FR_LABEL[k]) + '</option>').join('') + '</select>' +
      '<input type="text" name="detail" maxlength="200" placeholder="补充说明（可留空）">' +
      '<button class="btn btn-sm danger" type="submit">提交举报</button></form></details>'
    : '';
  return '<li class="fpost' + (pending ? ' pend' : '') + '" id="p' + Number(p.id) + '">' +
    '<div class="fp-side"><b>' + esc(p.name || p.username || '—') + '</b>' + (p.role === 'admin' ? '<i class="badge">站长</i>' : '') +
      '<small>' + (Number(p.floor) ? '#' + Number(p.floor) + ' 楼' : '') + '</small><small>' + ftime(p.created_at) + '</small>' +
      (Number(p.edit_count) ? '<small class="dim">已编辑 ' + Number(p.edit_count) + ' 次</small>' : '') + '</div>' +
    '<div class="fp-main">' +
      (p.parent_name ? '<div class="fp-quote">回复 @' + esc(p.parent_name) + '</div>' : '') +
      '<div class="fp-body">' + ftext(p.body) + '</div>' +
      '<div class="fp-act">' + (pending ? fpill(p.status, FP_STATUS) : '') +
      (!pending ? '<a class="btn btn-sm" href="' + base + '/t/' + Number(p.thread_id || 0) + '?reply=' + Number(p.id) + '#reply">回复</a>' : '') +
      (mine || isAdmin ? '<a class="btn btn-sm" href="' + base + '/post/' + Number(p.id) + '/edit">编辑</a>' : '') +
      report + '</div>' +
    '</div></li>';
}

/** 主题详情：楼层列表 + 回复框；站长在页内就能通过 / 下架 / 置顶 / 锁定 */
export function forumThreadPage({ origin, user = null, thread, forum = null, posts = [], page = 1, pages = 1, total = 0, base = '/forum', gate = null, error = '', notice = '', form = null, replyTo = null }) {
  const isAdmin = !!user && user.role === 'admin';
  const locked = Number(thread.locked) === 1;
  const adminBar = isAdmin
    ? '<div class="forum-adminbar">' +
      fpill(thread.status, FT_STATUS) +
      '<form class="inline" method="post" action="/forum/admin/threads/' + Number(thread.id) + '/status">' +
      '<input type="hidden" name="status" value="1"><button class="btn btn-sm ok" type="submit">✅ 通过</button></form>' +
      '<form class="inline" method="post" action="/forum/admin/threads/' + Number(thread.id) + '/status">' +
      '<input type="hidden" name="status" value="2"><button class="btn btn-sm danger" type="submit">✖ 下架</button></form>' +
      '<form class="inline" method="post" action="/forum/admin/threads/' + Number(thread.id) + '/flags">' +
      '<input type="hidden" name="pinned" value="' + (Number(thread.pinned) ? '0' : '1') + '">' +
      '<button class="btn btn-sm" type="submit">' + (Number(thread.pinned) ? '取消置顶' : '📌 置顶') + '</button></form>' +
      '<form class="inline" method="post" action="/forum/admin/threads/' + Number(thread.id) + '/flags">' +
      '<input type="hidden" name="locked" value="' + (locked ? '0' : '1') + '">' +
      '<button class="btn btn-sm" type="submit">' + (locked ? '🔓 解锁' : '🔒 锁定') + '</button></form></div>'
    : '';
  const replyBox = locked && !isAdmin
    ? '<p class="forum-gate">🔒 这个主题已被站长锁定，不能再回复</p>'
    : !user
      ? gateBox({ error: 'login' }, base, '/t/' + Number(thread.id))
      : (gate && !gate.ok)
        ? gateBox(gate, base, '/t/' + Number(thread.id))
        : '<form class="fpost-form" id="reply" method="post" action="' + base + '/t/' + Number(thread.id) + '/reply">' +
          antispamFields(form || {}) +
          '<input type="hidden" name="parent_id" value="' + (replyTo ? Number(replyTo.id) : 0) + '">' +
          (replyTo ? '<p class="dim">正在回复' + (Number(replyTo.floor) ? ' #' + Number(replyTo.floor) + ' 楼' : '') + ' @' + esc(replyTo.name || '') +
            '（<a href="' + base + '/t/' + Number(thread.id) + '#reply">取消</a>）</p>' : '') +
          '<label>回复<textarea name="body" rows="5" maxlength="3000" required placeholder="友善发言；广告、刷屏、人身攻击会被下架，严重者封禁"></textarea></label>' +
          '<button class="btn ok" type="submit">发表回复</button></form>';
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <a href="${base}/f/${encodeURIComponent(forum ? forum.slug : '')}">${esc(forum ? forum.name : '板块')}</a> › <span>${esc(thread.title)}</span></nav>
  <article class="fthread">
    <h1>${Number(thread.pinned) ? '📌 ' : ''}${locked ? '🔒 ' : ''}${esc(thread.title)}</h1>
    <p class="fthread-meta">${esc(thread.name || thread.username || '—')} · ${ftime(thread.created_at)} · ${fmtNum(thread.view_count)} 浏览 · ${fmtNum(thread.reply_count)} 回复</p>
    ${adminBar}
    ${notice ? '<p class="forum-notice">' + esc(notice) + '</p>' : ''}
    ${error ? '<p class="auth-err">' + esc(error) + '</p>' : ''}
    <ul class="fpost-list">${posts.map((p) => forumPostItem(p, { user, base })).join('') || '<li class="cmt-empty">还没有内容</li>'}</ul>
    ${forumPager(base, '/t/' + Number(thread.id), page, pages, '')}
    <section class="sec" id="reply-wrap"><div class="sec-head"><h2>回复</h2><span class="more">共 ${fmtNum(total)} 条</span></div>${replyBox}</section>
  </article>
</div>`;
  return layout({ origin, user, title: thread.title, description: excerpt(thread.title + ' — ' + (thread.body || ''), 140), path: base + '/t/' + thread.id, content });
}

/** 发新帖 */
export function forumNewPage({ origin, user = null, forums = [], forumSlug = '', error = '', values = {}, form = null, gate = null, base = '/forum' }) {
  const v = (k) => esc(values[k] || '');
  const opts = forums.map((f) => '<option value="' + esc(f.slug) + '"' + (f.slug === forumSlug ? ' selected' : '') + '>' +
    esc(f.icon || '') + ' ' + esc(f.name) + '</option>').join('');
  const body = !user
    ? gateBox({ error: 'login' }, base, '/new')
    : (gate && !gate.ok)
      ? gateBox(gate, base, '/new')
      : `<form class="fpost-form" method="post" action="${base}/new">
    ${antispamFields(form || {})}
    <label>板块<select name="forum">${opts}</select></label>
    <label>标题<input name="title" value="${v('title')}" required maxlength="80" placeholder="一句话说清楚问题或话题"></label>
    <label>正文<textarea name="body" rows="10" maxlength="3000" required placeholder="把情况说清楚，方便别人帮你">${v('body')}</textarea></label>
    ${error ? '<p class="auth-err">' + esc(error) + '</p>' : ''}
    <button class="btn ok" type="submit">发布主题</button>
    <p class="dim">新账号的前 3 帖会先进入待审队列，站长通过后公开。提交即表示同意<a href="/terms">用户协议</a>，请勿发布违法或广告内容。</p>
  </form>`;
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <span>发新帖</span></nav>
  <h1>✏️ 发新帖</h1>
  ${body}
</div>`;
  return layout({ origin, user, title: '发新帖', description: '在论坛发布新主题', path: base + '/new', content });
}

/** 编辑楼层：非站长的编辑会重新进入待审队列，改动留痕 */
export function forumEditPage({ origin, user = null, post, thread = null, error = '', form = null, base = '/forum' }) {
  const body = `<form class="fpost-form" method="post" action="${base}/post/${Number(post.id)}/edit">
    ${antispamFields(form || {})}
    <label>正文<textarea name="body" rows="12" maxlength="3000" required>${esc(post.body || '')}</textarea></label>
    ${error ? '<p class="auth-err">' + esc(error) + '</p>' : ''}
    <button class="btn ok" type="submit">保存修改</button>
    <p class="dim">只有自己能编辑自己的帖子，站长能看到全部历史版本。<b>普通用户编辑后这条会重新进入待审队列</b>，站长确认后才会再公开。</p>
  </form>`;
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <a href="${base}/t/${Number(post.thread_id)}">${esc(thread ? thread.title : '返回主题')}</a> › <span>编辑</span></nav>
  <h1>✏️ 编辑${Number(post.floor) ? ' #' + Number(post.floor) + ' 楼' : '帖子'}</h1>
  ${body}
</div>`;
  return layout({ origin, user, title: '编辑帖子', description: '编辑论坛帖子', path: base + '/post/' + post.id + '/edit', content });
}

/** 论坛管理页：待审主题 / 待审回复 / 举报 / 黑名单 / 禁言，都在这一页 */
export function forumAdminPage({ origin, user, stats = {}, pendingThreads = [], pendingPosts = [], reports = [], blacklist = [], muted = [], notice = '' }) {
  const thRow = (t) => '<tr><td><b>' + esc(t.title) + '</b><br><small class="dim">' +
    esc(t.forum_name || '') + ' · ' + esc(t.name || t.username || '—') + ' · ' + ftime(t.created_at) + '</small><br><small class="dim">' +
    esc(excerpt(t.body || '', 90)) + '</small></td><td class="act">' +
    '<a class="btn btn-sm" href="/forum/t/' + Number(t.id) + '" target="_blank" rel="noopener">预览</a>' +
    '<form class="inline" method="post" action="/forum/admin/threads/' + Number(t.id) + '/status"><input type="hidden" name="status" value="1"><button class="btn btn-sm ok" type="submit">✅ 通过</button></form>' +
    '<form class="inline" method="post" action="/forum/admin/threads/' + Number(t.id) + '/status"><input type="hidden" name="status" value="2"><button class="btn btn-sm danger" type="submit">✖ 拒绝</button></form>' +
    '</td></tr>';
  const pRow = (p) => '<tr><td><b>' + esc(p.thread_title || '（主题已删）') + '</b><br><small class="dim">' +
    esc(p.name || p.username || '—') + ' · ' + ftime(p.created_at) + '</small><br><small class="dim">' +
    esc(excerpt(p.body || '', 90)) + '</small></td><td class="act">' +
    '<form class="inline" method="post" action="/forum/admin/posts/' + Number(p.id) + '/status"><input type="hidden" name="status" value="1"><button class="btn btn-sm ok" type="submit">✅ 通过</button></form>' +
    '<form class="inline" method="post" action="/forum/admin/posts/' + Number(p.id) + '/status"><input type="hidden" name="status" value="2"><button class="btn btn-sm danger" type="submit">✖ 隐藏</button></form>' +
    '</td></tr>';
  const rRow = (r) => '<tr><td><b>' + esc(FR_LABEL[r.reason] || r.reason) + '</b> <small class="dim">' +
    esc(r.target_type === 'thread' ? '主题' : '回复') + '</small><br><small class="dim">' + esc(r.thread_title || '') +
    (r.thread_id ? ' · <a href="/forum/t/' + Number(r.thread_id) + '" target="_blank" rel="noopener">去看</a>' : '') +
    '</small><br><small class="dim">' + esc(excerpt(r.target_text || '', 80)) + '</small>' +
    (r.detail ? '<br><small class="dim">补充：' + esc(excerpt(r.detail, 80)) + '</small>' : '') +
    '</td><td>' + esc(r.reporter || '—') + '<br><small class="dim">' + ftime(r.created_at) + '</small></td><td class="act">' +
    '<form class="inline" method="post" action="/forum/admin/reports/' + Number(r.id) + '/status"><input type="hidden" name="status" value="1"><button class="btn btn-sm ok" type="submit">已处理</button></form>' +
    '<form class="inline" method="post" action="/forum/admin/reports/' + Number(r.id) + '/status"><input type="hidden" name="status" value="2"><button class="btn btn-sm" type="submit">忽略</button></form>' +
    '</td></tr>';
  const bRow = (b) => '<tr><td><code>' + esc(b.pattern) + '</code></td><td>' + (b.kind === 'regex' ? '正则' : '关键词') + '</td>' +
    '<td>' + (b.action === 'reject' ? '<span class="pill f2">直接拒绝</span>' : '<span class="pill f0">转人工待审</span>') + '</td>' +
    '<td><small class="dim">' + esc(b.note || '') + '</small></td><td class="act">' +
    '<form class="inline" method="post" action="/forum/admin/blacklist/' + Number(b.id) + '/delete"><button class="btn btn-sm danger" type="submit">删除</button></form></td></tr>';
  const mRow = (m) => '<tr><td><b>' + esc(m.display_name || m.username) + '</b><br><small class="dim">@' + esc(m.username) + '</small></td>' +
    '<td><small class="dim">' + esc(m.mute_reason || '') + '</small></td><td>' + ftime(m.muted_until) + '</td><td class="act">' +
    '<form class="inline" method="post" action="/forum/admin/users/' + Number(m.id) + '/mute"><input type="hidden" name="minutes" value="0"><button class="btn btn-sm ok" type="submit">解除禁言</button></form></td></tr>';
  const table = (head, rows, empty) => rows
    ? '<table class="tbl"><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>'
    : '<p class="cmt-empty">' + esc(empty) + '</p>';
  const content = `<div class="wrap">
  <h1>🛡 论坛管理</h1>
  <p class="dim">待审主题 ${fmtNum(stats.pendingThreads)} · 待审回复 ${fmtNum(stats.pendingPosts)} · 待处理举报 ${fmtNum(stats.reports)} · 板块 ${fmtNum(stats.forums)} · 主题 ${fmtNum(stats.threads)} · 回复 ${fmtNum(stats.posts)} · 今日新增 ${fmtNum(stats.today)} · 被禁言 ${fmtNum(stats.muted)}</p>
  ${notice ? '<p class="forum-notice">' + esc(notice) + '</p>' : ''}
  <p><a class="btn" href="/forum">← 回论坛</a> <a class="btn" href="/admin">→ 站点后台</a></p>
  <section class="sec"><div class="sec-head"><h2>待审主题</h2></div>${table(['内容', '操作'], pendingThreads.map(thRow), '没有待审主题')}</section>
  <section class="sec"><div class="sec-head"><h2>待审回复</h2></div>${table(['内容', '操作'], pendingPosts.map(pRow), '没有待审回复')}</section>
  <section class="sec"><div class="sec-head"><h2>待处理举报</h2></div>${table(['被举报内容', '举报人', '操作'], reports.map(rRow), '没有待处理举报')}</section>
  <section class="sec"><div class="sec-head"><h2>关键词 / 正则黑名单</h2></div>
    <form class="auth-form wide fbl" method="post" action="/forum/admin/blacklist">
      <div class="row2">
        <label>内容<select name="kind"><option value="word">关键词（含到就命中）</option><option value="regex">正则表达式</option></select></label>
        <label>命中后<select name="action"><option value="review">转人工待审</option><option value="reject">直接拒绝</option></select></label>
      </div>
      <label>匹配内容 / 表达式<input name="pattern" required maxlength="120" placeholder="如 加微信 或 (加|＋)\s*微信"></label>
      <label>备注<input name="note" maxlength="120" placeholder="为什么加这条（可选）"></label>
      <button class="btn ok" type="submit">加入黑名单</button>
    </form>
    ${table(['规则', '类型', '命中后', '备注', '操作'], blacklist.map(bRow), '还没有黑名单规则')}
  </section>
  <section class="sec"><div class="sec-head"><h2>被禁言的用户</h2></div>
    <form class="auth-form wide fbl" method="post" action="/forum/admin/users/mute">
      <div class="row2">
        <label>用户名<input name="username" required maxlength="32" placeholder="要禁言谁（填用户名）"></label>
        <label>时长<select name="minutes"><option value="60">1 小时</option><option value="1440">1 天</option><option value="10080" selected>7 天</option><option value="43200">30 天</option></select></label>
      </div>
      <label>理由<input name="reason" maxlength="80" placeholder="如：刷屏发广告"></label>
      <button class="btn danger" type="submit">禁言</button>
      <p class="dim">禁言只是不能发主题和回复，仍可浏览；封禁请到<a href="/admin">站点后台</a>（封禁会让登录立即失效）。</p>
    </form>
    ${table(['用户', '理由', '解禁时间', '操作'], muted.map(mRow), '没有正在被禁言的用户')}
  </section>
</div>`;
  return layout({ origin, user, title: '论坛管理', description: '论坛审核后台', path: '/forum/admin', content, noindex: true });
}
