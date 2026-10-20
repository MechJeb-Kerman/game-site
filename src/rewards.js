/**
 * 每日挑战的实质奖励（纯函数；Express 与 Workers 共用，worker 侧直接 import '../src/rewards.js'）。
 *
 * 为什么有这个文件：徽章只回答「点亮了没有」，16 枚拿满之后没有任何回报——README「后续可做」
 * 里那条「给全勤 / 长连续的实质奖励（现在只进徽章判定与页面展示）」说的就是这块。
 * 这里把三条线做成可累加、可展示的奖励，共 8 档：
 *   连续天数 7 / 14 / 30 / 100 天、当月全勤、累计完成 30 / 100 / 365 次。
 * 每档给 reward.xp（经验）与 reward.title（称号，可能为空串）；全部拿满 = 8000 经验。
 *
 * 经验是**另一套口径**，与 src/badges.js 的 levelOf() 各算各的、可叠加：
 *   显示用的总经验 = levelOf(stats).xp + rewardXp(stats)（一步到位用 rewardLevelOf(stats)）。
 *
 * 为什么 reward 里没有 coins：仓库没有钱包表、也没有能花掉它的地方，凭空造一个币种只会得到
 * 「谁也花不掉的数字」。要加币种得再立一张钱包表（文件末尾的 user_rewards 只记经验与称号，
 * 没有余额），那是 src/db.js 与 worker/schema.js 的活，不在本文件范围里。
 *
 * 口径与 src/social.js 的 dailyStats() 一致（定义见 src/daily.js 第八批）：
 *   · 连续天数 = stats.streak  —— 补做不续连续（补做能算完成数、能算全勤，就是不能续连续）
 *   · 当月全勤 = stats.perfect —— { month, total, done, perfect }，补做算全勤
 *   · 累计完成 = stats.total   —— 个人主页那条线（statsOf）里同一个数叫 stats.daily，两个都认
 * 缺字段（老调用只给 { total, streak, done }、stats.perfect / stats.calendar 都没有的情况）
 * 一律按 0 降级，不抛异常。
 *
 * 「已获得」有两种口径，页面各取所需：
 *   · 快照口径（本文件上半部分的 rewardsOf / rewardXp）：跟着传进来的 stats 现算，断签、翻月会让
 *     reward.xp 回落（连续 30 天那档会掉回未获得）——「还差多少」用它。
 *   · 流水口径（文件末尾的 user_rewards 那一节）：达成时落一行，**拿到就永不掉**——
 *     「已经获得什么」用它。两者叠加才是玩家真正的资产。
 */
import { levelOf, titleOf, xpFor } from './badges.js';
import { dayKey } from './daily.js';

/**
 * 奖励清单。rank 只在挑「当前最高称号」时用（越大越难得，跨家族的顺序是设计选择）；
 * need 是数值目标，kind = 'perfect' 那档的 need 不写死——由 stats.perfect.total
 * （本月已经过去的天数）在运行时填，否则每月 1 号永远不可能全勤。
 * badge 指向 src/badges.js 里同一件事的徽章 id（'' = 没有对应徽章，纯奖励）。
 */
const LIST = [
  { key: 'streak-7', kind: 'streak', rank: 1, icon: '🔥', title: '七日之火', desc: '连续 7 天完成每日挑战', need: 7, reward: { xp: 100, title: '' }, badge: 'streak-7' },
  { key: 'streak-14', kind: 'streak', rank: 2, icon: '⚡', title: '双周不辍', desc: '连续 14 天完成每日挑战', need: 14, reward: { xp: 250, title: '坚持者' }, badge: 'streak-14' },
  { key: 'streak-30', kind: 'streak', rank: 5, icon: '🌋', title: '月度不熄', desc: '连续 30 天完成每日挑战', need: 30, reward: { xp: 800, title: '不灭之火' }, badge: 'streak-30' },
  { key: 'streak-100', kind: 'streak', rank: 7, icon: '💎', title: '百日不熄', desc: '连续 100 天完成每日挑战', need: 100, reward: { xp: 3000, title: '百日不熄' }, badge: '' },
  { key: 'perfect-month', kind: 'perfect', rank: 4, icon: '🏅', title: '本月全勤', desc: '当月已经过去的每一天都完成每日挑战（补做算全勤、不算连续）', need: 0, reward: { xp: 500, title: '全勤达人' }, badge: 'perfect-month' },
  { key: 'total-30', kind: 'total', rank: 1, icon: '🗓️', title: '三十次打卡', desc: '累计完成 30 次每日挑战', need: 30, reward: { xp: 150, title: '' }, badge: 'daily-30' },
  { key: 'total-100', kind: 'total', rank: 3, icon: '📚', title: '百战之身', desc: '累计完成 100 次每日挑战', need: 100, reward: { xp: 700, title: '百战之身' }, badge: 'daily-100' },
  { key: 'total-365', kind: 'total', rank: 6, icon: '👑', title: '全年无休', desc: '累计完成 365 次每日挑战', need: 365, reward: { xp: 2500, title: '全年无休' }, badge: '' }
];
for (const d of LIST) Object.freeze(d.reward);

