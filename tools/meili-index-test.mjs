#!/usr/bin/env node
// tools/meili-index-test.mjs —— tools/meili-index.mjs 的自测（零依赖，只用 node: 内置模块）。
//
// 骨架照 tools/search-fallback-test.mjs / tools/adapters-test.mjs：
//   · 自起一个假 Meilisearch（node:http），只记请求、只回固定 JSON；
//   · 只 spawn 自己起的进程，退出码非 0 直接判失败；
//   · 端口从 31xx 私有段取空闲口，绝不碰 :3000 / :4400；
//   · 结尾打印「通过 N 项 / 失败 M 项」并按失败数退出。
//
// 跑法：node tools/meili-index-test.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'tools', 'meili-index.mjs');
const TMP = join(ROOT, 'data', '.tmp-meili-index-test');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); } else {
    fail++;
    console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
};
const is = (name, got, want) => ok(name, got === want, { got, want });

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const TP = String.fromCharCode(96);

/** 探活后再 bind：Windows 上别人绑了 :: 时只 bind 127.0.0.1 也会成功，必须两步 */
function portFree(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); res(false); });
    s.on('error', () => {
      const srv = createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(port, '127.0.0.1');
    });
  });
}

async function freePort(...candidates) {
  for (const p of candidates) if (await portFree(p)) return p;
  throw new Error('没有空闲端口：' + candidates.join(','));
}

/**
 * 假 Meilisearch：记下所有请求，并按 mode 回响应。
 *   ok     —— 202 + { taskUid }（真 Meili 推文档/改设置都是 202 受理）
 *   error  —— 500 + { message }
 *   notfound —— 404 + { message }
 *   hang   —— 收下请求但不回复（用来验超时）
 */
function makeFakeMeili(port) {
  let reqs = [];
  let mode = 'ok';
  let taskUid = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, body: null, mode };
      try { entry.body = raw ? JSON.parse(raw) : null; } catch { entry.body = null; }
      reqs.push(entry);
      if (mode === 'hang') return;
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: '内部错误：磁盘满了', code: 'internal' }));
        return;
      }
      if (mode === 'notfound') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Index ' + TP + 'games' + TP + ' not found', code: 'index_not_found' }));
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ taskUid: ++taskUid, indexUid: 'games', status: 'enqueued', type: 'documentAdditionOrUpdate' }));
    });
  });
  return {
    server,
    reqs: () => reqs,
    clear: () => { reqs.length = 0; }, // 原地清空：闭包里捕获的是同一个数组
    get mode() { return mode; },
    set mode(v) { mode = v; },
    docs: () => reqs.filter((r) => r.url.includes('/documents')).flatMap((r) => (Array.isArray(r.body) ? r.body : [])),
    indexReqs: () => reqs.filter((r) => r.url.includes('/documents')),
    settingsReqs: () => reqs.filter((r) => r.url.endsWith('/settings')),
    indexOf: (r) => reqs.indexOf(r),
    lastSettings: () => { const r = reqs.find((x) => x.url.endsWith('/settings')); return r ? r.body : null; },
    listen: () => new Promise((res, rej) => server.listen(port, '127.0.0.1', res).once('error', rej)),
    close: () => new Promise((res) => server.close(res)),
  };
}

function runCli(args, env = {}, { timeoutMs = 25_000 } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const clean = (s) => s.split(/\r?\n/).filter((l) => !/ExperimentalWarning|--trace-warnings|node:sqlite/i.test(l)).join('\n');
      res({ code, out: clean(out), err: clean(err) });
    });
  });
}

/** 期望成功的 spawn：非 0 退出直接抛 */
function result(r, label) {
  if (r.code !== 0) throw new Error(label + ' 退出码 ' + r.code + '\nstdout: ' + r.out + '\nstderr: ' + r.err);
  return r;
}
const dryJson = (r) => {
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('DRY_RUN_JSON '));
  return line ? JSON.parse(line.slice('DRY_RUN_JSON '.length)) : null;
};

// ------------------------------------------------------------------ 固定测试库
/** 5 款游戏：id 递增、tags 是 JSON 数组字符串（与真库一致）、含 search_pinyin */
const FIXTURE = [
  ['2048', '2048', '合并数字', 'puzzle', ['数字', '合成'], 'erlingsiba hebing', 1],
  ['snake', '贪吃蛇', '越吃越长', 'action', ['经典'], 'tanchishe tcs', 2],
  ['memory', '记忆翻牌', '找出相同的图案', 'puzzle', ['记忆'], 'jiyifanpai jyfp', 3],
  ['whack', '打地鼠', '30 秒手速挑战', 'action', ['反应', '手速'], 'dadishu dds', 4],
  ['tetris', '俄罗斯方块', '消行不停', 'casual', ['经典', '消除'], 'eluosifangkuai elsfk', 5],
];

