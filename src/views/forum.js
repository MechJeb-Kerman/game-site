import { SITE, esc, excerpt, fmtNum, layout, section } from './core.js';
import { FP_STATUS, FR_LABEL, FT_STATUS } from './admin.js';

export function ftime(v) {
  return esc(String(v || '').slice(0, 16));
}

export function ftext(body) {
  return esc(body).replace(/\r?\n/g, '<br>');
}

/** 附件大小：B / KB / MB（KB 起保留一位小数） */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 附件列表（第二轮）：没有附件时返回空串，保证旧调用的输出逐字节不变 */
export function fattachList(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '';
  return '<ul class="fattach-list">' + arr.map((a) =>
    '<li>📎 <a href="/ugc/a/' + encodeURIComponent(String(a && a.id != null ? a.id : '')) + '">' +
    esc((a && a.filename) || '附件') + '</a> <small class="dim">(' + fmtSize(a && a.bytes) + ')</small></li>').join('') +
    '</ul>';
}

/** 主题标签 chips：href 由调用方给（列表页用相对链接，详情页指向板块首页） */
export function ftagChips(tags, href) {
  const arr = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!arr.length) return '';
  return '<span class="ftags">' + arr.map((tag) =>
    '<a class="tagchip" href="' + href(String(tag)) + '">#' + esc(tag) + '</a>').join('') + '</span>';
}

export function fpill(status, map) {
  return '<span class="pill f' + Number(status) + '">' + esc(map[Number(status)] || '未知') + '</span>';
}

/** 论坛分页：基址与查询串由调用方给，两种挂载路径共用一个实现 */
export function forumPager(base, path, page, pages, qs = '') {
  if (pages <= 1) return '';
  const href = (p) => base + path + '?page=' + p + (qs ? '&' + qs : '');
  return '<nav class="pager" aria-label="分页">' +
    (page > 1 ? '<a class="pg" href="' + esc(href(page - 1)) + '" rel="prev">‹ 上一页</a>' : '<span class="pg off">‹ 上一页</span>') +
    '<span class="pg-info">' + page + ' / ' + pages + ' 页</span>' +
    (page < pages ? '<a class="pg" href="' + esc(href(page + 1)) + '" rel="next">下一页 ›</a>' : '<span class="pg off">下一页 ›</span>') +
  '</nav>';
}

/** 人机校验：一次性令牌（服务端签发、一人一用、30 分钟过期）+ 蜜罐字段 */
export function antispamFields(form = {}) {
  return '<input type="hidden" name="form_token" value="' + esc(form.token || '') + '">' +
    '<div class="hp" aria-hidden="true" hidden><label>网址（这一栏请留空）' +
    '<input type="text" name="' + esc(form.honeypot || 'website') + '" tabindex="-1" autocomplete="off"></label></div>';
}

