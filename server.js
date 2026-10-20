import express from 'express';
import { join } from 'node:path';
import { PUBLIC_DIR, GAMES_DIR, db as sqlite } from './src/db.js';
import { seed } from './src/seed.js';
import * as data from './src/data.js';
import * as ui from './src/views.js';
import * as auth from './src/auth.js';
import { coverSvg, ogSvg } from './src/cover.js';
import * as mail from './src/mail.js';
import * as oauth from './src/oauth.js';
import { randomBytes } from 'node:crypto';
import { formFromMultipart, parseMultipart } from './src/multipart.js';
import * as forum from './src/data-forum.js';
import * as fguard from './src/forum-guard.js';
// 导航页的主机判定：fishport.cn / www.fishport.cn / nav.fishport.cn
import { PORTAL_HOSTS } from './src/sites.js';
import * as play from './src/play-store.js';
import * as social from './src/social.js';
import { dayKey, makeupCheck } from './src/daily.js';
import { replayCardSvg, profileCardSvg, dailyCardSvg } from './src/cards.js';
import { makeSearchBackend, meiliBackend, sqlBackend } from './src/search.js';
import { createCache, redisLikeAdapter } from './src/rank-cache.js';
import * as outbox from './src/outbox.js';
import * as attachments from './src/attachments.js';
import { createBanCache } from './src/ratelimit.js';
import * as elo from './src/elo.js';
import * as og from './src/og.js';
import * as rules from './src/rules/index.js';

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

/* ---------- 第二轮接线的单例（进程内建一次，测试可注入） ---------- */

/** 封禁名单的内存缓存（TTL 60 秒）：封禁 / 解封时 invalidate 一下，别等它自己过期 */
const banCache = createBanCache({ ttlMs: 60000 });
app.locals.banCache = banCache;

/**
 * 论坛附件存储：Express 线用磁盘（data/attachments/），元数据进同一个 sqlite 库。
 * 建不起来（比如目录不可写）时留 null，路由层直接 404，不让整个站点起不来。
 */
const attachStore = attachments.createStore({ driver: 'fs' });
if (attachStore && attachStore.error) {
  console.error('[attach] 存储没建起来：' + attachStore.error + ' ' + String(attachStore.hint || ''));
}
app.locals.attachStore = attachStore;

/**
 * og:image 位图栅格化：用本机 Chrome / Edge 无头截一张 1200x630 PNG。
 * 没装浏览器时 png() 返回 { ok:false, error:'no_browser' }，路由回退发同一张 SVG 卡片。
 */
const rasterizer = og.createRasterizer({ driver: process.env.OG_DRIVER || 'chrome' });
app.locals.rasterizer = rasterizer;

/* ---------- 第二轮接线的共用小工具（附件 / og 位图 / 天梯） ---------- */

/** 表单体：普通提交读 urlencoded 解析好的 req.body；带文件的提交走 express.raw，这里自己 parse */
function parsedOf(req) {
  if (Buffer.isBuffer(req.body)) return parseMultipart(req.body, req.headers['content-type']);
  return { fields: req.body || {}, files: {}, list: [] };
}
function formOf(req) {
  return parsedOf(req).fields;
}

/**
 * 保存这一次提交里的附件（论坛正文里的 📎）。失败只记一行日志，绝不打断发帖——
 * 帖子已经写进库了，为了一个附件把用户弹回错误页反而不合适。
 */
async function saveUploads(req, place) {
  const p = parsedOf(req);
  const files = p.list || [];
  if (!files.length || !attachStore || attachStore.error) return [];
  const place2 = place || {};
  const saved = [];
  for (const f of files) {
    if (!f.name) continue;
    try {
      const r = await attachStore.save({
        ownerId: place2.ownerId,
        threadId: place2.threadId || 0,
        postId: place2.postId || 0,
        filename: f.name,
        mime: f.type,
        bytes: f.bytes
      });
      if (r && r.ok) saved.push(r);
      else if (r && r.error) console.warn('[attach] 附件没收下：' + r.error + (r.hint ? '（' + r.hint + '）' : ''));
    } catch (e) {
      console.warn('[attach] 附件写入异常：' + (e && e.message ? e.message : e));
    }
  }
  return saved;
}

/**
 * 主题页附件：主题级（post_id=0，发帖时附件先落、楼层随后）单独一层，楼层按 post_id 分组。
 * 与 Worker 线 worker/app.js 的 withAttachments 同口径（附件不入 data-forum 的帖子行，读侧自己补）。
 */
async function withAttachments(threadId, posts) {
  const r = attachStore && !attachStore.error ? await attachStore.listByThread(threadId) : null;
  const items = r && Array.isArray(r.items) ? r.items : [];
  const top = [];
  const byPost = new Map();
  for (const a of items) {
    const pid = Number(a.post_id || 0);
    if (!pid) { top.push(a); continue; }
    if (!byPost.has(pid)) byPost.set(pid, []);
    byPost.get(pid).push(a);
  }
  return {
    thread: top,
    posts: (posts || []).map((p) => Object.assign({}, p, { attachments: byPost.get(Number(p.id)) || [] }))
  };
}

/**
 * og 位图：渲染成功发 PNG，失败（没装浏览器 / 渲染超时）回退发同一张 SVG 卡片，绝不 404。
 * 位图是给微信 / X 这类只认位图的平台用的；页面里的 og:image 仍是 SVG（见 README）。
 */
async function sendOgOrCard(res, kind, key, svg) {
  let r = null;
  try {
    r = await rasterizer.png({ kind: kind, key: key, svg: svg });
  } catch (e) {
    r = { ok: false, error: 'render_failed', message: e && e.message ? e.message : String(e) };
  }
  if (r && r.ok) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(Buffer.from(r.bytes));
  }
  if (r && r.error && r.error !== 'no_browser' && r.error !== 'not_configured') {
    console.warn('[og] 位图没渲染出来（' + r.error + '）：' + String(r.message || ''));
  }
  return sendCard(res, svg);
}

/** 联机天梯：四款服务端裁判棋（src/rules 支持的那四款），Elo 由 play-store 结算 */
const LADDER_GAMES = rules.SLUGS;

/** 天梯页的切换条：[{slug,title,icon}] */
function ladderTabs() {
  return LADDER_GAMES.map(function (slug) {
    const g = data.getGame(slug) || {};
    return { slug: slug, title: g.title || slug, icon: g.emoji || '♟' };
  });
}

/**
 * 主页的联机天梯面板：只列这个人真下过（games > 0）的那几款。
 * 榜取前 200，没进榜就当没上榜；分数与胜负都以 ratingBoard 的行为准。
 */
function ratingsOf(userId) {
  const season = elo.seasonOf(Date.now());
  const out = [];
  for (const slug of LADDER_GAMES) {
    const board = play.ratingBoard(sqlite, slug, season, 200);
    const rows = (board && board.items) || [];
    const idx = rows.findIndex(function (x) { return Number(x.userId) === Number(userId); });
    if (idx < 0) continue;
    const row = rows[idx];
    if (!row || !Number(row.games)) continue;
    const g = data.getGame(slug) || {};
    out.push({
      game: slug, title: g.title || slug, icon: g.emoji || '♟',
      rating: Number(row.rating), games: Number(row.games),
      wins: Number(row.wins), losses: Number(row.losses), draws: Number(row.draws),
      peak: Number(row.peak), rank: Number(row.rank || idx + 1), total: Number(board.total || 0)
    });
  }
  return out;
}


/**
 * 安全响应头（游戏为本站自研，故允许 inline/eval）。
 * frame-src 额外放行 http(s)：投稿允许填任意外站地址，本站玩法就是把那个地址 iframe 进来，
 * 只写 'self' 会把外站游戏整块拦成「该内容被屏蔽了」（不同子域也不算 'self'）。
 * script-src / connect-src 另外放行 Cloudflare 的 RUM beacon：边缘会自动往 HTML 里插
 * beacon.min.js，不放行就是每页控制台一条 CSP 拦截报错，统计也收不到数。
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://cloudflareinsights.com",
      "frame-src 'self' https: http:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  next();
});

/**
 * 投稿上传的单文件 HTML 用这组响应头：CSP 的 sandbox 指令把文档降级成不透明源，
 * 于是上传的脚本即使被单独打开，也读不到本站的登录态、cookie 与存储。
 */
const UGC_HTML_CSP = [
  'sandbox allow-scripts allow-pointer-lock allow-orientation-lock',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-ancestors 'self'"
].join('; ');

/* ---------- 论坛挂载 ----------
   论坛有两种访问形态：游戏站上的 /forum/*，以及 forum.fishport.cn 的根路径。
   后者的请求在这里被内部重写成 /forum/*，页面里的链接基址用 req.forumBase（'' 或 '/forum'），
   同一套路由与模板在两种形态下都能用；/forum/* 与全站公共前缀不受影响。 */
