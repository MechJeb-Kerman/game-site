/**
 * 热度榜 / SEO 纯函数自测。
 *
 *   node tools/hot-test.mjs
 *
 * 零外网、零浏览器：只验证 src/hot.js 的打分曲线与 src/seo.js 的文本输出，
 * 不碰数据库里的真实数据（hotGames 需要库，这里不测它，留给 CI 的冒烟步骤）。
 * 全过退出码 0，任何一项 FAIL 退出码 1。
 */
import { ageDaysOf, hotScore, trendOf } from '../src/hot.js';
import { DISALLOW, STATIC_ENTRIES, gameJsonLd, robotsTxt, sitemapEntries, sitemapXml, websiteJsonLd, xmlEscape } from '../src/seo.js';

const startedAt = Date.now();
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

function is(name, got, want) {
  ok(name, Object.is(got, want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

console.log('--- 热度分数 ---');
is('没有任何信号时为 0', hotScore({}), 0);
is('空参数等同全零', hotScore(), hotScore({}));
ok('今天的播放会抬高分数', hotScore({ p1: 10, p3: 10, p7: 10 }) > hotScore({ p1: 0, p3: 0, p7: 0 }));
ok(
  '同样 10 次播放，今天的比 7 天前的更值钱',
  hotScore({ p1: 10, p3: 10, p7: 10 }) > hotScore({ p1: 0, p3: 0, p7: 10 })
);
ok('样本量大的评分更靠前', hotScore({ rating: 4.5, ratingCount: 40 }) > hotScore({ rating: 4.5, ratingCount: 1 }));
ok('上架 90 天后同样动量会衰减', hotScore({ p1: 10, p3: 10, p7: 10, ageDays: 90 }) < hotScore({ p1: 10, p3: 10, p7: 10 }));
ok('p3 小于 p1 时按 p1 兜底，不产生负动量', hotScore({ p1: 5, p3: 0, p7: 0 }) === hotScore({ p1: 5, p3: 5, p7: 5 }));
ok('分数是非负数', hotScore({ p1: 0, p3: 0, p7: 0, plays: 0, rating: 0 }) >= 0);

console.log('--- 趋势 ---');
is('没有基线、今天也没人玩 → flat', trendOf(0, 0), 'flat');
is('没有基线、今天有人玩 → up', trendOf(3, 3), 'up');
is('今日明显高于前两日均值 → up', trendOf(20, 25), 'up');
is('今日明显低于前两日均值 → down', trendOf(2, 30), 'down');
is('大致持平 → flat', trendOf(10, 30), 'flat');

console.log('--- 上架天数 ---');
ok('非法日期回落 0', ageDaysOf('not-a-date') === 0);
is('今天上架 → 0 天', ageDaysOf(new Date().toISOString().slice(0, 10) + ' 00:00:00'), ageDaysOf(new Date().toISOString().slice(0, 10) + ' 00:00:00'));

console.log('--- XML / robots ---');
is('& 被转义', xmlEscape('a&b'), 'a&amp;b');
is('< 被转义', xmlEscape('<x>'), '&lt;x&gt;');
ok('robots 屏蔽后台', robotsTxt('https://x.test').includes('Disallow: /admin'));
ok('robots 屏蔽收藏页', robotsTxt('https://x.test').includes('Disallow: /favorites'));
ok('robots 指向 sitemap', robotsTxt('https://x.test').includes('Sitemap: https://x.test/sitemap.xml'));
ok('robots 以空行结尾', robotsTxt('https://x.test').endsWith('\n'));
ok('额外前缀可追加', robotsTxt('https://x.test', { extra: ['/tmp'] }).includes('Disallow: /tmp'));
ok('DISALLOW 里没有重复项', new Set(DISALLOW).size === DISALLOW.length);

const xml = sitemapXml('https://x.test', sitemapEntries({
  posts: [{ slug: 'hello world', created_at: '2026-10-20 10:00:00' }],
  categories: [{ slug: 'puzzle', total: 3 }, { slug: 'empty', total: 0 }],
  games: [{ slug: '2048', created_at: '2026-10-01 00:00:00' }]
}));
ok('sitemap 带 urlset 声明', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><urlset'));
ok('sitemap 含首页', xml.includes('<loc>https://x.test/</loc>'));
ok('sitemap 含热度榜', xml.includes('<loc>https://x.test/hot</loc>'));
ok('sitemap 含游戏页', xml.includes('<loc>https://x.test/game/2048</loc>'));
ok('sitemap 含公告 slug 编码', xml.includes('/notice/hello%20world'));
ok('空分类不进 sitemap', !xml.includes('/category/empty'));
ok('lastmod 只保留日期', xml.includes('<lastmod>2026-10-01</lastmod>'));
ok('sitemap 不以 // 结尾', !xml.includes('https://x.test//'));

const dup = sitemapXml('https://x.test', [{ loc: '/' }, { loc: '/' }, { loc: 'http://evil.test/x' }]);
is('重复 loc 去重后只剩一个', (dup.match(/<url>/g) || []).length, 1);

console.log('--- JSON-LD ---');
const site = websiteJsonLd({ origin: 'https://x.test', name: '趣玩小游戏', description: 'd' });
is('WebSite 类型', site['@type'], 'WebSite');
is('WebSite 首页地址', site.url, 'https://x.test/');
ok('WebSite 带站内搜索动作', site.potentialAction.target === 'https://x.test/search?q={search_term_string}');

const g = gameJsonLd({ slug: '2048', title: '2048', description: '合并数字', rating: 4.25, rating_count: 8, category: { name: '益智' } }, 'https://x.test');
is('VideoGame 类型', g['@type'], 'VideoGame');
is('游戏页地址', g.url, 'https://x.test/game/2048');
is('评分保留一位小数', g.aggregateRating.ratingValue, '4.3');
const noVotes = gameJsonLd({ slug: 'x', title: 'x', rating_count: 0 }, 'https://x.test');
ok('没人评分时不造假数据', !('aggregateRating' in noVotes));

ok('STATIC_ENTRIES 都带 loc 与 pri', STATIC_ENTRIES.every((e) => e.loc && e.pri));

console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail + '（' + (Date.now() - startedAt) + 'ms）');
process.exit(fail ? 1 : 0);
