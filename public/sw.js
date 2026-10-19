/* 趣玩小游戏 Service Worker —— 保守策略
 *
 * 目标：宁可少缓存，也绝不把站点变砖。
 *  - 任何内部异常都退回浏览器默认行为（不 respondWith），服务挂掉也不影响正常访问。
 *  - 鉴权 / 有副作用的路径（/api/ /auth/ /account /admin /u/ /login /register /logout ...）与非 GET 请求一律直连网络，不缓存、不回落。
 *  - 页面导航：network-first；只有网络真的失败时才回落到离线壳。
 *  - 静态资源（/static/ /games/ /icons/ /cover/）：stale-while-revalidate —— 先给缓存、后台更新，下一次刷新必然拿到新版本。
 *    （/cover/ 是站点自己生成的封面 SVG：公开、无鉴权、体积小；不缓存它的话离线壳会满屏破图。）
 *  - manifest.webmanifest 也走同一条缓存：它只是一份清单，离线时少一个必然失败的请求。
 *
 * 版本失效机制：改 SW_VERSION 常量 -> 缓存名整体变化 -> activate 时删掉所有旧版本缓存。
 * 遇到「改了怎么都不生效」，先确认 sw.js 自身没被 HTTP 缓存：两条线的 /sw.js 响应都带 no-cache。
 */
const SW_VERSION = 'v1';
const SHELL_CACHE = 'qw-shell-' + SW_VERSION;
const ASSETS_CACHE = 'qw-assets-' + SW_VERSION;
/* 离线壳缓存键：带查询串的伪 URL，避免与任何真实导航响应共用一条缓存 */
const SHELL_KEY = '/?__pwa_offline_shell=' + SW_VERSION;

/* 只走网络：需鉴权或有副作用 */
const NETWORK_ONLY = [
  /^\/api\//, /^\/auth\//, /^\/account/, /^\/admin/, /^\/u\//,
  /^\/login/, /^\/register/, /^\/logout/, /^\/forgot/, /^\/reset/, /^\/verify/,
  /^\/favorites/, /^\/submit/, /^\/ugc/, /^\/comments\//
];

/* 可 stale-while-revalidate 的静态资源 */
const STATIC_PATHS = [/^\/static\//, /^\/games\//, /^\/icons\//, /^\/cover\//, /^\/manifest\.webmanifest$/];

/* 内置离线兜底页：只在「一次首页都没成功缓存过」时用得到，保持极简、零外部依赖 */
const OFFLINE_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>暂时离线 - 趣玩小游戏</title>' +
  '<style>' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e9edfa;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:24px}' +
  'main{max-width:26em;text-align:center}' +
  'h1{font-size:19px;margin:0 0 10px}' +
  'p{color:#96a0be;margin:0 0 20px}' +
  'a{display:inline-block;padding:10px 20px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;text-decoration:none}' +
  '</style></head><body><main>' +
  '<h1>现在处于离线状态</h1>' +
  '<p>网络恢复后刷新页面就能继续玩。</p>' +
  '<a href="/">重新加载</a>' +
  '</main></body></html>';

function isHtml(res) {
  const ct = (res && res.headers && res.headers.get('content-type')) || '';
  return ct.indexOf('text/html') === 0 || ct.indexOf('text/html') > 0;
}

/* 首页 HTML 作为离线壳：只在「匿名请求」时才记，避免把带登录态的页面写进缓存 */
function rememberShell(req, res) {
  if (req.headers.get('cookie')) return;          // 带 Cookie = 可能有登录态，不进缓存
  const cache = SHELL_CACHE;
  return caches.open(cache).then(function (c) { return c.put(SHELL_KEY, res); }).catch(function () { });
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    try {
      const cache = await caches.open(SHELL_CACHE);
      /* 先用内置兜底页占位：即使没网也能保证离线壳存在 */
      await cache.put(SHELL_KEY, new Response(OFFLINE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }));
      /* 再尝试抓一份真正的首页；credentials:omit 拿的是匿名版，不含任何个人数据 */
      const res = await fetch('/', { credentials: 'omit' });
      if (res && res.ok && res.type === 'basic' && isHtml(res)) await cache.put(SHELL_KEY, res);
    } catch (e) { /* 预热失败不影响安装，兜底页已经就位 */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(function (n) {
        const mine = n.indexOf('qw-shell-') === 0 || n.indexOf('qw-assets-') === 0;
        return mine && n !== SHELL_CACHE && n !== ASSETS_CACHE;
      }).map(function (n) { return caches.delete(n); }));
    } catch (e) { }
    await self.clients.claim();
  })());
});

/* 导航：network-first；网络失败才回落离线壳 */
async function handleNavigate(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic' && isHtml(res) && new URL(req.url).pathname === '/') {
      rememberShell(req, res.clone());
    }
    return res;
  } catch (e) {
    const hit = await caches.match(SHELL_KEY);
    if (hit) return hit;
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }
}

/* 静态资源：stale-while-revalidate */
async function handleStatic(req) {
  const cache = await caches.open(ASSETS_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then(function (res) {
    if (res && res.ok && res.type === 'basic') return cache.put(req, res.clone()).catch(function () { }).then(function () { return res; });
    return res;
  }).catch(function () { return null; });
  if (hit) return hit;                       // 命中：立即返回，更新在后台跑
  const res = await update;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  try {
    if (req.method !== 'GET') return;                       // 非 GET：交给浏览器
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;        // 跨域：一律不碰
    if (req.cache === 'no-store') return;
    if (req.headers.get('range')) return;                   // Range 请求缓存会坏事
    const path = url.pathname;
    for (const re of NETWORK_ONLY) if (re.test(path)) return;

    if (req.mode === 'navigate') { event.respondWith(handleNavigate(req)); return; }
    for (const re of STATIC_PATHS) if (re.test(path)) { event.respondWith(handleStatic(req)); return; }
  } catch (e) { /* 任何异常都退回默认网络行为 */ }
});

self.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg || !event.source || typeof event.source.postMessage !== 'function') return;
  if (msg.type === 'PWA_VERSION') event.source.postMessage({ type: 'PWA_VERSION', version: SW_VERSION });
  else if (msg.type === 'SKIP_WAITING') self.skipWaiting();
});
