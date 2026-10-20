/**
 * 每日奖励流水表（user_rewards）回归测试 —— src/rewards.js 的流水一节 + worker/rewards.js 镜像。
 *
 * 临时环境纪律（不碰真库、不占端口）：
 *   · Express 线：把 src/ 整树复制到系统临时目录的副本里跑，副本自带 data/；走
 *     src/rewards.js 的「自动开库」默认路径（一个连接都不注入），所以被写的是
 *     <副本>/data/games.db，真库 D:/CODE/game-site/data/games.db 全程不打开。
 *   · Worker 线：tools/d1-local.mjs 的 LocalD1(':memory:') + worker/rewards.js，不落盘。
 *   · 两条线共用同一个 suite 函数、同一批断言，最后逐字段比对两线返回值，防镜像漂移。
 *
 * 跑：node tools/rewards-ledger-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LocalD1 } from './d1-local.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_DB = path.join(REPO, 'data', 'games.db');
const W = 86400000;
const N1 = 1772000000000; // 固定时间戳：两条线的 created_at / now 完全一致，输出可逐字节比对
const N2 = N1 + 26 * W;
const N3 = N1 + 56 * W;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) pass += 1;
  else fail += 1;
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || extra === undefined ? '' : ' -> ' + extra));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, 'got ' + a + ' want ' + b);
}
function head(text) {
  console.log('\n== ' + text + ' ==');
}

/** 系统临时目录兜底：run_code 里 process.env 是空对象时 os.tmpdir() 会给相对路径 */
function tempBase() {
  let base = '';
  try {
    base = os.tmpdir();
  } catch (err) {
    base = '';
  }
  if (!base || !path.isAbsolute(base)) base = 'C:\\Windows\\Temp';
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/* ------------------------------------------------------------------ *
 * 两条线：同一组 API，同一种调用形状（Express 同步 / Worker await，都用 await 吃）
 * ------------------------------------------------------------------ */
function expressAdapter(mod, store) {
  return {
    kind: 'express',
    ddl: mod.REWARD_LEDGER_DDL,
    sql: mod.REWARD_LEDGER_SQL,
    snapshotXp: mod.rewardXp,
    ensure: () => mod.ensureLedger(),
    grant: (uid, stats, opts) => mod.grantRewards(uid, stats, opts),
    grantTier: (uid, tier, stats, opts) => mod.grantTier(uid, tier, stats, opts),
    due: (uid, stats, opts) => mod.dueRewards(uid, stats, opts),
    tiers: (uid) => mod.ledgerTiers(uid),
    list: (uid, opts) => mod.listLedger(uid, opts),
    summary: (uid) => mod.ledgerSummary(uid),
    raw: (sql, params) => store.prepare(sql).all(...(params || [])),
    run: (sql, params) => {
      const r = store.prepare(sql).run(...(params || []));
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid || 0) };
    }
  };
}

function workerAdapter(mod, db, snapshotXp) {
  return {
    kind: 'worker',
    ddl: mod.REWARD_LEDGER_DDL,
    sql: mod.REWARD_LEDGER_SQL,
    snapshotXp: snapshotXp,
    ensure: () => mod.ensureLedger(db),
    grant: (uid, stats, opts) => mod.grantRewards(db, uid, stats, opts),
    grantTier: (uid, tier, stats, opts) => mod.grantTier(db, uid, tier, stats, opts),
    due: (uid, stats, opts) => mod.dueRewards(db, uid, stats, opts),
    tiers: (uid) => mod.ledgerTiers(db, uid),
    list: (uid, opts) => mod.listLedger(db, uid, opts),
    summary: (uid) => mod.ledgerSummary(db, uid),
    raw: async (sql, params) => (await db.prepare(sql).bind(...(params || [])).all()).results,
    run: async (sql, params) => {
      const r = await db.prepare(sql).bind(...(params || [])).run();
      return { changes: Number(r.meta.changes), id: Number(r.meta.last_row_id || 0) };
    }
  };
}

