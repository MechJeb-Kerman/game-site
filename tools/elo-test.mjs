/**
 * Elo 评分 / 天梯 / 赛季（第九批）验收测试。
 *
 * 运行：node tools/elo-test.mjs
 * 前置：无。自己造临时库，不碰 data/games.db，不占端口，不发网络请求。
 *
 * 五段：
 *   A 纯函数：src/elo.js 的常量、K 分档、期望分、数值样例、下限、赛季、身份键、行归一。
 *   B 结算与天梯：真 play-store 的 settleRatings / ratingOf / ratingBoard 喂临时库（:memory:）。
 *   C Express 线端到端：把 src/ 整树复制到临时目录 —— src/db.js 的库路径由 import.meta.url 推出、
 *     没有环境变量开关，副本会把库建在 <tmp>/data/games.db，于是拿到一个真·临时库；跑它的
 *     migrate() 建全表、补跑 migrations/0010_elo.sql，再动态 import 副本的 play-store.js，
 *     真建房 / 真落子 / 真结算（7 手四子棋，房主横四连）。
 *   D Workers 线端到端：tools/d1-local.mjs 的 LocalD1 指向临时文件，跑 worker/schema.js 的
 *     migrate()，补跑 0010_elo.sql，加载 worker/play-store.js（第一个参数是 db 绑定、全程 await）。
 *   E 两条线同题同解：同一房间行喂两条线，结算返回值与天梯榜完全相同。
 *
 * 「现在」固定为 2026-10-20 09:48 UTC（赛季 2026-Q4），断言只依赖这个常量，与真实时钟无关。
 * 结尾打印「通过 N / 失败 M」，有失败逐条打印断言名与消息并 exit 1。
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as E from '../src/elo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** 0010 的建表语句（src/db.js migrate() 与 worker/schema.js 合入前，测试自己补跑一次；合入后重复执行也幂等） */
const MIG_ELO = readFileSync(join(ROOT, 'migrations', '0010_elo.sql'), 'utf8');

let pass = 0;
const fails = [];
const msg = (e) => (e && e.message ? e.message : String(e));
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(name + ' —— ' + msg(e));
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fails.push(name + ' —— ' + msg(e));
  }
}

/* 固定时间：T4 = 2026-10-20 09:48Z（赛季 2026-Q4）；T1 = 2026-Q1；T27 = 2027-Q1 */
const T4 = Date.UTC(2026, 9, 20, 9, 48);
const T1 = Date.UTC(2026, 0, 15);
const T27 = Date.UTC(2027, 1, 2);
const Q4 = '2026-Q4';
const Q1 = '2026-Q1';

/** 只建 Elo 两张表的临时 :memory: 库（跑的是真迁移文件） */
function eloDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(MIG_ELO);
  return d;
}
/** 一局已结束的房间行（settleRatings 只读这几个字段） */
function doneRoom(over) {
  return Object.assign(
    { id: 1, game: 'connect4', status: 'done', result: 'host', host_name: '甲', guest_name: '乙' },
    over || {}
  );
}
function ratingRowIn(d, key, game, season) {
  return d.prepare('SELECT * FROM player_ratings WHERE user_id = ? AND game = ? AND season = ?').get(key, game, season) || null;
}
function countOf(d, from) {
  return Number(d.prepare('SELECT COUNT(*) AS n FROM ' + from).get().n);
}
/** 把一段 SQL 文件拆成单条喂给假 D1（LocalD1 的 exec 按换行切，跨行 CREATE TABLE 会坏） */
async function applyMigration(db, sql) {
  const stmts = sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) await db.prepare(s).run();
}

/* ═══════════════════════ A 纯函数 ═══════════════════════ */

t('常量：起始分 1200 / 下限 100 / K 三档 40-24-16 / 赛季口径三种', () => {
  assert.equal(E.START_RATING, 1200);
  assert.equal(E.MIN_RATING, 100);
  assert.deepEqual(E.K_FACTORS, { NEW: 40, MID: 24, PRO: 16 });
  assert.deepEqual(E.K_TIERS.map((x) => x.under), [10, 30, Infinity]);
  assert.deepEqual(E.K_TIERS.map((x) => x.k), [40, 24, 16]);
  assert.equal(E.NAME_PREFIX, 'n:');
  assert.deepEqual(E.SEASON_UNITS, ['quarter', 'month', 'year']);
});

t('K 分档按已结算局数：<10 → 40、<30 → 24、否则 16（非法输入按 0）', () => {
  assert.equal(E.kFor(0), 40);
  assert.equal(E.kFor(9), 40);
  assert.equal(E.kFor(10), 24);
  assert.equal(E.kFor(29), 24);
  assert.equal(E.kFor(30), 16);
  assert.equal(E.kFor(9999), 16);
  assert.equal(E.kFor(9.9), 40);        // 向下取整
  assert.equal(E.kFor('12'), 24);       // 数字串按数字算
  assert.equal(E.kFor(-3), 40);
  assert.equal(E.kFor(undefined), 40);
  assert.equal(E.kFor(NaN), 40);
});

