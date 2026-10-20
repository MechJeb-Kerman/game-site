/**
 * 联机棋类的 Elo 评分 / 天梯 / 赛季（纯函数，零 I/O、零依赖）。
 *
 * 两条线共用：Express 的 src/play-store.js 与 Workers 的 worker/play-store.js 都 import 这里，
 * 分数只在本模块算，SQL 与事务各自写（与 src/play.js、src/rules/ 的分工一致）。
 *
 * 口径与理由：
 *   - 起始分 1200、评分下限 100；K 值按「已结算局数」分档：<10 → 40、<30 → 24、否则 16。
 *     K 是「每人一份」：双方档位不同时一局的分数变化不是零和（两人 delta 之和不为 0），
 *     这与 FIDE 的分档 K 一致，比强行取平均更贴近「新人快速定级、老人少波动」的目的；
 *   - 结果串沿用 src/play.js 的 RESULTS：'host'（房主 / seat 0 胜）、'guest'（挑战者胜）、'draw'；
 *   - delta 是「实际生效」的变化量：被下限 100 钳住时 delta 也随之变小，恒有 原分 + delta = 新分；
 *   - 取整对负数按绝对值四舍五入（对称），免得 +8.5 / -8.5 被 Math.round 掰成 +9 / -8。
 *
 * 赛季口径选自然季度（UTC）：'YYYY-Q1' .. 'YYYY-Q4'。
 *   为什么是季度：一季约三个月，正好对齐自然季度，不需要另配「赛季起点 / 锚点」就能从任意时间戳
 *   推出来（可复现、可回查），月度太短、年度太长；换口径只影响 season 字符串，历史数据不用动。
 *   为什么用 UTC：同一个时间戳在 Node 与 Cloudflare Workers（都跑在 UTC）上必须得到同一个赛季，
 *   否则同一局在两条线上会落进不同赛季；代价是北京时间 1/4/7/10 月 1 日 08:00 前仍算上一季度
 *   （跨年那 8 小时最明显）——可复现优先于本地历法。
 *
 * 身份：对局房间是匿名的（play_rooms 只有昵称与座位 token，没有账号绑定），所以天梯的身份键由昵称
 * 派生（playerKey：NFKC 归一 + 折叠空白 + 转小写，前缀 'n:'）。同一昵称跨房间会累积到同一份记录上——
 * 这是当前数据模型下唯一可用的跨房间身份。接入账号后把 String(user.id) 当键传进来即可（数字串不带
 * 前缀，与 'n:…' 天然不冲突），结算与查询的代码都不用改。
 */
import { RESULTS } from './play.js';

/** 起始分：没有记录的人（以及每个新赛季）都从这里开始 */
export const START_RATING = 1200;
/** 评分下限：一直输也不会低于它 */
export const MIN_RATING = 100;

/** K 值分档（局数越多越稳） */
export const K_FACTORS = { NEW: 40, MID: 24, PRO: 16 };

/** 局数分档表：games < under → k（顺序即优先级，最后一档兜底） */
export const K_TIERS = [
  { under: 10, k: K_FACTORS.NEW, name: '新手' },
  { under: 30, k: K_FACTORS.MID, name: '进阶' },
  { under: Infinity, k: K_FACTORS.PRO, name: '稳定' }
];

/** 赛季口径（seasonOf 的 unit 参数） */
export const SEASON_UNITS = ['quarter', 'month', 'year'];

/** 匿名身份键前缀（'n:' + 归一化昵称） */
export const NAME_PREFIX = 'n:';

