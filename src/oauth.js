/**
 * 第三方登录（OAuth 2.0 授权码模式）：用原生 fetch 走完，零依赖。
 *
 * 三种走法（同一套导出，调用方只认 provider 名）：
 *   ① 直连 Provider（默认）：本站自己拿 Client ID / Secret 换 token。没配密钥的 Provider 不会出现在界面上。
 *   ② 自建 OAuth 网关（OAUTH_GATEWAY_URL）：站点只跟网关说话，第三方密钥留在网关侧；
 *      授权页跳 <网关>/authorize，回调换资料走 <网关>/token（HMAC 签名 + 时间戳防重放）。
 *      接口约定、最小网关示例见 docs/OAUTH.md。
 *   ③ 演示登录（dev）：不走网络，仅开发环境（NODE_ENV !== 'production' 或 OAUTH_DEV=1）可用。
 *
 * Provider 与环境变量：
 *   GitHub  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   Google  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   微信    WECHAT_APP_ID / WECHAT_APP_SECRET（网站应用扫码登录，要企业主体 + 审核，见 docs/OAUTH.md）
 * 回调地址固定为 <站点>/auth/<provider>/callback，申请应用时照这个填。
 *
 * 端点可用环境变量覆盖（本地端到端测试指向假服务端，或接自建网关的旧式透明代理）：
 *   OAUTH_<PROVIDER>_AUTHORIZE_URL / OAUTH_<PROVIDER>_TOKEN_URL / OAUTH_<PROVIDER>_USER_URL
 *   OAUTH_GITHUB_EMAILS_URL（GitHub 单独取邮箱那一步）
 *
 * 日志纪律：本文件只打印 err.message；token / client_secret / 网关签名一律不进日志，
 * 也不把带 secret 的请求 URL 打出来。
 */
import { createHmac, randomBytes } from 'node:crypto';

export const PROVIDERS = ['github', 'google', 'wechat'];

/** 网关签名的时间戳容忍窗口（秒）：差得比这还多就按重放拒绝 */
export const GATEWAY_TS_WINDOW = 300;

