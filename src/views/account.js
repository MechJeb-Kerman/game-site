import { SITE, UPLOAD_LABEL, esc, fmtNum, gameGrid, layout, section } from './core.js';

export function authCard({ origin, user, title, heading, sub, body, path }) {
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
export function oauthButtons(providers, next) {
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

export const LEGAL_UPDATED = '2026-10-17';

export const PRIVACY_SECTIONS = [
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

export const TERMS_SECTIONS = [
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

export function legalSection(s) {
  return '<h2>' + esc(s.h) + '</h2>' + s.p.map(function (t) { return '<p>' + t + '</p>'; }).join('');
}

export function legalPage({ origin, user = null, title, heading, sub, path, sections }) {
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

export const ACCOUNT_OK = {
  email: '邮箱已保存，请去收件箱点验证链接（开发模式下页面会直接给你链接）',
  verified: '邮箱验证成功，账号安全等级 +1 ✅',
  resent: '验证邮件已重新发送',
  password: '密码已更新，其它设备上的登录已全部退出',
  unlink: '已解除第三方绑定'
};
export const ACCOUNT_ERR = {
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
export function emailPill(user) {
  if (!user.email) return '<span class="pill s0">未绑定</span>';
  return Number(user.email_verified)
    ? '<span class="pill s1">已验证</span>'
    : '<span class="pill s2">待验证</span>';
}

/** 账号设置页的徽章胶囊（与个人主页同一套数据，未解锁的半透明显示进度） */
export function accountBadge(b) {
  return '<span class="chip" title="' + esc(b.desc) + (b.done ? '' : '（进度 ' + b.now + '/' + b.need + '）') + '"' +
    (b.done ? '' : ' style="opacity:.45"') + '>' + b.icon + ' ' + esc(b.name) + (b.done ? '' : ' <b>' + b.now + '/' + b.need + '</b>') + '</span>';
}

export function accountPage({ origin, user, providers = [], links = [], notice = '', error = '', devLink = '', profile = null }) {
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

    ${profile ? `
    <section class="acct-sec">
      <h2>等级与徽章 <small>Lv.${profile.level} · ${esc(profile.title)} · ${profile.badgesOwned}/${profile.badges.length} 枚</small></h2>
      <p class="dim">经验 ${fmtNum(profile.xp)}，距离 Lv.${profile.level + 1} 还差 ${fmtNum(profile.xpNeed)}。徽章只认服务端能验证的行为（评论、收藏、评分、论坛发帖、每日挑战），别人刷不了。</p>
      <div class="chips">${profile.badges.map(accountBadge).join('')}</div>
      <p class="dim"><a href="/u/${encodeURIComponent(user.username)}">看我的个人主页 ›</a></p>
    </section>` : ''}

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