const FORUM_SHARED = /^\/(static|games|cover|ugc|api|auth|login|register|logout|account|admin|forum|nav|favicon\.ico|robots\.txt|sitemap\.xml|manifest\.webmanifest|sw\.js|precache\.json|icons)(\/|$)/;

app.use((req, res, next) => {
  const host = String(req.get('host') || '').split(':')[0].toLowerCase();
  const onForum = /^forum\./.test(host);
  req.forumBase = onForum ? '' : '/forum';
  if (onForum && !FORUM_SHARED.test(req.path)) req.url = '/forum' + (req.url === '/' ? '' : req.url);
  /* 导航页：门户主机的根路径直接渲染它（子域清单见 src/sites.js），其余主机走 /nav */
  if (PORTAL_HOSTS.test(host) && req.path === '/') req.url = '/nav';
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
// PWA 图标：public/ 根目录没有整体挂静态，单独把 icons 目录挂出来（manifest 里声明的 4 张图）
app.use('/icons', express.static(join(PUBLIC_DIR, 'icons'), { maxAge: '30d', etag: true }));
// 生产环境建议把游戏放到独立域名（如 games.example.com）做沙箱隔离
app.use('/games', express.static(GAMES_DIR, { maxAge: '1h', etag: true }));

// 投稿上传的单文件 HTML：正文存在库里，按 slug 取出来。待审/已下架的只给站长看，
// 免得猜 slug 就能看到未上架内容；响应头用 CSP sandbox 把它降级成不透明源。
app.get('/ugc/:file', (req, res) => {
  const notFound = () => res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
  // 投稿标题是中文时 slugify 会保留中文，所以这里不限定字符集，只看扩展名和长度；
  // 真正的门禁是下面那行「库里有没有这个文件 + 有没有上架」。
  const m = /^(.+)\.html?$/i.exec(String(req.params.file || ''));
  const slug = m ? m[1] : '';
  if (!slug || slug.length > 64 || slug.indexOf('/') >= 0 || slug.indexOf('\\') >= 0) return notFound();
  const game = data.getGameAny(slug);
  const file = game ? data.getGameFile(slug) : null;
  const isAdmin = !!req.user && req.user.role === 'admin';
  if (!game || !file || (Number(game.status) !== 1 && !isAdmin)) return notFound();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', UGC_HTML_CSP);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(file.html);
});

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
      stats: data.siteStats(),
      // 首页顶部横幅：置顶优先，其次最新的一条已发布公告
      notice: data.latestNotice()
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

/* ---------- 搜索后端接线：Meilisearch 可选 + SQL 永远兜底 ----------
 *
 * 硬规矩：search() 永不抛错。没配 MEILI_HOST 时 primary 为 null，makeSearchBackend 直接走 SQL 兜底，
 * 结果与接线前完全一致；配了 Meili 但挂了 / 超时 / 熔断了，也只是退回同一套 SQL，请求照样 200。
 *
 * env（README 口径，worker 线同名）：
 *   MEILI_HOST         形如 http://127.0.0.1:7700；空或未设 = 不启用主后端
 *   MEILI_API_KEY      可空
 *   MEILI_INDEX        默认 games
 *   SEARCH_TIMEOUT_MS  单次主后端上限，默认 1500
 */
const MEILI_HOST = String(process.env.MEILI_HOST || '').trim();
const MEILI_INDEX = String(process.env.MEILI_INDEX || '').trim() || 'games';
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) > 0 ? Number(process.env.SEARCH_TIMEOUT_MS) : 1500;

/** 列表页与建议接口的条数上限（与接线前一致：60 / 6） */
const SEARCH_PAGE_LIMIT = 60;
const SUGGEST_LIMIT = 6;

/**
 * SQL 兜底腿 = 接线前那两个 data 调用的原样封装。
 * 它吃的是 opts.rawQuery（路由拿到的原样 q），不是 normalizeQuery 折过空白的 text：
 * data.searchPlan 自己会 trim + 小写，但不折内部连续空白，用 text 会让 /search?q=a%20%20b 的结果变化。
 * 站点自己的排序令牌（hot/new/rating）只在兜底腿生效——Meili 腿按它自己的相关度排，
 * 所以走 opts.siteSort 而不是塞进 Meili 的 body.sort（Meili 的 sort 是 ["field:asc"] 那种形状）。
 */
const sqlFallback = sqlBackend(async (q, opts = {}) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = {
    q: typeof o.rawQuery === 'string' ? o.rawQuery : q,
    sort: o.siteSort || 'hot',
    limit: Number(o.limit) > 0 ? Number(o.limit) : SEARCH_PAGE_LIMIT
  };
  return { items: data.listGames(args), total: data.countGames(args) };
});

/** 惰性建后端：没配 Meili 的部署连这段构造都不跑 */
let searchBackendInstance = null;
function getSearchBackend() {
  if (searchBackendInstance) return searchBackendInstance;
  const primary = MEILI_HOST
    ? meiliBackend({
        url: MEILI_HOST,
        apiKey: process.env.MEILI_API_KEY || '',
        index: MEILI_INDEX,
        fetchImpl: fetch, // 全局 fetch（Node >= 18）；注入是为了可测
        timeoutMs: SEARCH_TIMEOUT_MS
      })
    : null;
  searchBackendInstance = makeSearchBackend({ primary: primary, fallback: sqlFallback, timeoutMs: SEARCH_TIMEOUT_MS });
  if (MEILI_HOST) console.log('[search] 主后端 meilisearch ' + MEILI_HOST + ' index=' + MEILI_INDEX);
  return searchBackendInstance;
}

/**
 * 映射层：把后端返回的 items 变成 ui.listPage / 建议接口期望的「完整游戏行」。
 *   - Meili 命中是 { slug, title, score }，拿 slug 回本站库取整行（与列表页同源），顺序仍按 Meili 的相关度；
 *     库里查不到的（下架 / 已删）直接丢掉，所以 total 有可能略大于实际渲染条数。
 *   - SQL 兜底腿给的本来就是完整行（data.listGames 的产物），原样透传。
 */
function toFullGames(result) {
  const items = Array.isArray(result && result.items) ? result.items : [];
  if (!result || result.backend !== 'meili') return items;
  const out = [];
  for (const hit of items) {
    const g = data.getGame(String((hit && hit.slug) || ''));
    if (g) out.push(g);
  }
  return out;
}

/**
 * 跑一次搜索。降级日志只在「配了 Meili 却没答上来」时打一行（形如 [search] fallback ...）；
 * 没配 Meili 的正常兜底路径不打，否则每个搜索请求都刷屏。
 */
async function runSearch(q, opts) {
  const backend = getSearchBackend();
  const result = await backend.search(q, opts);
  if (MEILI_HOST && result.source !== 'primary') {
    console.log('[search] fallback q=' + JSON.stringify(String(q).slice(0, 40)) +
      ' reason=' + String(backend.stats().lastError || 'n/a') + ' backend=' + result.backend);
  }
  return result;
}

app.get('/search', (req, res, next) => {
  const q = String(req.query.q || '').slice(0, 50);
  const sort = String(req.query.sort || 'hot');
  // rawQuery 交给兜底腿用，保证没配 Meili 时与接线前逐字节一致；siteSort 同上（只在兜底腿生效）
  runSearch(q, { limit: SEARCH_PAGE_LIMIT, offset: 0, rawQuery: q, siteSort: sort })
    .then((hit) => {
      res.send(
        ui.listPage({
          origin: originOf(req),
          user: req.user,
          path: '/search?q=' + encodeURIComponent(q),
          heading: q ? '「' + q + '」的搜索结果' : '搜索游戏',
          sub: '输入游戏名、类型或标签进行搜索',
          list: toFullGames(hit),
          total: hit.total,
          query: q,
          sort,
          base: '/search'
        })
      );
    })
    .catch(next); // 真出错（比如库挂了）交给 Express 错误处理，与接线前的同步抛错同样是 500
});


/** 举报结果提示（落在详情页评论区顶部） */
const CMT_NOTICE = {
  ok: '举报已收到，站长会尽快处理 ✅',
  already: '你已经举报过这条评论了',
  bad_reason: '举报原因不对，换一个试试',
  not_found: '这条评论已经不在了'
};

/* ---------- 榜单缓存：进程内 TTL + 单飞 ----------
 *
 * /rank 每次都要对 play_logs 做实时聚合，而它是最热的页面之一；真正常见的是「同一个榜单被一堆人同时刷」，
 * 靠单飞把那波并发合并成一次聚合，30 秒内复用同一份结果。
 *
 * 远程缓存接缝：本仓库零依赖，没有 redis 客户端，所以默认就是纯内存。
 * 若启动时 globalThis.__QW_REDIS__ 上挂了形如 { get, set, del, keys } 的最小客户端
 * （node-redis v4 / ioredis 的常用方法就长这样），就用 redisLikeAdapter 包一层走远程；
 * 接真 Redis 需要在这个部署的启动脚本里引入客户端依赖并挂上去，例如
 *   globalThis.__QW_REDIS__ = createClient({ url: process.env.REDIS_URL }).connect()
 * 仓库本身不引依赖。适配器远端一抖就永久退化成纯内存，榜单不会因为 Redis 抖一下整块挂掉。
 *
 * RANK_CACHE_TTL_MS 是给测试用的加速旋钮（默认 30000），生产不用管它。
 */
