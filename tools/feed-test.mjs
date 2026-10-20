#!/usr/bin/env node
/**
 * 好友动态流 /feed（第十批）自测：Express 与 Worker 两条线各跑一遍同一套断言。
 *
 * Express 线：整树复制到 D:/CODE/.tmp-ver/（跳过 node_modules / .git / dist / WAL 边车与别的测试库，
 *            再用 junction 把 node_modules 指回仓库），用复制品里的 data/games.db 起私有端口
 *            （从 3310 找空位，不碰 3000/4400）；数据层断言走复制品里的 src/social.js，页面断言走真 HTTP。
 * Worker 线：tools/d1-local.mjs 的 LocalD1 顶掉 D1 绑定，直接调 worker/app.js 的 default.fetch。
 *
 * 断言口径：只统计「我关注的人」、四种来源的过滤与去重、倒序与并列顺序、limit/offset 与翻页、
 *           空态、HTML 转义（昵称与正文）、notice 白名单、全站顶部入口；两条线同一套。
 *
 * 用法：node tools/feed-test.mjs [--express|--worker]     KEEP_TMP=1 保留临时目录
 * 退出码：有任何断言失败 → 1。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP_BASE = join(ROOT, '..', '.tmp-ver');
const KEEP = process.env.KEEP_TMP === '1';

/* ---------- 断言与计数 ---------- */
let PASS = 0;
let FAIL = 0;
let cur = null;
const SECTIONS = [];
function section(name) {
  cur = { name: name, pass: 0, fail: 0 };
  SECTIONS.push(cur);
  console.log('\n== ' + name + ' ==');
}
function ok(name, cond, extra) {
  if (cond) {
    cur.pass++;
    PASS++;
    console.log('  ok   ' + name);
  } else {
    cur.fail++;
    FAIL++;
    console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : '   → ' + extra));
  }
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b ? name : name + '   got=' + a + ' want=' + b, a === b);
}

/* ---------- 固定数据（id 用 9000xx 段，避开真库里的既有行） ---------- */
const IDS = { me: 900001, ann: 900002, bob: 900003, carl: 900004, loner: 900005, cat: 900011, g1: 900021, g2: 900022, g3: 900023, forum: 900031 };
const S1 = 'feed-test-alpha';
const S2 = 'feed-test-beta';
const S3 = 'feed-test-gamma';
const T1 = 900041;
const TOKEN = 'f'.repeat(64);
const TOTAL = 23;      // 3 play + 17 评论（3 条真 + 14 条流水）+ 1 主题 + 2 打卡
const FILLERS = 14;
const LONG = '这段评论故意写得很长很长'.repeat(6);
const T_BETA = new Date(2026, 4, 20, 12, 0, 0, 0).getTime();

const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h || 0, mi || 0, 0, 0).getTime();
const textAt = (y, m, d, h, mi) => {
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return y + '-' + p(m) + '-' + p(d) + ' ' + p(h || 0) + ':' + p(mi || 0) + ':00';
};

/* ---------- 临时目录与端口 ---------- */
function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split('\\').join('/');
      if (!rel) return true;
      if (rel === 'node_modules' || rel.indexOf('node_modules/') === 0) return false;
      if (rel === '.git' || rel.indexOf('.git/') === 0) return false;
      if (rel === 'dist' || rel.indexOf('dist/') === 0) return false;
      if (/^data\/.*\.db-(wal|shm)$/.test(rel)) return false;
      if (/^data\/(worker|probe|feed|smoke)/.test(rel)) return false;
      return true;
    }
  });
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(to, 'node_modules'), 'junction');
  } catch (e) {
    void e;
  }
}

async function freePort(start) {
  for (let p = start; p < start + 60; p++) {
    const can = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (can) return p;
  }
  throw new Error('从 ' + start + ' 起 60 个端口都占着');
}