/** 奖励清单（冻结；页面可以直接拿它做「奖励一览」，不用再调 rewardsOf） */
export const REWARDS = Object.freeze(LIST);

/** 数值兜底：非有限数 / 负数 / 空值一律当 0（stats 可能来自老调用点或半截对象） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把任意 stats 归一化成三条线的进度：
 *   streak 连续天数、total 累计完成（老档案的 daily 兜底）、perfect 当月全勤三件套。
 * 拿不到的一律是 0（perfectTotal = 0 表示「这个月还没过去任何一天」，不是「已全勤」）。
 */
function progressOf(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const p = s.perfect && typeof s.perfect === 'object' ? s.perfect : null;
  const perfectTotal = num(p && p.total);
  const perfectDone = Math.min(num(p && p.done), perfectTotal);
  return {
    streak: num(s.streak),
    total: num(s.total !== undefined && s.total !== null ? s.total : s.daily),
    perfectMonth: p ? String(p.month || '') : '',
    perfectTotal: perfectTotal,
    perfectDone: perfectDone,
    // 「全勤」的定义就是「已经过去的日子都打过卡」，done >= total 本身就是结论，daily.js 的
    // perfect 标记是同一个算式的另一种写法。两边都认：少给一个字段也判得出来，全缺就是 false。
    perfectReached: perfectTotal > 0 && (p.perfect === true || perfectDone >= perfectTotal)
  };
}

/** 达成点的短标签（给页面直接显示，比 desc 短：连续看第几天、全勤看月份、累计看第几次） */
function atOf(def, prog) {
  if (def.kind === 'streak') return '连续第 ' + def.need + ' 天';
  if (def.kind === 'total') return '累计第 ' + def.need + ' 次';
  return prog.perfectMonth ? prog.perfectMonth + ' 全勤' : '本月全勤';
}

/** 由清单 + 进度拼出一条奖励；now 夹到 need（与 badgesOf 一致，进度条不会超 100%） */
function build(def, prog) {
  const need = def.kind === 'perfect' ? prog.perfectTotal : def.need;
  const raw = def.kind === 'streak' ? prog.streak : def.kind === 'total' ? prog.total : prog.perfectDone;
  const now = Math.min(raw, need);
  return {
    key: def.key,
    kind: def.kind,
    icon: def.icon,
    title: def.title,
    desc: def.desc,
    need: need,
    now: now,
    done: def.kind === 'perfect' ? prog.perfectReached : now >= need,
    at: atOf(def, prog),
    reward: def.reward,
    badge: def.badge,
    rank: def.rank,
    left: Math.max(0, need - now)
  };
}

/**
 * 全部奖励（含未获得的进度），按「连续 → 全勤 → 累计」的清单顺序返回（同档内由易到难）。
 * 每项：{ key, kind, icon, title, desc, need, now, done, at, reward, badge, rank, left }
 *   · title 是奖励名，reward.title 才是奖励的**称号**（'' = 这档只给经验）
 *   · now / need 是数值进度，left 是还差多少（= need - now，未获得时才有意义）
 */
export function rewardsOf(stats) {
  const prog = progressOf(stats);
  return REWARDS.map((def) => build(def, prog));
}

/** 已经拿到的奖励经验（与 levelOf 的口径各算各的，可叠加：levelOf(stats).xp + rewardXp(stats)） */
export function rewardXp(stats) {
  const prog = progressOf(stats);
  let xp = 0;
  for (const def of REWARDS) if (build(def, prog).done) xp += num(def.reward.xp);
  return xp;
}

/**
 * 奖励汇总：{ total, owned, xp, title, next }
 *   · total 档数、owned 已获得档数、xp 已获得奖励的经验合计（快照口径）
 *   · title 当前最高称号（按 rank 取；一个称号都没有时是 ''，页面自己决定退回 titleOf(level)）
 *   · next 未获得里进度最高的那一档（同一档对象 + left 还差多少 + percent 进度百分比），
 *     全拿满时是 null；need = 0 的档（本月还没过去任何一天）不参与，免得挑出一个「还差 0」的
 */
export function rewardSummary(stats) {
  const list = rewardsOf(stats);
  const owned = list.filter((r) => r.done);
  let xp = 0;
  let title = '';
  let rank = 0;
  for (const r of owned) {
    xp += num(r.reward.xp);
    if (r.reward.title && r.rank > rank) {
      rank = r.rank;
      title = r.reward.title;
    }
  }
  let best = null;
  for (const r of list) {
    if (r.done || r.need <= 0) continue;
    const score = r.now / r.need;
    // 并列时先挑 need 小的（绝对门槛低），再并列按清单顺序（先到先得，结果稳定）
    if (!best || score > best.score || (score === best.score && r.need < best.item.need)) best = { score: score, item: r };
  }
  return {
    total: list.length,
    owned: owned.length,
    xp: xp,
    title: title,
    next: best ? Object.assign({}, best.item, { left: Math.max(0, best.item.need - best.item.now), percent: Math.round(best.score * 100) }) : null
  };
}

