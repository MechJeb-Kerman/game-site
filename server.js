import express from 'express';
import { join } from 'node:path';
import { PUBLIC_DIR, GAMES_DIR } from './src/db.js';
import { seed } from './src/seed.js';
import * as data from './src/data.js';
import * as ui from './src/views.js';
import * as auth from './src/auth.js';
import { coverSvg, ogSvg } from './src/cover.js';
import * as mail from './src/mail.js';
import * as oauth from './src/oauth.js';
import { randomBytes } from 'node:crypto';

// 首次启动自动建表 + 灌入种子数据，并保证有一个管理员账号
seed(false);
auth.ensureAdmin();

// 老库升级：search_pinyin 是后加的列，seed 不会算拼音，启动时把空索引补一遍（只处理空行，很快）
const indexedGames = data.reindexSearchIndex();
if (indexedGames) console.log('[search] 补建拼音索引 ' + indexedGames + ' 条');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '64kb' }));
// 登录 / 注册 / 投稿 / 后台都走原生表单提交，禁用 JS 也能用
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

/** 安全响应头（游戏为本站自研，故允许 inline/eval） */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
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
  );
  next();
});

const originOf = (req) => process.env.SITE_ORIGIN || req.protocol + '://' + req.get('host');

/** 每个请求解析一次登录态，页面模板和 JSON 接口共用 */
app.use((req, res, next) => {
  req.user = auth.currentUser(req);
  next();
});

/** 需要登录：页面跳登录页，接口返回 401 */
function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  res.status(401).json({ error: 'login_required', hint: '请先登录' });
}

/** 需要站长权限 */
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (req.method === 'GET') {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  res.status(403).json({ error: 'forbidden', hint: '只有站长能操作' });
}

/** 表单类接口的登录守卫：没登录就跳登录页，而不是回 JSON（浏览器直接提交表单时才不会看到一坨 JSON） */
function loginPageGuard(fallback) {
  return (req, res, next) => {
    if (req.user) return next();
    const n = (req.body || {}).next || fallback || '/';
    res.redirect('/login?next=' + encodeURIComponent(safeNext(n)));
  };
}

/** 往站内路径上挂查询参数，注意别挂到 # 片段后面去 */
function withQuery(path, kv) {
  const [base, hash] = String(path).split('#');
  return base + (base.includes('?') ? '&' : '?') + kv + (hash ? '#' + hash : '');
}

/** 只允许站内跳转，挡掉 //evil.com 这种开放重定向 */
function safeNext(n) {
  const s = String(n || '');
  return /^\/[^\/\\]/.test(s) || s === '/' ? s : '/';
}

/** 简洁的访问日志 */
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/static') || req.path.startsWith('/cover')) return;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`
    );
  });
  next();
});

// ---------- 静态资源 ----------
app.use('/static', express.static(PUBLIC_DIR, { maxAge: '7d', etag: true }));
// 生产环境建议把游戏放到独立域名（如 games.example.com）做沙箱隔离
app.use('/games', express.static(GAMES_DIR, { maxAge: '1h', etag: true }));

// ---------- 页面 ----------
app.get('/', (req, res) => {
  const origin = originOf(req);
  res.send(
    ui.homePage({
      origin,
      user: req.user,
      featured: data.listGames({ sort: 'hot', limit: 1 })[0] || null,
      hot: data.listGames({ sort: 'hot', limit: 8 }),
      newest: data.listGames({ sort: 'new', limit: 8 }),
      categories: data.listCategories(),
      tags: data.listTags(20),
      stats: data.siteStats()
    })
  );
});

app.get('/games', (req, res) => {
  const q = String(req.query.q || '');
  const sort = String(req.query.sort || 'hot');
  const opts = { q, sort, limit: 60 };
  res.send(
    ui.listPage({
      origin: originOf(req),
      user: req.user,
      path: '/games',
      heading: q ? '搜索：' + q : '全部游戏',
      sub: '按热度、评分或上架时间浏览全部小游戏',
      list: data.listGames(opts),
      total: data.countGames(opts),
      query: q,
      sort,
      base: '/games'
    })
  );
});

