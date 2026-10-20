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
import * as forum from './data-forum.js';
import * as fguard from '../src/forum-guard.js';
// 导航页的主机判定：fishport.cn / www.fishport.cn / nav.fishport.cn
import { PORTAL_HOSTS } from '../src/sites.js';
import * as play from './play-store.js';
import * as social from './social.js';
import { dayKey, makeupCheck } from '../src/daily.js';
import { replayCardSvg, profileCardSvg, dailyCardSvg } from '../src/cards.js';
import { makeSearchBackend, sqlBackend, meiliBackend } from '../src/search.js';
import { createCache, redisLikeAdapter } from '../src/rank-cache.js';
import * as outbox from './outbox.js';
import * as attach from './attachments.js';
import * as rules from '../src/rules/index.js';
import { seasonOf } from '../src/elo.js';
import * as push from './push.js';

/**
 * 页面响应的安全头。frame-src 额外放行 http(s)：投稿允许填任意外站地址，本站玩法就是把
 * 那个地址 iframe 进来，只写 'self' 会拦成「该内容被屏蔽了」（不同子域也不算 'self'）。
 * script-src / connect-src 另外放行 Cloudflare 的 RUM beacon（边缘自动注入 beacon.min.js）。
 */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy': [
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
};

/**
 * 投稿上传的单文件 HTML 用这组响应头：CSP 的 sandbox 指令把文档降级成不透明源，
 * 所以即便上传的脚本被直接打开，也拿不到本站的登录态、cookie 和存储。
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

const HTML_CACHE = 'public, max-age=0, must-revalidate';

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100" rx="22" fill="#6366f1"/>' +
  '<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-size="62">🎮</text>' +
  '</svg>';

/* ================= 搜索后端（可选 Meilisearch）与榜单缓存 ================= */

/**
 * 搜索接线：配了 MEILI_HOST 就用 Meilisearch 当主后端（src/search.js 的 meiliBackend），
 * 主后端失败 / 超时 / 熔断后自动落到 D1 的 SQL 搜索（sqlBackend 包住原来的 data.listGames），
 * 请求照常 200 并按兜底结果渲染；没配（未设或空串）时完全走原来的 SQL 路径，页面输出一字不差。
 *
 * 配置只从 env 进：Workers 里没有 process.env，读它直接 ReferenceError（本地 dev 由 serve-worker.mjs 塞 env）。
 *   MEILI_HOST         http://127.0.0.1:7700 这样；空 / 未设 = 不启用
 *   MEILI_API_KEY      可空
 *   MEILI_INDEX        默认 games
 *   SEARCH_TIMEOUT_MS  主后端单次上限，默认 1500
 *
 * 降级语义由 makeSearchBackend 保证：search() 永不抛错，三条腿全挂也只是返回空结果。
 */
const MEILI_DEFAULT_INDEX = 'games';
const SEARCH_TIMEOUT_DEFAULT_MS = 1500;
const SEARCH_BACKEND_CACHE_MAX = 8;

/** 解析搜索配置（纯函数，便于单测直接调） */
function searchConfig(env) {
  const e = env || {};
  const host = String(e.MEILI_HOST || '').trim().replace(/\/+$/, '');
  const raw = Number(String(e.SEARCH_TIMEOUT_MS || '').trim());
  return {
    host: host,
    apiKey: String(e.MEILI_API_KEY || ''),
    index: String(e.MEILI_INDEX || '').trim() || MEILI_DEFAULT_INDEX,
    timeoutMs: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SEARCH_TIMEOUT_DEFAULT_MS
  };
}

/**
 * 同一份配置复用同一个适配器实例：熔断状态与命中统计要跨请求才有意义。
 * （Workers 实例被回收 / 重启后清零；熔断只防「后端挂了还每请求都打一遍」，不承担持久状态。）
 */
const searchBackends = new Map();

/** 配好的搜索适配器；没配 MEILI_HOST 返回 null —— 调用方直接走原来的 SQL，行为一点不变 */
function searchBackendFor(env) {
  const cfg = searchConfig(env);
  if (!cfg.host) return null;
  const key = cfg.host + '\u0000' + cfg.index + '\u0000' + cfg.apiKey + '\u0000' + cfg.timeoutMs;
  const hit = searchBackends.get(key);
  if (hit) return hit;
  const backend = makeSearchBackend({
    // Workers 全局 fetch；meiliBackend 自己还有一层 AbortController 超时
    primary: meiliBackend({ url: cfg.host, apiKey: cfg.apiKey, index: cfg.index, fetchImpl: fetch, timeoutMs: cfg.timeoutMs }),
    // 兜底永远是本站 SQL。db 是每请求的（env 每请求现拼），所以从 opts.db 取，不能闭包在这里。
    fallback: sqlBackend(function (q, opts) { return sqlSearchLeg(opts && opts.db, q, opts); }),
    timeoutMs: cfg.timeoutMs
  });
  if (searchBackends.size >= SEARCH_BACKEND_CACHE_MAX) {
    const oldest = searchBackends.keys().next().value;
    if (oldest !== undefined) searchBackends.delete(oldest);
  }
  searchBackends.set(key, backend);
  return backend;
}

/**
 * 兜底腿 = 没配 MEILI_HOST 时用的那两条 SQL —— 保证「降级后看到的就是原来那份结果」。
 * 注意两条腿拿到的查询串略有差别：搜索引擎那条腿走的是 src/search.js 归一化后的 text
 * （去首尾空白、折叠空白、截 64），未配置时是原始 q —— 只影响降级瞬间的匹配细节，不影响可见性。
 */
async function sqlSearchLeg(db, q, opts) {
  const o = Object.assign({}, opts, { q: q });
  const items = await data.listGames(db, o);
  if (!o.wantTotal) return { items: items, total: items.length };
  return { items: items, total: await data.countGames(db, o) };
}

/**
 * 结果映射层：把搜索适配器给的 items 统一成「游戏整行」，页面模板（gameGrid）只认后者。
 *   - SQL 腿本来就是整行 → 原样返回（limit 只是再兜一层，正常情况下 SQL 已经限过）；
 *   - Meili 腿只给 { slug, title, score }（见 src/search.js 的 normalizeHit）→ 按 slug 回 D1 取整行，
 *     保持相关度顺序；下架的（status !== 1）和查不到的（已删）丢掉，与 SQL 搜索的可见性语义一致。
 * 也就是说 Meili 只负责「找到哪些」，渲染用的每个字段都来自 D1，播放数/评分不会因为走搜索引擎而变旧。
 */
async function searchRowsToGames(db, res, limit) {
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  if (res.backend !== 'meili') return cap ? res.items.slice(0, cap) : res.items;
  const seen = new Set();
  const slugs = [];
  for (const it of res.items) {
    const slug = it && it.slug ? String(it.slug) : '';
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
    if (cap && slugs.length >= cap) break;
  }
  const rows = await Promise.all(slugs.map(function (s) { return data.getGame(db, s); }));
  return rows.filter(function (g) { return g && Number(g.status) === 1; });
}

/** 降级留痕：主后端没答上来（失败 / 超时 / 熔断）时打一行；页面照常渲染兜底结果，不改 HTML */
function noteSearchFallback(backend, q, res) {
  if (!res || res.source === 'primary') return;
  const st = backend && typeof backend.stats === 'function' ? backend.stats() : {};
  console.log('[search] fallback source=' + res.source + ' backend=' + res.backend +
    ' leg=' + (st.lastErrorLeg || '-') + ' err=' + (st.lastError || '-') +
    ' q=' + JSON.stringify(String(q || '').slice(0, 64)));
}

/**
 * 取搜索结果列表（/api/search/suggest 用）。
 * 没配 MEILI_HOST 时就是原来那一句 data.listGames(ctx.db, opts)（参数一模一样）。
 */
async function searchGameList(ctx, q, opts) {
  const backend = searchBackendFor(ctx.env);
  if (!backend) return data.listGames(ctx.db, opts);
  const res = await backend.search(q, Object.assign({}, opts, { q: q, db: ctx.db, wantTotal: false }));
  noteSearchFallback(backend, q, res);
  return searchRowsToGames(ctx.db, res, opts && opts.limit);
}

/**
 * 取搜索结果列表 + 总数（/search 页面用）。
 * 没配 MEILI_HOST 或空查询时就是原来那两句：先 listGames 再 countGames，参数与顺序都不变。
 * （空查询没有「相关度」可言，也没必要把整库丢给搜索引擎，直接走 SQL。）
 */
async function searchGamePage(ctx, q, opts) {
  const backend = searchBackendFor(ctx.env);
  if (!backend || !String(q || '').trim()) {
    return { list: await data.listGames(ctx.db, opts), total: await data.countGames(ctx.db, opts) };
  }
  const res = await backend.search(q, Object.assign({}, opts, { q: q, db: ctx.db, wantTotal: true }));
  noteSearchFallback(backend, q, res);
  const list = await searchRowsToGames(ctx.db, res, opts && opts.limit);
  // 空结果（三条腿全挂）时 total 用实际条数，免得页面写「共找到 N 款」却一条都列不出来
  return { list: list, total: res.source === 'empty' ? list.length : res.total };
}

/* ---------- 榜单缓存（进程内 TTL + 单飞；远程缓存在这儿只留接缝） ---------- */

/**
 * 榜单（/rank）的缓存：30s TTL、容量 200、同一个 key 并发只查一次库（见 src/rank-cache.js）。
 * Workers 实例随时会被回收 / 重启，进程内缓存只在实例存活期内有效 —— 这是可接受的：
 * 它挡的是「榜单页被连续刷」的那一下，不是要一份强一致的持久缓存（榜单本身按天聚合）。
 *
 * 远程缓存只留显式接缝（本仓零外部依赖，没有 redis 客户端，所以默认不接）：
 *   1) setRankStore(store) —— 传一个和 createCache 同形状的实例，redisLikeAdapter(client, {keyPrefix}) 就是；
 *   2) 导入本模块前挂 globalThis.__QW_REDIS__ = client（要有 get / set / del / 扫描键的能力），
 *      这里会自动包一层；远端一出错就永久退化成内存（见 redisLikeAdapter 注释）。
 * 真接 Redis 必须引入客户端依赖（ioredis / node-redis），与「零外部依赖」政策冲突，故留而不接。
 */
const RANK_CACHE_OPTS = { ttlMs: 30000, maxEntries: 200 };
const RANK_CACHE_PREFIX = 'rank:';

function makeRankStore() {
  const injected = typeof globalThis !== 'undefined' ? globalThis.__QW_REDIS__ : null;
  if (injected) {
    try {
      return redisLikeAdapter(injected, Object.assign({ keyPrefix: 'qw:rank:' }, RANK_CACHE_OPTS));
    } catch (e) {
      console.error('[rank] redis adapter failed, fall back to memory: ' + (e && e.message ? e.message : e));
    }
  }
  return createCache(RANK_CACHE_OPTS);
}

let rankStore = makeRankStore();

/** 换一个缓存实现（测试注入 / 以后接远程缓存）；传 null / 不传就恢复默认 */
export function setRankStore(store) {
  rankStore = store || makeRankStore();
}

/** 榜单缓存运行状态（排障 / 测试用）；store 没提供 stats 就返回 null */
export function rankCacheStats() {
  return rankStore && typeof rankStore.stats === 'function' ? rankStore.stats() : null;
}

/**
 * 缓存键里的「数据库身份」：一个进程里可能同时开着几个库（本地多端口、多个测试），不区分就会串榜。
 * LocalD1（node:sqlite）能给出文件路径，优先用它；真 Workers 的 D1 绑定拿不到路径，退回站点 origin。
 * 绝不能拿绑定对象本身当键：Workers 每次请求现拼 env，对象一变缓存就永远不命中。
 */
function rankDbScope(ctx) {
  const db = ctx && ctx.db;
  try {
    if (db && typeof db.location === 'function') {
      const loc = db.location();
      if (loc) return String(loc);
    }
  } catch (e) { /* 没有这个方法或调用失败：退回 origin */ }
  return String((ctx && ctx.origin) || 'd1');
}

/** 榜单缓存键：影响结果的参数一个都不能少（库 / 榜单种类 / 条数） */
function rankCacheKey(ctx, kind, limit) {
  return RANK_CACHE_PREFIX + rankDbScope(ctx) + ':' + kind + ':' + limit;
}

/**
 * 可选的第二层：Cloudflare Cache API（caches.default）。进程内缓存随实例重启清零，这一层能跨实例。
 * 本地 dev / 单测里没有 caches 这个全局对象，用 typeof 保护后直接跳过（不报错、不改任何行为）。
 *
 * 两个风险必须写清：
 *   1. 只缓存「榜单行数据」（JSON），绝不缓存整页 HTML —— 页面带登录态（导航栏是用户名），
 *      缓存 HTML 会把一个用户的页面发给另一个用户；
 *   2. 缓存是建议性的（边缘按自己的策略淘汰），所以这层「命中算赚、不中不亏」，
 *      任何一步出错都直接放过，绝不影响渲染。
 */
const RANK_CACHE_API_TTL = 30;

function rankApiCache() {
  if (typeof caches === 'undefined' || !caches || !caches.default) return null;
  return caches.default;
}

/** Cache API 的键用站点自己的 /rank URL，带一个只有我们用的标记参数，便于运维辨认与清理 */
function rankApiCacheUrl(ctx, kind, limit) {
  return String((ctx && ctx.origin) || '') + '/rank?kind=' + encodeURIComponent(kind) +
    '&limit=' + encodeURIComponent(limit) + '&__rows=1';
}

async function rankApiCacheGet(ctx, kind, limit) {
  const cache = rankApiCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(new Request(rankApiCacheUrl(ctx, kind, limit)));
    if (!hit) return null;
    const rows = await hit.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    return null;
  }
}

function rankApiCachePut(ctx, kind, limit, rows) {
  const cache = rankApiCache();
  if (!cache) return;
  try {
    const res = new Response(JSON.stringify(rows), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=' + RANK_CACHE_API_TTL }
    });
    const put = cache.put(new Request(rankApiCacheUrl(ctx, kind, limit)), res);
    if (put && typeof put.catch === 'function') put.catch(function () { /* 写边缘缓存失败只影响下次命中率 */ });
  } catch (e) { /* 同上：缓存问题不能影响渲染 */ }
}

/** 榜单行：Cache API（可选，跨实例）→ 进程内 TTL 缓存（单飞）→ D1 聚合 */
async function loadLeaderboardRows(ctx, kind, limit) {
  const hot = await rankApiCacheGet(ctx, kind, limit);
  if (hot) return hot;
  const rows = await rankStore.getOrLoad(rankCacheKey(ctx, kind, limit), function () {
    return data.leaderboard(ctx.db, kind, limit).then(function (board) { return board.rows; });
  });
  rankApiCachePut(ctx, kind, limit, rows);
  return rows;
}

/* ---------- 响应工具 ---------- */

