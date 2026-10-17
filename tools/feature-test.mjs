/* 五组新功能验收测试：评论分页+楼中楼+举报 / 排行榜 / 后台增强 / 拼音搜索 / 账号增强。
 * 前置条件：站点已在 BASE 上跑起来（默认 http://127.0.0.1:3000）。
 *   node tools/feature-test.mjs      # 或 pnpm test:features
 *
 * 注意：会真的写库（建三个随机名字的测试账号、一条评论+回复+举报、两条测试投稿——其中一条是上传的
 * 单文件 HTML，跑完会退回待审留在库里——以及几条操作日志），
 * 结束时会把测试账号封禁再解封、把举报标记为已处理、把一首测试投稿真正彻底删掉（日志会留下 game.delete 记录），
 * 并留下一条已发布的公告（标题「验收公告<stamp>」）和它下面的评论/回复/举报——公告可以反复改和撤回，重复跑不会互相干扰。
 * 想彻底干净：停服 → 删 data/games.db → 重启。
 * 邮件走开发发件箱（没配 RESEND_API_KEY / MAIL_API_URL 时不会真发信）。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const STAMP = Date.now().toString(36);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}

function jar() { return new Map(); }
function absorb(j, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) j.set(first.slice(0, i), first.slice(i + 1));
  }
}
async function req(path, opt) {
  const o = opt || {};
  const headers = {};
  if (o.j && o.j.size) headers.cookie = [...o.j.entries()].map(([k, v]) => k + '=' + v).join('; ');
  let body;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  if (o.form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  if (o.fd !== undefined) body = o.fd;              /* FormData：content-type 和 boundary 交给 fetch 自己写 */
  if (o.body !== undefined) body = o.body;          /* 原始 body（比如手搓的 multipart 文本） */
  const res = await fetch(BASE + path, { method: o.method || 'GET', headers, body, redirect: o.redirect || 'follow' });
  if (o.j) absorb(o.j, res);
  const text = await res.text();
  return {
    status: res.status, text,
    location: res.headers.get('location') || '',
    type: res.headers.get('content-type') || '',
    csp: res.headers.get('content-security-policy') || ''
  };
}
function json(t) { try { return JSON.parse(t); } catch { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc8 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  /* ---------- 1. 游客可见的部分 ---------- */
  console.log('--- 排行榜（游客可见） ---');
  let r = await req('/rank');
  ok('/rank 200 且有榜单区（没人玩过时显示空状态）', r.status === 200 && (r.text.includes('rk-list') || r.text.includes('这个榜单还没有数据')), r.status);
  ok('榜单页有 7 个 tab', (r.text.match(/<a class="tab/g) || []).length === 7);
  r = await req('/rank?kind=rating');
  ok('/rank?kind=rating 用「分」做单位', r.status === 200 && r.text.includes('最高评分'), r.status);
  r = await req('/rank?kind=whatever');
  ok('非法 kind 回落到今日热玩', r.status === 200 && r.text.includes('今日热玩'), r.status);
  r = await req('/sitemap.xml');
  ok('sitemap 收录 /rank', r.text.includes('/rank'), '');
  r = await req('/robots.txt');
  ok('robots 屏蔽 /account 与 /comments/', r.text.includes('Disallow: /account') && r.text.includes('Disallow: /comments/'), '');
  r = await req('/game/2048');
  ok('游戏详情页 CSP 放行外站 iframe（frame-src 含 http(s)，否则投稿的外站游戏被拦成「该内容被屏蔽了」）',
    r.status === 200 && /frame-src[^;]*https:/.test(r.csp) && /frame-src[^;]*http:/.test(r.csp), r.csp.slice(0, 120));

  console.log('--- 隐私政策 / 用户协议 / 注册勾选同意 ---');
  r = await req('/privacy');
  ok('/privacy 200 且是隐私政策', r.status === 200 && r.text.includes('隐私政策'), r.status);
  ok('隐私政策写了 Cookie 名、第三方登录与邮件', r.text.includes('oauth_state') && r.text.includes('GitHub') && r.text.includes('密码只保存加盐哈希'), '');
  r = await req('/terms');
  ok('/terms 200 且是用户协议', r.status === 200 && r.text.includes('用户协议') && r.text.includes('投稿'), r.status);
  ok('协议写了最后更新时间与联系方式', r.text.includes('最后更新') && r.text.includes('mailto:'), '');
  r = await req('/');
  ok('页脚链到隐私政策 / 用户协议', r.text.includes('href="/privacy"') && r.text.includes('href="/terms"'), '');
  r = await req('/sitemap.xml');
  ok('sitemap 收录 /privacy 与 /terms', r.text.includes('/privacy') && r.text.includes('/terms'), '');
  r = await req('/register');
  ok('注册页有必填的同意勾选', r.status === 200 && /name="agree"[^>]*required/.test(r.text) && r.text.includes('《隐私政策》'), r.status);
  const noAgree = 'noag' + STAMP;
  r = await req('/register', { method: 'POST', form: { username: noAgree, password: 'pass1234', next: '/' }, redirect: 'manual' });
  ok('没勾同意不给注册（400 且页面提示）', r.status === 400 && r.text.includes('同意'), r.status);
  r = await req('/api/auth/login', { method: 'POST', json: { username: noAgree, password: 'pass1234' } });
  ok('没勾同意时不会偷偷建号', r.status === 401, r.status + ' ' + r.text.slice(0, 80));
  r = await req('/register');
  ok('勾选框旁边就是两份条款的链接',
    /name="agree"[\s\S]{0,260}href="\/terms"[\s\S]{0,160}href="\/privacy"/.test(r.text), '');
  const agreeUser = 'agr' + STAMP;
  r = await req('/register', { method: 'POST', form: { username: agreeUser, password: 'pass1234', agree: '1', next: '/' }, redirect: 'manual' });
  ok('勾了同意就能注册（302 回 next）', r.status === 302 && r.location === '/', r.status + ' ' + r.location);
  r = await req('/api/auth/login', { method: 'POST', json: { username: agreeUser, password: 'pass1234' } });
  ok('勾同意注册出来的账号能登录', r.status === 200, r.status + ' ' + r.text.slice(0, 80));

  console.log('--- 拼音 / 首字母搜索 ---');
  r = await req('/api/search/suggest?q=tcs');
  let s = json(r.text);
  ok('建议接口：tcs → 贪吃蛇', r.status === 200 && s && s.items.length > 0 && s.items[0].slug === 'snake', r.text.slice(0, 120));
  r = await req('/api/search/suggest?q=tanchishe');
  s = json(r.text);
  ok('建议接口：tanchishe → 贪吃蛇', s && s.items.length && s.items[0].slug === 'snake', r.text.slice(0, 120));
  r = await req('/api/search/suggest?q=' + encodeURIComponent('贪吃蛇'));
  s = json(r.text);
  ok('建议接口：中文直搜命中', s && s.items.length && s.items[0].slug === 'snake', r.text.slice(0, 120));
  r = await req('/api/search/suggest?q=');
  s = json(r.text);
  ok('空查询返回空列表', s && s.items.length === 0, r.text.slice(0, 80));

  console.log('--- 评论分页 JSON ---');
  r = await req('/api/games/2048/comments');
  s = json(r.text);
  ok('评论接口分页字段齐全', r.status === 200 && s && typeof s.total === 'number' && Array.isArray(s.items) && s.page === 1, r.text.slice(0, 120));
  r = await req('/api/games/no-such-game/comments');
  ok('不存在的游戏 404', r.status === 404, r.status);

  console.log('--- 账号相关页面（游客） ---');
  r = await req('/account', { redirect: 'manual' });
  ok('未登录访问 /account 跳登录', r.status === 302 && r.location.startsWith('/login'), r.status + ' ' + r.location);
  r = await req('/forgot');
  ok('找回密码页 200', r.status === 200 && r.text.includes('发送重置链接'), r.status);
  r = await req('/reset?token=zzz');
  ok('重置页 200（token 不合法也不报错，提交时才校验）', r.status === 200, r.status);
  r = await req('/verify-email?token=zzz');
  ok('无效验证 token 400', r.status === 400 && r.text.includes('验证没有成功'), r.status);

  console.log('--- 评论举报（游客） ---');
  r = await req('/comments/1/report', { method: 'POST', form: { reason: 'spam', next: '/game/2048' }, redirect: 'manual' });
  ok('游客举报跳登录', r.status === 302 && r.location.startsWith('/login'), r.status + ' ' + r.location);

  /* ---------- 2. 两个测试账号：评论 / 回复 / 举报 ---------- */
  console.log('--- 评论与楼中楼 ---');
  const jarA = jar(), jarB = jar();
  const nameA = 'qa' + STAMP, nameB = 'qb' + STAMP;
  r = await req('/api/auth/register', { method: 'POST', j: jarA, json: { username: nameA, password: 'pass1234', display_name: '测试甲' } });
  const userA = json(r.text).user;
  ok('注册账号甲', r.status === 201 && userA && userA.id > 0, r.status + ' ' + r.text.slice(0, 100));
  r = await req('/api/auth/register', { method: 'POST', j: jarB, json: { username: nameB, password: 'pass1234', display_name: '测试乙' } });
  const userB = json(r.text).user;
  ok('注册账号乙', r.status === 201 && userB && userB.id > 0, r.status);
  ok('新账号默认未绑定邮箱', userA.email === '' && Number(userA.email_verified) === 0, JSON.stringify(userA));

  r = await req('/api/games/2048/comments', { method: 'POST', j: jarA, json: { body: '功能验收：顶层评论 ' + STAMP } });
  const top = json(r.text);
  ok('甲发顶层评论', r.status === 200 && top && top.id > 0 && top.parent_id === null, r.status + ' ' + r.text.slice(0, 100));
  r = await req('/api/games/2048/comments', { method: 'POST', j: jarB, json: { body: '功能验收：回复 ' + STAMP, parent_id: top.id } });
  const rep = json(r.text);
  ok('乙回复顶层评论', r.status === 200 && rep && rep.parent_id === top.id, r.status + ' ' + r.text.slice(0, 100));
  await sleep(10500); /* 同一用户在同一游戏 10 秒内只能发一条评论，等过去再发 */
  r = await req('/api/games/2048/comments', { method: 'POST', j: jarA, json: { body: '楼中楼', parent_id: rep.id } });
  const deep = json(r.text);
  ok('回复「回复」挂到同一顶层并带 @昵称', r.status === 200 && deep && deep.parent_id === top.id && deep.body.startsWith('@测试乙'), r.status + ' ' + r.text.slice(0, 140));
  r = await req('/api/games/2048/comments', { method: 'POST', j: jarB, json: { body: 'x', parent_id: 99999999 } });
  ok('父评论不存在返回 bad_parent', r.status === 400 && json(r.text).error === 'bad_parent', r.status + ' ' + r.text.slice(0, 80));

  r = await req('/api/games/2048/comments');
  s = json(r.text);
  const found = s && s.items.find((c) => c.id === top.id);
  ok('评论接口把回复挂在顶层下', !!found && found.reply_total === 2 && found.replies.length === 2, JSON.stringify(found && { t: found.reply_total, n: found.replies.length }));

  r = await req('/game/2048', { j: jarA });
  ok('详情页渲染楼中楼与回复入口', r.status === 200 && r.text.includes('cmt-replies') && r.text.includes('data-reply='), r.status);

  console.log('--- 举报 ---');
  r = await req('/comments/' + top.id + '/report', { method: 'POST', j: jarB, form: { reason: 'spam', next: '/game/2048' }, redirect: 'manual' });
  ok('举报成功回到详情页', r.status === 302 && r.location.startsWith('/game/2048') && r.location.includes('report=ok'), r.status + ' ' + r.location);
  r = await req('/game/2048?report=already');
  ok('详情页显示举报提示', r.status === 200 && r.text.includes('你已经举报过这条评论了'), r.status);
  r = await req('/comments/' + top.id + '/report', { method: 'POST', j: jarB, form: { reason: 'spam', next: '/game/2048' }, redirect: 'manual' });
  ok('重复举报记为 already', r.location.includes('report=already'), r.location);
  r = await req('/comments/' + top.id + '/report', { method: 'POST', j: jarB, form: { reason: 'nope', next: '/game/2048' }, redirect: 'manual' });
  ok('非法举报原因被挡', r.location.includes('report=bad_reason'), r.location);

  /* ---------- 3. 账号增强：邮箱验证 / 找回密码 / 改密 ---------- */
  console.log('--- 邮箱验证 ---');
  const mail = 'qa' + STAMP + '@example.com';
  r = await req('/account/email', { method: 'POST', j: jarA, form: { email: mail }, redirect: 'manual' });
  ok('绑定邮箱后跳回账号页', r.status === 302 && r.location.startsWith('/account?ok=email'), r.status + ' ' + r.location);
  const t1 = (r.location.match(/t=([a-f0-9]{64})/) || [])[1];
  ok('开发模式直接给出验证 token', !!t1, r.location);
  r = await req('/account', { j: jarA });
  ok('账号页显示待验证', r.status === 200 && r.text.includes('待验证') && r.text.includes(mail), r.status);
  r = await req('/verify-email?token=' + t1, { j: jarA });
  ok('点验证链接成功', r.status === 200 && r.text.includes('邮箱验证成功'), r.status);
  r = await req('/api/me', { j: jarA });
  ok('/api/me 显示邮箱已验证', Number(json(r.text).user.email_verified) === 1, r.text.slice(0, 100));
  r = await req('/verify-email?token=' + t1, { j: jarA });
  ok('同一个 token 不能重复用', r.status === 400, r.status);
  r = await req('/account/email', { method: 'POST', j: jarB, form: { email: mail }, redirect: 'manual' });
  ok('邮箱已被别人绑定会被挡下', r.location === '/account?err=email', r.location);
  const mailB = 'qb' + STAMP + '@example.com';
  r = await req('/account/email', { method: 'POST', j: jarB, form: { email: mailB }, redirect: 'manual' });
  ok('乙绑定自己的邮箱', r.status === 302 && r.location.startsWith('/account?ok=email'), r.status + ' ' + r.location);

  console.log('--- 修改密码 ---');
  r = await req('/account/password', { method: 'POST', j: jarB, form: { old: 'wrong-one', password: 'newpass123' }, redirect: 'manual' });
  ok('原密码不对被挡', r.location === '/account?err=password', r.location);
  r = await req('/account/password', { method: 'POST', j: jarB, form: { old: 'pass1234', password: 'newpass123' }, redirect: 'manual' });
  ok('改密成功并退出所有设备', r.status === 200 && r.text.includes('密码已更新'), r.status);
  r = await req('/api/me', { j: jarB });
  ok('改密后当前会话也失效', json(r.text).user === null, r.text.slice(0, 80));
  r = await req('/api/auth/login', { method: 'POST', json: { username: nameB, password: 'newpass123' } });
  ok('新密码可以登录', r.status === 200, r.status + ' ' + r.text.slice(0, 80));

  console.log('--- 找回密码 ---');
  r = await req('/forgot', { method: 'POST', form: { account: nameB } });
  ok('申请重置成功', r.status === 200 && r.text.includes('如果这个账号存在'), r.status);
  const t2 = (r.text.match(/reset\?token=([a-f0-9]{64})/) || [])[1];
  ok('开发模式拿到重置链接', !!t2, '');
  r = await req('/forgot', { method: 'POST', form: { account: 'no-such-user-' + STAMP } });
  ok('账号不存在也返回同样的页面（防探测）', r.status === 200 && r.text.includes('如果这个账号存在'), r.status);
  r = await req('/reset', { method: 'POST', form: { token: t2, password: 'brandnew12', password2: 'brandnew12' } });
  ok('重置密码成功', r.status === 200 && r.text.includes('密码已重置'), r.status);
  r = await req('/reset', { method: 'POST', form: { token: t2, password: 'x', password2: 'x' } });
  ok('重置 token 一次性', r.status === 400, r.status);
  r = await req('/api/auth/login', { method: 'POST', json: { username: nameB, password: 'brandnew12' } });
  ok('重置后的新密码可以登录', r.status === 200, r.status + ' ' + r.text.slice(0, 80));

  console.log('--- 演示登录（OAuth dev provider） ---');
  const jarC = jar();
  r = await req('/auth/dev?next=/account', { j: jarC, redirect: 'manual' });
  ok('/auth/dev 跳到回调并种下 state cookie', r.status === 302 && r.location.startsWith('/auth/dev/callback'), r.status + ' ' + r.location);
  const cb = new URL(BASE + r.location).pathname + new URL(BASE + r.location).search;
  r = await req(cb, { j: jarC, redirect: 'manual' });
  ok('回调成功并跳回 next', r.status === 302 && r.location === '/account', r.status + ' ' + r.location);
  r = await req('/api/me', { j: jarC });
  const devUser = json(r.text).user;
  ok('演示账号已登录', !!devUser && devUser.username.startsWith('dev_'), r.text.slice(0, 120));
  r = await req('/auth/dev/callback?code=mock&state=bogus', { j: jar(), redirect: 'manual' });
  ok('state 不对时拒绝', r.status === 400 && r.text.includes('登录没有完成'), r.status);
  r = await req('/account', { j: jarC });
  ok('账号页列出已绑定的第三方账号', r.status === 200 && r.text.includes('演示登录'), r.status);
  r = await req('/account/unlink', { method: 'POST', j: jarC, form: { provider: 'dev' }, redirect: 'manual' });
  ok('解绑第三方成功', r.location === '/account?ok=unlink', r.location);

  /* ---------- 4. 后台增强 ---------- */
  console.log('--- 后台 ---');
  const jarAd = jar();
  r = await req('/api/auth/login', { method: 'POST', j: jarAd, json: { username: 'admin', password: 'admin123' } });
  ok('管理员登录', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
  r = await req('/admin', { j: jarAd });
  ok('后台含举报 / 用户 / 日志三块', r.status === 200 && r.text.includes('举报处理') && r.text.includes('用户管理') && r.text.includes('操作日志'), r.status);
  ok('后台有批量上下架表单', r.text.includes('id="batchForm"') && r.text.includes('批量上架'), '');
  ok('后台有被举报评论计数或举报行', r.text.includes('被举报') || r.text.includes('暂时没有待处理的举报'), '');
  const rid = (r.text.match(/\/admin\/reports\/(\d+)\/status/) || [])[1];
  ok('后台能定位到待处理举报', !!rid, '');
  r = await req('/admin/preview/2048', { j: jarAd });
  ok('后台预览按玩家视角打开', r.status === 200 && r.text.includes('预览模式'), r.status);

  r = await req('/admin/games/batch', { method: 'POST', j: jarAd, form: { slug: ['2048', 'tetris'], status: '1' }, redirect: 'manual' });
  ok('批量上架成功', r.status === 302 && r.location === '/admin?ok=batch', r.status + ' ' + r.location);
  r = await req('/admin/games/batch', { method: 'POST', j: jarAd, form: { status: '1' }, redirect: 'manual' });
  ok('没选任何游戏时报错', r.status === 400, r.status);
  if (rid) {
    r = await req('/admin/reports/' + rid + '/status', { method: 'POST', j: jarAd, form: { status: '1' }, redirect: 'manual' });
    ok('处理举报成功', r.status === 302 && r.location === '/admin?ok=report', r.status + ' ' + r.location);
  }
  r = await req('/admin/users/' + userA.id + '/verify', { method: 'POST', j: jarAd, redirect: 'manual' });
  ok('站长手动标记邮箱已验证', r.status === 302 && r.location === '/admin?ok=email', r.status + ' ' + r.location);
  r = await req('/admin/users/' + userA.id + '/ban', { method: 'POST', j: jarAd, form: { banned: '1', reason: '验收测试' }, redirect: 'manual' });
  ok('封禁用户成功', r.status === 302 && r.location === '/admin?ok=ban', r.status + ' ' + r.location);
  r = await req('/api/auth/login', { method: 'POST', json: { username: nameA, password: 'pass1234' } });
  ok('被封禁的账号登不进来', r.status === 401 && r.text.includes('封禁'), r.status + ' ' + r.text.slice(0, 100));
  r = await req('/api/me', { j: jarA });
  ok('被封禁后原会话立即失效', json(r.text).user === null, r.text.slice(0, 80));
  r = await req('/admin/users/' + userA.id + '/ban', { method: 'POST', j: jarAd, form: { banned: '0' }, redirect: 'manual' });
  ok('解封成功', r.status === 302, r.location);
  r = await req('/api/auth/login', { method: 'POST', json: { username: nameA, password: 'pass1234' } });
  ok('解封后可以登录', r.status === 200, r.status);
  r = await req('/admin/users/1/ban', { method: 'POST', j: jarAd, form: { banned: '1' }, redirect: 'follow' });
  ok('站长账号不可封禁', r.status === 400 && r.text.includes('站长账号不可封禁'), r.status);

  /* ---------- 5. 投稿上传单文件 HTML（存库，按 /ugc/<slug>.html 提供） ---------- */
  console.log('--- 投稿上传单文件 HTML ---');
  const jarUp = jar();
  r = await req('/api/auth/register', { method: 'POST', j: jarUp, json: { username: 'qu' + STAMP, password: 'pass1234', display_name: '投稿人' } });
  ok('注册投稿账号', r.status === 201, r.status + ' ' + r.text.slice(0, 80));

  r = await req('/submit', { j: jarUp });
  ok('投稿页有文件框 + multipart 表单', r.status === 200 && r.text.includes('name="game_file"') && r.text.includes('enctype="multipart/form-data"'), r.status);

  const MINI = '<!doctype html><html><head><meta charset="utf-8"><title>mini</title></head><body><div id="app">mini game</div><script>window.__upmini=1;</script></body></html>';
  const fd = (filename, body, field) => {
    const f = new FormData();
    f.append('title', '上传验收小游戏' + STAMP);
    f.append('subtitle', '验收用');
    f.append('category', 'puzzle');
    f.append('description', '功能验收：投稿上传的单文件 HTML');
    f.append(field || 'game_file', new Blob([body], { type: 'text/html' }), filename);
    return f;
  };
  r = await req('/submit', { method: 'POST', j: jarUp, fd: fd('mini.html', MINI) });
  ok('上传单文件 HTML 投稿成功', r.status === 200 && r.text.includes('投稿成功'), r.status + ' ' + r.text.slice(0, 200));
  const upSlug = ((r.text.match(/编号 <b>([^<]+)<\/b>/) || [])[1] || '');
  ok('返回投稿编号（即 slug，标题是中文时 slug 也会是中文）', !!upSlug && !/[\s"<>]/.test(upSlug), upSlug || r.text.slice(0, 200));

  if (upSlug) {
    r = await req('/ugc/' + upSlug + '.html');
    ok('待审的上传作品对游客 404', r.status === 404, r.status);
    r = await req('/ugc/' + upSlug + '.html', { j: jarAd });
    ok('站长能取到待审的上传作品', r.status === 200 && r.text.includes('__upmini'), r.status);
    ok('响应 = text/html + sandbox CSP（不含 allow-same-origin）', /text\/html/.test(r.type) && /sandbox/.test(r.csp) && !/allow-same-origin/.test(r.csp), r.type + ' | ' + r.csp.slice(0, 90));

    r = await req('/admin/preview/' + upSlug, { j: jarAd });
    const ptag = ((r.text.match(/<iframe id="gameFrame"[\s\S]*?<\/iframe>/) || [''])[0]);
    ok('后台预览用严格沙箱 iframe（无 allow-same-origin）', r.status === 200 && ptag.includes('/ugc/' + upSlug + '.html') && /sandbox="[^"]*allow-scripts[^"]*"/.test(ptag) && !/allow-same-origin/.test(ptag), ptag.slice(0, 180));

    r = await req('/submit', { method: 'POST', j: jarUp, fd: fd('big.html', 'x'.repeat(513 * 1024)) });
    ok('超过 512 KB 的文件被拒', r.status === 400 && r.text.includes('超过上限'), r.status + ' ' + r.text.slice(0, 140));
    r = await req('/submit', { method: 'POST', j: jarUp, fd: fd('save.zip', MINI) });
    ok('扩展名不对的文件被拒', r.status === 400 && r.text.includes('只能上传 .html'), r.status);
    r = await req('/submit', { method: 'POST', j: jarUp, fd: fd('binary.html', 'PK\u0000\u0001bin') });
    ok('非文本文件被拒', r.status === 400 && r.text.includes('不是文本'), r.status);
    r = await req('/submit', { method: 'POST', j: jarUp, form: { title: '地址投稿' + STAMP, category: 'puzzle', game_url: '/games/2048/index.html' } });
    ok('不带文件的老投稿路径仍可用', r.status === 200 && r.text.includes('投稿成功'), r.status);
    r = await req('/submit', { method: 'POST', j: jarUp, form: { title: '两边都不填' + STAMP, category: 'puzzle' } });
    ok('既没文件也没地址时明确报错', r.status === 400 && r.text.includes('请上传单文件 HTML'), r.status + ' ' + r.text.slice(0, 140));

    r = await req('/admin/games/' + upSlug + '/status', { method: 'POST', j: jarAd, form: { status: '1' }, redirect: 'manual' });
    ok('站长通过上传的投稿', r.status === 302, r.status + ' ' + r.location);
    r = await req('/ugc/' + upSlug + '.html');
    ok('上架后游客能拿到上传的 HTML', r.status === 200 && r.text.includes('__upmini'), r.status);
    r = await req('/game/' + upSlug);
    const dtag = ((r.text.match(/<iframe id="gameFrame"[\s\S]*?<\/iframe>/) || [''])[0]);
    ok('上架后详情页直接可玩（iframe 指向 /ugc/ 且严格沙箱）', r.status === 200 && dtag.includes('/ugc/' + upSlug + '.html') && /sandbox="[^"]*allow-scripts[^"]*"/.test(dtag) && !/allow-same-origin/.test(dtag), r.status + ' ' + dtag.slice(0, 170));
    r = await req('/admin/games/' + upSlug + '/status', { method: 'POST', j: jarAd, form: { status: '2' }, redirect: 'manual' });
    ok('复核完把测试投稿退回待审', r.status === 302, r.status + ' ' + r.location);
    r = await req('/ugc/' + upSlug + '.html');
    ok('退回待审后游客又取不到', r.status === 404, r.status);
  }

  /* ---------- 6. 游戏彻底删除（必须先下架，确认页列数据量） ---------- */
  console.log('--- 游戏彻底删除 ---');
  const jarDel = jar();
  r = await req('/api/auth/register', { method: 'POST', j: jarDel, json: { username: 'del' + STAMP, password: 'pass1234', display_name: '删除测试' } });
  ok('注册删除测试账号', r.status === 201, r.status + ' ' + r.text.slice(0, 80));

  const DELMINI = '<!doctype html><html><head><meta charset="utf-8"><title>del</title></head><body><div id="app">待删</div><script>window.__upmini=2;</script></body></html>';
  const delfd = (filename, body) => {
    const f = new FormData();
    f.append('title', '待删小游戏' + STAMP);
    f.append('category', 'puzzle');
    f.append('description', '功能验收：彻底删除');
    f.append('game_file', new Blob([body], { type: 'text/html' }), filename);
    return f;
  };
  r = await req('/submit', { method: 'POST', j: jarDel, fd: delfd('del.html', DELMINI) });
  const delSlug = ((r.text.match(/编号 <b>([^<]+)<\/b>/) || [])[1] || '');
  ok('造一条带上传文件的投稿给删除用', r.status === 200 && !!delSlug, r.status + ' ' + (delSlug || r.text.slice(0, 160)));

  if (delSlug) {
    r = await req('/admin/games/' + delSlug + '/status', { method: 'POST', j: jarAd, form: { status: '1' }, redirect: 'manual' });
    ok('把待删的游戏上架', r.status === 302, r.status + ' ' + r.location);
    r = await req('/api/games/' + delSlug + '/play', { method: 'POST' });
    ok('删除前先有游玩记录', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await req('/api/games/' + delSlug + '/rate', { method: 'POST', j: jarDel, json: { stars: 5 } });
    ok('删除前先有评分', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await req('/api/games/' + delSlug + '/favorite', { method: 'POST', j: jarDel });
    ok('删除前先有收藏', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await req('/api/games/' + delSlug + '/comments', { method: 'POST', j: jarDel, json: { body: '删除前留一条评论 ' + STAMP } });
    ok('删除前先有评论', r.status === 200, r.status + ' ' + r.text.slice(0, 80));

    r = await req('/admin/games/' + delSlug + '/delete', { method: 'POST', j: jarAd, redirect: 'manual' });
    ok('上架中的游戏不让彻底删除', r.status === 400 && r.text.includes('还在上架中'), r.status + ' ' + r.text.slice(0, 120));

    r = await req('/admin/games/' + delSlug + '/status', { method: 'POST', j: jarAd, form: { status: '0' }, redirect: 'manual' });
    ok('先下架', r.status === 302, r.status + ' ' + r.location);

    r = await req('/admin/games/' + delSlug + '/delete', { j: jarAd });
    const cnt = (label, n) => new RegExp(esc8(label) + '</span><b>' + n + '</b>').test(r.text);
    ok('删除确认页列出 6 项连带数据量（评论/评分/收藏/游玩/文件各 1）',
      r.status === 200 && r.text.includes('彻底删除') &&
      cnt('评论（含回复）', 1) && cnt('评分', 1) && cnt('收藏', 1) && cnt('游玩记录', 1) && cnt('上传的 HTML 文件', 1) && cnt('评论举报', 0),
      r.status + ' ' + (r.text.match(/<ul class="purge-list">[\s\S]*?<\/ul>/) || [''])[0].slice(0, 300));

    r = await req('/admin/games/' + delSlug + '/delete', { method: 'POST', j: jarAd, redirect: 'manual' });
    ok('下架后彻底删除成功并跳回后台', r.status === 302 && r.location === '/admin?ok=purge', r.status + ' ' + r.location);
    r = await req('/game/' + delSlug);
    ok('删除后详情页 404', r.status === 404, r.status);
    r = await req('/ugc/' + delSlug + '.html', { j: jarAd });
    ok('删除后上传的 HTML 也 404（文件跟着删）', r.status === 404, r.status);
    r = await req('/admin?ok=purge', { j: jarAd });
    ok('后台显示删除提示且日志里有这条记录', r.status === 200 && r.text.includes('游戏已彻底删除') && r.text.includes(delSlug), r.status);
    r = await req('/admin/games/' + delSlug + '/delete', { j: jarAd });
    ok('已被删掉的游戏再进确认页是 404', r.status === 404, r.status);
  }


  /* ---------- 7. 公告（发布 / 编辑 / 撤回 + 可评论）与更新说明 ---------- */
  console.log('--- 公告与更新说明 ---');
  const NT_TITLE = '验收公告' + STAMP;          /* 中文标题：slug 保留中文，正好走一遍百分号编码路径 */
  const NT_BODY = '第一段正文 ' + STAMP + '\n\n第二段正文（换段）';
  r = await req('/admin/posts/new', { j: jarAd });
  ok('写公告页面能打开（有标题/正文/置顶）',
    r.status === 200 && r.text.includes('name="title"') && r.text.includes('name="body"') && r.text.includes('name="pinned"'), r.status);
  r = await req('/admin/posts/new', { method: 'POST', j: jarAd, form: { title: NT_TITLE, body: NT_BODY, pinned: '1' }, redirect: 'manual' });
  ok('发布一条置顶公告并跳回后台', r.status === 302 && r.location === '/admin?ok=post', r.status + ' ' + r.location);

  r = await req('/admin?ok=post', { j: jarAd });
  const nSlug = decodeURIComponent(((r.text.match(/\/admin\/posts\/([^/"]+)\/edit/) || [])[1] || ''));
  const nEnc = encodeURIComponent(nSlug);
  ok('后台公告管理区列出新公告', r.status === 200 && !!nSlug && r.text.includes('📢 公告管理') && r.text.includes(NT_TITLE), r.status + ' slug=' + nSlug);

  r = await req('/notice');
  ok('/notice 列表 200 且列出这条公告（链到百分号编码的地址）',
    r.status === 200 && r.text.includes(NT_TITLE) && r.text.includes('/notice/' + nEnc), r.status);
  r = await req('/');
  ok('首页顶部挂出最新公告横幅（带 slug，供关闭记忆用）',
    r.status === 200 && r.text.includes('id="noticeBar"') && r.text.includes('data-slug="' + nSlug + '"'), r.status);
  r = await req('/notice/' + nEnc);
  ok('公告详情 200：正文按空行分段渲染',
    r.status === 200 && r.text.includes('第一段正文 ' + STAMP) && r.text.includes('<p>第二段正文（换段）</p>') &&
    r.text.includes('class="post-text"'), r.status);
  ok('游客在公告页看到的是登录引导，而不是评论表单',
    r.text.includes('id="cmtPanel"') && !r.text.includes('id="cmtForm"') && r.text.includes('cmt-login'), '');
  r = await req('/notice/' + encodeURIComponent('根本没有这条公告'));
  ok('不存在的公告 404', r.status === 404, r.status);

  r = await req('/api/notices/' + nEnc + '/comments', { method: 'POST', json: { body: '游客发不了' } });
  ok('游客给公告发评论 401', r.status === 401 && r.text.includes('login_required'), r.status + ' ' + r.text.slice(0, 80));

  const jarNt = jar();
  r = await req('/api/auth/register', { method: 'POST', j: jarNt, json: { username: 'nt' + STAMP, password: 'pass1234', display_name: '公告评论' } });
  ok('注册公告评论账号', r.status === 201, r.status + ' ' + r.text.slice(0, 80));
  r = await req('/api/notices/' + nEnc + '/comments', { method: 'POST', j: jarNt, json: { body: '公告评论 ' + STAMP } });
  const nCid = ((json(r.text) || {}).id) || 0;
  ok('给公告发评论成功', r.status === 200 && nCid > 0, r.status + ' ' + r.text.slice(0, 100));
  r = await req('/notice/' + nEnc, { j: jarNt });
  ok('登录后公告详情复用同一块评论面板（端点是 /api/notices/）',
    r.status === 200 && r.text.includes('id="cmtForm"') && r.text.includes('data-endpoint="/api/notices/' + nEnc + '/comments"'), r.status);

  /* 回复换个人发：同一用户对同一目标 10 秒内只能发一条（和游戏评论一个限流器） */
  const jarNt2 = jar();
  r = await req('/api/auth/register', { method: 'POST', j: jarNt2, json: { username: 'nr' + STAMP, password: 'pass1234', display_name: '公告回复' } });
  ok('注册第二个公告评论账号（用来发回复）', r.status === 201, r.status + ' ' + r.text.slice(0, 80));
  r = await req('/api/notices/' + nEnc + '/comments', { method: 'POST', j: jarNt2, json: { body: '回复一层 ' + STAMP, parent_id: nCid } });
  const nPid = ((json(r.text) || {}).parent_id) || 0;
  ok('公告评论也能楼中楼（回复挂同一顶层）', r.status === 200 && nPid === nCid, r.status + ' ' + r.text.slice(0, 100));
  r = await req('/api/notices/' + nEnc + '/comments');
  const ntData = json(r.text) || {};
  const ntTop = (ntData.items || [])[0] || {};
  ok('公告评论 JSON：total 只数顶层，回复挂在 replies 里',
    ntData.total === 1 && (ntTop.replies || []).length === 1, JSON.stringify(ntData).slice(0, 200));
  r = await req('/notice/' + nEnc);
  ok('详情页把评论与回复都渲染出来，角标数是顶层+回复的总数',
    r.status === 200 && r.text.includes('公告评论 ' + STAMP) && r.text.includes('回复一层 ' + STAMP) &&
    r.text.includes('id="cmtCount">2<'), r.status);

  r = await req('/comments/' + nCid + '/report', { method: 'POST', j: jarNt, form: { reason: 'spam' }, redirect: 'manual' });
  ok('举报公告评论成功（和游戏评论共用举报表）', r.status === 302 && r.location.indexOf('report=ok') >= 0, r.status + ' ' + r.location);
  r = await req('/comments/' + nCid + '/report', { method: 'POST', j: jarNt, form: { reason: 'spam' }, redirect: 'manual' });
  ok('同一个人重复举报只算一次（already）', r.status === 302 && r.location.indexOf('report=already') >= 0, r.status + ' ' + r.location);
  r = await req('/admin', { j: jarAd });
  ok('后台举报表把公告评论链到 /notice/<slug>（不是 /game/）',
    r.status === 200 && r.text.includes('/notice/' + nEnc), r.status);

  r = await req('/admin/posts/' + nEnc + '/edit', { j: jarAd });
  ok('公告编辑页带出原文与置顶状态', r.status === 200 && r.text.includes(NT_TITLE) && r.text.includes('第一段正文 ' + STAMP), r.status);
  r = await req('/admin/posts/' + nEnc + '/edit', { method: 'POST', j: jarAd, form: { title: NT_TITLE + '(改)', body: NT_BODY + '\n\n第三段（改后加的）', pinned: '1' }, redirect: 'manual' });
  ok('保存公告修改', r.status === 302 && r.location === '/admin?ok=post', r.status + ' ' + r.location);
  r = await req('/notice/' + nEnc);
  ok('前台看到改后的标题、新段落与「最后修改」', r.status === 200 && r.text.includes('第三段（改后加的）') && r.text.includes('最后修改'), r.status);

  r = await req('/admin/posts/' + nEnc + '/status', { method: 'POST', j: jarAd, form: { status: '0' }, redirect: 'manual' });
  ok('撤回公告', r.status === 302 && r.location === '/admin?ok=postStatus', r.status + ' ' + r.location);
  r = await req('/notice/' + nEnc);
  ok('撤回后前台详情立刻 404', r.status === 404, r.status);
  r = await req('/notice');
  ok('撤回后列表里也没有了', r.status === 200 && !r.text.includes(NT_TITLE + '(改)'), r.status);
  r = await req('/');
  ok('撤回后首页横幅不再出现这条（软撤回、前台当场消失）',
    r.status === 200 && !r.text.includes('data-slug="' + nSlug + '"'), r.status);
  r = await req('/admin', { j: jarAd });
  ok('后台仍看得到已撤回的公告（可再发布），统计里有「已发布公告」一格',
    r.status === 200 && r.text.includes('已撤回') && /<b>\d+<\/b><span>已发布公告<\/span>/.test(r.text), r.status);
  ok('公告的操作都写进了操作日志', r.text.includes('post.create') && r.text.includes('post.update') && r.text.includes('post.retract'), '');
  r = await req('/admin/posts/' + nEnc + '/status', { method: 'POST', j: jarAd, form: { status: '1' }, redirect: 'manual' });
  ok('重新发布这条公告', r.status === 302 && r.location === '/admin?ok=postStatus', r.status);
  r = await req('/notice/' + nEnc);
  ok('重新发布后评论与回复都还在（撤回不动数据）',
    r.status === 200 && r.text.includes('公告评论 ' + STAMP) && r.text.includes('回复一层 ' + STAMP), r.status);

  r = await req('/changelog');
  ok('/changelog 200 且是从 git 提交历史生成的（有 kind 标签与 sha）',
    r.status === 200 && r.text.includes('更新说明') && /<code>[0-9a-f]{7}<\/code>/.test(r.text), r.status);
  ok('更新说明标出提交总数与生成时间', r.text.includes('条提交') && r.text.includes('生成于'), '');
  r = await req('/sitemap.xml');
  ok('sitemap 收录 /notice 与 /changelog', r.text.includes('/notice') && r.text.includes('/changelog'), r.status);

  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
}

/** 导出给 worker-feature-test.mjs 之类的外壳等：直接跑时下面这行就会启动，导入时可以 await finished */
export const finished = main().catch((err) => {
  console.error('测试脚本自身出错：', err);
  process.exitCode = 1;
});
