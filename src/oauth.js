/**
 * 第三方登录（OAuth 2.0 授权码模式）：用原生 fetch 走完，零依赖。
 * 通过环境变量开关，没配的 Provider 不会出现在界面上：
 *   GitHub  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   Google  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   dev     演示登录，仅开发环境（NODE_ENV !== 'production' 或 OAUTH_DEV=1）可用，不需要任何密钥
 * 回调地址固定为 <站点>/auth/<provider>/callback，申请应用时照这个填。
 */

export const PROVIDERS = ['github', 'google'];

const META = {
  github: {
    label: 'GitHub',
    icon: '🐙',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']
  },
  google: {
    label: 'Google',
    icon: '🔍',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
  },
  dev: {
    label: '演示登录',
    icon: '🧪',
    mock: true,
    env: []
  }
};

export function providerMeta(name) {
  return META[String(name || '')] || null;
}

/**
 * Provider 端点可被环境变量覆盖，方便接自建网关，也让本地端到端测试能指向假服务端：
 *   OAUTH_GITHUB_AUTHORIZE_URL / OAUTH_GITHUB_TOKEN_URL / OAUTH_GITHUB_USER_URL / OAUTH_GITHUB_EMAILS_URL
 *   OAUTH_GOOGLE_AUTHORIZE_URL / OAUTH_GOOGLE_TOKEN_URL / OAUTH_GOOGLE_USER_URL
 * 不设时用 META 里的官方地址。
 */
function endpoint(name, key, fallback) {
  return process.env['OAUTH_' + String(name).toUpperCase() + '_' + key] || fallback;
}

/** 后台「集成自检」用：只回报配没配，绝不回显密钥内容 */
export function providerCreds(name) {
  const m = META[name];
  if (!m || m.mock) return null;
  return { id: process.env[m.env[0]] || '', secret: process.env[m.env[1]] || '' };
}

function creds(name) {
  const m = META[name];
  if (!m || m.mock) return null;
  const id = process.env[m.env[0]] || '';
  const secret = process.env[m.env[1]] || '';
  return id && secret ? { id, secret } : null;
}

export function providerEnabled(name) {
  const m = META[name];
  if (!m) return false;
  if (m.mock) return devEnabled();
  return !!creds(name);
}

export function devEnabled() {
  return process.env.NODE_ENV !== 'production' || process.env.OAUTH_DEV === '1';
}

/** 当前可用的第三方登录列表，模板直接拿去渲染按钮 */
export function enabledProviders() {
  const list = PROVIDERS.filter(providerEnabled).map((k) => ({ key: k, label: META[k].label, icon: META[k].icon }));
  if (devEnabled()) list.push({ key: 'dev', label: META.dev.label, icon: META.dev.icon });
  return list;
}

export function redirectUri(origin, name) {
  return origin + '/auth/' + name + '/callback';
}

/** 拼授权页地址（state 用于防 CSRF，存在 cookie 里回调时比对） */
export function authorizeUrl(name, origin, state) {
  const c = creds(name);
  if (!c) return '';
  const m = META[name];
  const p = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri(origin, name),
    scope: m.scope,
    state,
    response_type: 'code'
  });
  if (name === 'google') { p.set('access_type', 'online'); p.set('prompt', 'select_account'); }
  return endpoint(name, 'AUTHORIZE_URL', m.authorize) + '?' + p.toString();
}

async function postForm(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: new URLSearchParams(body).toString()
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 有些网关返回 urlencoded */ }
  if (!json) json = Object.fromEntries(new URLSearchParams(text));
  return { ok: res.ok, json };
}

async function githubProfile(token) {
  const h = { Authorization: 'Bearer ' + token, 'User-Agent': 'game-site', Accept: 'application/vnd.github+json' };
  const u = await (await fetch(endpoint('github', 'USER_URL', 'https://api.github.com/user'), { headers: h })).json();
  let email = u.email || '';
  if (!email) {
    const list = await (await fetch(endpoint('github', 'EMAILS_URL', 'https://api.github.com/user/emails'), { headers: h })).json();
    const pick = Array.isArray(list) ? list.find((e) => e.primary && e.verified) || list.find((e) => e.verified) : null;
    email = pick ? pick.email : '';
  }
  return { uid: String(u.id || ''), name: u.name || u.login || '', username: u.login || '', email };
}

async function googleProfile(token) {
  const u = await (await fetch(endpoint('google', 'USER_URL', 'https://openidconnect.googleapis.com/v1/userinfo'), {
    headers: { Authorization: 'Bearer ' + token }
  })).json();
  return { uid: String(u.sub || ''), name: u.name || '', email: u.email || '' };
}

/**
 * 用授权码换用户资料。
 * @returns {{error:string}|{profile:{uid:string,name:string,email:string}}}
 */
export async function exchangeCode(name, origin, code) {
  const c = creds(name);
  if (!c) return { error: 'provider_disabled' };
  const body = {
    client_id: c.id,
    client_secret: c.secret,
    code,
    redirect_uri: redirectUri(origin, name),
    grant_type: 'authorization_code'
  };
  try {
    const { ok, json } = await postForm(endpoint(name, 'TOKEN_URL', META[name].token), body);
    if (!ok || !json.access_token) return { error: 'exchange_failed' };
    const profile = name === 'github' ? await githubProfile(json.access_token) : await googleProfile(json.access_token);
    if (!profile.uid) return { error: 'no_profile' };
    return { profile };
  } catch (err) {
    console.error('[oauth:error]', err && err.message);
    return { error: 'exchange_failed' };
  }
}

/** 演示 Provider：不走网络，把参数当成资料直接返回 */
export function mockProfile(query) {
  const uid = String(query.uid || 'demo-1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'demo-1';
  const name = String(query.name || '演示用户' + uid).slice(0, 20);
  return { uid, name, username: 'dev_' + uid, email: String(query.email || '').slice(0, 120) };
}