function makeHeaders(ctx, opts) {
  const o = opts || {};
  const h = new Headers(SECURITY_HEADERS);
  h.set('content-type', o.type || 'text/html; charset=utf-8');
  if (o.cache) h.set('cache-control', o.cache);
  if (o.location) h.set('location', o.location);
  if (o.robot) h.set('x-robots-tag', o.robot);
  if (o.csp) h.set('content-security-policy', o.csp);
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
/** 分享卡出口：SVG 必须带 charset，5 分钟公共缓存（内容随数据变，别让 CDN 存太久） */
const CARD_CACHE = 'public, max-age=300';
function cardReply(ctx, svg) {
  return new Response(svg, { status: 200, headers: makeHeaders(ctx, { type: 'image/svg+xml; charset=utf-8', cache: CARD_CACHE }) });
}

/* ---------- 附件 / OG 位图 / 天梯（对应 Express 的 saveUploads、sendOgOrCard、ratingsOf） ---------- */

/** 表单里收下来的附件逐个落库；任何一份出错都只打日志，绝不打断发帖（与 server.js 的 saveUploads 同口径） */
async function saveUploads(ctx, body, place) {
  const list = body && Array.isArray(body.list) ? body.list : [];
  if (!list.length) return [];
  await attach.ensureAttachments(ctx.db);
  const out = [];
  for (const f of list) {
    try {
      const r = await attach.saveAttachment(ctx.db, {
        ownerId: place.ownerId,
        threadId: place.threadId || 0,
        postId: place.postId || 0,
        filename: f.name,
        mime: f.type,
        bytes: f.bytes
      });
      if (r && r.ok) out.push(r);
      else console.warn('[attach] 附件没收下：' + String((r && (r.error || r.hint)) || 'unknown'));
    } catch (e) {
      console.warn('[attach] 附件写入异常：' + (e && e.message ? e.message : String(e)));
    }
  }
  return out;
}

/** 主题页附件：主题级（post_id=0，发帖时附件先落、楼层随后）单独一层，楼层按 post_id 分组 */
async function withAttachments(ctx, threadId, posts) {
  const r = await attach.listThreadAttachments(ctx.db, threadId);
  const items = (r && Array.isArray(r.items)) ? r.items : [];
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

/** OG 位图要的 HTML 壳（等价于 src/og.js 的 svgToHtml，这里内联一份避免把 node: 依赖拖进 Worker 包） */
function svgPageHtml(svg) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#0b1020}' +
    'svg{display:block;width:1200px;height:630px}</style></head><body>' + svg + '</body></html>';
}

/** OG 位图：Workers 侧走 Cloudflare Browser Rendering（配 BROWSER_RENDERING_URL/TOKEN），拿不到就回同一张 SVG，绝不 404 */
async function sendOgOrCard(ctx, svg) {
  const env = ctx.env || {};
  const endpoint = String(env.CLOUDFLARE_BROWSER_RENDERING_URL || env.BROWSER_RENDERING_URL || '');
  if (!endpoint) return cardReply(ctx, svg);
  try {
    const headers = { 'content-type': 'application/json', accept: 'image/png' };
    const token = String(env.BROWSER_RENDERING_TOKEN || '');
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify({ html: svgPageHtml(svg) }) });
    const buf = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    if (buf && buf.length > 8 && buf[0] === 137 && buf[1] === 80) {
      return new Response(buf, { status: 200, headers: makeHeaders(ctx, { type: 'image/png', cache: CARD_CACHE }) });
    }
    console.warn('[og] 位图没渲染出来（' + (res.ok ? 'not_png' : 'http_' + res.status) + '）');
  } catch (e) {
    console.warn('[og] 位图渲染异常：' + (e && e.message ? e.message : String(e)));
  }
  return cardReply(ctx, svg);
}

/** 天梯：服务端裁判的四款棋（src/rules 的 SLUGS 顺序即展示顺序） */
const LADDER_GAMES = rules.SLUGS;

async function ladderTabs(ctx) {
  const out = [];
  for (const slug of LADDER_GAMES) {
    const g = await data.getGame(ctx.db, slug);
    out.push({ slug: slug, title: (g && g.title) || slug, icon: (g && g.emoji) || '♟' });
  }
  return out;
}

/** 某人在四款棋上的天梯战绩（没打过就跳过，与 server.js 的 ratingsOf 同口径） */
async function ratingsOf(ctx, userId, season) {
  const out = [];
  for (const slug of LADDER_GAMES) {
    const board = await play.ratingBoard(ctx.db, slug, season, 200);
    const items = (board && board.items) || [];
    const idx = items.findIndex((x) => Number(x.userId) === Number(userId));
    if (idx < 0) continue;
    const row = items[idx];
    if (!Number(row.games)) continue;
    const g = await data.getGame(ctx.db, slug);
    out.push({
      game: slug, title: (g && g.title) || slug, icon: (g && g.emoji) || '♟',
      rating: row.rating, games: row.games, wins: row.wins, losses: row.losses, draws: row.draws,
      peak: row.peak, rank: row.rank || idx + 1, total: board.total
    });
  }
  return out;
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
      const files = {};
      const list = [];
      for (const entry of fd.entries()) {
        if (typeof entry[1] === 'string') { o[entry[0]] = entry[1]; continue; }
        // File：投稿上传的单文件 HTML，正文读成文本交给数据层校验；附件还要原始字节
        const f = {
          name: String(entry[1].name || ''),
          type: String(entry[1].type || ''),
          size: Number(entry[1].size) || 0,
          html: '',
          bytes: null
        };
        try { f.html = await entry[1].text(); } catch { f.html = ''; }
        try { f.bytes = new Uint8Array(await entry[1].arrayBuffer()); } catch { f.bytes = null; }
        list.push(f);
        const prev = files[entry[0]];
        if (prev) files[entry[0]] = Array.isArray(prev) ? prev.concat([f]) : [prev, f];
        else files[entry[0]] = f;
      }
      if (list.length) o.list = list; // 论坛附件按顺序逐个收（同名字段多文件也在）
      if (files.game_file) o.file = files.game_file;
      else if (Object.keys(files).length === 1) o.file = files[Object.keys(files)[0]];
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
  // 首页顶部横幅：置顶优先，其次最新的一条已发布公告
  const notice = await data.latestNotice(db);
  return okHtml(ctx, ui.homePage({ origin: ctx.origin, user: ctx.user, featured, hot, newest, categories, tags, stats, notice: notice }));
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
  // 搜索走适配层：没配 MEILI_HOST 就是原来的 listGames + countGames（同一个 opts、同一个顺序），
  // 配了则 Meili 优先，失败 / 超时 / 熔断自动兜底到 SQL —— 请求照常 200，降级只打一行日志
  const q = String(ctx.url.searchParams.get('q') || '').slice(0, 50);
  const sort = String(ctx.url.searchParams.get('sort') || 'hot');
  const opts = { q: q, sort: sort, limit: 60 };
  const found = await searchGamePage(ctx, q, opts);
  return okHtml(ctx, ui.listPage({
    origin: ctx.origin, user: ctx.user,
    path: '/search?q=' + encodeURIComponent(q),
    heading: q ? '「' + q + '」的搜索结果' : '搜索游戏',
    sub: '输入游戏名、类型或标签进行搜索',
    list: found.list,
    total: found.total,
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
    // ?watch=观战钥匙 / ?replay=棋谱 id：只透传给 iframe 里的播放器，权限校验都在 API 侧
    watch: String(ctx.url.searchParams.get('watch') || ''),
    replay: String(ctx.url.searchParams.get('replay') || ''),
    cmtNotice: CMT_NOTICE[String(ctx.url.searchParams.get('report') || '')] || ''
  }));
}

/* ---------- 公告与更新说明 ---------- */

/** 公告列表：只列已发布的（撤回的只有站长在后台看得到） */
async function pageNotice(ctx) {
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const list = await data.listPublishedPosts(ctx.db, { page: page });
  return okHtml(ctx, ui.noticeListPage({
    origin: ctx.origin, user: ctx.user,
    items: list.items, total: list.total, page: list.page, pages: list.pages
  }));
}

/** 公告详情：正文 + 评论区（和游戏详情页共用一块评论面板） */
async function pageNoticeDetail(ctx, params) {
  const db = ctx.db;
  const post = await data.getPost(db, String(params.slug));
  if (!post) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const cpage = Math.max(1, Number(ctx.url.searchParams.get('cpage')) || 1);
  return okHtml(ctx, ui.noticePage({
    origin: ctx.origin, user: ctx.user, post: post,
    thread: await data.noticeThread(db, post.id, cpage),
    commentTotal: await data.countNoticeComments(db, post.id),
    cmtNotice: CMT_NOTICE[String(ctx.url.searchParams.get('report') || '')] || ''
  }));
}

/** 更新说明：读 src/changelog-data.js（tools/gen-changelog.mjs 从 git log 生成） */
async function pageChangelog(ctx) {
  return okHtml(ctx, ui.changelogPage({ origin: ctx.origin, user: ctx.user }));
}

/** 导航页：fishport.cn 下所有能打开的站点（清单在 src/sites.js） */
async function pagePortal(ctx) {
  return okHtml(ctx, ui.portalPage({ origin: ctx.origin, user: ctx.user }));
}

/** 排行榜：热玩榜按天聚合的纯 SQLite 查询，7 个榜单切着看 */
async function pageRank(ctx) {
  // 行数据走 30s 缓存（进程内 TTL + 单飞，可选 Cache API 层）；label / metric 仍取自 BOARD_KINDS，
  // 与缓存前逐字节一致
  const kind = data.boardKind(ctx.url.searchParams.get('kind'));
  const spec = data.BOARD_KINDS[kind];
  const rows = await loadLeaderboardRows(ctx, kind, 20);
  return okHtml(ctx, ui.rankPage({
    origin: ctx.origin,
    user: ctx.user,
    kind: kind,
    label: spec.label,
    metric: spec.metric,
    rows: rows,
    boards: Object.entries(data.BOARD_KINDS).map(function (e) { return { kind: e[0], label: e[1].label }; })
  }));
}

/* ================= 账号 ================= */

async function pageLogin(ctx) {
  const next = safeNext(ctx.url.searchParams.get('next'));
  if (ctx.user) return redirectTo(ctx, next);
  return okHtml(ctx, ui.loginPage({ origin: ctx.origin, next: next, providers: await oauth.enabledProviders(ctx.env) }));
}

async function doLogin(ctx) {
  const b = await readBody(ctx.request);
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const r = await auth.login(ctx.db, username, b.password);
  if (r.error) {
    return okHtml(ctx, ui.loginPage({
      origin: ctx.origin, next: next, error: r.error, username: username, providers: await oauth.enabledProviders(ctx.env)
    }), 401);
  }
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600, ctx.env));
  return redirectTo(ctx, next);
}

async function pageRegister(ctx) {
  const next = safeNext(ctx.url.searchParams.get('next'));
  if (ctx.user) return redirectTo(ctx, next);
  return okHtml(ctx, ui.registerPage({ origin: ctx.origin, next: next, providers: await oauth.enabledProviders(ctx.env) }));
}

async function doRegister(ctx) {
  const b = await readBody(ctx.request);
  const next = safeNext(b.next);
  const username = String(b.username || '');
  const displayName = String(b.display_name || '');
  const v = auth.validateRegister(username, b.password, displayName);
  const fail = async (error, status) => okHtml(ctx, ui.registerPage({
    origin: ctx.origin, next: next, error: error, username: username, displayName: displayName,
    providers: await oauth.enabledProviders(ctx.env)
  }), status);
  if (v.error) return fail(v.error, 400);
  // 注册页必须勾选同意《用户协议》与《隐私政策》（表单里是必填 checkbox，这里再兜一次）
  if (!b.agree) return fail('请先阅读并勾选同意《用户协议》与《隐私政策》', 400);
  if (await auth.findUser(ctx.db, v.username)) return fail('这个用户名已经被注册了，换一个吧', 409);
  const user = await auth.createUser(ctx.db, v.username, v.password, v.displayName);
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, user.id), auth.SESSION_DAYS * 24 * 3600, ctx.env));
  return redirectTo(ctx, next);
}

/* ---------- 法律页面（静态文本，登录与否都可看） ---------- */

async function pagePrivacy(ctx) {
  return okHtml(ctx, ui.privacyPage({ origin: ctx.origin, user: ctx.user }));
}

async function pageTerms(ctx) {
  return okHtml(ctx, ui.termsPage({ origin: ctx.origin, user: ctx.user }));
}

async function doLogout(ctx) {
  await auth.destroySession(ctx.db, auth.readCookie(ctx.request.headers.get('cookie'), auth.COOKIE));
  ctx.cookies.push(auth.sessionCookie('', 0, ctx.env));
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
    profile: await social.profileOf(ctx.db, ctx.user.id),
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
  ctx.cookies.push(auth.sessionCookie('', 0, ctx.env));
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
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600, ctx.env));
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

/**
 * 投稿上传的单文件 HTML：正文直接从 D1 里取出来吐回去。
 * 待审（status = 2）与已下架的投稿只对站长开放，免得猜 slug 就能看到未上架内容。
 */
async function pageUgcFile(ctx, params) {
  const notFound = () => new Response('404 Not Found', { status: 404, headers: makeHeaders(ctx, { type: 'text/plain; charset=utf-8', cache: 'no-store' }) });
  // 同 Express 版：slug 可能是中文（matchRoute 已 decode 过 :file），只认扩展名与长度
  const m = /^(.+)\.html?$/i.exec(String(params.file || ''));
  const slug = m ? m[1] : '';
  if (!slug || slug.length > 64 || slug.indexOf('/') >= 0 || slug.indexOf('\\') >= 0) return notFound();
  const game = await data.getGameAny(ctx.db, slug);
  const file = await data.getGameFile(ctx.db, slug);
  const isAdmin = !!ctx.user && ctx.user.role === 'admin';
  if (!game || !file || (Number(game.status) !== 1 && !isAdmin)) return notFound();
  return new Response(file.html, {
    status: 200,
    headers: makeHeaders(ctx, { type: 'text/html; charset=utf-8', cache: 'public, max-age=60', csp: UGC_HTML_CSP })
  });
}

/* ================= 后台 ================= */

/** 「集成自检」面板的数据：邮件通道与各第三方登录的配置状态（只看配没配，不回显密钥） */
function integrationsOf(ctx) {
  const env = ctx.env || {};
  const keys = oauth.PROVIDERS.concat(oauth.devEnabled(env) ? ['dev'] : []);
  return {
    mail: {
      transport: mail.transportName(env),
      endpoint: env.MAIL_API_URL || '',
      from: mail.MAIL_FROM(env),
      keySet: !!(env.RESEND_API_KEY || env.MAIL_API_KEY)
    },
    oauth: keys.map(function (k) {
      const m = oauth.providerMeta(k);
      const c = oauth.providerCreds(k, env);
      return {
        key: k,
        label: m.label,
        icon: m.icon,
        env: (m.env || []).join(' / '),
        enabled: oauth.providerEnabled(k, env),
        idSet: !!(c && c.id),
        secretSet: !!(c && c.secret),
        callback: m.mock ? '' : oauth.redirectUri(ctx.origin, k)
      };
    })
  };
}

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
    posts: await data.listPosts(db, { limit: 100 }),
    notice: String(ctx.url.searchParams.get('ok') || ''),
    integrations: integrationsOf(ctx)
  }));
}