const RANK_CACHE_TTL_MS = Number(process.env.RANK_CACHE_TTL_MS) > 0 ? Number(process.env.RANK_CACHE_TTL_MS) : 30000;
const RANK_CACHE_MAX = 200;
const rankCache = typeof globalThis.__QW_REDIS__ !== 'undefined' && globalThis.__QW_REDIS__
  ? redisLikeAdapter(globalThis.__QW_REDIS__, { ttlMs: RANK_CACHE_TTL_MS, maxEntries: RANK_CACHE_MAX, keyPrefix: 'rank:' })
  : createCache({ ttlMs: RANK_CACHE_TTL_MS, maxEntries: RANK_CACHE_MAX });
app.locals.rankCache = rankCache; // 测试与排障观察点：stats() 能看出这次请求有没有真打库

/**
 * 榜单缓存 key：把能影响这次结果的全部入参都编进去。
 * kind 先过 data.boardKind（非法值回落 today），所以 ?kind=xx 与不带参数共用一份缓存；
 * range / by / page 目前不参与取数（README:220 写了 ?range= / ?by=，实现只认 ?kind=，已向 Lead 报告），
 * 照样编进 key——将来真接上时不会串味。
 */
function rankKey(query) {
  const q = query || {};
  return 'rank:' + data.boardKind(q.kind) + ':' + String(q.range || '') + ':' + String(q.by || '') +
    ':' + String(q.page || '') + ':' + RANK_CACHE_LIMIT;
}
const RANK_CACHE_LIMIT = 20; // data.leaderboard 的条数（接线前就是 20）

app.get('/rank', (req, res, next) => {
  rankCache
    .getOrLoad(rankKey(req.query), () => data.leaderboard(data.boardKind(req.query.kind), RANK_CACHE_LIMIT))
    .then((board) => {
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
    })
    .catch(next); // loader 抛错（比如库挂了）原样交给错误处理，与接线前同样 500
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
      cmtNotice: CMT_NOTICE[String(req.query.report || '')] || '',
      // ?watch=观战钥匙 / ?replay=棋谱 id：只是把参数透传给 iframe 里的播放器，权限校验都在 API 侧
      watch: String(req.query.watch || ''),
      replay: String(req.query.replay || '')
    })
  );
});

app.get('/notice', (req, res) => {
  const list = data.listPublishedPosts({ page: Math.max(1, Number(req.query.page) || 1) });
  res.send(
    ui.noticeListPage({
      origin: originOf(req),
      user: req.user,
      items: list.items,
      total: list.total,
      page: list.page,
      pages: list.pages
    })
  );
});

app.get('/notice/:slug', (req, res) => {
  const post = data.getPost(String(req.params.slug));
  if (!post) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  const cpage = Math.max(1, Number(req.query.cpage) || 1);
  res.send(
    ui.noticePage({
      origin: originOf(req),
      user: req.user,
      post,
      thread: data.noticeThread(post.id, cpage),
      commentTotal: data.countNoticeComments(post.id),
      cmtNotice: CMT_NOTICE[String(req.query.report || '')] || ''
    })
  );
});

/* ---------- 每日挑战 / 个人主页 / 棋谱回放 ---------- */

/* ---------- 联机天梯 / 棋谱列表 ---------- */

/** 天梯：四款服务端裁判棋的 Elo 榜（?game=<slug> 切换，缺省第一款） */
app.get('/ladder', (req, res) => {
  const asked = String(req.query.game || '');
  const game = LADDER_GAMES.indexOf(asked) >= 0 ? asked : (LADDER_GAMES[0] || '');
  const season = elo.seasonOf(Date.now());
  res.send(ui.ladderPage({
    origin: originOf(req),
    user: req.user,
    game: game,
    games: ladderTabs(),
    board: game ? play.ratingBoard(sqlite, game, season, 50) : null,
    season: season,
    notice: String(req.query.notice || '')
  }));
});

/** 棋谱列表：只列裁判棋的对局（?game=<slug> 过滤，?page= 翻页） */
app.get('/replays', (req, res) => {
  const PAGE = 20;
  const asked = String(req.query.game || '');
  const game = LADDER_GAMES.indexOf(asked) >= 0 ? asked : '';
  const asked2 = Math.max(1, Number(req.query.page) || 1);
  const list = play.replayList({ game: game, limit: PAGE, offset: (asked2 - 1) * PAGE });
  const total = Number(list.total || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  res.send(ui.replaysPage({
    origin: originOf(req),
    user: req.user,
    items: list.items || [],
    total: total,
    game: game,
    games: ladderTabs(),
    page: Math.min(asked2, pages),
    pages: pages
  }));
});

/**
 * 每日挑战：题目由日期哈希从已上架游戏里轮换（src/daily.js），两条线算同一个结果。
 * 「完成」不发客户端成绩——当天那款游戏收到一次播放上报就算打卡（见 POST /api/games/:slug/play）。
 */
app.get('/daily', (req, res) => {
  const day = dayKey();
  const slug = social.dailySlug(day);
  const stats = req.user ? social.dailyStats(req.user.id) : null;
  res.send(
    ui.dailyPage({
      origin: originOf(req),
      user: req.user,
      day,
      game: data.getGame(slug),
      // dailyStats 已经是「视图要什么给什么」的形状（含 calendar / perfect / makeupUsed），整份透传即可
      stats: stats || null,
      board: social.dailyBoard(day, 12),
      notice: String(req.query.notice || '')
    })
  );
});

/**
 * 补做：只开放最近两天（src/daily.js 的 makeupCheck），补做记在**目标日**那一行、落 makeup=1。
 * 题目 slug 由目标日重算（dailySlug(day)），所以客户端只能补「那天本来就该做的那道题」。
 */
app.post('/daily/makeup', loginPageGuard('/daily'), (req, res) => {
  const b = req.body || {};
  const day = String(b.day || '');
  const chk = makeupCheck(day);
  if (chk) return res.redirect(withQuery('/daily', 'notice=' + encodeURIComponent(chk)));
  const r = social.markDaily(req.user.id, social.dailySlug(day), Date.now(), { day });
  const key = r && r.error ? r.error : 'makeup';
  res.redirect(withQuery('/daily', 'notice=' + encodeURIComponent(key)));
});

/** 分享卡统一出口：SVG 必须带 charset，5 分钟公共缓存（内容随数据变，别让 CDN 存太久） */
function sendCard(res, svg) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(svg);
}

/** 每日挑战成绩卡：游客也能拿（没有打卡记录时卡片按 0 处理） */
app.get('/daily/card.svg', (req, res) => {
  const day = dayKey();
  sendCard(res, dailyCardSvg({
    day,
    game: data.getGame(social.dailySlug(day)),
    stats: req.user ? social.dailyStats(req.user.id) : null,
    origin: originOf(req)
  }));
});

/** 个人主页：昵称、等级、徽章与公开计数；邮箱之类只出现在 /account。 */
app.get('/u/:name', (req, res) => {
  const profile = social.profileByName(req.params.name);
  if (!profile) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  res.send(
    ui.profilePage({
      origin: originOf(req),
      user: req.user,
      profile,
      isSelf: !!(req.user && Number(req.user.id) === Number(profile.id)),
      counts: social.followCounts(profile.id),
      following: req.user ? social.isFollowing(req.user.id, profile.id) : false,
      ratings: ratingsOf(profile.id),
      notice: FOLLOW_TEXT[String(req.query.notice || '')] || ''
    })
  );
});

/** 个人主页成绩卡：昵称 / 等级 / 徽章，取不到昵称就是 404 */
app.get('/u/:name/card.svg', (req, res) => {
  const profile = social.profileByName(req.params.name);
  if (!profile) return res.status(404).type('text/plain').send('not found');
  sendCard(res, profileCardSvg({ profile, origin: originOf(req) }));
});

/** 棋谱回放：对局结束时已落库（play-store.saveReplay），这里只负责渲染播放器。 */
app.get('/replay/:id', (req, res) => {
  const id = Number(req.params.id);
  const replay = Number.isInteger(id) && id > 0 ? play.replay(id) : null;
  if (!replay) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  play.bumpReplayPlays(id);
  res.send(
    ui.replayPage({
      origin: originOf(req),
      user: req.user,
      replay,
      game: data.getGame(replay.game),
      more: play.replayList({ game: replay.game, limit: 10 }).items.filter((x) => Number(x.id) !== id).slice(0, 6)
    })
  );
});

