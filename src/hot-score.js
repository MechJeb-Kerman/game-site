/**
 * 热度评分的纯函数部分。
 *
 * 单独拆出来是为了让 Node 端（src/hot.js，走 node:sqlite）和 Cloudflare Workers 端
 * （worker/app.js，走 D1）用同一套打分逻辑——两边只差「怎么查播放量」，
 * 一旦公式分叉，同一份数据在两条线上会排出不同榜单。
 *
 * 这里不 import 任何运行时模块，单测可以直接调。
 */

/** 上架越久衰减越慢（半衰期约 90 天），给新游戏曝光窗口，又不至于把老游戏一刀切 */
export const DECAY_DAYS = 90;

export const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * 把「每个游戏在三个窗口里的播放次数」与游戏行合成榜单，含排序。
 * 两端共用，避免 Node 与 Worker 的排序规则各写一遍。
 * @param {Array<object>} games 已上架的游戏行（含 plays / rating / rating_count / created_at）
 * @param {Map<number,{p1:number,p3:number,p7:number}>} counts
 * @param {number} now
 */
export function rankHotGames(games, counts, now = Date.now()) {
  const rows = (games || []).map((g) => {
    const c = counts.get(g.id) || { p1: 0, p3: 0, p7: 0 };
    return {
      ...g,
      p1: c.p1,
      p3: c.p3,
      p7: c.p7,
      hot: hotScore({
        ...c,
        plays: g.plays,
        rating: g.rating,
        ratingCount: g.rating_count,
        ageDays: ageDaysOf(g.created_at, now)
      }),
      trend: trendOf(c.p1, c.p3)
    };
  });
  rows.sort((a, b) => (b.hot - a.hot) || (b.plays - a.plays) || (a.id - b.id));
  return rows;
}
