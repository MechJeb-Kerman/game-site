/**
 * 论坛上线检查：确认主站的 /forum 正常，以及 forum.fishport.cn 这个自定义域有没有真的指到同一个 Worker。
 *
 *   node tools/check-forum-host.mjs                    # 默认检查 game-site.fishport.cn 与 forum.fishport.cn
 *   SITE=https://你的域名 FORUM=https://forum.你的域名 node tools/check-forum-host.mjs
 *   FORUM_USER=admin FORUM_PASS=... node tools/check-forum-host.mjs   # 额外验证两个子域共用登录态（会真登录一次）
 *
 * 只读：除了可选的登录之外，不改任何数据（登录只会插一条 session）。
 * 自定义域还没加时，论坛主机那一段会标 SKIP 并告诉你去哪加，不算失败。
 */
const SITE = (process.env.SITE || 'https://game-site.fishport.cn').replace(/\/$/, '');
const FORUM = (process.env.FORUM || 'https://forum.fishport.cn').replace(/\/$/, '');
let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}
function skipped(name, why) { skip++; console.log('  skip ' + name + '（' + why + '）'); }
async function probe(url, opt) {
  const o = opt || {};
  const init = { method: o.method || 'GET', redirect: o.redirect || 'manual', headers: {} };
  if (o.json !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(o.json); }
  if (o.cookie) init.headers.cookie = o.cookie;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return {
      ok: true, status: res.status, text: text,
      location: res.headers.get('location') || '',
      setCookie: (res.headers.getSetCookie ? res.headers.getSetCookie() : []).join(' ; ')
    };
  } catch (err) {
    return { ok: false, error: String((err && err.cause && err.cause.code) || (err && err.code) || err) };
  }
}
function isDnsError(r) { return !r.ok && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(r.error || ''); }

async function checkSite() {
  console.log('--- 主站 ' + SITE + ' 的 /forum ---');
  let r = await probe(SITE + '/forum');
  ok('/forum 200 且列出板块', r.ok && r.status === 200 && r.text.includes('综合讨论') && r.text.includes('攻略心得'), r.ok ? r.status : r.error);
  ok('论坛首页有「发新帖」入口（链接带 /forum 前缀，说明基址按主站算）', r.ok && r.text.includes('href="/forum/new"'), '');
  ok('论坛首页有搜索框', r.ok && r.text.includes('forum-search'), '');
  r = await probe(SITE + '/forum/new');
  ok('游客打开发帖页只有登录提示（且不签发一次性令牌）', r.ok && r.status === 200 && r.text.includes('forum-gate') && !r.text.includes('form_token'), r.ok ? r.status : r.error);
  r = await probe(SITE + '/forum/f/general');
  ok('板块页 200', r.ok && r.status === 200, r.ok ? r.status : r.error);
  r = await probe(SITE + '/forum/t/999999');
  ok('不存在的主题 404', r.ok && r.status === 404, r.ok ? r.status : r.error);
  r = await probe(SITE + '/forum/admin');
  ok('论坛后台未登录时 302 到登录页', r.ok && r.status === 302 && r.location.indexOf('/login?next=') === 0, r.ok ? r.status + ' ' + r.location : r.error);
  r = await probe(SITE + '/robots.txt');
  ok('robots 屏蔽 /forum/admin', r.ok && r.text.includes('Disallow: /forum/admin'), '');
  r = await probe(SITE + '/sitemap.xml');
  ok('sitemap 收录 /forum', r.ok && r.text.includes('<loc>') && /<loc>[^<]*\/forum<\/loc>/.test(r.text), '');
}

async function checkForumHost() {
  console.log('--- 论坛主机 ' + FORUM + ' ---');
  const home = await probe(FORUM + '/');
  if (isDnsError(home)) {
    skipped('论坛主机（自定义域）', '域名还没解析：Cloudflare → 该 Worker → Settings → Domains & Routes → Add → Custom Domain → forum.fishport.cn');
    return;
  }
  if (!home.ok) { skipped('论坛主机（自定义域）', '访问失败：' + home.error); return; }
  ok('根路径就是论坛首页（说明请求被内部重写成 /forum）', home.status === 200 && home.text.includes('综合讨论') && home.text.includes('攻略心得'), home.status);
  ok('页面里的论坛链接是相对根路径的（/f/…、/t/…，不是 /forum/f/…）',
    home.text.includes('href="/f/') && !home.text.includes('href="/forum/f/'), '');
  const board = await probe(FORUM + '/f/general');
  ok('板块页 200', board.ok && board.status === 200, board.ok ? board.status : board.error);
  const shared = await probe(FORUM + '/forum');
  ok('/forum 仍可达（公共前缀不会被重复重写）', shared.ok && shared.status === 200, shared.ok ? shared.status : shared.error);
  const css = await probe(FORUM + '/static/css/style.css');
  ok('/static 照样出静态资源', css.ok && css.status === 200, css.ok ? css.status : css.error);
  const admin = await probe(FORUM + '/forum/admin');
  ok('论坛后台未登录时 302 到登录页', admin.ok && admin.status === 302 && admin.location.indexOf('/login?next=') === 0, admin.ok ? admin.status + ' ' + admin.location : admin.error);
  const login = await probe(FORUM + '/login');
  ok('登录页 200', login.ok && login.status === 200, login.ok ? login.status : login.error);

  const user = process.env.FORUM_USER, pass = process.env.FORUM_PASS;
  if (!user || !pass) {
    skipped('两个子域共用登录态', '想验证就带 FORUM_USER / FORUM_PASS 再跑一次（会真登录一次、只多一条 session）');
    return;
  }
  console.log('--- 共用登录态（在论坛主机登录，去主站看是否已登录）---');
  const lg = await probe(FORUM + '/api/auth/login', { method: 'POST', json: { username: user, password: pass } });
  ok('在论坛主机登录成功', lg.ok && lg.status === 200, lg.ok ? lg.status + ' ' + lg.text.slice(0, 80) : lg.error);
  const m = /sid=([^;]+)/.exec(lg.setCookie || '');
  ok('会话 cookie 带上 COOKIE_DOMAIN（Domain=（.）你的域名）', !!m && /domain=/i.test(lg.setCookie), (lg.setCookie || '').slice(0, 140));
  if (!m) return;
  const me = await probe(SITE + '/api/me', { cookie: 'sid=' + m[1] });
  const u = me.ok ? (() => { try { return JSON.parse(me.text).user; } catch { return null; } })() : null;
  ok('拿着论坛主机的 cookie 访问主站 /api/me 也是登录态（两个子域共用会话）', !!u && u.username === user, me.ok ? me.text.slice(0, 100) : me.error);
}

async function main() {
  console.log('论坛上线检查（只读）');
  await checkSite();
  await checkForumHost();
  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项' + (skip ? '，跳过 ' + skip + ' 项' : ''));
  if (fail) process.exitCode = 1;
}
main().catch((err) => { console.error('检查脚本自身出错：', err); process.exitCode = 1; });