/** 送达率 / 抑制名单后台页（对应 Express 的 GET /admin/mail） */
async function pageAdminMail(ctx) {
  return okHtml(ctx, ui.mailAdminPage({
    origin: ctx.origin, user: ctx.user,
    stats: await outbox.deliveryStats(ctx.db, 7),
    suppressed: await outbox.listSuppressed(ctx.db, 50),
    bounces: (await outbox.bounceSummary(ctx.db, 20)).rows,
    webhook: { ready: !!String(ctx.env.MAIL_WEBHOOK_SECRET || ''), path: '/webhooks/mail-bounce' },
    notice: String(ctx.url.searchParams.get('ok') || '')
  }));
}

async function adminMailSuppress(ctx) {
  const b = await readBody(ctx.request);
  const address = String(b.address || '').trim().slice(0, 200);
  const reason = String(b.reason || '').trim().slice(0, 120);
  const r = await outbox.suppress(ctx.db, address, reason, 'manual');
  if (!r.ok) return redirectTo(ctx, '/admin/mail?ok=bad');
  await data.logAudit(ctx.db, ctx.user, 'mail.suppress', r.address, reason + (r.cleared ? ' 清掉排队 ' + r.cleared + ' 封' : ''));
  return redirectTo(ctx, '/admin/mail?ok=suppress');
}

async function adminMailUnsuppress(ctx) {
  const b = await readBody(ctx.request);
  const address = String(b.address || '').trim().slice(0, 200);
  const r = await outbox.unsuppress(ctx.db, address);
  if (!r.removed) return redirectTo(ctx, '/admin/mail?ok=missing');
  await data.logAudit(ctx.db, ctx.user, 'mail.unsuppress', r.address, '');
  return redirectTo(ctx, '/admin/mail?ok=unsuppress');
}

/* ---------- 邮件：服务商退信 / 投诉回调（对应 Express 的 POST /webhooks/mail-bounce） ---------- */

/** 定长时间比较（Worker 里没有 node:crypto 的 timingSafeEqual，照 worker/auth.js 的写法） */
function tokenEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 只有退信/投诉/投递失败才抑制；其它事件（送达、打开）照收 200，免得服务商重投 */
const BOUNCE_EVENT_RE = /bounce|complain|failed/; // Resend 的投诉事件名是 email.complained（-ed），别只写 complaint

/** 回调体里的收件人：Resend 是 {type:'email.bounced', data:{to:[…]}}，也认扁平的 {to, reason} */
function bounceAddresses(body, query) {
  const q = query || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const d = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) { for (const x of v) push(x); return; }
    if (v && typeof v === 'object') { push(v.email || v.address || v.recipient || ''); return; }
    const s = String(v || '').trim();
    if (s.includes('@')) out.push(s);
  };
  push(b.to); push(d.to); push(b.email); push(d.email); push(b.recipient); push(d.recipient); push(q.to);
  return Array.from(new Set(out)).slice(0, 20);
}

/** 事件类型与原因；type 为空时按「服务商既然打到了这个端点」当成退信处理 */
function bounceKind(body, query) {
  const q = query || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const d = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
  const bounce = (d.bounce && typeof d.bounce === 'object') ? d.bounce
    : ((b.bounce && typeof b.bounce === 'object') ? b.bounce : {});
  const type = String(b.type || b.event || b.event_type || b.eventType || q.type || '').toLowerCase();
  const reason = String(b.reason || d.reason || bounce.message || b.description || d.description || type || '').slice(0, 200);
  const hard = /permanent|hard/i.test(String(bounce.type || b.bounce_type || ''));
  return { type: type, reason: reason, hit: !type || hard || BOUNCE_EVENT_RE.test(type) };
}

async function webhookMailBounce(ctx) {
  const secret = String(ctx.env.MAIL_WEBHOOK_SECRET || '');
  const bearer = String(ctx.request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const got = String(bearer || ctx.url.searchParams.get('token') || '').trim();
  if (!tokenEqual(got, secret)) {
    return okJson(ctx, { ok: false, error: secret ? 'forbidden' : 'not_configured' }, 403);
  }
  const body = await readBody(ctx.request);
  const addresses = bounceAddresses(body, { to: ctx.url.searchParams.get('to') || '' });
  if (!addresses.length) return okJson(ctx, { ok: false, error: 'no_recipient' }, 400);
  const k = bounceKind(body, { type: ctx.url.searchParams.get('type') || '' });
  if (!k.hit) return okJson(ctx, { ok: true, ignored: k.type || 'unknown', suppressed: 0, addresses: [] });
  const done = [];
  for (const addr of addresses) {
    const r = await outbox.markBounced(ctx.db, addr, 'provider: ' + (k.reason || k.type || 'bounce'));
    if (r.ok) done.push(addr);
  }
  if (done.length) await data.logAudit(ctx.db, null, 'mail.bounce', done.join(','), (k.reason || k.type || 'bounce'));
  return okJson(ctx, { ok: true, type: k.type || 'bounce', suppressed: done.length, addresses: done });
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

/** 彻底删除确认页：连带数据量先摆出来，上架中的游戏不让删 */
async function adminDeletePage(ctx, params) {
  const game = await data.getGameAny(ctx.db, String(params.slug));
  if (!game) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  return okHtml(ctx, ui.deleteGamePage({
    origin: ctx.origin,
    user: ctx.user,
    game: game,
    counts: (await data.gamePurgeInfo(ctx.db, game.slug)) || {}
  }));
}

async function adminDelete(ctx, params) {
  const slug = String(params.slug);
  const r = await data.deleteGame(ctx.db, slug);
  if (r.error === 'online') return plainText(ctx, '这个游戏还在上架中，请先下架再彻底删除', 400);
  if (r.error) return plainText(ctx, '没有这个游戏', 404);
  const i = r.info;
  await data.logAudit(ctx.db, ctx.user, 'game.delete', slug,
    i.title + '（评论 ' + i.comments + ' / 举报 ' + i.reports + ' / 评分 ' + i.ratings +
    ' / 收藏 ' + i.favorites + ' / 游玩 ' + i.plays + ' / 上传文件 ' + i.file + '）');
  return redirectTo(ctx, '/admin?ok=purge');
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

/* ---------- 后台：公告发布 / 编辑 / 撤回 ---------- */

async function adminPostNew(ctx) {
  return okHtml(ctx, ui.postFormPage({
    origin: ctx.origin, user: ctx.user,
    error: String(ctx.url.searchParams.get('error') || '')
  }));
}

async function doPostNew(ctx) {
  const b = await readBody(ctx.request);
  const r = await data.createPost(ctx.db, { title: b.title, body: b.body, pinned: b.pinned, status: b.draft ? 0 : 1 }, ctx.user.id);
  if (r.error) return redirectTo(ctx, '/admin/posts/new?error=' + encodeURIComponent(r.error));
  await data.logAudit(ctx.db, ctx.user, 'post.create', r.slug, r.title + (r.status ? '' : '（先存着，未发布）'));
  return redirectTo(ctx, '/admin?ok=post');
}

async function adminPostEdit(ctx, params) {
  const post = await data.getPostAny(ctx.db, String(params.slug));
  if (!post) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  return okHtml(ctx, ui.postFormPage({
    origin: ctx.origin, user: ctx.user, post: post,
    error: String(ctx.url.searchParams.get('error') || '')
  }));
}

async function doPostEdit(ctx, params) {
  const b = await readBody(ctx.request);
  const slug = String(params.slug);
  const r = await data.updatePost(ctx.db, slug, { title: b.title, body: b.body, pinned: b.pinned });
  if (r.error === 'not_found') return plainText(ctx, '没有这条公告', 404);
  if (r.error) return redirectTo(ctx, '/admin/posts/' + encodeURIComponent(slug) + '/edit?error=' + encodeURIComponent(r.error));
  await data.logAudit(ctx.db, ctx.user, 'post.update', r.slug, r.title);
  return redirectTo(ctx, '/admin?ok=post');
}

async function adminPostStatus(ctx, params) {
  const b = await readBody(ctx.request);
  const slug = String(params.slug);
  const r = await data.setPostStatus(ctx.db, slug, b.status);
  if (r.error) return plainText(ctx, '没有这条公告', 404);
  await data.logAudit(ctx.db, ctx.user, r.status ? 'post.publish' : 'post.retract', slug, r.status ? '发布' : '撤回（前台隐藏，评论保留）');
  return redirectTo(ctx, '/admin?ok=postStatus');
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
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, r.user.id), auth.SESSION_DAYS * 24 * 3600, ctx.env));
  return okJson(ctx, { user: r.user });
}

async function apiRegister(ctx) {
  const b = await readBody(ctx.request);
  const v = auth.validateRegister(b.username, b.password, b.display_name);
  if (v.error) return okJson(ctx, { error: 'bad_input', hint: v.error }, 400);
  if (await auth.findUser(ctx.db, v.username)) return okJson(ctx, { error: 'taken', hint: '用户名已被注册' }, 409);
  const user = await auth.createUser(ctx.db, v.username, v.password, v.displayName);
  ctx.cookies.push(auth.sessionCookie(await auth.createSession(ctx.db, user.id), auth.SESSION_DAYS * 24 * 3600, ctx.env));
  return okJson(ctx, { user: user }, 201);
}

async function apiLogout(ctx) {
  await auth.destroySession(ctx.db, auth.readCookie(ctx.request.headers.get('cookie'), auth.COOKIE));
  ctx.cookies.push(auth.sessionCookie('', 0, ctx.env));
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
  // 每日挑战：当天那款游戏收到一次播放事件就算打卡（服务端判定，前端不申报）
  const daily = ctx.user ? await social.markDaily(ctx.db, ctx.user.id, slug, Date.now()) : null;
  return okJson(ctx, { counted: true, plays: plays, daily: daily && daily.fresh ? daily.day : '' });
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
  await notifyGameComment(ctx, slug, r.id, r.body);
  return okJson(ctx, { id: r.id, body: r.body, name: ctx.user.name, parent_id: r.parent_id });
}

/** 搜索建议：和列表页同一套相关度排序，输入拼音/首字母也能命中 */
/** 公告评论：和游戏评论同一套（分页 + 楼中楼 + 10 秒限流） */
async function apiNoticeComments(ctx, params) {
  const post = await data.getPost(ctx.db, String(params.slug));
  if (!post) return okJson(ctx, { error: 'not_found' }, 404);
  const pageSize = Math.max(1, Math.min(50,
    Number(ctx.url.searchParams.get('pageSize')) || data.COMMENT_PAGE_SIZE));
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const thread = await data.noticeThread(ctx.db, post.id, page, pageSize);
  return okJson(ctx, {
    slug: post.slug, total: thread.total, page: thread.page, pages: thread.pages,
    pageSize: thread.pageSize, items: thread.items
  });
}

