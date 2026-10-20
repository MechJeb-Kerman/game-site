/**
 * OAuth 网关 + 微信登录自测（tools/oauth-gateway-test.mjs）
 *
 * 跑法：node tools/oauth-gateway-test.mjs
 *
 * 说明：
 *   - 全程只访问本机假服务（随机高端口）与本地起的站点，不发任何外网请求；
 *   - 站点用随机高端口起，不碰 3000 / 4400，收尾只杀自己 spawn 的那个进程；
 *   - 覆盖：未配置时行为不变、GitHub/Google 直连格式、微信直连扫码、网关模式往返、
 *     签名与重放拒绝、profile 归一化、worker/oauth.js 镜像一致性、端到端 state 校验；
 *   - 结束时打印「通过 N 项，失败 M 项」，全过 exit 0，有失败 exit 1。
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as oauth from '../src/oauth.js';
import * as workerOauth from '../worker/oauth.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://game.example.com';
const CALLBACK = (p) => ORIGIN + '/auth/' + p + '/callback';

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
    return true;
  }
  fail += 1;
  console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : '  → ' + extra));
  return false;
}

function group(title) {
  console.log('\n== ' + title + ' ==');
}

export function summary() {
  return { pass, fail };
}

/* ---------------- 环境变量小工具 ---------------- */

const ENV_KEYS = [
  'NODE_ENV', 'OAUTH_DEV',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'WECHAT_APP_ID', 'WECHAT_APP_SECRET',
  'OAUTH_GATEWAY_URL', 'OAUTH_GATEWAY_SECRET', 'OAUTH_GATEWAY_PROVIDERS',
  'OAUTH_GITHUB_AUTHORIZE_URL', 'OAUTH_GITHUB_TOKEN_URL', 'OAUTH_GITHUB_USER_URL', 'OAUTH_GITHUB_EMAILS_URL',
  'OAUTH_GOOGLE_AUTHORIZE_URL', 'OAUTH_GOOGLE_TOKEN_URL', 'OAUTH_GOOGLE_USER_URL',
  'OAUTH_WECHAT_AUTHORIZE_URL', 'OAUTH_WECHAT_TOKEN_URL', 'OAUTH_WECHAT_USER_URL'
];

/** 先清空全部相关变量再打补丁，返回恢复函数 */
function applyEnv(patch) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) {
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** 默认基线：生产环境、什么都没配 */
function baseEnv(extra) {
  const p = {};
  for (const k of ENV_KEYS) p[k] = undefined;
  p.NODE_ENV = 'production';
  return Object.assign(p, extra || {});
}

/** 给子进程的环境：本机环境去掉全部 oauth 相关键，避免父进程的测试环境漏进去 */
function siteEnv() {
  const out = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OAUTH_|GITHUB_|GOOGLE_|WECHAT_)/.test(k)) continue;
    if (k === 'NODE_ENV' || k === 'SITE_ORIGIN' || k === 'PORT' || k === 'ADMIN_USER' || k === 'ADMIN_PASS') continue;
    out[k] = process.env[k];
  }
  out.NODE_ENV = 'production';
  return out;
}

/* ---------------- 会话 cookie 罐 ---------------- */

function jar() {
  const store = new Map();
  return {
    save(res, origin) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const raw of list) {
        const semi = raw.indexOf(';');
        const pair = semi < 0 ? raw : raw.slice(0, semi);
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '' || /max-age=0/i.test(raw)) store.delete(origin + '|' + k);
        else store.set(origin + '|' + k, v);
      }
    },
    header(origin) {
      const out = [];
      for (const [k, v] of store) if (k.indexOf(origin + '|') === 0) out.push(k.slice(origin.length + 1) + '=' + v);
      return out.join('; ');
    },
    get(origin, name) {
      return store.get(origin + '|' + name);
    }
  };
}

/** 取一页（手动跟重定向），j 给定时自动带 cookie 并收 cookie */
async function get(url, j) {
  const origin = new URL(url).origin;
  const opt = { redirect: 'manual' };
  if (j) {
    const c = j.header(origin);
    if (c) opt.headers = { cookie: c };
  }
  const res = await fetch(url, opt);
  if (j) j.save(res, origin);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') || '' };
}

/** 一路跟到底（含跨服务重定向），返回最后那一页 */
async function flow(j, start, hops = 6) {
  let url = start;
  const trail = [];
  for (let i = 0; i < hops; i += 1) {
    const step = await get(url, j);
    trail.push(step.status + ' ' + url);
    if (step.status >= 300 && step.status < 400 && step.location) {
      url = new URL(step.location, url).toString();
      continue;
    }
    return { status: step.status, text: step.text, url, trail };
  }
  throw new Error('重定向跳数过多：' + trail.join(' -> '));
}

/* ---------------- 本机假服务 ---------------- */

