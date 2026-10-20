/**
 * 每日挑战的实质奖励（src/rewards.js）回归测试。
 *
 * 运行：node tools/daily-reward-test.mjs
 * 前置：无——纯函数，不建库、不占端口、不发请求、不复制 src/（奖励体系没有数据库那半边，
 *   也就没有 worker 镜像；两条线共用同一份 src/rewards.js，所以一份矩阵测试就够）。
 *
 * 覆盖：8 档奖励的边界（刚好达标 / 差一天）、补做不续连续、断签与翻月的快照回落、
 *   calendar / perfect 缺失时的降级、rewardSummary 的汇总与「下一个奖励」、
 *   rewardLevelOf 把奖励经验并进等级，以及 src/badges.js「前 16 枚徽章一个字符都没变」的回归
 *   （内联清单对照 —— 追加新徽章不得动上面 16 枚的 id / icon / name / desc / stat / need）。
 * 结尾打印「通过 N / 失败 M」，有失败 exit 1。
 */
import { REWARDS, rewardsOf, rewardSummary, rewardXp, rewardLevelOf } from '../src/rewards.js';
import { BADGES, badgesOf, levelOf, titleOf, xpFor } from '../src/badges.js';

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

/* ---------- 夹具 ---------- */

/** dailyStats() 的真实形状（带 calendar / perfect / doneRows），缺什么传什么 */
const daily = (o) => Object.assign({ day: '2026-05-20', slug: 'g1', total: 0, streak: 0, doneToday: false, done: [] }, o);
/** monthPerfect() 的真实形状 */
const perfectOf = (month, total, done) => ({ month: month, total: total, done: done, perfect: total > 0 && done >= total });
const item = (stats, key) => rewardsOf(stats).find((r) => r.key === key) || {};
const ownedKeys = (stats) => rewardsOf(stats).filter((r) => r.done).map((r) => r.key);

const FULL = daily({ total: 400, streak: 120, perfect: perfectOf('2026-05', 20, 20) });
const FIELD = ['key', 'kind', 'icon', 'title', 'desc', 'need', 'now', 'done', 'at', 'reward', 'badge', 'rank', 'left'];

/* ---------- A 奖励清单本身的形状 ---------- */
console.log('--- A 奖励清单 ---');
eq('清单 8 档', REWARDS.length, 8);
eq('key 不重复', new Set(REWARDS.map((r) => r.key)).size, 8);
eq('三种 kind 的顺序', REWARDS.map((r) => r.kind), ['streak', 'streak', 'streak', 'streak', 'perfect', 'total', 'total', 'total']);
eq('连续档 7 / 14 / 30 / 100', REWARDS.filter((r) => r.kind === 'streak').map((r) => r.need), [7, 14, 30, 100]);
eq('累计档 30 / 100 / 365', REWARDS.filter((r) => r.kind === 'total').map((r) => r.need), [30, 100, 365]);
ok('每档都有正的 reward.xp', REWARDS.every((r) => Number(r.reward.xp) > 0), JSON.stringify(REWARDS.map((r) => r.reward)));
ok('REWARDS 与 reward 都被冻结', Object.isFrozen(REWARDS) && REWARDS.every((r) => Object.isFrozen(r.reward)));
ok('每项字段齐全', rewardsOf(FULL).every((r) => FIELD.every((k) => k in r)), JSON.stringify(rewardsOf(FULL)[0]));
ok('reward 只有 xp / title 两个字段', REWARDS.every((r) => JSON.stringify(Object.keys(r.reward).sort()) === '["title","xp"]'));
eq('全拿满 = 8000 经验', rewardXp(FULL), 8000);
eq('全拿满 = 8 / 8', rewardSummary(FULL).owned, 8);
eq('全拿满的称号 = 最高 rank 的 百日不熄', rewardSummary(FULL).title, '百日不熄');
eq('全拿满 next = null', rewardSummary(FULL).next, null);
ok('每个 badge 字段都指向真实徽章或空串', REWARDS.every((r) => r.badge === '' || BADGES.some((b) => b.id === r.badge)), JSON.stringify(REWARDS.map((r) => r.badge)));

