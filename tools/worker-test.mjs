/**
 * 在没有 wrangler、没有外网的情况下验证 worker/index.js 的行为。
 *
 *   node tools/worker-test.mjs [--out=dist-cf]
 *
 * 做法：造一个假的 env.ASSETS（直接读磁盘，行为对齐 Cloudflare 的
 * html_handling="none" / not_found_handling="404-page"），并先读 wrangler*.toml 确认 html_handling 还是 none
 * 把请求交给真正的 Worker fetch handler，然后断言状态码、响应头、正文，
 * 最后把主要页面的所有站内链接爬一遍确认没有断链。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker, * as W from '../worker/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ORIGIN = 'https://game-site.example.workers.dev';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function opt(name, fallback) {
  const hit = process.argv.find(function (a) { return a === '--' + name || a.startsWith('--' + name + '='); });
  if (!hit) return fallback;
  const i = hit.indexOf('=');
  return i < 0 ? '' : hit.slice(i + 1);
}

const OUT = path.resolve(opt('out', path.join(ROOT, 'dist-cf')));

/**
 * 资源层的 html_handling 必须是 none。
 * 如果是 auto-trailing-slash 之类，Cloudflare 会把 .html 路径 308 回去
 * （/index.html -> /、/games.html -> /games），而 Worker 正是显式去取 .html 的，
 * 原样透传就成了浏览器无限重定向（ERR_TOO_MANY_REDIRECTS）。
 */
function htmlHandlingProblems() {
  const bad = [];
  for (const name of ['wrangler.toml', 'wrangler.d1.toml']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const m = /html_handling\s*=\s*"([^"]*)"/.exec(fs.readFileSync(file, 'utf8'));
    if (!m) bad.push(name + '：没有写 html_handling（默认的 auto-trailing-slash 会引发重定向循环），应显式写 "none"');
    else if (m[1] !== 'none') bad.push(name + '：html_handling = "' + m[1] + '"，必须是 "none"');
  }
  return bad;
}

/** 假的 env.ASSETS：行为对齐 Cloudflare 的静态资源服务 */
function createAssets(dir) {
  const base = path.resolve(dir);
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel;
      try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = url.pathname; }
      rel = rel.replace(/^\/+/, '');
      if (rel === '') rel = 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(base, rel);
      if (file !== base && !file.startsWith(base + path.sep)) {
        return new Response('forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const buf = fs.readFileSync(file);
        const st = fs.statSync(file);
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            ETag: '"' + buf.length.toString(16) + '-' + st.mtimeMs.toString(16) + '"'
          }
        });
      }
      const nf = path.join(base, '404.html');
      if (fs.existsSync(nf)) {
        return new Response(fs.readFileSync(nf), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  };
}

const env = { ASSETS: createAssets(OUT) };
const call = function (p, opts) { return worker.fetch(new Request(ORIGIN + p, opts), env); };

