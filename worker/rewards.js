/**
 * 奖励流水（Cloudflare Workers + D1 版）：与 src/rewards.js 文件末尾那一节一一对应，
 * 唯一区别是 D1 绑定从第一个参数来、全程 await（同 worker/social.js / worker/outbox.js 的规矩）。
 *
 * 规则不复制：8 档判定（达到哪几档）、流水条目、账本汇总全部复用 src/rewards.js 导出的纯函数
 * （rewardLedgerUid / rewardLedgerScan / rewardLedgerItem / rewardLedgerRow / rewardLedgerSummary），
 * DDL 与 SQL 也是同一份常量——两条线各写一遍 8 档门槛迟早会算出两个结果，
 * 而 worker/social.js:9 本来就是从 '../src/rewards.js' 直接 import 的（src/rewards.js 顶层不含
 * node: import，才能被 Workers 打包）。这里只重写「怎么问库」。
 *
 * 表 user_rewards：DDL 见 REWARD_LEDGER_DDL（从 src/rewards.js 复用，下面再导出一次）。
 * 注意 D1 的 exec() 是按换行切语句执行的，跨多行的 CREATE TABLE 会被切坏
 *   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS user_rewards (: incomplete input
 * 所以那里每条都是单行字符串；这里也不用 exec()，而是逐条 prepare().run()（同 worker/schema.js）。
 *
 * 时间口径：created_at 存毫秒数（与 daily_results / elo_history / mail_suppression 一致），
 * 不用 outbox 那种 'YYYY-MM-DD HH:mm:ss' 文本——流水要按时间倒序翻页，秒级文本会大面积并列。
 *
 * 一律不抛：没有绑定（env.DB 忘了接）、非法用户、SQL 出错，都回 ok:false + 一份字段齐全的
 * 安全返回（调用方读 r.added 不会炸）；与 src/outbox.js 的 enqueue 同一个纪律。
 * 与 worker/outbox.js 的唯一刻意差异：那边的 ensureOutbox 没绑定时**抛** no_d1_binding，
 * 这里 ensureLedger 回 null、由上层翻成 ok:false / error:'no_store'——两条线（Express 同步 +
 * Worker await）对外形状保持一致，路由不必再包一层 try/catch。
 *
 * 接线：worker/schema.js 想在建表期一次性建好，可直接
 *   import { REWARD_LEDGER_DDL } from './rewards.js';
 *   ...SCHEMA.push(...REWARD_LEDGER_DDL)
 * 不接也能跑：ensureLedger(db) 在第一次调用时幂等建表。
 */
import {
  REWARDS,
  REWARD_LEDGER_DDL,
  REWARD_LEDGER_SQL,
  rewardLedgerUid,
  rewardLedgerScan,
  rewardLedgerItem,
  rewardLedgerMonth,
  rewardLedgerRow,
  rewardLedgerSummary
} from '../src/rewards.js';

// 建表语句与 SQL 原样再导出一次：接线方（worker/schema.js / 测试）一条 import 就够
export { REWARD_LEDGER_DDL, REWARD_LEDGER_SQL };

/** 档位清单的索引（tier -> def，只在 grantTier 里用；与 src/rewards.js 的 LEDGER_DEFS 同源） */
const LEDGER_DEF = new Map(REWARDS.map((d) => [d.key, d]));

/** 建过表的 D1 绑定（每次请求的 env.DB 是同一个对象，WeakSet 不会挂住它） */
const READY = new WeakSet();

/** SQL 文本 → 绑定好参数的语句（同 worker/social.js:14 的 stmt） */
function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

/** 出错信息归一成一句话（不给调用方抛异常对象，返回对象里也没法放） */
function errText(err) {
  return String((err && err.message) || err || 'unknown');
}

/** 查询多行：D1 的 all() 回 { success, results, meta }，取不到就空数组（同 worker/outbox.js） */
async function rows(db, sql, params) {
  const res = await stmt(db, sql, params).all();
  return (res && res.results) || [];
}

/** 查询单列：没行回 undefined（同 worker/social.js:28 的 one，但不要 null 兜底） */
async function cell(db, sql, params) {
  return await stmt(db, sql, params).first();
}

