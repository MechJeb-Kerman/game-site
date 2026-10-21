/**
 * 热度榜：把 play_logs 的近期播放量做时间衰减，再混上评分质量与历史播放，
 * 得出一个可排序、可复现的分数。不建新表——23 款游戏的量级直接现算，
 * 结果在进程内缓存 60 秒，避免每次请求都扫一遍日志表。
 *
 * 为什么不用 games.plays 直接排：
 *   1) 那是累计值，老游戏永远压新游戏；
 *   2) 它对「今天突然火了」没有感知，首页热门推荐会一直不变。
 */
import { db } from './db.js';
import { dayKey } from './daily.js';
import { listGames } from './data.js';

/** 缓存时长：热度是分钟级指标，60 秒足够新，也不至于把 SQLite 打满 */
export const HOT_CACHE_MS = 60 * 1000;

/** 上架越久衰减越慢（半衰期约 90 天），给新游戏一个曝光窗口，又不至于把老游戏一刀切掉 */
const DECAY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const cache = new Map();

/**
 * 热度分数。全部参数都有默认值，方便单测直接调。
 * @param {{p1?:number,p3?:number,p7?:number,plays?:number,rating?:number,ratingCount?:number,ageDays?:number}} s
 *   p1/p3/p7 = 今天 / 近 3 天 / 近 7 天的播放次数（含前面窗口，累计口径）
 */
export function hotScore(s = {}) {
  const p1 = Math.max(0, Number(s.p1) || 0);
  const p3 = Math.max(p1, Number(s.p3) || 0);
  const p7 = Math.max(p3, Number(s.p7) || 0);
  const plays = Math.max(0, Number(s.plays) || 0);
  const rating = Math.max(0, Math.min(5, Number(s.rating) || 0));
  const ratingCount = Math.max(0, Number(s.ratingCount) || 0);
  const ageDays = Math.max(0, Number(s.ageDays) || 0);

  // 动量：今天最重，往前两段按日均值递减
  const momentum = p1 * 3 + ((p3 - p1) / 2) * 1.5 + ((p7 - p3) / 4) * 1;
  // 质量：好评率 × 对数样本量，1 个 5 星不会顶到榜首
  const quality = rating > 0 ? (rating / 5) * Math.log1p(ratingCount) * 6 : 0;
  // 历史播放做对数缓冲，让长期有人玩的游戏不至于瞬间掉到底
  const history = Math.log1p(plays) * 1.2;
  // 慢衰减：上架越久，同样的动量打折越多
  const decay = Math.exp(-ageDays / DECAY_DAYS);

  return Math.round((momentum + quality + history) * decay * 1000) / 1000;
}

/**
 * 趋势：今日播放相对「前两天的日均」涨了还是跌了。
 * 没有历史基线时，今天有播放就是 up，没有就是 flat。
 */
export function trendOf(p1, p3) {
  const today = Math.max(0, Number(p1) || 0);
  const base = (Math.max(today, Number(p3) || 0) - today) / 2;
  if (base <= 0) return today > 0 ? 'up' : 'flat';
  const ratio = today / base;
  if (ratio >= 1.25) return 'up';
  if (ratio <= 0.75) return 'down';
  return 'flat';
}

/** 把 games.created_at（'YYYY-MM-DD HH:MM:SS'，本地时区）换成「上架多少天」 */
export function ageDaysOf(createdAt, now = Date.now()) {
  const t = Date.parse(String(createdAt || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / DAY_MS);
}

/** 清缓存：写入播放 / 评分后想立刻看到变化时调用 */
export function clearHotCache() {
  cache.clear();
}

function countsByWindow(now) {
  const d1 = dayKey(now);
  const d3 = dayKey(now - 2 * DAY_MS);
  const d7 = dayKey(now - 6 * DAY_MS);
  const rows = db
    .prepare(
      `SELECT g.id AS game_id,
              SUM(CASE WHEN l.day >= ? THEN 1 ELSE 0 END) AS p1,
              SUM(CASE WHEN l.day >= ? THEN 1 ELSE 0 END) AS p3,
              SUM(CASE WHEN l.day >= ? THEN 1 ELSE 0 END) AS p7
       FROM games g
       LEFT JOIN play_logs l ON l.game_id = g.id
       WHERE g.status = 1
       GROUP BY g.id`
    )
    .all(d1, d3, d7);
  const map = new Map();
  for (const r of rows) map.set(r.game_id, { p1: Number(r.p1) || 0, p3: Number(r.p3) || 0, p7: Number(r.p7) || 0 });
  return map;
}

/**
 * 热度榜（已排序，分数最高的在前）。
 * @param {{limit?:number, now?:number}} [opts]
 * @returns {Array<object>} 游戏行 + { p1, p3, p7, hot, trend }
 */
export function hotGames(opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 12));
  const now = Number(opts.now) || Date.now();

  const hit = cache.get(limit);
  if (hit && now - hit.at < HOT_CACHE_MS) return hit.rows;

  const counts = countsByWindow(now);
  const games = listGames({ sort: 'new', limit: 100 });
  const rows = games.map((g) => {
    const c = counts.get(g.id) || { p1: 0, p3: 0, p7: 0 };
    return {
      ...g,
      p1: c.p1,
      p3: c.p3,
      p7: c.p7,
      hot: hotScore({ ...c, plays: g.plays, rating: g.rating, ratingCount: g.rating_count, ageDays: ageDaysOf(g.created_at, now) }),
      trend: trendOf(c.p1, c.p3)
    };
  });

  rows.sort((a, b) => (b.hot - a.hot) || (b.plays - a.plays) || (a.id - b.id));
  cache.set(limit, { at: now, rows });
  return rows;
}
