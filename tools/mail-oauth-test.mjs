/**
 * 邮件与第三方登录的端到端验收（全程零外网）：
 *   起两个假服务端——假邮件 HTTP API、假 OAuth Provider（GitHub/Google 各一套端点），
 *   再把站点指过去（MAIL_API_URL + OAUTH_<PROVIDER>_*_URL），完整走一遍：
 *     绑定邮箱 → 收到验证信 → 点链接 → 已验证
 *     找回密码 → 收到重置信 → 重设密码 → 新密码能登、旧密码不能登
 *     GitHub / Google 授权 → 回调 → 建号 → 同一个身份再登不重复建号 → 解绑
 *     state 不匹配被拒；后台「集成自检」面板如实显示邮件通道与两个 Provider 的配置状态
 *
 *   node tools/mail-oauth-test.mjs         # Express：脚本自己起一个 PORT=3101 的服务，跑完关掉
 *   node tools/worker-mail-oauth-test.mjs  # Workers + D1（同一套断言）
 *
 * 说明：Express 那个临时服务连的还是仓库的 data/games.db（开发服务空闲时跑没问题）；
 * 会留下两个测试账号与相应操作日志，想彻底干净就停服删库重启。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}
export function summary() { return { pass: pass, fail: fail }; }

/** 假邮件 API + 假 OAuth Provider；返回 env：站点该配的环境变量 */
export async function startFakes() {
  const mails = [];
  const hits = [];
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const readBody = (req) => new Promise((r) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks).toString('utf8')));
  });

  /* 假邮件服务端：接受任何 POST（对格式不挑），把信记下来；GET /_mails 取回 */
  const mailSrv = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && u.pathname === '/_mails') return json(200, mails);
    let msg = null;
    try { msg = JSON.parse(raw); } catch { msg = { text: raw }; }
    msg = msg || {};
    const to = Array.isArray(msg.to) ? String(msg.to[0] || '') : String(msg.to || '');
    mails.push({
      to: to, from: String(msg.from || ''), subject: String(msg.subject || ''),
      text: String(msg.text || ''), html: String(msg.html || ''),
      auth: req.headers.authorization || '', at: Date.now()
    });
    /* 用 subject 认类型：验证信 / 重置信 */
    const last = mails[mails.length - 1];
    last.tag = last.subject.indexOf('验证') >= 0 ? 'verify' : (last.subject.indexOf('重置') >= 0 ? 'reset' : 'other');
    return json(200, { id: 'fake-' + mails.length });
  });

  /* 假 OAuth Provider：GitHub 与 Google 的 authorize / token / profile 端点 */
  const provSrv = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    hits.push({ path: path, method: req.method, body: raw, authorization: req.headers.authorization || '' });
    const send = (code, body, headers) => {
      res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, headers || {}));
      res.end(body);
    };
    if (path === '/login/oauth/authorize' || path === '/google/authorize') {
      const redirect = u.searchParams.get('redirect_uri') || '';
      const state = u.searchParams.get('state') || '';
      const code = path === '/google/authorize' ? 'g-code' : 'gh-code';
      const sep = redirect.indexOf('?') >= 0 ? '&' : '?';
      return send(302, '', { 'content-type': 'text/plain', location: redirect + sep + 'code=' + code + '&state=' + encodeURIComponent(state) });
    }
    if (path === '/login/oauth/access_token') return send(200, '{"access_token":"gh-token","token_type":"bearer"}');
    if (path === '/google/token') return send(200, '{"access_token":"g-token","token_type":"Bearer"}');
    /* 故意只给 login 不给 email：逼它去读 EMAILS_URL */
    if (path === '/user') return send(200, '{"id":987654,"login":"gh_tester","name":"GitHub 测试"}');
    if (path === '/user/emails') return send(200, '[{"email":"gh-primary@example.com","primary":true,"verified":true}]');
    if (path === '/google/userinfo') return send(200, '{"sub":"g-777","name":"Google 测试","email":"gtest@example.com"}');
    return send(404, '{"error":"not_found"}');
  });

  const mailPort = await listen(mailSrv);
  const provPort = await listen(provSrv);
  const mailUrl = 'http://127.0.0.1:' + mailPort + '/';
  const prov = 'http://127.0.0.1:' + provPort;
  const env = {
    MAIL_API_URL: mailUrl,
    MAIL_API_KEY: 'fake-mail-key',
    MAIL_FROM: '趣玩小游戏 <noreply@test.local>',
    GITHUB_CLIENT_ID: 'gh-test-id',
    GITHUB_CLIENT_SECRET: 'gh-test-secret',
    OAUTH_GITHUB_AUTHORIZE_URL: prov + '/login/oauth/authorize',
    OAUTH_GITHUB_TOKEN_URL: prov + '/login/oauth/access_token',
    OAUTH_GITHUB_USER_URL: prov + '/user',
    OAUTH_GITHUB_EMAILS_URL: prov + '/user/emails',
    GOOGLE_CLIENT_ID: 'g-test-id',
    GOOGLE_CLIENT_SECRET: 'g-test-secret',
    OAUTH_GOOGLE_AUTHORIZE_URL: prov + '/google/authorize',
    OAUTH_GOOGLE_TOKEN_URL: prov + '/google/token',
    OAUTH_GOOGLE_USER_URL: prov + '/google/userinfo'
  };
  return {
    env: env, mailUrl: mailUrl, provider: prov, mails: mails, hits: hits,
    close: async () => {
      await new Promise((r) => mailSrv.close(r));
      await new Promise((r) => provSrv.close(r));
    }
  };
}