app.get('/category/:slug', (req, res) => {
  const cat = data.getCategory(req.params.slug);
  if (!cat) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  const sort = String(req.query.sort || 'hot');
  const opts = { category: cat.slug, sort, limit: 60 };
  res.send(
    ui.listPage({
      origin: originOf(req),
      user: req.user,
      path: '/category/' + cat.slug,
      heading: cat.icon + ' ' + cat.name + '小游戏',
      sub: '在线免费玩' + cat.name + '类小游戏，即点即玩',
      list: data.listGames(opts),
      total: data.countGames(opts),
      sort,
      base: '/category/' + cat.slug
    })
  );
});

app.get('/tag/:tag', (req, res) => {
  const tag = String(req.params.tag);
  const sort = String(req.query.sort || 'hot');
  const opts = { tag, sort, limit: 60 };
  res.send(
    ui.listPage({
      origin: originOf(req),
      user: req.user,
      path: '/tag/' + encodeURIComponent(tag),
      heading: '#' + tag,
      sub: '带有「' + tag + '」标签的小游戏',
      list: data.listGames(opts),
      total: data.countGames(opts),
      sort,
      base: '/tag/' + encodeURIComponent(tag)
    })
  );
});

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  const sort = String(req.query.sort || 'hot');
  const opts = { q, sort, limit: 60 };
  res.send(
    ui.listPage({
      origin: originOf(req),
      user: req.user,
      path: '/search?q=' + encodeURIComponent(q),
      heading: q ? '「' + q + '」的搜索结果' : '搜索游戏',
      sub: '输入游戏名、类型或标签进行搜索',
      list: data.listGames(opts),
      total: data.countGames(opts),
      query: q,
      sort,
      base: '/search'
    })
  );
});

/** 举报结果提示（落在详情页评论区顶部） */
const CMT_NOTICE = {
  ok: '举报已收到，站长会尽快处理 ✅',
  already: '你已经举报过这条评论了',
  bad_reason: '举报原因不对，换一个试试',
  not_found: '这条评论已经不在了'
};

app.get('/rank', (req, res) => {
  const board = data.leaderboard(data.boardKind(req.query.kind), 20);
  res.send(
    ui.rankPage({
      origin: originOf(req),
      user: req.user,
      kind: board.kind,
      label: board.label,
      metric: board.metric,
      rows: board.rows,
      boards: Object.entries(data.BOARD_KINDS).map(([k, v]) => ({ kind: k, label: v.label }))
    })
  );
});

app.get('/game/:slug', (req, res) => {
  const game = data.getGame(req.params.slug);
  if (!game) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  const uid = req.user ? req.user.id : 0;
  const cpage = Math.max(1, Number(req.query.cpage) || 1);
  res.send(
    ui.gamePage({
      origin: originOf(req),
      user: req.user,
      game,
      related: data.relatedGames(game, 6),
      myStars: data.myRating(game.slug, req.user ? String(uid) : ''),
      favorited: data.isFavorited(game.slug, uid),
      favCount: data.favoriteCount(game.slug),
      thread: data.commentThread(game.slug, cpage),
      commentTotal: data.countComments(game.slug),
      cmtNotice: CMT_NOTICE[String(req.query.report || '')] || ''
    })
  );
});

// ---------- 封面 / SEO 资源 ----------
app.get('/cover/:slug.svg', (req, res) => {
  const game = data.getGame(String(req.params.slug));
  if (!game) return res.status(404).end();
  res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400');
  res.send(coverSvg(game));
});

app.get('/static/img/og.svg', (req, res) => {
  res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400');
  res.send(ogSvg());
});

// 站点图标：独立游戏页（iframe 内）不会带上首页的 data-URI 图标，这里兜底，避免 404
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
  res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=604800');
  res.send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" rx="22" fill="#6366f1"/>' +
      '<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-size="62">🎮</text>' +
      '</svg>'
  );
});