async function apiNoticeComment(ctx, params) {
  if (!ctx.user) return okJson(ctx, { error: 'login_required', hint: '登录后才能评论' }, 401);
  const post = await data.getPost(ctx.db, String(params.slug));
  if (!post) return okJson(ctx, { error: 'not_found' }, 404);
  const key = 'post:' + ctx.user.id + ':' + post.id;
  const now = Date.now();
  if (now - (commentGate.get(key) || 0) < 10000) {
    return okJson(ctx, { error: 'too_fast', hint: '发得太快了，歇 10 秒再发' }, 429);
  }
  const body = await readBody(ctx.request);
  const r = await data.addNoticeComment(ctx.db, post.id, ctx.user.id, body.body, body.parent_id || null);
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
  // 走搜索适配层：没配 MEILI_HOST 就是原来那一句 listGames（同一个 opts）；配了 Meili 优先、失败自动兜底
  const list = await searchGameList(ctx, q, { q: q, limit: 6 });
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


/* ================= 论坛 ================= */

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

function forumCode(e) {
  const k = String(e || '');
  return FORUM_ERR[k] ? k : 'default';
}

function forumOkOf(ctx) {
  return FORUM_MSG[String(ctx.url.searchParams.get('ok') || '')] || '';
}

function forumErrOf(ctx) {
  return FORUM_ERR[String(ctx.url.searchParams.get('err') || '')] || '';
}

function forumTo(ctx, path, ok, err) {
  if (ok) return redirectTo(ctx, withQuery(path, 'ok=' + encodeURIComponent(ok)));
  if (err) return redirectTo(ctx, withQuery(path, 'err=' + encodeURIComponent(forumCode(err))));
  return redirectTo(ctx, path);
}

async function forumToken(ctx, kind) {
  return { token: await forum.issueNonce(ctx.db, ctx.user.id, kind), honeypot: fguard.HONEYPOT_FIELD };
}

/** 发帖类 POST 的前置检查：蜜罐字段 + 一次性表单令牌 */
async function forumPrefilter(ctx, kind, b) {
  if (String(b[fguard.HONEYPOT_FIELD] || '').trim()) return { err: 'bot' };
  const n = await forum.consumeNonce(ctx.db, String(b.form_token || ''), ctx.user.id, kind);
  if (!n.ok) return { err: 'stale' };
  return { fastSubmit: Number(n.dwellMs) < fguard.MIN_DWELL_MS };
}

function forumViewer(ctx) {
  return ctx.user ? ctx.user.id : null;
}

async function pageForumHome(ctx) {
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const q = String(ctx.url.searchParams.get('q') || '').slice(0, 60);
  const tag = String(ctx.url.searchParams.get('tag') || '').slice(0, 24);
  const list = await forum.listThreads(ctx.db, { q: q, tag: tag, page: page, viewerId: forumViewer(ctx) });
  return okHtml(ctx, ui.forumHomePage({
    origin: ctx.origin, user: ctx.user, forums: await forum.listForums(ctx.db),
    threads: list.items, total: list.total, page: list.page, pages: list.pages, q: q, tag: tag,
    base: ctx.forumBase, stats: await forum.forumStats(ctx.db), notice: forumOkOf(ctx)
  }));
}

async function pageForumNew(ctx) {
  return okHtml(ctx, ui.forumNewPage({
    origin: ctx.origin, user: ctx.user, forums: await forum.listForums(ctx.db),
    forumSlug: String(ctx.url.searchParams.get('forum') || ''), base: ctx.forumBase,
    gate: ctx.user ? await forum.forumGate(ctx.db, ctx.user) : null,
    form: ctx.user ? await forumToken(ctx, 'thread') : null,
    error: forumErrOf(ctx)
  }));
}

async function doForumNew(ctx) {
  const guard = needLogin(ctx, ctx.forumBase + '/new');
  if (guard) return guard;
  const b = await readBody(ctx.request);
  const back = ctx.forumBase + '/new';
  const rerender = async (msg) => okHtml(ctx, ui.forumNewPage({
    origin: ctx.origin, user: ctx.user, forums: await forum.listForums(ctx.db),
    forumSlug: String(b.forum || ''), error: msg, values: { title: b.title, body: b.body },
    base: ctx.forumBase, gate: await forum.forumGate(ctx.db, ctx.user), form: await forumToken(ctx, 'thread')
  }), 400);
  const pre = await forumPrefilter(ctx, 'thread', b);
  if (pre.err) return forumTo(ctx, back, null, pre.err);
  const tv = fguard.validateTitle(b.title);
  if (!tv.ok) return rerender(tv.error);
  const bv = fguard.validateBody(b.body);
  if (!bv.ok) return rerender(bv.error);
  const f = await forum.getForum(ctx.db, String(b.forum || ''));
  if (!f) return forumTo(ctx, back, null, 'no_forum');
  // 频控只由数据层的 checkRate 负责（排在前面的还有 forumGate 禁言与黑名单判定）
  const r = await forum.createThread(ctx.db, {
    forumId: f.id, user: ctx.user, title: tv.value, body: bv.value, fastSubmit: pre.fastSubmit
  });
  if (r.error) return forumTo(ctx, back, null, r.error);
  await data.logAudit(ctx.db, ctx.user, 'forum.thread.create', String(r.id),
    (Number(r.status) === 1 ? '直接发布' : '转待审' + (r.reason ? '（' + r.reason + '）' : '')) + '：' + String(tv.value).slice(0, 40));
  // 标签只允许 admin/mod 落库（数据层把关，普通作者填了也不报错，与 Express 线一致）
  if (String(b.tags || '').trim()) await forum.setThreadTags(ctx.db, r.id, b.tags, ctx.user.role);
  await notifyThreadMentions(ctx, r.id, bv.value);
  await saveUploads(ctx, b, { ownerId: ctx.user.id, threadId: r.id });
  return forumTo(ctx, ctx.forumBase + '/t/' + r.id, Number(r.status) === 1 ? 'published' : 'pending');
}

async function pageForumBoard(ctx, params) {
  const f = await forum.getForum(ctx.db, String(params.slug));
  if (!f) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const q = String(ctx.url.searchParams.get('q') || '').slice(0, 60);
  const tag = String(ctx.url.searchParams.get('tag') || '').slice(0, 24);
  const list = await forum.listThreads(ctx.db, { forum: f.slug, q: q, tag: tag, page: page, viewerId: forumViewer(ctx) });
  return okHtml(ctx, ui.forumBoardPage({
    origin: ctx.origin, user: ctx.user, forum: f,
    threads: list.items, total: list.total, page: list.page, pages: list.pages, q: q, tag: tag, base: ctx.forumBase
  }));
}

async function pageForumThread(ctx, params) {
  const id = Number(params.id) || 0;
  const t = await forum.getThread(ctx.db, id, ctx.user);
  if (!t || !t.canView) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const page = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const list = await forum.listPosts(ctx.db, id, { page: page, viewer: ctx.user });
  await forum.bumpThreadView(ctx.db, id);
  const rid = Number(ctx.url.searchParams.get('reply')) || 0;
  const rp = rid ? await forum.getPost(ctx.db, rid, ctx.user) : null;
  const replyTo = rp && Number(rp.thread_id) === id ? { id: rp.id, floor: 0, name: rp.name || rp.username } : null;
  // 附件不在帖子行里（data-forum 不带），读侧自己按 post_id 分组补上
  const att = await withAttachments(ctx, id, list.items);
  return okHtml(ctx, ui.forumThreadPage({
    origin: ctx.origin, user: ctx.user, thread: Object.assign({}, t.thread, { attachments: att.thread }),
    forum: { slug: t.thread.forum_slug, name: t.thread.forum_name, icon: t.thread.forum_icon },
    posts: att.posts, total: list.total, page: list.page, pages: list.pages,
    base: ctx.forumBase, replyTo: replyTo,
    gate: ctx.user ? await forum.forumGate(ctx.db, ctx.user) : null,
    form: ctx.user ? await forumToken(ctx, 'post') : null,
    notice: forumOkOf(ctx), error: forumErrOf(ctx)
  }));
}

async function doForumReply(ctx, params) {
  const id = Number(params.id) || 0;
  const guard = needLogin(ctx, ctx.forumBase + '/t/' + id);
  if (guard) return guard;
  const b = await readBody(ctx.request);
  const back = ctx.forumBase + '/t/' + id;
  const pre = await forumPrefilter(ctx, 'post', b);
  if (pre.err) return forumTo(ctx, back, null, pre.err);
  const bv = fguard.validateBody(b.body);
  if (!bv.ok) return forumTo(ctx, back, null, 'empty');
  const r = await forum.createReply(ctx.db, {
    threadId: id, user: ctx.user, body: bv.value,
    parentId: Number(b.parent_id) || null, fastSubmit: pre.fastSubmit
  });
  if (r.error) return forumTo(ctx, back, null, r.error);
  await data.logAudit(ctx.db, ctx.user, 'forum.post.create', String(r.id), '回复主题 #' + id + (Number(r.status) === 1 ? '' : '（转待审）'));
  await notifyThreadReply(ctx, id, r.id, bv.value);
  await saveUploads(ctx, b, { ownerId: ctx.user.id, threadId: id, postId: r.id });
  return forumTo(ctx, back + '#p' + r.id, Number(r.status) === 1 ? 'replied' : 'pending');
}

async function pageForumEdit(ctx, params) {
  const post = await forum.getPost(ctx.db, Number(params.id) || 0, ctx.user);
  if (!post) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  if (Number(post.user_id) !== Number(ctx.user.id) && ctx.user.role !== 'admin') {
    return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  }
  return okHtml(ctx, ui.forumEditPage({
    origin: ctx.origin, user: ctx.user, post: post,
    thread: { id: post.thread_id, title: '主题 #' + post.thread_id },
    base: ctx.forumBase, form: await forumToken(ctx, 'post'), error: forumErrOf(ctx)
  }));
}

async function doForumEdit(ctx, params) {
  const id = Number(params.id) || 0;
  const guard = needLogin(ctx, ctx.forumBase + '/post/' + id + '/edit');
  if (guard) return guard;
  const b = await readBody(ctx.request);
  const post = await forum.getPost(ctx.db, id, ctx.user);
  if (!post) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const back = ctx.forumBase + '/t/' + post.thread_id;
  const pre = await forumPrefilter(ctx, 'post', b);
  if (pre.err) return forumTo(ctx, back, null, pre.err);
  const bv = fguard.validateBody(b.body);
  if (!bv.ok) return forumTo(ctx, ctx.forumBase + '/post/' + id + '/edit', null, 'empty');
  const r = await forum.editPost(ctx.db, { postId: id, user: ctx.user, body: bv.value, fastSubmit: pre.fastSubmit });
  if (r.error) return forumTo(ctx, back, null, r.error);
  await data.logAudit(ctx.db, ctx.user, 'forum.post.edit', String(id), '主题 #' + post.thread_id + '：' + String(bv.value).slice(0, 40));
  // 编辑时补的附件也收下（编辑不做频控，与 Express 线一致）
  await saveUploads(ctx, b, { ownerId: ctx.user.id, threadId: post.thread_id, postId: id });
  return forumTo(ctx, back + '#p' + id, r.unchanged ? 'done' : (Number(r.status) === 1 ? 'edited' : 'pending'));
}

async function doForumReport(ctx) {
  const guard = needLogin(ctx, ctx.forumBase + '/');
  if (guard) return guard;
  const b = await readBody(ctx.request);
  const tp = String(b.target_type || '');
  const tid = Number(b.target_id) || 0;
  const r = await forum.reportTarget(ctx.db, {
    targetType: tp, targetId: tid, user: ctx.user, reason: String(b.reason || ''), detail: String(b.detail || '')
  });
  const back = r.threadId ? ctx.forumBase + '/t/' + r.threadId : ctx.forumBase + '/';
  if (r.error) return forumTo(ctx, back, null, r.error);
  await data.logAudit(ctx.db, ctx.user, 'forum.report', tp + ':' + tid, '理由 ' + String(b.reason || '') + (r.already ? '（重复举报）' : ''));
  return forumTo(ctx, back, 'reported');
}

/* ---------- 论坛后台 ---------- */

async function pageForumAdmin(ctx) {
  return okHtml(ctx, ui.forumAdminPage({
    origin: ctx.origin, user: ctx.user, stats: await forum.forumStats(ctx.db),
    pendingThreads: await forum.listPendingThreads(ctx.db, 50),
    pendingPosts: await forum.listPendingPosts(ctx.db, 50),
    reports: await forum.listReports(ctx.db, 0, 50),
    blacklist: await forum.listBlacklist(ctx.db), muted: await forum.listMuted(ctx.db, 20),
    notice: forumOkOf(ctx)
  }));
}

async function adminForumThreadStatus(ctx, params) {
  const id = Number(params.id) || 0;
  const b = await readBody(ctx.request);
  const r = await forum.setThreadStatus(ctx.db, id, b.status);
  await data.logAudit(ctx.db, ctx.user, 'forum.thread.status', String(id),
    Number(r.status) === 1 ? '通过' : Number(r.status) === 2 ? '下架' : '转待审');
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumThreadFlags(ctx, params) {
  const id = Number(params.id) || 0;
  const b = await readBody(ctx.request);
  const flags = {};
  if (b.pinned !== undefined) flags.pinned = Number(b.pinned) ? 1 : 0;
  if (b.locked !== undefined) flags.locked = Number(b.locked) ? 1 : 0;
  await forum.setThreadFlags(ctx.db, id, flags);
  await data.logAudit(ctx.db, ctx.user, 'forum.thread.flags', String(id),
    (flags.pinned !== undefined ? (flags.pinned ? '置顶' : '取消置顶') : '') +
    (flags.locked !== undefined ? (flags.locked ? ' 锁定' : ' 解锁') : ''));
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumPostStatus(ctx, params) {
  const id = Number(params.id) || 0;
  const b = await readBody(ctx.request);
  const r = await forum.setPostStatus(ctx.db, id, b.status);
  await data.logAudit(ctx.db, ctx.user, 'forum.post.status', String(id), Number(r.status) === 2 ? '隐藏' : '通过');
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumReportStatus(ctx, params) {
  const id = Number(params.id) || 0;
  const b = await readBody(ctx.request);
  const r = await forum.setReportStatus(ctx.db, id, b.status);
  await data.logAudit(ctx.db, ctx.user, 'forum.report.status', String(id), Number(r.status) === 2 ? '忽略' : '已处理');
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumBlacklist(ctx) {
  const b = await readBody(ctx.request);
  const r = await forum.addBlacklist(ctx.db, { pattern: b.pattern, kind: b.kind, action: b.action, note: b.note });
  if (r.error) return forumTo(ctx, '/forum/admin', null, r.error);
  await data.logAudit(ctx.db, ctx.user, 'forum.blacklist.add', String(r.id || ''),
    String(b.kind || 'word') + ' / ' + String(b.pattern || '').slice(0, 60));
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumBlacklistDel(ctx, params) {
  const id = Number(params.id) || 0;
  await forum.deleteBlacklist(ctx.db, id);
  await data.logAudit(ctx.db, ctx.user, 'forum.blacklist.del', String(id), '');
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumMuteByName(ctx) {
  const b = await readBody(ctx.request);
  const uname = String(b.username || '').trim().toLowerCase();
  const found = (await data.listUsers(ctx.db, { q: uname, limit: 20 })).find(function (u) {
    return String(u.username).toLowerCase() === uname;
  });
  if (!found) return forumTo(ctx, '/forum/admin', null, 'not_found');
  const r = await forum.setUserMuted(ctx.db, found.id, Number(b.minutes) || 0, String(b.reason || ''));
  await data.logAudit(ctx.db, ctx.user, r.muted ? 'forum.user.mute' : 'forum.user.unmute', String(found.id),
    (found.display_name || found.username) + (r.muted ? ' 禁言 ' + r.minutes + ' 分钟：' + String(b.reason || '') : ' 解除禁言'));
  return forumTo(ctx, '/forum/admin', 'done');
}

async function adminForumMuteById(ctx, params) {
  const id = Number(params.id) || 0;
  const b = await readBody(ctx.request);
  const r = await forum.setUserMuted(ctx.db, id, Number(b.minutes) || 0, String(b.reason || ''));
  await data.logAudit(ctx.db, ctx.user, r.muted ? 'forum.user.mute' : 'forum.user.unmute', String(id),
    r.muted ? '禁言 ' + r.minutes + ' 分钟' : '解除禁言');
  return forumTo(ctx, '/forum/admin', 'done');
}

/* ================= 联机对战（房间 + 走法中继） ================= */
//
// 与 Express 线 server.js 的 /api/play/* 一一对应：服务端负责「轮流 + 转发走法」，
// 并对接入了规则引擎的棋类（connect4 / reversi / draughts / gomoku）自己裁判走法与胜负
// （判在 worker/play-store.js 的 sendMove 里）；其余棋类照旧只中继、采信客户端声明的 result。
// 成功统一 { ok: true, ... }，失败 { ok: false, error, hint }，错误码映射见 PLAY_STATUS。

const PLAY_STATUS = {
  not_found: 404, bad_token: 403, full: 409, busy: 503,
  bad_code: 400, bad_game: 400, bad_move: 400, illegal_move: 400,
  not_your_turn: 409, not_playing: 409, done: 409, closed: 409, playing: 409, waiting: 409
};
const PLAY_HINT = {
  not_found: '房间不存在或已过期', bad_token: '座位凭证无效（清掉浏览器数据后请重新创建房间）',
  full: '房间已经满员', busy: '暂时没有可加入的房间，请稍后再试',
  bad_code: '房间码是 6 位字母数字', bad_game: '游戏标识不合法', bad_move: '走法数据不合法',
  illegal_move: '这步不合规则（服务端已裁判）',
  not_your_turn: '还没轮到你', not_playing: '对局还没开始', done: '对局已经结束',
  closed: '房间已经关闭', playing: '房间已在对局中', waiting: '还没等到对手'
};

function playReply(ctx, r, status = 200) {
  if (r && r.error) {
    return okJson(ctx, { ok: false, error: r.error, hint: PLAY_HINT[r.error] || '' }, PLAY_STATUS[r.error] || 400);
  }
  return okJson(ctx, Object.assign({ ok: true }, r), status);
}

/** 已登录请求的用户 id，没登录就是 0（匿名也能玩，落库时记 0；与 Express 线的 userIdOf 同口径） */
function userIdOf(ctx) {
  return Number(ctx.user && ctx.user.id) || 0;
}

function playThrottled(ctx, key) {
  const ip = ctx.request.headers.get('cf-connecting-ip') || 'local';
  return !dedupe(key + ':' + ip, 1000);
}

async function apiPlayCreate(ctx) {
  const b = await readBody(ctx.request);
  if (playThrottled(ctx, 'play-new')) return okJson(ctx, { ok: false, error: 'busy', hint: '别急，稍等一秒' }, 429);
  return playReply(ctx, await play.createRoom(ctx.db, b.game, b.name, Date.now(), { userId: userIdOf(ctx) }), 201);
}

async function apiPlayQuick(ctx) {
  const b = await readBody(ctx.request);
  if (playThrottled(ctx, 'play-new')) return okJson(ctx, { ok: false, error: 'busy', hint: '别急，稍等一秒' }, 429);
  const r = await play.quickMatch(ctx.db, b.game, b.name, Date.now(), { userId: userIdOf(ctx) });
  return playReply(ctx, r, r.created ? 201 : 200);
}

async function apiPlayJoin(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.joinRoom(ctx.db, b.code, b.name, Date.now(), { userId: userIdOf(ctx) }));
}

async function apiPlayPoll(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.poll(ctx.db, Number(b.id), b.token, Number(b.since) || 0, Date.now()));
}

async function apiPlayMove(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.sendMove(ctx.db, Number(b.id), b.token, b.move, b.result, Date.now()));
}

async function apiPlayResign(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.resign(ctx.db, Number(b.id), b.token, Date.now()));
}

async function apiPlayRematch(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.rematch(ctx.db, Number(b.id), b.token, Date.now()));
}

async function apiPlayLeave(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.leave(ctx.db, Number(b.id), b.token, Date.now()));
}

/* ================= 每日挑战 / 个人主页 / 棋谱回放 ================= */

async function pageDaily(ctx) {
  const day = dayKey();
  const slug = await social.dailySlug(ctx.db, day);
  const stats = ctx.user ? await social.dailyStats(ctx.db, ctx.user.id) : null;
  return okHtml(ctx, ui.dailyPage({
    origin: ctx.origin,
    user: ctx.user,
    day: day,
    game: await data.getGame(ctx.db, slug),
    // dailyStats 的返回形状就是视图要的形状（含 calendar / perfect / makeupUsed），整份透传
    stats: stats || null,
    board: await social.dailyBoard(ctx.db, day, 12),
    notice: String(ctx.url.searchParams.get('notice') || '')
  }));
}

/**
 * 补做：只开放最近两天（src/daily.js 的 makeupCheck），记在目标日那一行、落 makeup=1。
 * 题目 slug 由目标日重算，客户端补不了别的题；窗口外的日期直接带 notice 回每日挑战页。
 */
async function doDailyMakeup(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/daily', b);
  if (guard) return guard;
  const day = String(b.day || '');
  const chk = makeupCheck(day);
  if (chk) return redirectTo(ctx, withQuery('/daily', 'notice=' + encodeURIComponent(chk)));
  const slug = await social.dailySlug(ctx.db, day);
  const r = await social.markDaily(ctx.db, ctx.user.id, slug, Date.now(), { day: day });
  const key = r && r.error ? r.error : 'makeup';
  return redirectTo(ctx, withQuery('/daily', 'notice=' + encodeURIComponent(key)));
}

async function pageProfile(ctx, params) {
  const profile = await social.profileByName(ctx.db, String(params.name));
  if (!profile) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  return okHtml(ctx, ui.profilePage({
    origin: ctx.origin,
    user: ctx.user,
    profile: profile,
    isSelf: !!(ctx.user && Number(ctx.user.id) === Number(profile.id)),
    counts: await social.followCounts(ctx.db, profile.id),
    following: ctx.user ? await social.isFollowing(ctx.db, ctx.user.id, profile.id) : false,
    ratings: await ratingsOf(ctx, profile.id, seasonOf(Date.now())),
    notice: FOLLOW_TEXT[String(ctx.url.searchParams.get('notice') || '')] || ''
  }));
}

async function pageReplay(ctx, params) {
  const id = Number(params.id);
  const rep = Number.isInteger(id) && id > 0 ? await play.replay(ctx.db, id) : null;
  if (!rep) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  await play.bumpReplayPlays(ctx.db, id);
  const more = await play.replayList(ctx.db, { game: rep.game, limit: 10 });
  return okHtml(ctx, ui.replayPage({
    origin: ctx.origin,
    user: ctx.user,
    replay: rep,
    game: await data.getGame(ctx.db, rep.game),
    more: ((more && more.items) || []).filter(function (x) { return Number(x.id) !== id; }).slice(0, 6)
  }));
}

/* 观战：只认「房间 id + watch_token」，拿到的是公开视图（seat = -1），永远看不到玩家座位凭证 */
async function apiPlayWatch(ctx) {
  const b = await readBody(ctx.request);
  return playReply(ctx, await play.watchRoom(ctx.db, String(b.key || ''), Number(b.since) || 0, Date.now()));
}

/** 回放页与游戏页的 ?replay= 播放器都读这一份，客户端不能改写棋谱 */
async function apiReplay(ctx, params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return okJson(ctx, { ok: false, error: 'bad_id' }, 400);
  const rep = await play.replay(ctx.db, id);
  if (!rep) return okJson(ctx, { ok: false, error: 'not_found', hint: '棋谱不存在或已被清理' }, 404);
  await play.bumpReplayPlays(ctx.db, id);
  return okJson(ctx, { ok: true, replay: rep });
}

/* ---- 分享卡（与 Express 线 server.js 的三条 /…/card.svg 一一对应，同一份 src/cards.js） ---- */

/** 每日挑战成绩卡：游客也能拿（没有打卡记录时按 0 渲染） */
async function cardDaily(ctx) {
  const day = dayKey();
  const slug = await social.dailySlug(ctx.db, day);
  const stats = ctx.user ? await social.dailyStats(ctx.db, ctx.user.id) : null;
  return cardReply(ctx, dailyCardSvg({
    day: day,
    game: await data.getGame(ctx.db, slug),
    stats: stats,
    origin: ctx.origin
  }));
}

/** 个人主页成绩卡：取不到这个人就是 404 */
async function cardProfile(ctx, params) {
  const profile = await social.profileByName(ctx.db, String(params.name || ''));
  if (!profile) return plainText(ctx, 'not found', 404);
  return cardReply(ctx, profileCardSvg({ profile: profile, origin: ctx.origin }));
}

/** 棋谱分享卡：非法 id 给 400（地址写错了）而不是 404（棋谱没了） */
async function cardReplay(ctx, params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return plainText(ctx, 'bad id', 400);
  const rep = await play.replay(ctx.db, id);
  if (!rep) return plainText(ctx, 'not found', 404);
  return cardReply(ctx, replayCardSvg({ replay: rep, game: await data.getGame(ctx.db, rep.game), origin: ctx.origin }));
}

/* ================= 社交：通知 / 私信 / 关注 =================
   第七批：路由与 Express 线 server.js 一一对应（数据层在 worker/social.js，
   第一参数是 D1 绑定，全程 await）。 */

const NOTICE_PAGE = 20;
const PEOPLE_PAGE = 24;
/** 好友动态每页条数（与 views.feedPage 保持一致） */
const FEED_PAGE = 20;
/** 关注动作回跳后的提示文案（对齐 server.js FOLLOW_TEXT） */
const FOLLOW_TEXT = { followed: '已关注', unfollowed: '已取消关注', self_follow: '不能关注自己', no_user: '没有这个用户' };

/** 页码：非法或负数一律回第 1 页（对齐 server.js pageOf） */
function pageOf(v) {
  return Math.max(1, Number(v) || 1);
}

async function pageNotifications(ctx) {
  const page = pageOf(ctx.url.searchParams.get('page'));
  const list = await social.listNotifications(ctx.db, ctx.user.id, { limit: NOTICE_PAGE, offset: (page - 1) * NOTICE_PAGE });
  return okHtml(ctx, ui.notificationsPage({
    origin: ctx.origin,
    user: ctx.user,
    list: list,
    page: page,
    notice: String(ctx.url.searchParams.get('notice') || '') === 'read' ? '全部标为已读' : ''
  }));
}

/** 好友动态流：关注的人最近在玩什么（第十批）；notice 只认关注动作那几个白名单值，不透传原串 */
async function pageFeed(ctx) {
  const page = pageOf(ctx.url.searchParams.get('page'));
  const list = await social.friendFeed(ctx.db, ctx.user.id, { limit: FEED_PAGE, offset: (page - 1) * FEED_PAGE });
  return okHtml(ctx, ui.feedPage({
    origin: ctx.origin,
    user: ctx.user,
    list: list,
    page: page,
    notice: FOLLOW_TEXT[String(ctx.url.searchParams.get('notice') || '')] || ''
  }));
}

/** 标为已读：带合法 id 只标那条，不带就把全部未读标掉 */
async function doNotificationsRead(ctx) {
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/notifications', b);
  if (guard) return guard;
  await social.markRead(ctx.db, ctx.user.id, Number(b.id) || 0);
  return redirectTo(ctx, withQuery(safeNext(b.next || '/notifications'), 'notice=read'));
}

async function pageMessages(ctx) {
  return okHtml(ctx, ui.messagesPage({
    origin: ctx.origin,
    user: ctx.user,
    threads: await social.listMessageThreads(ctx.db, ctx.user.id, { limit: 50 })
  }));
}

async function pageMessageThread(ctx, params) {
  const peer = await social.profileByName(ctx.db, String(params.name || ''));
  if (!peer || Number(peer.id) === Number(ctx.user.id)) {
    return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  }
  await social.markThreadRead(ctx.db, ctx.user.id, peer.id);
  const err = String(ctx.url.searchParams.get('error') || '');
  return okHtml(ctx, ui.messagesPage({
    origin: ctx.origin,
    user: ctx.user,
    peer: peer,
    thread: await social.threadMessages(ctx.db, ctx.user.id, peer.id, { limit: 30 }),
    notice: String(ctx.url.searchParams.get('notice') || '') === 'sent' ? '已发送' : '',
    error: err === 'too_long' ? '私信最多 ' + social.MESSAGE_MAX + ' 字' : (err === 'empty' ? '私信不能为空' : '')
  }));
}

async function doMessageSend(ctx, params) {
  const name = String(params.name || '');
  const back = '/messages/' + encodeURIComponent(name);
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/messages', b);
  if (guard) return guard;
  const peer = await social.profileByName(ctx.db, name);
  if (!peer) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const r = await social.sendMessage(ctx.db, ctx.user.id, peer.id, b.body);
  return redirectTo(ctx, r.error ? withQuery(back, 'error=' + encodeURIComponent(r.error)) : withQuery(back, 'notice=sent'));
}

/** 关注列表：粉丝 / 关注 / 好友（互关）三个 tab 共用一套渲染 */
function peopleHandler(kind) {
  return async function (ctx, params) {
    const owner = await social.profileByName(ctx.db, String(params.name || ''));
    if (!owner) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
    const page = pageOf(ctx.url.searchParams.get('page'));
    return okHtml(ctx, ui.peoplePage({
      origin: ctx.origin,
      user: ctx.user,
      owner: owner,
      kind: kind,
      page: page,
      list: await social.followList(ctx.db, owner.id, kind, { limit: PEOPLE_PAGE, offset: (page - 1) * PEOPLE_PAGE })
    }));
  };
}

const pageFollowers = peopleHandler('followers');
const pageFollowing = peopleHandler('following');
const pageFriends = peopleHandler('friends');

/** 关注 / 取关：同一个地址，按钮自带 action=follow|unfollow；没带就按当前状态取反 */
async function doFollow(ctx, params) {
  const name = String(params.name || '');
  const back = '/u/' + encodeURIComponent(name);
  const b = await readBody(ctx.request);
  const guard = needLogin(ctx, '/u', b);
  if (guard) return guard;
  const peer = await social.profileByName(ctx.db, name);
  if (!peer) return okHtml(ctx, ui.notFoundPage({ origin: ctx.origin, user: ctx.user }), 404);
  const action = String(b.action || '');
  const want = action === 'unfollow' ? false : (action === 'follow' ? true : !(await social.isFollowing(ctx.db, ctx.user.id, peer.id)));
  const r = want ? await social.follow(ctx.db, ctx.user.id, peer.id) : await social.unfollow(ctx.db, ctx.user.id, peer.id);
  const key = r.error ? r.error : (want ? 'followed' : 'unfollowed');
  // 只在「新关注」时发通知；social.notify 自己还会按 (user,kind,actor,target) 去重
  if (!r.error && want) {
    try {
      await social.notify(ctx.db, peer.id, { kind: 'follow', actorId: ctx.user.id, targetType: 'user', targetId: ctx.user.id });
    } catch (e) {
      console.error('[notify] follow ' + (e && e.message ? e.message : e));
    }
  }
  return redirectTo(ctx, withQuery(back, 'notice=' + encodeURIComponent(key)));
}

/** 导航上的小红点：通知未读数 */
async function apiNotificationsUnread(ctx) {
  if (!ctx.user) return okJson(ctx, { ok: false, error: 'login_required', unread: 0 }, 401);
  return okJson(ctx, { ok: true, unread: await social.unreadCount(ctx.db, ctx.user.id) });
}

/** 导航上的小红点：私信未读数（按会话汇总） */
async function apiMessagesUnread(ctx) {
  if (!ctx.user) return okJson(ctx, { ok: false, error: 'login_required', unread: 0 }, 401);
  const t = await social.listMessageThreads(ctx.db, ctx.user.id, { limit: 100 });
  return okJson(ctx, { ok: true, unread: (t.items || []).reduce(function (n, x) { return n + Number(x.unread || 0); }, 0) });
}

/* ---------- Web Push：浏览器订阅（没配 VAPID 时 enabled:false，前端不显示按钮） ---------- */

/** 公钥：前端拿它当 applicationServerKey 订阅（views.js 的 pushScript 认 configured/publicKey/subscribed） */
async function apiPushKey(ctx) {
  const key = push.vapidPublicKey(ctx.env);
  const subs = ctx.user ? await push.listSubscriptions(ctx.db, ctx.user.id) : [];
  return okJson(ctx, {
    ok: true,
    configured: !!key,
    publicKey: key,
    subscribed: (subs || []).some(function (s) { return !s.disabled; })
  });
}

/** 订阅：body 收 { subscription }，也兼容直接收订阅对象本身 */
async function apiPushSubscribe(ctx) {
  if (!ctx.user) return okJson(ctx, { ok: false, error: 'login_required' }, 401);
  const b = await readBody(ctx.request);
  const sub = (b && (b.subscription || b)) || null;
  const r = await push.subscribe(ctx.db, ctx.user.id, sub, ctx.request.headers.get('user-agent') || '');
  return okJson(ctx, { ok: !!r.ok, id: r.id || 0, error: r.error || '' }, r.ok ? 200 : 400);
}

/** 退订：不带 endpoint = 这个账号的全部订阅都退 */
async function apiPushUnsubscribe(ctx) {
  if (!ctx.user) return okJson(ctx, { ok: false, error: 'login_required' }, 401);
  const b = await readBody(ctx.request);
  const r = await push.unsubscribe(ctx.db, ctx.user.id, (b && b.endpoint) || '');
  return okJson(ctx, { ok: true, removed: r.removed });
}

/* ---------- 通知钩子：动作成功后补写通知，失败只记日志，绝不影响主流程 ---------- */

/** 回复主题之后：楼主收 reply，正文里 @ 到的人收 mention */
async function notifyThreadReply(ctx, threadId, postId, body) {
  try {
    const info = await forum.getThread(ctx.db, threadId, ctx.user);
    const t = info && info.thread ? info.thread : null;
    await social.notifyReply(ctx.db, {
      actorId: ctx.user.id,
      threadId: threadId,
      threadTitle: t ? t.title : '',
      ownerId: t ? Number(t.user_id) || 0 : 0,
      postId: postId,
      body: body
    });
  } catch (e) {
    console.error('[notify] reply ' + (e && e.message ? e.message : e));
  }
}

/** 发帖之后：楼主就是自己（reply 不发），只把正文里 @ 到的人落成 mention */
async function notifyThreadMentions(ctx, threadId, body) {
  try {
    await social.notifyMentions(ctx.db, {
      actorId: ctx.user.id,
      text: body,
      targetType: 'thread',
      targetId: String(Number(threadId) || 0),
      body: body
    });
  } catch (e) {
    console.error('[notify] thread ' + (e && e.message ? e.message : e));
  }
}

/** 游戏评论之后：作品作者收 comment，正文里 @ 到的人收 mention（自己评自己不写） */
async function notifyGameComment(ctx, slug, commentId, body) {
  try {
    const game = await data.getGame(ctx.db, slug);
    await social.notifyComment(ctx.db, {
      actorId: ctx.user.id,
      gameSlug: slug,
      ownerId: game ? Number(game.submitted_by) || 0 : 0,
      commentId: commentId,
      body: body
    });
  } catch (e) {
    console.error('[notify] comment ' + (e && e.message ? e.message : e));
  }
}

/* ================= 天梯 / 棋谱列表 / OG 位图（第二轮，对应 server.js /ladder · /replays · 三条 og.png） ================= */

/** 天梯：四款服务端裁判棋的 Elo 榜（?game=<slug> 切换，缺省第一款） */
async function pageLadder(ctx) {
  const asked = String(ctx.url.searchParams.get('game') || '');
  const game = LADDER_GAMES.indexOf(asked) >= 0 ? asked : (LADDER_GAMES[0] || '');
  const season = seasonOf(Date.now());
  return okHtml(ctx, ui.ladderPage({
    origin: ctx.origin,
    user: ctx.user,
    game: game,
    games: await ladderTabs(ctx),
    board: game ? await play.ratingBoard(ctx.db, game, season, 50) : null,
    season: season,
    notice: String(ctx.url.searchParams.get('notice') || '')
  }));
}

/** 查询串收成「每个键取第一个值」的普通对象，口径与 Express 的 req.query 一致（重复键取首次出现） */
function replayQuery(url) {
  const q = {};
  for (const [k, v] of url.searchParams) if (!(k in q)) q[k] = v;
  return q;
}
/** 棋谱检索：game（六款之一）/ player（昵称，房主或访客）/ result（host|guest|draw）/ from,to（日期或毫秒）/ mine=1 */
function replayFiltersFor(ctx) {
  const f = play.replayFilters(replayQuery(ctx.url));
  // 页面沿用老口径：game 只认天梯里的六款，其余一律当没填（与 Express 线一字不差）
  const game = LADDER_GAMES.indexOf(f.game) >= 0 ? f.game : '';
  // 「只看我的」优先按账号 id 匹配（play_replays.host_user_id / guest_user_id），
  // 昵称一起传是为了老棋谱（落库时还没有用户列，记为 0）靠建房昵称回退命中——与 Express 线一字不差。
  const u = ctx.user || null;
  const names = u ? [u.name, u.username].filter(Boolean) : [];
  const mine = f.mine && !!u;
  return {
    filters: Object.assign({}, f, { game: game, mine: mine }),
    mine: mine ? names : [],
    ownerId: mine ? Number(u.id) || 0 : 0
  };
}

/** 棋谱列表：只列裁判棋的对局（?game= 过滤、?page= 翻页，另支持上面那组检索参数） */
async function pageReplays(ctx) {
  const PAGE = 20;
  const q = replayFiltersFor(ctx);
  const asked2 = Math.max(1, Number(ctx.url.searchParams.get('page')) || 1);
  const list = await play.replayList(ctx.db, {
    game: q.filters.game,
    player: q.filters.player,
    result: q.filters.result,
    from: q.filters.from,
    to: q.filters.to,
    mine: q.mine,
    ownerId: q.ownerId,
    limit: PAGE,
    offset: (asked2 - 1) * PAGE
  });
  const total = Number((list && list.total) || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return okHtml(ctx, ui.replaysPage({
    origin: ctx.origin,
    user: ctx.user,
    items: (list && list.items) || [],
    total: total,
    game: q.filters.game,
    games: await ladderTabs(ctx),
    page: Math.min(asked2, pages),
    pages: pages,
    filters: q.filters
  }));
}

/**
 * 棋谱导出：/api/replays（JSON）与 /replays/export.json（带附件头）共用同一实现。
 * 棋谱是公开数据，未登录也能导出；但一次最多 500 条（默认 200），并按 IP 限流，
 * 免得被当成「整库导出器」来刷。翻页读 HTML 不受影响，只有这两个 JSON 端点计数。
 */
const replayExportHits = new Map();
/** 窗口限流：同一把 key 在 winMs 内最多 max 次（超过 5000 条就清空，别让 Map 无限长） */
function replayWindow(key, max, winMs) {
  const now = Date.now();
  if (replayExportHits.size > 5000) replayExportHits.clear();
  const hit = replayExportHits.get(key);
  if (!hit || now - hit.at >= winMs) {
    replayExportHits.set(key, { at: now, n: 1 });
    return true;
  }
  if (hit.n >= max) return false;
  hit.n += 1;
  return true;
}
/** 附件名里的当天日期（与 dayKey() 同口径）：replays-YYYYMMDD.json */
function replayStamp() {
  return dayKey().replace(/-/g, '');
}
/** 导出接口本体：筛选参数与 /replays 页面完全一致；limit 默认 200，夹在 1..500 */
async function apiReplays(ctx) {
  const ip = ctx.request.headers.get('cf-connecting-ip') || 'local';
  if (!replayWindow('replay-export:' + ip, 60, 60000)) {
    return okJson(ctx, { ok: false, error: 'busy', hint: '导出太频繁了，歇一分钟再来' }, 429);
  }
  const q = replayFiltersFor(ctx);
  const raw = ctx.url.searchParams.get('limit');
  const asked = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? Math.floor(asked) : 200, 1), play.REPLAY_MAX_LIMIT);
  const list = await play.replayList(ctx.db, {
    game: q.filters.game,
    player: q.filters.player,
    result: q.filters.result,
    from: q.filters.from,
    to: q.filters.to,
    mine: q.mine,
    ownerId: q.ownerId,
    limit: limit,
    offset: 0,
    maxLimit: play.REPLAY_MAX_LIMIT
  });
  const items = (list && list.items) || [];
  const res = okJson(ctx, { ok: true, total: Number((list && list.total) || 0), count: items.length, items: items });
  res.headers.set('cache-control', 'no-store');
  if (ctx.url.pathname === '/replays/export.json') {
    res.headers.set('content-disposition', 'attachment; filename=replays-' + replayStamp() + '.json');
  }
  return res;
}