t('期望得分：同分 0.5、400 分差 ≈ 0.909、两者互补、非法输入不 NaN', () => {
  assert.equal(E.expectedScore(1200, 1200), 0.5);
  assert.ok(Math.abs(E.expectedScore(1600, 1200) - 0.9090909) < 1e-6, String(E.expectedScore(1600, 1200)));
  assert.ok(Math.abs(E.expectedScore(1200, 1600) - 0.0909090) < 1e-6, String(E.expectedScore(1200, 1600)));
  assert.ok(Math.abs(E.expectedScore(1600, 1200) + E.expectedScore(1200, 1600) - 1) < 1e-12);
  assert.equal(E.expectedScore(NaN, undefined), 0.5); // 两边都按 1200
  assert.ok(Number.isFinite(E.expectedScore('甲', {})));
});

t('同分对局 = K/2：K=40 → ±20、K=24 → ±12、K=16 → ±8（赢与输对称）', () => {
  const a = E.applyResult(1200, 1200, 1, { gamesA: 0, gamesB: 0 });
  assert.deepEqual([a.ra, a.rb, a.deltaA, a.deltaB], [1220, 1180, 20, -20]);
  const b = E.applyResult(1200, 1200, 1, { gamesA: 10, gamesB: 10 });
  assert.deepEqual([b.ra, b.rb, b.deltaA, b.deltaB], [1212, 1188, 12, -12]);
  const c = E.applyResult(1200, 1200, 1, { gamesA: 30, gamesB: 30 });
  assert.deepEqual([c.ra, c.rb, c.deltaA, c.deltaB], [1208, 1192, 8, -8]);
  const d = E.applyResult(1200, 1200, 0, { gamesA: 30, gamesB: 30 });
  assert.deepEqual([d.ra, d.rb, d.deltaA, d.deltaB], [1192, 1208, -8, 8]);
});

t('K 是每人一份：双方档位不同时一局的分数变化不是零和', () => {
  const r = E.applyResult(1200, 1200, 1, { gamesA: 0, gamesB: 30 });
  assert.deepEqual([r.ra, r.rb, r.deltaA, r.deltaB], [1220, 1192, 20, -8]);
  assert.notEqual(r.deltaA + r.deltaB, 0);
});

t('分差样例：1600 胜 1200 只 +1/-1；1200 爆冷胜 1600 +15/-15；1600 平 1200 -7/+7', () => {
  const win = E.applyResult(1600, 1200, 1, { gamesA: 50, gamesB: 50 });
  assert.deepEqual([win.ra, win.rb, win.deltaA, win.deltaB], [1601, 1199, 1, -1]);
  const upset = E.applyResult(1200, 1600, 1, { gamesA: 50, gamesB: 50 });
  assert.deepEqual([upset.ra, upset.rb, upset.deltaA, upset.deltaB], [1215, 1585, 15, -15]);
  const draw = E.applyResult(1600, 1200, 0.5, { gamesA: 50, gamesB: 50 });
  assert.deepEqual([draw.ra, draw.rb, draw.deltaA, draw.deltaB], [1593, 1207, -7, 7]);
});

t('评分下限 100：钳住时 delta 跟着变小，恒有 原分 + delta = 新分', () => {
  const r = E.applyResult(104, 100, 0, { gamesA: 0, gamesB: 0 });
  assert.equal(r.ra, 100);
  assert.equal(r.deltaA, -4);
  assert.equal(r.rb, 120);
  assert.equal(r.deltaB, 20);
  assert.equal(104 + r.deltaA, r.ra);
  assert.equal(100 + r.deltaB, r.rb);
  const floor = E.applyResult(100, 1200, 0, { gamesA: 40, gamesB: 40 });
  assert.equal(floor.ra, 100); // 已经在下限，再输也不掉
});

t('取整对称：镜像结果 +x/-x 一致（不会一边进一边舍）', () => {
  const a = E.applyResult(1237, 1191, 1, { gamesA: 7, gamesB: 11 });
  const b = E.applyResult(1191, 1237, 0, { gamesA: 11, gamesB: 7 });
  assert.deepEqual([a.ra, a.rb], [b.rb, b.ra]);
  assert.deepEqual([a.deltaA, a.deltaB], [b.deltaB, b.deltaA]);
});

t('非法输入不产生 NaN：applyResult(NaN, undefined, "x") 仍给合法整数', () => {
  const r = E.applyResult(NaN, undefined, 'x', {});
  assert.equal(r.ra, 1200); // 双方按 1200、'x' 按平局 → 不动
  assert.equal(r.rb, 1200);
  for (const k of ['ra', 'rb', 'deltaA', 'deltaB']) assert.ok(Number.isFinite(r[k]), k + '=' + r[k]);
});