function freePort() {
  return new Promise((done, bad) => {
    const s = net.createServer();
    s.on('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => done(p));
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function redirect(res, to) {
  res.writeHead(302, { location: to });
  res.end('');
}

/** 独立实现的网关侧校验（和生产代码不共享任何函数，用来互相印证） */
function verifyGateway(state, headers, payload) {
  const ts = String(headers['x-oauth-ts'] || '');
  const nonce = String(headers['x-oauth-nonce'] || '');
  const sig = String(headers['x-oauth-signature'] || '');
  if (!payload || !payload.provider || !payload.code) return { ok: false, error: 'unsupported_provider' };
  if (!state.gwSecret) return { ok: true, signed: false };
  if (!ts || !nonce || !sig) return { ok: false, error: 'bad_signature' };
  const want = createHmac('sha256', state.gwSecret)
    .update([ts, nonce, payload.provider, payload.code, payload.redirect_uri].join('\n'), 'utf8')
    .digest('hex');
  if (want !== sig) return { ok: false, error: 'bad_signature' };
  const now = Date.now();
  const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(ms) || Math.abs(now - ms) > 300 * 1000) return { ok: false, error: 'stale_ts' };
  if (state.gwNonces.has(nonce)) return { ok: false, error: 'replayed' };
  state.gwNonces.set(nonce, now);
  return { ok: true, signed: true };
}

function startFake() {
  const state = {
    hits: [],
    wxMode: 'ok', wxUserMode: 'ok', wxUnionid: true,
    ghEmail: true,
    gwSecret: 'gw-secret', gwErr: '', gwNonces: new Map(), gwVerify: null
  };
  state.lastHit = (path) => {
    for (let i = state.hits.length - 1; i >= 0; i -= 1) if (state.hits[i].path === path) return state.hits[i];
    return null;
  };
  state.reset = () => {
    state.hits = [];
    state.wxMode = 'ok';
    state.wxUserMode = 'ok';
    state.wxUnionid = true;
    state.ghEmail = true;
    state.gwSecret = 'gw-secret';
    state.gwErr = '';
    state.gwNonces = new Map();
    state.gwVerify = null;
  };
  state.verify = (headers, payload) => verifyGateway(state, headers, payload);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const q = u.searchParams;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.hits.push({
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(q),
        headers: req.headers,
        body
      });
      const back = (code) => {
        const b = new URL(q.get('redirect_uri'));
        b.searchParams.set('code', code);
        b.searchParams.set('state', q.get('state') || '');
        return redirect(res, b.toString());
      };
      const p = u.pathname;
      if (p === '/wechat/qrconnect') return back('wx-code-1');
      if (p === '/wechat/token') {
        if (state.wxMode === 'errcode') return json(res, 200, { errcode: 40029, errmsg: 'invalid code' });
        const out = { access_token: 'wx-access-token', openid: 'WXOPENID123', scope: 'snsapi_login' };
        if (state.wxUnionid) out.unionid = 'WXUNIONID9';
        return json(res, 200, out);
      }
      if (p === '/wechat/userinfo') {
        if (state.wxUserMode === 'fail') return json(res, 200, { errcode: 40003, errmsg: 'invalid openid' });
        return json(res, 200, { openid: 'WXOPENID123', nickname: '微信测试用户', headimgurl: 'https://wx.example/avatar.png', unionid: 'WXUNIONID9' });
      }
      if (p === '/github/authorize') return back('gh-code-1');
      if (p === '/github/token') return json(res, 200, { access_token: 'gh-token', token_type: 'bearer', scope: 'read:user,user:email' });
      if (p === '/github/user') {
        return json(res, 200, {
          id: 123, login: 'octocat', name: 'The Octocat',
          email: state.ghEmail ? 'octo@example.com' : null,
          avatar_url: 'https://avatars.example/u/123'
        });
      }
      if (p === '/github/emails') {
        return json(res, 200, [
          { email: 'old@example.com', primary: false, verified: false },
          { email: 'octo@example.com', primary: true, verified: true }
        ]);
      }
      if (p === '/google/authorize') return back('g-code-1');
      if (p === '/google/token') return json(res, 200, { access_token: 'g-token', token_type: 'Bearer', expires_in: 3599 });
      if (p === '/google/userinfo') return json(res, 200, { sub: 'g-777', name: 'Google User', email: 'g@example.com', picture: 'https://g.example/p.png' });
      if (p === '/gateway/authorize') return back('gw-code-1');
      if (p === '/gateway/token') {
        let payload = null;
        try { payload = JSON.parse(body); } catch (e) { payload = null; }
        const v = verifyGateway(state, req.headers, payload);
        state.gwVerify = v;
        if (!v.ok) return json(res, 400, { error: v.error });
        if (state.gwErr === 'nonjson') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>oops</html>');
        }
        if (state.gwErr === 'no_profile') return json(res, 400, { error: 'no_profile' });
        if (state.gwErr === 'replayed') return json(res, 400, { error: 'replayed' });
        if (state.gwErr === 'weird') return json(res, 400, { error: 'gateway_internal_42' });
        if (state.gwErr === 'noid') return json(res, 200, { provider: 'github', profile: { username: 'nobody' } });
        return json(res, 200, {
          provider: 'github',
          profile: { id: 'GWU-42', username: 'gwuser', displayName: '网关用户', email: 'gw@example.com', avatar: 'https://gw.example/a.png' }
        });
      }
      return json(res, 404, { error: 'not_found', path: p });
    });
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = 'http://127.0.0.1:' + server.address().port;
      state.close = () => new Promise((r) => server.close(r));
      done(state);
    });
  });
}

/** 起一个真站点（server.js，随机高端口），跑完只杀自己 spawn 的那个进程 */
async function withSite(env, fn) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign(siteEnv(), env, { PORT: String(port), SITE_ORIGIN: base }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  try {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(base + '/');
        if (r.status < 500) { up = true; break; }
      } catch (e) { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!up) throw new Error('站点 20 秒内没起来（退出码 ' + child.exitCode + '）：\n' + log.slice(-1500));
    await fn(base, log);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
}

/* ---------------- 一、未配置基线 ---------------- */

