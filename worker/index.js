/**
 * Cloudflare Workers 版（Workers + Static Assets）。
 *
 * 静态站点在 dist-cf/（由 node tools/build-pages.mjs --cf --base=/ --out=dist-cf 生成），
 * 通过 wrangler.toml 的 [assets] 绑定成 env.ASSETS。这个 Worker 负责：
 *
 *   1. 注入安全响应头（Workers 不支持 Pages 的 _headers 文件，只能写在代码里）
 *   2. 按路径分级缓存：/static/* 7 天、/cover/* 1 天、/games/* 1 小时、HTML 不缓存
 *   3. 干净地址：/games -> /games.html、/game/2048 -> /game/2048.html、/category/puzzle -> ...
 *   4. 404 回 404.html 并加 noindex；/favicon.ico 302 到 /favicon.svg
 *   5. 非 GET / HEAD 一律 405（静态站没有服务端接口）
 *
 * 注意：wrangler.toml 里的 html_handling 必须是 "none"。Worker 是显式去取 /xxx.html
 * 的，如果资源层开着 auto-trailing-slash 之类，它会把 /xxx.html 308 回 /xxx，
 * 原样透传就成了浏览器无限重定向。
 *
 * 部署：npx wrangler deploy            本地自测：node tools/worker-test.mjs
 */
import { PORTAL_HOSTS } from '../src/sites.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  /* frame-src 放行 http(s)：投稿允许填任意外站地址，外站游戏靠 iframe 载入 */
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' https: http:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

/** 路径前缀 -> Cache-Control */
const CACHE_RULES = [
  [/^\/static\//, 'public, max-age=604800'],
  [/^\/cover\//, 'public, max-age=86400'],
  [/^\/games\//, 'public, max-age=3600']
];

const HTML_CACHE = 'public, max-age=0, must-revalidate';
const ASSET_CACHE = 'public, max-age=3600';

/** 规整路径：折叠重复斜杠、去掉 . 与 ..，保留结尾斜杠的语义 */
export function normalizePath(pathname) {
  const raw = String(pathname || '/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const trailing = raw.length > 1 && raw.endsWith('/') ? '/' : '';
  return '/' + out.join('/') + trailing;
}

/** 依次尝试的候选路径：原样（目录补 index.html）-> 加 .html -> 加 /index.html */
export function candidates(pathname) {
  const p = normalizePath(pathname);
  if (p === '/') return ['/index.html'];
  if (p.endsWith('/')) {
    const stem = p.slice(0, -1);
    return [p + 'index.html', stem + '.html', stem + '/index.html'];
  }
  return [p, p + '.html', p + '/index.html'];
}

/** 按路径与内容类型决定缓存策略 */
export function cacheFor(pathname, contentType) {
  for (const rule of CACHE_RULES) if (rule[0].test(pathname)) return rule[1];
  if (/\.html?$/.test(pathname)) return HTML_CACHE;
  if (String(contentType || '').indexOf('text/html') === 0) return HTML_CACHE;
  return ASSET_CACHE;
}

/** 把安全头与缓存头贴到响应上（304 / 204 / HEAD 不能带 body） */
function decorate(res, request, pathname) {
  const headers = new Headers(res.headers);
  for (const k of Object.keys(SECURITY_HEADERS)) headers.set(k, SECURITY_HEADERS[k]);
  const is404 = res.status === 404;
  headers.set('Cache-Control', is404 ? 'no-store' : cacheFor(pathname, res.headers.get('Content-Type')));
  if (is404) headers.set('X-Robots-Tag', 'noindex');
  const bodyless = request.method === 'HEAD' || res.status === 304 || res.status === 204;
  return new Response(bodyless ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

function assetRequest(request, target) {
  const url = new URL(request.url);
  url.pathname = target;
  return new Request(url.toString(), request);
}

export default {
  async fetch(request, env) {
    const method = request.method.toUpperCase();
    const incoming = new URL(request.url);

    if (method !== 'GET' && method !== 'HEAD') {
      const headers = new Headers(SECURITY_HEADERS);
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      headers.set('Allow', 'GET, HEAD');
      headers.set('Cache-Control', 'no-store');
      return new Response('静态演示站只接受 GET / HEAD。带账号的完整版请看 README。\n', { status: 405, headers });
    }

    if (incoming.pathname === '/favicon.ico') {
      const headers = new Headers(SECURITY_HEADERS);
      headers.set('Location', '/favicon.svg');
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(null, { status: 302, headers });
    }

    const pathname = normalizePath(incoming.pathname);
    /* 门户主机（fishport.cn / www / nav）的根路径给导航页：静态线也要有，
       否则把 apex 加到静态版 Worker 上会看到游戏首页而不是门户 */
    const reqHost = String(incoming.host || '').split(':')[0].toLowerCase();
    const portalRoot = PORTAL_HOSTS.test(reqHost) && pathname === '/';
    const tries = candidates(portalRoot ? '/nav' : pathname);
    // 跳转也算未命中：资源层不该发跳转（html_handling = "none"），
    // 万一配置被改回去，宁可给 404，也不要把浏览器拖进重定向死循环。
    const isMiss = (r) => r.status === 404 || (r.status >= 300 && r.status < 400);
    let res = null;
    for (let i = 0; i < tries.length; i++) {
      const hit = await env.ASSETS.fetch(assetRequest(request, tries[i]));
      if (!isMiss(hit)) { res = hit; break; }
      if (hit.status === 404 && !res) res = hit;
    }
    if (!res) {
      const home = await env.ASSETS.fetch(assetRequest(request, '/index.html'));
      res = isMiss(home)
        ? new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        : home;
    }
    return decorate(res, request, pathname);
  }
};