t('赛季：UTC 自然季度；跨季边界 / 非法时间戳 / 三种 unit', () => {
  assert.equal(E.seasonOf(T4), Q4);
  assert.equal(E.seasonOf(T1), Q1);
  assert.equal(E.seasonOf(T27), '2027-Q1');
  assert.equal(E.seasonOf(Date.UTC(2026, 2, 31, 23, 59, 59)), '2026-Q1'); // 3/31 还在 Q1
  assert.equal(E.seasonOf(Date.UTC(2026, 3, 1, 0, 0, 0)), '2026-Q2');    // 4/1 起 Q2
  assert.equal(E.seasonOf(Date.UTC(2026, 11, 31, 23, 59, 59)), '2026-Q4');
  assert.equal(E.seasonOf(Date.UTC(2027, 0, 1, 0, 0, 0)), '2027-Q1');
  assert.equal(E.seasonOf(T4, { unit: 'month' }), '2026-10');
  assert.equal(E.seasonOf(Date.UTC(2026, 0, 9), { unit: 'month' }), '2026-01'); // 个位数补零
  assert.equal(E.seasonOf(T4, { unit: 'year' }), '2026');
  assert.equal(E.seasonOf(undefined), '1970-Q1'); // 非法 → 按 0
  assert.equal(E.seasonOf(NaN), '1970-Q1');
  assert.equal(E.seasonOf('abc'), '1970-Q1');
});

t('身份键：NFKC + 折叠空白 + 小写；空昵称 → 空串；keyName 还原展示名', () => {
  assert.equal(E.playerKey('张三'), 'n:张三');
  assert.equal(E.playerKey('  Zhang San  '), 'n:zhang san');
  assert.equal(E.playerKey('ZHANG   SAN'), E.playerKey('zhang san'));
  assert.equal(E.playerKey('张三\u3000李四'), 'n:张三 李四'); // 全角空格折成半角空格
  assert.equal(E.playerKey('Ａ Ｂ'), 'n:a b');              // 全角字母 NFKC 成半角
  assert.equal(E.playerKey(''), '');
  assert.equal(E.playerKey('   '), '');
  assert.equal(E.playerKey(null), '');
  assert.equal(E.playerKey(undefined), '');
  assert.equal(E.keyName('n:张三'), '张三');
  assert.equal(E.keyName('123'), '123'); // 账号 id 原样
  assert.equal(E.keyName(''), '');
});

t('blankRating：完整 11 键，1200 / 0 局 / peak 1200 / username 空', () => {
  const b = E.blankRating('n:甲', 'connect4', Q4);
  assert.deepEqual(
    Object.keys(b).sort(),
    ['userId', 'game', 'season', 'username', 'rating', 'games', 'wins', 'losses', 'draws', 'peak', 'updatedAt'].sort()
  );
  assert.deepEqual(b, {
    userId: 'n:甲', game: 'connect4', season: Q4, username: '',
    rating: 1200, games: 0, wins: 0, losses: 0, draws: 0, peak: 1200, updatedAt: 0
  });
});

t('normRating：认 snake_case 与 camelCase，计数负数归 0，peak 不低于当前分', () => {
  const base = E.blankRating('n:甲', 'connect4', Q4);
  assert.deepEqual(E.normRating(null, base), base);
  const row = E.normRating(
    { user_id: 'n:甲', game: 'connect4', season: Q4, rating: 1300.7, games: '3', wins: 2, losses: 1, draws: 0, peak: 1200, updated_at: 111 },
    base
  );
  assert.equal(row.rating, 1301);
  assert.equal(row.games, 3);
  assert.equal(row.peak, 1301); // 行里的 peak 低于当前分 → 抬到当前分
  assert.equal(row.updatedAt, 111);
  const low = E.normRating({ userId: 'n:乙', rating: -5, games: -2, losses: -1 }, base);
  assert.equal(low.rating, -5); // rating 不钳（下限由 applyResult 保证）
  assert.equal(low.games, 0);
  assert.equal(low.losses, 0);
  assert.equal(low.peak, 1200); // 行里没有 peak → 用底，且不低于当前分
  const camel = E.normRating({ userId: 'n:丙', rating: 1000, games: 5, peak: 1100 }, base);
  assert.equal(camel.userId, 'n:丙');
  assert.equal(camel.season, Q4); // 行里没有 → 用底的赛季
  assert.equal(camel.peak, 1100);
});

t('nextRatings：局数 +1、胜负平各自 +1、peak 只升不降；result 非法回 null', () => {
  assert.equal(E.nextRatings(null, null, 'x'), null);
  assert.equal(E.nextRatings(null, null, ''), null);
  assert.equal(E.nextRatings(null, null, null), null);
  const a = E.blankRating('n:甲', 'connect4', Q4);
  const b = E.blankRating('n:乙', 'connect4', Q4);
  const first = E.nextRatings(a, b, 'host');
  assert.deepEqual(
    [first.host.rating, first.guest.rating, first.hostDelta, first.guestDelta, first.scoreHost],
    [1220, 1180, 20, -20, 1]
  );
  assert.equal(first.host.games, 1);
  assert.equal(first.host.wins, 1);
  assert.equal(first.host.losses, 0);
  assert.equal(first.host.peak, 1220);
  assert.equal(first.guest.losses, 1);
  assert.equal(first.guest.peak, 1200); // 输的人峰值不降
  const second = E.nextRatings(first.host, first.guest, 'draw');
  assert.equal(second.scoreHost, 0.5);
  assert.equal(second.host.games, 2);
  assert.equal(second.host.draws, 1);
  assert.equal(second.host.wins, 1);
  assert.equal(1220 + second.hostDelta, second.host.rating); // delta 与实际生效量一致
  const third = E.nextRatings(first.host, first.guest, 'guest');
  assert.equal(third.guest.wins, 1);
  assert.equal(third.host.losses, 1);
  assert.equal(third.guest.games, 2);
});