/**
 * 棋谱分享卡：id 就是 play_replays.id（和 /replay/:id 同一份棋谱）。
 * 非法 id 给 400 而不是 404 —— 「地址写错了」和「棋谱没了」分得开。
 */
app.get('/play/:id/card.svg', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).type('text/plain').send('bad id');
  const replay = play.replay(id);
  if (!replay) return res.status(404).type('text/plain').send('not found');
  sendCard(res, replayCardSvg({ replay, game: data.getGame(replay.game), origin: originOf(req) }));
});

/* ---------- og:image 位图（PNG）：给只认位图的平台用，渲染不了就回退同一张 SVG ---------- */

app.get('/play/:id/og.png', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).type('text/plain').send('bad id');
  const replay = play.replay(id);
  if (!replay) return res.status(404).type('text/plain').send('not found');
  const svg = replayCardSvg({ replay, game: data.getGame(replay.game), origin: originOf(req) });
  return sendOgOrCard(res, 'replay', String(id), svg);
});

app.get('/u/:name/og.png', (req, res) => {
  const profile = social.profileByName(String(req.params.name));
  if (!profile) return res.status(404).type('text/plain').send('not found');
  const svg = profileCardSvg({ profile, origin: originOf(req) });
  return sendOgOrCard(res, 'profile', String(profile.username || req.params.name), svg);
});

app.get('/daily/og.png', (req, res) => {
  const day = dayKey();
  const svg = dailyCardSvg({
    day,
    game: data.getGame(social.dailySlug(day)),
    stats: req.user ? social.dailyStats(req.user.id) : null,
    origin: originOf(req)
  });
  return sendOgOrCard(res, 'daily', day, svg);
});

app.get('/changelog', (req, res) => {
  res.send(ui.changelogPage({ origin: originOf(req), user: req.user }));
});

/* 导航页：fishport.cn 下所有能打开的站点一页直达（清单在 src/sites.js） */
app.get('/nav', (req, res) => {
  res.send(ui.portalPage({ origin: originOf(req), user: req.user }));
});

/* ---------- 论坛附件（内容实体）：帖子里只存 /ugc/a/<id> 这个链接 ---------- */

app.get('/ugc/a/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9]{1,18}$/.test(id) || !attachStore || attachStore.error) {
    return res.status(404).type('text/plain; charset=utf-8').send('not found');
  }
  let row = null;
  try {
    row = await attachStore.get(id, { withBody: true });
  } catch (e) {
    console.warn('[attach] 读附件出错：' + (e && e.message ? e.message : e));
    row = null;
  }
  // 只有已经挂到帖子上的（active）才给内容：pending 是还没发成功的草稿，按自增 id 就能枚举，不能公开
  if (!row || row.error || row.status !== 'active' || !row.body) {
    return res.status(404).type('text/plain; charset=utf-8').send('not found');
  }
  const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(row.filename || ('a' + row.id)) + '"');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(buf);
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

// PWA：manifest 与 Service Worker。单一事实来源就是 public/ 下这两个文件，每次都从磁盘读，改完即生效
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json; charset=utf-8').setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(join(PUBLIC_DIR, 'manifest.webmanifest'));
});

app.get('/sw.js', (req, res) => {
  // no-cache：SW 脚本必须每次回源校验，否则「改了不生效」；Service-Worker-Allowed 让 SW 能控制整站
  res
    .type('application/javascript; charset=utf-8')
    .setHeader('Cache-Control', 'no-cache')
    .setHeader('Service-Worker-Allowed', '/');
  res.sendFile(join(PUBLIC_DIR, 'sw.js'));
});

// PWA 真离线：预缓存清单。由 tools/gen-precache.mjs 扫描仓库生成，sw.js 在 install 时拉取；
// 与 manifest/sw.js 一样以 public/ 下的文件为单一事实来源，改完即生效。
app.get('/precache.json', (req, res) => {
  res.type('application/json; charset=utf-8').setHeader('Cache-Control', 'public, max-age=600');
  res.sendFile(join(PUBLIC_DIR, 'precache.json'));
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
  'Disallow: /forum/admin',
      '',
      'Sitemap: ' + origin + '/sitemap.xml',
      ''
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = originOf(req);
  const urls = [{ loc: '/', pri: '1.0' }, { loc: '/rank', pri: '0.7' }, { loc: '/forum', pri: '0.5' },
    { loc: '/notice', pri: '0.6' }, { loc: '/changelog', pri: '0.4' }, { loc: '/nav', pri: '0.5' },
    { loc: '/privacy', pri: '0.3' }, { loc: '/terms', pri: '0.3' }];
  for (const p of data.listPosts({ status: 1, limit: 50 })) {
    urls.push({ loc: '/notice/' + encodeURIComponent(p.slug), pri: '0.6', lm: String(p.published_at || p.created_at).slice(0, 10) });
  }
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
app.get('/api/search/suggest', (req, res, next) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) return res.json({ q: '', items: [] });
  // 与 /search 同一条后端链（Meili 主 + SQL 兜底）；rawQuery 仍是这份 trim 过的 q，兜底腿与接线前一致
  runSearch(q, { limit: SUGGEST_LIMIT, offset: 0, rawQuery: q })
    .then((hit) => {
      const items = toFullGames(hit).map((g) => ({
        slug: g.slug,
        title: g.title,
        emoji: g.emoji,
        category: g.category ? g.category.name : '',
        plays: g.plays,
        rating: g.rating
      }));
      res.json({ q, items });
    })
    .catch(next);
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
  // 每日挑战打卡：今天轮到的正好是这款游戏时记一笔（只有登录用户有打卡，游客只计播放次数）
  let daily = null;
  if (req.user) {
    try { daily = social.markDaily(req.user.id, slug); } catch { daily = null; }
  }
  res.json({ counted: true, plays, daily: daily && daily.fresh ? daily.day : '' });
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

// ---------- 联机对战（房间 + 走法中继） ----------
//
// 服务端做三件事：轮流（谁的回合）、转发走法，以及对接入规则引擎的棋类（connect4 / reversi /
// draughts / gomoku）自己裁判走法与胜负（判在 src/play-store.js 的 sendMove 里）。
// 其余棋类（中国象棋 / 国际象棋 / 井字棋）照旧只中继，result 采信客户端声明。
// 客户端 1.2s 轮询 /api/play/poll 拉增量（since = 已应用的最大 seq），不用 Durable Objects。

/** store 的 { error } → HTTP 状态码；成功统一补 ok:true。绝不外泄 host_token/guest_token。 */
const PLAY_STATUS = {
  not_found: 404, bad_token: 403, full: 409, busy: 503,
  bad_code: 400, bad_game: 400, bad_move: 400, illegal_move: 400,
  not_your_turn: 409, not_playing: 409, done: 409, closed: 409, playing: 409, waiting: 409
};
function playReply(res, r, status = 200) {
  if (r && r.error) {
    const code = PLAY_STATUS[r.error] || 400;
    return res.status(code).json({ ok: false, error: r.error, hint: playHint(r.error) });
  }
  res.status(status).json(Object.assign({ ok: true }, r));
}
function playHint(code) {
  return {
    not_found: '房间不存在或已过期', bad_token: '座位凭证无效（清掉浏览器数据后请重新创建房间）',
    full: '房间已经满员', busy: '暂时没有可加入的房间，请稍后再试',
    bad_code: '房间码是 6 位字母数字', bad_game: '游戏标识不合法', bad_move: '走法数据不合法',
    illegal_move: '这步不合规则（服务端已裁判）',
    not_your_turn: '还没轮到你', not_playing: '对局还没开始', done: '对局已经结束',
    closed: '房间已经关闭', playing: '房间已在对局中', waiting: '还没等到对手'
  }[code] || '';
}

// 建房 / 快速匹配给点限速，防止刷房间；轮询与走法不拦（本来就高频）
app.post('/api/play/create', (req, res) => {
  if (!dedupe('play-new:' + req.ip, 1000)) return res.status(429).json({ ok: false, error: 'busy', hint: '别急，稍等一秒' });
  playReply(res, play.createRoom(req.body && req.body.game, req.body && req.body.name, Date.now()), 201);
});

app.post('/api/play/quick', (req, res) => {
  if (!dedupe('play-new:' + req.ip, 1000)) return res.status(429).json({ ok: false, error: 'busy', hint: '别急，稍等一秒' });
  const r = play.quickMatch(req.body && req.body.game, req.body && req.body.name, Date.now());
  playReply(res, r, r.created ? 201 : 200);
});

app.post('/api/play/join', (req, res) => {
  playReply(res, play.joinRoom(req.body && req.body.code, req.body && req.body.name, Date.now()));
});

app.post('/api/play/poll', (req, res) => {
  playReply(res, play.poll(Number(req.body && req.body.id), req.body && req.body.token, Number(req.body && req.body.since) || 0, Date.now()));
});

app.post('/api/play/move', (req, res) => {
  playReply(res, play.sendMove(Number(req.body && req.body.id), req.body && req.body.token, req.body && req.body.move, req.body && req.body.result, Date.now()));
});

app.post('/api/play/resign', (req, res) => {
  playReply(res, play.resign(Number(req.body && req.body.id), req.body && req.body.token, Date.now()));
});

app.post('/api/play/rematch', (req, res) => {
  playReply(res, play.rematch(Number(req.body && req.body.id), req.body && req.body.token, Date.now()));
});

app.post('/api/play/leave', (req, res) => {
  playReply(res, play.leave(Number(req.body && req.body.id), req.body && req.body.token, Date.now()));
});

// 观战：只认「房间 id + watch_token」，拿到的是公开视图（seat = -1），永远看不到玩家座位凭证
app.post('/api/play/watch', (req, res) => {
  const b = req.body || {};
  playReply(res, play.watchRoom(String(b.key || ''), Number(b.since) || 0, Date.now()));
});

/**
 * 棋谱：对局结束时由服务端落库（见 play-store 的 saveReplay），只读、公开。
 * 回放页与游戏页的 ?replay= 播放器都读这一份，客户端不能改写棋谱。
 */
app.get('/api/replays/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'bad_id' });
  const replay = play.replay(id);
  if (!replay) return res.status(404).json({ ok: false, error: 'not_found', hint: '棋谱不存在或已被清理' });
  play.bumpReplayPlays(id);
  res.json({ ok: true, replay });
});

// ---------- 账号 ----------

app.get('/login', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.send(ui.loginPage({ origin: originOf(req), next, providers: oauth.enabledProviders() }));
});

