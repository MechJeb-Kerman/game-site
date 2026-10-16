/**
 * Cloudflare Workers + D1 完整版：页面与接口全部在 Worker 里动态渲染。
 * 路由与 Express 版 server.js 一一对应，模板直接复用 src/views.js、src/cover.js（纯函数、无 Node 依赖），
 * 数据落到 D1（worker/data.js），账号用 PBKDF2 + 库内会话（worker/auth.js）。
 * 静态资源（/static/*、/games/*）交给 Workers Static Assets（env.ASSETS）。
 */
import * as ui from '../src/views.js';
import { coverSvg, ogSvg } from '../src/cover.js';
import * as data from './data.js';
import * as auth from './auth.js';
import * as mail from './mail.js';
import * as oauth from './oauth.js';
import { ensureReady } from './schema.js';

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

const HTML_CACHE = 'public, max-age=0, must-revalidate';

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100" rx="22" fill="#6366f1"/>' +
  '<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-size="62">🎮</text>' +
  '</svg>';

/* ---------- 响应工具 ---------- */

function makeHeaders(ctx, opts) {
  const o = opts || {};
  const h = new Headers(SECURITY_HEADERS);
  h.set('content-type', o.type || 'text/html; charset=utf-8');
  if (o.cache) h.set('cache-control', o.cache);
  if (o.location) h.set('location', o.location);
  if (o.robot) h.set('x-robots-tag', o.robot);
  for (const c of ctx.cookies) h.append('set-cookie', c);
  return h;
}

function okHtml(ctx, body, status) {
  return new Response(body, { status: status || 200, headers: makeHeaders(ctx, { cache: HTML_CACHE }) });
}
function okJson(ctx, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: makeHeaders(ctx, { type: 'application/json; charset=utf-8', cache: 'no-store' })
  });
}
function plainText(ctx, text, status) {
  return new Response(text, {
    status: status || 200,
    headers: makeHeaders(ctx, { type: 'text/plain; charset=utf-8', cache: 'no-store' })
  });
}
function redirectTo(ctx, location) {
  return new Response(null, { status: 302, headers: makeHeaders(ctx, { location: location, cache: 'no-store' }) });
}

/* ---------- 请求工具 ---------- */

/** GET/HEAD 直接返回 {}；JSON 用 request.json()，表单用 request.formData() */
async function readBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const ct = String(request.headers.get('content-type') || '');
  try {
    if (ct.indexOf('application/json') >= 0) {
      const j = await request.json();
      return j && typeof j === 'object' ? j : {};
    }
    if (ct.indexOf('form') >= 0) {
      const fd = await request.formData();
      const o = {};
      for (const entry of fd.entries()) o[entry[0]] = typeof entry[1] === 'string' ? entry[1] : '';
      return o;
    }
    const text = await request.text();
    if (!text) return {};
    try {
      const j = JSON.parse(text);
      return j && typeof j === 'object' ? j : {};
    } catch {
      const o = {};
      for (const entry of new URLSearchParams(text).entries()) o[entry[0]] = entry[1];
      return o;
    }
  } catch {
    return {};
  }
}

/** 只允许站内跳转，挡掉 //evil.com 这种开放重定向 */
function safeNext(n) {
  const s = String(n || '');
  return /^\/[^\/\\]/.test(s) || s === '/' ? s : '/';
}

/** 往站内路径上挂查询参数，注意别挂到 # 片段后面去 */
function withQuery(path, kv) {
  const parts = String(path).split('#');
  const base = parts[0];
  const hash = parts.length > 1 ? parts.slice(1).join('#') : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + kv + (hash ? '#' + hash : '');
}

function randomState() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 举报结果提示（落在详情页评论区顶部） */
const CMT_NOTICE = {
  ok: '举报已收到，站长会尽快处理 ✅',
  already: '你已经举报过这条评论了',
  bad_reason: '举报原因不对，换一个试试',
  not_found: '这条评论已经不在了'
};

/** 没配邮件服务时，把验证链接直接带回页面（开发自测用） */
function devLinkOf(env, origin, kind, token) {
  if (mail.mailConfigured(env)) return '';
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return '';
  return origin + (kind === 'reset' ? '/reset?token=' : '/verify-email?token=') + token;
}

/** 简易路由：段数相同、:名 段取参数 */
function matchRoute(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].charAt(0) === ':') {
      try { params[p[i].slice(1)] = decodeURIComponent(s[i]); }
      catch { params[p[i].slice(1)] = s[i]; }
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}

/* ---------- 限流（isolate 内存，尽力而为，和 Express 版语义一致） ---------- */

const recentPlays = new Map();
function dedupe(key, ms) {
  const now = Date.now();
  const last = recentPlays.get(key);
  if (last && now - last < (ms || 30000)) return false;
  recentPlays.set(key, now);
  if (recentPlays.size > 5000) recentPlays.clear();
  return true;
}

const commentGate = new Map();

/* ================= 页面 ================= */

async function pageHome(ctx) {
  const db = ctx.db;
  const featured = (await data.listGames(db, { sort: 'hot', limit: 1 }))[0] || null;
  const hot = await data.listGames(db, { sort: 'hot', limit: 8 });
  const newest = await data.listGames(db, { sort: 'new', limit: 8 });
  const categories = await data.listCategories(db);
  const tags = await data.listTags(db, 20);
  const stats = await data.siteStats(db);
  return okHtml(ctx, ui.homePage({ origin: ctx.origin, user: ctx.user, featured, hot, newest, categories, tags, stats }));
}

