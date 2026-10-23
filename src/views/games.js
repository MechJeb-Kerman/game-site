import { BOARD_UNIT, CHANGELOG, CHANGELOG_GENERATED, CHANGELOG_TOTAL, HINTS, SITE, STATIC_MODE, coverFor, esc, excerpt, fmtNum, footer, gameCard, gameGrid, gameJsonLd, groupedSites, header, isUploadedUrl, layout, moveTag, noticeBanner, section, siteUrl, trendTag, websiteJsonLd } from './core.js';

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
            '<img src="' + esc((coverFor(r.slug) || {}).src || '/cover/' + r.slug + '.svg') + '" alt="" loading="lazy" decoding="async" width="120" height="75"></a>' +
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

/* 升温 / 降温：今日播放相对「前两天的日均」的涨跌标签 */
export function hotPage({ origin, user = null, rows = [], updatedAt = '', windowLabel = '' }) {
  const body = rows.length
    ? '<ol class="rk-list">' + rows.map((r, i) => {
        const rank = i + 1;
        const sub = [r.category ? r.category.name : '小游戏',
          Number(r.rating_count) ? '⭐ ' + Number(r.rating).toFixed(1) : '未评',
          fmtNum(r.plays) + ' 次游玩'].join(' · ');
        return '<li class="rk-row">' +
          '<span class="rk-no n' + Math.min(3, rank) + '">' + rank + '</span>' +
          '<a class="rk-cover" href="/game/' + esc(r.slug) + '" tabindex="-1" aria-hidden="true" style="--a:' + esc(r.accent || '#6366f1') + ';--b:' + esc(r.accent2 || '#8b5cf6') + '">' +
            '<img src="' + esc((coverFor(r.slug) || {}).src || '/cover/' + r.slug + '.svg') + '" alt="" loading="lazy" decoding="async" width="120" height="75"></a>' +
          '<span class="rk-body"><a class="rk-title" href="/game/' + esc(r.slug) + '">' + esc(r.emoji || '🎮') + ' ' + esc(r.title) + '</a>' +
            '<small class="dim">' + sub + '</small>' +
            '<small class="dim hot-win">今日 ' + fmtNum(r.p1) + ' · 3 日 ' + fmtNum(r.p3) + ' · 7 日 ' + fmtNum(r.p7) + '</small></span>' +
          '<span class="rk-val"><b>' + fmtNum(r.p1) + '</b><small>今日</small></span>' +
          trendTag(r.trend) +
        '</li>';
      }).join('') + '</ol>'
    : '<p class="empty">今天还没人玩，去 <a href="/games">全部游戏</a> 挑一款开个头吧 🎮</p>';

  const content = '<div class="wrap page">' +
    '<nav class="crumb"><a href="/">首页</a><span>›</span><b>热度榜</b></nav>' +
    '<div class="page-head"><h1>🔥 热度榜</h1>' +
      '<p class="page-sub">' + esc(windowLabel || '按今日 / 近 3 天 / 近 7 天播放量加权，每分钟重算一次') + '</p>' +
      '<p class="page-count">共 <b>' + rows.length + '</b> 款在榜' + (updatedAt ? ' · 更新于 ' + esc(updatedAt) : '') + '</p></div>' +
    body +
    '<p class="rank-note">热度分 = 动量（今日 ×3、近 3 天 ×1.5、近 7 天 ×1）+ 评分质量（好评率 × 对数样本量）+ 历史播放（对数）× 上架衰减（半衰期 90 天）。' +
      '不同口径的榜单见 <a href="/rank">排行榜</a>。</p>' +
    '</div>';

  return layout({
    origin, user, title: '热度榜 - 实时热门小游戏', description: '按今日、近 3 天、近 7 天播放量加权的实时小游戏热度榜',
    path: '/hot', content,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: '热度榜',
      url: origin + '/hot',
      itemListElement: rows.slice(0, 10).map((r, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: origin + '/game/' + r.slug,
        name: r.title
      }))
    }
  });
}

