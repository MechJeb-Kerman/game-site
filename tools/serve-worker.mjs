/**
 * 本地把 Worker 跑起来：Node http 当壳，worker/app.js 当处理器，node:sqlite 冒充 D1。
 * 用途：本机验证 Workers + D1 完整版（不需要 wrangler / Miniflare / 外网）。
 *
 *   node tools/serve-worker.mjs                 # 默认 http://127.0.0.1:4400，库 data/worker.db
 *   node tools/serve-worker.mjs --reset         # 先删库再来（回到出厂态）
 *   node tools/serve-worker.mjs --port 4401 --db data/t.db
 */
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalD1 } from './d1-local.mjs';
import worker from '../worker/app.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm'
};

/** 极简的 Static Assets 假实现：读 dist-cf 目录，找不到回 404.html */
export async function assetsFetch(out, request) {
  const url = new URL(request.url);
  let rel = '';
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { rel = ''; }
  if (rel.indexOf('..') >= 0) return new Response('bad path', { status: 400 });
  const base = join(out, rel);
  const tries = rel === '' || rel.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, base + '.html', join(base, 'index.html')];

  for (const f of tries) {
    try {
      const buf = await readFile(f);
      return new Response(buf, {
        status: 200,
        headers: { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream' }
      });
    } catch { /* 试下一个候选 */ }
  }
  try {
    const buf = await readFile(join(out, '404.html'));
    return new Response(buf, { status: 404, headers: { 'content-type': TYPES['.html'] } });
  } catch {
    return new Response('not found', { status: 404, headers: { 'content-type': TYPES['.txt'] } });
  }
}

const SKIP_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade'];

/** 起一个本地 Worker 服务器；port 传 0 让系统随便挑一个空闲端口 */
export async function createWorkerServer(opts) {
  const o = opts || {};
  const out = resolve(o.out || join(ROOT, 'dist-cf'));
  const dbFile = resolve(o.db || join(ROOT, 'data', 'worker.db'));
  const d1 = new LocalD1(dbFile);
  const env = {
    DB: d1,
    ASSETS: { fetch: (req) => assetsFetch(out, req) },
    ADMIN_USER: o.adminUser,
    ADMIN_PASS: o.adminPass,
    SITE_ORIGIN: o.origin,
    // 本机验证用：开放 dev 演示登录（Workers 里没有 NODE_ENV，只能靠这个开关）
    OAUTH_DEV: o.oauthDev === undefined ? '1' : String(o.oauthDev),
    COOKIE_DOMAIN: o.cookieDomain === undefined ? process.env.COOKIE_DOMAIN : o.cookieDomain
  };
  // 允许调用方塞任意 env（端到端测试要灌假的邮件服务 / OAuth 端点地址）
  Object.assign(env, o.env || {});

  const server = http.createServer(async (req, res) => {
    try {
      const headers = {};
      for (const k of Object.keys(req.headers)) {
        if (SKIP_HEADERS.indexOf(k) < 0) headers[k] = req.headers[k];
      }
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (chunks.length) body = Buffer.concat(chunks);
      }
      // 用请求里的 Host 拼 URL：Workers 的 url.host 就是公开域名，本地这样才测得到 forum.fishport.cn 根路径挂载
      const url = 'http://' + (req.headers.host || ('127.0.0.1:' + server.address().port)) + req.url;
      const request = new Request(url, { method: req.method, headers: headers, body: body });
      const r = await worker.fetch(request, env);

      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const pair of r.headers.entries()) {
        if (pair[0].toLowerCase() === 'set-cookie') continue;
        res.setHeader(pair[0], pair[1]);
      }
      if (setCookies.length) res.setHeader('set-cookie', setCookies);
      res.writeHead(r.status);
      if (req.method === 'HEAD' || r.status === 204 || r.status === 304) return res.end();
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      console.error('[serve-worker]', err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  });

  await new Promise((r) => server.listen(o.port === undefined ? 4400 : o.port, '127.0.0.1', r));
  const address = server.address();
  return {
    server: server,
    port: address.port,
    db: d1,
    dbFile: dbFile,
    out: out,
    /** 预热一次首页：触发建表 / 灌种子 / 建管理员，和 Express 版启动时做的事一致 */
    async warmup() {
      // 先把自举错误原样抛出来：appFetch 会把它转成 500，调用方只看得到
      // 一句「no such table: games」，根本不知道 DDL 为什么没跑成。
      const { ensureReady } = await import('../worker/schema.js');
      await ensureReady(env);
      const r = await worker.fetch(new Request('http://127.0.0.1:' + address.port + '/'), env);
      let n = null;
      try {
        n = await d1.prepare('SELECT COUNT(*) AS n FROM games').first();
      } catch (e) {
        const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
          .then((x) => ((x && x.results) || []).map((t) => t.name).join(','))
          .catch(() => '(查询失败)');
        throw new Error('worker 自举后仍没有 games 表（' + e.message + '）；现有表：' + (tables || '(空)'));
      }
      return { status: r.status, games: n ? n.n : 0 };
    },
    close() { return new Promise((r) => server.close(r)); }
  };
}

function runCli() {
  const argv = process.argv.slice(2);
  const arg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const port = Number(arg('--port', '4400'));
  const out = arg('--out', join(ROOT, 'dist-cf'));
  const db = arg('--db', join(ROOT, 'data', 'worker.db'));

  (async () => {
    if (argv.indexOf('--reset') >= 0) {
      await rm(db, { force: true });
      await rm(db + '-wal', { force: true });
      await rm(db + '-shm', { force: true });
      console.log('🧹 已删除 ' + db);
    }
    const s = await createWorkerServer({ port: port, out: out, db: db });
    const warm = await s.warmup();
    console.log('');
    console.log('  🎮  Worker(D1) 本地版已启动');
    console.log('  ➜  http://127.0.0.1:' + s.port);
    console.log('  🗄️  D1 假实现: ' + s.dbFile);
    console.log('  📦  静态资源: ' + s.out);
    console.log('  ' + (warm.status === 200 ? '✅' : '⚠️ ') + ' 预热首页 HTTP ' + warm.status + ' · 游戏 ' + warm.games + ' 款');
    console.log('  ⚠️  管理员默认 admin / admin123，可用 ADMIN_USER / ADMIN_PASS 覆盖');
    console.log('');
  })().catch((e) => { console.error(e); process.exit(1); });
}

if (process.argv[1] && process.argv[1].endsWith('serve-worker.mjs')) runCli();
