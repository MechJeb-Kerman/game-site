/**
 * 送达率监控与抑制名单（退信地址清理）自测。
 *
 * 运行：node tools/mail-report-test.mjs
 * 前置：无。自己造临时库，不碰 data/games.db，不占端口（更不碰 3000 / 4400），不发网络请求。
 *
 * 两条线各跑一遍同一套断言：
 *   express 线：把 src/ 整树复制到临时目录 —— src/db.js 的库路径由 import.meta.url 推出、
 *     没有环境变量开关，副本会把库建在 <tmp>/data/games.db，于是拿到一个真·临时库；
 *     再调它的 migrate() 建全表，动态 import 副本的 outbox.js（跑的是真源码，不是替身）。
 *   worker 线：tools/d1-local.mjs 的 LocalD1 指向临时文件，先跑 worker/schema.js 的 migrate()，
 *     再加载 worker/outbox.js（第一个参数是 db 绑定、全程 await）。
 *
 * 覆盖：建表幂等、suppress 的地址归一与非法地址、抑制后 enqueue 不入队且队里旧信被清、
 * unsuppress 后能再发、markBounced 自动抑制、markFailed 的 5xx 抑制与 4xx / 网络错不抑制、
 * deliveryStats 的 totals / rate（分母 0 回 null）/ byTag / topErrors 排序与截断、
 * listSuppressed 的倒序与分页。时间一律靠注入（deliveryStats 的 now 显式传 NOW），不真等。
 * 结尾打印「通过 N / 失败 M」，有失败 exit 1。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* express 线读 process.env 拿重试上限，worker 线由我们传的 env={} 走默认 6；这里固定成 6，
 * 断言就不受跑测试的人的环境变量影响 */
process.env.MAIL_MAX_ATTEMPTS = '6';

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