/* ---------- B 连续天数：刚好达标 / 差一天 ---------- */
console.log('--- B 连续天数边界 ---');
eq('streak 6：七日之火差 1 天', [item(daily({ total: 6, streak: 6 }), 'streak-7').done, item(daily({ total: 6, streak: 6 }), 'streak-7').left], [false, 1]);
eq('streak 6：now / need = 6 / 7', [item(daily({ total: 6, streak: 6 }), 'streak-7').now, item(daily({ total: 6, streak: 6 }), 'streak-7').need], [6, 7]);
eq('streak 7：七日之火到手', item(daily({ total: 7, streak: 7 }), 'streak-7').done, true);
eq('streak 7：双周不辍差 7 天', [item(daily({ total: 7, streak: 7 }), 'streak-14').done, item(daily({ total: 7, streak: 7 }), 'streak-14').left], [false, 7]);
eq('streak 13：双周不辍差 1 天', [item(daily({ total: 13, streak: 13 }), 'streak-14').done, item(daily({ total: 13, streak: 13 }), 'streak-14').left], [false, 1]);
eq('streak 14：双周不辍到手', item(daily({ total: 14, streak: 14 }), 'streak-14').done, true);
eq('streak 29：月度不熄差 1 天', [item(daily({ total: 29, streak: 29 }), 'streak-30').done, item(daily({ total: 29, streak: 29 }), 'streak-30').left], [false, 1]);
eq('streak 30：月度不熄到手', item(daily({ total: 30, streak: 30 }), 'streak-30').done, true);
eq('streak 99：百日不熄差 1 天', [item(daily({ total: 99, streak: 99 }), 'streak-100').done, item(daily({ total: 99, streak: 99 }), 'streak-100').left], [false, 1]);
eq('streak 100：四档连续全到手', [item(daily({ total: 100, streak: 100 }), 'streak-7').done, item(daily({ total: 100, streak: 100 }), 'streak-14').done, item(daily({ total: 100, streak: 100 }), 'streak-30').done, item(daily({ total: 100, streak: 100 }), 'streak-100').done], [true, true, true, true]);
eq('streak 150：now 夹到 need（不超 100%）', [item(daily({ total: 150, streak: 150 }), 'streak-14').now, item(daily({ total: 150, streak: 150 }), 'streak-100').now], [14, 100]);
ok('at 是「连续第 N 天」', item(daily({ streak: 7 }), 'streak-7').at === '连续第 7 天' && item(daily({ streak: 100 }), 'streak-100').at === '连续第 100 天', item(daily({ streak: 7 }), 'streak-7').at);
eq('连续档的 reward 是 100 / 250 / 800 / 3000', REWARDS.filter((r) => r.kind === 'streak').map((r) => r.reward.xp), [100, 250, 800, 3000]);

/* ---------- C 累计完成：刚好达标 / 差一天 ---------- */
console.log('--- C 累计完成边界 ---');
eq('total 29：三十次打卡差 1 次', [item(daily({ total: 29, streak: 29 }), 'total-30').done, item(daily({ total: 29, streak: 29 }), 'total-30').left], [false, 1]);
eq('total 30：三十次打卡到手', item(daily({ total: 30, streak: 30 }), 'total-30').done, true);
eq('total 99：百战之身差 1 次', [item(daily({ total: 99, streak: 99 }), 'total-100').done, item(daily({ total: 99, streak: 99 }), 'total-100').left], [false, 1]);
eq('total 100：百战之身到手', item(daily({ total: 100, streak: 100 }), 'total-100').done, true);
eq('total 364：全年无休差 1 次', [item(daily({ total: 364, streak: 364 }), 'total-365').done, item(daily({ total: 364, streak: 364 }), 'total-365').left], [false, 1]);
eq('total 365：全年无休到手', item(daily({ total: 365, streak: 365 }), 'total-365').done, true);
eq('老档案只有 daily 也认（statsOf 的形状）', item({ daily: 100, streak: 3 }, 'total-100').done, true);
eq('total 优先于 daily（dailyStats 的形状：total = 0 的游客不该借 daily 过关）', item({ total: 0, daily: 999 }, 'total-100').done, false);
eq('at 是「累计第 N 次」', item(daily({ total: 30 }), 'total-30').at, '累计第 30 次');