export function homePage({ origin, featured, hot, newest, categories, tags, stats, user = null, notice = null }) {
  const ld = websiteJsonLd({ origin, name: SITE.name, description: SITE.tagline });

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
          <img src="${esc((coverFor(featured.slug) || {}).src || '/cover/' + featured.slug + '.svg')}" alt="" width="420" height="262">
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
export const REPORT_REASONS = [['spam', '垃圾广告'], ['abuse', '辱骂攻击'], ['spoiler', '剧透'], ['other', '其他']];
export const REPORT_LABEL = Object.fromEntries(REPORT_REASONS);

/** 评论正文 + 回复 / 举报操作条。举报用原生 form，禁用 JS 也能提交 */
export function cmtActions(id, path, user) {
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
export function commentItem(c, { user, path }) {
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
export function commentPanel({ thread, total = 0, user = null, path, slug, endpoint, loginHref, notice = '', heading = '玩家评论', empty = '还没有人评论，来抢沙发 🛋️' }) {
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

export function gamePage({ origin, game, related, myStars = 0, user = null, favorited = false, favCount = 0, comments = [], commentTotal = 0, thread = null, preview = false, cmtNotice = '', watch = '', replay = '' }) {
  const path = '/game/' + game.slug;
  const votes = Number(game.rating_count) || 0;
  // schema.org 要求 ratingCount >= 1，没人评分时宁可不带这个字段，也不造数（判定在 seo.js 里）
  const ld = gameJsonLd(game, origin);

  const tagLinks = game.tags
    .map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('');

  // ?watch=观战钥匙 / ?replay=棋谱 id 由 net-play.js 在 iframe 内自动接管，这里只负责把参数透传进去
  const extra = watch ? '?watch=' + encodeURIComponent(watch) : replay ? '?replay=' + encodeURIComponent(replay) : '';
  const frameUrl = game.game_url + extra;
  const hint = HINTS[game.slug] || '支持键盘与触屏操作，点击全屏获得最佳体验';
  // 横屏比例的游戏在手机竖屏下会被压得很扁，提示用户点全屏转横屏
  const isWideGame = Number(game.width) > Number(game.height);

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
      <div class="player${isWideGame ? ' player--wide' : ''}" id="player" data-slug="${esc(game.slug)}" data-url="${esc(game.game_url)}" style="--a:${esc(game.accent)}">
        <div class="player-bar">
          <button class="btn" data-act="fullscreen" type="button">⛶ 全屏</button>
          <button class="btn" data-act="reload" type="button">↻ 重开</button>
          <a class="btn" href="${esc(game.game_url)}" target="_blank" rel="noopener noreferrer">↗ 新窗口</a>
          ${STATIC_MODE ? '' : '<button class="btn fav" id="favBtn" type="button" data-slug="' + esc(game.slug) + '" data-on="' + (favorited ? 1 : 0) + '" aria-pressed="' + favorited + '">' + (favorited ? '♥ 已收藏' : '♡ 收藏') + ' <b id="favCount">' + favCount + '</b></button>'}
          ${STATIC_MODE ? '' : '<span class="player-views">🔥 已玩 <b id="playCount">' + fmtNum(game.plays) + '</b> 次</span>'}
        </div>
        <div class="player-stage" id="stage" style="--ar:${game.width}/${game.height}">
          <iframe id="gameFrame"
                  src="${esc(frameUrl)}"
                  title="${esc(game.title)} 在线玩"
                  sandbox="${ugcHtml ? 'allow-scripts allow-pointer-lock allow-orientation-lock' : 'allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock allow-popups'}"
                  allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope"
                  loading="eager" referrerpolicy="no-referrer"></iframe>
        </div>
        ${isWideGame ? '<p class="rot-tip">📱 横屏更好玩：点「全屏」后把手机横过来</p>' : ''}
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

  return layout({ origin, user, title: game.title + ' - 在线玩', description: game.description, path, content, jsonLd: ld, bodyClass: 'pg-game' });
}

/* ---------- 公告 ---------- */

/** 公告分页导航（列表页用） */
export function noticePager(page, pages) {
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

/** fishport.cn 的门户：所有子域的一页导航。
    数据是 src/sites.js 那份清单，三条线（Express / Workers+D1 / 静态导出）共用。
    走 chrome:'none' 自带页头页脚——这一页挂的是 fishport.cn 的牌子，套游戏站的搜索框与分类导航
    只会让人以为走错了地方。 */
export function portalPage({ origin = '', user = null }) {
  const groups = groupedSites();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const cards = groups.map((g) => {
    const items = g.items.map((s) =>
      '<li class="pf-item" style="--a:' + esc(s.accent || '#6366f1') + ';--b:' + esc(s.accent2 || '#8b5cf6') + '">' +
        '<a class="pf-link" href="' + esc(siteUrl(s)) + '" target="_blank" rel="noopener">' +
          '<span class="pf-ico" aria-hidden="true">' + esc(s.emoji || '🌐') + '</span>' +
          '<span class="pf-body">' +
            '<span class="pf-name">' + esc(s.name) + '</span>' +
            '<span class="pf-host">' + esc(s.host) + '</span>' +
            '<span class="pf-desc">' + esc(s.desc || '') + '</span>' +
          '</span>' +
          '<span class="pf-go" aria-hidden="true">↗</span>' +
        '</a>' +
      '</li>').join('');
    return '<section class="pf-group">' +
      '<div class="sec-head"><h2>' + esc(g.group) + '</h2><span class="dim">' + g.items.length + ' 个</span></div>' +
      '<ul class="pf-list">' + items + '</ul>' +
    '</section>';
  }).join('');

  const content = '<div class="pf">' +
  '<header class="pf-hdr"><div class="wrap pf-hdr-in">' +
    '<a class="pf-logo" href="/"><span aria-hidden="true">🐟</span><b>fishport.cn</b></a>' +
    '<nav class="pf-nav" aria-label="常用入口">' +
      '<a href="https://game-site.fishport.cn/">趣玩小游戏</a>' +
      '<a href="https://forum.fishport.cn/">论坛</a>' +
      '<a href="/nav">导航</a>' +
    '</nav>' +
  '</div></header>' +
  '<div class="wrap pf-hero">' +
    '<h1>🐟 fishport.cn 导航</h1>' +
    '<p class="pf-sub">这个域名下能打开的东西都在这里：共 ' + total + ' 个站点，点卡片直接过去。</p>' +
  '</div>' +
  '<div class="wrap pf-main">' + cards +
    '<p class="pf-note">邮件（send / rsend）与 Minecraft（mc）这类只给程序用的解析记录不在这里。<br>' +
    '要加一个，改仓库 <code>src/sites.js</code> 的清单，三条线一起生效。</p>' +
  '</div>' +
  '<footer class="pf-ftr"><div class="wrap">' +
    '<p class="ftr-note">' + esc(SITE.name) + ' · ' + esc(SITE.tagline) + '</p>' +
    '<p class="ftr-links"><a href="/privacy">隐私政策</a><span>·</span><a href="/terms">用户协议</a>' +
      '<span>·</span><a href="/changelog">更新说明</a></p>' +
  '</div></footer>' +
  '</div>';

  return layout({
    origin, user, chrome: 'none', titleSuffix: false,
    title: 'fishport.cn 导航',
    description: 'fishport.cn 的站点导航：小游戏、论坛、DSH、政务平台、学习与个人主页一页直达',
    path: '/nav', content,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'fishport.cn 导航',
      url: origin + '/nav',
      itemListElement: groups.reduce((acc, g) => acc.concat(g.items), []).map((s, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: s.name,
        url: siteUrl(s)
      }))
    }
  });
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

export const STATUS_LABEL = { 0: '已下架', 1: '已上架', 2: '待审核' };
