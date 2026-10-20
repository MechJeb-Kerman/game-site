/* 趣玩小游戏 Service Worker —— 保守策略 + 真离线
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
  /^\/api\//,
  /^\/auth\//,
  /^\/account/,
  /^\/admin/,
  /^\/u\//,
  /^\/login/,
  /^\/register/,
  /^\/logout/,
  /^\/forgot/,
  /^\/reset/,
  /^\/verify/,
  /^\/favorites/,
  /^\/submit/,
  /^\/ugc/,
  /^\/comments\//
];

/* 可以进缓存的静态资源前缀 */
const STATIC_PATHS = [
  /^\/static\//,
  /^\/games\//,
  /^\/icons\//,
  /^\/cover\//,
  /^\/manifest\.webmanifest$/
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
].join('\n');

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