const ROW_COLS = ['id', 'user_id', 'day', 'tier', 'kind', 'amount', 'title', 'month', 'need', 'value', 'created_at'];
const IDX_NAMES = ['idx_user_rewards_day', 'idx_user_rewards_grant', 'idx_user_rewards_once', 'idx_user_rewards_user'];
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/** 两线共用的全部断言；log 收集原始返回值，跑完逐字节比对 */
async function suite(label, api, log) {
  const raw = api.raw;
  const count = async (uid) => Number((await raw('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = ?', [uid]))[0].n);

  head(label + ' 建表 / 索引 / 空账');
  ok(label + ' ensureLedger 有库（返回连接本身，供测试直接查）', !!(await api.ensure()));
  const ddlOneLine = api.ddl.filter((s) => s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0).length;
  eq(label + ' DDL 5 条、每条单行（D1 的 exec 按换行切语句）', [api.ddl.length, ddlOneLine, api.ddl.every((s) => s.trim().slice(0, 6).toUpperCase() === 'CREATE')], [5, 0, true]);
  const idx = (await raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_rewards' ORDER BY name")).map((r) => r.name);
  eq(label + ' 四个索引都建出来了', idx, IDX_NAMES);
  await api.ensure();
  await api.ensure();
  const e0 = await api.list(199, {});
  const s0 = await api.summary(199);
  const t0 = await api.tiers(199);
  eq(label + ' 空账：total 0 / items 空 / 不报错（重复 ensure 没副作用）', [e0.ok, e0.error, e0.total, e0.items.length, s0.ok, s0.total, s0.xp, s0.days, s0.first_day, s0.tiers.length, t0.ok, t0.total, t0.keys.length], [true, '', 0, 0, true, 0, 0, 0, '', 0, true, 0, 0]);

  head(label + ' 首次发档 / 重复调用幂等');
  const g1 = await api.grant(101, { streak: 7, total: 10 }, { day: '2026-03-05', now: N1 });
  eq(label + ' 首次发档：seen 1 / added 1 / xp 100 / error 空', [g1.ok, g1.error, g1.seen, g1.added, g1.already, g1.xp], [true, '', 1, 1, false, 100]);
  eq(label + ' 首次发档：granted 只有 streak-7、没 reach 的不发', [g1.granted.length, g1.granted.map((i) => i.tier).join(','), g1.granted[0].month, g1.granted[0].amount, g1.granted[0].need, g1.granted[0].value, g1.granted[0].paid], [1, 'streak-7', '', 100, 7, 7, false]);
  eq(label + ' 首次发档：行上带发放日 / 毫秒时间戳 / 自增 id', [g1.granted[0].day, g1.granted[0].created_at, g1.granted[0].id > 0, g1.granted[0].added], ['2026-03-05', N1, true, true]);
  eq(label + ' 首次发档：summary 跟着动', [g1.summary.total, g1.summary.xp, g1.summary.owned, g1.summary.days, g1.summary.first_day, g1.summary.last_day, g1.summary.first_at, g1.summary.last_at], [1, 100, 1, 1, '2026-03-05', '2026-03-05', N1, N1]);
  const l1 = await api.list(101, {});
  eq(label + ' 首次发档：账上一行，11 列齐全且无多余列', [l1.ok, l1.total, l1.items.length, Object.keys(l1.items[0]).join(','), l1.items[0].user_id, l1.items[0].day, l1.items[0].tier, l1.items[0].kind, l1.items[0].amount, l1.items[0].title, l1.items[0].month, l1.items[0].need, l1.items[0].value, l1.items[0].created_at, l1.items[0].id === g1.granted[0].id], [true, 1, 1, ROW_COLS.join(','), 101, '2026-03-05', 'streak-7', 'streak', 100, '', '', 7, 7, N1, true]);
  const g2 = await api.grant(101, { streak: 7, total: 10 }, { day: '2026-03-05', now: N1 });
  eq(label + ' 重复调用：ok 但 already:true、added 0、xp 0', [g2.ok, g2.error, g2.seen, g2.added, g2.already, g2.xp], [true, '', 1, 0, true, 0]);
  eq(label + ' 重复调用：skipped 说清是「已发」', [g2.skipped.length, g2.skipped[0].tier, g2.skipped[0].reason, g2.skipped[0].amount, g2.skipped[0].error], [1, 'streak-7', 'paid', 100, '']);
  eq(label + ' 重复调用：账上仍是一行、经验不翻倍', [await count(101), (await api.list(101, {})).total, (await api.summary(101)).xp], [1, 1, 100]);
  log['101'] = [g1, g2, l1];

  head(label + ' 唯一索引 / INSERT OR IGNORE（幂等的地基）');
  const SQL_ROW = 'INSERT INTO user_rewards (user_id, day, tier, kind, amount, title, month, need, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const ins1 = await api.run(SQL_ROW, [900, '2026-03-31', 'perfect-month', 'perfect', 500, '全勤达人', '2026-02', 28, 28, N1]);
  eq(label + ' 直插一行成功（changes 1）', ins1.changes, 1);
  let dupErr = '';
  try {
    await api.run(SQL_ROW, [900, '2026-03-31', 'perfect-month', 'perfect', 500, '全勤达人', '2026-01', 31, 31, N1]);
  } catch (err) {
    dupErr = String((err && err.message) || err);
  }
  ok(label + ' once 索引挡住「同 user + 同 day + 同 tier」（换 month 也挡）', dupErr.toUpperCase().indexOf('UNIQUE') >= 0, dupErr);
  eq(label + ' 被挡住的那次没留下半行', await count(900), 1);
  const ins2 = await api.run(api.sql.insert, [900, '2026-03-31', 'perfect-month', 'perfect', 500, '全勤达人', '2026-01', 31, 31, N1]);
  eq(label + ' INSERT OR IGNORE 命中唯一键：changes 0、不抛', ins2.changes, 0);
  const kept = await raw('SELECT day, tier, month FROM user_rewards WHERE user_id = ?', [900]);
  eq(label + ' 先到的那行原样留着（month 没被后到的改写）', [await count(900), kept[0].day, kept[0].tier, kept[0].month], [1, '2026-03-31', 'perfect-month', '2026-02']);

  head(label + ' 跨天');
  const A = await api.grant(102, { streak: 7 }, { day: '2026-03-05', now: N1 });
  const B = await api.grant(102, { streak: 7 }, { day: '2026-03-06', now: N1 + W });
  eq(label + ' 跨天：同一档第二天不重发', [A.added, B.added, B.already, await count(102)], [1, 0, true, 1]);
  const C = await api.grant(102, { streak: 14, total: 5 }, { day: '2026-03-06', now: N1 + W });
  eq(label + ' 跨天：第二天新达到的档照发，发放日是那天', [C.added, C.already, C.granted.map((i) => i.tier + '@' + i.day + '@' + i.created_at).join(','), C.xp], [1, false, 'streak-14@2026-03-06@' + (N1 + W), 250]);
  const D = await api.due(102, { streak: 14, total: 5 }, { day: '2026-03-07', now: N1 + 2 * W });
  eq(label + ' 跨天：due 分辨「达到 2 档 / 该发 0 档 / 已发 2 档」', [D.ok, D.error, D.count, D.reached, D.paid, D.xp, D.items.length], [true, '', 0, 2, 2, 0, 0]);
  log['102'] = [A, B, C, D];

  head(label + ' 跨月');
  const P3 = await api.grant(103, { perfect: { month: '2026-03', total: 31, done: 31, perfect: true } }, { day: '2026-03-31', now: N2 });
  const P4 = await api.grant(103, { perfect: { month: '2026-04', total: 30, done: 30, perfect: true } }, { day: '2026-04-30', now: N3 });
  eq(label + ' 跨月：全勤档每月各发一条，month 记达成月', [P3.granted.map((i) => i.tier + '@' + i.month).join(','), P4.granted.map((i) => i.tier + '@' + i.month).join(',')], ['perfect-month@2026-03', 'perfect-month@2026-04']);
  const S3 = await api.summary(103);
  eq(label + ' 跨月：按档汇总给两个月、xp 各 500', [S3.total, S3.xp, S3.days, S3.tiers.length, S3.tiers[0].tier, S3.tiers[0].count, S3.tiers[0].months.join('/'), S3.tiers[0].xp, S3.tiers[0].title], [2, 1000, 2, 1, 'perfect-month', 2, '2026-03/2026-04', 1000, '全勤达人']);
  const P3b = await api.grant(103, { perfect: { month: '2026-03', total: 31, done: 31, perfect: true } }, { day: '2026-03-31', now: N2 });
  eq(label + ' 跨月：回头补三月的全勤不重发', [P3b.ok, P3b.added, P3b.already, P3b.skipped[0].reason], [true, 0, true, 'paid']);
  const St3 = await api.grant(103, { streak: 7 }, { day: '2026-03-05', now: N1 });
  const St4 = await api.grant(103, { streak: 7 }, { day: '2026-04-05', now: N3 });
  eq(label + ' 跨月：连续档拿到就不掉，四月不重发', [St3.added, St4.added, St4.already, await count(103)], [1, 0, true, 3]);
  log['103'] = [P3, P4, P3b, St3, St4, S3];

  head(label + ' 补做日');
  const X1 = await api.grant(104, { streak: 7 }, { day: '2026-03-05', now: N1 });
  const X2 = await api.grant(104, { streak: 7 }, { day: '2026-03-01', now: N1 });
  eq(label + ' 补做日：同一档补到更早的日不重发', [X1.added, X2.added, X2.already], [1, 0, true]);
  const T104 = await api.tiers(104);
  eq(label + ' 补做日：历史行还是原发放日（不回写成补做日）', [T104.total, T104.items[0].day, T104.items[0].tier], [1, '2026-03-05', 'streak-7']);
  const X3 = await api.grant(104, { streak: 7, total: 100 }, { day: '2026-02-10', now: N1 - 10 * W });
  eq(label + ' 补做日：没发过的档可以回填到过去某天（这一趟补上 2 档）', [X3.added, X3.granted.map((i) => i.tier + '@' + i.day).join(','), X3.granted[0].created_at], [2, 'total-30@2026-02-10,total-100@2026-02-10', N1 - 10 * W]);
  const S104 = await api.summary(104);
  eq(label + ' 补做日：first/last 按发放日算（与写入先后无关）', [S104.total, S104.days, S104.first_day, S104.last_day, S104.first_at, S104.last_at], [3, 2, '2026-02-10', '2026-03-05', N1 - 10 * W, N1]);
  const L104 = await api.list(104, { limit: 1 });
  eq(label + ' 补做日：翻页新的在前（补做的那行在最前）', [L104.total, L104.items.length, L104.items[0].tier, L104.items[0].day], [3, 1, 'total-100', '2026-02-10']);
  eq(label + ' 补做日：tiers 按写入先后（id 升序）', (await api.tiers(104)).items.map((r) => r.tier), ['streak-7', 'total-30', 'total-100']);
  log['104'] = [X1, X2, X3, T104, S104, L104];

  head(label + ' 断签后历史流水不变（拿到就不掉）');
  const FULL = { streak: 100, total: 365, perfect: { month: '2026-03', total: 31, done: 31, perfect: true } };
  const BROKEN = { streak: 0, total: 3 };
  const F1 = await api.grant(105, FULL, { day: '2026-03-31', now: N2 });
  eq(label + ' 满档：8 档全发、8000 经验', [F1.added, F1.xp, F1.granted.length, F1.seen, F1.granted.map((i) => i.tier).join(',')], [8, 8000, 8, 8, 'streak-7,streak-14,streak-30,streak-100,perfect-month,total-30,total-100,total-365']);
  const F2 = await api.grant(105, BROKEN, { day: '2026-04-01', now: N3 });
  eq(label + ' 断签后：没新档可发（seen 0 时 already 恒 false）', [F2.ok, F2.error, F2.seen, F2.added, F2.already, F2.xp], [true, '', 0, 0, false, 0]);
  const D105 = await api.due(105, BROKEN, { day: '2026-04-01', now: N3 });
  eq(label + ' 断签后：该发的 0 档、已发的 8 行仍在（解耦查询）', [D105.count, D105.reached, D105.paid, (await api.tiers(105)).total], [0, 0, 0, 8]);
  const S105 = await api.summary(105);
  eq(label + ' 断签后：流水口径 8000 / 快照口径掉到 0', [S105.total, S105.xp, S105.owned, S105.days, S105.title, S105.titles.join(','), api.snapshotXp(FULL), api.snapshotXp(BROKEN)], [8, 8000, 8, 1, '百日不熄', '百日不熄,全年无休,不灭之火,全勤达人,百战之身,坚持者', 8000, 0]);
  const F3 = await api.grant(105, FULL, { day: '2026-06-01', now: N3 + 10 * W });
  eq(label + ' 断签后再回满档：也不重发（拿到就不掉）', [F3.added, F3.already, F3.seen, await count(105)], [0, true, 8, 8]);
  log['105'] = [F1, F2, D105, S105, F3];

  head(label + ' 缺字段降级');
  const E1 = await api.grant(106, undefined, { day: '2026-03-05', now: N1 });
  const E2 = await api.grant(106, {}, { day: '2026-03-05', now: N1 });
  const E3 = await api.grant(106, null, { day: '2026-03-05', now: N1 });
  const E4 = await api.grant(106, { streak: 'x', total: null, perfect: {} }, { day: '2026-03-05', now: N1 });
  const E5 = await api.due(106, undefined, { day: '2026-03-05', now: N1 });
  eq(label + ' stats 整缺：不抛、不发、也不伪造 already', [E1.ok, E1.error, E1.seen, E1.added, E1.already, E1.xp, E1.summary.total, E2.seen, E3.seen, E4.seen], [true, '', 0, 0, false, 0, 0, 0, 0, 0]);
  eq(label + ' stats 整缺：due 同形、账上一行没有', [E5.ok, E5.error, E5.count, E5.reached, E5.xp, await count(106)], [true, '', 0, 0, 0, 0]);
  const E6 = await api.grant(106, { streak: '7' }, { day: '2026-03-05', now: N1 });
  eq(label + ' 字符串数字当数（streak "7" 算达成）', [E6.seen, E6.added, E6.granted[0].tier, E6.granted[0].value], [1, 1, 'streak-7', 7]);
  const E7 = await api.grant(106, { daily: 30 }, { day: '2026-03-06', now: N1 + W });
  eq(label + ' 老档案只有 daily 也能算累计档', [E7.seen, E7.added, E7.granted[0].tier, E7.granted[0].value, E7.granted[0].need], [1, 1, 'total-30', 30, 30]);
  log['106'] = [E1, E2, E3, E4, E5, E6, E7];

  head(label + ' 非法档位 / 单档发放');
  const T1 = await api.grantTier(107, 'nope', { streak: 99 }, { day: '2026-03-01', now: N1 });
  const T2 = await api.grantTier(107, '', { streak: 99 }, { day: '2026-03-01', now: N1 });
  const T3 = await api.grantTier(107, 'total-100', { streak: 7, total: 20 }, { day: '2026-03-01', now: N1 });
  const T4 = await api.grantTier(107, 'streak-7', { streak: 6 }, { day: '2026-03-01', now: N1 });
  eq(label + ' 非法档位：unknown / unknown_tier，item 为 null', [T1.ok, T1.error, T1.reason, T1.added, T1.xp, T1.item, T2.ok, T2.error, T2.reason], [false, 'unknown_tier', 'unknown', false, 0, null, false, 'unknown_tier', 'unknown']);
  eq(label + ' 没达成的档：not_reached（没有 force 口子）', [T3.ok, T3.error, T3.reason, T4.reason, await count(107)], [false, 'not_reached', 'not_reached', 'not_reached', 0]);
  const T4b = await api.grantTier(107, 'perfect-month', { perfect: { month: '2026-05', total: 31, done: 3 } }, { day: '2026-05-05', now: N1 });
  eq(label + ' 没达成的全勤档：month 也回达成月（两线同一口径）', [T4b.ok, T4b.error, T4b.reason, T4b.month, await count(107)], [false, 'not_reached', 'not_reached', '2026-05', 0]);
  const T5 = await api.grantTier(107, 'streak-7', { streak: 7 }, { day: '2026-03-05', now: N1 });
  const T6 = await api.grantTier(107, 'streak-7', { streak: 7 }, { day: '2026-03-09', now: N2 });
  eq(label + ' 单档：第一次 ok，第二次 paid', [T5.ok, T5.error, T5.reason, T5.added, T5.xp, T6.ok, T6.error, T6.reason, T6.added, T6.xp], [true, '', 'ok', true, 100, true, '', 'paid', false, 0]);
  eq(label + ' 单档：paid 的 item 指回原流水行（id/day/created_at），不回写、没有 added 字段', [T6.day, T6.item.paid, T6.item.paid_day, T6.item.paid_at, T6.item.day, T6.item.created_at, T6.item.id === T5.item.id, Object.keys(T6.item).indexOf('added') < 0, await count(107)], ['2026-03-09', true, '2026-03-05', N1, '2026-03-05', N1, true, true, 1]);
  const T7 = await api.grantTier('x', 'streak-7', { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq(label + ' 非法用户：bad_user、一行不写', [T7.ok, T7.error, T7.reason, T7.user_id, T7.xp, await count(107)], [false, 'bad_user', 'bad_user', 0, 0, 1]);
  log['107'] = [T1, T2, T3, T4, T4b, T5, T6, T7];

  head(label + ' 分页与总数');
  for (let m = 1; m <= 12; m += 1) {
    const mm = MONTHS[m - 1];
    const days = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await api.grant(108, { perfect: { month: '2026-' + mm, total: days, done: days, perfect: true } }, { day: '2026-' + mm + '-' + days, now: N1 + m * W });
  }
  await api.grant(108, { streak: 7 }, { day: '2026-03-05', now: N1 });
  await api.grant(108, { total: 30 }, { day: '2026-03-06', now: N1 + W });
  const BIG = await api.list(108, { limit: 5 });
  const B2 = await api.list(108, { limit: 5, offset: 5 });
  const B3 = await api.list(108, { limit: 5, offset: 13 });
  const B4 = await api.list(108, { limit: 5, offset: 14 });
  eq(label + ' 分页：12 个月全勤 + 2 个其它档 = 14 行', [BIG.ok, BIG.total, BIG.limit, BIG.offset, BIG.items.length], [true, 14, 5, 0, 5]);
  const ids = BIG.items.map((r) => r.id);
  eq(label + ' 分页：新的在前（id 严格递减）', [ids[0] > ids[1], ids[1] > ids[2], ids[2] > ids[3], ids[3] > ids[4], BIG.items[4].tier], [true, true, true, true, 'perfect-month']);
  eq(label + ' 分页：第二页接得上、无重叠', [B2.items.length, B2.items[0].id < ids[4], B2.total], [5, true, 14]);
  eq(label + ' 分页：末页 1 行、越界 0 行但 total 照旧', [B3.items.length, B4.items.length, B4.total], [1, 0, 14]);
  const B5 = await api.list(108, { limit: 999, offset: -5 });
  const B6 = await api.list(108, { limit: 0 });
  const B7 = await api.list(108, {});
  eq(label + ' 分页：limit 夹到 200 / 默认 50、offset 负数归 0', [B5.limit, B5.offset, B5.items.length, B6.limit, B7.limit, B7.offset], [200, 0, 14, 50, 50, 0]);
  const B8 = await api.list('x', {});
  eq(label + ' 分页：非法用户 bad_user + 空壳', [B8.ok, B8.error, B8.total, B8.items.length], [false, 'bad_user', 0, 0]);
  eq(label + ' 分页：tiers 是全量（不受 limit 影响）', [(await api.tiers(108)).total, (await api.summary(108)).total, (await api.summary(108)).kinds.perfect.count], [14, 14, 12]);
  log['108'] = [BIG, B2, B3, B4, B5, B6, B7, B8, await api.tiers(108), await api.summary(108)];

  head(label + ' 并发重复调用（同步连调 + Promise.all）');
  const CC = { streak: 7, total: 30 };
  const c1p = api.grant(109, CC, { day: '2026-03-05', now: N1 });
  const c2p = api.grant(109, CC, { day: '2026-03-05', now: N1 });
  const c1 = await c1p;
  const c2 = await c2p;
  eq(label + ' 连调两次：都 ok，只有一次真发', [c1.ok, c2.ok, c1.error, c2.error, c1.added + c2.added, (c1.added > 0) !== (c2.added > 0)], [true, true, '', '', 2, true]);
  eq(label + ' 连调两次：账上两行、没有第三行', [await count(109), (await api.summary(109)).xp], [2, 250]);
  const pair = await Promise.all([
    api.grant(109, { streak: 14 }, { day: '2026-03-06', now: N2 }),
    api.grant(109, { streak: 14 }, { day: '2026-03-06', now: N2 })
  ]);
  const d1 = pair[0];
  const d2 = pair[1];
  eq(label + ' Promise.all：一个发一个 already、都 ok', [d1.ok, d2.ok, d1.error, d2.error, d1.added + d2.added, [d1.already, d2.already].filter(Boolean).length], [true, true, '', '', 1, 1]);
  eq(label + ' Promise.all：该档只有一行、经验只加一次', [await count(109), Number((await raw('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = ? AND tier = ?', [109, 'streak-14']))[0].n), (await api.summary(109)).xp, (await api.summary(109)).total], [3, 1, 500, 3]);
  console.log('  note  并发这组的唯一两线差异是「哪一次抢到哪一档」：Express 同步调用必然串行（added 2+0），Worker 的两次调用可真交错（1+1 或 2+0，看调度）。两线的不变量断言都在上面逐条通过了，这里把终态摊平后再参与逐字段比对。');
  log['109'] = {
    calls: [c1, c2, d1, d2].map((r) => r.ok + '|' + r.error).sort(),
    total: (await api.summary(109)).total,
    xp: (await api.summary(109)).xp,
    titles: (await api.summary(109)).titles,
    tiers: (await api.tiers(109)).items.map((r) => r.tier + '@' + r.day + '@' + r.created_at).sort()
  };
  return log;
}

/* ------------------------------------------------------------------ */
const main = async function () {
  console.log('node ' + process.version + ' / 临时目录 ' + tempBase());
  const RUN = { express: {}, worker: {} };

  head('准备临时环境');
  const expRoot = fs.mkdtempSync(path.join(tempBase(), 'rewards-ledger-'));
  fs.cpSync(path.join(REPO, 'src'), path.join(expRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(expRoot, 'data'), { recursive: true });
  // 副本里也放一份 package.json（只是复制，绝不改仓库那份）：让副本的 "type": "module"
  // 与仓库一致，顺带消掉 Node 的 MODULE_TYPELESS_PACKAGE_JSON 重解析告警。
  const pkg = path.join(REPO, 'package.json');
  if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(expRoot, 'package.json'));
  const expMod = await import(pathToFileURL(path.join(expRoot, 'src', 'rewards.js')).href);
  const expStore = expMod.ensureLedger();
  ok('E 副本 src/ 已复制、副本库已开', !!expStore && fs.existsSync(path.join(expRoot, 'src', 'rewards.js')), expRoot);

  const wkMod = await import(pathToFileURL(path.join(REPO, 'worker', 'rewards.js')).href);
  const wkDb = new LocalD1(':memory:');
  await wkMod.ensureLedger(wkDb);

  const realBefore = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null;

  await suite('E', expressAdapter(expMod, expStore), RUN.express);
  await suite('W', workerAdapter(wkMod, wkDb, expMod.rewardXp), RUN.worker);

  head('两线逐字段一致（同输入 → 同输出，防镜像漂移）');
  const keys = Object.keys(RUN.express);
  eq('两线覆盖的场景组一致', keys, Object.keys(RUN.worker));
  for (const k of keys) {
    const a = JSON.stringify(RUN.express[k]);
    const b = JSON.stringify(RUN.worker[k]);
    ok('场景组 ' + k + '：Express 与 Worker 返回值完全相同', a === b, a.slice(0, 160) + ' !== ' + b.slice(0, 160));
  }

  head('E 线专有：自动开库 / 测试钩子 / 真库隔离');
  const realRoot = path.resolve(REPO) + path.sep;
  ok('E 临时副本在仓库之外（不是仓库根、也不在仓库里面）', path.resolve(expRoot) !== path.resolve(REPO) && (path.resolve(expRoot) + path.sep).indexOf(realRoot) !== 0, expRoot);
  const copyDb = path.join(expRoot, 'data', 'games.db');
  const copyStat = fs.existsSync(copyDb) ? fs.statSync(copyDb) : null;
  ok('E 一个连接都不注入也自动开了副本库（data/games.db）', !!copyStat && copyStat.size > 0, copyDb);
  ok('E 副本库是刚写的（60s 内）', !!copyStat && Date.now() - copyStat.mtimeMs < 60000, copyStat ? String(Math.round(Date.now() - copyStat.mtimeMs)) + 'ms' : 'missing');
  eq('E 行落进副本库', Number(expStore.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 101').get().n), 1);
  eq('E ensureLedger 幂等：再调还是同一个连接', [expMod.ensureLedger() === expStore, expMod.ensureLedger() === expStore], [true, true]);
  const mem = new DatabaseSync(':memory:');
  const prev = expMod.useRewardStore(mem);
  eq('E useRewardStore 返回上一个注入值（默认 null）', prev, null);
  const gmem = expMod.grantRewards(555, { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq('E 注入后写内存库、副本库不动', [gmem.ok, gmem.error, gmem.added, Number(mem.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 555').get().n), Number(expStore.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 555').get().n)], [true, '', 1, 1, 0]);
  eq('E useRewardStore(null) 回上一个值（内存库）', expMod.useRewardStore(null) === mem, true);
  const gauto = expMod.grantRewards(556, { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq('E 清掉注入后回落自动开库（null = 恢复默认，不是「没有库」）', [gauto.ok, gauto.error, gauto.added, Number(mem.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 556').get().n), Number(expStore.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 556').get().n)], [true, '', 1, 0, 1]);
  mem.close();

  head('W 线专有：没绑定 / 冷启动 / DDL 单行');
  eq('W ensureLedger(null) 回 null（不抛）', await wkMod.ensureLedger(null), null);
  const nb = await wkMod.grantRewards(null, 123, { streak: 100, total: 365 }, { day: '2026-03-05', now: N1 });
  eq('W 没绑定：grantRewards ok:false / no_store，形状齐全', [nb.ok, nb.error, nb.detail, nb.user_id, nb.seen, nb.added, nb.already, nb.xp, nb.granted.length, nb.skipped.length, nb.summary], [false, 'no_store', '', 123, 0, 0, false, 0, 0, 0, null]);
  const nbT = await wkMod.grantTier(null, 123, 'streak-7', { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq('W 没绑定：grantTier reason no_store / item null', [nbT.ok, nbT.error, nbT.reason, nbT.added, nbT.xp, nbT.item], [false, 'no_store', 'no_store', false, 0, null]);
  const nbD = await wkMod.dueRewards(null, 123, { streak: 7 }, { day: '2026-03-05', now: N1 });
  const nbL = await wkMod.listLedger(null, 123, {});
  const nbS = await wkMod.ledgerSummary(null, 123);
  const nbR = await wkMod.ledgerTiers(null, 123);
  eq('W 没绑定：其余四个查询都是 no_store + 空壳', [nbD.ok, nbD.error, nbD.items.length, nbD.reached, nbL.ok, nbL.error, nbL.total, nbL.items.length, nbS.ok, nbS.error, nbS.total, nbS.tiers.length, nbR.ok, nbR.error, nbR.total], [false, 'no_store', 0, 0, false, 'no_store', 0, 0, false, 'no_store', 0, 0, false, 'no_store', 0]);
  const cold = new LocalD1(':memory:');
  const coldG = await wkMod.grantRewards(cold, 42, { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq('W 冷 D1（一次都没 ensure）也能发：懒建表', [coldG.ok, coldG.error, coldG.added, coldG.xp, coldG.granted[0].tier], [true, '', 1, 100, 'streak-7']);
  eq('W 冷 D1 上账里就一行', Number((await cold.prepare('SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = 42').all()).results[0].n), 1);
  const same3 = [];
  for (let i = 0; i < 3; i += 1) same3.push((await wkMod.ensureLedger(cold)) === cold);
  eq('W 同一绑定重复 ensure：都回同一个 db、不抛', same3, [true, true, true]);
  const d1x = new LocalD1(':memory:');
  await d1x.exec(wkMod.REWARD_LEDGER_DDL.join('\n'));
  const d1xIdx = (await d1x.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_rewards' ORDER BY name").all()).results.map((r) => r.name);
  eq('W 走真实 D1 exec（按换行切）也能把 5 条 DDL 建全', d1xIdx, IDX_NAMES);
  const d1xG = await wkMod.grantRewards(d1x, 43, { streak: 7 }, { day: '2026-03-05', now: N1 });
  eq('W exec 建出来的表照样能发', [d1xG.ok, d1xG.added, d1xG.xp], [true, 1, 100]);
  eq('W DDL / SQL 原样再导出，内容与 src 副本逐字节一致（接线方一条 import 就够）', [JSON.stringify(wkMod.REWARD_LEDGER_DDL) === JSON.stringify(expMod.REWARD_LEDGER_DDL), wkMod.REWARD_LEDGER_DDL.length, typeof wkMod.REWARD_LEDGER_SQL.insert, JSON.stringify(wkMod.REWARD_LEDGER_SQL) === JSON.stringify(expMod.REWARD_LEDGER_SQL), typeof expMod.rewardLedgerMonth], [true, 5, 'string', true, 'function']);
  cold.close();
  d1x.close();

  head('收尾');
  const realAfter = fs.existsSync(REAL_DB) ? fs.statSync(REAL_DB) : null;
  console.log('  真库 ' + REAL_DB + '：' + (realBefore ? '大小 ' + realBefore.size + 'B / mtime ' + new Date(realBefore.mtimeMs).toISOString() + ' → ' + (realAfter ? '大小 ' + realAfter.size + 'B / mtime ' + new Date(realAfter.mtimeMs).toISOString() : '不见了') : '不存在') + '（仅 stat，从未打开；若本机正跑着服务它自己会动，故不断言）');
  console.log('  临时副本 ' + expRoot + '（跑完删除）');
  try {
    expMod.useRewardStore(null);
    expStore.close();
  } catch (err) {
    console.log('  关闭副本连接时出错：' + String((err && err.message) || err));
  }
  try {
    wkDb.close();
  } catch (err) {
    console.log('  关闭内存 D1 时出错：' + String((err && err.message) || err));
  }
  try {
    fs.rmSync(expRoot, { recursive: true, force: true });
  } catch (err) {
    console.log('  删临时副本时出错：' + String((err && err.message) || err));
  }
  ok('收尾：临时副本已删除', !fs.existsSync(expRoot));

  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) process.exitCode = 1;
};

main().catch(function (err) {
  console.log('  测试自身抛错：' + String((err && err.stack) || err));
  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + (fail + 1));
  process.exitCode = 1;
});