/** 棋谱 OG 位图：非法 id 给 400（地址写错了），棋谱没了给 404 */
async function ogReplay(ctx, params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return plainText(ctx, 'bad id', 400);
  const rep = await play.replay(ctx.db, id);
  if (!rep) return plainText(ctx, 'not found', 404);
  return sendOgOrCard(ctx, replayCardSvg({ replay: rep, game: await data.getGame(ctx.db, rep.game), origin: ctx.origin }));
}

async function ogProfile(ctx, params) {
  const profile = await social.profileByName(ctx.db, String(params.name || ''));
  if (!profile) return plainText(ctx, 'not found', 404);
  return sendOgOrCard(ctx, profileCardSvg({ profile: profile, origin: ctx.origin }));
}

async function ogDaily(ctx) {
  const day = dayKey();
  const slug = await social.dailySlug(ctx.db, day);
  const stats = ctx.user ? await social.dailyStats(ctx.db, ctx.user.id) : null;
  return sendOgOrCard(ctx, dailyCardSvg({ day: day, game: await data.getGame(ctx.db, slug), stats: stats, origin: ctx.origin }));
}

/* ================= 路由表 ================= */

const ROUTES = [
  { m: 'GET', p: '/', fn: pageHome },
  { m: 'GET', p: '/games', fn: pageGames },
  { m: 'GET', p: '/category/:slug', fn: pageCategory },
  { m: 'GET', p: '/tag/:tag', fn: pageTag },
  { m: 'GET', p: '/search', fn: pageSearch },
  { m: 'GET', p: '/game/:slug', fn: pageGame },
  /* 附件下载：must 排在 /ugc/:file 之前（匹配按段数 + 字面段，这里额外走一层 /a/） */
  { m: 'GET', p: '/ugc/a/:id', fn: attach.pageAttachment },
  { m: 'GET', p: '/ugc/:file', fn: pageUgcFile },
  { m: 'GET', p: '/notice', fn: pageNotice },
  { m: 'GET', p: '/notice/:slug', fn: pageNoticeDetail },
  { m: 'GET', p: '/changelog', fn: pageChangelog },
  { m: 'GET', p: '/nav', fn: pagePortal },
  { m: 'GET', p: '/rank', fn: pageRank },
  { m: 'GET', p: '/daily', fn: pageDaily },
  { m: 'POST', p: '/daily/makeup', fn: doDailyMakeup },
  { m: 'GET', p: '/daily/card.svg', fn: cardDaily },
  { m: 'GET', p: '/u/:name', fn: pageProfile },
  { m: 'GET', p: '/u/:name/card.svg', fn: cardProfile },
  { m: 'GET', p: '/replay/:id', fn: pageReplay },
  { m: 'GET', p: '/play/:id/card.svg', fn: cardReplay },
  { m: 'GET', p: '/ladder', fn: pageLadder },
  { m: 'GET', p: '/replays', fn: pageReplays },
  { m: 'GET', p: '/play/:id/og.png', fn: ogReplay },
  { m: 'GET', p: '/daily/og.png', fn: ogDaily },
  { m: 'GET', p: '/u/:name/og.png', fn: ogProfile },
  // 社交：通知 / 私信 / 关注列表（第七批）
  { m: 'GET', p: '/notifications', fn: pageNotifications, need: 'user' },
  { m: 'GET', p: '/feed', fn: pageFeed, need: 'user' },
  { m: 'POST', p: '/notifications/read', fn: doNotificationsRead },
  { m: 'GET', p: '/messages', fn: pageMessages, need: 'user' },
  { m: 'GET', p: '/messages/:name', fn: pageMessageThread, need: 'user' },
  { m: 'POST', p: '/messages/:name', fn: doMessageSend },
  { m: 'GET', p: '/u/:name/followers', fn: pageFollowers },
  { m: 'GET', p: '/u/:name/following', fn: pageFollowing },
  { m: 'GET', p: '/u/:name/friends', fn: pageFriends },
  { m: 'POST', p: '/u/:name/follow', fn: doFollow },
  { m: 'GET', p: '/login', fn: pageLogin },
  { m: 'POST', p: '/login', fn: doLogin },
  { m: 'GET', p: '/register', fn: pageRegister },
  { m: 'POST', p: '/register', fn: doRegister },
  { m: 'GET', p: '/privacy', fn: pagePrivacy },
  { m: 'GET', p: '/terms', fn: pageTerms },
  { m: 'POST', p: '/logout', fn: doLogout },
  { m: 'GET', p: '/favorites', fn: pageFavorites, need: 'user' },
  { m: 'GET', p: '/submit', fn: pageSubmit, need: 'user' },
  { m: 'POST', p: '/submit', fn: doSubmit, need: 'user' },
  { m: 'GET', p: '/admin', fn: pageAdmin, need: 'admin' },
  { m: 'GET', p: '/admin/mail', fn: pageAdminMail, need: 'admin' },
  { m: 'POST', p: '/admin/mail/suppress', fn: adminMailSuppress, need: 'admin' },
  { m: 'POST', p: '/admin/mail/unsuppress', fn: adminMailUnsuppress, need: 'admin' },
  { m: 'POST', p: '/webhooks/mail-bounce', fn: webhookMailBounce },
  { m: 'GET', p: '/admin/games/:slug/delete', fn: adminDeletePage, need: 'admin' },
  { m: 'POST', p: '/admin/games/:slug/delete', fn: adminDelete, need: 'admin' },
  { m: 'POST', p: '/admin/games/:slug/status', fn: adminSetGame, need: 'admin' },
  { m: 'POST', p: '/admin/comments/:id/status', fn: adminSetComment, need: 'admin' },
  { m: 'GET', p: '/api/me', fn: apiMe },
  // 社交：导航小红点的未读数
  { m: 'GET', p: '/api/notifications/unread', fn: apiNotificationsUnread },
  { m: 'GET', p: '/api/messages/unread', fn: apiMessagesUnread },
  // Web Push：订阅（公钥 / 订阅 / 退订）
  { m: 'GET', p: '/api/push/key', fn: apiPushKey },
  { m: 'POST', p: '/api/push/subscribe', fn: apiPushSubscribe },
  { m: 'POST', p: '/api/push/unsubscribe', fn: apiPushUnsubscribe },
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
  { m: 'GET', p: '/api/notices/:slug/comments', fn: apiNoticeComments },
  { m: 'POST', p: '/api/notices/:slug/comments', fn: apiNoticeComment },
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
  { m: 'GET', p: '/admin/posts/new', fn: adminPostNew, need: 'admin' },
  { m: 'POST', p: '/admin/posts/new', fn: doPostNew, need: 'admin' },
  { m: 'GET', p: '/admin/posts/:slug/edit', fn: adminPostEdit, need: 'admin' },
  { m: 'POST', p: '/admin/posts/:slug/edit', fn: doPostEdit, need: 'admin' },
  { m: 'POST', p: '/admin/posts/:slug/status', fn: adminPostStatus, need: 'admin' },
  { m: 'GET', p: '/admin/preview/:slug', fn: adminPreview, need: 'admin' },
  { m: 'POST', p: '/admin/games/batch', fn: adminBatch, need: 'admin' },
  { m: 'POST', p: '/admin/reports/:id/status', fn: adminReportStatus, need: 'admin' },
  { m: 'POST', p: '/admin/users/:id/ban', fn: adminUserBan, need: 'admin' },
  { m: 'POST', p: '/admin/users/:id/verify', fn: adminUserVerify, need: 'admin' },
  { m: 'GET', p: '/forum', fn: pageForumHome },
  { m: 'GET', p: '/forum/new', fn: pageForumNew },
  { m: 'POST', p: '/forum/new', fn: doForumNew },
  { m: 'GET', p: '/forum/f/:slug', fn: pageForumBoard },
  { m: 'GET', p: '/forum/t/:id', fn: pageForumThread },
  { m: 'POST', p: '/forum/t/:id/reply', fn: doForumReply },
  { m: 'GET', p: '/forum/post/:id/edit', fn: pageForumEdit, need: 'user' },
  { m: 'POST', p: '/forum/post/:id/edit', fn: doForumEdit },
  { m: 'POST', p: '/forum/report', fn: doForumReport },
  { m: 'GET', p: '/forum/admin', fn: pageForumAdmin, need: 'admin' },
  { m: 'POST', p: '/forum/admin/threads/:id/status', fn: adminForumThreadStatus, need: 'admin' },
  { m: 'POST', p: '/forum/admin/threads/:id/flags', fn: adminForumThreadFlags, need: 'admin' },
  { m: 'POST', p: '/forum/admin/posts/:id/status', fn: adminForumPostStatus, need: 'admin' },
  { m: 'POST', p: '/forum/admin/reports/:id/status', fn: adminForumReportStatus, need: 'admin' },
  { m: 'POST', p: '/forum/admin/blacklist', fn: adminForumBlacklist, need: 'admin' },
  { m: 'POST', p: '/forum/admin/blacklist/:id/delete', fn: adminForumBlacklistDel, need: 'admin' },
  { m: 'POST', p: '/forum/admin/users/mute', fn: adminForumMuteByName, need: 'admin' },
  { m: 'POST', p: '/forum/admin/users/:id/mute', fn: adminForumMuteById, need: 'admin' },

  // 联机对战：房间与走法中继（五子棋 / 中国象棋 / 国际象棋等共用）
  { m: 'POST', p: '/api/play/create', fn: apiPlayCreate },
  { m: 'POST', p: '/api/play/quick', fn: apiPlayQuick },
  { m: 'POST', p: '/api/play/join', fn: apiPlayJoin },
  { m: 'POST', p: '/api/play/poll', fn: apiPlayPoll },
  { m: 'POST', p: '/api/play/move', fn: apiPlayMove },
  { m: 'POST', p: '/api/play/resign', fn: apiPlayResign },
  { m: 'POST', p: '/api/play/rematch', fn: apiPlayRematch },
  { m: 'POST', p: '/api/play/leave', fn: apiPlayLeave },
  { m: 'POST', p: '/api/play/watch', fn: apiPlayWatch },
  { m: 'GET', p: '/api/replays', fn: apiReplays },
  { m: 'GET', p: '/replays/export.json', fn: apiReplays },
  { m: 'GET', p: '/api/replays/:id', fn: apiReplay },
];