async function sectionBaseline() {
  group('一、什么都没配：现有行为不变，微信不出现');
  const restore = applyEnv(baseEnv());
  try {
    ok('PROVIDERS 顺序仍是 github,google,wechat', JSON.stringify(oauth.PROVIDERS) === JSON.stringify(['github', 'google', 'wechat']), JSON.stringify(oauth.PROVIDERS));
    ok('未配置时 enabledProviders() 不含微信', oauth.enabledProviders().every((p) => p.key !== 'wechat'), JSON.stringify(oauth.enabledProviders()));
    ok('生产环境无密钥：登录按钮列表为空（连演示登录都没有）', oauth.enabledProviders().length === 0, JSON.stringify(oauth.enabledProviders()));
    ok('providerEnabled(wechat) === false', oauth.providerEnabled('wechat') === false);
    ok('未配置时 authorizeUrl(wechat) 返回空串（不会拼出半截地址）', oauth.authorizeUrl('wechat', ORIGIN, 'st') === '', oauth.authorizeUrl('wechat', ORIGIN, 'st'));
    const r = await oauth.exchangeCode('wechat', ORIGIN, 'code-x');
    ok('未配置时 exchangeCode(wechat) → provider_disabled', r.error === 'provider_disabled', JSON.stringify(r));
    const m = oauth.providerMeta('wechat');
    ok('微信元信息：名称「微信」/ 图标 💬', !!m && m.label === '微信' && m.icon === '💬', JSON.stringify(m && { label: m.label, icon: m.icon }));
    ok('微信读 WECHAT_APP_ID / WECHAT_APP_SECRET', !!m && JSON.stringify(m.env) === JSON.stringify(['WECHAT_APP_ID', 'WECHAT_APP_SECRET']), JSON.stringify(m && m.env));
    ok('gatewayInfo() 未配时 enabled=false，doc 指向 docs/OAUTH.md', JSON.stringify(oauth.gatewayInfo()) === JSON.stringify({ enabled: false, url: '', providers: [], secretSet: false, doc: 'docs/OAUTH.md' }), JSON.stringify(oauth.gatewayInfo()));
  } finally {
    restore();
  }
}

/* ---------------- 二、GitHub / Google 直连 ---------------- */

async function sectionDirect(fake) {
  group('二、GitHub / Google 直连：授权地址与资料归一化');
  let restore = applyEnv(baseEnv({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' }));
  try {
    const expect = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
      client_id: 'gh-id', redirect_uri: CALLBACK('github'), scope: 'read:user user:email', state: 'st-1', response_type: 'code'
    }).toString();
    const got = oauth.authorizeUrl('github', ORIGIN, 'st-1');
    ok('GitHub 授权地址与改前逐字节一致（参数顺序也没变）', got === expect, got);
    const list = oauth.enabledProviders();
    ok('enabledProviders 元素形状仍是 {key,label,icon}', list.length === 1 && JSON.stringify(Object.keys(list[0]).sort()) === JSON.stringify(['icon', 'key', 'label']), JSON.stringify(list));
  } finally {
    restore();
  }

  restore = applyEnv(baseEnv({ GOOGLE_CLIENT_ID: 'go-id', GOOGLE_CLIENT_SECRET: 'go-secret' }));
  try {
    const expect = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: 'go-id', redirect_uri: CALLBACK('google'), scope: 'openid email profile', state: 'st-2', response_type: 'code'
    }).toString() + '&access_type=online&prompt=select_account';
    const got = oauth.authorizeUrl('google', ORIGIN, 'st-2');
    ok('Google 授权地址与改前逐字节一致（access_type/prompt 仍在末尾）', got === expect, got);
  } finally {
    restore();
  }

  restore = applyEnv(baseEnv({
    GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret',
    OAUTH_GITHUB_TOKEN_URL: fake.base + '/github/token',
    OAUTH_GITHUB_USER_URL: fake.base + '/github/user',
    OAUTH_GITHUB_EMAILS_URL: fake.base + '/github/emails'
  }));
  try {
    fake.reset();
    const r = await oauth.exchangeCode('github', ORIGIN, 'gh-code-1');
    ok('GitHub 直连换资料成功且 provider = github', !!r.profile && r.profile.provider === 'github', JSON.stringify(r));
    ok('providerId = github:<平台 id>', !!r.profile && r.profile.providerId === 'github:123', r.profile && r.profile.providerId);
    ok('username 取平台账号名（login），displayName 取姓名', !!r.profile && r.profile.username === 'octocat' && r.profile.displayName === 'The Octocat', JSON.stringify(r.profile));
    ok('uid 仍是旧字段（server.js 走 profile.uid）', !!r.profile && r.profile.uid === '123', r.profile && r.profile.uid);
    ok('头像归一化到 avatar 字段', !!r.profile && r.profile.avatar === 'https://avatars.example/u/123', r.profile && r.profile.avatar);
    const tok = fake.lastHit('/github/token');
    ok('换 token 仍是 POST 表单且字段与改前一致', !!tok && tok.method === 'POST' && tok.body.indexOf('client_id=gh-id') === 0 && tok.body.indexOf('grant_type=authorization_code') > 0, tok && tok.body);
    const user = fake.lastHit('/github/user');
    ok('取资料仍带 Bearer + User-Agent: game-site', !!user && user.headers.authorization === 'Bearer gh-token' && user.headers['user-agent'] === 'game-site', user && JSON.stringify({ a: user.headers.authorization, u: user.headers['user-agent'] }));
    fake.ghEmail = false;
    const r2 = await oauth.exchangeCode('github', ORIGIN, 'gh-code-2');
    ok('GitHub 不公开邮箱时回退到 /user/emails 里已验证的那个', !!r2.profile && r2.profile.email === 'octo@example.com', r2.profile && r2.profile.email);
    fake.ghEmail = true;
  } finally {
    restore();
  }

  restore = applyEnv(baseEnv({
    GOOGLE_CLIENT_ID: 'go-id', GOOGLE_CLIENT_SECRET: 'go-secret',
    OAUTH_GOOGLE_TOKEN_URL: fake.base + '/google/token',
    OAUTH_GOOGLE_USER_URL: fake.base + '/google/userinfo'
  }));
  try {
    const r = await oauth.exchangeCode('google', ORIGIN, 'g-code-1');
    ok('Google 直连换资料成功且 providerId = google:<sub>', !!r.profile && r.profile.providerId === 'google:g-777', JSON.stringify(r));
    ok('Google 没有平台账号名 → username 空串（回退链交给 auth.js）', !!r.profile && r.profile.username === '', r.profile && JSON.stringify(r.profile.username));
    ok('Google displayName 取 name、avatar 取 picture', !!r.profile && r.profile.displayName === 'Google User' && r.profile.avatar === 'https://g.example/p.png', JSON.stringify(r.profile));
  } finally {
    restore();
  }
}

