/**
 * 第三方登录（Workers 版）：逻辑与 src/oauth.js 一致，区别是密钥从 env 读。
 *
 * Workers 里没有 process.env，密钥是 wrangler 的 vars / secret：
 *   GitHub  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   Google  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   dev     演示登录，只在 OAUTH_DEV="1" 时开放（Workers 里没有 NODE_ENV，
 *           所以这里刻意选「默认关闭、显式打开」，避免线上误开免密登录）
 * 回调地址固定为 <站点>/auth/<provider>/callback。
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

function creds(name, env) {
  const m = META[name];
  if (!m || m.mock) return null;
  const e = env || {};
  const id = e[m.env[0]] || '';
  const secret = e[m.env[1]] || '';
  return id && secret ? { id, secret } : null;
}

export function providerEnabled(name, env) {
  const m = META[name];
  if (!m) return false;
  if (m.mock) return devEnabled(env);
  return !!creds(name, env);
}

export function devEnabled(env) {
  const e = env || {};
  return e.OAUTH_DEV === '1' || e.OAUTH_DEV === 'true' || e.OAUTH_DEV === true;
}

/** 当前可用的第三方登录列表，模板直接拿去渲染按钮 */
export function enabledProviders(env) {
  const list = PROVIDERS.filter((k) => providerEnabled(k, env)).map((k) => ({ key: k, label: META[k].label, icon: META[k].icon }));
  if (devEnabled(env)) list.push({ key: 'dev', label: META.dev.label, icon: META.dev.icon });
  return list;
}

export function redirectUri(origin, name) {
  return origin + '/auth/' + name + '/callback';
}

/** 拼授权页地址（state 用于防 CSRF，存在 cookie 里回调时比对） */
export function authorizeUrl(name, origin, state, env) {
  const c = creds(name, env);
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
  return m.authorize + '?' + p.toString();
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
  const u = await (await fetch('https://api.github.com/user', { headers: h })).json();
  let email = u.email || '';
  if (!email) {
    const list = await (await fetch('https://api.github.com/user/emails', { headers: h })).json();
    const pick = Array.isArray(list) ? list.find((e) => e.primary && e.verified) || list.find((e) => e.verified) : null;
    email = pick ? pick.email : '';
  }
  return { uid: String(u.id || ''), name: u.name || u.login || '', username: u.login || '', email };
}

async function googleProfile(token) {
  const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + token }
  })).json();
  return { uid: String(u.sub || ''), name: u.name || '', email: u.email || '' };
}

/**
 * 用授权码换用户资料。
 * @returns {{error:string}|{profile:{uid:string,name:string,email:string}}}
 */
export async function exchangeCode(name, origin, code, env) {
  const c = creds(name, env);
  if (!c) return { error: 'provider_disabled' };
  const body = {
    client_id: c.id,
    client_secret: c.secret,
    code,
    redirect_uri: redirectUri(origin, name),
    grant_type: 'authorization_code'
  };
  try {
    const { ok, json } = await postForm(META[name].token, body);
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