/* ---------- 断言场景（Express 与 Workers 共用同一套，行为必须一致） ---------- */

function jar() { return new Map(); }
function absorb(j, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) j.set(first.slice(0, i), first.slice(i + 1));
  }
}
/** path 可以是相对 BASE 的路径，也可以是绝对地址（走假 Provider 时用） */
async function req(base, path, opt) {
  const o = opt || {};
  const headers = {};
  if (o.j && o.j.size) headers.cookie = [...o.j.entries()].map(([k, v]) => k + '=' + v).join('; ');
  let body;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  if (o.form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  const url = /^https?:/.test(path) ? path : base + path;
  const res = await fetch(url, { method: o.method || 'GET', headers: headers, body: body, redirect: o.redirect || 'follow' });
  if (o.j) absorb(o.j, res);
  const text = await res.text();
  return { status: res.status, text: text, location: res.headers.get('location') || '', type: res.headers.get('content-type') || '' };
}
function json(t) { try { return JSON.parse(t); } catch { return null; } }
function pick(re, t) { const m = String(t || '').match(re); return m ? m[1] : ''; }

export async function runScenario(base, fakes, opt) {
  const o = opt || {};
  const adminUser = o.adminUser || 'admin';
  const adminPass = o.adminPass || 'admin123';
  const STAMP = Date.now().toString(36);
  const mails = fakes.mails;
  let r;

  /* ---------- 1. 邮件：绑定邮箱 → 收信 → 点链接验证 ---------- */
  console.log('--- 邮件：绑定邮箱 → 验证 ---');
  const jarU = jar();
  const USER = 'mo' + STAMP;
  const EMAIL = USER + '@example.com';
  r = await req(base, '/api/auth/register', { method: 'POST', j: jarU, json: { username: USER, password: 'pass1234', display_name: '邮件测试' } });
  ok('注册测试账号', r.status === 201, r.status + ' ' + r.text.slice(0, 100));

  r = await req(base, '/account/email', { method: 'POST', j: jarU, form: { email: EMAIL }, redirect: 'manual' });
  ok('绑定邮箱后跳回账号页（配了邮件服务就不再给开发态直链）', r.status === 302 && r.location === '/account?ok=email', r.status + ' ' + r.location);

  const vmail = mails.filter((m) => m.tag === 'verify').pop();
  ok('假邮件服务端收到了验证信', !!vmail, JSON.stringify(mails.map((m) => m.tag)));
  ok('发信走 MAIL_API_URL，令牌用 MAIL_API_KEY 作 Bearer', !!vmail && vmail.auth === 'Bearer fake-mail-key', vmail && vmail.auth);
  ok('收件人就是刚绑定的邮箱', !!vmail && vmail.to === EMAIL, vmail && vmail.to);
  ok('发件人用 MAIL_FROM', !!vmail && vmail.from.indexOf('noreply@test.local') >= 0, vmail && vmail.from);
  const vtoken = pick(/\/verify-email\?token=([A-Za-z0-9_-]+)/, vmail ? vmail.text : '');
  ok('信里有验证链接', !!vtoken, (vmail ? vmail.text : '').slice(0, 140));
  r = await req(base, '/verify-email?token=' + vtoken, { j: jarU });
  ok('点链接验证成功', r.status === 200 && r.text.includes('邮箱验证成功'), r.status);
  r = await req(base, '/api/me', { j: jarU });
  const meV = (json(r.text) || {}).user || {};
  ok('/api/me 显示邮箱已验证', Number(meV.email_verified) === 1 && meV.email === EMAIL, r.text.slice(0, 140));

  /* ---------- 2. 邮件：找回密码 → 重置 → 新密码登录 ---------- */
  console.log('--- 邮件：找回密码 → 重置 ---');
  r = await req(base, '/forgot', { method: 'POST', form: { account: USER }, redirect: 'follow' });
  ok('申请找回密码成功', r.status === 200 && r.text.includes('如果这个账号存在'), r.status + ' ' + r.text.slice(0, 120));
  const rmail = mails.filter((m) => m.tag === 'reset').pop();
  ok('假邮件服务端收到了重置信', !!rmail, JSON.stringify(mails.map((m) => m.tag)));
  const rtoken = pick(/\/reset\?token=([A-Za-z0-9_-]+)/, rmail ? rmail.text : '');
  ok('重置信里有重置链接', !!rtoken, (rmail ? rmail.text : '').slice(0, 140));

  r = await req(base, '/reset?token=' + rtoken);
  ok('重置页能打开并带着 token', r.status === 200 && r.text.includes(rtoken), r.status);
  r = await req(base, '/reset', { method: 'POST', form: { token: rtoken, password: 'newpass1234', password2: 'newpass1234' }, redirect: 'follow' });
  ok('重设密码成功', r.status === 200 && r.text.includes('密码已重置'), r.status);
  r = await req(base, '/api/auth/login', { method: 'POST', j: jar(), json: { username: USER, password: 'newpass1234' } });
  ok('新密码能登录', r.status === 200, r.status + ' ' + r.text.slice(0, 100));
  r = await req(base, '/api/auth/login', { method: 'POST', j: jar(), json: { username: USER, password: 'pass1234' } });
  ok('旧密码不能登录了', r.status === 401, r.status);
  r = await req(base, '/forgot', { method: 'POST', form: { account: 'nobody' + STAMP }, redirect: 'follow' });
  ok('账号不存在时也是同一套说辞（不泄露注册情况）', r.status === 200 && r.text.includes('如果这个账号存在') && r.text.indexOf(USER) < 0, r.status);

  /* ---------- 3. 第三方登录：GitHub ---------- */
  console.log('--- 第三方登录：GitHub ---');
  const ghFlow = async (j, next) => {
    const a = await req(base, '/auth/github?next=' + encodeURIComponent(next), { j: j, redirect: 'manual' });
    if (a.status !== 302) return { step: 'authorize', res: a, authorize: a };
    const b = await req(base, a.location, { redirect: 'manual' });
    if (b.status !== 302) return { step: 'provider', res: b, authorize: a, provider: b };
    const c = await req(base, b.location, { j: j, redirect: 'manual' });
    return { step: 'ok', res: c, authorize: a, provider: b };
  };
  const jarG = jar();
  let flow = await ghFlow(jarG, '/account');
  ok('点 GitHub 登录 → 302 到假 Provider 的授权页', flow.authorize.status === 302 && flow.authorize.location.indexOf(fakes.provider + '/login/oauth/authorize') === 0, flow.authorize.status + ' ' + flow.authorize.location.slice(0, 120));
  ok('授权地址带 client_id 与随机 state', flow.authorize.location.includes('client_id=gh-test-id') && /state=[0-9a-f]{16,}/.test(flow.authorize.location), flow.authorize.location.slice(0, 180));
  ok('假 Provider 把浏览器送回回调（带 code + state）', flow.provider && flow.provider.status === 302 && flow.provider.location.indexOf('/auth/github/callback?code=gh-code') >= 0, flow.provider ? flow.provider.status + ' ' + flow.provider.location.slice(0, 140) : flow.step);
  ok('回调登录成功并跳回 next', flow.res.status === 302 && flow.res.location === '/account', flow.res.status + ' ' + flow.res.location);
  r = await req(base, '/api/me', { j: jarG });
  const meG = (json(r.text) || {}).user || {};
  ok('GitHub 登录后是登录态', !!meG.id, r.text.slice(0, 140));
  r = await req(base, '/account', { j: jarG });
  ok('账号页显示已绑定的 GitHub 身份', r.status === 200 && r.text.includes('987654') && r.text.includes('GitHub'), r.status);
  const tokHit = fakes.hits.filter((h) => h.path === '/login/oauth/access_token').pop();
  ok('换 token 的请求带上了 client_secret 与 code', !!tokHit && tokHit.body.includes('client_secret=gh-test-secret') && tokHit.body.includes('code=gh-code'), tokHit ? tokHit.body.slice(0, 160) : '');
  const emailHit = fakes.hits.filter((h) => h.path === '/user/emails').pop();
  ok('资料里没有邮箱时会去读 EMAILS_URL', !!emailHit, JSON.stringify(fakes.hits.map((h) => h.path)));

  const jarG2 = jar();
  flow = await ghFlow(jarG2, '/');
  r = await req(base, '/api/me', { j: jarG2 });
  const meG2 = (json(r.text) || {}).user || {};
  ok('同一个 GitHub 身份再登会复用账号（不重复建号）', !!meG2.id && meG2.id === meG.id, 'first=' + meG.id + ' second=' + meG2.id);

  r = await req(base, '/account/unlink', { method: 'POST', j: jarG, form: { provider: 'github' }, redirect: 'manual' });
  ok('能解绑 GitHub', r.status === 302 && r.location === '/account?ok=unlink', r.status + ' ' + r.location);
  r = await req(base, '/account', { j: jarG });
  ok('解绑后账号页不再显示这个身份', r.status === 200 && !r.text.includes('987654'), r.status);

  /* ---------- 4. 第三方登录：Google ---------- */
  console.log('--- 第三方登录：Google ---');
  const jarGG = jar();
  const ga = await req(base, '/auth/google?next=/', { j: jarGG, redirect: 'manual' });
  ok('点 Google 登录 → 302 到假 Provider', ga.status === 302 && ga.location.indexOf(fakes.provider + '/google/authorize') === 0, ga.status + ' ' + ga.location.slice(0, 140));
  const gb = await req(base, ga.location, { redirect: 'manual' });
  ok('假 Google 把浏览器送回回调', gb.status === 302 && gb.location.indexOf('/auth/google/callback?code=g-code') >= 0, gb.status + ' ' + gb.location.slice(0, 140));
  const gc = await req(base, gb.location, { j: jarGG, redirect: 'manual' });
  ok('Google 回调登录成功', gc.status === 302, gc.status + ' ' + gc.location);
  r = await req(base, '/api/me', { j: jarGG });
  const meGG = (json(r.text) || {}).user || {};
  ok('Google 账号建好了', !!meGG.id, r.text.slice(0, 140));
  ok('Google 资料里的邮箱被存下来并视为已验证', meGG.email === 'gtest@example.com' && Number(meGG.email_verified) === 1, JSON.stringify({ email: meGG.email, v: meGG.email_verified }));

  /* ---------- 5. 第三方登录：异常路径 ---------- */
  console.log('--- 第三方登录：异常路径 ---');
  r = await req(base, '/auth/github/callback?code=x&state=bogus', { j: jar(), redirect: 'manual' });
  ok('state 不匹配时拒绝登录', r.status === 400 && r.text.includes('登录状态校验失败'), r.status + ' ' + r.text.slice(0, 140));
  r = await req(base, '/auth/nosuch', { redirect: 'manual' });
  ok('没开启的 Provider 给 404 提示页', r.status === 404 && r.text.includes('没有开启'), r.status);

  /* ---------- 6. 后台「集成自检」面板 ---------- */
  console.log('--- 后台集成自检 ---');
  const jarAd = jar();
  r = await req(base, '/api/auth/login', { method: 'POST', j: jarAd, json: { username: adminUser, password: adminPass } });
  ok('站长登录', r.status === 200, r.status + ' ' + r.text.slice(0, 100));
  r = await req(base, '/admin', { j: jarAd });
  const page = r.text;
  ok('后台有「集成自检」区', r.status === 200 && page.includes('集成自检'), r.status);
  ok('邮件行显示走自建 HTTP 邮件服务并给出 endpoint', page.includes('自建 HTTP 邮件服务') && page.indexOf(fakes.mailUrl) >= 0, '');
  ok('GitHub 行显示 client_id 与 secret 都已配置', /GitHub[\s\S]{0,700}?client_id ✅[\s\S]{0,160}?secret ✅/.test(page), '');
  ok('GitHub 回调地址与站点一致', page.indexOf(base + '/auth/github/callback') >= 0, '');
  ok('Google 行也显示 client_id 与 secret 都已配置', /Google[\s\S]{0,700}?client_id ✅[\s\S]{0,160}?secret ✅/.test(page), '');
  ok('操作日志里能看到 oauth.login 与 user.email', page.includes('oauth.login') && page.includes('user.email'), '');
}

/* ---------- 直接 node 跑：Express 版（自己起临时服务） ---------- */

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const fakes = await startFakes();
    const PORT = Number(process.env.PORT || 3101);
    const base = 'http://127.0.0.1:' + PORT;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, fakes.env, { PORT: String(PORT), SITE_ORIGIN: base }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { const res = await fetch(base + '/'); if (res.status === 200) { up = true; break; } } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) {
      console.error('临时 Express 服务没能起来（PORT=' + PORT + '）');
      child.kill();
      await fakes.close();
      process.exit(2);
    }
    console.log('临时 Express 服务已就绪：' + base);
    console.log('假邮件服务端：' + fakes.mailUrl + '　假 OAuth Provider：' + fakes.provider);
    await runScenario(base, fakes, {});
    const s = summary();
    console.log('');
    console.log('通过 ' + s.pass + ' 项，失败 ' + s.fail + ' 项');
    child.kill();
    await fakes.close();
    process.exit(s.fail ? 1 : 0);
  })().catch(async (err) => {
    console.error('脚本异常：', err);
    process.exit(2);
  });
}