/* ---------------- 三、微信直连 ---------------- */

async function sectionWechat(fake) {
  group('三、微信网站应用扫码：授权地址与换资料');
  let restore = applyEnv(baseEnv({ WECHAT_APP_ID: 'wx-appid', WECHAT_APP_SECRET: 'wx-secret' }));
  try {
    const expect = 'https://open.weixin.qq.com/connect/qrconnect?' + new URLSearchParams({
      appid: 'wx-appid', redirect_uri: CALLBACK('wechat'), response_type: 'code', scope: 'snsapi_login', state: 'st-wx'
    }).toString() + '#wechat_redirect';
    const got = oauth.authorizeUrl('wechat', ORIGIN, 'st-wx');
    ok('微信授权地址与微信文档逐字节一致（末尾 #wechat_redirect）', got === expect, got);
    ok('配了 WECHAT_* 之后登录列表里出现微信', oauth.enabledProviders().some((p) => p.key === 'wechat'), JSON.stringify(oauth.enabledProviders()));
  } finally {
    restore();
  }

  restore = applyEnv(baseEnv({
    WECHAT_APP_ID: 'wx-appid', WECHAT_APP_SECRET: 'wx-secret',
    OAUTH_WECHAT_TOKEN_URL: fake.base + '/wechat/token',
    OAUTH_WECHAT_USER_URL: fake.base + '/wechat/userinfo'
  }));
  try {
    fake.reset();
    const r = await oauth.exchangeCode('wechat', ORIGIN, 'wx-code-1');
    ok('微信换资料成功且 provider = wechat', !!r.profile && r.profile.provider === 'wechat', JSON.stringify(r));
    ok('providerId 优先用 unionid（同一开放平台下跨应用稳定）', !!r.profile && r.profile.providerId === 'wechat:WXUNIONID9', r.profile && r.profile.providerId);
    ok('微信没有平台账号名 → username 空串', !!r.profile && r.profile.username === '', r.profile && JSON.stringify(r.profile.username));
    ok('displayName 取 nickname、avatar 取 headimgurl', !!r.profile && r.profile.displayName === '微信测试用户' && r.profile.avatar === 'https://wx.example/avatar.png', JSON.stringify(r.profile));
    ok('email 是空串（微信不给邮箱，不能瞎填）', !!r.profile && r.profile.email === '', r.profile && r.profile.email);
    const tok = fake.lastHit('/wechat/token');
    ok('换 token 是 GET，带 appid/secret/code/grant_type=authorization_code', !!tok && tok.method === 'GET' && tok.query.appid === 'wx-appid' && tok.query.secret === 'wx-secret' && tok.query.code === 'wx-code-1' && tok.query.grant_type === 'authorization_code', JSON.stringify(tok && tok.query));
    const ui = fake.lastHit('/wechat/userinfo');
    ok('取资料带 access_token + openid + lang=zh_CN', !!ui && ui.query.access_token === 'wx-access-token' && ui.query.openid === 'WXOPENID123' && ui.query.lang === 'zh_CN', JSON.stringify(ui && ui.query));
    fake.wxUnionid = false;
    const r2 = await oauth.exchangeCode('wechat', ORIGIN, 'wx-code-2');
    ok('没有 unionid 时 providerId 退到 openid', !!r2.profile && r2.profile.providerId === 'wechat:WXOPENID123', r2.profile && r2.profile.providerId);
    fake.wxUnionid = true;
    fake.wxMode = 'errcode';
    const r3 = await oauth.exchangeCode('wechat', ORIGIN, 'wx-code-3');
    ok('微信返回 errcode（如 40029）→ exchange_failed', r3.error === 'exchange_failed', JSON.stringify(r3));
    fake.wxMode = 'ok';
    fake.wxUserMode = 'fail';
    const r4 = await oauth.exchangeCode('wechat', ORIGIN, 'wx-code-4');
    ok('昵称头像拉不到也要能登录（空昵称空头像，身份以 unionid 为准）', !!r4.profile && r4.profile.providerId === 'wechat:WXUNIONID9' && r4.profile.displayName === '' && r4.profile.avatar === '', JSON.stringify(r4.profile));
    fake.wxUserMode = 'ok';
  } finally {
    restore();
  }
}

/* ---------------- 四、网关模式 ---------------- */