/* ================= SEO 资源 ================= */

function robotsText(origin) {
  return [
    'User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin',
    'Disallow: /login', 'Disallow: /register', 'Disallow: /favorites', 'Disallow: /submit',
    'Disallow: /account', 'Disallow: /forgot', 'Disallow: /reset', 'Disallow: /auth',
    'Disallow: /comments/', 'Disallow: /forum/admin', '',
    'Sitemap: ' + origin + '/sitemap.xml', ''
  ].join('\n');
}

async function sitemapXml(ctx) {
  const urls = [{ loc: '/', pri: '1.0' }, { loc: '/rank', pri: '0.7' },
    { loc: '/forum', pri: '0.5' },
    { loc: '/privacy', pri: '0.3' }, { loc: '/terms', pri: '0.3' },
    { loc: '/notice', pri: '0.6' }, { loc: '/changelog', pri: '0.4' }, { loc: '/nav', pri: '0.5' }];
  for (const c of await data.listCategories(ctx.db)) {
    if (c.total > 0) urls.push({ loc: '/category/' + c.slug, pri: '0.8' });
  }
  for (const g of await data.listGames(ctx.db, { sort: 'new', limit: 100 })) {
    urls.push({ loc: '/game/' + g.slug, pri: '0.9', lm: String(g.created_at).slice(0, 10) });
  }
  /* 公告：只收录已发布的（撤回的前台看不到） */
  for (const p of await data.listPosts(ctx.db, { status: 1, limit: 50 })) {
    urls.push({ loc: '/notice/' + encodeURIComponent(p.slug), pri: '0.6' });
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

/* ================= PWA：manifest / Service Worker =================
 * Worker 里没有磁盘，public/ 下的 manifest.webmanifest 与 sw.js 只能内联一份。
 * 防漂移由 tools/pwa-test.mjs 把关：它比对这里产出的正文与 public/ 下那两个文件（逐字节）。
 */
const PWA_MANIFEST = {
  "name": "趣玩小游戏",
  "short_name": "趣玩小游戏",
  "description": "免费在线小游戏，即点即玩，无需下载。自研小游戏合集，支持手柄操作与联机对战。",
  "lang": "zh-CN",
  "dir": "ltr",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "display_override": [
    "standalone",
    "minimal-ui"
  ],
  "orientation": "any",
  "background_color": "#0b1020",
  "theme_color": "#0b1020",
  "categories": [
    "games",
    "entertainment"
  ],
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icons/apple-touch-icon-180.png",
      "sizes": "180x180",
      "type": "image/png",
      "purpose": "any"
    }
  ],
  "shortcuts": [
    {
      "name": "游戏库",
      "short_name": "游戏库",
      "url": "/games",
      "description": "浏览全部小游戏"
    },
    {
      "name": "每日挑战",
      "short_name": "挑战",
      "url": "/daily",
      "description": "今天的每日挑战"
    }
  ]
};