t('ratingRow / ratingRows：天梯行恰好 10 键、rank 从 1 连续、username 从身份键还原', () => {
  const rows = E.ratingRows([
    { user_id: 'n:甲', rating: 1300, games: 5, wins: 4, losses: 1, draws: 0, peak: 1350 },
    { user_id: 'n:乙', rating: 1200, games: 3, wins: 1, losses: 2, draws: 0, peak: 1220, username: '乙同学' }
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['rank', 'userId', 'username', 'rating', 'games', 'wins', 'losses', 'draws', 'peak'].sort()
  );
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
  assert.equal(rows[0].username, '甲');       // 行里没有展示名 → 从身份键还原
  assert.equal(rows[1].username, '乙同学');   // 行里带了就用行里的
  assert.deepEqual(E.ratingRows(null), []);
  assert.deepEqual(E.ratingRows([]), []);
});

/* ═══════════════════════ 两条线的装载（C / D 段前置） ═══════════════════════ */

let tmp = '';
let store = null;   // Express 线：临时副本的 play-store.js
let sdb = null;     // Express 线：副本的 db 单例（库在 <tmp>/data/games.db）
let W = null;       // Workers 线：worker/play-store.js
let wdb = null;     // Workers 线：LocalD1（临时文件）

async function main() {
  try {
    /* ---------- Express 线：复制 src/ 到临时目录，拿到真·临时库 ---------- */
    tmp = mkdtempSync(join(tmpdir(), 'elo-test-'));
    mkdirSync(join(tmp, 'public'), { recursive: true });
    mkdirSync(join(tmp, 'games'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
    const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
    dbmod.migrate();          // 建全表（含 play_rooms / play_moves / play_replays）
    dbmod.db.exec(MIG_ELO);   // 补跑 0010：合入 migrate() 之前必须有这一步，合入后重复执行也幂等
    sdb = dbmod.db;
    store = await import(pathToFileURL(join(tmp, 'src', 'play-store.js')).href);

    /* ---------- Workers 线：LocalD1 + 真 worker/schema.js ---------- */
    const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
    const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
    wdb = new LocalD1(join(tmp, 'd1.db'));
    await schema.migrate(wdb);
    await applyMigration(wdb, MIG_ELO);
    W = await import(pathToFileURL(join(ROOT, 'worker', 'play-store.js')).href);

    /* ═══════════════════════ B 结算与天梯 ═══════════════════════ */

    await ta('结算第一局：1 条历史 + 2 行评分（首局 K=40 → ±20），赛季按结算时间算', () => {
      const d = eloDb();
      const res = store.settleRatings(d, doneRoom({ id: 11 }), T4);
      assert.equal(res.settled, true);
      assert.equal(res.reason, '');
      assert.equal(res.season, Q4);
      assert.deepEqual([res.hostDelta, res.guestDelta, res.hostAfter, res.guestAfter], [20, -20, 1220, 1180]);
      assert.equal(countOf(d, 'elo_history'), 1);
      assert.equal(countOf(d, 'player_ratings'), 2);
      const h = ratingRowIn(d, 'n:甲', 'connect4', Q4);
      const g = ratingRowIn(d, 'n:乙', 'connect4', Q4);
      assert.equal(h.rating, 1220);
      assert.equal(h.games, 1);
      assert.equal(h.wins, 1);
      assert.equal(h.losses, 0);
      assert.equal(h.draws, 0);
      assert.equal(h.peak, 1220);
      assert.equal(h.updated_at, T4);
      assert.equal(g.rating, 1180);
      assert.equal(g.losses, 1);
      assert.equal(g.peak, 1200); // 输的人峰值不降
      const hist = d.prepare('SELECT * FROM elo_history ORDER BY id').all()[0];
      assert.equal(hist.room_id, 11);
      assert.equal(hist.game, 'connect4');
      assert.equal(hist.season, Q4);
      assert.equal(hist.host_id, 'n:甲');
      assert.equal(hist.guest_id, 'n:乙');
      assert.equal(hist.host_delta, 20);
      assert.equal(hist.guest_delta, -20);
      assert.equal(hist.host_after, 1220);
      assert.equal(hist.guest_after, 1180);
      assert.equal(hist.result, 'host');
      assert.equal(hist.created_at, T4);
      d.close();
    });

    await ta('结算幂等：同一房间再结一次 → duplicate，行数与分数都不变', () => {
      const d = eloDb();
      store.settleRatings(d, doneRoom({ id: 12 }), T4);
      const again = store.settleRatings(d, doneRoom({ id: 12 }), T4);
      assert.equal(again.settled, false);
      assert.equal(again.reason, 'duplicate');
      assert.equal(countOf(d, 'elo_history'), 1);
      assert.equal(countOf(d, 'player_ratings'), 2);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).rating, 1220);
      d.close();
    });

    await ta('结算门禁：非裁判棋类 / 没结束 / 没结果 / 空昵称 / 归一后同名 / 房间号非法 → 一律不写库', () => {
      const d = eloDb();
      assert.equal(store.settleRatings(d, doneRoom({ id: 21, game: 'junqi' }), T4).reason, 'not_judged'); // 军棋没注册裁判；chess / xiangqi 已在第四批接入，不能再当「非裁判」样本
      assert.equal(store.settleRatings(d, doneRoom({ id: 22, status: 'playing' }), T4).reason, 'not_done');
      assert.equal(store.settleRatings(d, doneRoom({ id: 23, result: '' }), T4).reason, 'no_result');
      assert.equal(store.settleRatings(d, doneRoom({ id: 24, result: 'nobody' }), T4).reason, 'no_result');
      assert.equal(store.settleRatings(d, doneRoom({ id: 25, host_name: '' }), T4).reason, 'bad_players');
      assert.equal(store.settleRatings(d, doneRoom({ id: 26, guest_name: '   ' }), T4).reason, 'bad_players');
      assert.equal(store.settleRatings(d, doneRoom({ id: 27, host_name: '甲', guest_name: ' 甲 ' }), T4).reason, 'bad_players');
      assert.equal(store.settleRatings(d, doneRoom({ id: 0 }), T4).reason, 'bad_room');
      assert.equal(store.settleRatings(d, doneRoom({ id: 'abc' }), T4).reason, 'bad_room');
      assert.equal(store.settleRatings(d, null, T4).reason, 'not_judged');
      assert.equal(countOf(d, 'elo_history'), 0);
      assert.equal(countOf(d, 'player_ratings'), 0);
      d.close();
    });

    await ta('赛季独立：下一季重新从 1200 起（局数也重算 → 又是 K=40），旧赛季记录保留', () => {
      const d = eloDb();
      store.settleRatings(d, doneRoom({ id: 31 }), T4);       // 2026-Q4：1220 / 1180
      const q1 = store.settleRatings(d, doneRoom({ id: 32 }), T1); // 2026-Q1：也 ±20（不是 ±12）
      assert.equal(q1.season, Q1);
      assert.deepEqual([q1.hostDelta, q1.guestDelta], [20, -20]);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q1).rating, 1220);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).rating, 1220);
      assert.equal(countOf(d, 'player_ratings'), 4); // 2 人 × 2 赛季
      assert.equal(countOf(d, 'elo_history'), 2);
      d.close();
    });

    await ta('同赛季连打：局数累积、胜负记账、peak 只升不降；局数到 10 后 K 变 24（同分 ±12）', () => {
      const d = eloDb();
      store.settleRatings(d, doneRoom({ id: 41, result: 'host' }), T4);
      // 第二局是在 1220 vs 1180 上打的：同分 ±20 的直觉不成立，期望分 0.557 → 变化量 ±22
      const r2 = store.settleRatings(d, doneRoom({ id: 42, result: 'guest' }), T4);
      assert.deepEqual([r2.hostDelta, r2.guestDelta, r2.hostAfter, r2.guestAfter], [-22, 22, 1198, 1202]);
      const h = ratingRowIn(d, 'n:甲', 'connect4', Q4);
      assert.equal(h.games, 2);
      assert.equal(h.wins, 1);
      assert.equal(h.losses, 1);
      assert.equal(h.peak, 1220); // 峰值留在第一局的 1220
      // 把两边摆到第 10 局（K 档边界）再打：同分 → ±12
      for (const key of ['n:甲', 'n:乙']) {
        d.prepare('UPDATE player_ratings SET games = 10, rating = 1200 WHERE user_id = ? AND game = ? AND season = ?').run(key, 'connect4', Q4);
      }
      const r3 = store.settleRatings(d, doneRoom({ id: 43, result: 'draw' }), T4);
      assert.deepEqual([r3.hostDelta, r3.guestDelta, r3.hostAfter, r3.guestAfter], [0, 0, 1200, 1200]); // 同分平局不动
      const r4 = store.settleRatings(d, doneRoom({ id: 44, result: 'host' }), T4);
      assert.deepEqual([r4.hostDelta, r4.guestDelta], [12, -12]);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).games, 12);
      d.close();
    });

    await ta('评分下限落在库里：102 分输一局被钳在 100，delta 记实际生效量 -2', () => {
      const d = eloDb();
      d.prepare('INSERT INTO player_ratings (user_id, game, season, rating, games, wins, losses, draws, peak, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)')
        .run('n:甲', 'connect4', Q4, 102, 102, T1);
      d.prepare('INSERT INTO player_ratings (user_id, game, season, rating, games, wins, losses, draws, peak, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)')
        .run('n:乙', 'connect4', Q4, 100, 100, T1);
      const res = store.settleRatings(d, doneRoom({ id: 51, result: 'guest' }), T4);
      assert.equal(res.hostAfter, 100);
      assert.equal(res.hostDelta, -2);
      assert.equal(res.guestAfter, 120);
      assert.equal(res.guestDelta, 20);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).rating, 100);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).peak, 102);
      assert.equal(ratingRowIn(d, 'n:甲', 'connect4', Q4).losses, 1);
      assert.equal(102 + res.hostDelta, res.hostAfter);
      d.close();
    });

    await ta('结算失败不抛异常：库里没有表 → reason=error，只打一行日志（不影响落子返回）', () => {
      const empty = new DatabaseSync(':memory:');
      const logs = [];
      const orig = console.error;
      console.error = (...a) => logs.push(a.join(' '));
      let res = null;
      try {
        res = store.settleRatings(empty, doneRoom({ id: 61 }), T4);
      } finally {
        console.error = orig;
      }
      assert.equal(res.settled, false);
      assert.equal(res.reason, 'error');
      assert.equal(logs.length, 1, JSON.stringify(logs));
      assert.ok(logs[0].indexOf('[elo] 结算失败 room=61 game=connect4') === 0, logs[0]);
      empty.close();
    });

    await ta('并发兜底：elo_history.room_id 的 UNIQUE 索引真的在（抢先插入后 → duplicate，不动分数）', () => {
      const d = eloDb();
      d.prepare('INSERT INTO elo_history (room_id, game, season, host_id, guest_id, host_delta, guest_delta, host_after, guest_after, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(71, 'connect4', Q4, 'n:甲', 'n:乙', 20, -20, 1220, 1180, 'host', T4);
      const res = store.settleRatings(d, doneRoom({ id: 71 }), T4);
      assert.equal(res.settled, false);
      assert.equal(res.reason, 'duplicate');
      assert.equal(countOf(d, 'elo_history'), 1);
      assert.equal(countOf(d, 'player_ratings'), 0);
      assert.throws(
        () => d.prepare('INSERT INTO elo_history (room_id, game, season, host_id, guest_id) VALUES (?, ?, ?, ?, ?)').run(71, 'connect4', Q4, 'n:甲', 'n:乙'),
        /UNIQUE/i
      );
      d.close();
    });

    await ta('ratingOf：没记录返回起始行且不写库；有记录返回整行；游戏标识大小写不敏感', () => {
      const d = eloDb();
      const blank = store.ratingOf(d, 'connect4', 'n:新人', Q4);
      assert.equal(blank.userId, 'n:新人');
      assert.equal(blank.rating, 1200);
      assert.equal(blank.games, 0);
      assert.equal(blank.peak, 1200);
      assert.equal(blank.username, '');
      assert.equal(countOf(d, 'player_ratings'), 0);
      store.settleRatings(d, doneRoom({ id: 81 }), T4);
      assert.equal(store.ratingOf(d, 'connect4', 'n:甲', Q4).rating, 1220);
      assert.equal(store.ratingOf(d, 'CONNECT4', 'n:甲', Q4).rating, 1220);
      assert.equal(store.ratingOf(d, 'connect4', 'n:甲').season, E.seasonOf(Date.now())); // 省略赛季 = 当前赛季
      assert.equal(store.ratingOf(d, 'connect4', '', Q4).rating, 1200);
      assert.equal(store.ratingOf(d, 'BAD GAME', 'n:甲', Q4).rating, 1200);
      d.close();
    });

    await ta('ratingBoard：分数降序、同分比局数、rank 从 1 连续、total 不受 limit 影响', () => {
      const d = eloDb();
      store.settleRatings(d, doneRoom({ id: 91, host_name: '甲', guest_name: '乙', result: 'host' }), T4);
      d.prepare('INSERT INTO player_ratings (user_id, game, season, rating, games, wins, losses, draws, peak, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('n:丙', 'connect4', Q4, 1220, 3, 2, 1, 0, 1250, T4);
      const board = store.ratingBoard(d, 'connect4', Q4, 50);
      assert.equal(board.game, 'connect4');
      assert.equal(board.season, Q4);
      assert.equal(board.total, 3);
      assert.deepEqual(board.items.map((r) => r.userId), ['n:丙', 'n:甲', 'n:乙']); // 同分 1220：局数多的在前
      assert.deepEqual(board.items.map((r) => r.rank), [1, 2, 3]);
      assert.equal(board.items[0].peak, 1250);
      assert.equal(board.items[1].username, '甲'); // 从身份键还原展示名
      assert.equal(board.items[2].rating, 1180);
      const one = store.ratingBoard(d, 'connect4', Q4, 1);
      assert.equal(one.items.length, 1);
      assert.equal(one.total, 3); // total 是赛季总人数，不受 limit 影响
      assert.equal(store.ratingBoard(d, 'connect4', Q4, -5).items.length, 1);   // limit 下限钳到 1
      assert.equal(store.ratingBoard(d, 'connect4', Q4, 9999).items.length, 3); // 上限钳到 200 不影响小榜
      assert.equal(store.ratingBoard(d, 'BAD GAME', Q4).total, 0);
      assert.deepEqual(store.ratingBoard(d, 'BAD GAME', Q4).items, []);
      assert.equal(store.ratingBoard(d, 'connect4', Q1).total, 0); // 别的赛季空榜
      d.close();
    });

    /* ═══════════════════════ C Express 线端到端 ═══════════════════════ */

    await ta('Express 端到端：真建房 / 真加入 / 7 手四子棋房主横四连 → 自动结算 ±20 并存棋谱', () => {
      const HK = E.playerKey('Elo甲');
      const GK = E.playerKey('Elo乙');
      const host = store.createRoom('connect4', 'Elo甲', T4);
      assert.ok(host && host.room && host.token, '建房失败：' + JSON.stringify(host));
      const guest = store.joinRoom(host.room.code, 'Elo乙', T4 + 1000);
      assert.ok(guest && guest.room && guest.token, '加入失败：' + JSON.stringify(guest));
      const id = Number(sdb.prepare('SELECT id FROM play_rooms WHERE code = ?').get(host.room.code).id);
      const moves = [[0, '0'], [1, '0'], [0, '1'], [1, '1'], [0, '2'], [1, '2'], [0, '3']];
      let last = null;
      for (const [seat, mv] of moves) last = store.sendMove(id, seat === 0 ? host.token : guest.token, mv, '', T4 + 2000);
      assert.equal(last.error, undefined, 'sendMove 被拒：' + JSON.stringify(last));
      assert.equal(last.seq, 7);
      assert.equal(last.finished, true);
      assert.equal(last.result, 'host');
      assert.ok(last.replayId > 0, 'replayId=' + last.replayId); // saveReplay 必须在取 after 之前，否则这里是 0
      const room = sdb.prepare('SELECT * FROM play_rooms WHERE id = ?').get(id);
      assert.equal(room.status, 'done');
      assert.equal(Number(room.replay_id), last.replayId);
      assert.equal(Number(sdb.prepare('SELECT COUNT(*) AS n FROM play_replays WHERE room_code = ?').get(host.room.code).n), 1);
      assert.equal(Number(sdb.prepare('SELECT COUNT(*) AS n FROM play_moves WHERE room_id = ?').get(id).n), 7);
      const h = ratingRowIn(sdb, HK, 'connect4', Q4);
      const g = ratingRowIn(sdb, GK, 'connect4', Q4);
      assert.equal(h.rating, 1220);
      assert.equal(h.games, 1);
      assert.equal(h.wins, 1);
      assert.equal(g.rating, 1180);
      assert.equal(g.losses, 1);
      const hist = sdb.prepare('SELECT * FROM elo_history WHERE room_id = ?').get(id);
      assert.equal(hist.result, 'host');
      assert.equal(hist.season, Q4);
      assert.equal(hist.host_delta, 20);
      assert.equal(hist.guest_after, 1180);
      const board = store.ratingBoard(sdb, 'connect4', Q4, 50);
      assert.equal(board.total, 2);
      assert.equal(board.items[0].userId, HK);
      assert.equal(board.items[0].rating, 1220);
      assert.equal(board.items[0].username, 'elo甲'); // 展示名从归一后的身份键还原（小写）
      // 同一房间再结一次：幂等
      assert.equal(store.settleRatings(sdb, room, T4).reason, 'duplicate');
    });

    await ta('Express 端到端（认输也结算）：新开一局五子棋，房主认输 → 挑战者 +20', () => {
      const HK = E.playerKey('Elo丙');
      const GK = E.playerKey('Elo丁');
      const host = store.createRoom('gomoku', 'Elo丙', T4 + 3000);
      const guest = store.joinRoom(host.room.code, 'Elo丁', T4 + 4000);
      assert.ok(guest && guest.token, '加入失败：' + JSON.stringify(guest));
      const id = Number(sdb.prepare('SELECT id FROM play_rooms WHERE code = ?').get(host.room.code).id);
      const res = store.resign(id, host.token, T4 + 5000);
      assert.equal(res.error, undefined, JSON.stringify(res));
      assert.equal(res.room.status, 'done');
      assert.equal(res.room.result, 'guest');
      const g = ratingRowIn(sdb, GK, 'gomoku', Q4);
      const h = ratingRowIn(sdb, HK, 'gomoku', Q4);
      assert.equal(g.rating, 1220);
      assert.equal(g.wins, 1);
      assert.equal(h.rating, 1180);
      assert.equal(h.losses, 1);
      assert.equal(Number(sdb.prepare('SELECT COUNT(*) AS n FROM elo_history WHERE room_id = ?').get(id).n), 1);
    });

    /* ═══════════════════════ D Workers 线端到端 ═══════════════════════ */

    await ta('Workers 端到端：LocalD1 临时库跑同一局，落库与 Express 一致（±20、棋谱 id、幂等）', async () => {
      const HK = E.playerKey('W甲');
      const GK = E.playerKey('W乙');
      const host = await W.createRoom(wdb, 'connect4', 'W甲', T4);
      assert.ok(host && host.room && host.token, '建房失败：' + JSON.stringify(host));
      const guest = await W.joinRoom(wdb, host.room.code, 'W乙', T4 + 1000);
      assert.ok(guest && guest.room && guest.token, '加入失败：' + JSON.stringify(guest));
      const row = await wdb.prepare('SELECT id FROM play_rooms WHERE code = ?').bind(host.room.code).first();
      const id = Number(row.id);
      const moves = [[0, '0'], [1, '0'], [0, '1'], [1, '1'], [0, '2'], [1, '2'], [0, '3']];
      let last = null;
      for (const [seat, mv] of moves) last = await W.sendMove(wdb, id, seat === 0 ? host.token : guest.token, mv, '', T4 + 2000);
      assert.equal(last.error, undefined, 'sendMove 被拒：' + JSON.stringify(last));
      assert.equal(last.seq, 7);
      assert.equal(last.finished, true);
      assert.equal(last.result, 'host');
      assert.ok(last.replayId > 0, 'replayId=' + last.replayId);
      const hist = await wdb.prepare('SELECT * FROM elo_history WHERE room_id = ?').bind(id).first();
      assert.ok(hist, '没有结算历史');
      assert.equal(hist.season, Q4);
      assert.equal(hist.result, 'host');
      assert.equal(hist.host_delta, 20);
      assert.equal(hist.host_after, 1220);
      assert.equal(hist.guest_after, 1180);
      const h = await W.ratingOf(wdb, 'connect4', HK, Q4);
      assert.equal(h.rating, 1220);
      assert.equal(h.games, 1);
      assert.equal(h.wins, 1);
      // ratingOf 回的是 player_ratings 的原始行（表里没有展示名列）→ username 是空串；
      // 展示名只在 ratingBoard 的行里由身份键还原（见上面 Express 那一处断言）
      assert.equal(h.username, '');
      const board = await W.ratingBoard(wdb, 'connect4', Q4, 50);
      assert.equal(board.total, 2);
      assert.deepEqual(board.items.map((r) => r.rank), [1, 2]);
      assert.equal(board.items[0].rating, 1220);
      // 幂等：同一房间再结一次
      const roomRow = await wdb.prepare('SELECT * FROM play_rooms WHERE id = ?').bind(id).first();
      const again = await W.settleRatings(wdb, roomRow, T4 + 3000);
      assert.equal(again.reason, 'duplicate');
      assert.equal(await countOfD1(wdb, 'SELECT COUNT(*) AS n FROM elo_history'), 1);
    });

    /* ═══════════════════════ E 同题同解 ═══════════════════════ */

    await ta('两条线同题同解：同一房间行喂进去，结算返回值与天梯榜完全相同', async () => {
      const room = doneRoom({ id: 991, host_name: '甲', guest_name: '乙' });
      const rd = eloDb();
      const rex = store.settleRatings(rd, room, T27);
      const wd = new LocalD1('');
      await applyMigration(wd, MIG_ELO);
      const rwk = await W.settleRatings(wd, room, T27);
      assert.equal(rex.settled, true);
      assert.deepEqual(rwk, rex);
      assert.equal(rex.season, '2027-Q1');
      const bx = store.ratingBoard(rd, 'connect4', '2027-Q1', 50);
      const bw = await W.ratingBoard(wd, 'connect4', '2027-Q1', 50);
      assert.deepEqual(bw, bx);
      const ox = store.ratingOf(rd, 'connect4', 'n:甲', '2027-Q1');
      const ow = await W.ratingOf(wd, 'connect4', 'n:甲', '2027-Q1');
      assert.deepEqual(ow, ox);
      assert.equal(ox.rating, 1220);
      rd.close();
      wd.close();
    });
  } finally {
    try { if (sdb) sdb.close(); } catch (e) { /* 忽略 */ }
    try { if (wdb) wdb.close(); } catch (e) { /* 忽略 */ }
    try { if (tmp) rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/** LocalD1 上取一个标量（假的 D1 用 first() 取行） */
async function countOfD1(db, sql) {
  const row = await db.prepare(sql).first();
  return Number((row && row.n) || 0);
}

main()
  .then(() => {
    if (fails.length) for (const f of fails) console.log('FAIL ' + f);
    console.log('通过 ' + pass + ' / 失败 ' + fails.length);
    process.exit(fails.length ? 1 : 0);
  })
  .catch((e) => {
    console.error('测试脚本自身出错：' + msg(e));
    process.exit(1);
  });