async function sectionGateway(fake) {
  group('四、网关模式：authorizeUrl / token 往返与错误码');
  const gw = fake.base + '/gateway';
  let restore = applyEnv(baseEnv({ OAUTH_GATEWAY_URL: gw + '/', OAUTH_GATEWAY_SECRET: 'gw-secret' }));
  try {
    const expect = gw + '/authorize?' + new URLSearchParams({ provider: 'github', redirect_uri: CALLBACK('github'), state: 'st-gw' }).toString();
    const got = oauth.authorizeUrl('github', ORIGIN, 'st-gw');
    ok('网关模式授权地址 = <网关>/authorize?provider=&redirect_uri=&state=', got === expect, got);
    ok('网关地址末尾斜杠被吃掉，不会拼出 /gateway//authorize', got.indexOf('/gateway//') < 0, got);
    ok('网关模式下三个 Provider 都算可用（密钥在网关侧）', oauth.providerEnabled('github') && oauth.providerEnabled('google') && oauth.providerEnabled('wechat'));
    ok('gatewayInfo() 报地址/名单/密钥状态（不回显密钥内容）', JSON.stringify(oauth.gatewayInfo()) === JSON.stringify({ enabled: true, url: gw, providers: ['github', 'google', 'wechat'], secretSet: true, doc: 'docs/OAUTH.md' }), JSON.stringify(oauth.gatewayInfo()));
    process.env.OAUTH_GATEWAY_PROVIDERS = 'wechat';
    ok('OAUTH_GATEWAY_PROVIDERS=wechat 时只有微信走网关', oauth.providerEnabled('wechat') === true && oauth.providerEnabled('github') === false && oauth.authorizeUrl('github', ORIGIN, 's') === '');
    process.env.OAUTH_GATEWAY_PROVIDERS = 'nope,bogus';
    ok('网关名单全是非法名字 → 没有 Provider 走网关（不静默放开）', oauth.gatewayProviders().length === 0 && oauth.providerEnabled('github') === false);
    delete process.env.OAUTH_GATEWAY_PROVIDERS;
  } finally {
    restore();
  }

  restore = applyEnv(baseEnv({ OAUTH_GATEWAY_URL: gw, OAUTH_GATEWAY_SECRET: 'gw-secret' }));
  try {
    fake.reset();
    const r = await oauth.exchangeCode('github', ORIGIN, 'gw-code-1');
    ok('网关模式换资料成功，形状与直连时一致', !!r.profile && r.profile.provider === 'github' && r.profile.providerId === 'github:GWU-42', JSON.stringify(r));
    ok('网关给的 username/displayName/email/avatar 原样归一化', !!r.profile && r.profile.username === 'gwuser' && r.profile.displayName === '网关用户' && r.profile.email === 'gw@example.com' && r.profile.avatar === 'https://gw.example/a.png', JSON.stringify(r.profile));
    const t = fake.lastHit('/gateway/token');
    ok('站点向 <网关>/token 发 POST JSON', !!t && t.method === 'POST' && String(t.headers['content-type']).indexOf('application/json') === 0, t && t.method + ' ' + (t && t.headers['content-type']));
    ok('请求头带 x-oauth-ts / x-oauth-nonce(32hex) / x-oauth-signature(64hex)', !!t && !!t.headers['x-oauth-ts'] && /^[0-9a-f]{32}$/.test(String(t.headers['x-oauth-nonce'])) && /^[0-9a-f]{64}$/.test(String(t.headers['x-oauth-signature'])), t && JSON.stringify({ ts: t.headers['x-oauth-ts'], nonce: t.headers['x-oauth-nonce'] }));
    const wantSig = t ? createHmac('sha256', 'gw-secret').update([String(t.headers['x-oauth-ts']), String(t.headers['x-oauth-nonce']), 'github', 'gw-code-1', CALLBACK('github')].join('\n'), 'utf8').digest('hex') : '';
    ok('站点算的签名与独立 HMAC 实现一致', !!t && t.headers['x-oauth-signature'] === wantSig);
    ok('时间戳在 5 分钟窗口内（网关据此判重放）', !!t && oauth.gatewayTsFresh(t.headers['x-oauth-ts']) === true);
    const payload = t ? JSON.parse(t.body) : {};
    ok('请求体带 provider/code/redirect_uri（与签名同值）+ ts/nonce', payload.provider === 'github' && payload.code === 'gw-code-1' && payload.redirect_uri === CALLBACK('github') && !!payload.ts && !!payload.nonce, JSON.stringify(payload));
    ok('网关侧独立校验放行这一份请求（签名 + 时间戳都对得上）', !!fake.gwVerify && fake.gwVerify.ok === true && fake.gwVerify.signed === true, JSON.stringify(fake.gwVerify));
    ok('网关请求里没有 client_secret（站点密钥不出本站）', !!t && t.body.indexOf('secret') < 0, t && t.body);

    fake.gwErr = 'no_profile';
    const e1 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-2');
    ok('网关返回 {error:"no_profile"} → 原样透传', e1.error === 'no_profile', JSON.stringify(e1));
    fake.gwErr = 'replayed';
    const e2 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-3');
    ok('网关拒绝重放（replayed）→ 站点按换资料失败处理', e2.error === 'replayed', JSON.stringify(e2));
    fake.gwErr = 'weird';
    const e3 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-4');
    ok('不认识的错误码归成 exchange_failed（不透网关内部措辞）', e3.error === 'exchange_failed', JSON.stringify(e3));
    fake.gwErr = 'nonjson';
    const e4 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-5');
    ok('网关返回非 JSON → exchange_failed', e4.error === 'exchange_failed', JSON.stringify(e4));
    fake.gwErr = 'noid';
    const e5 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-6');
    ok('网关返回的 profile 没有 id → no_profile', e5.error === 'no_profile', JSON.stringify(e5));
    fake.gwErr = '';

    delete process.env.OAUTH_GATEWAY_SECRET;
    fake.reset();
    fake.gwSecret = ''; // 网关侧也没配密钥 → 不校验签名
    const r6 = await oauth.exchangeCode('github', ORIGIN, 'gw-code-7');
    const t6 = fake.lastHit('/gateway/token');
    ok('没配 OAUTH_GATEWAY_SECRET 时不带签名头（风险已在 docs/OAUTH.md 写明）', !!r6.profile && !!t6 && t6.headers['x-oauth-signature'] === undefined, JSON.stringify({ ok: !!r6.profile, sig: t6 && t6.headers['x-oauth-signature'] }));
  } finally {
    restore();
  }
}

/* ---------------- 五、签名与重放判据 ---------------- */