/* 与 public/sw.js 逐字节一致（模板字符串里只有反斜杠需要转义） */
const PWA_SW = `/* 趣玩小游戏 Service Worker —— 保守策略 + 真离线
 *
 * 目标：宁可少缓存，也绝不把站点变砖；同时保证「断网也能打开并玩 20 款游戏」。
 *  - 任何内部异常都退回浏览器默认行为（不 respondWith），SW 出问题也不影响正常访问。
 *  - 鉴权 / 有副作用的路径（/api/ /auth/ /account /admin /u/ /login …）与非 GET 请求一律直连网络，
 *    不缓存、不回落 —— /api/ 永远 network-only，绝不拿旧数据骗用户。
 *  - install：拉 /precache.json（拉不到退 /static/precache.json，再退下方生成块里的内置清单），
 *    按 urls 逐条预缓存；单条失败只计数、不中断（避开 cache.addAll 的全有或全无语义）。
 *  - 导航：已预缓存的页面（20 款游戏页 + 首页）走 stale-while-revalidate（先给缓存、后台更新），
 *    其余页面保持 network-first；网络失败时依次回落「该页面自己的缓存 → 离线壳 → 内置兜底页」。
 *  - 静态资源（/static/ /games/ /icons/ /cover/ /manifest.webmanifest）：stale-while-revalidate。
 *
 * 两层版本号：
 *  - SW_VERSION 只管「页面 ⇄ SW 的握手协议」，不随内容改（worker/app.js 里的内联副本由
 *    tools/gen-sw.mjs 同步，改这里就得跑一次那个脚本）。
 *  - PRECACHE_VERSION 由 tools/gen-precache.mjs 按资源内容算出；CACHE_TAG = 两者拼接，
 *    缓存名跟着内容走 → 游戏页一更新缓存名就变 → activate 顺手把旧桶删掉。
 *    遇到「改了怎么都不生效」，先确认 sw.js 自身没被 HTTP 缓存：两条线的 /sw.js 都带 no-cache。
 */

/* PRECACHE:BEGIN —— 本块由 tools/gen-precache.mjs 生成，不要手改（跑 node tools/gen-precache.mjs 刷新） */
/* 33 条 · 851.3 KB · 最大单文件 95.8 KB */
const PRECACHE_VERSION = 'p1-95c403f1a492';
const PRECACHE_FALLBACK = [
  '/',
  '/games/2048/index.html',
  '/games/blackhole/index.html',
  '/games/chess/index.html',
  '/games/connect4/index.html',
  '/games/draughts/index.html',
  '/games/gomoku/index.html',
  '/games/idiom/index.html',
  '/games/linkup/index.html',
  '/games/match3/index.html',
  '/games/memory/index.html',
  '/games/minesweeper/index.html',
  '/games/reversi/index.html',
  '/games/snake/index.html',
  '/games/sokoban/index.html',
  '/games/solitaire/index.html',
  '/games/sudoku/index.html',
  '/games/tetris/index.html',
  '/games/tictactoe/index.html',
  '/games/whack/index.html',
  '/games/xiangqi/index.html',
  '/static/js/app-static.js',
  '/static/js/app.js',
  '/static/js/gamepad.js',
  '/static/js/net-play.js',
  '/static/css/style.css',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.webmanifest'
];
/* PRECACHE:END */

const SW_VERSION = 'v1';
const CACHE_TAG = SW_VERSION + '.' + PRECACHE_VERSION;
const SHELL_CACHE = 'qw-shell-' + CACHE_TAG;
const ASSETS_CACHE = 'qw-assets-' + CACHE_TAG;
/* 离线壳的缓存键：带版本号，换版本就等于换键，不会读到上一版壳页 */
const SHELL_KEY = '/?__pwa_offline_shell=' + CACHE_TAG;

/* 永不缓存、永不回落的路径（有副作用或带登录态） */
const NETWORK_ONLY = [
  /^\\/api\\//,
  /^\\/auth\\//,
  /^\\/account/,
  /^\\/admin/,
  /^\\/u\\//,
  /^\\/login/,
  /^\\/register/,
  /^\\/logout/,
  /^\\/forgot/,
  /^\\/reset/,
  /^\\/verify/,
  /^\\/favorites/,
  /^\\/submit/,
  /^\\/ugc/,
  /^\\/comments\\//
];

/* 可以进缓存的静态资源前缀 */
const STATIC_PATHS = [
  /^\\/static\\//,
  /^\\/games\\//,
  /^\\/icons\\//,
  /^\\/cover\\//,
  /^\\/manifest\\.webmanifest$/
];

/* 预缓存清单的候选位置：Express 线两条都能取到，Workers 线走静态资源 */
const PRECACHE_FILES = ['/precache.json', '/static/precache.json'];

/* install 时逐条预缓存的结果，供页面通过 postMessage 查询（测试也用它） */
const PRECACHE_STATUS = { version: PRECACHE_VERSION, total: 0, ok: 0, failed: [], done: false, at: 0 };

/* 已预缓存的页面路径：导航时决定走 cache-first 还是 network-first。
   先用生成块里的内置清单打底（模块每次启动都会求值），install 时再按线上清单补全。 */
const PRECACHED_PATHS = new Set(PRECACHE_FALLBACK.map(function (u) { return String(u).split('?')[0]; }));

/* 兜底离线页：连壳页都没缓存到时候用 */
const OFFLINE_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>趣玩小游戏 · 离线</title>',
  '<style>',
  'html,body{margin:0;height:100%;background:#0b1020;color:#e8ecf8;font:16px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}',
  '.card{max-width:420px;width:100%;background:#151a2e;border:1px solid #2a3352;border-radius:16px;padding:28px;text-align:center}',
  'h1{font-size:20px;margin:0 0 8px}',
  'p{margin:0 0 18px;color:#9aa6c4}',
  'a{display:inline-block;padding:10px 20px;border-radius:10px;background:#4f7cff;color:#fff;text-decoration:none}',
  '</style>',
  '</head>',
  '<body>',
  '<div class="wrap"><div class="card">',
  '<h1>现在处于离线状态</h1>',
  '<p>网络恢复后刷新页面就能继续玩；玩过的游戏在断网时也能直接打开。</p>',
  '<a href="/">重新加载</a>',
  '</div></div>',
  '</body>',
  '</html>'
].join('\\n');

function htmlResponse(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function isHtml(res) {
  try {
    var type = res && res.headers ? res.headers.get('Content-Type') || '' : '';
    return type.indexOf('text/html') === 0;
  } catch (e) {
    return false;
  }
}

/* 清单里的元素可以是字符串，也可以是 { url, revision } */
function normalizeList(data) {
  var raw = (data && data.urls) || [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    var url = typeof item === 'string' ? item : item && item.url;
    if (typeof url !== 'string' || url.charAt(0) !== '/') continue;
    out.push({ url: url, revision: (item && item.revision) || '' });
  }
  return out;
}

/* 线上清单优先，实在拿不到就用 sw.js 里的内置清单 —— 保证 install 永远有活干 */
function loadPrecacheList() {
  var chain = Promise.resolve(null);
  PRECACHE_FILES.forEach(function (file) {
    chain = chain.then(function (found) {
      if (found) return found;
      return fetch(file, { cache: 'no-cache', credentials: 'omit' })
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json().then(function (data) {
            var urls = normalizeList(data);
            if (!urls.length) return null;
            return { version: String(data.version || PRECACHE_VERSION), urls: urls, from: file };
          });
        })
        .catch(function () { return null; });
    });
  });
  return chain.then(function (found) {
    if (found) return found;
    return { version: PRECACHE_VERSION, urls: normalizeList({ urls: PRECACHE_FALLBACK }), from: 'sw.js 内置清单' };
  });
}

/* 逐条预缓存：单条失败只计数（cache.addAll 是全有或全无，这里必须避开） */
function precacheAll() {
  return loadPrecacheList().then(function (list) {
    PRECACHE_STATUS.version = list.version;
    for (var i = 0; i < list.urls.length; i++) {
      PRECACHED_PATHS.add(String(list.urls[i].url).split('?')[0]);
    }
    return caches.open(ASSETS_CACHE).then(function (cache) {
      var ok = 0;
      var failed = [];
      var chain = Promise.resolve();
      list.urls.forEach(function (item) {
        chain = chain.then(function () {
          return fetch(item.url, { credentials: 'omit', cache: 'reload' })
            .then(function (res) {
              if (!res || !res.ok) {
                failed.push(item.url + ' → HTTP ' + (res ? res.status : '?'));
                return null;
              }
              return cache.put(item.url, res).then(function () { ok += 1; });
            })
            .catch(function (err) {
              failed.push(item.url + ' → ' + (err && err.message ? err.message : err));
            });
        });
      });
      return chain.then(function () {
        PRECACHE_STATUS.total = list.urls.length;
        PRECACHE_STATUS.ok = ok;
        PRECACHE_STATUS.failed = failed;
        PRECACHE_STATUS.done = true;
        PRECACHE_STATUS.at = Date.now();
        console.log('[sw] 预缓存 ' + ok + '/' + list.urls.length + ' 条（来源：' + list.from + '，清单版本 ' + list.version + '）');
        if (failed.length) console.warn('[sw] 预缓存失败 ' + failed.length + ' 条：' + failed.join(' | '));
      });
    });
  });
}

/* 抓一次并写缓存；失败返回 null（不抛出） */
function fetchAndCache(cache, request) {
  return fetch(request)
    .then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        return cache.put(request, res.clone()).then(
          function () { return res; },
          function () { return res; }
        );
      }
      return res;
    })
    .catch(function () { return null; });
}

/* stale-while-revalidate 的「更新」那一半：不阻塞返回，失败静默 */
function revalidate(cache, request) {
  fetchAndCache(cache, request).catch(function () { return null; });
}

/* 首页 HTML 只在匿名、同源、无 cookie 的前提下才留作离线壳 */
function rememberShell(request, response) {
  try {
    if (!isHtml(response)) return;
    if (request.headers.get('cookie')) return;
    if (response.type !== 'basic') return;
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.put(SHELL_KEY, response);
    }).catch(function () { });
  } catch (e) { }
}

/* 页面导航：预缓存的页面（游戏页/首页）缓存优先，其余 network-first，断网逐级回落 */
function handleNavigate(request) {
  var pathname = new URL(request.url).pathname;
  return caches.open(ASSETS_CACHE).then(function (cache) {
    var precached = PRECACHED_PATHS.has(pathname);
    var step = precached ? cache.match(request) : Promise.resolve(null);
    return step.then(function (hit) {
      if (hit && isHtml(hit)) {
        revalidate(cache, request);
        return hit;
      }
      return fetch(request)
        .then(function (res) {
          if (res && res.ok && pathname === '/' && !request.headers.get('cookie')) {
            rememberShell(request, res.clone());
          }
          return res;
        })
        .catch(function () {
          /* 断网：先看这个页面自己有没有被预缓存，再落离线壳，最后才是内置兜底页 */
          return cache.match(request, { ignoreSearch: true }).then(function (own) {
            if (own && isHtml(own)) return own;
            return cache.match(pathname, { ignoreSearch: true }).then(function (byPath) {
              if (byPath && isHtml(byPath)) return byPath;
              return caches.match(SHELL_KEY).then(function (shell) {
                return shell || htmlResponse(OFFLINE_HTML, 200);
              });
            });
          });
        });
    });
  });
}

/* 静态资源：stale-while-revalidate；断网且没缓存时给出明确的 504（不伪造 200） */
function handleStatic(request) {
  return caches.open(ASSETS_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) {
        revalidate(cache, request);
        return hit;
      }
      /* 版本号（?v=N）升级后，旧条目与预缓存清单里都是不带 query 的 URL：忽略 query 再找一次，
         这样断网时样式与脚本仍能命中（否则升级一次就会离线掉样式） */
      return cache.match(request, { ignoreSearch: true }).then(function (loose) {
        if (loose) {
          revalidate(cache, request);
          return loose;
        }
        return fetchAndCache(cache, request).then(function (res) {
          if (res) return res;
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      });
    });
  });
}

/* ------------------------------------------------------------------ 安装 / 激活 */

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      /* 1) 内置兜底页先占位：清单一条都拉不到时，离线也不会白屏 */
      try {
        var shell = await caches.open(SHELL_CACHE);
        await shell.put(SHELL_KEY, htmlResponse(OFFLINE_HTML, 200));
      } catch (e) { }

      /* 2) 按清单逐条预缓存（整体异常也不能把 install 拖挂） */
      try {
        await precacheAll();
      } catch (e) {
        console.warn('[sw] 预缓存整体失败：' + (e && e.message ? e.message : e));
      }

      /* 3) 用预缓存下来的首页替换占位兜底页；没有就当场抓一次 */
      try {
        var assets = await caches.open(ASSETS_CACHE);
        var home = await assets.match('/');
        if (!home) {
          var res = await fetch('/', { credentials: 'omit' });
          if (res && res.ok && res.type === 'basic') home = res;
        }
        if (home && isHtml(home)) {
          var shellCache = await caches.open(SHELL_CACHE);
          await shellCache.put(SHELL_KEY, home);
        }
      } catch (e) { }

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      try {
        var names = await caches.keys();
        await Promise.all(
          names.map(function (name) {
            var mine = name.indexOf('qw-shell-') === 0 || name.indexOf('qw-assets-') === 0;
            if (!mine) return null;
            if (name === SHELL_CACHE || name === ASSETS_CACHE) return null;
            /* 旧版本的桶：内容版本一变缓存名就变，这里顺手清掉 */
            return caches.delete(name);
          })
        );
      } catch (e) { }
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------------ 请求拦截 */

self.addEventListener('fetch', function (event) {
  var request = event.request;
  try {
    if (request.method !== 'GET') return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    /* 页面显式要求绕缓存，或带 Range 的请求，一律交给浏览器默认处理 */
    if (request.cache === 'no-store') return;
    if (request.headers.get('range')) return;

    for (var i = 0; i < NETWORK_ONLY.length; i++) {
      if (NETWORK_ONLY[i].test(url.pathname)) return;
    }

    if (request.mode === 'navigate') {
      event.respondWith(handleNavigate(request));
      return;
    }
    for (var j = 0; j < STATIC_PATHS.length; j++) {
      if (STATIC_PATHS[j].test(url.pathname)) {
        event.respondWith(handleStatic(request));
        return;
      }
    }
    /* 清单里点名的零散资源（/favicon.ico、/favicon.svg 之类）也走缓存优先：
       预缓存了却仍在离线时打网络，会白失败一次（浏览器还会自动请求 favicon） */
    if (PRECACHED_PATHS.has(url.pathname)) {
      event.respondWith(handleStatic(request));
      return;
    }
  } catch (e) {
    /* 任何内部异常都退回浏览器默认行为 */
  }
});

/* ------------------------------------------------------------------ 消息通道 */

self.addEventListener('message', function (event) {
  var msg = event.data;
  if (!msg || !event.source || typeof event.source.postMessage !== 'function') return;
  if (msg.type === 'PWA_VERSION') {
    event.source.postMessage({
      type: 'PWA_VERSION',
      version: SW_VERSION,
      precache: PRECACHE_VERSION,
      cache: CACHE_TAG,
      pages: PRECACHED_PATHS.size
    });
  } else if (msg.type === 'PWA_PRECACHE_STATUS') {
    event.source.postMessage({
      type: 'PWA_PRECACHE_STATUS',
      version: PRECACHE_STATUS.version,
      total: PRECACHE_STATUS.total,
      ok: PRECACHE_STATUS.ok,
      failedCount: PRECACHE_STATUS.failed.length,
      failed: PRECACHE_STATUS.failed.slice(0, 8),
      done: PRECACHE_STATUS.done,
      at: PRECACHE_STATUS.at
    });
  } else if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ------------------------------------------------------------------ 主动推送（Web Push） */

/* 服务端用 src/push-core.js 加密后 POST 到订阅端点，这里只负责把 payload 变成系统通知。
   载荷缺失（有些浏览器会给空 push）时也要弹一条兜底通知，否则 Chrome 会按「静默推送」限流。 */
self.addEventListener('push', function (event) {
  var data = null;
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    try { data = { body: event.data.text() }; } catch (e2) { data = null; }
  }
  data = data || {};
  var title = data.title || '趣玩小游戏';
  var options = {
    body: data.body || '有新的通知，点开看看',
    tag: data.tag || 'qw-notice',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    lang: 'zh-CN',
    data: { url: data.url || '/notifications', kind: data.kind || '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* 点通知：同源已有窗口就聚焦并跳过去，没有就开一个。深链由服务端在 pushPayload 里算好。 */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/notifications';
  var url = new URL(target, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin !== self.location.origin) continue;
        if ('navigate' in c) {
          return c.navigate(url).then(function () { return c.focus(); }).catch(function () { return self.clients.openWindow(url); });
        }
        return c.focus().catch(function () { return self.clients.openWindow(url); });
      }
      return self.clients.openWindow(url);
    })
  );
});

`;