function makeFixtureDb(dbPath) {
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(String.raw`CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, icon TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, subtitle TEXT,
  description TEXT, category_id INTEGER, engine TEXT, game_url TEXT NOT NULL, width INTEGER, height INTEGER,
  orientation TEXT, tags TEXT, emoji TEXT, accent TEXT, accent2 TEXT, plays INTEGER DEFAULT 0,
  rating REAL DEFAULT 0, rating_count INTEGER DEFAULT 0, license TEXT, status INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0, submitted_by TEXT, search_pinyin TEXT);`);
  const cats = ['puzzle', 'action', 'casual', 'board'];
  cats.forEach((slug, i) => db.prepare('INSERT INTO categories (slug,name,icon,sort) VALUES (?,?,?,?)').run(slug, slug, 'x', i + 1));
  const ins = db.prepare('INSERT INTO games (slug,title,subtitle,description,category_id,game_url,tags,status,created_at,search_pinyin) VALUES (?,?,?,?,?,?,?,1,?,?)');
  for (const [slug, title, subtitle, cat, tags, py, day] of FIXTURE) {
    ins.run(slug, title, subtitle, '描述 ' + title, cats.indexOf(cat) + 1, '/games/' + slug + '/index.html', JSON.stringify(tags), day, py);
  }
  db.prepare('INSERT INTO games (slug,title,game_url,tags,status,created_at) VALUES (?,?,?,?,0,?)').run('retired', '已下架', '/games/retired/index.html', '[]', 99);
  db.prepare('INSERT INTO games (slug,title,game_url,tags,status,created_at) VALUES (?,?,?,?,2,?)').run('pending', '待审', '/games/pending/index.html', '[]', 100);
  db.close();
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const dbPath = join(TMP, 'fixture.db');
  makeFixtureDb(dbPath);
  ok('测试库已生成（5 款上架 + 1 下架 + 1 待审）', existsSync(dbPath));

  const port = await freePort(3160, 3161, 3162);
  const base = 'http://127.0.0.1:' + port;
  const fake = makeFakeMeili(port);
  await fake.listen();
  ok('假 Meilisearch 已在 ' + base + ' 起来', true);

  try {
    // ---------------------------------------------------------- --help / 参数
    {
      const r = await runCli(['--help']);
      is('--help 退出码 0', r.code, 0);
      ok('--help 有用法说明', r.out.includes('用法') && r.out.includes('--dry-run') && r.out.includes('--batch'));
    }
    {
      const r = await runCli(['--help', '--dry-run']);
      is('--help 与其它选项同时给时仍退出 0', r.code, 0);
    }
    {
      const r = await runCli(['--batch=abc', '--host=' + base]);
      is('--batch 非数字 → 非零退出', r.code === 0 ? 0 : 1, 1);
      ok('--batch 非数字有可读错误', r.err.includes('--batch'), r.err);
    }
    {
      const r = await runCli(['--nope', '--host=' + base]);
      is('未知选项 → 非零退出', r.code === 0 ? 0 : 1, 1);
      ok('未知选项提示可读', r.err.includes('无法识别') || r.err.includes('--nope'), r.err);
    }

    // ---------------------------------------------------------- --dry-run
    {
      fake.clear();
      const r = result(await runCli(['--dry-run', '--db=' + dbPath, '--host=' + base]), '--dry-run');
      is('--dry-run：假服务端收到 0 个请求（硬指标）', fake.reqs().length, 0);
      const j = dryJson(r);
      ok('--dry-run 打印 DRY_RUN_JSON', !!j, r.out.slice(-200));
      if (j) {
        is('--dry-run 文档数 = 库里上架数 5（下架/待审不算）', j.count, 5);
        is('--dry-run 分批数 = 1（batch 默认 100）', j.batches, 1);
        is('--dry-run batch = 100', j.batch, 100);
        is('--dry-run sample[0].slug', j.sample && j.sample[0] && j.sample[0].slug, '2048');
      }
      ok('--dry-run 输出含 primaryKey=slug 请求形态', r.out.includes('?primaryKey=slug'));
      ok('--dry-run 输出不出现真实推送行', !/推送 5 条 → ok/.test(r.out));
    }
    {
      fake.clear();
      const r = result(await runCli(['--dry-run', '--db=' + dbPath, '--batch=2', '--host=' + base]), '--dry-run --batch=2');
      const j = dryJson(r);
      is('--dry-run 分批数随 --batch 变（5 条 / batch=2 → 3 批）', j && j.batches, 3);
      is('--dry-run 仍不发请求', fake.reqs().length, 0);
    }

    // ---------------------------------------------------------- 真推：请求形态
    {
      fake.clear();
      const r = result(await runCli(['--db=' + dbPath, '--host=' + base, '--batch=2']), '推送 batch=2');
      const reqs = fake.indexReqs();
      is('batch=2：5 条 → 3 次 POST', reqs.length, 3);
      ok('每次都是 POST', reqs.every((x) => x.method === 'POST'), reqs.map((x) => x.method));
      ok('URL 都带 ?primaryKey=slug', reqs.every((x) => x.url === '/indexes/games/documents?primaryKey=slug'), reqs.map((x) => x.url));
      is('默认索引名 games', reqs[0].url.split('/')[2], 'games');
      const sizes = reqs.map((x) => x.body.length);
      is('分批大小与 batch 参数一致（2,2,1）', sizes.join(','), '2,2,1');
      is('推完打印完成行', r.out.includes('完成：5 条文档已提交'), true);
      ok('进度行可见', r.out.includes('第 1/3 批：推送 2 条 → ok'), r.out);

      const docs = fake.docs();
      is('文档总数 5', docs.length, 5);
      const keys = ['slug', 'title', 'subtitle', 'category', 'tags', 'pinyin', 'releasedAt'];
      ok('字段齐全（slug/title/subtitle/category/tags/pinyin/releasedAt）',
        docs.every((d) => keys.every((k) => Object.prototype.hasOwnProperty.call(d, k))), docs[0]);
      ok('slug 唯一', new Set(docs.map((d) => d.slug)).size === docs.length);
      ok('slug 与库里一致', docs.map((d) => d.slug).join(',') === FIXTURE.map((f) => f[0]).join(','), docs.map((d) => d.slug));
      ok('tags 是字符串数组（与 src/data.js 的 tags.join 口径一致）',
        docs.every((d) => Array.isArray(d.tags) && d.tags.every((t) => typeof t === 'string')), docs[0].tags);
      ok('tags 内容与库里 JSON 一致', JSON.stringify(docs[0].tags) === JSON.stringify(FIXTURE[0][4]), docs[0].tags);
      is('category 是分类 slug 文本', docs[0].category, 'puzzle');
      ok('pinyin 来自 search_pinyin 列', docs.every((d, i) => d.pinyin === FIXTURE[i][5]), docs.map((d) => d.pinyin));
      ok('title 取自库里的中文标题', docs[1].title === '贪吃蛇', docs[1]);
      ok('下架/待审游戏没有进文档', !docs.some((d) => d.slug === 'retired' || d.slug === 'pending'));
      ok('content-type: application/json', fake.indexReqs().every((x) => (x.headers['content-type'] || '').includes('application/json')));
    }

    // ---------------------------------------------------------- 幂等：跑两遍
    {
      fake.clear();
      result(await runCli(['--db=' + dbPath, '--host=' + base]), '第一次全量推送');
      const first = fake.docs();
      fake.clear();
      result(await runCli(['--db=' + dbPath, '--host=' + base]), '第二次全量推送');
      const second = fake.docs();
      ok('重复跑两次文档集合完全相同（幂等，逐字段 JSON 比较）',
        JSON.stringify(first) === JSON.stringify(second),
        { firstSlugs: first.map((d) => d.slug), secondSlugs: second.map((d) => d.slug) });
      is('重复跑两次文档数相同', second.length, first.length);
      ok('两次都以 primaryKey=slug 覆盖同一批 slug',
        fake.indexReqs().every((x) => x.url.includes('primaryKey=slug')));
    }

    // ---------------------------------------------------------- --limit
    {
      fake.clear();
      result(await runCli(['--db=' + dbPath, '--host=' + base, '--limit=2']), '--limit=2');
      is('--limit=2 只推 2 条', fake.docs().length, 2);
      is('--limit=2 只发 1 次请求', fake.indexReqs().length, 1);
      is('--limit 取的是 id 最小的两条', fake.docs().map((d) => d.slug).join(','), '2048,snake');
    }

    // ---------------------------------------------------------- --index / --key
    {
      fake.clear();
      result(await runCli(['--db=' + dbPath, '--host=' + base, '--index=games_staging', '--key=masterKey', '--limit=1']), '--index/--key');
      const r0 = fake.indexReqs()[0];
      ok('--index 出现在 URL 里', r0.url.startsWith('/indexes/games_staging/documents?'), r0.url);
      is('--key 变成 Authorization 头', r0.headers.authorization, 'Bearer masterKey');
    }

    // ---------------------------------------------------------- --settings
    {
      fake.clear();
      const rs = result(await runCli(['--db=' + dbPath, '--host=' + base, '--settings', '--limit=1']), '--settings');
      const s = fake.settingsReqs();
      is('--settings 发 1 次 settings 请求', s.length, 1);
      is('settings 用 PUT', s[0].method, 'PUT');
      is('settings URL 对', s[0].url, '/indexes/games/settings');
      const body = fake.lastSettings();
      ok('searchableAttributes 与站点字段一致（title/subtitle/tags/category/pinyin/description）',
        JSON.stringify(body && body.searchableAttributes) === JSON.stringify(['title', 'subtitle', 'tags', 'category', 'pinyin', 'description']),
        body && body.searchableAttributes);
      ok('filterableAttributes 覆盖 category/tags（meiliBackend 支持 filter）',
        Array.isArray(body.filterableAttributes) && body.filterableAttributes.includes('category') && body.filterableAttributes.includes('tags'),
        body.filterableAttributes);
      ok('sortableAttributes 覆盖 plays/rating/id',
        Array.isArray(body.sortableAttributes) && ['plays', 'rating', 'id'].every((k) => body.sortableAttributes.includes(k)),
        body.sortableAttributes);
      ok('settings 先于文档推送', fake.reqs().indexOf(s[0]) < fake.reqs().findIndex((x) => x.url.includes('/documents')));
      ok('settings 成功有回显', /索引设置已更新/.test(rs.out), rs.out);
    }

    // ---------------------------------------------------------- 错误路径
    {
      fake.clear();
      fake.mode = 'error';
      const r = await runCli(['--db=' + dbPath, '--host=' + base]);
      ok('服务端 500 → 非零退出', r.code !== 0, r.code);
      ok('错误信息含状态码 500', r.err.includes('500'), r.err);
      ok('错误信息含响应体片段（前 200 字）', r.err.includes('内部错误：磁盘满了'), r.err);
      ok('失败时没有抛栈', !/\n\s+at /.test(r.err), r.err);
      fake.mode = 'ok';
    }
    {
      fake.clear();
      fake.mode = 'notfound';
      const r = await runCli(['--db=' + dbPath, '--host=' + base, '--limit=1']);
      ok('服务端 404 → 非零退出', r.code !== 0, r.code);
      ok('404 错误信息含状态码', r.err.includes('404'), r.err);
      fake.mode = 'ok';
    }
    {
      const dead = await freePort(3163, 3164, 3165);
      const r = await runCli(['--db=' + dbPath, '--host=http://127.0.0.1:' + dead, '--timeout=1500']);
      ok('端口没人听 → 非零退出（不抛栈）', r.code !== 0 && !/\n\s+at /.test(r.err), { code: r.code, err: r.err.slice(0, 300) });
      ok('连接失败错误可读', /连不上|超时/.test(r.err), r.err.slice(0, 300));
    }
    {
      fake.mode = 'hang';
      const r = await runCli(['--db=' + dbPath, '--host=' + base, '--timeout=200', '--limit=1']);
      fake.mode = 'ok';
      ok('服务端不响应 → 超时非零退出', r.code !== 0, r.code);
      ok('超时错误可读', /超时/.test(r.err), r.err.slice(0, 300));
    }
    {
      const r = await runCli(['--db=' + join(TMP, 'nope.db'), '--host=' + base]);
      ok('库不存在 → 非零退出且有提示', r.code !== 0 && r.err.includes('找不到数据库'), { code: r.code, err: r.err.slice(0, 200) });
    }
    {
      const r = await runCli(['--db=' + dbPath, '--dry-run']);
      is('--dry-run 不需要 MEILI_HOST 也能退 0', r.code, 0);
    }
    {
      const r = await runCli(['--db=' + dbPath]);
      ok('没给 --host 且没设 MEILI_HOST → 非零退出并提示', r.code !== 0 && /MEILI_HOST|--host/.test(r.err), { code: r.code, err: r.err.slice(0, 200) });
    }

    // ---------------------------------------------------------- env 变量口径
    {
      fake.clear();
      const r = await runCli(['--db=' + dbPath, '--limit=1'], {
        MEILI_HOST: base, MEILI_INDEX: 'games_env', MEILI_API_KEY: 'envKey',
      });
      if (r.code !== 0) console.log('    （env 用例 stderr）' + r.err.slice(0, 200));
      const r0 = fake.indexReqs()[0];
      ok('MEILI_HOST/MEILI_INDEX/MEILI_API_KEY 生效（命令行优先）',
        r.code === 0 && r0 && r0.url.startsWith('/indexes/games_env/documents?') && r0.headers.authorization === 'Bearer envKey',
        r0 && { url: r0.url, auth: r0.headers.authorization });
    }
  } finally {
    await fake.close();
    rmSync(TMP, { recursive: true, force: true });
  }

  console.log('');
  console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('自测自身出错：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