/** 不能发帖时给一句话说明，并把去路指清楚 */
export function gateBox(gate, base, next) {
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

export function threadItem(t, base) {
  return '<li class="thr' + (Number(t.pinned) ? ' pinned' : '') + '">' +
    '<a class="thr-link" href="' + base + '/t/' + Number(t.id) + '">' +
      '<span class="thr-title">' + (Number(t.pinned) ? '📌 ' : '') + (Number(t.locked) ? '🔒 ' : '') + (t.featured ? '⭐ ' : '') + esc(t.title) + '</span>' +
      '<span class="thr-meta">' + esc(t.forum_name || '') + ' · ' + esc(t.name || t.username || '—') + ' · ' + ftime(t.last_reply_at || t.created_at) +
      ' · ' + fmtNum(t.reply_count) + ' 回复 · ' + fmtNum(t.view_count) + ' 浏览</span>' +
    '</a>' +
    (Number(t.status) !== 1 ? fpill(t.status, FT_STATUS) : '') +
    ftagChips(t.tags, (tag) => '?tag=' + encodeURIComponent(tag)) +
    '</li>';
}

/** 论坛首页：板块导航 + 最新主题 + 搜索 */
export function forumHomePage({ origin, user = null, forums = [], threads = [], stats = {}, q = '', page = 1, pages = 1, total = 0, base = '/forum', notice = '', tag = '' }) {
  const tagBar = tag ? '\n    <div class="ftagbar">标签：<b>#' + esc(tag) + '</b> <a href="' + base + '/">清除</a></div>' : '';
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
    <h1>💬 论坛</h1>${tagBar}
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
export function forumBoardPage({ origin, user = null, forum, threads = [], q = '', page = 1, pages = 1, total = 0, base = '/forum', tag = '' }) {
  const tagBar = tag ? '\n    <div class="ftagbar">标签：<b>#' + esc(tag) + '</b> <a href="' + base + '/f/' + encodeURIComponent(forum.slug) + '">清除</a></div>' : '';
  const list = threads.length
    ? '<ul class="thr-list">' + threads.map((t) => threadItem(t, base)).join('') + '</ul>' +
      forumPager(base, '/f/' + encodeURIComponent(forum.slug), page, pages, q ? 'q=' + encodeURIComponent(q) : '')
    : '<p class="cmt-empty">这个板块还没有主题，来发第一帖吧</p>';
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <span>${esc(forum.name)}</span></nav>
  <div class="forum-head">
    <h1>${esc(forum.icon || '💬')} ${esc(forum.name)}</h1>${tagBar}
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
export function forumPostItem(p, { user, base }) {
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
      (Array.isArray(p.attachments) && p.attachments.length ? '<div class="fattach">' + fattachList(p.attachments) + '</div>' : '') +
      '<div class="fp-act">' + (pending ? fpill(p.status, FP_STATUS) : '') +
      (!pending ? '<a class="btn btn-sm" href="' + base + '/t/' + Number(p.thread_id || 0) + '?reply=' + Number(p.id) + '#reply">回复</a>' : '') +
      (mine || isAdmin ? '<a class="btn btn-sm" href="' + base + '/post/' + Number(p.id) + '/edit">编辑</a>' : '') +
      report + '</div>' +
    '</div></li>';
}

/** 主题详情：楼层列表 + 回复框；站长在页内就能通过 / 下架 / 置顶 / 锁定 */
export function forumThreadPage({ origin, user = null, thread, forum = null, posts = [], page = 1, pages = 1, total = 0, base = '/forum', gate = null, error = '', notice = '', form = null, replyTo = null }) {
  const isMod = !!user && (user.role === 'admin' || user.role === 'mod');
  const locked = Number(thread.locked) === 1;
  const threadTags = Array.isArray(thread.tags) ? thread.tags.filter(Boolean) : [];
  const threadAtts = Array.isArray(thread.attachments) ? thread.attachments : [];
  const tagsLine = threadTags.length
    ? '\n    <div class="ftags">' + threadTags.map((tag) => '<a class="tagchip" href="' + base + '/?tag=' + encodeURIComponent(tag) + '">#' + esc(tag) + '</a>').join('') + '</div>'
    : '';
  const attachLine = threadAtts.length ? '\n    ' + fattachList(threadAtts) : '';
  const adminBar = isMod
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
      '<button class="btn btn-sm" type="submit">' + (locked ? '🔓 解锁' : '🔒 锁定') + '</button></form>' +
      '<form class="inline" method="post" action="/forum/admin/threads/' + Number(thread.id) + '/flags">' +
      '<input type="hidden" name="featured" value="' + (thread.featured ? '0' : '1') + '">' +
      '<button class="btn btn-sm" type="submit">' + (thread.featured ? '取消精华' : '⭐ 设为精华') + '</button></form></div>'
    : '';
  const replyBox = locked && !isMod
    ? '<p class="forum-gate">🔒 这个主题已被站长锁定，不能再回复</p>'
    : !user
      ? gateBox({ error: 'login' }, base, '/t/' + Number(thread.id))
      : (gate && !gate.ok)
        ? gateBox(gate, base, '/t/' + Number(thread.id))
        // data-offline：断网时由 /static/js/offline-wire.js 接管，先入队、联网后自动补传
        : '<form class="fpost-form" id="reply" method="post" enctype="multipart/form-data" data-offline="这条回复" action="' + base + '/t/' + Number(thread.id) + '/reply">' +
          antispamFields(form || {}) +
          '<span class="dim" data-offline-note hidden></span>' +
          '<input type="hidden" name="parent_id" value="' + (replyTo ? Number(replyTo.id) : 0) + '">' +
          (replyTo ? '<p class="dim">正在回复' + (Number(replyTo.floor) ? ' #' + Number(replyTo.floor) + ' 楼' : '') + ' @' + esc(replyTo.name || '') +
            '（<a href="' + base + '/t/' + Number(thread.id) + '#reply">取消</a>）</p>' : '') +
          '<label>回复<textarea name="body" rows="5" maxlength="3000" required placeholder="友善发言；广告、刷屏、人身攻击会被下架，严重者封禁"></textarea></label>' +
          '<label>附件<input type="file" name="files" multiple accept="image/*,.txt,.md,.json,.zip"></label>' +
          '<button class="btn ok" type="submit">发表回复</button></form>';
  const content = `<div class="wrap forum">
  <nav class="crumb"><a href="${base}/">论坛</a> › <a href="${base}/f/${encodeURIComponent(forum ? forum.slug : '')}">${esc(forum ? forum.name : '板块')}</a> › <span>${esc(thread.title)}</span></nav>
  <article class="fthread">
    <h1>${Number(thread.pinned) ? '📌 ' : ''}${locked ? '🔒 ' : ''}${thread.featured ? '⭐ ' : ''}${esc(thread.title)}</h1>
    <p class="fthread-meta">${esc(thread.name || thread.username || '—')} · ${ftime(thread.created_at)} · ${fmtNum(thread.view_count)} 浏览 · ${fmtNum(thread.reply_count)} 回复</p>${tagsLine}${attachLine}
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
      : `<form class="fpost-form" method="post" enctype="multipart/form-data" data-offline="这个主题" action="${base}/new">
    <span class="dim" data-offline-note hidden></span>
    ${antispamFields(form || {})}
    <label>板块<select name="forum">${opts}</select></label>
    <label>标题<input name="title" value="${v('title')}" required maxlength="80" placeholder="一句话说清楚问题或话题"></label>
    <label>正文<textarea name="body" rows="10" maxlength="3000" required placeholder="把情况说清楚，方便别人帮你">${v('body')}</textarea></label>
    <label>标签<input name="tags" maxlength="64" placeholder="最多 3 个，逗号分隔，例如 攻略,求助" value="${v('tags')}"></label>
    <label>附件<input type="file" name="files" multiple accept="image/*,.txt,.md,.json,.zip"></label>
    <p class="dim">单个文件最大 4 MB；Worker 线上限 256 KB。</p>
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
  // 标签是主题级字段：编辑楼层的输入框只为展示与回传，实际写入由路由决定
  const rawTags = post.tags && (Array.isArray(post.tags) ? post.tags.length : true) ? post.tags : (thread ? thread.tags : '');
  const tagValue = Array.isArray(rawTags) ? rawTags.filter(Boolean).join(',') : String(rawTags || '');
  const body = `<form class="fpost-form" method="post" enctype="multipart/form-data" action="${base}/post/${Number(post.id)}/edit">
    ${antispamFields(form || {})}
    <label>正文<textarea name="body" rows="12" maxlength="3000" required>${esc(post.body || '')}</textarea></label>
    <label>标签<input name="tags" maxlength="64" placeholder="最多 3 个，逗号分隔，例如 攻略,求助" value="${esc(tagValue)}"></label>
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
  <p><a class="btn" href="/forum">← 回论坛</a> <a class="btn" href="/forum/admin/attachments">🖼 附件审核</a> <a class="btn" href="/admin">→ 站点后台</a></p>
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

/* ---------- 附件审核（第十四批） ---------- */

/** 审核状态 / 来源 → 人话 */
export const ATTACH_REVIEW_LABEL = { pending: '待审', approved: '已通过', rejected: '已拒绝' };
export const ATTACH_SOURCE_LABEL = { auto: '自动规则', manual: '人工', classifier: '分类器' };
/** 回跳提示：只认识自己这几个码，别的码按「没成功」显示（不把任意文本照到页面上） */
export const ATTACH_OK_MSG = { done: '✅ 处理好了。', auto: '🤖 自动规则跑完一遍，拿不准的都留在待审队列里。' };
export const ATTACH_ERR_MSG = {
  not_found: '这条附件不在了',
  reason_required: '拒绝要填一个理由',
  forbidden: '当前账号没有审核权限',
  bad_action: '动作不对，请用页面上的按钮',
  default: '这次操作没成功，稍后再试'
};

/**
 * 附件审核页：图片 / 文件的人工复核队列。
 * 数据来自 src/attachments.js 的 listPending / listRejected / moderationStats（Worker 线同名同形）。
 * 口径：拒绝 = 软删 + 隐藏（记录留着，能翻案）；待审不影响展示。
 */
export function attachAdminPage({ origin, user, stats = {}, pending = {}, rejected = {}, ok = '', err = '' }) {
  const itemsOf = (box) => (box && Array.isArray(box.items) ? box.items : []);
  const okMsg = ATTACH_OK_MSG[String(ok || '')] || '';
  const errMsg = ATTACH_ERR_MSG[String(err || '')] || (err ? ATTACH_ERR_MSG.default : '');
  const thumb = (a) => {
    const id = Number(a.id) || 0;
    if (String(a.mime || '').indexOf('image/') !== 0) return '<span class="dim">📎 不是图片</span>';
    if (String(a.status || '') === 'deleted') return '<span class="dim">（已隐藏，没法预览）</span>';
    return '<a href="/ugc/a/' + id + '" target="_blank" rel="noopener"><img src="/ugc/a/' + id +
      '" alt="" loading="lazy" style="width:120px;height:80px;object-fit:cover;border-radius:6px"></a>';
  };
  const place = (a) => {
    if (Number(a.thread_id)) return '<a href="/forum/t/' + Number(a.thread_id) + '" target="_blank" rel="noopener">主题 #' + Number(a.thread_id) + '</a>';
    if (Number(a.post_id)) return '回复 #' + Number(a.post_id);
    return '<span class="dim">还没挂到帖子上</span>';
  };
  const stime = (v) => esc(String(v || '').slice(0, 16).replace('T', ' '));
  const modForm = (a) => '<form class="inline" method="post" action="/forum/admin/attachments/' + (Number(a.id) || 0) + '/review">' +
    '<input name="reason" maxlength="80" placeholder="拒绝理由（拒绝必填）" style="width:150px">' +
    '<button class="btn btn-sm ok" type="submit" name="action" value="approve">✅ 通过</button>' +
    '<button class="btn btn-sm danger" type="submit" name="action" value="reject">✖ 拒绝</button></form>';
  const row = (a) => '<tr><td>' + thumb(a) + '</td>' +
    '<td><b>' + esc(a.filename || '附件') + '</b><br><small class="dim">' + esc(a.mime || '—') + ' · ' + fmtSize(a.bytes) +
    (a.review_hidden ? ' · <span class="pill">已隐藏</span>' : '') + '</small></td>' +
    '<td><small class="dim">用户 #' + (Number(a.owner_id) || 0) + '<br>' + place(a) + '<br>' + stime(a.created_at) + '</small></td>' +
    '<td><small class="dim">' + esc(a.review_reason || '—') + '<br>' +
    (a.review_source ? esc(ATTACH_SOURCE_LABEL[a.review_source] || a.review_source) + ' · ' + stime(a.review_at) : '—') + '</small></td>' +
    '<td class="act">' + modForm(a) + '</td></tr>';
  const table = (rows, empty) => rows.length
    ? '<table class="tbl"><thead><tr><th>预览</th><th>文件</th><th>来自</th><th>审核记录</th><th>操作</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>'
    : '<p class="cmt-empty">' + esc(empty) + '</p>';
  const content = `<div class="wrap">
  <h1>🖼 附件审核</h1>
  <p class="dim">共 ${fmtNum(stats.total)} 件 · 待审 ${fmtNum(stats.pending)}（还挂在帖子上的 ${fmtNum(stats.pending_live)}）· 已通过 ${fmtNum(stats.approved)} · 已拒绝 ${fmtNum(stats.rejected)} · 已隐藏 ${fmtNum(stats.hidden)} · 占用 ${fmtSize(stats.bytes)}（待审 ${fmtSize(stats.bytes_pending)}）</p>
  <p class="dim">存储驱动 <code>${esc(stats.driver || 'fs')}</code>；<b>拒绝 = 软删 + 隐藏</b>：记录和内容都留着，随时能点「通过」翻案；<b>待审不影响展示</b>，只有被拒的内容会被 /ugc/a/ 挡掉。</p>
  ${okMsg ? '<p class="forum-notice">' + esc(okMsg) + '</p>' : ''}
  ${errMsg ? '<p class="forum-notice">' + esc(errMsg) + '</p>' : ''}
  <p><a class="btn" href="/forum/admin">← 回论坛管理</a> <a class="btn" href="/forum">论坛首页</a></p>
  <section class="sec"><div class="sec-head"><h2>待审队列</h2><span class="pill">${fmtNum(pending.total)} 件</span></div>
    <form class="inline" method="post" action="/forum/admin/attachments/auto"><button class="btn" type="submit">🤖 跑一遍自动规则</button></form>
    <p class="dim">自动规则只拒不给通过：体积、类型、图片尺寸里有任何一条不合规才会自动拒，读不出尺寸的一律留在队列里等人工。</p>
    ${table(itemsOf(pending).map(row), '待审队列是空的')}
  </section>
  <section class="sec"><div class="sec-head"><h2>最近被拒</h2><span class="pill">${fmtNum(rejected.total)} 件</span></div>
    ${table(itemsOf(rejected).map(row), '没有被拒的附件')}
  </section>
</div>`;
  return layout({ origin, user, title: '附件审核', description: '论坛附件人工复核后台', path: '/forum/admin/attachments', content, noindex: true });
}

/* ---------- 每日挑战 ---------- */

/** 最近 n 天的日期键（本地时区），用于打卡日历；end 为空表示到今天就结束 */