app.get('/robots.txt', (req, res) => {
  const origin = originOf(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /login',
      'Disallow: /register',
      'Disallow: /favorites',
      'Disallow: /submit',
      'Disallow: /account',
      'Disallow: /forgot',
      'Disallow: /reset',
      'Disallow: /auth',
      'Disallow: /comments/',
      '',
      'Sitemap: ' + origin + '/sitemap.xml',
      ''
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = originOf(req);
  const urls = [{ loc: '/', pri: '1.0' }, { loc: '/rank', pri: '0.7' }];
  for (const c of data.listCategories()) {
    if (c.total > 0) urls.push({ loc: '/category/' + c.slug, pri: '0.8' });
  }
  for (const g of data.listGames({ sort: 'new', limit: 100 })) {
    urls.push({ loc: '/game/' + g.slug, pri: '0.9', lm: String(g.created_at).slice(0, 10) });
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls
      .map(
        (u) =>
          '<url><loc>' + origin + u.loc + '</loc>' +
          (u.lm ? '<lastmod>' + u.lm + '</lastmod>' : '') +
          '<priority>' + u.pri + '</priority></url>'
      )
      .join('') +
    '</urlset>';
  res.type('application/xml').send(body);
});

// ---------- JSON API ----------
app.get('/api/games', (req, res) => {
  const q = String(req.query.q || '');
  const category = String(req.query.category || '');
  const tag = String(req.query.tag || '');
  const sort = String(req.query.sort || 'hot');
  const limit = Math.min(60, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const opts = { q, category, tag, sort, limit, offset };
  res.json({
    total: data.countGames(opts),
    limit,
    offset,
    items: data.listGames(opts).map((g) => ({
      slug: g.slug,
      title: g.title,
      subtitle: g.subtitle,
      category: g.category ? g.category.slug : null,
      tags: g.tags,
      emoji: g.emoji,
      plays: g.plays,
      rating: g.rating,
      rating_count: g.rating_count,
      cover: '/cover/' + g.slug + '.svg',
      url: '/game/' + g.slug,
      game_url: g.game_url
    }))
  });
});

app.get('/api/games/:slug', (req, res) => {
  const g = data.getGame(req.params.slug);
  if (!g) return res.status(404).json({ error: 'not_found' });
  res.json(g);
});

/**
 * 搜索建议：走的是和列表页同一套相关度排序（标题 > 拼音前缀 > 拼音包含 > 副标题 > 标签）。
 * 输入拼音/首字母也能出结果，例如 tanchishe / tcs → 贪吃蛇。
 */
app.get('/api/search/suggest', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) return res.json({ q: '', items: [] });
  const items = data.listGames({ q, limit: 6 }).map((g) => ({
    slug: g.slug,
    title: g.title,
    emoji: g.emoji,
    category: g.category ? g.category.name : '',
    plays: g.plays,
    rating: g.rating
  }));
  res.json({ q, items });
});

/** 评论分页 JSON（详情页评论区 / 无刷新翻页用） */
app.get('/api/games/:slug/comments', (req, res) => {
  const slug = String(req.params.slug);
  if (!data.getGame(slug)) return res.status(404).json({ error: 'not_found' });
  const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || data.COMMENT_PAGE_SIZE));
  const thread = data.commentThread(slug, Math.max(1, Number(req.query.page) || 1), pageSize);
  res.json({ slug, total: thread.total, page: thread.page, pages: thread.pages, pageSize: thread.pageSize, items: thread.items });
});

/** 同一个 IP 对同一款游戏 30 秒内只计一次，避免刷新刷量 */
const recentPlays = new Map();
function dedupe(key, ms = 30000) {
  const now = Date.now();
  const last = recentPlays.get(key);
  if (last && now - last < ms) return false;
  recentPlays.set(key, now);
  if (recentPlays.size > 5000) recentPlays.clear();
  return true;
}

app.post('/api/games/:slug/play', (req, res) => {
  const slug = String(req.params.slug);
  if (!dedupe(req.ip + ':' + slug)) {
    const g = data.getGame(slug);
    return res.json({ counted: false, plays: g ? g.plays : 0 });
  }
  const plays = data.incrementPlay(slug);
  if (plays === null) return res.status(404).json({ error: 'not_found' });
  res.json({ counted: true, plays });
});

/**
 * 评分：1~5 星，一人一票、可改票（用登录用户 id 识别，未登录返回 401）。
 * 每次写入后按 ratings 表重算平均分与票数，回写 games 以便排序。
 */
app.post('/api/games/:slug/rate', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', hint: '登录后才能评分' });
  const stars = Number(req.body && req.body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'bad_stars', hint: 'stars 必须是 1~5 的整数' });
  }
  const r = data.rateGame(String(req.params.slug), String(req.user.id), stars);
  if (r.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// ---------- 账号 ----------

app.get('/login', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.send(ui.loginPage({ origin: originOf(req), next }));
});