async function pageGames(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '');
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const opts = { q: q, sort: sort, limit: 60 };
  return okHtml(ctx, ui.listPage({
    origin: ctx.origin, user: ctx.user, path: '/games',
    heading: q ? '搜索：' + q : '全部游戏',
    sub: '按热度、评分或上架时间浏览全部小游戏',
    list: await data.listGames(ctx.db, opts),
    total: await data.countGames(ctx.db, opts),
    query: q, sort: sort, base: '/games'
  }));
}

async function pageCategory(ctx, params) {
  const cat = await data.getCategory(ctx.db, params.slug);
  if (!cat) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const opts = { category: cat.slug, sort: sort, limit: 60 };
  return okHtml(ctx, ui.listPage({
    origin: ctx.origin, user: ctx.user, path: '/category/' + cat.slug,
    heading: cat.icon + ' ' + cat.name + '小游戏',
    sub: '在线免费玩' + cat.name + '类小游戏，即点即玩',
    list: await data.listGames(ctx.db, opts),
    total: await data.countGames(ctx.db, opts),
    sort: sort, base: '/category/' + cat.slug
  }));
}

async function pageTag(ctx, params) {
  const tag = String(params.tag);
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const opts = { tag: tag, sort: sort, limit: 60 };
  return okHtml(ctx, ui.listPage({
    origin: ctx.origin, user: ctx.user, path: '/tag/' + encodeURIComponent(tag),
    heading: '#' + tag,
    sub: '带有「' + tag + '」标签的小游戏',
    list: await data.listGames(ctx.db, opts),
    total: await data.countGames(ctx.db, opts),
    sort: sort, base: '/tag/' + encodeURIComponent(tag)
  }));
}

async function pageSearch(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '').slice(0, 50);
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const opts = { q: q, sort: sort, limit: 60 };
  return okHtml(ctx, ui.listPage({
    origin: ctx.origin, user: ctx.user,
    path: '/search?q=' + encodeURIComponent(q),
    heading: q ? '「' + q + '」的搜索结果' : '搜索游戏',
    sub: '输入游戏名、类型或标签进行搜索',
    list: await data.listGames(ctx.db, opts),
    total: await data.countGames(ctx.db, opts),
    query: q, sort: sort, base: '/search'
  }));
}

async function pageGame(ctx, params) {
  const db = ctx.db;
  const game = await data.getGame(db, params.slug);
  if (!game) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const uid = ctx.user ? ctx.user.id : 0;
  const cpage = Math.max(1, Number(ctx.url.searchParams.get('cpage')) || 1);
  return okHtml(ctx, ui.gamePage({
    origin: ctx.origin, user: ctx.user, game: game,
    related: await data.relatedGames(db, game, 6),
    myStars: await data.myRating(db, game.slug, ctx.user ? String(uid) : ''),
    favorited: await data.isFavorited(db, game.slug, uid),
    favCount: await data.favoriteCount(db, game.slug),
    thread: await data.commentThread(db, game.slug, cpage),
    commentTotal: await data.countComments(db, game.slug),
    cmtNotice: CMT_NOTICE[String(ctx.url.searchParams.get('report') || '')] || ''
  }));
}

/** 排行榜：热玩榜按天聚合的纯 SQLite 查询，7 个榜单切着看 */
async function pageRank(ctx) {
  const board = await data.leaderboard(ctx.db, data.boardKind(ctx.url.searchParams.get('kind')), 20);
  return okHtml(ctx, ui.rankPage({
    origin: ctx.origin,
    user: ctx.user,
    kind: board.kind,
    label: board.label,
    metric: board.metric,
    rows: board.rows,
    boards: Object.entries(data.BOARD_KINDS).map(function (e) { return { kind: e[0], label: e[1].label }; })
  }));
}

/* ================= 账号 ================= */

async function pageLogin(ctx) {
  const next = safeNext(ctx.url.searchParams.get('next'));
  if (ctx.user) return redirectTo(ctx, next);
  return okHtml(ctx, ui.loginPage({ origin: ctx.origin, next: next }));
}

async function doLogin(ctx) {
  const b = await readBody(ctx.request);
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const r = await auth.login(ctx.db, username, b.password);
  if (r.error) {
    return okHtml(ctx, ui.loginPage({ origin: ctx.origin, next: next, error: r.error, username: username }), 401);
  }
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600));
  return redirectTo(ctx, next);
}

async function pageRegister(ctx) {
  const next = safeNext(ctx.url.searchParams.get('next'));
  if (ctx.user) return redirectTo(ctx, next);
  return okHtml(ctx, ui.registerPage({ origin: ctx.origin, next: next }));
}

async function doRegister(ctx) {
  const b = await readBody(ctx.request);
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const displayName = String(b.display_name || '');
  const v = auth.validateRegister(username, b.password, displayName);
  const fail = (error, status) => okHtml(ctx, ui.registerPage({
    origin: ctx.origin, next: next, error: error, username: username, displayName: displayName
  }), status);
  if (v.error) return fail(v.error, 400);
  if (await auth.findUser(ctx.db, v.username)) return fail('这个用户名已经被注册了，换一个吧', 409);
  const user = await auth.createUser(ctx.db, v.username, v.password, v.displayName);
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, user.id), auth.SESSION_DAYS * 24 * 3600));
  return redirectTo(ctx, next);
}