/**
 * 便利函数：把奖励经验并进等级（levelOf 的 XP + rewardXp），一次算好等级 / 称号 / 进度，
 * 页面不用自己抄那个升级循环。返回 { xp, bonus, level, floor, next, need, title }，
 * 字段含义与 src/badges.js 的 levelOf() 完全一致，多一个 bonus = 其中来自奖励的部分。
 */
export function rewardLevelOf(stats) {
  const base = levelOf(stats);
  const bonus = rewardXp(stats);
  const xp = base.xp + bonus;
  let level = 1;
  while (level < 99 && xp >= xpFor(level + 1)) level++;
  return { xp: xp, bonus: bonus, level: level, floor: xpFor(level), next: xpFor(level + 1), need: Math.max(0, xpFor(level + 1) - xp), title: titleOf(level) };
}
/* ==========================================================================
 * 奖励流水（user_rewards）：拿到就不掉
 *
 * 快照口径的问题（README「这一轮」那条讲的就是它）：rewardsOf() 跟着传进来的 stats 现算，
 * 连续 30 天那档在断签之后会掉回未获得、翻月后当月全勤也会归零——「已经拿过的经验会消失」。
 * 这一节加一张流水表：服务端在**达成的那一刻**往 user_rewards 落一行；之后 stats 怎么回落，
 * 历史流水都在，页面按流水展示「已获得」即可。
 *
 * 表 user_rewards（DDL 见下面的 REWARD_LEDGER_DDL）。src/db.js 与 worker/schema.js 本次不许动，
 * 所以按 src/outbox.js 的 SUPPRESSION_DDL 那套「模块自带 DDL + 幂等自愈」自己建表：
 *   id         自增主键
 *   user_id    玩家 id（INTEGER）
 *   day        'YYYY-MM-DD'，**发放日**（不是达成日：补做 / 回填可以用 opts.day 指定）
 *   tier       REWARDS 里的档位 key（'streak-7' / 'perfect-month' / 'total-30' ...）
 *   kind       'streak' | 'perfect' | 'total'（冗余一列：页面不 join REWARDS 也能按线分组）
 *   amount     该档的经验数（= 当时的 reward.xp；落库是为了以后改清单也不影响老流水）
 *   title      该档给的**称号**（'' = 这档只给经验）——称号是资产，落库才不会随快照回落
 *   month      'YYYY-MM'：perfect 档的**达成月**（跨月各发一次），其它档 ''
 *   need       发放时的门槛（perfect 档 = 当月已经过去的每一天数）
 *   value      发放时的**真实进度**（不夹到 need：所以看得到「连续 9 天时发的 7 天档」）
 *   created_at 毫秒数（INTEGER）——与 daily_results.created_at / elo_history / mail_suppression 同口径。
 *              流水要按时间倒序翻页，秒级的文本时间在同一次测试里会大面积并列，所以不用文本时间。
 *
 * 索引（4 条）：
 *   idx_user_rewards_once  UNIQUE(user_id, day, tier)   同一个人同一天同一档只有一行（幂等键）
 *   idx_user_rewards_grant UNIQUE(user_id, tier, month) 发放身份：连续/累计档 month='' 一生一行，
 *                                                       perfect 档每个月各一行（跨月是新的一档实例）
 *   idx_user_rewards_user  (user_id, id DESC)           翻页：某个人的流水按发放先后倒序取
 *   idx_user_rewards_day   (day)                        日报 / 后台按天看今天发了什么
 *
 * 幂等不靠「先查后写」而靠唯一索引 + INSERT OR IGNORE：并发重复调用（同一 tick 连发两次、
 * 两条线打同一个库）时第二次 changes=0，回 added:0 / already:true，一行都不会多、经验不会多发。
 *
 * 与快照的关系：rewardsOf / rewardXp / rewardSummary / rewardLevelOf 一个字都没动（快照口径照旧，
 * 进度条继续用它）。要「已获得」就叠加流水：rewardXp(stats) 是「现在够得着的」，
 * ledgerSummary(uid).xp 是「拿到手的」，中间差集就是这次该补的（dueRewards()）。
 * 「某天该发什么」（dueRewards）与「已经发了什么」（ledgerTiers）是两个解耦的查询：
 * 断签之后前者会变少，后者一条都不会少。
 *
 * 两条线只有一份规则：下面 rewardLedger* 那几个**纯函数**（扫描 / 造条目 / 汇总）同时被 Express 线
 * 与本文件调用，worker/rewards.js 复用同一份 REWARD_LEDGER_DDL / REWARD_LEDGER_SQL 和同样的纯函数，
 * 它只重写「怎么问库」（D1 只有 await 版、db 从第一个参数来），不重写 8 档规则——所以不会出现
 * 「同一档 Express 算达成、Worker 算没达成」。
 * 因此本文件顶层**不出现 node: 的 import**（内置模块一律 process.getBuiltinModule 惰性取），
 * 否则 worker 打包会把 node:sqlite / node:fs 拖下水（worker 线本来就 import 本文件）。
 *
 * 一律不抛：缺字段 / 非法档位 / 没有连接 / SQL 出错，都回 ok:false + 一份字段齐全的安全返回
 * （调用方读 r.added 不会炸），与 src/outbox.js 的 enqueue 是同一个纪律。
 * ========================================================================== */