app.post('/login', (req, res) => {
  const b = req.body || {};
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const r = auth.login(username, b.password);
  if (r.error) {
    return res.status(401).send(ui.loginPage({
      origin: originOf(req), next, error: r.error, username
    }));
  }
  auth.startSession(res, r.user.id);
  res.redirect(next);
});

app.get('/register', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.send(ui.registerPage({ origin: originOf(req), next }));
});

app.post('/register', (req, res) => {
  const b = req.body || {};
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const displayName = String(b.display_name || '');
  const v = auth.validateRegister(username, b.password, displayName);
  const fail = (error, status) => res.status(status).send(ui.registerPage({
    origin: originOf(req), next, error, username, displayName
  }));
  if (v.error) return fail(v.error, 400);
  if (auth.findUser(v.username)) return fail('这个用户名已经被注册了，换一个吧', 409);
  const user = auth.createUser(v.username, v.password, v.displayName);
  auth.startSession(res, user.id);
  res.redirect(next);
});

app.post('/logout', (req, res) => {
  auth.endSession(req, res);
  res.redirect('/');
});

/* ---------- 账号设置 / 邮箱验证 / 找回密码 ---------- */

/** 没配邮件服务时，把验证链接直接带回页面（开发自测用） */
function devLinkOf(origin, kind, token) {
  if (mail.mailConfigured()) return '';
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return '';
  return origin + (kind === 'reset' ? '/reset?token=' : '/verify-email?token=') + token;
}

app.get('/account', requireLogin, (req, res) => {
  res.send(
    ui.accountPage({
      origin: originOf(req),
      user: req.user,
      providers: oauth.enabledProviders(),
      links: auth.oauthAccountsOf(req.user.id).map((l) => {
        const m = oauth.providerMeta(l.provider);
        return { provider: l.provider, label: m ? m.icon + ' ' + m.label : l.provider, name: l.provider_uid };
      }),
      notice: String(req.query.ok || ''),
      error: String(req.query.err || ''),
      devLink: devLinkOf(originOf(req), 'verify', req.query.t)
    })
  );
});

app.post('/account/email', loginPageGuard('/account'), async (req, res) => {
  const email = auth.normalizeEmail((req.body || {}).email);
  if (req.user.email && email === auth.normalizeEmail(req.user.email)) {
    return res.redirect('/account?err=email_same');
  }
  const r = auth.setEmail(req.user.id, email);
  if (r.error) return res.redirect('/account?err=email');
  const m = mail.verifyMail(originOf(req), { name: req.user.name, username: req.user.username, email: r.email }, r.token);
  const sent = await mail.sendMail(m);
  data.logAudit(req.user, 'user.email', '#' + req.user.id, r.email);
  res.redirect('/account?ok=email' + (sent.ok && sent.dev ? '&t=' + r.token : ''));
});

app.post('/account/resend', loginPageGuard('/account'), async (req, res) => {
  if (!req.user.email || Number(req.user.email_verified)) return res.redirect('/account?err=resend');
  const r = auth.refreshVerifyToken(req.user.id);
  if (r.error) return res.redirect('/account?err=resend');
  const sent = await mail.sendMail(mail.verifyMail(originOf(req), req.user, r.token));
  res.redirect('/account?ok=resent' + (sent.ok && sent.dev ? '&t=' + r.token : ''));
});

app.post('/account/password', loginPageGuard('/account'), (req, res) => {
  const b = req.body || {};
  const r = auth.changePassword(req.user.id, b.old, b.password);
  if (r.error) return res.redirect('/account?err=password');
  data.logAudit(req.user, 'user.password', '#' + req.user.id, '');
  auth.endSession(req, res);
  res.send(
    ui.messagePage({
      origin: originOf(req), user: null, title: '密码已更新', heading: '密码已更新 ✅',
      sub: '所有设备都已退出登录，请用新密码重新登录', path: '/login'
    })
  );
});

app.post('/account/unlink', loginPageGuard('/account'), (req, res) => {
  const r = auth.unlinkOAuth(req.user.id, (req.body || {}).provider);
  if (r.error) return res.redirect('/account?err=unlink');
  data.logAudit(req.user, 'user.unlink', '#' + req.user.id, String((req.body || {}).provider || ''));
  res.redirect('/account?ok=unlink');
});