function startSite(cwd, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: cwd,
    env: Object.assign({}, process.env, { PORT: String(port), SITE_ORIGIN: 'http://127.0.0.1:' + port }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const site = { child: child, port: port, base: 'http://127.0.0.1:' + port, log: [] };
  const push = (buf) => {
    site.log.push(String(buf));
    if (site.log.length > 400) site.log.shift();
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => site.log.push('spawn error: ' + e.message));
  return site;
}

async function waitReady(site, ms) {
  const banner = 'http://localhost:' + site.port;
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 25000)) {
    if (site.child.exitCode !== null) return { ok: false, reason: 'server 提前退出：' + site.log.join('').slice(-300) };
    if (site.log.join('').indexOf(banner) >= 0) {
      try {
        const r = await fetch(site.base + '/api/games?limit=1');
        if (r.ok) return { ok: true, reason: '' };
      } catch (e) {
        void e;
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok: false, reason: '等不到启动横幅：' + site.log.join('').slice(-300) };
}

function rmTree(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (i === 7) {
        console.log('  （临时目录没删干净：' + e.message + '）');
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return false;
}

function killSite(site) {
  if (!site || !site.child) return;
  try {
    spawnSync('taskkill', ['/pid', String(site.child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (e) {
    void e;
  }
  try {
    site.child.kill('SIGKILL');
  } catch (e) {
    void e;
  }
}

/* ---------- 播种：两条线同一个 SQL 集，只是绑定方式不同 ---------- */
function sqlLine(line, db) {
  return async (sql, params) => {
    const a = params || [];
    if (line === 'express') return db.prepare(sql).run(...a);
    const st = db.prepare(sql);
    return await (a.length ? st.bind(...a) : st).run();
  };
}

async function seed(run, ensure) {
  await ensure();
  await run('INSERT INTO categories (id, slug, name, icon, sort) VALUES (?, ?, ?, ?, ?)', [IDS.cat, 'feed-test-cat', '动态测试', '🧪', 1]);
  const gs = [[IDS.g1, S1, '阿尔法大冒险'], [IDS.g2, S2, '贝塔消除'], [IDS.g3, S3, '伽马棋']];
  for (const g of gs) await run('INSERT INTO games (id, slug, title, game_url, category_id, status) VALUES (?, ?, ?, ?, ?, 1)', [g[0], g[1], g[2], '/games/demo/index.html', IDS.cat]);
  const us = [
    [IDS.me, 'feed-me', '我 昵称'],
    [IDS.ann, 'feed-ann', 'Ann <script>alert(1)</script>'],
    [IDS.bob, 'feed-bob', '鲍勃'],
    [IDS.carl, 'feed-carl', '卡尔'],
    [IDS.loner, 'feed-loner', '路人']
  ];
  for (const u of us) await run('INSERT INTO users (id, username, display_name, pass_hash, pass_salt) VALUES (?, ?, ?, ?, ?)', [u[0], u[1], u[2], 'h', 's']);
  // 我只关注 Ann 和 Bob；Carl（陌生人）与 Loner（谁都没关注）都在名单外
  await run('INSERT INTO follows (user_id, followee_id, created_at) VALUES (?, ?, ?)', [IDS.me, IDS.ann, textAt(2026, 5, 10, 10, 0)]);
  await run('INSERT INTO follows (user_id, followee_id, created_at) VALUES (?, ?, ?)', [IDS.me, IDS.bob, textAt(2026, 5, 11, 10, 0)]);
  // play 来源一：收藏（Carl 的那条不该出现）
  await run('INSERT INTO favorites (user_id, game_id, created_at) VALUES (?, ?, ?)', [IDS.ann, IDS.g1, textAt(2026, 5, 20, 9, 0)]);
  await run('INSERT INTO favorites (user_id, game_id, created_at) VALUES (?, ?, ?)', [IDS.carl, IDS.g1, textAt(2026, 5, 20, 9, 5)]);
  // play 来源二：elo_history —— Ann 同一款打了两局（去重留最近）、第三局里 Ann 是 guest、另外是陌生人与匿名键
  const elo = [
    [900101, S2, String(IDS.ann), 'n:guest', at(2026, 5, 20, 10)],
    [900102, S2, String(IDS.ann), 'n:guest', at(2026, 5, 20, 11)],
    [900103, S2, String(IDS.bob), String(IDS.ann), T_BETA],
    [900104, S3, String(IDS.carl), String(IDS.carl), at(2026, 5, 20, 13)],
    [900105, S3, 'n:bob', 'n:carol', at(2026, 5, 20, 14)]
  ];
  for (const e of elo) await run('INSERT INTO elo_history (room_id, game, season, host_id, guest_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [e[0], e[1], '2026Q2', e[2], e[3], e[4]]);
  // 评论：正常 / 已隐藏 / 挂在公告上 / 超长 / 陌生人 / XSS / 14 条流水
  const cms = [
    [IDS.g1, IDS.ann, '好玩！', 1, 'game', textAt(2026, 5, 20, 8, 0)],
    [IDS.g1, IDS.ann, '被隐藏的评论', 0, 'game', textAt(2026, 5, 20, 8, 10)],
    [IDS.g1, IDS.bob, '公告下的评论', 1, 'post', textAt(2026, 5, 20, 8, 20)],
    [IDS.g2, IDS.ann, LONG, 1, 'game', textAt(2026, 5, 20, 7, 0)],
    [IDS.g1, IDS.carl, '陌生人的评论', 1, 'game', textAt(2026, 5, 20, 8, 30)],
    [IDS.g1, IDS.ann, 'XSS <script>alert(2)</script>', 1, 'game', textAt(2026, 5, 20, 5, 30)]
  ];
  for (const c of cms) await run('INSERT INTO comments (game_id, user_id, body, status, target, created_at) VALUES (?, ?, ?, ?, ?, ?)', c);
  for (let i = 0; i < FILLERS; i++) await run('INSERT INTO comments (game_id, user_id, body, status, target, created_at) VALUES (?, ?, ?, ?, ?, ?)', [IDS.g1, IDS.ann, '流水评论 ' + i, 1, 'game', textAt(2026, 5, 10, 0, i)]);
  // 主题：已发布 / 待审 / 下架 / 陌生人
  await run('INSERT INTO forums (id, slug, name) VALUES (?, ?, ?)', [IDS.forum, 'feed-test-forum', '动态测试版']);
  const ths = [
    [T1, IDS.ann, '大家来玩阿尔法', 1, textAt(2026, 5, 20, 6, 0)],
    [T1 + 1, IDS.ann, '待审的帖子', 0, textAt(2026, 5, 20, 6, 10)],
    [T1 + 2, IDS.bob, '下架的帖子', 2, textAt(2026, 5, 20, 6, 20)],
    [T1 + 3, IDS.carl, '陌生人的帖子', 1, textAt(2026, 5, 20, 6, 30)]
  ];
  for (const t of ths) await run('INSERT INTO forum_threads (id, forum_id, user_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [t[0], IDS.forum, t[1], t[2], t[3], t[4]]);
  // 每日挑战：Ann 正常、Bob 补做；Carl 与我自己的不算
  const dl = [
    ['2026-05-18', IDS.ann, S3, at(2026, 5, 18, 12), 0, '2026-05-18'],
    ['2026-05-19', IDS.bob, S3, at(2026, 5, 19, 12), 1, '2026-05-19'],
    ['2026-05-17', IDS.carl, S3, at(2026, 5, 17, 12), 0, '2026-05-17'],
    ['2026-05-16', IDS.me, S3, at(2026, 5, 16, 12), 0, '2026-05-16']
  ];
  for (const d of dl) await run('INSERT INTO daily_results (day, user_id, slug, created_at, makeup, done_day) VALUES (?, ?, ?, ?, ?, ?)', d);
}

/* ---------- 两条线共用的数据层断言 ---------- */
async function checkData(tag, feedAs) {
  const full = await feedAs(IDS.me, { limit: 50 });
  const items = (full && full.items) || [];
  const byKind = (k) => items.filter((it) => it.kind === k);
  eq(tag + 'total = 23（3 play + 17 评论 + 1 主题 + 2 打卡）', full && full.total, TOTAL);
  eq(tag + 'limit=50 时条目数等于 total（去重后计数与列表一致）', items.length, TOTAL);
  eq(tag + '四种 kind 的条数', [byKind('play').length, byKind('comment').length, byKind('thread').length, byKind('daily').length], [3, 17, 1, 2]);
  ok(tag + '按 at 倒序（单调不增）', items.every((it, i) => i === 0 || items[i - 1].at >= it.at));
  ok(tag + 'at 是毫秒数', items.every((it) => typeof it.at === 'number' && it.at > 1e12));
  ok(tag + '并列时的第一条：同刻 play 里 actorId 大的在前', items[0] && items[0].kind === 'play' && items[0].actorId === IDS.bob && items[0].at === T_BETA, JSON.stringify(items[0]));
  ok(tag + '第二条：Ann 也从 guest 分支拿到同刻那条', items[1] && items[1].kind === 'play' && items[1].actorId === IDS.ann && items[1].at === T_BETA, JSON.stringify(items[1]));
  const dup = byKind('play').filter((it) => it.actorId === IDS.ann && it.gameSlug === S2);
  eq(tag + '同一人同一游戏的 play 只留一条', dup.length, 1);
  eq(tag + '留的是最近那局（12:00 的第三局压过 10:00/11:00）', dup.length ? dup[0].at : 0, T_BETA);
  const fav = byKind('play').filter((it) => it.gameSlug === S1);
  eq(tag + '收藏来源的 play 一条，标题取自 games、text 空串', fav.length === 1 ? [fav[0].actorId, fav[0].gameTitle, fav[0].text, fav[0].threadId] : null, [IDS.ann, '阿尔法大冒险', '', 0]);
  ok(tag + '没被关注的人（Carl）一条都不出现', items.every((it) => it.actorId !== IDS.carl));
  ok(tag + '自己的动态不出现（不含我自己）', items.every((it) => it.actorId !== IDS.me));
  ok(tag + '匿名键与陌生人的 elo 不算 play', byKind('play').every((it) => it.gameSlug !== S3));
  ok(tag + 'status=0 的评论不出现', items.every((it) => it.text.indexOf('被隐藏的评论') < 0));
  ok(tag + 'target=post 的评论不出现', items.every((it) => it.text.indexOf('公告下的评论') < 0));
  const th = byKind('thread');
  eq(tag + '主题只算 status=1 的，且带 threadId、不带游戏', th.length === 1 ? [th[0].threadId, th[0].gameSlug, th[0].text] : null, [T1, '', '大家来玩阿尔法']);
  ok(tag + '待审 / 下架的主题不出现', items.every((it) => it.text.indexOf('待审的帖子') < 0 && it.text.indexOf('下架的帖子') < 0));
  const longC = byKind('comment').filter((it) => it.text.indexOf('这段评论故意写得很长很长') === 0);
  eq(tag + '超长评论截到 60 字', longC.length ? longC[0].text.length : 0, 60);
  ok(tag + '截断不补省略号（flat 只 slice）', longC.length ? longC[0].text.slice(-1) !== '…' : false);
  const dl = byKind('daily');
  ok(tag + '打卡两条，标题按 slug 关联到 games', dl.length === 2 && dl.every((it) => it.gameTitle === '伽马棋'), JSON.stringify(dl.map((it) => it.gameTitle)));
  ok(tag + '打卡文案区分补做', dl.some((it) => it.text === '完成了每日挑战（补做）') && dl.some((it) => it.text === '完成了每日挑战'));
  const ann1 = items.filter((it) => it.actorId === IDS.ann)[0];
  ok(tag + '补上了 username 与 displayName', !!ann1 && ann1.username === 'feed-ann' && ann1.displayName === 'Ann <script>alert(1)</script>', ann1 ? ann1.username + ' / ' + ann1.displayName : '');
  const l5 = await feedAs(IDS.me, { limit: 5 });
  eq(tag + 'limit=5 只回 5 条、total 不变', [l5.items.length, l5.total], [5, TOTAL]);
  const def = await feedAs(IDS.me, {});
  ok(tag + '不带参数默认每页 20 条', def.items.length === 20 && def.total === TOTAL);
  const o20 = await feedAs(IDS.me, { limit: 20, offset: 20 });
  eq(tag + 'offset=20 回最后 3 条', o20.items.length, 3);
  ok(tag + '翻页两页不重叠', o20.items.every((it) => it.at < full.items[19].at));
  const oo = await feedAs(IDS.me, { limit: 20, offset: 100 });
  eq(tag + 'offset 越界回空列表但 total 仍在', [oo.items.length, oo.total], [0, TOTAL]);
  const big = await feedAs(IDS.me, { limit: 999 });
  eq(tag + 'limit 超上限按 50 截（23 条数据全回）', big.items.length, TOTAL);
  const lp = await feedAs(IDS.loner, {});
  eq(tag + 'Loner 没关注谁 → 空态', [lp.total, lp.items.length], [0, 0]);
  const zero = await feedAs(0, {});
  eq(tag + 'userId=0 → 空', [zero.total, zero.items.length], [0, 0]);
  const self = await feedAs(IDS.ann, {});
  eq(tag + 'Ann 没关注谁 → 空（口径是「我关注的人」，不是「关注我的人」）', self.total, 0);
}

/* ---------- Express 线 ---------- */
async function runExpress() {
  section('Express 线（整树复制 + 私有端口：数据层 + 真 HTTP + sid cookie）');
  mkdirSync(TMP_BASE, { recursive: true });
  const tmp = mkdtempSync(join(TMP_BASE, 'express-'));
  let site = null;
  let closeDb = null;
  try {
    copyTree(ROOT, tmp);
    const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
    closeDb = () => { try { dbmod.db.close(); } catch (e) { void e; } };
    if (typeof dbmod.migrate === 'function') dbmod.migrate();
    const S = await import(pathToFileURL(join(tmp, 'src', 'social.js')).href);
    const AUTH = await import(pathToFileURL(join(tmp, 'src', 'auth.js')).href);
    const run = sqlLine('express', dbmod.db);
    await seed(run, async () => { S.friendFeed(0); });
    await checkData('express：', (uid, opts) => S.friendFeed(uid, opts));

    const port = await freePort(3310);
    site = startSite(tmp, port);
    const ready = await waitReady(site);
    ok('express：私有端口 ' + port + ' 起来并回了 /api/games', ready.ok, ready.reason);
    if (!ready.ok) return;
    const base = site.base;
    const token = AUTH.createSession(IDS.me);
    ok('express：会话 cookie 名是 sid、token 是 64 位十六进制', AUTH.SESSION_COOKIE === 'sid' && /^[a-f0-9]{64}$/.test(String(token)), String(AUTH.SESSION_COOKIE));
    const jar = { headers: { cookie: 'sid=' + token } };

    const anon = await fetch(base + '/feed', { redirect: 'manual' });
    ok('express：未登录 GET /feed → 302', anon.status === 302, 'status=' + anon.status);
    const anonLoc = String(anon.headers.get('location') || '');
    ok('express：未登录跳 /login?next=%2Ffeed', anonLoc.indexOf('/login') >= 0 && /next=(%2Ffeed|%2ffeed|\/feed)/.test(anonLoc), anonLoc);

    const p1 = await fetch(base + '/feed', jar);
    const h1 = await p1.text();
    ok('express：登录后 GET /feed → 200', p1.status === 200, 'status=' + p1.status);
    ok('express：页面有「好友动态」', h1.indexOf('好友动态') > 0);
    ok('express：计数条是「共 23 条」', h1.indexOf('共 ' + TOTAL + ' 条') > 0);
    ok('express：play 链到 /game/' + S1, h1.indexOf('/game/' + S1) > 0);
    ok('express：主题链到 /forum/t/' + T1, h1.indexOf('/forum/t/' + T1) > 0);
    ok('express：打卡链到 /daily', h1.indexOf('href="/daily"') > 0);
    ok('express：昵称里的 <script> 被转义', h1.indexOf('&lt;script&gt;alert(1)') > 0 && h1.indexOf('<script>alert(1)') < 0);
    ok('express：评论正文里的 <script> 被转义', h1.indexOf('&lt;script&gt;alert(2)') > 0 && h1.indexOf('<script>alert(2)') < 0);
    ok('express：第 1 页有翻页链接 page=2', h1.indexOf('page=2') > 0);
    ok('express：第 1 页含最近的流水评论 13', h1.indexOf('流水评论 13') > 0);

    const p2 = await fetch(base + '/feed?page=2', jar);
    const h2 = await p2.text();
    ok('express：第 2 页 → 200', p2.status === 200, 'status=' + p2.status);
    ok('express：第 2 页含最老的流水评论 2', h2.indexOf('流水评论 2') > 0);
    ok('express：第 2 页没有第 1 页的内容', h2.indexOf('流水评论 13') < 0);
    ok('express：第 2 页有回第 1 页的链接', h2.indexOf('page=1') > 0);

    const pn = await fetch(base + '/feed?notice=followed', jar);
    ok('express：notice=followed 透出「已关注」', (await pn.text()).indexOf('已关注') > 0);
    const px = await fetch(base + '/feed?notice=' + encodeURIComponent('<script>alert(3)</script>'), jar);
    ok('express：notice 只认白名单、不反射原串', (await px.text()).indexOf('alert(3)') < 0);

    const lonerJar = { headers: { cookie: 'sid=' + AUTH.createSession(IDS.loner) } };
    const pe = await fetch(base + '/feed', lonerJar);
    const he = await pe.text();
    ok('express：没关注谁时渲染空态文案', pe.status === 200 && he.indexOf('还没有动态') > 0, 'status=' + pe.status);

    const home = await fetch(base + '/', jar);
    const hh = await home.text();
    ok('express：全站顶部有 /feed 入口', home.status === 200 && hh.indexOf('href="/feed"') > 0, 'status=' + home.status);
  } finally {
    killSite(site);
    if (closeDb) closeDb();
    if (KEEP) console.log('  （保留临时目录 ' + tmp + '）');
    else rmTree(tmp);
  }
}

/* ---------- Worker 线 ---------- */
async function runWorker() {
  section('Worker 线（LocalD1 + worker/app.js default.fetch）');
  mkdirSync(TMP_BASE, { recursive: true });
  const file = join(TMP_BASE, 'feed-worker-' + Date.now() + '.db');
  let db = null;
  try {
    const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
    db = new LocalD1(file);
    const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
    await schema.migrate(db);
    if (typeof schema.ensureColumns === 'function') await schema.ensureColumns(db);
    const S = await import(pathToFileURL(join(ROOT, 'worker', 'social.js')).href);
    const app = (await import(pathToFileURL(join(ROOT, 'worker', 'app.js')).href)).default;
    const run = sqlLine('worker', db);
    await seed(run, async () => { await S.friendFeed(db, 0); });
    await checkData('worker：', (uid, opts) => S.friendFeed(db, uid, opts));
    await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime(\'now\',\'localtime\',\'+30 days\'))', [TOKEN, IDS.me]);

    const env = { DB: db, SITE_ORIGIN: 'http://feed.test', MAIL_TICK: '0' };
    const call = (p, init) => app.fetch(new Request('http://feed.test' + p, init), env);
    const jar = { headers: { cookie: 'sid=' + TOKEN } };

    const anon = await call('/feed');
    ok('worker：未登录 GET /feed → 302', anon.status === 302, 'status=' + anon.status);
    const anonLoc = String(anon.headers.get('location') || '');
    ok('worker：未登录跳 /login?next=%2Ffeed', anonLoc.indexOf('/login') >= 0 && /next=(%2Ffeed|%2ffeed|\/feed)/.test(anonLoc), anonLoc);

    const p1 = await call('/feed', jar);
    const h1 = await p1.text();
    ok('worker：登录后 GET /feed → 200', p1.status === 200, 'status=' + p1.status);
    ok('worker：页面有「好友动态」', h1.indexOf('好友动态') > 0);
    ok('worker：计数条是「共 23 条」', h1.indexOf('共 ' + TOTAL + ' 条') > 0);
    ok('worker：play 链到 /game/' + S1, h1.indexOf('/game/' + S1) > 0);
    ok('worker：主题链到 /forum/t/' + T1, h1.indexOf('/forum/t/' + T1) > 0);
    ok('worker：打卡链到 /daily', h1.indexOf('href="/daily"') > 0);
    ok('worker：昵称里的 <script> 被转义', h1.indexOf('&lt;script&gt;alert(1)') > 0 && h1.indexOf('<script>alert(1)') < 0);
    ok('worker：评论正文里的 <script> 被转义', h1.indexOf('&lt;script&gt;alert(2)') > 0 && h1.indexOf('<script>alert(2)') < 0);
    ok('worker：第 1 页有翻页链接 page=2', h1.indexOf('page=2') > 0);

    const p2 = await call('/feed?page=2', jar);
    const h2 = await p2.text();
    ok('worker：第 2 页 → 200', p2.status === 200, 'status=' + p2.status);
    ok('worker：第 2 页含最老的流水评论 2', h2.indexOf('流水评论 2') > 0);
    ok('worker：第 2 页没有第 1 页的内容', h2.indexOf('流水评论 13') < 0);

    const pn = await call('/feed?notice=followed', jar);
    ok('worker：notice=followed 透出「已关注」', (await pn.text()).indexOf('已关注') > 0);

    await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime(\'now\',\'localtime\',\'+30 days\'))', ['a'.repeat(64), IDS.loner]);
    const pe = await call('/feed', { headers: { cookie: 'sid=' + 'a'.repeat(64) } });
    ok('worker：没关注谁时渲染空态文案', pe.status === 200 && (await pe.text()).indexOf('还没有动态') > 0, 'status=' + pe.status);

    const home = await call('/', jar);
    ok('worker：全站顶部有 /feed 入口', home.status === 200 && (await home.text()).indexOf('href="/feed"') > 0, 'status=' + home.status);
  } finally {
    try {
      if (db && db.close) db.close();
    } catch (e) {
      void e;
    }
    for (const f of [file, file + '-wal', file + '-shm']) {
      try { rmSync(f, { force: true }); } catch (e) { void e; }
    }
  }
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
const only = argv.indexOf('--express') >= 0 ? 'express' : (argv.indexOf('--worker') >= 0 ? 'worker' : 'both');
try {
  if (only === 'express' || only === 'both') await runExpress();
  if (only === 'worker' || only === 'both') await runWorker();
} catch (e) {
  FAIL++;
  console.log('\n!! 抛异常：' + (e && e.stack ? e.stack : e));
}
console.log('\n' + '='.repeat(60));
for (const s of SECTIONS) console.log(s.name + '：' + s.pass + ' 通过 / ' + s.fail + ' 失败');
console.log('合计：' + PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