app.post('/login', (req, res) => {
  const b = req.body || {};
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const r = auth.login(username, b.password);
  if (r.error) {
    return res.status(401).send(ui.loginPage({
      origin: originOf(req), next, error: r.error, username, providers: oauth.enabledProviders()
    }));
  }
  auth.startSession(res, r.user.id);
  res.redirect(next);
});

app.get('/register', (req, res) => {
  const next = safeNext(req.query.next);
  if (req.user) return res.redirect(next);
  res.send(ui.registerPage({ origin: originOf(req), next, providers: oauth.enabledProviders() }));
});

app.post('/register', (req, res) => {
  const b = req.body || {};
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const displayName = String(b.display_name || '');
  const v = auth.validateRegister(username, b.password, displayName);
  const fail = (error, status) => res.status(status).send(ui.registerPage({
    origin: originOf(req), next, error, username, displayName, providers: oauth.enabledProviders()
  }));
  if (v.error) return fail(v.error, 400);
  // 注册页必须勾选同意《用户协议》与《隐私政策》（表单里是必填 checkbox，这里再兜一次）
  if (!b.agree) return fail('请先阅读并勾选同意《用户协议》与《隐私政策》', 400);
  if (auth.findUser(v.username)) return fail('这个用户名已经被注册了，换一个吧', 409);
  const user = auth.createUser(v.username, v.password, v.displayName);
  auth.startSession(res, user.id);
  res.redirect(next);
});

/* ---------- 法律页面（静态文本，登录与否都可看） ---------- */

app.get('/privacy', (req, res) => {
  res.send(ui.privacyPage({ origin: originOf(req), user: req.user }));
});