/**
 * user_rewards 的建表语句（worker/rewards.js 复用同一个数组）。
 * **每条必须是单行字符串**：Worker 线走 D1，而 D1 的 exec() 是按换行切语句执行的，
 * 跨多行的 CREATE TABLE 会被切坏（D1_EXEC_ERROR: ... incomplete input）。
 * 下面用 JS 的字符串相接「写成多行、拼成一行」——运行时不含换行符，两条线都能直接用。
 */
export const REWARD_LEDGER_DDL = [
  'CREATE TABLE IF NOT EXISTS user_rewards (' +
    '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  user_id    INTEGER NOT NULL,' +
    '  day        TEXT NOT NULL,' +
    '  tier       TEXT NOT NULL,' +
    "  kind       TEXT NOT NULL DEFAULT ''," +
    '  amount     INTEGER NOT NULL DEFAULT 0,' +
    "  title      TEXT NOT NULL DEFAULT ''," +
    "  month      TEXT NOT NULL DEFAULT ''," +
    '  need       INTEGER NOT NULL DEFAULT 0,' +
    '  value      INTEGER NOT NULL DEFAULT 0,' +
    '  created_at INTEGER NOT NULL' +
    ')',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_rewards_once ON user_rewards(user_id, day, tier)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_rewards_grant ON user_rewards(user_id, tier, month)',
  'CREATE INDEX IF NOT EXISTS idx_user_rewards_user ON user_rewards(user_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_user_rewards_day ON user_rewards(day)'
];

/** 流水用的 SQL（worker/rewards.js 复用同一份文本：占位符两边都是 ?，语义也一样） */
export const REWARD_LEDGER_SQL = Object.freeze({
  insert: 'INSERT OR IGNORE INTO user_rewards (user_id, day, tier, kind, amount, title, month, need, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  rows: 'SELECT * FROM user_rewards WHERE user_id = ? ORDER BY id ASC',
  page: 'SELECT * FROM user_rewards WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  count: 'SELECT COUNT(*) AS n FROM user_rewards WHERE user_id = ?',
  paid: 'SELECT id, day, tier, month, created_at FROM user_rewards WHERE user_id = ?'
});

/* ───────────────────── 两条线共用的纯函数（不碰连接） ───────────────────── */

