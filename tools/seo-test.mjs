/**
 * src/seo.js 的单元测试：sitemap / robots / JSON-LD 的口径。
 *
 * 这些产物是给爬虫看的，出错不会有人反馈（页面照常打开），所以只能靠断言守住：
 * 少了 <lastmod>、URL 没转义、把登录态页面放进了 sitemap，都是那种「悄悄扣分」的错。
 *
 *   node tools/seo-test.mjs
 */
import {
  DISALLOW,
  STATIC_ENTRIES,
  gameJsonLd,
  robotsTxt,
  sitemapEntries,
  sitemapXml,
  websiteJsonLd,
  xmlEscape
} from '../src/seo.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
function is(name, actual, expected) {
  ok(name + '（' + JSON.stringify(actual) + '）', actual === expected, '期望 ' + JSON.stringify(expected));
}

/* ---------- 转义 ---------- */
is('xmlEscape 处理 &', xmlEscape('a&b'), 'a&amp;b');
is('xmlEscape 处理尖括号', xmlEscape('<x>'), '&lt;x&gt;');
is('xmlEscape 处理引号', xmlEscape('"q" \'s\''), '&quot;q&quot; &apos;s&apos;');
is('xmlEscape 空值', xmlEscape(null), '');

/* ---------- robots ---------- */
const robots = robotsTxt('https://example.com');
ok('robots 以 User-agent 开头', robots.startsWith('User-agent: *'), robots.slice(0, 40));
ok('robots 放行全站', robots.includes('\nAllow: /\n'));
for (const p of DISALLOW) ok('robots 屏蔽 ' + p, robots.includes('Disallow: ' + p + '\n'));
ok('robots 指向 sitemap', robots.includes('Sitemap: https://example.com/sitemap.xml'));
ok('robots 以换行结尾', robots.endsWith('\n'));
const robotsExtra = robotsTxt('https://example.com', { extra: ['/drafts/'] });
ok('robots 支持额外屏蔽', robotsExtra.includes('Disallow: /drafts/'));
is('robots 不重复 Disallow', new Set(DISALLOW).size, DISALLOW.length);

/* ---------- sitemap 条目 ---------- */
const games = [
  { slug: '2048', created_at: '2026-10-01 10:00:00' },
  { slug: 'snake', created_at: '2026-10-20 10:00:00' }
];
const posts = [{ slug: 'hello world', published_at: '2026-10-18 09:00:00', status: 1 }];
const categories = [
  { slug: 'puzzle', total: 5 },
  { slug: 'empty', total: 0 }
];
const entries = sitemapEntries({ posts, categories, games });
const locs = entries.map((e) => e.loc);

is('静态度数不变', entries.length, STATIC_ENTRIES.length + 4);
ok('含首页', locs.includes('/'));
ok('含热度榜', locs.includes('/hot'));
ok('含游戏页', locs.includes('/game/2048') && locs.includes('/game/snake'));
ok('公告 slug 被编码', locs.includes('/notice/hello%20world'), locs.join(','));
ok('空分类不进 sitemap', !locs.includes('/category/empty'));
ok('有内容的分类进 sitemap', locs.includes('/category/puzzle'));

/* lastmod：静态页取「最近一次内容变动」，不是今天 */
const siteLm = entries.find((e) => e.loc === '/').lm;
is('静态页 lastmod = 最新内容日', siteLm, '2026-10-20');
is('游戏 lastmod = 上架日', entries.find((e) => e.loc === '/game/snake').lm, '2026-10-20');
is('公告 lastmod = 发布日', entries.find((e) => e.loc === '/notice/hello%20world').lm, '2026-10-18');
const noData = sitemapEntries({});
ok('没有数据时不编造 lastmod', noData.every((e) => !e.lm));

/* ---------- sitemap XML ---------- */
const xml = sitemapXml('https://example.com', entries);
ok('xml 带版本声明', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><urlset'), xml.slice(0, 60));
ok('xml 闭合', xml.endsWith('</urlset>'));
ok('xml 含 lastmod', xml.includes('<lastmod>2026-10-20</lastmod>'));
ok('xml 不含双斜线', !xml.includes('com//'));
ok('xml 转义 &', sitemapXml('https://example.com', [{ loc: '/a&b' }]).includes('/a&amp;b'));
is('按 loc 去重', (sitemapXml('https://example.com', [{ loc: '/x' }, { loc: '/x' }]).match(/<url>/g) || []).length, 1);
is('丢弃非站内路径', (sitemapXml('https://example.com', [{ loc: 'https://evil.example/x' }]).match(/<url>/g) || []).length, 0);
is('丢弃空 loc', (sitemapXml('https://example.com', [{ loc: '' }]).match(/<url>/g) || []).length, 0);
ok('priority 保留', xml.includes('<priority>1.0</priority>'));

/* ---------- JSON-LD ---------- */
const site = websiteJsonLd({ origin: 'https://example.com', name: '趣玩小游戏', description: '免费在线小游戏' });
is('WebSite 类型', site['@type'], 'WebSite');
is('WebSite url', site.url, 'https://example.com/');
is('WebSite 带站内搜索', site.potentialAction.target, 'https://example.com/search?q={search_term_string}');

const game = { slug: '2048', title: '2048', description: '合并数字', rating: 4.3, rating_count: 12, category: { name: '益智' } };
const gld = gameJsonLd(game, 'https://example.com');
is('VideoGame 类型', gld['@type'], 'VideoGame');
is('VideoGame url', gld.url, 'https://example.com/game/2048');
is('VideoGame 封面', gld.image, 'https://example.com/cover/2048.svg');
is('评分保留一位小数', gld.aggregateRating.ratingValue, '4.3');
is('评分人数', gld.aggregateRating.ratingCount, 12);
ok('免费游戏带 offers', gld.offers && gld.offers.price === '0');

const noVotes = gameJsonLd({ slug: 'x', title: 'X', rating: 5, rating_count: 0, category: null }, 'https://example.com');
ok('没人评分时不带 aggregateRating', !noVotes.aggregateRating);
is('无分类回落休闲', noVotes.genre, '休闲');

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