async function doLogout(ctx) {
  await auth.destroySession(ctx.db, auth.readCookie(ctx.request.headers.get('cookie'), auth.COOKIE));
  ctx.cookies.push(auth.sessionCookie('', 0));
  return redirectTo(ctx, '/');
}

async function pageFavorites(ctx) {
  const list = await data.listFavorites(ctx.db, ctx.user.id);
  return okHtml(ctx, ui.favoritesPage({ origin: ctx.origin, user: ctx.user, list: list, total: list.length }));
}

/* ---------- 账号设置 / 邮箱验证 / 找回密码 ---------- */

/** 表单类页面在未登录时回登录页（而不是 JSON 401） */
function needLogin(ctx, fallback, body) {
  if (ctx.user) return null;
  const n = (body && body.next) || fallback || '/';
  return redirectTo(ctx, '/login?next=' + encodeURIComponent(safeNext(n)));
}

async function pageAccount(ctx) {
  const links = (await auth.oauthAccountsOf(ctx.db, ctx.user.id)).map(function (l) {
    const m = oauth.providerMeta(l.provider);
    return { provider: l.provider, label: m ? m.icon + ' ' + m.label : l.provider, name: l.provider_uid };
  });
  return okHtml(ctx, ui.accountPage({
    origin: ctx.origin,
    user: ctx.user,
    providers: oauth.enabledProviders(ctx.env),
    links: links,
    notice: String(ctx.url.searchParams.get('ok') || ''),
    error: String(ctx.url.searchParams.get('err') || ''),
    devLink: devLinkOf(ctx.env, ctx.origin, 'verify', ctx.url.searchParams.get('t'))
  }));
}

async function doAccountEmail(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/account', b);
  if (guard) return guard;
  const email = auth.normalizeEmail(b.email);
  if (ctx.user.email && email === auth.normalizeEmail(ctx.user.email)) {
    return redirectTo(ctx, '/account?err=email_same');
  }
  const r = await auth.setEmail(ctx.db, ctx.user.id, email);
  if (r.error) return redirectTo(ctx, '/account?err=email');
  const m = mail.verifyMail(ctx.origin, { name: ctx.user.name, username: ctx.user.username, email: r.email }, r.token);
  const sent = await mail.sendMail(ctx.env, m);
  await data.logAudit(ctx.db, ctx.user, 'user.email', '#' + ctx.user.id, r.email);
  return redirectTo(ctx, '/account?ok=email' + (sent.ok && sent.dev ? '&t=' + r.token : ''));
}

async function doAccountResend(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/account', b);
  if (guard) return guard;
  if (!ctx.user.email || Number(ctx.user.email_verified)) return redirectTo(ctx, '/account?err=resend');
  const r = await auth.refreshVerifyToken(ctx.db, ctx.user.id);
  if (r.error) return redirectTo(ctx, '/account?err=resend');
  const sent = await mail.sendMail(ctx.env, mail.verifyMail(ctx.origin, ctx.user, r.token));
  return redirectTo(ctx, '/account?ok=resent' + (sent.ok && sent.dev ? '&t=' + r.token : ''));
}

async function doAccountPassword(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/account', b);
  if (guard) return guard;
  const r = await auth.changePassword(ctx.db, ctx.user.id, b.old, b.password);
  if (r.error) return redirectTo(ctx, '/account?err=password');
  await data.logAudit(ctx.db, ctx.user, 'user.password', '#' + ctx.user.id, '');
  await auth.destroySession(ctx.db, auth.readCookie(ctx.request.headers.get('cookie'), auth.COOKIE));
  ctx.cookies.push(auth.sessionCookie('', 0));
  return okHtml(ctx, ui.messagePage({
    origin: ctx.origin, user: null, title: '密码已更新', heading: '密码已更新 ✅',
    sub: '所有设备都已退出登录，请用新密码重新登录', path: '/login'
  }));
}

async function doAccountUnlink(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/account', b);
  if (guard) return guard;
  const r = await auth.unlinkOAuth(ctx.db, ctx.user.id, b.provider);
  if (r.error) return redirectTo(ctx, '/account?err=unlink');
  await data.logAudit(ctx.db, ctx.user, 'user.unlink', '#' + ctx.user.id, String(b.provider || ''));
  return redirectTo(ctx, '/account?ok=unlink');
}

async function pageVerifyEmail(ctx) {
  const r = await auth.verifyEmailToken(ctx.db, ctx.url.searchParams.get('token'));
  if (r.error) {
    return okHtml(ctx, ui.messagePage({
      origin: ctx.origin, user: ctx.user, title: '邮箱验证', heading: '验证没有成功', sub: r.error, path: '/account'
    }), 400);
  }
  return okHtml(ctx, ui.messagePage({
    origin: ctx.origin, user: ctx.user, title: '邮箱验证', heading: '邮箱验证成功 ✅',
    sub: (r.email || '') + ' 已验证，之后可以用它找回密码', path: '/account'
  }));
}

async function pageForgot(ctx) {
  return okHtml(ctx, ui.forgotPage({ origin: ctx.origin, user: ctx.user }));
}