app.get('/terms', (req, res) => {
  res.send(ui.termsPage({ origin: originOf(req), user: req.user }));
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
      devLink: devLinkOf(originOf(req), 'verify', req.query.t),
      profile: social.profileOf(req.user.id)
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
// ---------- 通知中心 / 私信 / 关注（第七批：社交） ----------

const NOTICE_PAGE = 20;
const PEOPLE_PAGE = 24;
const FOLLOW_TEXT = { followed: '已关注', unfollowed: '已取消关注', self_follow: '不能关注自己', no_user: '没有这个用户' };

/** 页码：非法或负数一律回第 1 页 */
function pageOf(v) {
  return Math.max(1, Number(v) || 1);
}

app.get('/notifications', requireLogin, (req, res) => {
  const page = pageOf(req.query.page);
  const list = social.listNotifications(req.user.id, { limit: NOTICE_PAGE, offset: (page - 1) * NOTICE_PAGE });
  res.send(ui.notificationsPage({
    origin: originOf(req), user: req.user, list, page,
    notice: String(req.query.notice || '') === 'read' ? '全部标为已读' : ''
  }));
});

/** 标为已读：带 id 只标那条，不带（或不合法）就把全部未读标掉 */
app.post('/notifications/read', loginPageGuard('/notifications'), (req, res) => {
  const b = req.body || {};
  social.markRead(req.user.id, Number(b.id) || 0);
  res.redirect(withQuery(safeNext(b.next || '/notifications'), 'notice=read'));
});

app.get('/messages', requireLogin, (req, res) => {
  res.send(ui.messagesPage({
    origin: originOf(req), user: req.user,
    threads: social.listMessageThreads(req.user.id, { limit: 50 })
  }));
});

app.get('/messages/:name', requireLogin, (req, res) => {
  const peer = social.profileByName(String(req.params.name || ''));
  if (!peer || Number(peer.id) === Number(req.user.id)) {
    return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  }
  social.markThreadRead(req.user.id, peer.id);
  const err = String(req.query.error || '');
  res.send(ui.messagesPage({
    origin: originOf(req), user: req.user, peer,
    thread: social.threadMessages(req.user.id, peer.id, { limit: 30 }),
    notice: String(req.query.notice || '') === 'sent' ? '已发送' : '',
    error: err === 'too_long' ? '私信最多 ' + social.MESSAGE_MAX + ' 字' : (err === 'empty' ? '私信不能为空' : '')
  }));
});

app.post('/messages/:name', loginPageGuard('/messages'), (req, res) => {
  const name = String(req.params.name || '');
  const back = '/messages/' + encodeURIComponent(name);
  const peer = social.profileByName(name);
  if (!peer) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  const r = social.sendMessage(req.user.id, peer.id, (req.body || {}).body);
  res.redirect(r.error ? withQuery(back, 'error=' + encodeURIComponent(r.error)) : withQuery(back, 'notice=sent'));
});

/** 关注列表：粉丝 / 关注 / 好友（互关）三个 tab 共用一套渲染 */
function peopleHandler(kind) {
  return (req, res) => {
    const owner = social.profileByName(String(req.params.name || ''));
    if (!owner) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
    const page = pageOf(req.query.page);
    res.send(ui.peoplePage({
      origin: originOf(req), user: req.user, owner, kind, page,
      list: social.followList(owner.id, kind, { limit: PEOPLE_PAGE, offset: (page - 1) * PEOPLE_PAGE })
    }));
  };
}

app.get('/u/:name/followers', peopleHandler('followers'));
app.get('/u/:name/following', peopleHandler('following'));
app.get('/u/:name/friends', peopleHandler('friends'));

/** 关注 / 取关：同一个地址，按钮自带 action=follow|unfollow；没带就按当前状态取反 */
app.post('/u/:name/follow', loginPageGuard('/u'), (req, res) => {
  const name = String(req.params.name || '');
  const back = '/u/' + encodeURIComponent(name);
  const peer = social.profileByName(name);
  if (!peer) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  const action = String((req.body || {}).action || '');
  const want = action === 'unfollow' ? false : (action === 'follow' ? true : !social.isFollowing(req.user.id, peer.id));
  const r = want ? social.follow(req.user.id, peer.id) : social.unfollow(req.user.id, peer.id);
  const key = r.error ? r.error : (want ? 'followed' : 'unfollowed');
  // 只在「新关注」时发通知：social.notify 自己还会按 (user,kind,actor,target) 去重
  if (!r.error && want) {
    social.notify(peer.id, { kind: 'follow', actorId: req.user.id, targetType: 'user', targetId: req.user.id });
  }
  res.redirect(withQuery(back, 'notice=' + encodeURIComponent(key)));
});

// ---------- 投稿 ----------

app.get('/submit', requireLogin, (req, res) => {
  res.send(ui.submitPage({
    origin: originOf(req), user: req.user, categories: data.listCategories()
  }));
});

app.post('/submit', requireLogin, express.raw({ type: 'multipart/form-data', limit: '2mb' }), (req, res) => {
  // 带文件时浏览器发的是 multipart/form-data；项目零依赖，自己解析（不引 multer）
  const b = Buffer.isBuffer(req.body)
    ? formFromMultipart(req.body, req.headers['content-type'], 'game_file')
    : (req.body || {});
  const r = data.createSubmission(b, req.user.id);
  const ok = !r.error;
  res.status(ok ? 200 : 400).send(ui.submitPage({
    origin: originOf(req), user: req.user, categories: data.listCategories(),
    error: r.error || '', values: b, done: ok ? r.slug : ''
  }));
});

// ---------- 后台 ----------

/** 「集成自检」面板的数据：邮件通道与各第三方登录的配置状态（只看配没配，不回显密钥） */
function integrationsOf(origin) {
  const keys = oauth.PROVIDERS.concat(oauth.devEnabled() ? ['dev'] : []);
  return {
    mail: {
      transport: mail.transportName(),
      endpoint: process.env.MAIL_API_URL || '',
      from: mail.MAIL_FROM(),
      keySet: !!(process.env.RESEND_API_KEY || process.env.MAIL_API_KEY)
    },
    oauth: keys.map((k) => {
      const m = oauth.providerMeta(k);
      const c = oauth.providerCreds(k);
      return {
        key: k,
        label: m.label,
        icon: m.icon,
        env: (m.env || []).join(' / '),
        enabled: oauth.providerEnabled(k),
        idSet: !!(c && c.id),
        secretSet: !!(c && c.secret),
        callback: m.mock ? '' : oauth.redirectUri(origin, k)
      };
    })
  };
}

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
    posts: data.listPosts({ limit: 100 }),
    notice: String(req.query.ok || ''),
    integrations: integrationsOf(originOf(req))
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

/** 彻底删除确认页：连带数据量先摆出来，上架中的游戏不让删 */
app.get('/admin/games/:slug/delete', requireAdmin, (req, res) => {
  const game = data.getGameAny(req.params.slug);
  if (!game) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  res.send(ui.deleteGamePage({
    origin: originOf(req),
    user: req.user,
    game,
    counts: data.gamePurgeInfo(game.slug) || {}
  }));
});

app.post('/admin/games/:slug/delete', requireAdmin, (req, res) => {
  const slug = String(req.params.slug);
  const r = data.deleteGame(slug);
  if (r.error === 'online') return res.status(400).type('text/plain').send('这个游戏还在上架中，请先下架再彻底删除');
  if (r.error) return res.status(404).type('text/plain').send('没有这个游戏');
  const i = r.info;
  data.logAudit(req.user, 'game.delete', slug,
    i.title + '（评论 ' + i.comments + ' / 举报 ' + i.reports + ' / 评分 ' + i.ratings +
    ' / 收藏 ' + i.favorites + ' / 游玩 ' + i.plays + ' / 上传文件 ' + i.file + '）');
  res.redirect('/admin?ok=purge');
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

// ---------- 公告管理（发布 / 编辑 / 撤回） ----------
app.get('/admin/posts/new', requireAdmin, (req, res) => {
  res.send(ui.postFormPage({ origin: originOf(req), user: req.user, error: String(req.query.error || '') }));
});

app.post('/admin/posts/new', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = data.createPost({ title: b.title, body: b.body, pinned: b.pinned, status: b.draft ? 0 : 1 }, req.user.id);
  if (r.error) return res.redirect('/admin/posts/new?error=' + encodeURIComponent(r.error));
  data.logAudit(req.user, 'post.create', r.slug, r.title + (r.status ? '' : '（先存着，未发布）'));
  res.redirect('/admin?ok=post');
});

app.get('/admin/posts/:slug/edit', requireAdmin, (req, res) => {
  const post = data.getPostAny(String(req.params.slug));
  if (!post) return res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
  res.send(ui.postFormPage({ origin: originOf(req), user: req.user, post, error: String(req.query.error || '') }));
});

app.post('/admin/posts/:slug/edit', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = data.updatePost(String(req.params.slug), { title: b.title, body: b.body, pinned: b.pinned });
  if (r.error === 'not_found') return res.status(404).type('text/plain').send('没有这条公告');
  if (r.error) return res.redirect('/admin/posts/' + encodeURIComponent(req.params.slug) + '/edit?error=' + encodeURIComponent(r.error));
  data.logAudit(req.user, 'post.update', r.slug, r.title);
  res.redirect('/admin?ok=post');
});

app.post('/admin/posts/:slug/status', requireAdmin, (req, res) => {
  const r = data.setPostStatus(String(req.params.slug), (req.body || {}).status);
  if (r.error) return res.status(404).type('text/plain').send('没有这条公告');
  data.logAudit(req.user, r.status ? 'post.publish' : 'post.retract', String(req.params.slug), r.status ? '发布' : '撤回（前台隐藏，评论保留）');
  res.redirect('/admin?ok=postStatus');
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
  banCache.invalidate(Number(req.params.id) || 0); // 封禁 / 解封立刻作废快速缓存，别让讨论区还认旧状态
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

/** 导航上的小红点：通知未读数（app.js 每页拉一次） */
app.get('/api/notifications/unread', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login_required', unread: 0 });
  res.json({ ok: true, unread: social.unreadCount(req.user.id) });
});

/** 导航上的小红点：私信未读数（按会话汇总，条数不大） */
app.get('/api/messages/unread', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login_required', unread: 0 });
  const t = social.listMessageThreads(req.user.id, { limit: 100 });
  res.json({ ok: true, unread: (t.items || []).reduce(function (n, x) { return n + Number(x.unread || 0); }, 0) });
});

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

/**
 * 通知钩子统一入口：只在写库成功之后调用，内部任何异常都只记一行日志。
 * 通知是附加价值，发帖 / 评论本身不能因为它失败而失败。
 */
function notifySafe(fn) {
  try { return fn(); } catch (e) {
    console.warn('[notify] ' + (e && e.message ? e.message : e));
    return null;
  }
}

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
  // 通知作品作者（submitted_by，游戏没记作者就是 0，social 内部会跳过）与正文里 @ 到的人
  notifySafe(() => {
    const game = data.getGame(slug);
    if (!game) return;
    social.notifyComment({
      actorId: req.user.id, gameSlug: slug,
      ownerId: game.submitted_by, commentId: r.id, body: r.body
    });
  });
  res.json({ id: r.id, body: r.body, name: req.user.name, parent_id: r.parent_id });
});

/** 公告评论：和游戏评论同一套（分页 + 楼中楼 + 10 秒限流） */
app.get('/api/notices/:slug/comments', (req, res) => {
  const post = data.getPost(String(req.params.slug));
  if (!post) return res.status(404).json({ error: 'not_found' });
  const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || data.COMMENT_PAGE_SIZE));
  const thread = data.noticeThread(post.id, Math.max(1, Number(req.query.page) || 1), pageSize);
  res.json({ slug: post.slug, total: thread.total, page: thread.page, pages: thread.pages, pageSize: thread.pageSize, items: thread.items });
});

app.post('/api/notices/:slug/comments', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'login_required', hint: '登录后才能评论' });
  const post = data.getPost(String(req.params.slug));
  if (!post) return res.status(404).json({ error: 'not_found' });
  const key = 'post:' + req.user.id + ':' + post.id;
  const now = Date.now();
  if (now - (commentGate.get(key) || 0) < 10000) {
    return res.status(429).json({ error: 'too_fast', hint: '发得太快了，歇 10 秒再发' });
  }
  const r = data.addNoticeComment(post.id, req.user.id, req.body && req.body.body, (req.body && req.body.parent_id) || null);
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


/* ==================== 论坛 ==================== */
/* 只需要一套 /forum/* 路由：forum.fishport.cn 的请求已被上面的中间件重写成 /forum/*。
   模板里的链接基址用 req.forumBase（'' 或 '/forum'），论坛后台固定在 /forum/admin。 */

const FORUM_MSG = {
  published: '发布成功，已经出现在论坛里了',
  pending: '提交成功，站长审核通过后就会公开',
  replied: '回复成功，已经贴到楼下了',
  edited: '保存成功，普通账号的编辑会重新进入待审队列',
  reported: '举报已收到，站长会尽快处理',
  done: '操作已完成'
};

const FORUM_ERR = {
  too_fast: '发得太快了，歇一会儿再发',
  daily: '今天发得够多了，明天再来吧',
  hourly: '举报交得有点多，过一会儿再试',
  muted: '你正在被禁言，暂时不能发言',
  banned: '账号已被封禁，不能发帖',
  email: '要先在「账号」页验证邮箱才能发帖',
  blocked: '内容里包含被禁止的表述，发不出去',
  stale: '表单已过期，请重新打开页面再提交',
  bot: '这次提交没有通过校验，请重新打开页面再试',
  locked: '这个主题已经被锁定，不能再回复',
  empty: '内容不能是空的',
  no_forum: '没有这个板块',
  not_found: '要操作的内容不存在了',
  forbidden: '只能改自己的内容',
  bad_regex: '正则写错了，检查一下括号和转义',
  default: '这次操作没成功，稍后再试'
};

function forumOkOf(req) {
  return FORUM_MSG[String((req.query && req.query.ok) || '')] || '';
}

function forumErrOf(req) {
  return FORUM_ERR[String((req.query && req.query.err) || '')] || '';
}