/** 数字兜底：NaN / undefined / 非数字串一律换成 fallback */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 对称取整：负数按绝对值四舍五入（Math.round(-0.5) 是 -0，会让两边不对称） */
function roundInt(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * 这个人这一局用哪个 K 值（局数分档）。
 * @param {number} games 已结算局数（负数 / 非数字按 0 算）
 * @returns {number} 40 | 24 | 16
 */
export function kFor(games) {
  const n = Math.max(0, Math.floor(num(games, 0)));
  for (let i = 0; i < K_TIERS.length; i++) {
    if (n < K_TIERS[i].under) return K_TIERS[i].k;
  }
  return K_FACTORS.PRO;
}

/**
 * 标准 Elo 期望得分：E = 1 / (1 + 10^((rb - ra) / 400))。
 * 同分 = 0.5；400 分差 ≈ 0.909。非法输入按起始分算（不产生 NaN）。
 */
export function expectedScore(ra, rb) {
  const a = num(ra, START_RATING);
  const b = num(rb, START_RATING);
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

/**
 * 结算一局：算出双方新分与各自的变化量。
 * @param {number} ra 甲方（host）原分
 * @param {number} rb 乙方（guest）原分
 * @param {number} scoreA 甲方得分：1 胜 / 0.5 平 / 0 负（其余数值钳到 [0,1]，非法值按平局）
 * @param {{gamesA?: number, gamesB?: number}} [options] 双方已结算局数（决定各自的 K 档）
 * @returns {{ra: number, rb: number, deltaA: number, deltaB: number}} 新分与变化量（整数）
 */
export function applyResult(ra, rb, scoreA, options) {
  const o = options || {};
  const a0 = roundInt(num(ra, START_RATING));
  const b0 = roundInt(num(rb, START_RATING));
  const s = Math.min(1, Math.max(0, num(scoreA, 0.5)));
  const ka = kFor(o.gamesA);
  const kb = kFor(o.gamesB);
  const ea = expectedScore(a0, b0);
  const ra1 = Math.max(MIN_RATING, roundInt(a0 + ka * (s - ea)));
  const rb1 = Math.max(MIN_RATING, roundInt(b0 + kb * ((1 - s) - (1 - ea))));
  return { ra: ra1, rb: rb1, deltaA: ra1 - a0, deltaB: rb1 - b0 };
}

/**
 * 时间戳 → 赛季串（可复现：同一时间戳在任何机器 / 任何时区都得到同一个串）。
 * @param {number} ts 毫秒时间戳（Date.now()；非法值按 0 算）
 * @param {{unit?: 'quarter'|'month'|'year'}} [options] 默认季度
 * @returns {string} 'YYYY-Q1' | 'YYYY-MM' | 'YYYY'
 */
export function seasonOf(ts, options) {
  const unit = (options && options.unit) || 'quarter';
  const d = new Date(num(ts, 0));
  const year = d.getUTCFullYear();
  if (unit === 'year') return String(year);
  const month = d.getUTCMonth() + 1;
  if (unit === 'month') return year + '-' + (month < 10 ? '0' + month : String(month));
  return year + '-Q' + (Math.floor((month - 1) / 3) + 1);
}

/**
 * 昵称 → 身份键：NFKC 归一（全角/半角同一人）+ 折叠空白 + 转小写，前缀 'n:'。
 * 空昵称返回 ''（调用方据此跳过结算：没有身份就没有天梯记录）。
 */
export function playerKey(name) {
  const s = String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? NAME_PREFIX + s : '';
}

/** 身份键 → 展示名（'n:张三' → '张三'；账号 id 原样返回） */
export function keyName(key) {
  const s = String(key == null ? '' : key);
  return s.slice(0, NAME_PREFIX.length) === NAME_PREFIX ? s.slice(NAME_PREFIX.length) : s;
}

/**
 * 一行评分记录的默认值（字段与 player_ratings 对齐）——没有记录时用它当底。
 */
export function blankRating(userId, game, season) {
  return {
    userId: String(userId == null ? '' : userId),
    game: String(game == null ? '' : game),
    season: String(season == null ? '' : season),
    username: '',
    rating: START_RATING,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    peak: START_RATING,
    updatedAt: 0
  };
}

/**
 * 把一行残缺数据补成完整的一行：DB 行（snake_case）与页面传来的对象（camelCase）都认。
 * 数字字段一律取整、负数归 0；peak 永远不低于当前分（也永远不低于起始分）。
 * @param {object|null} row
 * @param {object} [fallback] 缺字段时的底（一般用 blankRating(...)），省略则用起始值 + 行里的身份字段
 */
export function normRating(row, fallback) {
  const b = fallback || blankRating(row ? row.user_id : '', row ? row.game : '', row ? row.season : '');
  if (!row) return b;
  const v = (camel, snake) => {
    if (row[camel] != null) return row[camel];
    if (snake && row[snake] != null) return row[snake];
    return undefined;
  };
  const rating = roundInt(num(v('rating'), b.rating));
  const id = v('userId', 'user_id');
  const game = v('game');
  const season = v('season');
  const username = v('username');
  return {
    userId: String(id == null ? b.userId : id),
    game: String(game == null ? b.game : game),
    season: String(season == null ? b.season : season),
    username: String(username == null ? b.username : username),
    rating: rating,
    games: Math.max(0, roundInt(num(v('games'), b.games))),
    wins: Math.max(0, roundInt(num(v('wins'), b.wins))),
    losses: Math.max(0, roundInt(num(v('losses'), b.losses))),
    draws: Math.max(0, roundInt(num(v('draws'), b.draws))),
    peak: Math.max(rating, roundInt(num(v('peak'), b.peak))),
    updatedAt: Math.max(0, roundInt(num(v('updatedAt', 'updated_at'), b.updatedAt)))
  };
}

/**
 * 一局结算后的两份新记录（纯函数；读旧行、写新行的 SQL 由两条线的 play-store 各自写）。
 * @param {object} hostRow 房主当前的评分行（可用 blankRating 补底）
 * @param {object} guestRow 挑战者当前的评分行
 * @param {string} result 'host' | 'guest' | 'draw'（照抄房间的 result，不采信客户端声明）
 * @returns {{host: object, guest: object, hostDelta: number, guestDelta: number, scoreHost: number}|null}
 *   result 不在 RESULTS 里返回 null（不结算）；局数 +1、胜/负/平各自 +1、peak 只升不降。
 */
export function nextRatings(hostRow, guestRow, result) {
  if (RESULTS.indexOf(result) < 0) return null;
  const host = normRating(hostRow);
  const guest = normRating(guestRow);
  const scoreHost = result === 'draw' ? 0.5 : result === 'host' ? 1 : 0;
  const d = applyResult(host.rating, guest.rating, scoreHost, { gamesA: host.games, gamesB: guest.games });
  return {
    host: tally(host, scoreHost, d.ra),
    guest: tally(guest, 1 - scoreHost, d.rb),
    hostDelta: d.deltaA,
    guestDelta: d.deltaB,
    scoreHost: scoreHost
  };
}

/** 记一局的账：局数 +1、按得分记胜负平、新分与 peak */
function tally(row, score, rating) {
  const next = {
    userId: row.userId, game: row.game, season: row.season, username: row.username,
    rating: rating,
    games: row.games + 1,
    wins: row.wins + (score === 1 ? 1 : 0),
    losses: row.losses + (score === 0 ? 1 : 0),
    draws: row.draws + (score === 0.5 ? 1 : 0),
    peak: row.peak,
    updatedAt: row.updatedAt
  };
  next.peak = Math.max(row.peak, rating);
  return next;
}

/**
 * 排行榜一行：{rank, userId, username, rating, games, wins, losses, draws, peak}。
 * username 优先用行里的（将来联表 users 时会有），没有就从身份键还原（keyName）。
 */
export function ratingRow(row, rank) {
  const r = normRating(row);
  return {
    rank: roundInt(num(rank, 0)),
    userId: r.userId,
    username: r.username || keyName(r.userId),
    rating: r.rating,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
    peak: r.peak
  };
}

/** 排行榜多行：按传入顺序编号 1..n（排序由 SQL 负责；不做同分并列，名次稳定不跳号） */
export function ratingRows(rows) {
  return (rows || []).map((row, i) => ratingRow(row, i + 1));
}