/**
 * 幂等建表（每个绑定只跑一次）。
 * 没有绑定回 null（不抛）：调用方据此回 ok:false / error:'no_store'。
 */
export async function ensureLedger(db) {
  if (!db) return null;
  if (READY.has(db)) return db;
  for (const sql of REWARD_LEDGER_DDL) await db.prepare(sql).run();
  READY.add(db);
  return db;
}

/** 账上已发的行（只取判定要用的四列） */
async function paidRows(db, uid) {
  return await rows(db, REWARD_LEDGER_SQL.paid, [uid]);
}

/** 账上全部流水（归一后的行，id 升序） */
async function ledgerRows(db, uid) {
  const list = await rows(db, REWARD_LEDGER_SQL.rows, [uid]);
  return list.map(rewardLedgerRow);
}

/**
 * 一次扫描（D1 侧胶水）：取绑定 → 建表 → 查已发 → 交给 src/rewards.js 的纯函数判定。
 * ok:false 时 error 是 'no_store' | 'bad_user' | 'ledger_error'，detail 是原始信息。
 */
async function scanLedger(db, userId, stats, opts) {
  const out = {
    ok: false, error: 'no_store', detail: '', user_id: rewardLedgerUid(userId), day: '', now: 0,
    prog: null, reached: [], paid: new Map(), db: null
  };
  let h = null;
  try {
    h = await ensureLedger(db);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  if (!h) return out;
  out.db = h;
  const uid = rewardLedgerUid(userId);
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let list = [];
  try {
    list = await paidRows(h, uid);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  const scan = rewardLedgerScan(list, uid, stats, opts);
  scan.ok = true;
  scan.error = '';
  scan.detail = '';
  scan.db = h;
  return scan;
}

/**
 * 写一行流水（INSERT OR IGNORE）。added=false 表示账上已经有这一行（幂等命中，不是错误）。
 * 落库的 amount / need / value 全部来自 rewardLedgerItem（与返回给页面的条目同源），
 * 所以两条线写出来的行逐列一致。
 */
async function writeRow(db, scan, hit) {
  const def = hit.def;
  const item = rewardLedgerItem(def, scan.prog, hit.month, null);
  const p = [scan.user_id, scan.day, def.key, def.kind, item.amount, String(def.reward.title || ''), hit.month, item.need, item.value, scan.now];
  try {
    const info = await stmt(db, REWARD_LEDGER_SQL.insert, p).run();
    const meta = (info && info.meta) || {};
    const changes = Number(meta.changes || 0);
    const id = Number(meta.last_row_id || 0);
    if (changes > 0) {
      scan.paid.set(hit.key, { id: id, day: scan.day, tier: def.key, month: hit.month, created_at: scan.now });
      return { added: true, id: id, amount: item.amount, error: '' };
    }
    return { added: false, id: 0, amount: item.amount, error: '' };
  } catch (err) {
    return { added: false, id: 0, amount: item.amount, error: errText(err) };
  }
}

/** 空账本（失败时用：字段与成功返回完全一样，页面不用判空） */
function emptySummary(uid, error, detail) {
  const out = rewardLedgerSummary([], uid);
  out.ok = false;
  out.error = error;
  out.detail = detail || '';
  return out;
}

/** 分页参数：limit 默认 50、上限 200；offset 至少 0（与 src/rewards.js 的私有同名函数同规矩） */
function limitOf(limit, def, max) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function offsetOf(offset) {
  const n = Math.floor(Number(offset));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 发放奖励（D1 版，与 src/rewards.js 的 grantRewards 同参同返回，只是多了第一个 db）。
 * @param {object} db    D1 绑定（env.DB）
 * @param {number} userId 玩家 id（非正整数 → ok:false / error:'bad_user'）
 * @param {object} stats  src/social.js dailyStats() 的形状；缺字段一律按 0 降级（不抛）
 * @param {{day?:string, now?:number|Date|string}} [opts]
 * @returns 同 src/rewards.js：{ ok, error, detail, user_id, day, now, seen, added, already, xp,
 *   granted, skipped, summary }——already:true = 这次一档都没新发（全是重复调用）
 */
export async function grantRewards(db, userId, stats, opts) {
  const scan = await scanLedger(db, userId, stats, opts);
  const out = {
    ok: false, error: scan.ok ? '' : (scan.error || 'no_store'), detail: scan.detail || '', user_id: scan.user_id,
    day: scan.day, now: scan.now, seen: 0, added: 0, already: false, xp: 0, granted: [], skipped: [], summary: null
  };
  if (!scan.ok) return out;
  for (const hit of scan.reached) {
    const paidRow = scan.paid.get(hit.key);
    if (paidRow) {
      out.skipped.push({ tier: hit.def.key, month: hit.month, amount: rewardLedgerItem(hit.def, scan.prog, hit.month, paidRow).amount, reason: 'paid', error: '' });
      continue;
    }
    const w = await writeRow(scan.db, scan, hit);
    if (!w.added) {
      out.skipped.push({ tier: hit.def.key, month: hit.month, amount: w.amount, reason: w.error ? 'error' : 'paid', error: w.error });
      continue;
    }
    const item = rewardLedgerItem(hit.def, scan.prog, hit.month, { id: w.id, day: scan.day, month: hit.month, created_at: scan.now });
    item.id = w.id;
    item.day = scan.day;
    item.created_at = scan.now;
    item.added = true;
    out.granted.push(item);
    out.xp += w.amount;
  }
  out.ok = true;
  out.seen = scan.reached.length;
  out.added = out.granted.length;
  out.already = out.added === 0 && out.seen > 0;
  out.summary = await ledgerSummary(scan.db, scan.user_id);
  return out;
}

/**
 * 单档发放（D1 版，与 src/rewards.js 的 grantTier 同参同返回）。
 * 只认 REWARDS 里有的档，而且只有 stats 判定为已达成才写——没有 force。
 * @returns {Promise<{ok:boolean, error:string, detail:string,
 *   reason:'ok'|'paid'|'unknown'|'not_reached'|'bad_user'|'no_store'|'ledger_error',
 *   user_id:number, day:string, now:number, tier:string, month:string, added:boolean, xp:number, item:object|null}>}
 */
export async function grantTier(db, userId, tier, stats, opts) {
  const name = String(tier === undefined || tier === null ? '' : tier).trim();
  const scan = await scanLedger(db, userId, stats, opts);
  const out = { ok: false, error: '', detail: '', reason: '', user_id: scan.user_id, day: scan.day, now: scan.now, tier: name, month: '', added: false, xp: 0, item: null };
  const def = LEDGER_DEF.get(name);
  if (!scan.ok) {
    out.error = scan.error || 'no_store';
    out.reason = out.error;
    out.detail = scan.detail || '';
    return out;
  }
  if (!def) {
    out.error = 'unknown_tier';
    out.reason = 'unknown';
    return out;
  }
  let hit = null;
  for (const h of scan.reached) if (h.def.key === name) hit = h;
  if (!hit) {
    out.error = 'not_reached';
    out.reason = 'not_reached';
    out.month = rewardLedgerMonth(def, scan.prog, scan.day);
    return out;
  }
  out.month = hit.month;
  const paidRow = scan.paid.get(hit.key);
  if (paidRow) {
    out.ok = true;
    out.reason = 'paid';
    // 早发过的那次，item 也指着账上原来那一行（id / day / created_at = 原发放日与写入时间，
    // 与 paid_id / paid_day / paid_at 同值）：调用方拿 item 就能显示「哪天的流水」，不必自己回查。
    out.item = rewardLedgerItem(def, scan.prog, hit.month, paidRow);
    out.item.id = paidRow.id;
    out.item.day = paidRow.day;
    out.item.created_at = paidRow.created_at;
    return out;
  }
  const w = await writeRow(scan.db, scan, hit);
  const item = rewardLedgerItem(def, scan.prog, hit.month, w.added ? { id: w.id, day: scan.day, month: hit.month, created_at: scan.now } : null);
  if (!w.added) {
    out.error = w.error ? 'ledger_error' : '';
    out.reason = w.error ? 'ledger_error' : 'paid';
    out.detail = w.error;
    out.ok = !w.error;
    out.item = item;
    return out;
  }
  item.id = w.id;
  item.day = scan.day;
  item.created_at = scan.now;
  item.added = true;
  out.ok = true;
  out.reason = 'ok';
  out.added = true;
  out.xp = w.amount;
  out.item = item;
  return out;
}

/**
 * 「某天该发什么」（D1 版，只读不写）：与 ledgerTiers() 解耦——断签之后这里会变少，
 * 账上那条不会少。
 * @returns {Promise<{ok:boolean, error:string, detail:string, user_id:number, day:string, now:number,
 *   items:Array, count:number, reached:number, paid:number, xp:number}>}
 */
export async function dueRewards(db, userId, stats, opts) {
  const scan = await scanLedger(db, userId, stats, opts);
  if (!scan.ok) {
    return { ok: false, error: scan.error || 'no_store', detail: scan.detail || '', user_id: scan.user_id, day: scan.day, now: scan.now, items: [], count: 0, reached: 0, paid: 0, xp: 0 };
  }
  const items = [];
  let paid = 0;
  let xp = 0;
  for (const hit of scan.reached) {
    if (scan.paid.has(hit.key)) {
      paid++;
      continue;
    }
    const item = rewardLedgerItem(hit.def, scan.prog, hit.month, null);
    items.push(item);
    xp += item.amount;
  }
  return { ok: true, error: '', detail: '', user_id: scan.user_id, day: scan.day, now: scan.now, items: items, count: items.length, reached: scan.reached.length, paid: paid, xp: xp };
}

/**
 * 「已经发了什么」（D1 版）：账上的档实例，按发放先后（id 升序）。
 * @returns {Promise<{ok:boolean, error:string, detail:string, user_id:number, total:number,
 *   items:Array, keys:Array}>}
 */
export async function ledgerTiers(db, userId) {
  const uid = rewardLedgerUid(userId);
  const out = { ok: false, error: '', detail: '', user_id: uid, total: 0, items: [], keys: [] };
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let h = null;
  try {
    h = await ensureLedger(db);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  if (!h) {
    out.error = 'no_store';
    return out;
  }
  try {
    out.items = await ledgerRows(h, uid);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  const keys = [];
  for (const row of out.items) if (row.tier && keys.indexOf(row.tier) < 0) keys.push(row.tier);
  out.ok = true;
  out.total = out.items.length;
  out.keys = keys;
  return out;
}

/**
 * 流水翻页（新的在前）：{ total, items }——total 是该用户总行数，不受 limit 影响。
 * @param {object} db D1 绑定
 * @param {number} userId
 * @param {{limit?:number, offset?:number}} [opts] limit 默认 50 / 上限 200，offset 默认 0
 * @returns {Promise<{ok:boolean, error:string, detail:string, user_id:number, total:number,
 *   limit:number, offset:number, items:Array}>}
 */
export async function listLedger(db, userId, opts) {
  const uid = rewardLedgerUid(userId);
  const o = opts && typeof opts === 'object' ? opts : {};
  const limit = limitOf(o.limit, 50, 200);
  const offset = offsetOf(o.offset);
  const out = { ok: false, error: '', detail: '', user_id: uid, total: 0, limit: limit, offset: offset, items: [] };
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let h = null;
  try {
    h = await ensureLedger(db);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  if (!h) {
    out.error = 'no_store';
    return out;
  }
  try {
    const row = await cell(h, REWARD_LEDGER_SQL.count, [uid]);
    out.total = Number((row && row.n) || 0);
    out.items = (await rows(h, REWARD_LEDGER_SQL.page, [uid, limit, offset])).map(rewardLedgerRow);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = errText(err);
    return out;
  }
  out.ok = true;
  return out;
}

/**
 * 账本汇总（D1 版）：累计多少条 / 多少经验 / 拿了哪些档与称号，不随 stats 回落。
 * @returns {Promise<object>} 字段见 src/rewards.js 的 rewardLedgerSummary()
 */
export async function ledgerSummary(db, userId) {
  const uid = rewardLedgerUid(userId);
  if (!uid) return emptySummary(0, 'bad_user', '');
  let h = null;
  try {
    h = await ensureLedger(db);
  } catch (err) {
    return emptySummary(uid, 'ledger_error', errText(err));
  }
  if (!h) return emptySummary(uid, 'no_store', '');
  try {
    return rewardLedgerSummary(await ledgerRows(h, uid), uid);
  } catch (err) {
    return emptySummary(uid, 'ledger_error', errText(err));
  }
}