/* ---------- D 补做不续连续 ---------- */
console.log('--- D 补做与断签 ---');
// 补做 3 天：累计 10 次、其中 3 次是补做 —— 补做算完成数，但 streak 只认自然打卡（= 2）
const madeUp = daily({ total: 10, streak: 2, makeupUsed: 3, doneToday: true });
eq('补做算累计（total-30 进度 = 10）', item(madeUp, 'total-30').now, 10);
eq('补做不算连续（七日之火仍差 5 天）', [item(madeUp, 'streak-7').done, item(madeUp, 'streak-7').left], [false, 5]);
ok('补做玩家的连续档一个都没到手', ownedKeys(madeUp).every((k) => k.indexOf('streak-') !== 0), JSON.stringify(ownedKeys(madeUp)));
// 断签：连续 30 天攒到手之后又断了（快照口径，没有落库的领取记录）
const broken = daily({ total: 120, streak: 0 });
eq('断签：连续档全部回落未获得', ownedKeys(broken).filter((k) => k.indexOf('streak-') === 0), []);
eq('断签：累计档不受影响（total-30 还在）', item(broken, 'total-30').done, true);
ok('断签后奖励经验只剩累计档的（150 + 700 = 850）', rewardXp(broken) === 850, String(rewardXp(broken)));
ok('streak 30 时比 streak 0 时多 1150 经验（100+250+800）', rewardXp(daily({ total: 120, streak: 30 })) - rewardXp(broken) === 1150);

/* ---------- E 缺字段降级（老调用点 / 半截 stats） ---------- */
console.log('--- E 缺字段降级 ---');
eq('rewardsOf(undefined) 仍有 8 档', rewardsOf(undefined).length, 8);
eq('rewardsOf(null) 全未获得', rewardsOf(null).filter((r) => r.done).length, 0);
eq('rewardsOf({}) 不抛且全未获得', rewardsOf({}).filter((r) => r.done).length, 0);
eq('rewardsOf 非对象也不抛', rewardsOf('garbage').length, 8);
eq('老调用 { total: 3, streak: 1, done: [...] } 不抛', rewardsOf({ total: 3, streak: 1, done: ['2026-05-20'] }).length, 8);
eq('缺 perfect：全勤档 need = 0', item({ total: 3, streak: 1 }, 'perfect-month').need, 0);
eq('缺 perfect：全勤档未获得（0/0 不等于全勤）', [item({ total: 3, streak: 1 }, 'perfect-month').done, item({ total: 3, streak: 1 }, 'perfect-month').now], [false, 0]);
eq('缺 perfect：at 退回「本月全勤」', item({ total: 3, streak: 1 }, 'perfect-month').at, '本月全勤');
eq('perfect 是垃圾值也不抛（need = 0、未获得）', [item({ perfect: 'yes' }, 'perfect-month').need, item({ perfect: 'yes' }, 'perfect-month').done], [0, false]);
eq('perfect 里 total / done 是垃圾值也按 0', [item({ perfect: { total: 'x', done: null, month: '2026-05' } }, 'perfect-month').need, item({ perfect: { total: 'x', done: null, month: '2026-05' } }, 'perfect-month').done], [0, false]);
eq('只有 perfect 标记、没有 total：不凭空对象发奖', item({ perfect: { month: '2026-05', perfect: true } }, 'perfect-month').done, false);
eq('负数按 0（streak = -5）', [item({ streak: -5 }, 'streak-7').now, item({ streak: -5 }, 'streak-7').done], [0, false]);
eq('calendar 缺失不影响结果（本来就不看它）', JSON.stringify(rewardsOf(daily({ total: 50, streak: 8, calendar: { cells: [] } }))) === JSON.stringify(rewardsOf(daily({ total: 50, streak: 8 }))), true);
eq('多余的字段不影响结果（doneRows / makeup / slug）', JSON.stringify(rewardsOf(daily({ total: 50, streak: 8, doneRows: [{ day: 'x' }], makeup: {}, slug: 'zz' }))) === JSON.stringify(rewardsOf(daily({ total: 50, streak: 8 }))), true);

