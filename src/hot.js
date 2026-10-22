/**
 * 热度榜：把 play_logs 的近期播放量做时间衰减，再混上评分质量与历史播放，
 * 得出一个可排序、可复现的分数。不建新表——23 款游戏的量级直接现算，
 * 结果在进程内缓存 60 秒，避免每次请求都扫一遍日志表。
 *
 * 为什么不用 games.plays 直接排：
 *   1) 那是累计值，老游戏永远压新游戏；
 *   2) 它对「今天突然火了」没有感知，首页热门推荐会一直不变。
 *
 * 打分公式本身在 ./hot-score.js（与 Cloudflare Workers 版共用），这里只负责查数、缓存。
 */
import { db } from './db.js';
import { dayKey } from './daily.js';
import { listGames } from './data.js';
import { DAY_MS, ageDaysOf, hotScore, rankHotGames, trendOf } from './hot-score.js';

// 纯函数原样再导出：tools/hot-test.mjs 一直是从这里拿，不破坏既有调用点
export { DAY_MS, ageDaysOf, hotScore, rankHotGames, trendOf };

/** 缓存时长：热度是分钟级指标，60 秒足够新，也不至于把 SQLite 打满 */
export const HOT_CACHE_MS = 60 * 1000;

const cache = new Map();

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
  const rows = rankHotGames(games, counts, now);

  cache.set(limit, { at: now, rows });
  return rows;
}