async function doForgot(ctx) {
  const r = await auth.createResetToken(ctx.db, (await readBody(ctx.request)).account);
  let devLink = '';
  if (r.sent) {
    const m = mail.resetMail(ctx.origin, r.user, r.token);
    const sent = await mail.sendMail(ctx.env, m);
    if (sent.ok && sent.dev) devLink = m.link;
  }
  return okHtml(ctx, ui.forgotPage({
    origin: ctx.origin, user: ctx.user, error: r.error || '', done: !r.error, devLink: devLink
  }), r.error ? 400 : 200);
}

async function pageReset(ctx) {
  return okHtml(ctx, ui.resetPage({
    origin: ctx.origin, user: ctx.user, token: String(ctx.url.searchParams.get('token') || '')
  }));
}

async function doReset(ctx) {
  const b = await readBody(ctx.request);
  const token = String(b.token || '');
  const fail = (error) => okHtml(ctx, ui.resetPage({ origin: ctx.origin, user: ctx.user, token: token, error: error }), 400);
  if (String(b.password || '') !== String(b.password2 || '')) return fail('两次输入的密码不一样');
  const r = await auth.consumeResetToken(ctx.db, token, b.password);
  if (r.error) return fail(r.error);
  return okHtml(ctx, ui.messagePage({
    origin: ctx.origin, user: null, title: '密码已重置', heading: '密码已重置 ✅',
    sub: '所有设备都需要用新密码重新登录', path: '/login'
  }));
}

/* ---------- 第三方登录（OAuth 2.0） ---------- */

const OAUTH_STATE_COOKIE = 'oauth_state';

/** state 和登录后要去的地址一起塞进短命 cookie，回调时比对 */
function stateCookie(state, next) {
  return OAUTH_STATE_COOKIE + '=' + state + '.' + encodeURIComponent(next) +
    '; Path=/; Max-Age=600; SameSite=Lax; HttpOnly';
}

async function doAuthProvider(ctx, params) {
  const name = String(params.provider);
  const next = safeNext(ctx.url.searchParams.get('next'));
  if (!oauth.providerEnabled(name, ctx.env)) {
    return okHtml(ctx, ui.messagePage({
      origin: ctx.origin, user: ctx.user, title: '第三方登录', heading: '这个登录方式没有开启',
      sub: '需要先给站点配置对应的 Client ID / Secret', path: '/login'
    }), 404);
  }
  const state = randomState();
  ctx.cookies.push(stateCookie(state, next));
  if (oauth.providerMeta(name).mock) return redirectTo(ctx, '/auth/dev/callback?code=mock&state=' + state);
  return redirectTo(ctx, oauth.authorizeUrl(name, ctx.origin, state, ctx.env));
}

async function doAuthCallback(ctx, params) {
  const name = String(params.provider);
  const fail = (sub) => okHtml(ctx, ui.messagePage({
    origin: ctx.origin, user: ctx.user, title: '第三方登录', heading: '登录没有完成', sub: sub, path: '/login'
  }), 400);
  if (!oauth.providerEnabled(name, ctx.env)) return fail('这个登录方式没有开启');

  const raw = auth.readCookie(ctx.request.headers.get('cookie'), OAUTH_STATE_COOKIE);
  const dot = raw.indexOf('.');
  const state = dot < 0 ? raw : raw.slice(0, dot);
  let next = '/';
  if (dot >= 0) {
    try { next = safeNext(decodeURIComponent(raw.slice(dot + 1))); } catch { next = '/'; }
  }
  if (!state || String(ctx.url.searchParams.get('state') || '') !== state) {
    return fail('登录状态校验失败，请重新发起一次（浏览器可能拦了临时 cookie）');
  }
  ctx.cookies.push(OAUTH_STATE_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');

  let profile;
  if (oauth.providerMeta(name).mock) {
    profile = oauth.mockProfile(ctx.url.searchParams);
  } else {
    const code = String(ctx.url.searchParams.get('code') || '');
    if (!code) return fail('没有拿到授权码，可能是你取消了授权');
    const ex = await oauth.exchangeCode(name, ctx.origin, code, ctx.env);
    if (ex.error) return fail('换取用户资料失败（' + ex.error + '），稍后再试');
    profile = ex.profile;
  }
  const r = await auth.oauthLogin(ctx.db, name, profile.uid, profile);
  if (r.error) return fail(r.error === '账号已被封禁' ? '账号已被封禁，请联系站长' : '登录失败，请换个方式再试');
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600));
  await data.logAudit(ctx.db, r.user, 'oauth.login', name, r.created ? '新账号' : (r.linked ? '按邮箱认领' : '已绑定'));
  return redirectTo(ctx, next);
}

/* ================= 投稿 ================= */

async function pageSubmit(ctx) {
  return okHtml(ctx, ui.submitPage({
    origin: ctx.origin, user: ctx.user, categories: await data.listCategories(ctx.db)
  }));
}

async function doSubmit(ctx) {
  const b = await readBody(ctx.request);
  const r = await data.createSubmission(ctx.db, b, ctx.user.id);
  return okHtml(ctx, ui.submitPage({
    origin: ctx.origin, user: ctx.user, categories: await data.listCategories(ctx.db),
    error: r.error || '', values: b, done: r.slug || ''
  }), r.error ? 400 : 200);
}

/* ================= 后台 ================= */