/** 归一 userId：非正整数一律 0（0 = 没有这个用户，读出来是空账本，也写不进去） */
export function rewardLedgerUid(userId) {
  const n = Math.floor(Number(userId));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 发放身份：tier + month 拼成内存键，与 DDL 的 UNIQUE(user_id, tier, month) 一一对应 */
function rewardLedgerKey(tier, month) {
  return String(tier || '') + '@' + String(month || '');
}

/** 'YYYY-MM-DD' 校验；不合法 / 没给就退回「now 那一天」（日界与 src/daily.js 的 dayKey 同一个） */
function rewardLedgerDay(day, now) {
  const s = String(day === undefined || day === null ? '' : day).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : dayKey(now);
}

/** 时间戳归一：不传=现在、Date、毫秒数、或可解析的文本（都回毫秒数；非法回现在） */
function rewardLedgerMs(now) {
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  if (typeof now === 'string' && now.trim()) {
    const t = new Date(now.trim().replace(' ', 'T')).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Date.now();
}

/**
 * 发放身份里的月份：perfect 档用 stats.perfect.month（**达成月**），其它档 ''。
 * month 缺失（老调用点没给 perfect）时退回发放日的月份——至少不会把两个月的全勤记成一行。
 */
export function rewardLedgerMonth(def, prog, day) {
  if (def.kind !== 'perfect') return '';
  const m = String(prog.perfectMonth || '').trim();
  return /^\d{4}-\d{2}$/.test(m) ? m : day.slice(0, 7);
}

/**
 * 行归一：node:sqlite 的 changes / lastInsertRowid 可能是 BigInt，D1 是 number，统一成 number。
 * 列名与流水表一致；缺列补 0 / ''（两条线的返回值形状因此完全一样）。
 */
export function rewardLedgerRow(r) {
  const row = r && typeof r === 'object' ? r : {};
  return {
    id: Number(row.id || 0),
    user_id: Number(row.user_id || 0),
    day: String(row.day || ''),
    tier: String(row.tier || ''),
    kind: String(row.kind || ''),
    amount: Number(row.amount || 0),
    title: String(row.title || ''),
    month: String(row.month || ''),
    need: Number(row.need || 0),
    value: Number(row.value || 0),
    created_at: Number(row.created_at || 0)
  };
}

/** 一次扫描（纯函数）：把 stats 归一成「达到了哪几档」，并把账上已发的发放身份并进来 */
export function rewardLedgerScan(paidRows, userId, stats, opts) {
  const uid = rewardLedgerUid(userId);
  const now = rewardLedgerMs(opts && opts.now);
  const day = rewardLedgerDay(opts && opts.day, now);
  const prog = progressOf(stats);
  const paid = new Map();
  for (const r of paidRows || []) {
    const row = rewardLedgerRow(r);
    if (row.tier) paid.set(rewardLedgerKey(row.tier, row.month), row);
  }
  const reached = [];
  if (uid) {
    for (const def of REWARDS) {
      const built = build(def, prog);
      if (!built.done) continue;
      const month = rewardLedgerMonth(def, prog, day);
      reached.push({ def: def, built: built, month: month, key: rewardLedgerKey(def.key, month) });
    }
  }
  return { user_id: uid, day: day, now: now, prog: prog, reached: reached, paid: paid };
}

/**
 * 一档 → 流水条目。入参 prog 是扫描出来的进度、paidRow 是账上那一行（没发过传 null）。
 * 返回 = 档对象（key/kind/icon/title/desc/need/now/done/at/reward/badge/rank/left）
 *   + tier（= REWARDS 的 key）、month（perfect 档的达成月）、amount（经验）、
 *     value（发放时的真实进度，不夹到 need）、paid / paid_day / paid_at / paid_id。
 * 真写了行的那次由调用方再补 id / day / created_at / added。
 */
export function rewardLedgerItem(def, prog, month, paidRow) {
  const built = build(def, prog);
  const paid = paidRow || {};
  const raw = def.kind === 'streak' ? prog.streak : def.kind === 'total' ? prog.total : prog.perfectDone;
  return Object.assign({}, built, {
    tier: def.key,
    month: month,
    amount: num(def.reward.xp),
    value: raw,
    paid: !!paid.tier,
    paid_day: paid.day || '',
    paid_at: Number(paid.created_at || 0),
    paid_id: Number(paid.id || 0)
  });
}

/**
 * 账本汇总（纯函数，两条线共用同一份口径）：流水行 → 累计 / 按档 / 称号。
 * 一个用户的流水有界（最多 8 档 + 每月一条全勤），所以一次取回内存里算，比几条 GROUP BY 好读。
 * 返回 { ok:true, error:'', user_id, total, owned, xp, days, first_day, last_day, first_at, last_at,
 *        title, titles, kinds, tiers }：
 *   · total 行数（跨月的 perfect-month 各算一条）、owned 去重后的档数、xp 账上经验合计
 *   · title / titles 账上**最高称号**与去重称号清单（按 REWARDS 的 rank 排；称号是资产，不会掉）
 *   · kinds { streak|perfect|total: { count, xp } }（三条线都恒在，页面不用判空）
 *   · tiers 按档汇总（按 REWARDS 清单顺序）：{ tier, kind, icon, name, desc, badge, rank, count,
 *     months, amount, xp, title, need, value, first_day, last_day, first_at, last_at, last_id }
 */
export function rewardLedgerSummary(rows, userId) {
  const out = {
    ok: true, error: '', detail: '', user_id: rewardLedgerUid(userId), total: 0, owned: 0, xp: 0, days: 0,
    first_day: '', last_day: '', first_at: 0, last_at: 0, title: '', titles: [],
    kinds: { streak: { count: 0, xp: 0 }, perfect: { count: 0, xp: 0 }, total: { count: 0, xp: 0 } },
    tiers: []
  };
  const list = [];
  for (const r of rows || []) list.push(rewardLedgerRow(r));
  if (!list.length) return out;
  const days = [];
  const tiers = new Map();
  const titles = new Map();
  for (const row of list) {
    out.total++;
    out.xp += row.amount;
    if (days.indexOf(row.day) < 0) days.push(row.day);
    if (!out.first_at || row.created_at < out.first_at) out.first_at = row.created_at;
    if (row.created_at > out.last_at) out.last_at = row.created_at;
    if (!out.first_day || row.day < out.first_day) out.first_day = row.day;
    if (row.day > out.last_day) out.last_day = row.day;
    const def = LEDGER_DEFS.get(row.tier);
    const kind = row.kind || (def ? def.kind : '');
    if (!out.kinds[kind]) out.kinds[kind] = { count: 0, xp: 0 };
    out.kinds[kind].count++;
    out.kinds[kind].xp += row.amount;
    let t = tiers.get(row.tier);
    if (!t) {
      t = {
        tier: row.tier, kind: kind, icon: def ? def.icon : '', name: def ? def.title : row.tier,
        desc: def ? def.desc : '', badge: def ? def.badge : '', rank: def ? def.rank : 0,
        count: 0, months: [], amount: row.amount, xp: 0, title: '', need: row.need, value: row.value,
        first_day: row.day, last_day: row.day, first_at: row.created_at, last_at: row.created_at, last_id: row.id
      };
      tiers.set(row.tier, t);
    }
    t.count++;
    t.xp += row.amount;
    if (row.month && t.months.indexOf(row.month) < 0) t.months.push(row.month);
    if (row.title) t.title = row.title;
    if (row.day < t.first_day) t.first_day = row.day;
    if (row.day > t.last_day) t.last_day = row.day;
    if (row.created_at < t.first_at) t.first_at = row.created_at;
    if (row.created_at >= t.last_at) {
      t.last_at = row.created_at;
      t.last_id = row.id;
      t.need = row.need;
      t.value = row.value;
    }
    if (row.title) {
      const rank = def ? def.rank : 0;
      const prev = titles.get(row.title);
      if (prev === undefined || rank > prev) titles.set(row.title, rank);
    }
  }
  out.days = days.length;
  out.owned = tiers.size;
  out.tiers = Array.from(tiers.values()).sort(function (a, b) {
    const ia = REWARDS.findIndex((d) => d.key === a.tier);
    const ib = REWARDS.findIndex((d) => d.key === b.tier);
    const ka = ia < 0 ? REWARDS.length + 1 : ia;
    const kb = ib < 0 ? REWARDS.length + 1 : ib;
    return ka === kb ? (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0) : ka - kb;
  });
  out.titles = Array.from(titles.entries()).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  out.title = out.titles.length ? out.titles[0] : '';
  return out;
}

/** 档位清单的索引：tier -> def（清单里没有的档取不到，按空档处理） */
const LEDGER_DEFS = new Map(REWARDS.map((d) => [d.key, d]));

/* ───────────────────── Express 线的连接（Worker 线见 worker/rewards.js） ───────────────────── */

let ledgerReady = null;     // 建过表的连接（同一个连接只建一次）
let ledgerOverride = null;  // useRewardStore() 换进来的连接（测试用）
let ledgerTried = false;    // 默认连接探测过没有
let ledgerAuto = null;      // 惰性探测到的默认连接

/** 内置模块（拿不到就 null）：顶层不写 node: import，Worker 打包才不会被拖下水 */
function ledgerBuiltin(name) {
  const p = typeof process !== 'undefined' ? process : null;
  if (!p || typeof p.getBuiltinModule !== 'function') return null;
  try { return p.getBuiltinModule(name) || null; } catch { return null; }
}

/**
 * 默认连接（调用方没注入 store 时的兜底）：
 *   1. 首选复用 src/db.js 的那个连接——server.js / src/social.js 用的就是它，不额外开连接。
 *      用 require(esm) 取（Node 22.12+ 免 flag）；22.5~22.11 会抛，落到第 2 步。
 *   2. 兜底自己开一个同库连接（data/games.db，WAL + busy_timeout；与主连接并存），表由 ensureLedger() 自建。
 * Worker 线两条都取不到（没有 process.getBuiltinModule）→ 返回 null，调用方回 ok:false /
 * error:'no_store'（Worker 侧必须把 db 当第一个参数传，见 worker/rewards.js）。
 * 全程 try/catch：探测失败只是「没有默认连接」，不能把 import 或一次调用打挂。
 */
function ledgerAutoOpen() {
  try {
    const m = ledgerBuiltin('node:module');
    if (m && typeof m.createRequire === 'function') {
      const mod = m.createRequire(import.meta.url)('./db.js');
      if (mod && mod.db) return mod.db;
    }
  } catch { /* require(esm) 不可用或 db.js 起不来：走兜底 */ }
  try {
    const sqlite = ledgerBuiltin('node:sqlite');
    const path = ledgerBuiltin('node:path');
    const url = ledgerBuiltin('node:url');
    const fs = ledgerBuiltin('node:fs');
    if (!sqlite || !sqlite.DatabaseSync || !path || !url || !fs) return null;
    const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const dir = path.join(root, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const handle = new sqlite.DatabaseSync(path.join(dir, 'games.db'));
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA busy_timeout = 5000');
    return handle;
  } catch { return null; }
}

/** 当前连接：注入了就用注入的，否则惰性探测一次（探不到就是 null） */
function ledgerStore() {
  if (ledgerOverride) return ledgerOverride;
  if (!ledgerTried) {
    ledgerTried = true;
    ledgerAuto = ledgerAutoOpen();
  }
  return ledgerAuto;
}

/**
 * 测试钩子：把流水接到另一个 SQLite 连接上（tools/rewards-ledger-test.mjs 跑临时库，不碰
 * data/games.db），传 null 恢复默认。返回之前的连接。生产代码不要用。
 */
export function useRewardStore(handle) {
  const prev = ledgerOverride;
  ledgerOverride = handle || null;
  ledgerReady = null;
  return prev;
}

/**
 * 幂等建表（每个连接只跑一次）；导出是给调用方在启动时预热用，普通调用不必手动调。
 * 返回用到的连接；没有连接（Worker 线 / 探测失败）返回 null——不抛。
 */
export function ensureLedger() {
  const h = ledgerStore();
  if (!h) return null;
  if (ledgerReady === h) return h;
  for (const sql of REWARD_LEDGER_DDL) h.exec(sql);
  ledgerReady = h;
  return h;
}

/** 账上已发的行 → 扫描（Express 侧：取连接、查一次、交给纯函数） */
function ledgerScan(userId, stats, opts) {
  const out = { ok: false, error: 'no_store', detail: '', user_id: rewardLedgerUid(userId), day: '', now: 0, prog: null, reached: [], paid: new Map(), handle: null };
  let h = null;
  try {
    h = ensureLedger();
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  if (!h) return out;
  out.handle = h;
  const uid = rewardLedgerUid(userId);
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let rows = [];
  try {
    rows = h.prepare(REWARD_LEDGER_SQL.paid).all(uid);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  const scan = rewardLedgerScan(rows, uid, stats, opts);
  scan.ok = true;
  scan.error = '';
  scan.detail = '';
  scan.handle = h;
  return scan;
}

/** 账上全部流水（归一后的行，id 升序）；读失败用 throw 传给调用方统一兜 */
function ledgerRowsOf(h, uid) {
  return h.prepare(REWARD_LEDGER_SQL.rows).all(uid).map(rewardLedgerRow);
}

/**
 * 写一行流水（INSERT OR IGNORE）。added=false 表示账上已经有这一行（幂等命中，不是错误）。
 * 落库的 amount / need / value 全部来自 rewardLedgerItem（与返回给页面的条目同源）。
 */
function ledgerWrite(scan, hit) {
  const def = hit.def;
  const item = rewardLedgerItem(def, scan.prog, hit.month, null);
  try {
    const info = h_prepare(scan).run(scan.user_id, scan.day, def.key, def.kind, item.amount, String(def.reward.title || ''), hit.month, item.need, item.value, scan.now);
    const changes = Number((info && info.changes) || 0);
    const id = Number((info && info.lastInsertRowid) || 0);
    if (changes > 0) {
      scan.paid.set(hit.key, { id: id, day: scan.day, tier: def.key, month: hit.month, created_at: scan.now });
      return { added: true, id: id, amount: item.amount, item: item, error: '' };
    }
    return { added: false, id: 0, amount: item.amount, item: item, error: '' };
  } catch (err) {
    return { added: false, id: 0, amount: item.amount, item: item, error: String((err && err.message) || err) };
  }
}

/** 插入语句按连接缓存一次（node:sqlite 的 prepare 是同步的，省下的是一次次重编译） */
function h_prepare(scan) {
  if (!scan.stmt) scan.stmt = scan.handle.prepare(REWARD_LEDGER_SQL.insert);
  return scan.stmt;
}

/**
 * 发放奖励：把 stats 里**达到且账上还没有**的档各写一行流水。
 * 同一个 (user, day, tier) 只会有一行——重复调用回 added:0 / already:true，不再多发经验。
 *
 * @param {number} userId 玩家 id（非正整数 → ok:false / error:'bad_user'）
 * @param {object} stats  src/social.js dailyStats() 的形状；缺字段一律按 0 降级（不抛）
 * @param {{day?:string, now?:number|Date|string}} [opts] day = 发放日（补做 / 回填用，默认今天），
 *        now = created_at（默认现在）
 * @returns {{ok:boolean, error:string, detail:string, user_id:number, day:string, now:number, seen:number,
 *   added:number, already:boolean, xp:number, granted:Array, skipped:Array, summary:object|null}}
 *   · seen    本次判定**达到**的档数（含早就发过的）；added 本次真写进去的行数；xp 这些行的经验合计
 *   · already added===0 且 seen>0（都是重复调用），没达到任何档时是 false
 *   · granted 这次新发的档（条目 + id / day / created_at / added:true）
 *   · skipped 这次没写的档：{ tier, month, amount, reason:'paid'|'error', error }
 *   · summary 发放之后的账本（= ledgerSummary(userId)，页面一次调用就能刷新）
 */
export function grantRewards(userId, stats, opts) {
  const scan = ledgerScan(userId, stats, opts);
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
    const w = ledgerWrite(scan, hit);
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
  out.summary = ledgerSummaryOf(scan.handle, scan.user_id);
  return out;
}

/**
 * 单档发放（补发 / 后台用；grantRewards 内部也是这个路子）。
 * 只认 REWARDS 里有的档，而且**只有 stats 判定为已达成**才写——没有 force，凭空造不出一档经验。
 * @returns {{ok:boolean, error:string, detail:string,
 *   reason:'ok'|'paid'|'unknown'|'not_reached'|'bad_user'|'no_store'|'ledger_error',
 *   user_id:number, day:string, now:number, tier:string, month:string, added:boolean, xp:number, item:object|null}}
 *   · ok:true 只表示「账上现在是发过的状态」；真写了行才是 added:true（幂等命中回 ok:true / reason:'paid'）
 *   · item.id / item.day / item.created_at 永远指向「这一档的流水行」：新发的 = 刚写的行，
 *     早发过的 = 账上原来那行（added 字段只在真写了行时出现，幂等命中那次没有）
 */
export function grantTier(userId, tier, stats, opts) {
  const name = String(tier === undefined || tier === null ? '' : tier).trim();
  const scan = ledgerScan(userId, stats, opts);
  const out = { ok: false, error: '', detail: '', reason: '', user_id: scan.user_id, day: scan.day, now: scan.now, tier: name, month: '', added: false, xp: 0, item: null };
  const def = LEDGER_DEFS.get(name);
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
  const w = ledgerWrite(scan, hit);
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
 * 「某天该发什么」：按 stats 算**达到且账上还没有**的档，只读不写（要先看再发就用它）。
 * 与 ledgerTiers() 解耦——断签之后这里会变少，账上那条不会少。
 * @returns {{ok:boolean, error:string, detail:string, user_id:number, day:string, now:number, items:Array,
 *   count:number, reached:number, paid:number, xp:number}}
 *   · items 每项 = 流水条目（档对象 + tier / month / amount / value / paid:false）
 *   · reached 达到的档数、paid 其中早就发过的档数、xp 这次该发多少经验
 */
export function dueRewards(userId, stats, opts) {
  const scan = ledgerScan(userId, stats, opts);
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
 * 「已经发了什么」：账上的档实例（一个人 + 一档 + 一个月 = 一条），按发放先后（id 升序）返回。
 * 拿到就不掉——断签、翻月都不会让这里的行消失。
 * @returns {{ok:boolean, error:string, detail:string, user_id:number, total:number, items:Array, keys:Array}}
 *   · items 流水行原样（id / user_id / day / tier / kind / amount / title / month / need / value / created_at）
 *   · keys  去重后的档位清单（如 ['streak-7','perfect-month']），页面标「已获得」直接用它
 */
export function ledgerTiers(userId) {
  const uid = rewardLedgerUid(userId);
  const out = { ok: false, error: '', detail: '', user_id: uid, total: 0, items: [], keys: [] };
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let h = null;
  try {
    h = ensureLedger();
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  if (!h) {
    out.error = 'no_store';
    return out;
  }
  try {
    out.items = ledgerRowsOf(h, uid);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  const keys = [];
  for (const row of out.items) if (row.tier && keys.indexOf(row.tier) < 0) keys.push(row.tier);
  out.ok = true;
  out.total = out.items.length;
  out.keys = keys;
  return out;
}

/** 分页参数：limit 默认 50、上限 200；offset 至少 0（与 src/outbox.js 的 clampLimit 同规矩） */
function ledgerLimit(limit, def, max) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function ledgerOffset(offset) {
  const n = Math.floor(Number(offset));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 流水翻页（新的在前）：{ total, items }——total 是该用户的总行数（不受 limit 影响）。
 * @param {number} userId
 * @param {{limit?:number, offset?:number}} [opts] limit 默认 50 / 上限 200，offset 默认 0
 * @returns {{ok:boolean, error:string, detail:string, user_id:number, total:number, limit:number,
 *   offset:number, items:Array}}
 */
export function listLedger(userId, opts) {
  const uid = rewardLedgerUid(userId);
  const o = opts && typeof opts === 'object' ? opts : {};
  const limit = ledgerLimit(o.limit, 50, 200);
  const offset = ledgerOffset(o.offset);
  const out = { ok: false, error: '', detail: '', user_id: uid, total: 0, limit: limit, offset: offset, items: [] };
  if (!uid) {
    out.error = 'bad_user';
    return out;
  }
  let h = null;
  try {
    h = ensureLedger();
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  if (!h) {
    out.error = 'no_store';
    return out;
  }
  try {
    const row = h.prepare(REWARD_LEDGER_SQL.count).get(uid) || {};
    out.total = Number(row.n || 0);
    out.items = h.prepare(REWARD_LEDGER_SQL.page).all(uid, limit, offset).map(rewardLedgerRow);
  } catch (err) {
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  out.ok = true;
  return out;
}

/**
 * 账本汇总（页面用这个）：累计多少条 / 多少经验 / 拿了哪些档与称号，**不随 stats 回落**。
 * 把奖励经验并进等级时，ledgerSummary(uid).xp 才是「拿到就不掉」的那一份
 * （rewardXp(stats) 仍是快照口径，两个数会随着断签拉开）。
 */
function ledgerSummaryOf(h, uid) {
  try {
    return rewardLedgerSummary(ledgerRowsOf(h, uid), uid);
  } catch (err) {
    const out = rewardLedgerSummary([], uid);
    out.ok = false;
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
}

/**
 * 账本汇总：字段见 rewardLedgerSummary()；没有连接 / 非法用户时回 ok:false 的空账本
 * （字段齐全，页面不用判空）。
 */
export function ledgerSummary(userId) {
  const uid = rewardLedgerUid(userId);
  if (!uid) {
    const out = rewardLedgerSummary([], 0);
    out.ok = false;
    out.error = 'bad_user';
    return out;
  }
  let h = null;
  try {
    h = ensureLedger();
  } catch (err) {
    const out = rewardLedgerSummary([], uid);
    out.ok = false;
    out.error = 'ledger_error';
    out.detail = String((err && err.message) || err);
    return out;
  }
  if (!h) {
    const out = rewardLedgerSummary([], uid);
    out.ok = false;
    out.error = 'no_store';
    return out;
  }
  return ledgerSummaryOf(h, uid);
}
