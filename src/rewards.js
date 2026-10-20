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
 * 「谁也花不掉的数字」。要加币种得同时加一张领取记录表（user_rewards），那是 src/db.js 与
 * worker/schema.js 的活，不在本文件范围里。
 *
 * 口径与 src/social.js 的 dailyStats() 一致（定义见 src/daily.js 第八批）：
 *   · 连续天数 = stats.streak  —— 补做不续连续（补做能算完成数、能算全勤，就是不能续连续）
 *   · 当月全勤 = stats.perfect —— { month, total, done, perfect }，补做算全勤
 *   · 累计完成 = stats.total   —— 个人主页那条线（statsOf）里同一个数叫 stats.daily，两个都认
 * 缺字段（老调用只给 { total, streak, done }、stats.perfect / stats.calendar 都没有的情况）
 * 一律按 0 降级，不抛异常。
 *
 * 「已获得」是**快照口径**：它跟着传进来的 stats 现算，没有落库的领取记录——所以断签、翻月会让
 * reward.xp 回落（连续 30 天那档会掉回未获得）。要「拿过就永不掉」得加 user_rewards 表，
 * 由服务端在达成时落一行；在那之前页面按快照展示即可。
 */
import { levelOf, titleOf, xpFor } from './badges.js';

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