/* ---------- F 月度全勤 ---------- */
console.log('--- F 月度全勤 ---');
const mayFull = daily({ total: 20, streak: 20, perfect: perfectOf('2026-05', 20, 20) });
eq('全勤：到手', item(mayFull, 'perfect-month').done, true);
eq('全勤：now / need = 20 / 20（need 跟着「已过去的天数」走）', [item(mayFull, 'perfect-month').now, item(mayFull, 'perfect-month').need], [20, 20]);
eq('全勤：at = 2026-05 全勤', item(mayFull, 'perfect-month').at, '2026-05 全勤');
eq('全勤：奖励 500 经验 + 全勤达人称号', [item(mayFull, 'perfect-month').reward.xp, item(mayFull, 'perfect-month').reward.title], [500, '全勤达人']);
const mayHalf = daily({ total: 19, streak: 19, perfect: perfectOf('2026-05', 20, 19) });
eq('非全勤：差 1 天没到手', [item(mayHalf, 'perfect-month').done, item(mayHalf, 'perfect-month').left], [false, 1]);
eq('非全勤：now / need = 19 / 20', [item(mayHalf, 'perfect-month').now, item(mayHalf, 'perfect-month').need], [19, 20]);
const mayDay1 = daily({ total: 1, streak: 1, perfect: perfectOf('2026-05', 1, 1) });
eq('1 号当天做一次就是 1 / 1（全勤门槛不是整月天数）', [item(mayDay1, 'perfect-month').need, item(mayDay1, 'perfect-month').done], [1, true]);
const future = daily({ total: 0, streak: 0, perfect: perfectOf('2026-06', 0, 0) });
eq('未来月：need = 0、未获得、at 仍报月份', [item(future, 'perfect-month').need, item(future, 'perfect-month').done, item(future, 'perfect-month').at], [0, false, '2026-06 全勤']);
eq('只有月度全勤也拿称号', rewardSummary(mayFull).title, '全勤达人');
eq('非全勤：不给 500 全勤经验（只有连续 7 / 14 的 350）', rewardXp(mayHalf), 350);
eq('全勤比非全勤正好多 500 经验', rewardXp(mayFull) - rewardXp(mayHalf), 500);

/* ---------- G 跨月 ---------- */
console.log('--- G 跨月 ---');
const may31 = daily({ total: 31, streak: 31, perfect: perfectOf('2026-05', 20, 20) });
const june1 = daily({ total: 32, streak: 1, perfect: perfectOf('2026-06', 1, 1) });
eq('五月：连续 30 天 + 全勤都到手', [item(may31, 'streak-30').done, item(may31, 'perfect-month').done], [true, true]);
eq('六月 1 号：全勤档重置成 1 / 1 并到手', [item(june1, 'perfect-month').need, item(june1, 'perfect-month').now, item(june1, 'perfect-month').done], [1, 1, true]);
eq('六月 1 号：at 跟着翻月', item(june1, 'perfect-month').at, '2026-06 全勤');
eq('六月 1 号：上个月的完成数不计入本月（now = 1 而不是 21）', item(june1, 'perfect-month').now, 1);
eq('跨月断连续：连续 30 天档回落（快照口径）', item(june1, 'streak-30').done, false);
eq('跨月后称号换成还持有的全勤达人', rewardSummary(june1).title, '全勤达人');
eq('跨月后经验变化：+500（本月全勤）- 800（连续 30）- 350（连续 7 / 14）= 少 1150', rewardXp(may31) - rewardXp(june1), 1150);
eq('累计档不因跨月回落', [item(june1, 'total-30').done, item(june1, 'total-100').done], [true, false]);

/* ---------- H rewardSummary ---------- */
console.log('--- H 汇总 ---');
const empty = rewardSummary({});
eq('空 stats：total = 8 / owned = 0 / xp = 0 / title = ""', [empty.total, empty.owned, empty.xp, empty.title], [8, 0, 0, '']);
eq('空 stats：next 是最容易的那档（七日之火，还差 7 天）', [empty.next.key, empty.next.left, empty.next.percent], ['streak-7', 7, 0]);
ok('空 stats：next 不会挑 need = 0 的全勤档', empty.next.key !== 'perfect-month', empty.next.key);
const ten = rewardSummary(daily({ total: 10, streak: 2 }));
eq('total 10 / streak 2：next 是比例最高的 total-30（还差 20 次）', [ten.next.key, ten.next.left, ten.next.percent], ['total-30', 20, 33]);
eq('total 10 / streak 2：owned = 0', ten.owned, 0);
const mixed = rewardSummary(daily({ total: 31, streak: 30, perfect: perfectOf('2026-05', 20, 20) }));
eq('混合：owned = 5（连续 7/14/30 + 全勤 + 累计 30）', mixed.owned, 5);
eq('混合：xp = 100 + 250 + 800 + 500 + 150', mixed.xp, 1800);
eq('混合：称号取 rank 最高的（不灭之火 > 全勤达人）', mixed.title, '不灭之火');
eq('混合：next 是比例最高的 total-100（31 / 100）', [mixed.next.key, mixed.next.left], ['total-100', 69]);
eq('next 也带全套字段（icon / desc / reward / done）', [mixed.next.done, typeof mixed.next.icon, typeof mixed.next.desc, mixed.next.reward.xp], [false, 'string', 'string', 700]);
eq('next 的 percent 是四舍五入的整数', rewardSummary(daily({ total: 99, streak: 0 })).next.percent, 99);
eq('xp 随进度单调不降（几组 fixture 连起来看）', [0, 5, 10, 30, 100, 365].map((n) => rewardXp(daily({ total: n, streak: n, perfect: perfectOf('2026-05', 20, 20) }))).every((v, i, a) => i === 0 || v >= a[i - 1]), true);
eq('奖励经验 = 已获得档的经验之和（rewardXp 与 summary.xp 一致）', [0, 7, 14, 30, 60, 100, 365].map((n) => n + ':' + (rewardXp(daily({ total: n, streak: n })) === rewardSummary(daily({ total: n, streak: n })).xp)).join(','), '0:true,7:true,14:true,30:true,60:true,100:true,365:true');