/** 错误码归一：只回显自己认识的码，避免把任意文本反照到页面上 */
function forumCode(e) {
  const k = String(e || '');
  return FORUM_ERR[k] ? k : 'default';
}

/** 论坛类表单的统一回跳：成功带 ok=，失败带 err=（只带码，页面上再翻成人话） */
function forumTo(res, path, ok, err) {
  if (ok) return res.redirect(withQuery(path, 'ok=' + encodeURIComponent(ok)));
  if (err) return res.redirect(withQuery(path, 'err=' + encodeURIComponent(forumCode(err))));
  res.redirect(path);
}

function forumToken(req, kind) {
  return { token: forum.issueNonce(req.user.id, kind), honeypot: fguard.HONEYPOT_FIELD };
}

/**
 * 发帖类 POST 的前置检查：蜜罐字段 + 一次性表单令牌（脚本重放与 CSRF 都在这挡）。
 * 必须传 formOf(req) 解析出来的字段对象，不能直接读 req.body：带附件的提交走
 * express.raw，req.body 是原始 Buffer，读出来 form_token 永远是空 → 一律 err=stale
 * （2026-10-20 用真 multipart 复现：浏览器里带 enctype 的表单一条也发不出去）。
 */
function forumPrefilter(req, b, kind) {
  const f = b || {};
  if (String(f[fguard.HONEYPOT_FIELD] || '').trim()) return { err: 'bot' };
  const n = forum.consumeNonce(String(f.form_token || ''), req.user.id, kind);
  if (!n.ok) return { err: 'stale' };
  return { fastSubmit: Number(n.dwellMs) < fguard.MIN_DWELL_MS };
}

function forumNotFound(req, res) {
  res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
}

function forumViewer(req) {
  return req.user ? req.user.id : null;
}

app.get(['/forum', '/forum/'], (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = String(req.query.q || '').slice(0, 60);
  const tag = String(req.query.tag || '').slice(0, 24);
  const list = forum.listThreads({ q, tag, page, viewerId: forumViewer(req) });
  res.send(ui.forumHomePage({
    origin: originOf(req), user: req.user, forums: forum.listForums(),
    threads: list.items, total: list.total, page: list.page, pages: list.pages, q, tag,
    base: req.forumBase, stats: forum.forumStats(), notice: forumOkOf(req)
  }));
});

app.get('/forum/new', (req, res) => {
  res.send(ui.forumNewPage({
    origin: originOf(req), user: req.user, forums: forum.listForums(),
    forumSlug: String(req.query.forum || ''), base: req.forumBase,
    gate: req.user ? forum.forumGate(req.user) : null,
    form: req.user ? forumToken(req, 'thread') : null,
    error: forumErrOf(req)
  }));
});

app.post('/forum/new', loginPageGuard('/forum/new'), express.raw({ type: 'multipart/form-data', limit: '6mb' }), async (req, res) => {
  const b = formOf(req);
  const back = req.forumBase + '/new';
  const rerender = (msg) => res.status(400).send(ui.forumNewPage({
    origin: originOf(req), user: req.user, forums: forum.listForums(),
    forumSlug: String(b.forum || ''), error: msg, values: { title: b.title, body: b.body },
    base: req.forumBase, gate: forum.forumGate(req.user), form: forumToken(req, 'thread')
  }));
  const pre = forumPrefilter(req, b, 'thread');
  if (pre.err) return forumTo(res, back, null, pre.err);
  const tv = fguard.validateTitle(b.title);
  if (!tv.ok) return rerender(tv.error);
  const bv = fguard.validateBody(b.body);
  if (!bv.ok) return rerender(bv.error);
  const f = forum.getForum(String(b.forum || ''));
  if (!f) return forumTo(res, back, null, 'no_forum');
  // 频控只由数据层的 checkRate 负责：它排在 forumGate（禁言）与黑名单之后，且站长豁免；
  // 在路由里再挡一层会把「已禁言」这种更具体的原因盖成 too_fast（2026-10-20 验收实测）
  const r = forum.createThread({ forumId: f.id, user: req.user, title: tv.value, body: bv.value, fastSubmit: pre.fastSubmit });
  if (r.error) return forumTo(res, back, null, r.error);
  data.logAudit(req.user, 'forum.thread.create', String(r.id),
    (Number(r.status) === 1 ? '直接发布' : '转待审' + (r.reason ? '（' + r.reason + '）' : '')) + '：' + String(tv.value).slice(0, 40));
  // 新帖：作者就是楼主，reply 通知会被 self 规则吃掉，这一步实际是把正文里 @ 到的人喊上
  // 待审内容一律不通知，免得没过审的正文借通知漏给收件人
  if (Number(r.status) === 1) notifySafe(() => social.notifyReply({
    actorId: req.user.id, threadId: r.id, threadTitle: tv.value,
    ownerId: req.user.id, postId: 0, body: bv.value
  }));
  if (String(b.tags || '').trim()) forum.setThreadTags(r.id, b.tags, req.user.role); // 标签只认 admin / mod 之外的人吗？不：作者可以给自己的帖子打标签，数据层只清洗内容
  await saveUploads(req, { ownerId: req.user.id, threadId: r.id });
  forumTo(res, req.forumBase + '/t/' + r.id, Number(r.status) === 1 ? 'published' : 'pending');
});

app.get('/forum/f/:slug', (req, res) => {
  const f = forum.getForum(String(req.params.slug));
  if (!f) return forumNotFound(req, res);
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = String(req.query.q || '').slice(0, 60);
  const tag = String(req.query.tag || '').slice(0, 24);
  const list = forum.listThreads({ forum: f.slug, q, tag, page, viewerId: forumViewer(req) });
  res.send(ui.forumBoardPage({
    origin: originOf(req), user: req.user, forum: f,
    threads: list.items, total: list.total, page: list.page, pages: list.pages, q, tag, base: req.forumBase
  }));
});

app.get('/forum/t/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const t = forum.getThread(id, req.user);
  if (!t || !t.canView) return forumNotFound(req, res);
  const page = Math.max(1, Number(req.query.page) || 1);
  const list = forum.listPosts(id, { page, viewer: req.user });
  forum.bumpThreadView(id);
  const rid = Number(req.query.reply) || 0;
  const rp = rid ? forum.getPost(rid, req.user) : null;
  const replyTo = rp && Number(rp.thread_id) === id ? { id: rp.id, floor: 0, name: rp.name || rp.username } : null;
  const att = await withAttachments(id, list.items);
  res.send(ui.forumThreadPage({
    origin: originOf(req), user: req.user, thread: Object.assign({}, t.thread, { attachments: att.thread }),
    forum: { slug: t.thread.forum_slug, name: t.thread.forum_name, icon: t.thread.forum_icon },
    posts: att.posts, total: list.total, page: list.page, pages: list.pages,
    base: req.forumBase, replyTo,
    gate: req.user ? forum.forumGate(req.user) : null,
    form: req.user ? forumToken(req, 'post') : null,
    notice: forumOkOf(req), error: forumErrOf(req)
  }));
});

app.post('/forum/t/:id/reply', loginPageGuard('/forum'), express.raw({ type: 'multipart/form-data', limit: '6mb' }), async (req, res) => {
  const id = Number(req.params.id) || 0;
  const back = req.forumBase + '/t/' + id;
  const form = formOf(req);
  const pre = forumPrefilter(req, form, 'post');
  if (pre.err) return forumTo(res, back, null, pre.err);
  const bv = fguard.validateBody(form.body);
  if (!bv.ok) return forumTo(res, back, null, 'empty');
  const parentId = Number(form.parent_id) || null;
  // 同上：频控交给数据层 checkRate（禁言 / 锁定 / 黑名单的判定顺序都在它前面）
  const r = forum.createReply({ threadId: id, user: req.user, body: bv.value, parentId, fastSubmit: pre.fastSubmit });
  if (r.error) return forumTo(res, back, null, r.error);
  data.logAudit(req.user, 'forum.post.create', String(r.id), '回复主题 #' + id + (Number(r.status) === 1 ? '' : '（转待审）'));
  // 楼中楼也算「回复」：targetId 仍是 主题#这一楼，@ 展开与 10 分钟去重都在 social 内部
  if (Number(r.status) === 1) notifySafe(() => {
    const t = forum.getThread(id, req.user);
    if (!t || !t.thread) return;
    social.notifyReply({
      actorId: req.user.id, threadId: id, threadTitle: t.thread.title,
      ownerId: t.thread.user_id, postId: r.id, body: bv.value
    });
  });
  await saveUploads(req, { ownerId: req.user.id, threadId: id, postId: r.id });
  forumTo(res, back + '#p' + r.id, Number(r.status) === 1 ? 'replied' : 'pending');
});

