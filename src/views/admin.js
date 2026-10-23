import { esc, excerpt, fmtNum, layout, section } from './core.js';
import { REPORT_LABEL, STATUS_LABEL } from './games.js';
import { authCard } from './account.js';
import { sinceTime } from './social.js';

export function statusPill(s) {
  return '<span class="pill s' + Number(s) + '">' + esc(STATUS_LABEL[Number(s)] || '未知') + '</span>';
}

export function statusForms(g) {
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

  // 邮件面板常渲染：没配邮件服务时也要能点进 /admin/mail 看送达率与抑制名单
  const mailBox = '<section class="sec"><div class="sec-head"><h2>📮 邮件' +
    (mailTransport === 'outbox' && outbox.length ? ' <b>' + outbox.length + '</b>' : '') + '</h2>' +
    '<a class="more" href="/admin/mail">送达率与抑制名单 ›</a></div>' +
    (mailTransport === 'outbox' && outbox.length
      ? '<ul class="mail-list">' + outbox.map((m) =>
        '<li><b>' + esc(m.subject) + '</b><small class="dim"> → ' + esc(m.to) + ' · ' + esc(m.at) + '</small>' +
        (m.link ? '<br><a href="' + esc(m.link) + '">' + esc(m.link) + '</a>' : '') + '</li>').join('') + '</ul>'
      : '<p class="dim">开发发件箱是空的。没配邮件服务时，验证信、重置信只会落进这里；配 RESEND_API_KEY，或 MAIL_API_URL + MAIL_API_KEY 之后即真实发送。</p>') +
    '</section>';

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

/** /admin/mail 的 ?notice= 文案：加/解抑制成功走绿色，地址格式不对走橙色 */
export const MAIL_ADMIN_NOTICE = {
  suppress: '<p class="auth-ok">✅ 已加入抑制名单，队列里发给它的信也一并清掉了</p>',
  unsuppress: '<p class="auth-ok">✅ 已解除抑制，可以重新发信了</p>',
  bad: '<p class="auth-err">⚠️ 地址不对：要含 @，且不超过 200 字</p>',
  missing: '<p class="auth-err">⚠️ 这个地址不在抑制名单里</p>'
};

/**
 * 邮件送达率与抑制名单（/admin/mail）。
 * 数据全来自 src/outbox.js 的 deliveryStats / listSuppressed / bounceSummary —— 这页只读统计 + 两个动作（加/解抑制）。
 */
export function mailAdminPage({ origin, user = null, stats = null, suppressed = null, bounces = null, notice = '', webhook = null }) {
  const s = stats || {};
  const t = s.totals || {};
  const n = (v) => fmtNum(Number(v) || 0);
  const rate = s.rate === null || s.rate === undefined ? '—' : (Number(s.rate) * 100).toFixed(2) + '%';
  const wrap = (head, rows, empty) => rows.length
    ? '<div class="table-wrap"><table class="tbl"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<p class="empty">' + empty + '</p>';

  const tagRows = (s.byTag || []).map((r) => '<tr><td><code>' + esc(r.tag || '—') + '</code></td><td>' + n(r.sent) +
    '</td><td>' + n(r.failed) + '</td><td>' + n(r.bounced) + '</td><td>' + n(r.total) + '</td></tr>').join('');
  const errRows = (s.topErrors || []).map((r) => '<tr><td><code>' + esc(r.error || '—') + '</code></td><td>' + n(r.count) + '</td></tr>').join('');
  const sup = suppressed || { total: 0, items: [] };
  const supRows = (sup.items || []).map((r) => '<tr><td><code>' + esc(r.address) + '</code></td><td>' + esc(r.reason || '—') +
    '</td><td>' + esc(r.source || '—') + '</td><td>' + esc(sinceTime(r.created_at)) + '</td>' +
    '<td class="act"><form method="post" action="/admin/mail/unsuppress">' +
    '<input type="hidden" name="address" value="' + esc(r.address) + '">' +
    '<button class="btn btn-sm" type="submit">解除</button></form></td></tr>').join('');
  const bounceRows = (bounces || []).map((b) => '<tr><td><code>' + esc(b.to_addr || '') + '</code></td><td>' +
    esc(String(b.subject || '').slice(0, 40)) + '</td><td>' + esc(b.tag || '—') + '</td><td><code>' +
    esc(String(b.last_error || '').slice(0, 60)) + '</code></td><td>' + esc(sinceTime(b.updated_at)) + '</td></tr>').join('');
  const hook = webhook || { ready: false, path: '/webhooks/mail-bounce' };
  const hookText = hook.ready
    ? '回调地址 <code>' + esc(origin + hook.path) + '</code> 已启用：服务商带 <code>Authorization: Bearer $MAIL_WEBHOOK_SECRET</code>，或用查询串 <code>?token=…</code>，把退信 / 硬失败打进来，命中的地址自动进抑制名单。'
    : '还没配 <code>MAIL_WEBHOOK_SECRET</code>，回调地址不接收请求（发过去会 403）。留空也能用：退信由服务商扣量后自己进名单，或在这页手动加。';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><a href="/admin">管理后台</a><span>›</span><b>邮件送达</b></nav>
  <div class="page-head">
    <h1>📮 邮件送达</h1>
    <p class="page-sub">统计是全表当前口径；抑制名单里的地址不会再入队，队列里还没发出去的会就地判失败。硬失败（5xx）与退信会自动进名单，也可以在这里手动加。</p>
  </div>
  ${MAIL_ADMIN_NOTICE[notice] || ''}
  <div class="panel">
    <div class="sec-head"><h2>📊 概览</h2><span class="dim">窗口 ${n(s.days || 7)} 天 · 送达率 = 已送达 ÷（已送达 + 失败 + 退信）</span></div>
    <div class="stats">
      <div class="stat"><b>${n(t.sent)}</b><span>已送达</span></div>
      <div class="stat${Number(t.failed) ? ' hot' : ''}"><b>${n(t.failed)}</b><span>失败</span></div>
      <div class="stat${Number(t.bounced) ? ' hot' : ''}"><b>${n(t.bounced)}</b><span>退信</span></div>
      <div class="stat"><b>${n(t.queued)}</b><span>排队中</span></div>
      <div class="stat"><b>${esc(rate)}</b><span>送达率</span></div>
      <div class="stat"><b>${n(t.total)}</b><span>合计</span></div>
    </div>
    <p class="dim" style="margin:12px 0 0">统计窗口从 ${esc(String(s.from || '').slice(0, 10) || '—')} 到 ${esc(String(s.to || '').slice(0, 10) || '—')}；按用途拆分见下表。</p>
  </div>
  <div class="panel">
    <div class="sec-head"><h2>🏷️ 按用途</h2><span class="dim">tag 是发信时标的用途（verify / reset / daily / alert 等）</span></div>
    ${wrap('<th>用途</th><th>已送达</th><th>失败</th><th>退信</th><th>合计</th>', tagRows, '还没有任何发信记录')}
  </div>
  <div class="panel">
    <div class="sec-head"><h2>🧯 失败原因 TOP</h2><span class="dim">mail_5xx 这类硬失败会连带进抑制名单，避免反复撞墙</span></div>
    ${wrap('<th>错误</th><th>次数</th>', errRows, '没有失败记录，挺健康 🎉')}
  </div>
  <div class="panel">
    <div class="sec-head"><h2>🚫 抑制名单 <b>${n(sup.total)}</b></h2><a class="more" href="/admin">回后台 ›</a></div>
    <form class="auth-form" method="post" action="/admin/mail/suppress">
      <label>邮箱<input type="email" name="address" placeholder="bounce@example.com" maxlength="200" required></label>
      <label>原因<input name="reason" placeholder="硬退信 / 用户投诉" maxlength="120"></label>
      <button class="btn" type="submit">加入抑制名单</button>
    </form>
    ${wrap('<th>地址</th><th>原因</th><th>来源</th><th>加入时间</th><th>操作</th>', supRows, '名单是空的：没有硬退信，也没有手动拉黑')}
  </div>
  <div class="panel">
    <div class="sec-head"><h2>↩️ 最近退信</h2><span class="dim">退信 = 对方服务器明确拒收，通常是地址不存在</span></div>
    ${wrap('<th>地址</th><th>主题</th><th>用途</th><th>错误</th><th>时间</th>', bounceRows, '没有退信记录')}
  </div>
  <div class="panel">
    <div class="sec-head"><h2>🔗 服务商回调</h2></div>
    <p class="dim">${hookText}</p>
  </div>
</div>`;
  return layout({
    origin, user, path: '/admin/mail', noindex: true,
    title: '邮件送达',
    description: '邮件送达率、失败原因与抑制名单，站点管理员专用。',
    content
  });
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

export const FT_STATUS = { 0: '待审核', 1: '已发布', 2: '已下架' };
export const FP_STATUS = { 0: '待审核', 1: '已发布', 2: '已隐藏' };
export const FR_STATUS = { 0: '待处理', 1: '已处理', 2: '已忽略' };
export const FR_LABEL = { spam: '垃圾广告', ad: '推广刷屏', abuse: '人身攻击', illegal: '违法内容', other: '其他' };