async function pageAdmin(ctx) {
  const db = ctx.db;
  const q = String(ctx.url.searchParams.get('q') || '').trim().slice(0, 40);
  const raw = ctx.url.searchParams.get('status');
  const status = raw === null ? '' : String(raw);
  const category = String(ctx.url.searchParams.get('category') || '');
  return okHtml(ctx, ui.adminPage({
    origin: ctx.origin, user: ctx.user,
    stats: await data.adminStats(db),
    pending: await data.listGamesByStatus(db, 2, 100),
    managed: await data.listManagedGames(db, { status: status, q: q, category: category, limit: 200 }),
    comments: await data.listRecentComments(db, { limit: 30 }),
    reports: await data.listReports(db, 0, 50),
    users: await data.listUsers(db, { q: q, limit: 100 }),
    audit: await data.listAudit(db, { limit: 50 }),
    categories: await data.listCategories(db),
    filter: { q: q, status: status, category: category },
    outbox: mail.outbox(20),
    mailTransport: mail.transportName(ctx.env),
    notice: String(ctx.url.searchParams.get('ok') || '')
  }));
}

/** 后台预览：待审核的投稿也能按玩家视角打开 */
async function adminPreview(ctx, params) {
  const game = await data.getGameAny(ctx.db, String(params.slug));
  if (!game) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  return okHtml(ctx, ui.gamePage({
    origin: ctx.origin,
    user: ctx.user,
    game: game,
    related: await data.relatedGames(ctx.db, game, 4),
    preview: true,
    thread: await data.commentThread(ctx.db, game.slug, 1),
    commentTotal: await data.countComments(ctx.db, game.slug)
  }));
}

async function adminSetGame(ctx, params) {
  const b = await readBody(ctx.request);
  const slug = String(params.slug);
  const r = await data.setGameStatus(ctx.db, slug, b.status);
  if (r.error) return plainText(ctx, '没有这个游戏', 404);
  await data.logAudit(ctx.db, ctx.user, 'game.status', slug, data.STATUS_LABEL[r.status] || String(r.status));
  return redirectTo(ctx, '/admin');
}

/** 批量上下架：勾选多张卡一次处理，没找到的照样记账 */
async function adminBatch(ctx) {
  const b = await readBody(ctx.request);
  const r = await data.setGamesStatus(ctx.db, [].concat(b.slug || []), b.status);
  if (r.error) {
    return plainText(ctx, r.error === 'empty' ? '没有选中任何游戏' : '状态不合法', 400);
  }
  await data.logAudit(ctx.db, ctx.user, 'game.batch', data.STATUS_LABEL[r.status] || String(r.status),
    r.changed.length + ' 条：' + r.changed.slice(0, 12).join(', ') +
    (r.missing.length ? ' / 未找到 ' + r.missing.length + ' 条' : ''));
  return redirectTo(ctx, '/admin?ok=batch');
}

async function adminSetComment(ctx, params) {
  const b = await readBody(ctx.request);
  const r = await data.setCommentStatus(ctx.db, params.id, b.status);
  if (r.error) return plainText(ctx, '没有这条评论', 404);
  await data.logAudit(ctx.db, ctx.user, 'comment.status', '#' + params.id, r.status ? '显示' : '隐藏');
  return redirectTo(ctx, '/admin?ok=comment');
}

async function adminReportStatus(ctx, params) {
  const b = await readBody(ctx.request);
  const r = await data.setReportStatus(ctx.db, params.id, b.status);
  if (r.error) return plainText(ctx, '没有这条举报', 404);
  await data.logAudit(ctx.db, ctx.user, 'report.status', '#' + params.id, r.status === 2 ? '忽略' : '已处理');
  return redirectTo(ctx, '/admin?ok=report');
}

async function adminUserBan(ctx, params) {
  const b = await readBody(ctx.request);
  const r = await data.setUserBanned(ctx.db, params.id, Number(b.banned) ? 1 : 0, b.reason);
  if (r.error) {
    return plainText(ctx, r.error === 'cannot_ban_admin' ? '站长账号不可封禁' : '没有这个用户', 400);
  }
  await data.logAudit(ctx.db, ctx.user, r.banned ? 'user.ban' : 'user.unban', '#' + params.id, String(b.reason || ''));
  return redirectTo(ctx, '/admin?ok=ban');
}

async function adminUserVerify(ctx, params) {
  const r = await auth.markEmailVerified(ctx.db, params.id);
  if (r.error) return plainText(ctx, '没有这个用户', 404);
  await data.logAudit(ctx.db, ctx.user, 'user.verify', '#' + params.id, '站长手动核实邮箱');
  return redirectTo(ctx, '/admin?ok=email');
}

/* ================= JSON API ================= */

async function apiMe(ctx) {
  return okJson(ctx, { user: ctx.user });
}

async function apiLogin(ctx) {
  const b = await readBody(ctx.request);
  const r = await auth.login(ctx.db, String(b.username || ''), b.password);
  if (r.error) return okJson(ctx, { error: 'bad_credentials', hint: r.error }, 401);
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600));
  return okJson(ctx, { user: r.user });
}

async function apiRegister(ctx) {
  const b = await readBody(ctx.request);
  const v = auth.validateRegister(b.username, b.password, b.display_name);
  if (v.error) return okJson(ctx, { error: 'bad_input', hint: v.error }, 400);
  if (await auth.findUser(ctx.db, v.username)) return okJson(ctx, { error: 'taken', hint: '用户名已被注册' }, 409);
  const user = await auth.createUser(ctx.db, v.username, v.password, v.displayName);
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, user.id), auth.SESSION_DAYS * 24 * 3600));
  return okJson(ctx, { user: user }, 201);
}