/** 本地时间：2026-05-20 12:00（真实时钟无关，deliveryStats 的 now 用它） */
const NOW = new Date(2026, 4, 20, 12, 0, 0, 0).getTime();
/** 和 src/outbox.js 内部同款的本地时间文本，用来算 from / to / 造数据（不拿被测模块算期望值） */
function stamp(when) {
  const d = new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const STAMP = stamp(NOW);

/* ---------- 两条线的装载 ---------- */

async function setupExpress(tmp) {
  mkdirSync(join(tmp, 'public'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });
  const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
  dbmod.migrate();
  const S = await import(pathToFileURL(join(tmp, 'src', 'outbox.js')).href);
  return { db: dbmod.db, S: S };
}

async function setupWorker(tmp) {
  const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
  const db = new LocalD1(join(tmp, 'd1.db'));
  const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
  await schema.migrate(db);
  const S = await import(pathToFileURL(join(ROOT, 'worker', 'outbox.js')).href);
  return { db: db, S: S };
}

/** 把两条线包成同一组方法：断言只写一遍；worker 线自动补 db 首参（markFailed 是 env, db, ...） */
function api(kind, S, db) {
  const isExpress = kind === 'express';
  const env = {};
  const bind = (sql, params = []) => {
    const st = db.prepare(sql);
    return params.length ? st.bind.apply(st, params) : st;
  };
  const run = async (sql, params = []) => (isExpress ? db.prepare(sql).run(...params) : bind(sql, params).run());
  const all = async (sql, params = []) => (isExpress ? db.prepare(sql).all(...params) : ((await bind(sql, params).all()) || {}).results || []);
  const num = async (sql, params = []) => {
    const row = isExpress ? db.prepare(sql).get(...params) : await bind(sql, params).first();
    return Number((row || {}).n || 0);
  };
  const call = (name, args) => (isExpress ? S[name](...args) : S[name](db, ...args));
  return {
    kind: kind, run: run, all: all, num: num,
    ensure: () => call('ensureOutbox', []),
    ens: (obj) => call('enqueue', [obj]),
    sup: (a, r, s) => call('suppress', [a, r === undefined ? '' : r, s === undefined ? '' : s]),
    unsup: (a) => call('unsuppress', [a]),
    isSup: (a) => call('isSuppressed', [a]),
    list: (limit, offset) => (limit === undefined ? call('listSuppressed', [])
      : (offset === undefined ? call('listSuppressed', [limit]) : call('listSuppressed', [limit, offset]))),
    due: (now, limit) => (limit === undefined ? call('dueList', [now]) : call('dueList', [now, limit])),
    mSent: (id) => call('markSent', [id]),
    mFail: (id, err, opts) => (isExpress
      ? (opts === undefined ? S.markFailed(id, err) : S.markFailed(id, err, opts))
      : (opts === undefined ? S.markFailed(env, db, id, err) : S.markFailed(env, db, id, err, opts))),
    mBounce: (a, r) => call('markBounced', [a, r === undefined ? '' : r]),
    bsum: (n) => (n === undefined ? call('bounceSummary', []) : call('bounceSummary', [n])),
    stats: () => call('stats', []),
    dstats: (days, now) => (days === undefined ? call('deliveryStats', []) : call('deliveryStats', [days, now]))
  };
}

/* ---------- 一条线的全部断言 ---------- */

async function runLine(kind, S, db) {
  const A = api(kind, S, db);
  console.log('\n=== ' + kind + ' 线 ===');
  const wipe = async () => {
    await A.run('DELETE FROM mail_outbox');
    await A.run('DELETE FROM mail_suppression');
  };
  const seed = async (tag, status, n, err) => {
    for (let i = 0; i < n; i++) {
      await A.run(
        'INSERT INTO mail_outbox (to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tag + i + '@ex.com', 's', 'b', tag, status, 1, err === undefined ? '' : err, null, STAMP, STAMP]
      );
    }
  };

  /* ---------- A 建表幂等 ---------- */
  console.log('--- A 建表幂等 ---');
  await A.ensure();
  await A.ensure();
  await A.ensure();
  const tbl = await A.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_suppression'");
  ok('ensureOutbox 多次调用只建出一张 mail_suppression', tbl.length === 1);
  const ddl = String((tbl[0] || {}).sql || '').replace(/\s+/g, ' ');
  ok('列与 NOT NULL / 默认值齐全', ddl.indexOf('address TEXT PRIMARY KEY') >= 0 &&
    ddl.indexOf("reason TEXT NOT NULL DEFAULT ''") >= 0 && ddl.indexOf("source TEXT NOT NULL DEFAULT ''") >= 0 &&
    ddl.indexOf('created_at INTEGER NOT NULL') >= 0, ddl);
  ok('抑制名单的 created_at 索引也在', (await A.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mail_suppression_created'")).length === 1);

  /* ---------- B suppress：地址归一与非法地址 ---------- */
  console.log('--- B suppress：地址归一与非法地址 ---');
  await wipe();
  const s1 = await A.sup('  Bounce@Example.COM ', 'hard bounce', 'manual');
  eq('suppress 成功返回', { ok: s1.ok, address: s1.address, cleared: s1.cleared, error: s1.error },
    { ok: true, address: 'bounce@example.com', cleared: 0, error: '' });
  ok('isSuppressed 忽略大小写与空格', (await A.isSup('BOUNCE@example.com')) === true && (await A.isSup(' bounce@EXAMPLE.com ')) === true);
  const row = (await A.all('SELECT address, reason, source, created_at FROM mail_suppression'))[0];
  eq('存的是归一后的地址', row.address, 'bounce@example.com');
  eq('reason / source 原样存', [row.reason, row.source], ['hard bounce', 'manual']);
  ok('created_at 是毫秒数', typeof row.created_at === 'number' && row.created_at > 1600000000000, JSON.stringify(row));
  const bad1 = await A.sup('');
  const bad2 = await A.sup('not-an-address');
  const bad3 = await A.sup('   ');
  eq('空地址 → bad_address', [bad1.ok, bad1.error, bad1.cleared], [false, 'bad_address', 0]);
  eq('不含 @ → bad_address', [bad2.ok, bad2.error], [false, 'bad_address']);
  eq('全空格 → bad_address', [bad3.ok, bad3.error], [false, 'bad_address']);
  eq('非法地址不写名单', await A.num('SELECT COUNT(*) AS n FROM mail_suppression'), 1);
  eq('isSuppressed 对空 / 非法地址回 false', [await A.isSup(''), await A.isSup('nope')], [false, false]);
  const again = await A.sup('bounce@example.com', '第二遍', 'manual');
  eq('重复抑制幂等（还是一条，reason 覆盖）',
    [again.ok, await A.num('SELECT COUNT(*) AS n FROM mail_suppression'), (await A.all('SELECT reason FROM mail_suppression'))[0].reason],
    [true, 1, '第二遍']);

  /* ---------- C 抑制后不入队、队里旧信被清 ---------- */
  console.log('--- C 抑制后 enqueue 不入队、队里旧信被清 ---');
  await wipe();
  const q1 = await A.ens({ to: 'Clear-Me@Example.com', subject: 'a', tag: 'verify' });
  const q2 = await A.ens({ to: 'clear-me@example.com', subject: 'b', tag: 'verify' });
  eq('先正常入队两条', [q1.ok, q1.status, q2.ok, q2.status], [true, 'queued', true, 'queued']);
  const supC = await A.sup('clear-me@example.com', '退信', 'bounce');
  eq('suppress 把排队的信清掉（cleared=2）', [supC.ok, supC.cleared], [true, 2]);
  // 注意 COLLATE NOCASE：enqueue 按调用方给的写法存地址（大小写原样），普通 = 比较是大小写敏感的
  const cleared = await A.all("SELECT status, last_error, next_attempt_at FROM mail_outbox WHERE to_addr = 'clear-me@example.com' COLLATE NOCASE ORDER BY id");
  eq('旧信落 failed + suppressed 原因 + 不再排期', cleared.map((r) => [r.status, r.last_error, r.next_attempt_at]),
    [['failed', 'suppressed: 退信', null], ['failed', 'suppressed: 退信', null]]);
  const blocked = await A.ens({ to: 'CLEAR-ME@example.com', subject: 'c', tag: 'verify' });
  eq('抑制后 enqueue 不入队（老字段名还在，只是没排）',
    { ok: blocked.ok, id: blocked.id, status: blocked.status, next_attempt_at: blocked.next_attempt_at, suppressed: blocked.suppressed, error: blocked.error },
    { ok: false, id: 0, status: '', next_attempt_at: null, suppressed: true, error: 'suppressed' });
  eq('队里没有多出第三条', await A.num("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'clear-me@example.com' COLLATE NOCASE"), 2);
  eq('这地址没有 queued 残留', await A.num("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'clear-me@example.com' COLLATE NOCASE AND status = 'queued'"), 0);
  const q3 = await A.ens({ to: 'already@example.com' });
  await A.mSent(q3.id);
  const supSent = await A.sup('already@example.com', '手动拉黑', 'manual');
  eq('已 sent 的行不被 suppress 动',
    [supSent.cleared, (await A.all('SELECT status FROM mail_outbox WHERE id = ?', [q3.id]))[0].status], [0, 'sent']);

  /* ---------- D unsuppress 后能再发 ---------- */
  console.log('--- D unsuppress 后能再发 ---');
  const u1 = await A.unsup(' Clear-Me@Example.com ');
  eq('解除抑制（地址同样归一）', { ok: u1.ok, address: u1.address, removed: u1.removed },
    { ok: true, address: 'clear-me@example.com', removed: 1 });
  const u2 = await A.unsup('clear-me@example.com');
  eq('再解除一次 removed=0 也算 ok', [u2.ok, u2.removed], [true, 0]);
  eq('不在名单里了', await A.isSup('clear-me@example.com'), false);
  const q4 = await A.ens({ to: 'clear-me@example.com', subject: 'again', tag: 'reset' });
  eq('解除后能再入队', [q4.ok, q4.status], [true, 'queued']);
  const dueNow = await A.due(Date.now());
  ok('dueList 能捞到它（真的又能发了）', dueNow.some((r) => r.to_addr === 'clear-me@example.com'),
    JSON.stringify(dueNow.map((r) => r.to_addr)));

  /* ---------- E markBounced 自动抑制 ---------- */
  console.log('--- E markBounced 自动抑制 ---');
  await wipe();
  await A.ens({ to: 'Bounce-Me@Example.com', tag: 'verify' });
  await A.ens({ to: 'bounce-me@example.com', tag: 'verify' });
  const bres = await A.mBounce('Bounce-Me@Example.com', 'mail_550 5.1.1 user unknown');
  eq('markBounced 的旧返回逐字不变（多出来的抑制是副作用）',
    { ok: bres.ok, address: bres.address, reason: bres.reason, changed: bres.changed },
    { ok: true, address: 'Bounce-Me@Example.com', reason: 'mail_550 5.1.1 user unknown', changed: 2 });
  eq('两条都成 bounced（没被改成 failed）',
    await A.num("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = 'bounce-me@example.com' COLLATE NOCASE AND status = 'bounced'"), 2);
  eq('地址自动进抑制名单（source=bounce）',
    [await A.isSup('BOUNCE-ME@example.com'), (await A.all("SELECT source, reason FROM mail_suppression WHERE address = 'bounce-me@example.com'"))[0]],
    [true, { source: 'bounce', reason: 'mail_550 5.1.1 user unknown' }]);
  const blocked2 = await A.ens({ to: 'bounce-me@example.com' });
  eq('退信地址再入队被拒', [blocked2.ok, blocked2.suppressed, blocked2.error], [false, true, 'suppressed']);
  const bs = await A.bsum(20);
  eq('bounceSummary 仍然只数退信', [bs.count, bs.rows.length], [2, 2]);

  /* ---------- F markFailed：5xx 抑制、4xx / 网络错不抑制 ---------- */
  console.log('--- F markFailed：5xx 抑制、4xx / 网络错不抑制 ---');
  await wipe();
  const h1 = await A.ens({ to: 'slow5xx@example.com', tag: 'verify' });
  const seq = [];
  for (let i = 1; i <= 6; i++) {
    const r = await A.mFail(h1.id, 'mail_503 service unavailable');
    seq.push([r.status, await A.isSup('slow5xx@example.com')]);
  }
  eq('前 5 次还排队且不抑制，第 6 次试满落 failed 才抑制', seq,
    [['queued', false], ['queued', false], ['queued', false], ['queued', false], ['queued', false], ['failed', true]]);
  const row6 = (await A.all('SELECT attempts, last_error, next_attempt_at FROM mail_outbox WHERE id = ?', [h1.id]))[0];
  eq('第 6 次的落库细节', [row6.attempts, row6.last_error, row6.next_attempt_at], [6, 'mail_503 service unavailable', null]);
  eq('hardfail 抑制的 source / reason',
    [(await A.all("SELECT source, reason FROM mail_suppression WHERE address = 'slow5xx@example.com'"))[0]],
    [{ source: 'hardfail', reason: 'mail_503 service unavailable' }]);

  const h2 = await A.ens({ to: 'hard@example.com' });
  const r2 = await A.mFail(h2.id, 'mail_550 5.1.1 user unknown', { retry: false });
  eq('retry:false 的 5xx 一次就落 failed 并抑制', [r2.status, r2.attempts, await A.isSup('hard@example.com')], ['failed', 1, true]);

  const h3 = await A.ens({ to: 'soft@example.com' });
  for (let i = 1; i <= 6; i++) await A.mFail(h3.id, 'mail_422 invalid recipient');
  eq('4xx 试满也不抑制',
    [await A.isSup('soft@example.com'), await A.num("SELECT COUNT(*) AS n FROM mail_outbox WHERE id = ? AND status = 'failed'", [h3.id])],
    [false, 1]);

  const h4 = await A.ens({ to: 'net@example.com' });
  for (let i = 1; i <= 6; i++) await A.mFail(h4.id, 'mail_network: socket hang up');
  eq('网络错试满也不抑制',
    [await A.isSup('net@example.com'), await A.num("SELECT COUNT(*) AS n FROM mail_outbox WHERE id = ? AND status = 'failed'", [h4.id])],
    [false, 1]);

  /* ---------- G deliveryStats ---------- */
  console.log('--- G deliveryStats：totals / rate / byTag / topErrors ---');
  await wipe();
  await seed('verify', 'sent', 2);
  await seed('verify', 'failed', 1, 'mail_550 5.1.1 user unknown');
  await seed('verify', 'bounced', 1, 'mail_550 5.1.1 user unknown');
  await seed('reset', 'sent', 1);
  await seed('reset', 'failed', 1, 'mail_network: timeout');
  await seed('digest', 'queued', 2);
  const st = await A.dstats(7, NOW);
  eq('totals 按 mail_outbox 全表当前状态算（不是窗口事件）', st.totals, { queued: 2, sent: 3, failed: 2, bounced: 1, total: 8 });
  eq('totals 与 stats() 一致', st.totals, await A.stats());
  eq('rate = sent / (sent+failed+bounced)', st.rate, 0.5);
  eq('from / to / days 用注入的 now 算（7 天窗口）', [st.from, st.to, st.days], [stamp(NOW - 7 * 86400000), stamp(NOW), 7]);
  eq('byTag：total 降序，同数按 tag 升序', st.byTag, [
    { tag: 'verify', sent: 2, failed: 1, bounced: 1, total: 4 },
    { tag: 'digest', sent: 0, failed: 0, bounced: 0, total: 2 },
    { tag: 'reset', sent: 1, failed: 1, bounced: 0, total: 2 }
  ]);
  eq('topErrors：只数 failed / bounced，count 降序，键是 last_error 原文', st.topErrors, [
    { error: 'mail_550 5.1.1 user unknown', count: 2 },
    { error: 'mail_network: timeout', count: 1 }
  ]);
  eq('顶层字段固定', Object.keys(st).sort(), ['byTag', 'days', 'from', 'rate', 'to', 'topErrors', 'totals']);

  await A.run("UPDATE mail_outbox SET status = 'queued'");
  const st0 = await A.dstats(1, NOW);
  eq('没有 sent / failed / bounced 时 rate = null', [st0.rate, st0.totals.sent, st0.totals.total], [null, 0, 8]);
  eq('days 传 1 就是 1 天窗口', [st0.days, st0.from], [1, stamp(NOW - 86400000)]);

  await wipe();
  await seed('a', 'sent', 1);
  await seed('a', 'failed', 2, 'mail_500 x');
  eq('rate 保留 4 位小数', (await A.dstats(3, NOW)).rate, 0.3333);

  await wipe();
  for (let i = 1; i <= 14; i++) await seed('t' + String(i).padStart(2, '0'), 'sent', 15 - i);
  const st12 = await A.dstats(7, NOW);
  eq('byTag 最多 12 条、total 降序（第 13 名以后被截掉）',
    [st12.byTag.length, st12.byTag[0].tag, st12.byTag[0].total, st12.byTag[11].tag, st12.byTag[11].total],
    [12, 't01', 14, 't12', 3]);
  eq('截断不影响 totals / rate', [st12.totals.total, st12.rate], [105, 1]);

  await wipe();
  for (let i = 1; i <= 12; i++) await seed('e' + String(i).padStart(2, '0'), 'failed', 13 - i, 'err' + String(i).padStart(2, '0'));
  const stE = await A.dstats(7, NOW);
  eq('topErrors 最多 10 条、count 降序',
    [stE.topErrors.length, stE.topErrors[0], stE.topErrors[9]], [10, { error: 'err01', count: 12 }, { error: 'err10', count: 3 }]);

  await wipe();
  const long = 'x'.repeat(80);
  await seed('noise', 'sent', 1, 'sent-noise');
  await seed('noise', 'queued', 1, 'queued-noise');
  await A.run('INSERT INTO mail_outbox (to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['long1@ex.com', 's', 'b', 'long', 'failed', 1, long + 'AAA', null, STAMP, STAMP]);
  await A.run('INSERT INTO mail_outbox (to_addr, subject, body_text, tag, status, attempts, last_error, next_attempt_at, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['long2@ex.com', 's', 'b', 'long', 'failed', 1, long + 'BBB', null, STAMP, STAMP]);
  const stL = await A.dstats(7, NOW);
  eq('topErrors 的键取 last_error 前 80 字（尾部不同也并成一条）', stL.topErrors, [{ error: long, count: 2 }]);
  ok('sent / queued 行的 last_error 不进 topErrors', stL.topErrors.every((e) => e.error.indexOf('-noise') < 0));

  /* ---------- H listSuppressed：倒序与分页 ---------- */
  console.log('--- H listSuppressed：倒序与分页 ---');
  await wipe();
  await A.sup('a@ex.com', 'ra', 'manual');
  await A.sup('b@ex.com', 'rb', 'manual');
  await A.sup('c@ex.com', 'rc', 'manual');
  const l1 = await A.list();
  eq('三条都在，最新的在前', [l1.total, l1.items.map((i) => i.address)], [3, ['c@ex.com', 'b@ex.com', 'a@ex.com']]);
  eq('item 字段固定', Object.keys(l1.items[0]).sort(), ['address', 'created_at', 'reason', 'source']);
  await A.sup('a@ex.com', 'ra2', 'manual');
  eq('重复抑制刷新 created_at（浮到最前）', (await A.list()).items.map((i) => i.address), ['a@ex.com', 'c@ex.com', 'b@ex.com']);
  await A.run('UPDATE mail_suppression SET created_at = ? WHERE address = ?', [1000, 'a@ex.com']);
  await A.run('UPDATE mail_suppression SET created_at = ? WHERE address = ?', [2000, 'b@ex.com']);
  await A.run('UPDATE mail_suppression SET created_at = ? WHERE address = ?', [3000, 'c@ex.com']);
  eq('created_at DESC + limit / offset', [(await A.list(2, 1)).total, (await A.list(2, 1)).items.map((i) => i.address)], [3, ['b@ex.com', 'a@ex.com']]);
  eq('limit 非法 / 缺省都回默认页', [(await A.list(0)).items.length, (await A.list(-5)).items.length], [3, 3]);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'game-site-mail-report-'));
  console.log('临时目录：' + tmp);
  console.log('基准时间：NOW = 2026-05-20 12:00（本地），真实时钟只用于 enqueue 的 now');
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
      console.log('\n（临时目录没删掉，无害：' + tmp + '）');
    }
  }
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main();