let pass = 0;
const fails = [];
async function t(name, fn) {
  try {
    const extra = await fn();
    pass++;
    console.log('  ok   ' + name + (extra ? '  ' + extra : ''));
  } catch (e) {
    fails.push(name);
    console.log('  FAIL ' + name + '  -> ' + (e && e.message));
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error((what || '值') + ' 应为 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function has(text, needle, what) {
  if (String(text).indexOf(needle) < 0) throw new Error((what || '正文') + ' 应包含 ' + JSON.stringify(needle));
}

const CSP = [
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
].join('; ');

async function main() {
  if (!fs.existsSync(path.join(OUT, 'index.html'))) {
    console.error('没找到 ' + path.join(OUT, 'index.html') + '，先跑：node tools/build-pages.mjs --cf --base=/ --out=dist-cf');
    process.exit(1);
  }
  const badCfg = htmlHandlingProblems();
  if (badCfg.length) {
    console.error('wrangler 配置会让线上陷入重定向循环（ERR_TOO_MANY_REDIRECTS），先改回来：');
    badCfg.forEach(function (b) { console.error('  ' + b); });
    process.exit(1);
  }
  console.log('Worker 自测   产物 ' + OUT + '   主机 ' + ORIGIN);

  await t('GET / 返回 200 HTML 且带全套安全头', async function () {
    const r = await call('/');
    eq(r.status, 200, '状态码');
    has(r.headers.get('content-type'), 'text/html');
    eq(r.headers.get('content-security-policy'), CSP, 'CSP');
    eq(r.headers.get('x-content-type-options'), 'nosniff');
    eq(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    eq(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    eq(r.headers.get('permissions-policy'), 'geolocation=(), microphone=(), camera=()');
    eq(r.headers.get('cache-control'), 'public, max-age=0, must-revalidate', 'HTML 缓存');
    const html = await r.text();
    has(html, '<title>');
    return 'CSP 与 server.js 完全一致';
  });

  await t('dist-cf/_headers 的 CSP 与代码一致（frame-src 放行外站）', async function () {
    const headers = fs.readFileSync(path.join(OUT, '_headers'), 'utf8');
    has(headers, 'Content-Security-Policy: ' + CSP, 'Pages 安全头');
    return 'Pages 静态导出线的 _headers 已同步';
  });

  await t('GET /index.html 与 / 等价', async function () {
    const r = await call('/index.html');
    eq(r.status, 200);
    eq(r.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  });

  await t('干净地址 /games -> /games.html', async function () {
    const r = await call('/games');
    eq(r.status, 200);
    eq(r.headers.get('content-type'), 'text/html; charset=utf-8', '内容类型');
    has(await r.text(), '全部游戏');
  });
  await t('真文件名 /games.html 也能开', async function () {
    eq((await call('/games.html')).status, 200);
  });
  await t('多一个斜杠 /games/ 仍然 200', async function () {
    eq((await call('/games/')).status, 200);
  });
  await t('//games// 这种重复斜杠被归一', async function () {
    eq((await call('//games//')).status, 200);
  });
  await t('/game/2048 与 /game/2048.html 都是 200', async function () {
    const a = await call('/game/2048');
    const b = await call('/game/2048.html');
    eq(a.status, 200);
    eq(b.status, 200);
    has(await a.text(), '2048');
  });
  await t('/category/puzzle 与 /tag/<中文> 都是 200', async function () {
    eq((await call('/category/puzzle')).status, 200);
    eq((await call('/tag/' + encodeURIComponent('益智'))).status, 200);
  });
  await t('/search?q=... 带查询串照常返回', async function () {
    const r = await call('/search?q=' + encodeURIComponent('方块'));
    eq(r.status, 200);
    eq(r.headers.get('cache-control'), 'public, max-age=0, must-revalidate', 'HTML 缓存');
  });

  await t('/static/* 缓存 7 天', async function () {
    const r = await call('/static/css/style.css');
    eq(r.status, 200);
    has(r.headers.get('content-type'), 'text/css');
    eq(r.headers.get('cache-control'), 'public, max-age=604800');
  });
  await t('/cover/* 缓存 1 天', async function () {
    const r = await call('/cover/2048.svg');
    eq(r.status, 200);
    has(r.headers.get('content-type'), 'image/svg+xml');
    eq(r.headers.get('cache-control'), 'public, max-age=86400');
  });
  await t('/games/* 缓存 1 小时', async function () {
    const r = await call('/games/2048/index.html');
    eq(r.status, 200);
    eq(r.headers.get('cache-control'), 'public, max-age=3600');
  });
  await t('/favicon.ico 302 到 /favicon.svg', async function () {
    const r = await call('/favicon.ico', { redirect: 'manual' });
    eq(r.status, 302);
    eq(r.headers.get('location'), '/favicon.svg');
    eq((await call('/favicon.svg')).status, 200);
  });
  await t('/robots.txt 与 /sitemap.xml 正常返回', async function () {
    const rb = await call('/robots.txt');
    eq(rb.status, 200);
    has(rb.headers.get('content-type'), 'text/plain');
    has(await rb.text(), 'Sitemap');
    eq((await call('/sitemap.xml')).status, 200);
  });

  await t('/sitemap.xml 收录 /nav', async function () {
    has(await (await call('/sitemap.xml')).text(), '/nav');
  });

  await t('门户主机（fishport.cn / www / nav）的根路径给导航页，其它子域给首页', async function () {
    for (const host of ['fishport.cn', 'www.fishport.cn', 'nav.fishport.cn']) {
      const r = await worker.fetch(new Request('https://' + host + '/'), env);
      eq(r.status, 200, host + ' 根路径状态码');
      has(await r.text(), 'fishport.cn 导航', host + ' 根路径应当是导航页');
    }
    const home = await worker.fetch(new Request(ORIGIN + '/'), env);
    has(await home.text(), '趣玩小游戏', '游戏站主机的首页被门户盖掉了');
    eq((await call('/nav')).status, 200, '/nav 在任何主机都能开');
  });

  await t('不存在的地址返回 404 页面 + noindex', async function () {
    const r = await call('/nope');
    eq(r.status, 404, '状态码');
    eq(r.headers.get('x-robots-tag'), 'noindex');
    eq(r.headers.get('cache-control'), 'no-store');
    eq(r.headers.get('x-content-type-options'), 'nosniff', '404 也要有安全头');
    has(await r.text(), 'html');
    eq((await call('/game/不存在的游戏')).status, 404);
  });
  await t('路径穿越 /../ 不会跑出产物目录', async function () {
    const r = await call('/../../etc/passwd');
    ok(r.status === 404 || r.status === 403, ' 期望 404/403，实际 ' + r.status);
    eq((await call('/game/../games')).status, 200, '/game/../games 归一成 /games 后应 200');
  });
  await t('HEAD / 返回 200 且没有正文', async function () {
    const r = await call('/', { method: 'HEAD' });
    eq(r.status, 200);
    eq((await r.text()).length, 0, '正文长度');
  });
  await t('POST 返回 405 且带 Allow', async function () {
    const r = await call('/', { method: 'POST', body: 'a=1' });
    eq(r.status, 405);
    eq(r.headers.get('allow'), 'GET, HEAD');
    eq(r.headers.get('cache-control'), 'no-store');
  });

  await t('纯函数：normalizePath', function () {
    eq(W.normalizePath('//a///b/../c/'), '/a/c/');
    eq(W.normalizePath('/'), '/');
    eq(W.normalizePath('/games'), '/games');
  });
  await t('纯函数：candidates', function () {
    eq(W.candidates('/game/2048').join(','), '/game/2048,/game/2048.html,/game/2048/index.html');
    eq(W.candidates('/games/').join(','), '/games/index.html,/games.html,/games/index.html');
    eq(W.candidates('/').join(','), '/index.html');
  });
  await t('纯函数：cacheFor', function () {
    eq(W.cacheFor('/static/js/app.js', 'text/javascript'), 'public, max-age=604800');
    eq(W.cacheFor('/cover/x.svg', 'image/svg+xml'), 'public, max-age=86400');
    eq(W.cacheFor('/games/2048/index.html', 'text/html; charset=utf-8'), 'public, max-age=3600');
    eq(W.cacheFor('/games.html', 'text/html; charset=utf-8'), 'public, max-age=0, must-revalidate');
    eq(W.cacheFor('/sitemap.xml', 'application/xml'), 'public, max-age=3600');
  });

  // ---- 静态路径一个跳转都不该有（有就是 html_handling 配错了/代码被改坏了）----
  await t('静态路径不产生任何跳转', async function () {
    const list = ['/', '/index.html', '/games', '/games.html', '/games/', '/game/2048', '/game/2048.html',
      '/category/puzzle', '/category/puzzle/', '/tag/' + encodeURIComponent('益智'), '/static/css/style.css'];
    const bad = [];
    for (const p of list) {
      const r = await call(p);
      if (r.status >= 300 && r.status < 400) bad.push(p + ' -> ' + r.status + ' ' + (r.headers.get('location') || ''));
    }
    ok(!bad.length, '资源层发出了跳转，线上会 ERR_TOO_MANY_REDIRECTS：' + bad.join('；'));
  });

  // ---- 站内链接全量爬一遍 ----
  const pages = ['/', '/games', '/search?q=' + encodeURIComponent('方块'), '/category/puzzle',
    '/tag/' + encodeURIComponent('益智'), '/game/2048', '/game/tetris', '/notice', '/changelog', '/404'];
  const linkRe = /(?:href|src)\s*=\s*"([^"]*)"/g;
  const seen = new Set();
  const broken = [];
  let crawled = 0;
  for (const page of pages) {
    const res = await call(page);
    ok(res.status === 200 || res.status === 404, page + ' 本身应可访问');
    const html = await res.text();
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(html))) {
      const href = m[1].trim();
      if (!href || href.startsWith('#') || href.startsWith('data:') || href.startsWith('mailto:')) continue;
      if (/^[a-z]+:\/\//i.test(href)) continue;
      let target;
      try { target = new URL(href, ORIGIN + page); } catch (e) { broken.push(page + ' -> ' + href + '（解析失败）'); continue; }
      const key = target.pathname + target.search;
      if (seen.has(key)) continue;
      seen.add(key);
      const r2 = await call(key);
      crawled++;
      if (r2.status !== 200) broken.push(page + ' -> ' + key + ' (' + r2.status + ')');
    }
  }
  await t('站内链接全部可访问（' + crawled + ' 条）', function () {
    if (broken.length) throw new Error('断链：\n    ' + broken.slice(0, 10).join('\n    '));
    ok(crawled > 50, '爬到的链接太少（' + crawled + '），可能页面没渲染');
  });

  console.log('');
  if (fails.length) {
    console.log('worker 冒烟：' + pass + ' 项通过，' + fails.length + ' 项失败');
    fails.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('worker 冒烟：' + pass + ' 项断言全部通过');
}

main().catch(function (e) { console.error(e); process.exit(1); });