app.get('/verify-email', (req, res) => {
  const origin = originOf(req);
  const r = auth.verifyEmailToken(req.query.token);
  if (r.error) {
    return res.status(400).send(ui.messagePage({
      origin, user: req.user, title: '邮箱验证', heading: '验证没有成功', sub: r.error, path: '/account'
    }));
  }
  res.send(ui.messagePage({
    origin, user: req.user, title: '邮箱验证', heading: '邮箱验证成功 ✅',
    sub: (r.email || '') + ' 已验证，之后可以用它找回密码', path: '/account'
  }));
});

app.get('/forgot', (req, res) => {
  res.send(ui.forgotPage({ origin: originOf(req), user: req.user }));
});

app.post('/forgot', async (req, res) => {
  const origin = originOf(req);
  const r = auth.createResetToken((req.body || {}).account);
  let devLink = '';
  if (r.sent) {
    const m = mail.resetMail(origin, r.user, r.token);
    const sent = await mail.sendMail(m);
    if (sent.ok && sent.dev) devLink = m.link;
  }
  res.status(r.error ? 400 : 200).send(ui.forgotPage({
    origin, user: req.user, error: r.error || '', done: !r.error, devLink
  }));
});

app.get('/reset', (req, res) => {
  res.send(ui.resetPage({ origin: originOf(req), user: req.user, token: String(req.query.token || '') }));
});

app.post('/reset', (req, res) => {
  const origin = originOf(req);
  const b = req.body || {};
  const token = String(b.token || '');
  const fail = (error) => res.status(400).send(ui.resetPage({ origin, user: req.user, token, error }));
  if (String(b.password || '') !== String(b.password2 || '')) return fail('两次输入的密码不一样');
  const r = auth.consumeResetToken(token, b.password);
  if (r.error) return fail(r.error);
  res.send(ui.messagePage({
    origin, user: null, title: '密码已重置', heading: '密码已重置 ✅',
    sub: '所有设备都需要用新密码重新登录', path: '/login'
  }));
});

/* ---------- 第三方登录（OAuth 2.0） ---------- */

const OAUTH_STATE_COOKIE = 'oauth_state';

/** state 和登录后要去的地址一起塞进短命 cookie，回调时比对 */
function setStateCookie(res, state, next) {
  res.append('Set-Cookie',
    OAUTH_STATE_COOKIE + '=' + state + '.' + encodeURIComponent(next) +
    '; Path=/; Max-Age=600; SameSite=Lax; HttpOnly');
}

app.get('/auth/:provider', (req, res) => {
  const name = String(req.params.provider);
  const origin = originOf(req);
  const next = safeNext(req.query.next);
  if (!oauth.providerEnabled(name)) {
    return res.status(404).send(ui.messagePage({
      origin, user: req.user, title: '第三方登录', heading: '这个登录方式没有开启',
      sub: '需要先给站点配置对应的 Client ID / Secret', path: '/login'
    }));
  }
  const state = randomBytes(16).toString('hex');
  setStateCookie(res, state, next);
  if (oauth.providerMeta(name).mock) return res.redirect('/auth/dev/callback?code=mock&state=' + state);
  res.redirect(oauth.authorizeUrl(name, origin, state));
});