/* ================= PWA：图标 ================= */
/* CF 生产线的静态资源来自 dist-cf，而 tools/build-pages.mjs 的产出白名单里没有 icons，Worker 又没有
 * 磁盘可读，所以 4 张图标以 base64 内联在这里 —— 它是 public/icons/*.png 的逐字节副本。
 * 不要手改：`node tools/gen-icons.mjs`（pnpm gen:icons）会重写标记块之间的内容，
 * tools/pwa-test.mjs 会断言两条线发出的字节完全一致，所以漂移会被测出来。 */
/* PWA-ICONS:BEGIN */
const PWA_ICONS = {
  '/icons/icon-192.png':
    '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',
  '/icons/icon-512.png':
    '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',
  '/icons/icon-maskable-512.png':
    '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',
  '/icons/apple-touch-icon-180.png':
    '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'
};
/* PWA-ICONS:END */

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pwaResponse(ctx) {
  const isSw = ctx.pathname === '/sw.js';
  const h = makeHeaders(ctx, {
    type: isSw ? 'application/javascript; charset=utf-8' : 'application/manifest+json; charset=utf-8',
    cache: isSw ? 'no-cache' : 'public, max-age=3600'
  });
  // SW 脚本必须每次回源校验；Service-Worker-Allowed 让 SW 能控制整站
  if (isSw) h.set('service-worker-allowed', '/');
  return new Response(isSw ? PWA_SW : JSON.stringify(PWA_MANIFEST, null, 2) + '\n', { status: 200, headers: h });
}

/* ================= 静态资源 ================= */

const ASSET_CACHE = (pathname) => {
  if (/^\/static\//.test(pathname)) return 'public, max-age=604800';
  if (/^\/games\//.test(pathname)) return 'public, max-age=3600';
  if (pathname === '/precache.json') return 'public, max-age=600';
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

/* ================= 邮件补发（机会式） ================= */

/**
 * 每分钟最多检查一次：把 D1 里到期的信重投。
 * Workers 没有常驻定时器——线上建议配 Cron Trigger 调 mailRetryTick，
 * 没配时就用「有请求顺带跑一次」兜底（同一个 isolate 内不会并发跑两份）。
 * 只投递不改发件箱：走 mail.sendMail 会再入队一条新记录，历史那条永远收不了尾。
 */
let mailTickAt = 0;
let mailTicking = false;

export async function mailRetryTick(ctx) {
  const now = Date.now();
  const tickMs = Number(ctx.env.MAIL_TICK_MS || 60000);
  if (mailTicking || now - mailTickAt < tickMs) return { skipped: 'throttled' };
  mailTickAt = now;
  if (ctx.env.MAIL_TICK === '0') return { skipped: 'off' };
  if (!mail.mailConfigured(ctx.env)) return { skipped: 'unconfigured' };  // 没配传输时 sendMail 早已标 sent

  mailTicking = true;
  let done = 0, failed = 0;
  try {
    for (const row of await outbox.dueList(ctx.db, now, 20)) {
      const r = await mail.deliverNow(ctx.env, { to: row.to_addr, subject: row.subject, text: row.body_text });
      if (r.ok) { await outbox.markSent(ctx.db, row.id); done++; }
      else if (r.error === 'not_configured') break;
      else if (r.error === 'suppressed') { await outbox.markFailed(ctx.env, ctx.db, row.id, r.error, { retry: false }); failed++; }  // 拉黑的地址不再重投
      else { await outbox.markFailed(ctx.env, ctx.db, row.id, r.error); failed++; }
    }
  } catch (err) {
    console.error('[mail:tick-error] ' + (err && err.message));
  } finally {
    mailTicking = false;
  }
  if (done || failed) console.log('[mail:tick] 补发 ' + done + ' 封失败 ' + failed + ' 封');
  return { done, failed };
}

/* ================= 入口 ================= */

export async function appFetch(request, env, execCtx) {
  const started = Date.now();
  if (!env || !env.DB) {
    return new Response('D1 binding "DB" is not configured. See DEPLOY-CLOUDFLARE-D1.md.', {
      status: 503,
      headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS)
    });
  }

  const url = new URL(request.url);
  let pathname = url.pathname;

  // 论坛主机（forum.fishport.cn）根路径挂载：非公共前缀的请求内部改写成 /forum/*
  const reqHost = String(request.headers.get('host') || url.host || '').split(':')[0].toLowerCase();
  const onForumHost = /^forum\./.test(reqHost);
  const FORUM_SHARED = /^\/(static|games|cover|ugc|api|auth|login|register|logout|account|admin|forum|nav|favicon\.ico|robots\.txt|sitemap\.xml|manifest\.webmanifest|sw\.js|icons)(\/|$)/;
  if (onForumHost && !FORUM_SHARED.test(pathname)) {
    pathname = '/forum' + (pathname === '/' ? '' : pathname);
    url.pathname = pathname;
  }

  // 导航页主机（fishport.cn / www.fishport.cn / nav.fishport.cn）：根路径直接给导航页，其余路径照常走站点
  const onPortalHost = PORTAL_HOSTS.test(reqHost);
  if (onPortalHost && pathname === '/') {
    pathname = '/nav';
    url.pathname = pathname;
  }

  const ctx = {
    request: request, env: env, db: env.DB, url: url, pathname: pathname,
    origin: env.SITE_ORIGIN || url.origin,
    user: null,
    cookies: [],
    forumBase: onForumHost ? '' : '/forum'
  };

  let res;
  try {
    // Web Push：把本次请求的 env（VAPID 密钥）注入 social 的通知挂钩（worker/social.js 没别的途径拿 env）
    social.usePushEnv(env);
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

  // 邮件补发：有 waitUntil 就丢后台跑（不拖慢这次响应），本地 dev 没有 ctx 就地 await
  const tick = mailRetryTick(ctx);
  if (execCtx && typeof execCtx.waitUntil === 'function') execCtx.waitUntil(tick);
  else await tick;

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

  // PWA：manifest / Service Worker（正文内联在上面，与 public/ 下文件保持一致）
  if (pathname === '/manifest.webmanifest' || pathname === '/sw.js') return pwaResponse(ctx);

  // PWA：4 张图标（同样是内联常量，见上面的 PWA_ICONS）
  const pwaIcon = PWA_ICONS[pathname];
  if (pwaIcon) {
    return new Response(base64ToBytes(pwaIcon), {
      status: 200,
      headers: makeHeaders(ctx, { type: 'image/png', cache: 'public, max-age=604800' })
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

  /* PWA 真离线：预缓存清单不进内联常量（它随游戏数量变化），交给静态资源层，
     构建时由 tools/gen-precache.mjs 生成、tools/build-pages.mjs 搬进产物目录。 */
  if (pathname === '/precache.json') {
    const asset = await serveAsset(ctx);
    if (asset) return asset;
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