app.get('/forum/post/:id/edit', (req, res) => {
  const post = forum.getPost(Number(req.params.id) || 0, req.user);
  if (!post) return forumNotFound(req, res);
  if (Number(post.user_id) !== Number(req.user.id) && req.user.role !== 'admin') return forumNotFound(req, res);
  res.send(ui.forumEditPage({
    origin: originOf(req), user: req.user, post,
    thread: { id: post.thread_id, title: '主题 #' + post.thread_id },
    base: req.forumBase, form: forumToken(req, 'post'), error: forumErrOf(req)
  }));
});

app.post('/forum/post/:id/edit', loginPageGuard('/forum'), express.raw({ type: 'multipart/form-data', limit: '6mb' }), async (req, res) => {
  const id = Number(req.params.id) || 0;
  const post = forum.getPost(id, req.user);
  if (!post) return forumNotFound(req, res);
  const back = req.forumBase + '/t/' + post.thread_id;
  const form = formOf(req);
  const bv = fguard.validateBody(form.body);
  const pre = forumPrefilter(req, form, 'post');
  if (pre.err) return forumTo(res, back, null, pre.err);
  if (!bv.ok) return forumTo(res, req.forumBase + '/post/' + id + '/edit', null, 'empty');
  const r = forum.editPost({ postId: id, user: req.user, body: bv.value, fastSubmit: pre.fastSubmit });
  if (r.error) return forumTo(res, back, null, r.error);
  data.logAudit(req.user, 'forum.post.edit', String(id), '主题 #' + post.thread_id + '：' + String(bv.value).slice(0, 40));
  await saveUploads(req, { ownerId: req.user.id, threadId: post.thread_id, postId: id }); // 编辑时补的附件也收下（编辑不做频控）
  forumTo(res, back + '#p' + id, r.unchanged ? 'done' : (Number(r.status) === 1 ? 'edited' : 'pending'));
});

app.post('/forum/report', loginPageGuard('/forum'), (req, res) => {
  const b = req.body || {};
  const tp = String(b.target_type || '');
  const tid = Number(b.target_id) || 0;
  const r = forum.reportTarget({ targetType: tp, targetId: tid, user: req.user, reason: String(b.reason || ''), detail: String(b.detail || '') });
  const back = r.threadId ? req.forumBase + '/t/' + r.threadId : req.forumBase + '/';
  if (r.error) return forumTo(res, back, null, r.error);
  data.logAudit(req.user, 'forum.report', tp + ':' + tid, '理由 ' + String(b.reason || '') + (r.already ? '（重复举报）' : ''));
  forumTo(res, back, 'reported');
});

/* ---------- 论坛后台 ---------- */

app.get('/forum/admin', requireAdmin, (req, res) => {
  res.send(ui.forumAdminPage({
    origin: originOf(req), user: req.user, stats: forum.forumStats(),
    pendingThreads: forum.listPendingThreads(50), pendingPosts: forum.listPendingPosts(50),
    reports: forum.listReports(0, 50), blacklist: forum.listBlacklist(), muted: forum.listMuted(20),
    notice: forumOkOf(req)
  }));
});

app.post('/forum/admin/threads/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  const r = forum.setThreadStatus(id, (req.body || {}).status);
  data.logAudit(req.user, 'forum.thread.status', String(id), Number(r.status) === 1 ? '通过' : Number(r.status) === 2 ? '下架' : '转待审');
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/threads/:id/flags', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  const b = req.body || {};
  const flags = {};
  if (b.pinned !== undefined) flags.pinned = Number(b.pinned) ? 1 : 0;
  if (b.locked !== undefined) flags.locked = Number(b.locked) ? 1 : 0;
  if (b.featured !== undefined) flags.featured = Number(b.featured) ? 1 : 0; // 精华只认 admin / mod（角色由数据层二次校验）
  const fr = forum.setThreadFlags(id, flags, req.user.role);
  if (fr && fr.error) return forumTo(res, '/forum/admin', null, fr.error);
  data.logAudit(req.user, 'forum.thread.flags', String(id),
    (flags.pinned !== undefined ? (flags.pinned ? '置顶' : '取消置顶') : '') +
    (flags.locked !== undefined ? (flags.locked ? ' 锁定' : ' 解锁') : '') +
    (flags.featured !== undefined ? (flags.featured ? ' 精华' : ' 取消精华') : ''));
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/posts/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  const r = forum.setPostStatus(id, (req.body || {}).status);
  data.logAudit(req.user, 'forum.post.status', String(id), Number(r.status) === 2 ? '隐藏' : '通过');
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/reports/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  const r = forum.setReportStatus(id, (req.body || {}).status);
  data.logAudit(req.user, 'forum.report.status', String(id), Number(r.status) === 2 ? '忽略' : '已处理');
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/blacklist', requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = forum.addBlacklist({ pattern: b.pattern, kind: b.kind, action: b.action, note: b.note });
  if (r.error) return forumTo(res, '/forum/admin', null, r.error);
  data.logAudit(req.user, 'forum.blacklist.add', String(r.id || ''), String(b.kind || 'word') + ' / ' + String(b.pattern || '').slice(0, 60));
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/blacklist/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  forum.deleteBlacklist(id);
  data.logAudit(req.user, 'forum.blacklist.del', String(id), '');
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/users/mute', requireAdmin, (req, res) => {
  const b = req.body || {};
  const uname = String(b.username || '').trim().toLowerCase();
  const found = (data.listUsers({ q: uname, limit: 20 }) || []).find((u) => String(u.username).toLowerCase() === uname);
  if (!found) return forumTo(res, '/forum/admin', null, 'not_found');
  const r = forum.setUserMuted(found.id, Number(b.minutes) || 0, String(b.reason || ''));
  data.logAudit(req.user, r.muted ? 'forum.user.mute' : 'forum.user.unmute', String(found.id),
    (found.display_name || found.username) + (r.muted ? ' 禁言 ' + r.minutes + ' 分钟：' + String(b.reason || '') : ' 解除禁言'));
  forumTo(res, '/forum/admin', 'done');
});

app.post('/forum/admin/users/:id/mute', requireAdmin, (req, res) => {
  const id = Number(req.params.id) || 0;
  const b = req.body || {};
  const r = forum.setUserMuted(id, Number(b.minutes) || 0, String(b.reason || ''));
  data.logAudit(req.user, r.muted ? 'forum.user.mute' : 'forum.user.unmute', String(id), r.muted ? '禁言 ' + r.minutes + ' 分钟' : '解除禁言');
  forumTo(res, '/forum/admin', 'done');
});

// ---------- 错误处理 ----------
app.use((req, res) => {
  res.status(404).send(ui.notFoundPage({ origin: originOf(req), user: req.user }));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(500).type('text/plain').send('500 Internal Server Error');
});

/* ================= 邮件补发循环 ================= */

/**
 * 每分钟捞一次到期的信（mail_outbox 里 status='queued' AND next_attempt_at<=now），
 * 用 mail.deliverNow() 直投——不能再走 sendMail，那会再入队一条新记录、历史那条永远收不了尾。
 * 成功 markSent、失败 markFailed（内部按 base*2^(n-1) 退避，封顶 6h，次数到上限落 failed）。
 * 只在配了 RESEND_API_KEY / MAIL_API_URL 时才有活干：没配时 sendMail 早已把记录标成 sent。
 */
const MAIL_TICK_MS = Number(process.env.MAIL_TICK_MS || 60000);
let mailTicking = false;

async function retryDueMail(now = Date.now(), limit = 20) {
  if (mailTicking) return { done: 0, failed: 0, skipped: 'busy' };
  mailTicking = true;
  let done = 0, failed = 0;
  try {
    for (const row of outbox.dueList(now, limit)) {
      const r = await mail.deliverNow({ to: row.to_addr, subject: row.subject, text: row.body_text });
      if (r.ok) { outbox.markSent(row.id); done++; }
      else if (r.error === 'not_configured') break;      // 没配传输就别空转，留着下次
      else { outbox.markFailed(row.id, r.error); failed++; }
    }
  } catch (err) {
    console.error('[mail:tick-error]', err && err.message);
  } finally {
    mailTicking = false;
  }
  if (done || failed) console.log('[mail:tick] 补发 ' + done + ' 封失败 ' + failed + ' 封');
  return { done, failed };
}

/* MAIL_TICK=0 可以关掉（测试里用）；unref 让定时器不阻止进程退出 */
if (process.env.MAIL_TICK !== '0') {
  const mailTimer = setInterval(() => { retryDueMail().catch(() => {}); }, MAIL_TICK_MS);
  if (mailTimer.unref) mailTimer.unref();
}

const server = app.listen(PORT, () => {
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

/* 导出给测试与排障用（tools/search-fallback-test.mjs 在进程内 import 本站，直接观察榜单缓存的单飞与 TTL）：
   server 是 listen 出来的句柄，测试收尾要 close 掉，别把端口留在那儿。 */
export { app, server, rankCache, getSearchBackend };
