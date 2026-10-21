/**
 * 站点 SEO 的唯一出处：robots.txt、sitemap.xml 与 JSON-LD。
 *
 * 之前这几块分散在 server.js（路由内联）和 views.js（页面内联），改一处要改两处；
 * 这里收成一个纯函数模块，服务端直接调用，静态导出 / worker 侧也能复用同一份规则。
 * 纯函数、不碰数据库，方便 tools/hot-test.mjs 这类单元测试直接断言。
 */

/** 不希望被搜索引擎收录的路径前缀：后台、登录态页面、个人数据、接口 */
export const DISALLOW = [
  '/api/',
  '/admin',
  '/forum/admin',
  '/login',
  '/register',
  '/favorites',
  '/submit',
  '/account',
  '/forgot',
  '/reset',
  '/auth',
  '/comments/'
];

/** 站点固定页面（不依赖数据库），顺序即 sitemap 里的顺序 */
export const STATIC_ENTRIES = [
  { loc: '/', pri: '1.0' },
  { loc: '/hot', pri: '0.8' },
  { loc: '/rank', pri: '0.7' },
  { loc: '/ladder', pri: '0.6' },
  { loc: '/forum', pri: '0.6' },
  { loc: '/daily', pri: '0.6' },
  { loc: '/notice', pri: '0.6' },
  { loc: '/replays', pri: '0.5' },
  { loc: '/nav', pri: '0.5' },
  { loc: '/changelog', pri: '0.4' },
  { loc: '/privacy', pri: '0.3' },
  { loc: '/terms', pri: '0.3' }
];

/** XML 文本转义：loc 里的 & 不转义会让 sitemap 直接解析失败 */
export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * robots.txt。默认放行全站、屏蔽 DISALLOW，末尾给出 sitemap 地址。
 * @param {string} origin 站点根（协议 + 主机），不带结尾斜杠
 * @param {{extra?: string[]}} [opts] 额外要屏蔽的路径前缀
 */
export function robotsTxt(origin, opts = {}) {
  const extra = Array.isArray(opts.extra) ? opts.extra : [];
  const lines = ['User-agent: *', 'Allow: /'];
  for (const p of [...DISALLOW, ...extra]) lines.push('Disallow: ' + p);
  lines.push('', 'Sitemap: ' + origin + '/sitemap.xml', '');
  return lines.join('\n');
}

/** 把数据行映射成 sitemap 条目（每行形状：{slug, created_at} 之类） */
export function sitemapEntries({ posts = [], categories = [], games = [] } = {}) {
  const entries = STATIC_ENTRIES.slice();
  for (const p of posts) {
    entries.push({
      loc: '/notice/' + encodeURIComponent(p.slug),
      pri: '0.6',
      lm: String(p.published_at || p.created_at || '').slice(0, 10)
    });
  }
  for (const c of categories) {
    if (Number(c.total) > 0) entries.push({ loc: '/category/' + encodeURIComponent(c.slug), pri: '0.8' });
  }
  for (const g of games) {
    entries.push({ loc: '/game/' + encodeURIComponent(g.slug), pri: '0.9', lm: String(g.created_at || '').slice(0, 10) });
  }
  return entries;
}

/**
 * 输出 urlset。条目按 loc 去重（同一 URL 只出现一次），保留首次出现的顺序。
 * @param {string} origin
 * @param {{loc: string, pri?: string, lm?: string, freq?: string}[]} entries
 */
export function sitemapXml(origin, entries = []) {
  const seen = new Set();
  const rows = [];
  for (const e of entries) {
    if (!e || !e.loc) continue;
    const loc = String(e.loc);
    if (!loc.startsWith('/')) continue;
    if (seen.has(loc)) continue;
    seen.add(loc);
    rows.push(e);
  }
  const body = rows
    .map((e) => {
      const parts = ['<loc>' + xmlEscape(origin + e.loc) + '</loc>'];
      if (e.lm) parts.push('<lastmod>' + xmlEscape(e.lm) + '</lastmod>');
      if (e.freq) parts.push('<changefreq>' + xmlEscape(e.freq) + '</changefreq>');
      if (e.pri) parts.push('<priority>' + xmlEscape(e.pri) + '</priority>');
      return '<url>' + parts.join('') + '</url>';
    })
    .join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + body + '</urlset>';
}

/** 全站 WebSite 结构化数据（首页用，带站内搜索） */
export function websiteJsonLd({ origin = '', name = '', description = '' } = {}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url: origin + '/',
    description,
    potentialAction: {
      '@type': 'SearchAction',
      target: origin + '/search?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  };
}

/**
 * 单款游戏的 VideoGame 结构化数据。
 * schema.org 要求 ratingCount >= 1，没人评分时宁可不带 aggregateRating，也不造数。
 */
export function gameJsonLd(game, origin = '') {
  const path = '/game/' + game.slug;
  const votes = Number(game.rating_count) || 0;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: game.title,
    description: game.description,
    url: origin + path,
    image: origin + '/cover/' + game.slug + '.svg',
    genre: game.category ? game.category.name : '休闲',
    gamePlatform: 'Web Browser',
    applicationCategory: 'Game',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY', availability: 'https://schema.org/InStock' }
  };
  if (votes > 0) {
    ld.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(game.rating).toFixed(1),
      ratingCount: votes,
      bestRating: '5',
      worstRating: '1'
    };
  }
  return ld;
}