async function apiLogout(ctx) {
  await auth.destroySession(ctx.db, auth.readCookie(ctx.request.headers.get('cookie'), auth.COOKIE));
  ctx.cookies.push(auth.sessionCookie('', 0));
  return okJson(ctx, { ok: true });
}

const GAME_BRIEF = (g) => ({
  slug: g.slug, title: g.title, subtitle: g.subtitle,
  category: g.category ? g.category.slug : null,
  tags: g.tags, emoji: g.emoji, plays: g.plays,
  rating: g.rating, rating_count: g.rating_count,
  cover: '/cover/' + g.slug + '.svg',
  url: '/game/' + g.slug,
  game_url: g.game_url
});

async function apiGames(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '');
  const category = String(ctx.url.searchParams.get('category') || '');
  const tag = String(ctx.url.searchParams.get('tag') || '');
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const limit = Math.min(60, Number(ctx.url.searchParams.get('limit')) || 24);
  const offset = Math.max(0, Number(ctx.url.searchParams.get('offset')) || 0);
  const opts = { q: q, category: category, tag: tag, sort: sort, limit: limit, offset: offset };
  return okJson(ctx, {
    total: await data.countGames(ctx.db, opts),
    limit: limit,
    offset: offset,
    items: (await data.listGames(ctx.db, opts)).map(GAME_BRIEF)
  });
}

async function apiGame(ctx, params) {
  const g = await data.getGame(ctx.db, params.slug);
  if (!g) return okJson(ctx, { error: 'not_found' }, 404);
  return okJson(ctx, g);
}

async function apiPlay(ctx, params) {
  const slug = String(params.slug);
  const ip = ctx.request.headers.get('cf-connecting-ip') || 'local';
  if (!dedupe(ip + ':' + slug)) {
    const g = await data.getGame(ctx.db, slug);
    return okJson(ctx, { counted: false, plays: g ? g.plays : 0 });
  }
  const plays = await data.incrementPlay(ctx.db, slug);
  if (plays === null) return okJson(ctx, { error: 'not_found' }, 404);
  return okJson(ctx, { counted: true, plays: plays });
}

async function apiRate(ctx, params) {
  if (!ctx.user) return okJson(ctx, { error: 'login_required', hint: '登录后才能评分' }, 401);
  const stars = Number((await readBody(ctx.request)).stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return okJson(ctx, { error: 'bad_stars', hint: 'stars 必须是 1~5 的整数' }, 400);
  }
  const r = await data.rateGame(ctx.db, String(params.slug), String(ctx.user.id), stars);
  if (r.error === 'not_found') return okJson(ctx, { error: 'not_found' }, 404);
  if (r.error) return okJson(ctx, { error: r.error }, 400);
  return okJson(ctx, r);
}

async function apiFavorite(ctx, params) {
  if (!ctx.user) return okJson(ctx, { error: 'login_required', hint: '登录后才能收藏' }, 401);
  const r = await data.toggleFavorite(ctx.db, String(params.slug), ctx.user.id);
  if (r.error) return okJson(ctx, { error: r.error }, 404);
  return okJson(ctx, r);
}

async function apiComment(ctx, params) {
  if (!ctx.user) return okJson(ctx, { error: 'login_required', hint: '登录后才能评论' }, 401);
  const slug = String(params.slug);
  const key = ctx.user.id + ':' + slug;
  const now = Date.now();
  if (now - (commentGate.get(key) || 0) < 10000) {
    return okJson(ctx, { error: 'too_fast', hint: '发得太快了，歇 10 秒再发' }, 429);
  }
  const body = await readBody(ctx.request);
  const parentId = body.parent_id || null;
  const r = await data.addComment(ctx.db, slug, ctx.user.id, body.body, parentId);
  if (r.error === 'not_found') return okJson(ctx, { error: 'not_found' }, 404);
  if (r.error) {
    const hint = r.error === 'too_long' ? '评论最多 ' + data.COMMENT_MAX + ' 字'
      : r.error === 'bad_parent' ? '要回复的评论已经不存在了'
      : '评论不能为空';
    return okJson(ctx, { error: r.error, hint: hint }, 400);
  }
  commentGate.set(key, now);
  if (commentGate.size > 5000) commentGate.clear();
  return okJson(ctx, { id: r.id, body: r.body, name: ctx.user.name, parent_id: r.parent_id });
}

/** 搜索建议：和列表页同一套相关度排序，输入拼音/首字母也能命中 */
async function apiSuggest(ctx) {
  const q = String(ctx.url.searchParams.get('q') || '').trim().slice(0, 40);
  if (!q) return okJson(ctx, { q: '', items: [] });
  const list = await data.listGames(ctx.db, { q: q, limit: 6 });
  return okJson(ctx, {
    q: q,
    items: list.map(function (g) {
      return {
        slug: g.slug, title: g.title, emoji: g.emoji,
        category: g.category ? g.category.name : '',
        plays: g.plays, rating: g.rating
      };
    })
  });
}

/** 评论分页 JSON（详情页评论区无刷新翻页用） */
async function apiComments(ctx, params) {
  const slug = String(params.slug);
  if (!(await data.getGame(ctx.db, slug))) return okJson(ctx, { error: 'not_found' }, 404);
  const pageSize = Math.max(1, Math.min(50,
    Number(ctx.url.searchParams.get('pageSize')) || data.COMMENT_PAGE_SIZE));
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const thread = await data.commentThread(ctx.db, slug, page, pageSize);
  return okJson(ctx, {
    slug: slug, total: thread.total, page: thread.page, pages: thread.pages,
    pageSize: thread.pageSize, items: thread.items
  });
}

