/* 账号系统验收测试：注册 / 登录 / 退出 / 评分 / 收藏 / 评论 / 投稿 / 后台审核。
 * 前置条件：站点已在 BASE 上跑起来（默认 http://127.0.0.1:3000）。
 *   node tools/account-test.mjs      # 或 pnpm test:account
 *
 * 注意：会真的写库（建 tester1 / tester2 两个账号、一条投稿、一条评论、一次评分），
 * 并留下一条「测试小游戏」投稿（最后被下架）。想彻底回到干净状态：
 * 停掉服务 → 删除 data/games.db → 重新启动。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
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
  const res = await fetch(BASE + path, { method: o.method || 'GET', headers, body, redirect: o.redirect || 'follow' });
  if (o.j) absorb(o.j, res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') || '', headers: res.headers };
}
function json(t) { try { return JSON.parse(t); } catch { return null; } }

async function main() {
  console.log('--- 游客态 ---');
  let r = await req('/');
  ok('首页 200 且含登录入口', r.status === 200 && r.text.includes('登录'), r.status);
  r = await req('/login');
  ok('登录页 200 且 noindex', r.status === 200 && r.text.includes('noindex,follow'), r.status);
  r = await req('/submit', { redirect: 'manual' });
  ok('未登录访问 /submit 跳登录', r.status === 302 && r.location === '/login?next=%2Fsubmit', r.status + ' ' + r.location);
  r = await req('/admin', { redirect: 'manual' });
  ok('未登录访问 /admin 跳登录', r.status === 302 && r.location.startsWith('/login?next='), r.status + ' ' + r.location);
  r = await req('/sitemap.xml');
  ok('sitemap 200', r.status === 200 && r.text.includes('<urlset'), r.status);
  r = await req('/robots.txt');
  ok('robots 屏蔽后台', r.text.includes('Disallow: /admin') && r.text.includes('Disallow: /favorites'), r.text.slice(0, 60));

  r = await req('/api/me');
  ok('游客 /api/me 返回 null', r.status === 200 && json(r.text) && json(r.text).user === null, r.text);
  r = await req('/api/games/2048/rate', { method: 'POST', json: { stars: 5 } });
  ok('游客评分 401', r.status === 401 && json(r.text).error === 'login_required', r.status + ' ' + r.text);
  r = await req('/api/games/2048/favorite', { method: 'POST' });
  ok('游客收藏 401', r.status === 401 && json(r.text).error === 'login_required', r.status);
  r = await req('/api/games/2048/comments', { method: 'POST', json: { body: 'hi' } });
  ok('游客评论 401', r.status === 401, r.status);

  console.log('--- 注册 / 登录 ---');
  const u1 = jar();
  r = await req('/api/auth/register', { method: 'POST', j: u1, json: { username: 'tester1', password: 'pass1234', display_name: '测试君' } });
  const reg1 = json(r.text);
  ok('注册成功 201', r.status === 201 && reg1 && reg1.user.username === 'tester1' && reg1.user.name === '测试君', r.status + ' ' + r.text);
  ok('注册后种下 sid', u1.has('sid'), [...u1.keys()].join(','));
  ok('返回体不含口令字段', r.text.indexOf('pass_hash') === -1 && r.text.indexOf('pass_salt') === -1, r.text);
  r = await req('/api/me', { j: u1 });
  ok('登录态 /api/me', json(r.text).user && json(r.text).user.username === 'tester1');
  r = await req('/api/auth/register', { method: 'POST', json: { username: 'tester1', password: 'pass1234' } });
  ok('重名注册 409', r.status === 409 && json(r.text).error === 'taken', r.status);
  r = await req('/api/auth/register', { method: 'POST', json: { username: 'a', password: 'pass1234' } });
  ok('非法用户名 400', r.status === 400, r.status + ' ' + r.text);
  r = await req('/api/auth/register', { method: 'POST', json: { username: 'tester9', password: '123' } });
  ok('短密码 400', r.status === 400, r.status);
  r = await req('/api/auth/login', { method: 'POST', json: { username: 'tester1', password: 'wrongpass' } });
  ok('错密码 401', r.status === 401 && json(r.text).error === 'bad_credentials', r.status);

  console.log('--- 评分 ---');
  r = await req('/api/games/2048/rate', { method: 'POST', j: u1, json: { stars: 4 } });
  let d = json(r.text);
  ok('首评 4 星', r.status === 200 && d.stars === 4 && d.count === 1 && Number(d.rating) === 4, r.status + ' ' + r.text);
  r = await req('/api/games/2048/rate', { method: 'POST', j: u1, json: { stars: 2 } });
  d = json(r.text);
  ok('改票后仍 1 人评分、均分 2', d.count === 1 && Number(d.rating) === 2 && d.isNew === false, r.text);
  r = await req('/api/games/2048/rate', { method: 'POST', j: u1, json: { stars: 9 } });
  ok('非法星数 400', r.status === 400, r.status);
  r = await req('/api/games/2048/rate', { method: 'POST', j: u1, json: { stars: 5 } });
  r = await req('/game/2048', { j: u1 });
  ok('详情页显示评分与登录态', r.text.includes('5.0') && r.text.includes('1 人评分') && r.text.includes('已评 5 星'), 'rating block');
  ok('详情页有评论面板与收藏按钮', r.text.includes('id="cmtPanel"') && r.text.includes('id="favBtn"') && r.text.includes('data-auth="1"'));
  const anon = await req('/game/2048');
  ok('游客详情页是只读星级', anon.text.includes('stars locked') && anon.text.includes('data-auth="0"') && anon.text.includes('后即可评分'));

  console.log('--- 收藏 ---');
  r = await req('/api/games/2048/favorite', { method: 'POST', j: u1 });
  d = json(r.text);
  ok('收藏成功', r.status === 200 && d.favorited === true && d.count === 1, r.text);
  r = await req('/favorites', { j: u1 });
  ok('收藏页列出 2048', r.status === 200 && r.text.includes('2048') && r.text.includes('你收藏了 1 款'), r.status);
  r = await req('/api/games/2048/favorite', { method: 'POST', j: u1 });
  d = json(r.text);
  ok('再点取消收藏', d.favorited === false && d.count === 0, r.text);
  await req('/api/games/2048/favorite', { method: 'POST', j: u1 });
  r = await req('/api/games/nope/favorite', { method: 'POST', j: u1 });
  ok('收藏不存在的游戏 404', r.status === 404, r.status + ' ' + r.text);

  console.log('--- 评论 ---');
  r = await req('/api/games/2048/comments', { method: 'POST', j: u1, json: { body: '  这个游戏   挺好玩的  ' } });
  d = json(r.text);
  ok('发评论成功且折叠空白', r.status === 200 && d.body === '这个游戏 挺好玩的' && d.name === '测试君', r.text);
  const cid = d.id;
  r = await req('/api/games/2048/comments', { method: 'POST', j: u1, json: { body: '再来一条' } });
  ok('10 秒内连发 429', r.status === 429 && json(r.text).error === 'too_fast', r.status + ' ' + r.text);
  r = await req('/game/2048');
  ok('游客能看到评论', r.text.includes('这个游戏 挺好玩的') && r.text.includes('测试君') && r.text.includes('id="cmtCount"'));
  const u2 = jar();
  await req('/api/auth/register', { method: 'POST', j: u2, json: { username: 'tester2', password: 'pass1234' } });
  r = await req('/api/games/2048/comments', { method: 'POST', j: u2, json: { body: '   ' } });
  ok('空评论 400', r.status === 400 && json(r.text).error === 'empty', r.status + ' ' + r.text);
  r = await req('/api/games/2048/comments', { method: 'POST', j: u2, json: { body: 'x'.repeat(501) } });
  ok('超长评论 400', r.status === 400 && json(r.text).error === 'too_long', r.status);

  console.log('--- 投稿 + 后台 ---');
  r = await req('/submit', { j: u2 });
  ok('登录后可打开投稿页', r.status === 200 && r.text.includes('投稿游戏') && r.text.includes('提交审核'), r.status);
  r = await req('/submit', { method: 'POST', j: u2, form: { title: '测试小游戏', subtitle: '临时投稿', game_url: '/games/2048/index.html', category: 'puzzle', width: '600', height: '700', emoji: '🧪', license: '投稿', tags: '测试, 临时', description: '这是一条自动化测试投稿。' } });
  const m = r.text.match(/编号 <b>([^<]+)<\/b>/);
  ok('投稿成功并返回编号', r.status === 200 && !!m, r.status + ' ' + r.text.slice(0, 120));
  const sub = m ? m[1] : '';
  r = await req('/submit', { method: 'POST', j: u2, form: { title: 'x', game_url: 'javascript:alert(1)' } });
  ok('非法游戏地址被拒', r.status === 400 && r.text.includes('auth-err'), r.status);
  r = await req('/games');
  ok('待审核游戏不出现在列表', r.status === 200 && !r.text.includes('测试小游戏'));
  r = await req('/admin', { j: u2, redirect: 'manual' });
  ok('普通用户访问后台被踢去登录', r.status === 302, r.status + ' ' + r.location);
  r = await req('/admin/games/' + sub + '/status', { method: 'POST', j: u2, form: { status: '1' } });
  ok('普通用户改状态 403', r.status === 403, r.status);

  const adm = jar();
  r = await req('/login', { method: 'POST', j: adm, form: { username: 'admin', password: 'admin123', next: '/admin' }, redirect: 'manual' });
  ok('站长登录 302', r.status === 302 && r.location === '/admin', r.status + ' ' + r.location);
  r = await req('/admin', { j: adm });
  ok('后台页 200 且列出待审投稿', r.status === 200 && r.text.includes('管理后台') && r.text.includes('测试小游戏') && r.text.includes('待审核'), r.status);
  ok('后台有统计块', r.text.includes('注册用户') && r.text.includes('评论') && r.text.includes('收藏'));
  ok('后台评论表格里有那条评论', r.text.includes('这个游戏 挺好玩的') && r.text.includes('/admin/comments/' + cid + '/status'));
  r = await req('/admin/games/' + sub + '/status', { method: 'POST', j: adm, form: { status: '1' }, redirect: 'manual' });
  ok('通过上架 302 回后台', r.status === 302 && r.location === '/admin', r.status);
  r = await req('/games');
  ok('上架后出现在全部游戏', r.text.includes('测试小游戏'));
  r = await req('/game/' + sub);
  ok('上架后详情页可访问', r.status === 200 && r.text.includes('测试小游戏'), r.status);
  r = await req('/admin/games/' + sub + '/status', { method: 'POST', j: adm, form: { status: '0' }, redirect: 'manual' });
  r = await req('/games');
  ok('下架后从列表消失', !r.text.includes('测试小游戏'));
  r = await req('/admin/games/nope/status', { method: 'POST', j: adm, form: { status: '1' } });
  ok('操作不存在的游戏 404', r.status === 404, r.status);
  r = await req('/admin/comments/' + cid + '/status', { method: 'POST', j: adm, form: { status: '0' }, redirect: 'manual' });
  ok('隐藏评论 302', r.status === 302, r.status);
  r = await req('/game/2048');
  ok('隐藏后玩家看不到评论', !r.text.includes('这个游戏 挺好玩的'));
  r = await req('/admin/comments/' + cid + '/status', { method: 'POST', j: adm, form: { status: '1' } });
  r = await req('/game/2048');
  ok('恢复后又能看到', r.text.includes('这个游戏 挺好玩的'));

  console.log('--- 退出 ---');
  r = await req('/api/auth/logout', { method: 'POST', j: u1 });
  ok('退出接口 ok', r.status === 200 && json(r.text).ok === true, r.status);
  r = await req('/api/me', { j: u1 });
  ok('退出后 /api/me 归 null', json(r.text).user === null, r.text);
  r = await req('/favorites', { j: u1, redirect: 'manual' });
  ok('退出后收藏页跳登录', r.status === 302, r.status);
  r = await req('/login', { method: 'POST', j: u1, form: { username: 'tester1', password: 'wrong' } });
  ok('页面登录失败 401 且回显错误', r.status === 401 && r.text.includes('用户名或密码不对'), r.status);
  r = await req('/login', { method: 'POST', j: u1, form: { username: 'tester1', password: 'pass1234', next: '//evil.com' }, redirect: 'manual' });
  ok('开放重定向被挡成 /', r.status === 302 && r.location === '/', r.status + ' ' + r.location);
  r = await req('/api/me', { j: u1 });
  ok('页面登录成功', json(r.text).user && json(r.text).user.username === 'tester1');

  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