async function sectionSignature(fake) {
  group('五、签名算法与重放判据（网关侧独立复核）');
  fake.reset(); // 第四节末尾临时关掉过网关侧密钥，这里复位
  const parts = { ts: '1760000000', nonce: 'abc123', provider: 'github', code: 'C1', redirectUri: CALLBACK('github') };
  const sig = await oauth.gatewaySignature('s3cret', parts);
  const want = createHmac('sha256', 's3cret').update(['1760000000', 'abc123', 'github', 'C1', CALLBACK('github')].join('\n'), 'utf8').digest('hex');
  ok('gatewaySignature = HMAC-SHA256(ts\\n nonce\\n provider\\n code\\n redirect_uri) 小写 hex', sig === want && /^[0-9a-f]{64}$/.test(sig), sig);
  ok('签名对 code 敏感（换 code 签名就变）', (await oauth.gatewaySignature('s3cret', Object.assign({}, parts, { code: 'C2' }))) !== sig);
  ok('签名对 secret 敏感', (await oauth.gatewaySignature('other', parts)) !== sig);
  const now = 1760000000000;
  ok('时间窗口：差 299 秒还算新鲜，301 秒就拒绝', oauth.gatewayTsFresh(1759999701, now) === true && oauth.gatewayTsFresh(1759999699, now) === false);
  ok('单位容错：毫秒时间戳也认（不误杀）', oauth.gatewayTsFresh(now, now) === true);
  ok('空/非法时间戳直接判不新鲜', oauth.gatewayTsFresh('', now) === false && oauth.gatewayTsFresh('abc', now) === false);
  const n1 = oauth.randomNonce();
  const n2 = oauth.randomNonce();
  ok('randomNonce 是 16 字节 hex 且两次不同', /^[0-9a-f]{32}$/.test(n1) && n1 !== n2, n1);

  const nowSec = Math.floor(Date.now() / 1000);
  const body = { provider: 'github', code: 'C1', redirect_uri: CALLBACK('github') };
  const sign = (secret, ts, nonce, b) => createHmac('sha256', secret).update([ts, nonce, b.provider, b.code, b.redirect_uri].join('\n'), 'utf8').digest('hex');
  const h = { 'x-oauth-ts': String(nowSec), 'x-oauth-nonce': 'n-1', 'x-oauth-signature': sign('gw-secret', String(nowSec), 'n-1', body) };
  ok('网关校验：签名正确且新鲜 → 放行', fake.verify(h, body).ok === true, JSON.stringify(fake.verify(h, body)));
  ok('网关校验：同一份请求重放第二次 → replayed（重放拒绝）', fake.verify(h, body).error === 'replayed', JSON.stringify(fake.verify(h, body)));
  ok('网关校验：换了 nonce 没换签名 → bad_signature', fake.verify(Object.assign({}, h, { 'x-oauth-nonce': 'n-2' }), body).error === 'bad_signature');
  const old = String(nowSec - 600);
  ok('网关校验：10 分钟前的时间戳 → stale_ts', fake.verify({ 'x-oauth-ts': old, 'x-oauth-nonce': 'n-3', 'x-oauth-signature': sign('gw-secret', old, 'n-3', body) }, body).error === 'stale_ts');
  ok('网关校验：改了 code 却沿用旧签名 → bad_signature', fake.verify(h, { provider: 'github', code: 'C2', redirect_uri: CALLBACK('github') }).error === 'bad_signature');
}

/* ---------------- 六、worker 镜像 ---------------- */