async function handleOAuthCallback(req, res) {
  const name = String(req.params.provider);
  const origin = originOf(req);
  const fail = (sub) => res.status(400).send(ui.messagePage({
    origin, user: req.user, title: '第三方登录', heading: '登录没有完成', sub, path: '/login'
  }));
  if (!oauth.providerEnabled(name)) return fail('这个登录方式没有开启');

  const raw = auth.readCookie(req, OAUTH_STATE_COOKIE);
  const dot = raw.indexOf('.');
  const state = dot < 0 ? raw : raw.slice(0, dot);
  const next = dot < 0 ? '/' : safeNext(decodeURIComponent(raw.slice(dot + 1)));
  if (!state || String(req.query.state || '') !== state) {
    return fail('登录状态校验失败，请重新发起一次（浏览器可能拦了临时 cookie）');
  }
  res.append('Set-Cookie', OAUTH_STATE_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');

  let profile;
  if (oauth.providerMeta(name).mock) {
    profile = oauth.mockProfile(req.query);
  } else {
    const code = String(req.query.code || '');
    if (!code) return fail('没有拿到授权码，可能是你取消了授权');
    const ex = await oauth.exchangeCode(name, origin, code);
    if (ex.error) return fail('换取用户资料失败（' + ex.error + '），稍后再试');
    profile = ex.profile;
  }
  const r = auth.oauthLogin(name, profile.uid, profile);
  if (r.error) return fail(r.error === '账号已被封禁' ? '账号已被封禁，请联系站长' : '登录失败，请换个方式再试');
  auth.startSession(res, r.user.id);
  data.logAudit(r.user, 'oauth.login', name, r.created ? '新账号' : (r.linked ? '按邮箱认领' : '已绑定'));
  res.redirect(next);
}

app.get('/auth/:provider/callback', (req, res) => {
  handleOAuthCallback(req, res).catch((err) => {
    console.error('[oauth:callback]', err);
    res.status(500).type('text/plain').send('第三方登录出错了，请稍后再试');
  });
});

app.get('/favorites', requireLogin, (req, res) => {
  const list = data.listFavorites(req.user.id);
  res.send(ui.favoritesPage({
    origin: originOf(req), user: req.user, list, total: list.length
  }));
});

// ---------- 投稿 ----------

app.get('/submit', requireLogin, (req, res) => {
  res.send(ui.submitPage({
    origin: originOf(req), user: req.user, categories: data.listCategories()
  }));
});

app.post('/submit', requireLogin, (req, res) => {
  const b = req.body || {};
  const r = data.createSubmission(b, req.user.id);
  res.status(r.error ? 400 : 200).send(ui.submitPage({
    origin: originOf(req), user: req.user, categories: data.listCategories(),
    error: r.error || '', values: b, done: r.slug || ''
  }));
});

// ---------- 后台 ----------

app.get('/admin', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  const status = req.query.status === undefined ? '' : String(req.query.status);
  const category = String(req.query.category || '');
  res.send(ui.adminPage({
    origin: originOf(req),
    user: req.user,
    stats: data.adminStats(),
    pending: data.listGamesByStatus(2, 100),
    managed: data.listManagedGames({ status, q, category, limit: 200 }),
    comments: data.listRecentComments({ limit: 30 }),
    reports: data.listReports(0, 50),
    users: data.listUsers({ q, limit: 100 }),
    audit: data.listAudit({ limit: 50 }),
    categories: data.listCategories(),
    filter: { q, status, category },
    outbox: mail.outbox(20),
    mailTransport: mail.transportName(),
    notice: String(req.query.ok || '')
  }));
});

/** 后台预览：待审核的投稿也能按玩家视角打开 */
app.get('/admin/preview/:slug', requireAdmin, (req, res) => {
  const game = data.getGameAny(req.params.slug);
  if (!game) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  res.send(ui.gamePage({
    origin: originOf(req),
    user: req.user,
    game,
    related: data.relatedGames(game, 4),
    preview: true,
    thread: data.commentThread(game.slug, 1),
    commentTotal: data.countComments(game.slug)
  }));
});

app.post('/admin/games/:slug/status', requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  const r = data.setGameStatus(slug, (req.body || {}).status);
  if (r.error) return res.status(404).type('text/plain').send('没有这个游戏');
  data.logAudit(req.user, 'game.status', slug, data.STATUS_LABEL[r.status] || String(r.status));
  res.redirect('/admin');
});

app.post('/admin/games/batch', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = data.setGamesStatus([].concat(b.slug || []), b.status);
  if (r.error) {
    const msg = r.error === 'empty' ? '没有选中任何游戏' : '状态不合法';
    return res.status(400).type('text/plain').send(msg);
  }
  data.logAudit(req.user, 'game.batch', data.STATUS_LABEL[r.status] || String(r.status),
    r.changed.length + ' 条：' + r.changed.slice(0, 12).join(', ') + (r.missing.length ? ' / 未找到 ' + r.missing.length + ' 条' : ''));
  res.redirect('/admin?ok=batch');
});

app.post('/admin/comments/:id/status', requireAdmin, (req, res) => {
  const r = data.setCommentStatus(req.params.id, (req.body || {}).status);
  if (r.error) return res.status(404).type('text/plain').send('没有这条评论');
  data.logAudit(req.user, 'comment.status', '#' + req.params.id, r.status ? '显示' : '隐藏');
  res.redirect('/admin?ok=comment');
});

app.post('/admin/reports/:id/status', requireAdmin, (req, res) => {
  const r = data.setReportStatus(req.params.id, (req.body || {}).status);
  if (r.error) return res.status(404).type('text/plain').send('没有这条举报');
  data.logAudit(req.user, 'report.status', '#' + req.params.id, r.status === 2 ? '忽略' : '已处理');
  res.redirect('/admin?ok=report');
});