/* ---------- I rewardLevelOf（奖励经验并进等级） ---------- */
console.log('--- I 等级叠加 ---');
// 个人主页那条线的真实形状（statsOf）：daily 是累计次数、perfectMonths 是当月全勤标记
const stat100 = { daily: 100, streak: 30, total: 100, perfect: perfectOf('2026-05', 20, 20), perfectMonths: 1 };
const lv = rewardLevelOf(stat100);
const baseLv = levelOf(stat100);
eq('xp = levelOf 的 XP + rewardXp', lv.xp, baseLv.xp + rewardXp(stat100));
eq('bonus 就是 rewardXp', lv.bonus, rewardXp(stat100));
eq('基础等级 7（2400 经验）→ 叠加后 10（4900 = 2400 + 2500）', [baseLv.level, lv.level, lv.xp, lv.bonus], [7, 10, 4900, 2500]);
eq('floor / next / need 与 xpFor 一致', [lv.floor, lv.next, lv.need], [xpFor(10), xpFor(11), xpFor(11) - 4900]);
eq('称号跟着等级走', lv.title, titleOf(10));
ok('叠加后的等级不低于基础等级', rewardLevelOf(daily({ total: 1, streak: 1 })).level >= levelOf(daily({ total: 1, streak: 1 })).level);
eq('rewardLevelOf({}) 不抛', rewardLevelOf({}).level, 1);
eq('rewardLevelOf(undefined) 不抛', rewardLevelOf(undefined).xp, 0);