/** 举报一条评论（原生表单也能提交，所以跳回详情页带上 report 结果） */
async function doReport(ctx, params) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/', b);
  if (guard) return guard;
  const r = await data.reportComment(ctx.db, params.id, ctx.user.id, b.reason);
  const key = r.error ? r.error : (r.already ? 'already' : 'ok');
  return redirectTo(ctx, withQuery(safeNext(b.next), 'report=' + encodeURIComponent(key)));
}

/* ================= 路由表 ================= */

const ROUTES = [
  { m: 'GET', p: '/', fn: pageHome },
  { m: 'GET', p: '/games', fn: pageGames },
  { m: 'GET', p: '/category/:slug', fn: pageCategory },
  { m: 'GET', p: '/tag/:tag', fn: pageTag },
  { m: 'GET', p: '/search', fn: pageSearch },
  { m: 'GET', p: '/game/:slug', fn: pageGame },
  { m: 'GET', p: '/rank', fn: pageRank },
  { m: 'GET', p: '/login', fn: pageLogin },
  { m: 'POST', p: '/login', fn: doLogin },
  { m: 'GET', p: '/register', fn: pageRegister },
  { m: 'POST', p: '/register', fn: doRegister },
  { m: 'POST', p: '/logout', fn: doLogout },
  { m: 'GET', p: '/favorites', fn: pageFavorites, need: 'user' },
  { m: 'GET', p: '/submit', fn: pageSubmit, need: 'user' },
  { m: 'POST', p: '/submit', fn: doSubmit, need: 'user' },
  { m: 'GET', p: '/admin', fn: pageAdmin, need: 'admin' },
  { m: 'POST', p: '/admin/games/:slug/status', fn: adminSetGame, need: 'admin' },
  { m: 'POST', p: '/admin/comments/:id/status', fn: adminSetComment, need: 'admin' },
  { m: 'GET', p: '/api/me', fn: apiMe },
  { m: 'POST', p: '/api/auth/login', fn: apiLogin },
  { m: 'POST', p: '/api/auth/register', fn: apiRegister },
  { m: 'POST', p: '/api/auth/logout', fn: apiLogout },
  { m: 'GET', p: '/api/games', fn: apiGames },
  { m: 'GET', p: '/api/games/:slug', fn: apiGame },
  { m: 'POST', p: '/api/games/:slug/play', fn: apiPlay },
  { m: 'POST', p: '/api/games/:slug/rate', fn: apiRate },
  { m: 'POST', p: '/api/games/:slug/favorite', fn: apiFavorite },
  { m: 'POST', p: '/api/games/:slug/comments', fn: apiComment },
  { m: 'GET', p: '/api/search/suggest', fn: apiSuggest },
  { m: 'GET', p: '/api/games/:slug/comments', fn: apiComments },
  { m: 'POST', p: '/comments/:id/report', fn: doReport },
  { m: 'GET', p: '/account', fn: pageAccount, need: 'user' },
  { m: 'POST', p: '/account/email', fn: doAccountEmail },
  { m: 'POST', p: '/account/resend', fn: doAccountResend },
  { m: 'POST', p: '/account/password', fn: doAccountPassword },
  { m: 'POST', p: '/account/unlink', fn: doAccountUnlink },
  { m: 'GET', p: '/verify-email', fn: pageVerifyEmail },
  { m: 'GET', p: '/forgot', fn: pageForgot },
  { m: 'POST', p: '/forgot', fn: doForgot },
  { m: 'GET', p: '/reset', fn: pageReset },
  { m: 'POST', p: '/reset', fn: doReset },
  { m: 'GET', p: '/auth/:provider', fn: doAuthProvider },
  { m: 'GET', p: '/auth/:provider/callback', fn: doAuthCallback },
  { m: 'GET', p: '/admin/preview/:slug', fn: adminPreview, need: 'admin' },
  { m: 'POST', p: '/admin/games/batch', fn: adminBatch, need: 'admin' },
  { m: 'POST', p: '/admin/reports/:id/status', fn: adminReportStatus, need: 'admin' },
  { m: 'POST', p: '/admin/users/:id/ban', fn: adminUserBan, need: 'admin' },
  { m: 'POST', p: '/admin/users/:id/verify', fn: adminUserVerify, need: 'admin' }
];

/* ================= SEO 资源 ================= */

function robotsText(origin) {
  return [
    'User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin',
    'Disallow: /login', 'Disallow: /register', 'Disallow: /favorites', 'Disallow: /submit',
    'Disallow: /account', 'Disallow: /forgot', 'Disallow: /reset', 'Disallow: /auth',
    'Disallow: /comments/', '',
    'Sitemap: ' + origin + '/sitemap.xml', ''
  ].join('\n');
}