const META = {
  github: {
    label: 'GitHub',
    icon: '🐙',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    setup: 'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App；Authorization callback URL 填 <站点>/auth/github/callback。',
    qualification: ''
  },
  google: {
    label: 'Google',
    icon: '🔍',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    setup: 'Google Cloud Console → API 和服务 → 凭据 → 创建「OAuth 客户端 ID」（Web 应用）；已获授权的重定向 URI 填 <站点>/auth/google/callback。',
    qualification: ''
  },
  wechat: {
    label: '微信',
    icon: '💬',
    authorize: 'https://open.weixin.qq.com/connect/qrconnect',
    token: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    user: 'https://api.weixin.qq.com/sns/userinfo',
    scope: 'snsapi_login',
    env: ['WECHAT_APP_ID', 'WECHAT_APP_SECRET'],
    setup: '微信开放平台 → 管理中心 → 网站应用 → 创建网站应用；「授权回调域」填站点域名（只填域名，不带协议与路径），用户扫二维码确认后回到 <站点>/auth/wechat/callback。',
    qualification: '网站应用要企业主体 + 微信开放平台认证（约 300 元/年）+ 审核通过，个人主体申请不到。没有资质就继续用 GitHub / Google，或把微信这一跳交给有资质的自建网关（OAUTH_GATEWAY_URL）。'
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
 * 界面 / 文档用的「怎么配」说明书：环境变量、申请步骤、资质要求、回调地址。
 * 登录页与后台「集成自检」要显示配置指引时直接读这里，不用在模板里另抄一份。
 */
export function providerSetup(name, origin = '') {
  const m = META[String(name || '')];
  if (!m) return null;
  return {
    key: String(name),
    label: m.label,
    icon: m.icon,
    env: (m.env || []).slice(),
    scope: m.scope || '',
    setup: m.setup || '',
    qualification: m.qualification || '',
    callback: m.mock ? '' : redirectUri(origin, String(name)),
    doc: 'docs/OAUTH.md'
  };
}

/* ---------------- 自建 OAuth 网关 ---------------- */

/**
 * 网关地址：OAUTH_GATEWAY_URL（末尾斜杠会被去掉，方便直接拼 /authorize、/token）。
 * 网关管哪些 Provider：OAUTH_GATEWAY_PROVIDERS（逗号分隔），不配 = github,google,wechat 都走网关。
 * 配了但一个合法名字都没有 = 没有 Provider 走网关（宁可不生效也不要静默放开）。
 */
export function gatewayUrl() {
  const raw = String(process.env.OAUTH_GATEWAY_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

export function gatewaySecret() {
  return String(process.env.OAUTH_GATEWAY_SECRET || '');
}

export function gatewayEnabled() {
  return !!gatewayUrl();
}

export function gatewayProviders() {
  const raw = String(process.env.OAUTH_GATEWAY_PROVIDERS || '').trim();
  if (!raw) return PROVIDERS.slice();
  return raw.split(',').map((k) => k.trim().toLowerCase()).filter((k) => PROVIDERS.indexOf(k) >= 0);
}

/** 这个 Provider 是否经网关：经网关返回网关地址，否则返回空串 */
function gatewayFor(name) {
  const p = String(name || '');
  if (!gatewayEnabled()) return '';
  return gatewayProviders().indexOf(p) >= 0 ? gatewayUrl() : '';
}

/** 后台自检用：网关开没开、管哪些 Provider、签名密钥配没配（不回显内容） */
export function gatewayInfo() {
  return {
    enabled: gatewayEnabled(),
    url: gatewayUrl(),
    providers: gatewayEnabled() ? gatewayProviders() : [],
    secretSet: !!gatewaySecret(),
    doc: 'docs/OAUTH.md'
  };
}

/**
 * 网关请求签名（客户端与自建网关共用同一套算法）：
 *   base = ts + '\n' + nonce + '\n' + provider + '\n' + code + '\n' + redirect_uri
 *   sig  = HMAC-SHA256(OAUTH_GATEWAY_SECRET, base) 的十六进制小写
 * 其中 ts 为秒级 Unix 时间戳，nonce 为一次性随机串，redirect_uri 与请求体里的字段同值。
 */
export async function gatewaySignature(secret, parts) {
  const p = parts || {};
  const base = [p.ts, p.nonce, p.provider, p.code, p.redirectUri].join('\n');
  return createHmac('sha256', String(secret)).update(base, 'utf8').digest('hex');
}

/** 网关侧判重放的时间判据：ts 与当前时间相差不超过 GATEWAY_TS_WINDOW 秒 */
export function gatewayTsFresh(ts, now = Date.now(), windowSec = GATEWAY_TS_WINDOW) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return false;
  const ms = t < 1e12 ? t * 1000 : t; // 秒和毫秒都认，省得网关传错单位还静默放过
  return Math.abs(Number(now) - ms) <= windowSec * 1000;
}

/** 一次性随机串（nonce）：网关用它把同一份签名只放行一次 */
export function randomNonce() {
  return randomBytes(16).toString('hex');
}

/** 网关返回的 error 码：只透传认识的，别的一律归成 exchange_failed（错误页会原样显示给用户） */
const GATEWAY_ERRORS = ['provider_disabled', 'exchange_failed', 'no_profile', 'bad_signature', 'stale_ts', 'replayed', 'unsupported_provider'];
function gatewayError(code) {
  const c = String(code || '');
  return GATEWAY_ERRORS.indexOf(c) >= 0 ? c : 'exchange_failed';
}

/* ---------------- 归一化 ---------------- */

/** 统一的资料形状：空值一律空串，绝不 undefined（界面与建号逻辑都不用再判） */
function s(v) {
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 把各 Provider 的原始资料归一到同一形状：
 *   { provider, providerId: 'github:123', username, displayName, email, avatar }
 * 另带 uid / name 两个旧字段：server.js 走的是 profile.uid，src/auth.js 走 profile.name /
 * profile.username / profile.email，值与原实现完全一致（username 为空时 auth.js 的
 * 「username || name || provider+uid」回退链与改前一致，规则没动）。
 * username 取自平台自己的账号名：GitHub 有（login），Google / 微信没有，就是空串。
 */
export function normalizeProfile(provider, raw) {
  const p = s(provider);
  const r = raw || {};
  const id = s(r.id !== undefined && r.id !== null ? r.id : r.uid);
  const name = s(r.name !== undefined && r.name !== null ? r.name : r.displayName);
  return {
    provider: p,
    providerId: id ? p + ':' + id : '',
    username: s(r.username),
    displayName: name,
    email: s(r.email),
    avatar: s(r.avatar),
    uid: id,
    name
  };
}

/* ---------------- Provider 开关 ---------------- */

/**
 * Provider 端点可被环境变量覆盖，方便接自建网关，也让本地端到端测试能指向假服务端：
 *   OAUTH_<PROVIDER>_AUTHORIZE_URL / OAUTH_<PROVIDER>_TOKEN_URL / OAUTH_<PROVIDER>_USER_URL
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
  if (gatewayFor(name)) return true; // 密钥在网关侧，本站不需要自己那份
  return !!creds(name);
}

export function devEnabled() {
  return process.env.NODE_ENV !== 'production' || process.env.OAUTH_DEV === '1';
}

/** 当前可用的第三方登录列表，模板直接拿去渲染按钮（形状保持 { key, label, icon } 不变） */
export function enabledProviders() {
  const list = PROVIDERS.filter(providerEnabled).map((k) => ({ key: k, label: META[k].label, icon: META[k].icon }));
  if (devEnabled()) list.push({ key: 'dev', label: META.dev.label, icon: META.dev.icon });
  return list;
}

export function redirectUri(origin, name) {
  return origin + '/auth/' + name + '/callback';
}

/** 微信「网站应用」扫码登录的授权地址：appid + snsapi_login + 末尾 #wechat_redirect（微信要的） */
function wechatAuthorizeUrl(c, origin, state) {
  const p = new URLSearchParams({
    appid: c.id,
    redirect_uri: redirectUri(origin, 'wechat'),
    response_type: 'code',
    scope: META.wechat.scope,
    state
  });
  return endpoint('wechat', 'AUTHORIZE_URL', META.wechat.authorize) + '?' + p.toString() + '#wechat_redirect';
}

/** 拼授权页地址（state 用于防 CSRF，存在 cookie 里回调时比对） */
export function authorizeUrl(name, origin, state) {
  const gw = gatewayFor(name);
  if (gw) {
    // 网关模式：站点不暴露自己的 client_id，网关拿它自己那份去拼第三方授权页
    const p = new URLSearchParams({
      provider: String(name),
      redirect_uri: redirectUri(origin, name),
      state
    });
    return gw + '/authorize?' + p.toString();
  }
  const c = creds(name);
  if (!c) return '';
  const m = META[name];
  if (name === 'wechat') return wechatAuthorizeUrl(c, origin, state);
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

/* ---------------- 换 token / 取资料 ---------------- */

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

/** GET 一个返回 JSON 的端点：微信的 token / userinfo 都是 GET（URL 里带 secret，出错也不打印它） */
async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 当失败处理 */ }
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
  return normalizeProfile('github', { id: u.id, username: u.login, name: u.name || u.login, email, avatar: u.avatar_url });
}

async function googleProfile(token) {
  const u = await (await fetch(endpoint('google', 'USER_URL', 'https://openidconnect.googleapis.com/v1/userinfo'), {
    headers: { Authorization: 'Bearer ' + token }
  })).json();
  return normalizeProfile('google', { id: u.sub, name: u.name, email: u.email, avatar: u.picture });
}

/**
 * 微信：先用 code 换 access_token + openid（GET），再拉昵称头像。
 * provider_uid 优先用 unionid（同一开放平台账号下跨应用稳定），没有就 openid。
 * 昵称 / 头像是展示用的，拉不到不影响登录（身份在换 token 那一步就拿到了）。
 */
async function wechatExchange(c, origin, code) {
  const q = new URLSearchParams({
    appid: c.id,
    secret: c.secret,
    code,
    grant_type: 'authorization_code'
  });
  try {
    const t = await getJson(endpoint('wechat', 'TOKEN_URL', META.wechat.token) + '?' + q.toString());
    const tok = t.json || {};
    if (!t.ok || tok.errcode || !tok.access_token || !tok.openid) return { error: 'exchange_failed' };
    let info = null;
    try {
      const u = await getJson(endpoint('wechat', 'USER_URL', META.wechat.user) + '?' + new URLSearchParams({
        access_token: tok.access_token,
        openid: tok.openid,
        lang: 'zh_CN'
      }).toString());
      if (u.ok && u.json && !u.json.errcode && u.json.openid) info = u.json;
    } catch { info = null; }
    return {
      profile: normalizeProfile('wechat', {
        id: tok.unionid || tok.openid,
        name: info ? info.nickname : '',
        avatar: info ? info.headimgurl : ''
      })
    };
  } catch (err) {
    console.error('[oauth:error]', err && err.message);
    return { error: 'exchange_failed' };
  }
}

/** 网关模式换资料：POST <网关>/token，body 是 JSON，签名在请求头里 */
async function gatewayExchange(name, gw, origin, code) {
  const secret = gatewaySecret();
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonce();
  const redirect = redirectUri(origin, name);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-oauth-ts': ts,
    'x-oauth-nonce': nonce
  };
  if (secret) headers['x-oauth-signature'] = await gatewaySignature(secret, { ts, nonce, provider: name, code, redirectUri: redirect });
  try {
    const res = await fetch(gw + '/token', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: name, code, redirect_uri: redirect, ts, nonce })
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!json) return { error: 'exchange_failed' };
    if (!res.ok || json.error) return { error: gatewayError(json.error) };
    const profile = normalizeProfile(name, json.profile);
    if (!profile.uid) return { error: 'no_profile' };
    return { profile };
  } catch (err) {
    console.error('[oauth:error]', err && err.message);
    return { error: 'exchange_failed' };
  }
}

/**
 * 用授权码换用户资料。
 * @returns {{error:string}|{profile:{provider:string,providerId:string,username:string,displayName:string,email:string,avatar:string,uid:string,name:string}}}
 */
export async function exchangeCode(name, origin, code) {
  const gw = gatewayFor(name);
  if (gw) return gatewayExchange(name, gw, origin, code);
  const c = creds(name);
  if (!c) return { error: 'provider_disabled' };
  if (name === 'wechat') return wechatExchange(c, origin, code);
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

/** 演示 Provider：不走网络，把参数当成资料直接返回（形状与真 Provider 一致） */
export function mockProfile(query) {
  const uid = String(query.uid || 'demo-1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'demo-1';
  const name = String(query.name || '演示用户' + uid).slice(0, 20);
  return normalizeProfile('dev', { id: uid, username: 'dev_' + uid, name, email: String(query.email || '').slice(0, 120) });
}