/* ---------- J 前 16 枚徽章一个字符都没变 ---------- */
console.log('--- J 徽章回归 ---');
// 内联清单：逐字抄自改动前的 src/badges.js（第九批之前的 16 枚）
const INLINE = [
  { id: 'say-first', icon: '💬', name: '开口第一句', desc: '发表 1 条评论', stat: 'comments', need: 1 },
  { id: 'talker-10', icon: '🗣️', name: '话匣子', desc: '发表 10 条评论', stat: 'comments', need: 10 },
  { id: 'talker-50', icon: '📣', name: '金句频出', desc: '发表 50 条评论', stat: 'comments', need: 50 },
  { id: 'collector-5', icon: '📁', name: '小收藏家', desc: '收藏 5 款游戏', stat: 'favorites', need: 5 },
  { id: 'collector-20', icon: '⭐', name: '私藏库', desc: '收藏 20 款游戏', stat: 'favorites', need: 20 },
  { id: 'rater-5', icon: '🌟', name: '打分员', desc: '给 5 款游戏评分', stat: 'ratings', need: 5 },
  { id: 'thread-first', icon: '🧵', name: '第一次发帖', desc: '在论坛发 1 个主题', stat: 'threads', need: 1 },
  { id: 'thread-10', icon: '📌', name: '论坛常客', desc: '在论坛发 10 个主题', stat: 'threads', need: 10 },
  { id: 'reply-50', icon: '✍️', name: '盖楼大王', desc: '论坛回帖 50 条', stat: 'replies', need: 50 },
  { id: 'daily-first', icon: '📅', name: '今日打卡', desc: '完成 1 次每日挑战', stat: 'daily', need: 1 },
  { id: 'daily-30', icon: '🗓️', name: '月度全勤', desc: '累计完成 30 次每日挑战', stat: 'daily', need: 30 },
  { id: 'streak-7', icon: '🔥', name: '七日之火', desc: '连续 7 天完成每日挑战', stat: 'streak', need: 7 },
  { id: 'mail-ok', icon: '📧', name: '邮箱已验证', desc: '完成邮箱验证', stat: 'verified', need: 1 },
  { id: 'veteran-30', icon: '🕰️', name: '老玩家', desc: '注册满 30 天', stat: 'days', need: 30 },
  { id: 'author', icon: '🎁', name: '投稿者', desc: '提交 1 款游戏', stat: 'submitted', need: 1 },
  { id: 'published', icon: '🚀', name: '作者认证', desc: '提交的游戏被收录上架', stat: 'published', need: 1 }
];
const pick = (b) => ({ id: b.id, icon: b.icon, name: b.name, desc: b.desc, stat: b.stat, need: b.need });
eq('徽章总数 = 16 + 4', BADGES.length, 20);
ok('前 16 枚的顺序与内容逐字一致', JSON.stringify(BADGES.slice(0, 16).map(pick)) === JSON.stringify(INLINE), JSON.stringify(BADGES.slice(0, 16).map(pick)));
for (let i = 0; i < INLINE.length; i++) {
  eq('第 ' + (i + 1) + ' 枚（' + INLINE[i].id + '）未变', pick(BADGES[i] || {}), INLINE[i]);
}
const NEW4 = [
  { id: 'streak-14', icon: '⚡', name: '双周不辍', desc: '连续 14 天完成每日挑战', stat: 'streak', need: 14 },
  { id: 'streak-30', icon: '🌋', name: '月度不熄', desc: '连续 30 天完成每日挑战', stat: 'streak', need: 30 },
  { id: 'daily-100', icon: '📚', name: '百战之身', desc: '累计完成 100 次每日挑战', stat: 'daily', need: 100 },
  { id: 'perfect-month', icon: '🏅', name: '当月全勤', desc: '当月每一天都完成每日挑战', stat: 'perfectMonths', need: 1 }
];
eq('新徽章追加在末尾，共 4 枚', BADGES.slice(16).map(pick), NEW4);
eq('新增的 4 枚 id 都不与旧的重名', new Set(BADGES.map((b) => b.id)).size, 20);
eq('新增的 4 枚名字都不与旧的重名', new Set(BADGES.map((b) => b.name)).size, 20);
// 用内联清单核对 badgesOf 的输出（排序会打乱顺序，所以按 id 对回去，逐条比 name / need / desc）
const rows = new Map(badgesOf({}).map((b) => [b.id, b]));
for (const b of INLINE) {
  const got = rows.get(b.id) || {};
  ok('badgesOf 里 ' + b.id + ' 的名称 / 描述 / 门槛未变', got.name === b.name && got.need === b.need && got.desc === b.desc, JSON.stringify([got.name, got.need, got.desc]));
}
// 新徽章的判定
const b30 = new Map(badgesOf({ streak: 30, daily: 100, perfectMonths: 1 }).map((b) => [b.id, b]));
eq('连续 30 → 点亮 streak-30', [b30.get('streak-30').done, b30.get('streak-30').now], [true, 30]);
eq('连续 29 → 不点亮 streak-30', new Map(badgesOf({ streak: 29 }).map((b) => [b.id, b])).get('streak-30').done, false);
eq('累计 100 → 点亮 daily-100', b30.get('daily-100').done, true);
eq('当月全勤 → 点亮 perfect-month', b30.get('perfect-month').done, true);
eq('没接 perfectMonths（statsOf 现状）→ perfect-month 停在 0 / 1', [new Map(badgesOf({ streak: 99, daily: 365 }).map((b) => [b.id, b])).get('perfect-month').done, new Map(badgesOf({ streak: 99, daily: 365 }).map((b) => [b.id, b])).get('perfect-month').now], [false, 0]);
eq('旧徽章的判定不受新徽章影响（streak 7 只点亮 streak-7）', [new Map(badgesOf({ streak: 7 }).map((b) => [b.id, b])).get('streak-7').done, new Map(badgesOf({ streak: 7 }).map((b) => [b.id, b])).get('streak-14').done], [true, false]);
// XP 权重表：只追加了 perfectMonths
eq('XP 表新增 perfectMonths 权重 100', levelOf({ perfectMonths: 1 }).xp - levelOf({}).xp, 100);
eq('老统计项的 XP 口径没变（3 条评论 = 15）', levelOf({ comments: 3 }).xp, 15);
eq('缺 perfectMonths 时等级不受影响', levelOf({ comments: 3, streak: 7, daily: 10 }).xp, 15 + 70 + 200);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exitCode = 1;