app.post('/admin/users/:id/ban', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = data.setUserBanned(req.params.id, Number(b.banned) ? 1 : 0, b.reason);
  if (r.error) {
    const msg = r.error === 'cannot_ban_admin' ? '站长账号不可封禁' : '没有这个用户';
    return res.status(400).type('text/plain').send(msg);
  }
  data.logAudit(req.user, r.banned ? 'user.ban' : 'user.unban', '#' + req.params.id, String(b.reason || ''));
  res.redirect('/admin?ok=ban');
});

app.post('/admin/users/:id/verify', requireAdmin, (req, res) => {
  const r = auth.markEmailVerified(req.params.id);
  if (r.error) return res.status(404).type('text/plain').send('没有这个用户');
  data.logAudit(req.user, 'user.verify', '#' + req.params.id, '站长手动核实邮箱');
  res.redirect('/admin?ok=email');
});

// ---------- JSON API：账号 / 收藏 / 评论 ----------

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.post('/api/auth/login', (req, res) => {
  const b = req.body || {};
  const r = auth.login(String(b.username || ''), b.password);
  if (r.error) return res.status(401).json({ error: 'bad_credentials', hint: r.error });
  auth.startSession(res, r.user.id);
  res.json({ user: r.user });
});

app.post('/api/auth/register', (req, res) => {
  const b = req.body || {};
  const v = auth.validateRegister(b.username, b.password, b.display_name);
  if (v.error) return res.status(400).json({ error: 'bad_input', hint: v.error });
  if (auth.findUser(v.username)) return res.status(409).json({ error: 'taken', hint: '用户名已被注册' });
  const user = auth.createUser(v.username, v.password, v.displayName);
  auth.startSession(res, user.id);
  res.status(201).json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.post('/api/games/:slug/favorite', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', hint: '登录后才能收藏' });
  const r = data.toggleFavorite(String(req.params.slug), req.user.id);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json(r);
});

/** 评论限流：同一用户对同一游戏 10 秒内只能发一条（防手抖连点） */
const commentGate = new Map();

app.post('/api/games/:slug/comments', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', hint: '登录后才能评论' });
  const slug = String(req.params.slug);
  const key = req.user.id + ':' + slug;
  const now = Date.now();
  if (now - (commentGate.get(key) || 0) < 10000) {
    return res.status(429).json({ error: 'too_fast', hint: '发得太快了，歇 10 秒再发' });
  }
  const parentId = (req.body && req.body.parent_id) || null;
  const r = data.addComment(slug, req.user.id, req.body && req.body.body, parentId);
  if (r.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (r.error) {
    const hint = r.error === 'too_long' ? '评论最多 ' + data.COMMENT_MAX + ' 字'
      : r.error === 'bad_parent' ? '要回复的评论已经不存在了'
      : '评论不能为空';
    return res.status(400).json({ error: r.error, hint });
  }
  commentGate.set(key, now);
  if (commentGate.size > 5000) commentGate.clear();
  res.json({ id: r.id, body: r.body, name: req.user.name, parent_id: r.parent_id });
});

/** 举报一条评论（原生表单也能提交，所以用 302 跳回来） */
app.post('/comments/:id/report', loginPageGuard('/'), (req, res) => {
  const b = req.body || {};
  const r = data.reportComment(req.params.id, req.user.id, b.reason);
  const key = r.error ? r.error : (r.already ? 'already' : 'ok');
  res.redirect(withQuery(safeNext(b.next), 'report=' + encodeURIComponent(key)));
});

// ---------- 错误处理 ----------
app.use((req, res) => {
  res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).type('text/plain').send('500 Internal Server Error');
});

app.listen(PORT, () => {
  const s = data.siteStats();
  console.log('');
  console.log('  🎮  ' + ui.SITE.name + ' 已启动');
  console.log('  ➜  http://localhost:' + PORT);
  console.log('  📦  游戏 ' + s.games + ' 款 · 累计游玩 ' + s.plays + ' 次');
  if (auth.usingDefaultAdminPassword()) {
    console.log('  ⚠️  管理员仍是默认口令 admin / admin123，上线前务必用 ADMIN_USER / ADMIN_PASS 改掉');
  }
  console.log('');
});