async function sitemapXml(ctx) {
  const urls = [{ loc: '/', pri: '1.0' }, { loc: '/rank', pri: '0.7' }];
  for (const c of await data.listCategories(ctx.db)) {
    if (c.total > 0) urls.push({ loc: '/category/' + c.slug, pri: '0.8' });
  }
  for (const g of await data.listGames(ctx.db, { sort: 'new', limit: 100 })) {
    urls.push({ loc: '/game/' + g.slug, pri: '0.9', lm: String(g.created_at).slice(0, 10) });
  }
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map((u) => '<url><loc>' + ctx.origin + u.loc + '</loc>' +
      (u.lm ? '<lastmod>' + u.lm + '</lastmod>' : '') +
      '<priority>' + u.pri + '</priority></url>').join('') +
    '</urlset>';
  return new Response(body, {
    status: 200,
    headers: makeHeaders(ctx, { type: 'application/xml; charset=utf-8', cache: 'public, max-age=3600' })
  });
}

/* ================= 静态资源 ================= */

const ASSET_CACHE = (pathname) => {
  if (/^\/static\//.test(pathname)) return 'public, max-age=604800';
  if (/^\/games\//.test(pathname)) return 'public, max-age=3600';
  return 'public, max-age=3600';
};

async function serveAsset(ctx) {
  try {
    const req = new Request(ctx.url.origin + ctx.pathname + ctx.url.search, { method: 'GET' });
    const r = await ctx.env.ASSETS.fetch(req);
    // 跳转也当作没有这个资源：资源层不该发跳转（wrangler 配置里 html_handling = "none"），
    // 透传给浏览器会让它陷入重定向循环。
    if (r.status === 404 || r.status === 405 || (r.status >= 300 && r.status < 400)) return null;
    const h = makeHeaders(ctx, { cache: ASSET_CACHE(ctx.pathname) });
    const ct = r.headers.get('content-type');
    if (ct) h.set('content-type', ct);
    const etag = r.headers.get('etag');
    if (etag) h.set('etag', etag);
    return new Response(r.body, { status: r.status, headers: h });
  } catch {
    return null;
  }
}

/* ================= 入口 ================= */

export async function appFetch(request, env) {
  const started = Date.now();
  if (!env || !env.DB) {
    return new Response('D1 binding "DB" is not configured. See DEPLOY-CLOUDFLARE-D1.md.', {
      status: 503,
      headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS)
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  const ctx = {
    request: request, env: env, db: env.DB, url: url, pathname: pathname,
    origin: env.SITE_ORIGIN || url.origin,
    user: null,
    cookies: []
  };

  let res;
  try {
    await ensureReady(env);
    ctx.user = await auth.currentUser(env.DB, request);
    res = await route(ctx);
  } catch (err) {
    console.error('[error] ' + (err && err.stack ? err.stack : err));
    res = new Response('500 Internal Server Error', {
      status: 500,
      headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS)
    });
  }

  if (pathname.indexOf('/static') !== 0 && pathname.indexOf('/cover') !== 0) {
    console.log(request.method + ' ' + pathname + url.search + ' ' + res.status + ' ' + (Date.now() - started) + 'ms');
  }
  return res;
}

async function route(ctx) {
  const pathname = ctx.pathname;
  const method = ctx.request.method;

  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    const h = makeHeaders(ctx, { cache: 'no-store' });
    h.set('allow', 'GET, HEAD, POST');
    return new Response('405 Method Not Allowed', { status: 405, headers: h });
  }

  // 站点图标：独立游戏页（iframe 内）不会带上首页的 data-URI 图标，这里兜底，避免 404
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return new Response(FAVICON_SVG, {
      status: 200,
      headers: makeHeaders(ctx, { type: 'image/svg+xml', cache: 'public, max-age=604800' })
    });
  }

  if (pathname === '/robots.txt') {
    return new Response(robotsText(ctx.origin), {
      status: 200,
      headers: makeHeaders(ctx, { type: 'text/plain; charset=utf-8', cache: 'public, max-age=3600' })
    });
  }

  if (pathname === '/sitemap.xml') return sitemapXml(ctx);

  if (/^\/cover\/[^\/]+\.svg$/.test(pathname)) {
    const game = await data.getGame(ctx.db, pathname.slice(7, -4));
    if (!game) return new Response(null, { status: 404, headers: makeHeaders(ctx, { cache: 'no-store' }) });
    return new Response(coverSvg(game), {
      status: 200,
      headers: makeHeaders(ctx, { type: 'image/svg+xml', cache: 'public, max-age=86400' })
    });
  }

  if (/^\/static\//.test(pathname) || /^\/games\//.test(pathname)) {
    const asset = await serveAsset(ctx);
    if (asset) return asset;
    if (pathname === '/static/img/og.svg') {
      return new Response(ogSvg(), {
        status: 200,
        headers: makeHeaders(ctx, { type: 'image/svg+xml', cache: 'public, max-age=86400' })
      });
    }
    return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  }

  for (const r of ROUTES) {
    if (r.m !== method) continue;
    const params = matchRoute(r.p, pathname);
    if (!params) continue;
    if (r.need === 'user' && !ctx.user) {
      if (method === 'GET') return redirectTo(ctx, '/login?next=' + encodeURIComponent(pathname + ctx.url.search));
      return okJson(ctx, { error: 'login_required', hint: '请先登录' }, 401);
    }
    if (r.need === 'admin' && (!ctx.user || ctx.user.role !== 'admin')) {
      if (method === 'GET') return redirectTo(ctx, '/login?next=' + encodeURIComponent(pathname + ctx.url.search));
      return okJson(ctx, { error: 'forbidden', hint: '只有站长能操作' }, 403);
    }
    return r.fn(ctx, params);
  }

  return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
}

export default { fetch: appFetch };