async function sectionWorker(fake) {
  group('六、worker/oauth.js 与 src/oauth.js 镜像一致性');
  const restore = applyEnv(baseEnv({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', WECHAT_APP_ID: 'wx-appid', WECHAT_APP_SECRET: 'wx-secret' }));
  try {
    ok('镜像：PROVIDERS 一致', JSON.stringify(workerOauth.PROVIDERS) === JSON.stringify(oauth.PROVIDERS));
    ok('镜像：GATEWAY_TS_WINDOW 都是 300 秒', workerOauth.GATEWAY_TS_WINDOW === oauth.GATEWAY_TS_WINDOW && oauth.GATEWAY_TS_WINDOW === 300);
    const raw = { id: 123, username: 'octocat', name: null, email: 'a@b.c', avatar: 'x' };
    ok('镜像：normalizeProfile 输出逐字节一致', JSON.stringify(workerOauth.normalizeProfile('github', raw)) === JSON.stringify(oauth.normalizeProfile('github', raw)));
    const parts = { ts: '1', nonce: 'n', provider: 'wechat', code: 'c', redirectUri: CALLBACK('wechat') };
    ok('镜像：网关签名（WebCrypto）与 node:crypto 版同值', (await workerOauth.gatewaySignature('s', parts)) === (await oauth.gatewaySignature('s', parts)));
    const env = { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', WECHAT_APP_ID: 'wx-appid', WECHAT_APP_SECRET: 'wx-secret' };
    ok('镜像：微信直连授权地址一致', workerOauth.authorizeUrl('wechat', ORIGIN, 'st', env) === oauth.authorizeUrl('wechat', ORIGIN, 'st'));
    ok('镜像：enabledProviders 一致（直连模式）', JSON.stringify(workerOauth.enabledProviders(env)) === JSON.stringify(oauth.enabledProviders()));
    const genv = Object.assign({}, env, { OAUTH_GATEWAY_URL: fake.base + '/gateway/', OAUTH_GATEWAY_SECRET: 's' });
    process.env.OAUTH_GATEWAY_URL = genv.OAUTH_GATEWAY_URL;
    process.env.OAUTH_GATEWAY_SECRET = genv.OAUTH_GATEWAY_SECRET;
    ok('镜像：网关模式授权地址一致（末尾斜杠同样被吃掉）', workerOauth.authorizeUrl('github', ORIGIN, 'st', genv) === oauth.authorizeUrl('github', ORIGIN, 'st'));
    ok('镜像：enabledProviders 一致（网关模式：三个都在）', JSON.stringify(workerOauth.enabledProviders(genv)) === JSON.stringify(oauth.enabledProviders()));
    ok('镜像：gatewayInfo 一致（gatewayInfo(env) vs gatewayInfo()）', JSON.stringify(workerOauth.gatewayInfo(genv)) === JSON.stringify(oauth.gatewayInfo()));
    delete process.env.OAUTH_GATEWAY_URL;
    delete process.env.OAUTH_GATEWAY_SECRET;
    ok('镜像：演示登录只在 OAUTH_DEV 打开时出现（Workers 没有 NODE_ENV）', workerOauth.enabledProviders({ OAUTH_DEV: '1' }).some((p) => p.key === 'dev') && !workerOauth.enabledProviders({}).some((p) => p.key === 'dev'));
    const q = { uid: 'u1', name: '甲', email: 'a@b.c' };
    ok('镜像：mockProfile 输出逐字节一致', JSON.stringify(workerOauth.mockProfile(q)) === JSON.stringify(oauth.mockProfile(q)));
    ok('镜像：providerSetup 文案一致（回调地址 + 资质要求）', JSON.stringify(workerOauth.providerSetup('wechat', ORIGIN)) === JSON.stringify(oauth.providerSetup('wechat', ORIGIN)));
    ok('镜像：providerCreds 形状一致', JSON.stringify(workerOauth.providerCreds('wechat', env)) === JSON.stringify(oauth.providerCreds('wechat')));
    fake.reset();
    const wr = await workerOauth.exchangeCode('github', ORIGIN, 'gw-w-1', { OAUTH_GATEWAY_URL: fake.base + '/gateway', OAUTH_GATEWAY_SECRET: 'gw-secret' });
    ok('镜像：网关换资料走同一套协议，签名同样被独立校验接受', !!wr.profile && wr.profile.providerId === 'github:GWU-42' && !!fake.gwVerify && fake.gwVerify.ok === true, JSON.stringify({ p: wr.profile && wr.profile.providerId, v: fake.gwVerify }));
    const ww = await workerOauth.exchangeCode('wechat', ORIGIN, 'wx-w-1', {
      WECHAT_APP_ID: 'wx-appid', WECHAT_APP_SECRET: 'wx-secret',
      OAUTH_WECHAT_TOKEN_URL: fake.base + '/wechat/token',
      OAUTH_WECHAT_USER_URL: fake.base + '/wechat/userinfo'
    });
    ok('镜像：微信直连换资料结果与 src 版同值', JSON.stringify(ww) === JSON.stringify({ profile: oauth.normalizeProfile('wechat', { id: 'WXUNIONID9', name: '微信测试用户', avatar: 'https://wx.example/avatar.png' }) }), JSON.stringify(ww));
  } finally {
    restore();
  }
}

/* ---------------- 七、端到端：什么都不配 ---------------- */

async function adminRow(base) {
  const j = jar();
  const r = await get(base + '/login', j);
  const res = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: j.header(base) },
    body: new URLSearchParams({ username: 'admin', password: 'admin123', next: '/admin' }).toString()
  });
  j.save(res, base);
  return get(base + '/admin', j);
}

async function sectionSiteEmpty() {
  group('七、端到端（什么都不配）：登录页没有第三方按钮，微信路由 404');
  await withSite({}, async (base) => {
    const login = await get(base + '/login');
    ok('未配置时登录页不出现 /auth/wechat', login.text.indexOf('/auth/wechat') < 0);
    ok('未配置时登录页也不出现 /auth/github（与改前一致）', login.text.indexOf('/auth/github') < 0);
    const w = await get(base + '/auth/wechat');
    ok('未配置时 /auth/wechat → 404「这个登录方式没有开启」', w.status === 404 && w.text.indexOf('这个登录方式没有开启') >= 0, w.status + ' ' + w.text.slice(0, 100));
    const g = await get(base + '/auth/github');
    ok('未配置时 /auth/github → 404 且提示去配 Client ID / Secret', g.status === 404 && g.text.indexOf('Client ID / Secret') >= 0, g.status + ' ' + g.text.slice(0, 100));
    const adm = await adminRow(base);
    if (adm.status === 200) {
      ok('后台「集成自检」出现微信这一行', adm.text.indexOf('wechat') >= 0 && adm.text.indexOf('微信') >= 0);
      ok('后台自检列出微信要配的环境变量', adm.text.indexOf('WECHAT_APP_ID') >= 0 && adm.text.indexOf('WECHAT_APP_SECRET') >= 0);
      ok('后台自检给出微信回调地址 /auth/wechat/callback', adm.text.indexOf('/auth/wechat/callback') >= 0);
    } else {
      console.log('  skip 后台集成自检（admin 登录没成，status ' + adm.status + '）');
    }
  });
}

/* ---------------- 八、端到端：微信直连 ---------------- */

async function sectionSiteWechat(fake) {
  group('八、端到端（微信直连）：扫码往返、state 校验、同一个 unionid 复用账号');
  fake.reset();
  const env = {
    WECHAT_APP_ID: 'wx-appid',
    WECHAT_APP_SECRET: 'wx-secret',
    OAUTH_WECHAT_AUTHORIZE_URL: fake.base + '/wechat/qrconnect',
    OAUTH_WECHAT_TOKEN_URL: fake.base + '/wechat/token',
    OAUTH_WECHAT_USER_URL: fake.base + '/wechat/userinfo'
  };
  await withSite(env, async (base) => {
    const login = await get(base + '/login');
    ok('配了微信后登录页出现 /auth/wechat 按钮', login.text.indexOf('/auth/wechat') >= 0 && login.text.indexOf('微信') >= 0);
    const j1 = jar();
    const a1 = await get(base + '/auth/wechat', j1);
    ok('微信直连：/auth/wechat 302 到微信扫码页', a1.status === 302, a1.status + ' ' + a1.location);
    const u1 = new URL(a1.location);
    ok('微信直连：授权地址指向假微信、参数齐全、末尾 #wechat_redirect', a1.location.indexOf(fake.base + '/wechat/qrconnect?') === 0 && u1.searchParams.get('appid') === 'wx-appid' && u1.searchParams.get('scope') === 'snsapi_login' && a1.location.endsWith('#wechat_redirect'), a1.location);
    ok('微信直连：redirect_uri 指向本站回调地址', u1.searchParams.get('redirect_uri') === base + '/auth/wechat/callback', u1.searchParams.get('redirect_uri'));
    const st1 = u1.searchParams.get('state');
    ok('微信直连：state 存在临时 cookie 里（防 CSRF）', !!j1.get(base, 'oauth_state') && j1.get(base, 'oauth_state').indexOf(st1) === 0, j1.get(base, 'oauth_state'));
    const done = await flow(j1, a1.location);
    ok('微信直连：扫码 → 回调 → 落到站点页面（不是错误页）', done.status === 200 && done.text.indexOf('换取用户资料失败') < 0, done.trail.join(' -> '));
    const me1 = JSON.parse((await get(base + '/api/me', j1)).text);
    ok('微信直连：登录成功（/api/me 有用户）', !!(me1.user && me1.user.id), JSON.stringify(me1).slice(0, 200));
    ok('微信直连：微信昵称进了账号资料', JSON.stringify(me1.user || {}).indexOf('微信测试用户') >= 0, JSON.stringify(me1.user || {}).slice(0, 200));
    const acct = await get(base + '/account', j1);
    ok('微信直连：账号页显示已绑定微信', acct.status === 200 && acct.text.indexOf('微信') >= 0, acct.status);
    const j2 = jar();
    const a2 = await get(base + '/auth/wechat', j2);
    const done2 = await flow(j2, a2.location);
    const me2 = JSON.parse((await get(base + '/api/me', j2)).text);
    ok('微信直连：同一 unionid 第二次登录复用同一个账号', done2.status === 200 && !!me2.user && me2.user.id === me1.user.id, JSON.stringify([me1.user.id, me2.user && me2.user.id]));
    const j3 = jar();
    const a3 = await get(base + '/auth/wechat', j3);
    const st3 = new URL(a3.location).searchParams.get('state');
    const bad = await get(base + '/auth/wechat/callback?code=wx-code-1&state=' + st3 + 'zz', j3);
    ok('微信直连：回调 state 对不上 → 400「登录状态校验失败」', bad.status === 400 && bad.text.indexOf('登录状态校验失败') >= 0, bad.status + ' ' + bad.text.slice(0, 100));
    const noCode = await get(base + '/auth/wechat/callback?state=' + st3, j3);
    ok('微信直连：回调没带 code → 提示「没有拿到授权码」', noCode.text.indexOf('没有拿到授权码') >= 0, noCode.status);
    fake.wxMode = 'errcode';
    const j4 = jar();
    const a4 = await get(base + '/auth/wechat', j4);
    const err4 = await flow(j4, a4.location);
    ok('微信直连：换 token 失败 → 错误页「换取用户资料失败（exchange_failed）」', err4.text.indexOf('换取用户资料失败') >= 0 && err4.text.indexOf('exchange_failed') >= 0, err4.status + ' ' + err4.text.slice(0, 140));
    fake.wxMode = 'ok';
    ok('微信直连：授权码确实打进了假微信的换 token 接口', !!fake.lastHit('/wechat/token'));
  });
}

/* ---------------- 九、端到端：网关模式 ---------------- */

async function sectionSiteGateway(fake) {
  group('九、端到端（网关模式）：站点不持有第三方密钥也能登录');
  fake.reset();
  await withSite({ OAUTH_GATEWAY_URL: fake.base + '/gateway', OAUTH_GATEWAY_SECRET: 'gw-secret' }, async (base) => {
    const login = await get(base + '/login');
    ok('网关模式：登录页同时出现 GitHub 与微信按钮（都走网关）', login.text.indexOf('/auth/github') >= 0 && login.text.indexOf('/auth/wechat') >= 0);
    const j = jar();
    const a = await get(base + '/auth/github', j);
    ok('网关模式：/auth/github 302 到 <网关>/authorize', a.status === 302 && a.location.indexOf(fake.base + '/gateway/authorize?') === 0, a.status + ' ' + a.location);
    const u = new URL(a.location);
    ok('网关模式：授权地址带 provider/redirect_uri/state，不带 client_id', u.searchParams.get('provider') === 'github' && u.searchParams.get('redirect_uri') === base + '/auth/github/callback' && !!u.searchParams.get('state') && !u.searchParams.get('client_id'), a.location);
    const done = await flow(j, a.location);
    ok('网关模式：授权 → 回调 → 登录成功落到站点页面', done.status === 200 && done.text.indexOf('换取用户资料失败') < 0, done.trail.join(' -> '));
    const me = JSON.parse((await get(base + '/api/me', j)).text);
    ok('网关模式：网关给的资料建出了账号', !!(me.user && me.user.id) && JSON.stringify(me.user).indexOf('网关用户') >= 0, JSON.stringify(me.user || {}).slice(0, 200));
    const t = fake.lastHit('/gateway/token');
    ok('网关模式：回调时向网关换资料，签名被网关独立校验接受', !!t && !!fake.gwVerify && fake.gwVerify.ok === true, JSON.stringify(fake.gwVerify));
    ok('网关模式：redirect_uri 与站点回调地址一致（网关据此回跳）', !!t && JSON.parse(t.body).redirect_uri === base + '/auth/github/callback', t && t.body);
  });

  await withSite({ OAUTH_GATEWAY_URL: fake.base + '/gateway', OAUTH_GATEWAY_SECRET: 'wrong-secret' }, async (base) => {
    const j = jar();
    const a = await get(base + '/auth/github', j);
    const done = await flow(j, a.location);
    ok('网关模式：站点签名密钥配错 → 网关拒绝，站点显示换资料失败（不静默放行）', done.text.indexOf('换取用户资料失败') >= 0, done.status + ' ' + done.text.slice(0, 140));
    ok('网关模式：错误信息里有 bad_signature，便于排查', done.text.indexOf('bad_signature') >= 0, done.text.slice(0, 160));
  });
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('OAuth 网关 + 微信登录自测（只访问本机假服务与本地站点，不发外网请求）');
  const fake = await startFake();
  try {
    await sectionBaseline();
    await sectionDirect(fake);
    await sectionWechat(fake);
    await sectionGateway(fake);
    await sectionSignature(fake);
    await sectionWorker(fake);
    await sectionSiteEmpty();
    await sectionSiteWechat(fake);
    await sectionSiteGateway(fake);
  } finally {
    await fake.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => {
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      process.exit(fail ? 1 : 0);
    })
    .catch((err) => {
      console.error('\n[测试脚本本身出错]', (err && err.stack) || err);
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项（测试中断）');
      process.exit(1);
    });
}
