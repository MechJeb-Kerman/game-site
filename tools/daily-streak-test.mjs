/**
 * 每日挑战：全勤日历 / 补做 / 月度全勤（第八批）回归测试。
 *
 * 运行：node tools/daily-streak-test.mjs
 * 前置：无。自己造临时库，不碰 data/games.db，不占端口，不发网络请求。
 *
 * 两条线各跑一遍同一套断言：
 *   express 线：把 src/ 整树复制到临时目录 —— src/db.js 的库路径由 import.meta.url 推出、
 *     没有环境变量开关，副本会把库建在 <tmp>/data/games.db，于是拿到一个真·临时库；
 *     再调它的 migrate() 建全表，动态 import 副本的 social.js（跑的是真源码，不是替身）。
 *   worker 线：tools/d1-local.mjs 的 LocalD1 指向临时文件，先跑 worker/schema.js 的 migrate()，
 *     再加载 worker/social.js（第一个参数是 db 绑定、全程 await）。
 *
 * 「现在」固定成本地 2026-05-20 中午：所有断言只依赖这两个常量，跟跑测试的真实时钟无关。
 * 期望用的日期键由本文件自己算，不拿被测模块算期望值。结尾打印「通过 N / 失败 M」，有失败 exit 1。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra));
  }
}

function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, 'got ' + a + ' want ' + b);
}

/** 本地时间：2026-05-20 12:00（真实时钟无关） */
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
const NOW = at(2026, 5, 20);
const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
/** 从「现在」往回第 i 天的日期键（0 = 今天，自己算，不用被测模块） */
const back = (i) => {
  const d = new Date(2026, 4, 20);
  d.setDate(d.getDate() - i);
  return key(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

const TODAY = back(0);          // 2026-05-20
const YESTERDAY = back(1);      // 2026-05-19
const DAY_BEFORE = back(2);     // 2026-05-18
const DAY3 = back(3);           // 2026-05-17（超出补做窗口）
const DAY5 = back(5);           // 2026-05-15
const TOMORROW = key(2026, 5, 21);
const SEEDS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];

/* ---------- 两条线的装载 ---------- */

async function setupExpress(tmp) {
  mkdirSync(join(tmp, 'public'), { recursive: true });
  mkdirSync(join(tmp, 'games'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
  dbmod.migrate();
  const S = await import(pathToFileURL(join(tmp, 'src', 'social.js')).href);
  return { db: dbmod.db, S: S };
}

async function setupWorker(tmp) {
  const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
  const db = new LocalD1(join(tmp, 'd1.db'));
  const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
  await schema.migrate(db);
  const S = await import(pathToFileURL(join(ROOT, 'worker', 'social.js')).href);
  return { db: db, S: S };
}

/** 把两条线包成同一组方法：断言只写一遍；worker 线自动补 db 首参 */
function api(kind, S, db) {
  const isExpress = kind === 'express';
  const bind = (sql, params = []) => {
    const st = db.prepare(sql);
    return params.length ? st.bind.apply(st, params) : st;
  };
  const run = async (sql, params = []) => (isExpress ? db.prepare(sql).run(...params) : bind(sql, params).run());
  const all = async (sql, params = []) => (isExpress ? db.prepare(sql).all(...params) : (await bind(sql, params).all() || {}).results || []);
  const num = async (sql, params = []) => {
    const row = isExpress ? db.prepare(sql).get(...params) : await bind(sql, params).first();
    return Number((row || {}).n || 0);
  };
  const call = (name, args) => (isExpress ? S[name](...args) : S[name](db, ...args));
  return {
    kind: kind,
    run: run,
    all: all,
    num: num,
    slug: (day) => call('dailySlug', [day]),
    stats: (uid, now) => call('dailyStats', [uid, now]),
    cal: (uid, days, now) => call('dailyCalendar', [uid, days, now]),
    perfect: (uid, month, now) => call('monthlyPerfect', [uid, month, now]),
    // 不传 opts 就走「老调用点」的两参形状（server.js / worker/app.js 就是这么调的）
    mark: (uid, slug, now, opts) => (opts === undefined ? call('markDaily', [uid, slug, now]) : call('markDaily', [uid, slug, now, opts])),
    profile: (uid) => call('profileOf', [uid]),
    board: (day) => call('dailyBoard', [day])
  };
}

/* ---------- 一条线的全部断言 ---------- */

async function runLine(kind, S, db) {
  const A = api(kind, S, db);
  console.log('\n=== ' + kind + ' 线 ===');

  /* 造数据：1 个分类 + 6 款上架游戏（dailySlug 要有得挑）+ 5 个用户
   * uid 1 = 主线（今天打卡 + 补两天）；2 = 连续 4 天；3 = 四月全勤老数据；
   * uid 4 = 四月缺一天；5 = 连打 70 天（测上限） */
  await A.run('INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)', ['daily-test', '测试分类', '🎲', 1]);
  for (let i = 1; i <= SEEDS.length; i++) {
    await A.run('INSERT INTO games (slug, title, game_url, category_id, status) VALUES (?, ?, ?, 1, 1)', [SEEDS[i - 1], '测试游戏 ' + i, '/games/g' + i + '/index.html']);
  }
  for (const name of ['dtest', 'streaker', 'aprfull', 'aprhalf', 'seventy']) {
    await A.run('INSERT INTO users (username, display_name, pass_hash, pass_salt) VALUES (?, ?, ?, ?)', [name, name + '昵称', 'h', 's']);
  }
  const slugs = {};
  for (const d of [TODAY, YESTERDAY, DAY_BEFORE, DAY3, DAY5]) slugs[d] = await A.slug(d);
  ok('五天都有题、且都是 seed 里的 slug', [TODAY, YESTERDAY, DAY_BEFORE, DAY3, DAY5].every((d) => SEEDS.indexOf(slugs[d]) >= 0), JSON.stringify(slugs));

  /* ---------- A 未登录兜底 ---------- */
  console.log('--- A 未登录兜底 ---');
  const s0 = await A.stats(0, NOW);
  eq('未登录 total = 0', s0.total, 0);
  eq('未登录 streak = 0', s0.streak, 0);
  eq('未登录 doneToday = false', s0.doneToday, false);
  eq('未登录 done = []', s0.done, []);
  ok('未登录也给当天挑战 slug', typeof s0.slug === 'string' && s0.slug.length > 0, String(s0.slug));
  eq('未登录日历 28 格', s0.calendar.cells.length, 28);
  eq('未登录 calendar.today = null', s0.calendar.today, null);
  ok('未登录格子全 false', s0.calendar.cells.every((c) => c.done === false && c.makeup === false && c.slug === '' && c.doneDay === ''));
  eq('未登录 makeupUsed = 0', s0.makeupUsed, 0);
  eq('未登录 perfect.done = 0', s0.perfect.done, 0);
  eq('未登录 perfect.perfect = false', s0.perfect.perfect, false);
  eq('未登录 doneRows = []', s0.doneRows, []);
  eq('未登录打卡 fresh = false', (await A.mark(0, 'whatever', NOW)).fresh, false);
  eq('未登录打卡不落库', await A.num('SELECT COUNT(*) AS n FROM daily_results'), 0);

  /* ---------- B 日历 28 格 ---------- */
  console.log('--- B 日历形状 ---');
  const cal28 = (await A.cal(1, 28, NOW)).cells;
  eq('28 格', cal28.length, 28);
  eq('首格 = 27 天前', cal28[0].day, back(27));
  eq('末格 = 今天', cal28[27].day, TODAY);
  ok('只有末格 today = true', cal28[27].today === true && cal28.filter((c) => c.today).length === 1);
  ok('按时间正序', cal28.every((c, i) => i === 0 || cal28[i - 1].day < c.day));
  ok('格子字段齐全', cal28.every((c) => ['day', 'done', 'slug', 'makeup', 'today', 'doneDay'].every((k) => k in c)));
  ok('还没打卡时全 false', cal28.every((c) => !c.done && c.slug === '' && c.makeup === false));
  eq('days = 7 就给 7 格', (await A.cal(1, 7, NOW)).cells.length, 7);
  eq('days = 999 夹到 120', (await A.cal(1, 999, NOW)).cells.length, 120);

  /* ---------- C 今天打卡 ---------- */
  console.log('--- C 今天打卡 ---');
  const m1 = await A.mark(1, slugs[TODAY], NOW);
  eq('打卡 fresh = true', m1.fresh, true);
  eq('打卡 day = 今天', m1.day, TODAY);
  eq('打卡 makeup = false', m1.makeup, false);
  eq('打卡 doneDay = 今天', m1.doneDay, TODAY);
  eq('打卡 error = ""', m1.error, '');
  eq('同一天再打一次 fresh = false（幂等）', (await A.mark(1, slugs[TODAY], NOW)).fresh, false);
  eq('幂等：库里只有 1 行', await A.num('SELECT COUNT(*) AS n FROM daily_results WHERE user_id = 1'), 1);
  const mBad = await A.mark(1, 'not-a-daily-slug', NOW);
  eq('题不对 fresh = false', mBad.fresh, false);
  eq('题不对 error = slug_mismatch', mBad.error, 'slug_mismatch');
  eq('题不对不落库', await A.num('SELECT COUNT(*) AS n FROM daily_results WHERE user_id = 1'), 1);
  const s1 = await A.stats(1, NOW);
  eq('total = 1', s1.total, 1);
  eq('streak = 1', s1.streak, 1);
  eq('doneToday = true', s1.doneToday, true);
  eq('done[0] = 今天', s1.done[0], TODAY);
  eq('日历末格 done', s1.calendar.cells[27].done, true);
  eq('日历末格 makeup = false', s1.calendar.cells[27].makeup, false);
  eq('日历末格 slug = 今天的题', s1.calendar.cells[27].slug, slugs[TODAY]);
  eq('makeupUsed = 0', s1.makeupUsed, 0);
  eq('最近一次补做是空的', s1.makeup, { day: '', slug: '', makeup: false, doneDay: '' });
  eq('五月 total = 20（只数到今天）', s1.perfect.total, 20);
  eq('五月 done = 1', s1.perfect.done, 1);
  eq('五月 perfect = false', s1.perfect.perfect, false);
  eq('perfect.month = 2026-05', s1.perfect.month, '2026-05');
  eq('doneRows[0].doneDay = 今天', s1.doneRows[0].doneDay, TODAY);
  eq('doneRows[0].makeup = false', s1.doneRows[0].makeup, false);

  /* ---------- D 补做（窗口内） ---------- */
  console.log('--- D 补做昨天 ---');
  const mk = await A.mark(1, slugs[YESTERDAY], NOW, { day: YESTERDAY, makeup: true });
  eq('补昨天 fresh = true', mk.fresh, true);
  eq('补昨天 day = 昨天', mk.day, YESTERDAY);
  eq('补昨天 makeup = true', mk.makeup, true);
  eq('补昨天 doneDay = 今天（审计用）', mk.doneDay, TODAY);
  eq('补昨天 error = ""', mk.error, '');
  const rowY = (await A.all('SELECT day, slug, makeup, done_day FROM daily_results WHERE user_id = 1 AND day = ?', [YESTERDAY]))[0] || {};
  eq('库里 makeup = 1', Number(rowY.makeup), 1);
  eq('库里 done_day = 今天', String(rowY.done_day), TODAY);
  const s2 = await A.stats(1, NOW);
  eq('补做后 total = 2（补做也算完成）', s2.total, 2);
  eq('补做不进 streak（仍 1）', s2.streak, 1);
  ok('补做按目标日进了 done', s2.done.indexOf(YESTERDAY) >= 0, JSON.stringify(s2.done));
  eq('makeupUsed = 1', s2.makeupUsed, 1);
  eq('最近一次补做 = 昨天', s2.makeup, { day: YESTERDAY, slug: slugs[YESTERDAY], makeup: true, doneDay: TODAY });
  const c26 = s2.calendar.cells[26];
  ok('日历倒数第二格 = 昨天 done + makeup', c26.day === YESTERDAY && c26.done === true && c26.makeup === true && c26.today === false, JSON.stringify(c26));
  eq('补做后五月 done = 2', s2.perfect.done, 2);
  ok('doneRows 标了 makeup 与 doneDay', s2.doneRows.some((r) => r.day === YESTERDAY && r.makeup === true && r.doneDay === TODAY));
  eq('重复补做 fresh = false（幂等）', (await A.mark(1, slugs[YESTERDAY], NOW, { day: YESTERDAY, makeup: true })).fresh, false);
  eq('重复补做仍 1 行', await A.num('SELECT COUNT(*) AS n FROM daily_results WHERE user_id = 1 AND day = ?', [YESTERDAY]), 1);
  const mOld = await A.mark(1, slugs[YESTERDAY], at(2026, 5, 19));
  eq('老调用（now = 昨天）重复打卡 fresh = false', mOld.fresh, false);
  eq('补做标记没被抹掉', Number(((await A.all('SELECT makeup FROM daily_results WHERE user_id = 1 AND day = ?', [YESTERDAY]))[0] || {}).makeup), 1);
  eq('streak 仍是 1', (await A.stats(1, NOW)).streak, 1);

  /* ---------- E 补做窗口与拒绝 ---------- */
  console.log('--- E 补做窗口 ---');
  const late = await A.mark(1, slugs[DAY3], NOW, { day: DAY3 });
  eq('补 3 天前 fresh = false', late.fresh, false);
  eq('补 3 天前 error = too_late', late.error, 'too_late');
  eq('补 3 天前 makeup = false', late.makeup, false);
  eq('补 3 天前不落库', await A.num('SELECT COUNT(*) AS n FROM daily_results WHERE user_id = 1'), 2);
  eq('补明天 error = too_late', (await A.mark(1, 'x', NOW, { day: TOMORROW })).error, 'too_late');
  eq('日期格式不对 error = bad_day', (await A.mark(1, 'x', NOW, { day: '2026-5-1' })).error, 'bad_day');
  const ok2 = await A.mark(1, slugs[DAY_BEFORE], NOW, { day: DAY_BEFORE });
  eq('前天（只给 day）fresh = true', ok2.fresh, true);
  eq('只给 day 也按补做记', ok2.makeup, true);
  eq('补前天 doneDay = 今天', ok2.doneDay, TODAY);
  const s3 = await A.stats(1, NOW);
  eq('补两天后 total = 3', s3.total, 3);
  eq('makeupUsed = 2', s3.makeupUsed, 2);
  eq('streak 仍 1（三个目标日里只有今天算自然打卡）', s3.streak, 1);
  ok('最近三格都 done', s3.calendar.cells.slice(25).every((c) => c.done), JSON.stringify(s3.calendar.cells.slice(25)));
  eq('28 格里正好 3 天 done', s3.calendar.cells.filter((c) => c.done).length, 3);
  eq('最近一次补做 = 目标日最新的那次（昨天）', s3.makeup.day, YESTERDAY);
  eq('它记的完成日仍是今天', s3.makeup.doneDay, TODAY);

  /* ---------- F 连续天数只认自然打卡 ---------- */
  console.log('--- F 连续天数 ---');
  for (let i = 4; i >= 1; i--) {
    const r = await A.mark(2, await A.slug(back(i)), at(2026, 5, 20 - i));
    ok('自然打卡 ' + back(i), r.fresh === true && r.makeup === false, JSON.stringify(r));
  }
  const s4 = await A.stats(2, NOW);
  eq('连续 4 天 → streak = 4', s4.streak, 4);
  eq('缺今天 → doneToday = false', s4.doneToday, false);
  eq('连续玩家 total = 4', s4.total, 4);
  eq('老玩家补 5 天前 error = too_late', (await A.mark(2, slugs[DAY5], NOW, { day: DAY5 })).error, 'too_late');
  eq('老玩家 streak 没变', (await A.stats(2, NOW)).streak, 4);

  /* ---------- G 跨月 / 月度全勤 ---------- */
  console.log('--- G 跨月全勤 ---');
  for (let d = 1; d <= 30; d++) {
    await A.run('INSERT INTO daily_results (day, user_id, slug, created_at) VALUES (?, ?, ?, ?)', [key(2026, 4, d), 3, 'seed', at(2026, 4, d)]);
  }
  await A.run('INSERT INTO daily_results (day, user_id, slug, created_at) VALUES (?, ?, ?, ?)', [key(2026, 4, 20), 4, 'seed', at(2026, 4, 20)]);
  const apr = await A.perfect(3, '2026-04', NOW);
  eq('四月 month = 2026-04', apr.month, '2026-04');
  eq('四月 total = 30', apr.total, 30);
  eq('四月 done = 30', apr.done, 30);
  eq('四月 perfect = true', apr.perfect, true);
  const may3 = await A.perfect(3, '2026-05', NOW);
  eq('五月 total = 20（只数到今天）', may3.total, 20);
  eq('五月 done = 0', may3.done, 0);
  eq('五月 perfect = false', may3.perfect, false);
  const jun = await A.perfect(3, '2026-06', NOW);
  eq('未来月 total = 0', jun.total, 0);
  eq('未来月 perfect = false', jun.perfect, false);
  const apr4 = await A.perfect(4, '2026-04', NOW);
  eq('缺一天 done = 1', apr4.done, 1);
  eq('缺一天 perfect = false', apr4.perfect, false);
  eq('month 不合法 → 退回当前月', (await A.perfect(3, 'garbage', NOW)).month, '2026-05');
  eq('month 空串 → 退回当前月', (await A.perfect(3, '', NOW)).month, '2026-05');
  const s5g = await A.stats(3, NOW);
  eq('老数据 total = 30', s5g.total, 30);
  eq('老数据 streak = 0（最近没打）', s5g.streak, 0);
  eq('老数据 makeupUsed = 0', s5g.makeupUsed, 0);
  ok('老数据 doneRows 的 doneDay 兜底成目标日', s5g.doneRows.every((r) => r.doneDay === r.day));
  eq('老数据落在日历窗口里的有 8 天（4-23..4-30）', s5g.calendar.cells.filter((c) => c.done).length, 8);

  /* ---------- H 上限与长连续 ---------- */
  console.log('--- H 上限 ---');
  for (let i = 69; i >= 0; i--) {
    await A.run('INSERT INTO daily_results (day, user_id, slug, created_at) VALUES (?, ?, ?, ?)', [back(i), 5, 'seed', at(2026, 5, 20)]);
  }
  const s6 = await A.stats(5, NOW);
  eq('连打 70 天 total = 70', s6.total, 70);
  eq('done 只给 60 条', s6.done.length, 60);
  eq('done[0] 是今天', s6.done[0], TODAY);
  eq('doneRows 给全 70 条', s6.doneRows.length, 70);
  eq('streak = 70', s6.streak, 70);
  eq('日历 28 格全 done', s6.calendar.cells.filter((c) => c.done).length, 28);
  eq('五月 perfect = true', s6.perfect.perfect, true);
  eq('五月 done = 20', s6.perfect.done, 20);

  /* ---------- I 徽章 / 档案口径 ---------- */
  console.log('--- I 徽章与档案 ---');
  const prof1 = await A.profile(1);
  eq('uid1 档案 daily = 3（补做也算完成）', prof1.daily, 3);
  ok('uid1 点亮 daily-first', (prof1.badges.find((b) => b.id === 'daily-first') || {}).done === true);
  ok('uid1 没点亮 daily-30', (prof1.badges.find((b) => b.id === 'daily-30') || {}).done === false);
  ok('uid1 没点亮 streak-7（补做不续连续）', (prof1.badges.find((b) => b.id === 'streak-7') || {}).done === false);
  const prof5 = await A.profile(5);
  eq('uid5 档案 daily = 70', prof5.daily, 70);
  ok('uid5 点亮 daily-30', (prof5.badges.find((b) => b.id === 'daily-30') || {}).done === true);

  /* ---------- J dailyBoard 回归 ---------- */
  console.log('--- J dailyBoard 回归 ---');
  const board = await A.board(TODAY);
  eq('今天打卡人数 = 2（uid1 自然打卡 + uid5 造的数据）', board.count, 2);
  ok('board.rows 带 username / name', board.rows.length === 2 && board.rows.every((r) => typeof r.username === 'string' && r.username.length > 0 && typeof r.name === 'string' && r.name.length > 0), JSON.stringify(board.rows));
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'game-site-daily-'));
  console.log('临时目录：' + tmp);
  console.log('基准时间：NOW = 2026-05-20（本地中午），今天 = ' + TODAY);
  try {
    const ex = await setupExpress(tmp);
    await runLine('express', ex.S, ex.db);
    const wk = await setupWorker(tmp);
    await runLine('worker', wk.S, wk.db);
  } catch (e) {
    fail++;
    console.log('  FAIL 测试执行中断 :: ' + (e && e.stack ? e.stack : e));
  }
  if (fail) {
    console.log('\n（临时目录保留以便排查：' + tmp + '）');
  } else {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      // Windows 上 sqlite 的句柄还开着时删不掉，留个空目录无害（系统会清 tmpdir）
      console.log('\n（临时目录没删掉，无害：' + tmp + '）');
    }
  }
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main();
