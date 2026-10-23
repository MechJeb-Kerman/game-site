#!/usr/bin/env node
// 渲染层冒烟：把 `src/views.js` 里每个导出的页面函数都真跑一遍。
//
// 目的不是校验像素，而是防止「重构把某个页面弄炸」——只要某个模板抛出异常，
// 或者把 `undefined` / `[object Object]` 印进 HTML，这里就会红。
//
//   node tools/render-test.mjs
//
// 不连数据库、不起服务、不写文件；用的是手搓的最小 fixture。

import * as ui from '../src/views.js';

let fail = 0;
let pass = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('  FAIL ' + msg);
  }
};

const origin = 'https://example.com';

const game = {
  id: 1,
  slug: 'demo',
  title: '演示游戏',
  subtitle: '一句话副标题',
  description: '这是描述，用来喂给模板。',
  category_id: 1,
  category: { id: 1, slug: 'puzzle', name: '益智', emoji: '🧩' },
  engine: 'html5',
  game_url: '/games/demo/index.html',
  width: 800,
  height: 600,
  orientation: 'landscape',
  tags: ['标签一', '标签二'],
  emoji: '🎮',
  accent: '#7c5cff',
  accent2: '#22d3ee',
  plays: 12,
  rating: 4.3,
  rating_count: 7,
  license: '原创',
  status: 1,
  created_at: '2026-10-01 10:00:00',
};

const user = { id: 1, name: 'admin', display_name: '管理员', role: 'admin', email: 'a@b.c' };
const list = [game, { ...game, id: 2, slug: 'demo2', title: '演示游戏二' }];

const thread = {
  id: 1,
  slug: 'hello',
  title: '第一个帖子',
  body: '正文内容',
  user_id: 1,
  author: 'admin',
  author_display: '管理员',
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-01 10:00:00',
  reply_count: 1,
  view_count: 3,
  forum_id: 1,
};

const post = { ...thread, summary: '摘要' };

const comment = {
  id: 1,
  user_id: 1,
  author: 'admin',
  author_display: '管理员',
  body: '评论内容',
  created_at: '2026-10-01 10:00:00',
  rating: 5,
  replies: [],
};

const CASE = [
  ['homePage', () => ui.homePage({ origin, featured: game, hot: list, newest: list, categories: [{ id: 1, slug: 'puzzle', name: '益智', emoji: '🧩', total: 2 }], tags: [{ tag: '标签一', n: 2 }], stats: { games: 2, plays: 12, users: 1, comments: 1 }, user, notice: post })],
  ['listPage', () => ui.listPage({ origin, path: '/games', heading: '全部游戏', sub: '共 2 款', list, total: 2, sort: 'hot', base: '/games', user })],
  ['gamePage', () => ui.gamePage({ origin, game, related: list, myStars: 4, user, favorited: true, favCount: 3, comments: [comment], commentTotal: 1 })],
  ['gamePage preview', () => ui.gamePage({ origin, game, related: [], preview: true, comments: [], commentTotal: 0 })],
  ['rankPage', () => ui.rankPage({ origin, user, kind: 'today', label: '今日榜', rows: [{ rank: 1, slug: 'demo', title: '演示游戏', emoji: '🎮', accent: '#7c5cff', accent2: '#22d3ee', category: '益智', rating: 4.3, rating_count: 7, plays: 12, value: 12, mv: 'up', move: 'up' }], boards: [{ id: 1, kind: 'today', title: '今日' }], metric: 'plays' })],
  ['rankPage rating', () => ui.rankPage({ origin, user, kind: 'rating', label: '评分榜', rows: [{ rank: 1, slug: 'demo', title: '演示游戏', plays: 1, value: 4.5 }], boards: [], metric: 'rating' })],
  ['hotPage', () => ui.hotPage({ origin, user, rows: [{ ...game, p1: 3, p3: 5, p7: 9, hot: 4.2, trend: 'up' }], updatedAt: '10:00:00', windowLabel: '窗口说明' })],
  ['noticeListPage', () => ui.noticeListPage({ origin, user, items: [post], total: 1, page: 1, pages: 1 })],
  ['noticePage', () => ui.noticePage({ origin, user, post, comments: [comment], commentTotal: 1 })],
  ['changelogPage', () => ui.changelogPage({ origin, user })],
  ['portalPage', () => ui.portalPage({ origin, user })],
  ['postFormPage', () => ui.postFormPage({ origin, user, post: null })],
  ['notFoundPage', () => ui.notFoundPage({ origin, user })],
  ['loginPage', () => ui.loginPage({ origin, user: null, next: '/', error: '', username: '', providers: ['github'] })],
  ['registerPage', () => ui.registerPage({ origin, user: null, next: '/', error: '', username: '', displayName: '', providers: [] })],
  ['privacyPage', () => ui.privacyPage({ origin, user })],
  ['termsPage', () => ui.termsPage({ origin, user })],
  ['favoritesPage', () => ui.favoritesPage({ origin, user, list, total: 2 })],
  ['accountPage', () => ui.accountPage({ origin, user, providers: [], links: [], notice: '', error: '', devLink: '', profile: null })],
  ['forgotPage', () => ui.forgotPage({ origin, user: null, error: '', done: false, devLink: '' })],
  ['resetPage', () => ui.resetPage({ origin, user: null, token: 'abc', error: '' })],
  ['messagePage', () => ui.messagePage({ origin, user, title: '提示', heading: '标题', sub: '副标题', body: '<p>正文</p>', path: '/' })],
  ['submitPage', () => ui.submitPage({ origin, user, categories: [{ id: 1, slug: 'puzzle', name: '益智' }], error: '', values: {}, done: '' })],
  ['adminPage', () => ui.adminPage({ origin, user, stats: { users: 1, games: 2, comments: 1, plays: 12, pending: 0, reports: 0, banned: 0, favorites: 0, offline: 0, posts: 0, published: 0 }, pending: [], managed: [], comments: [], reports: [], users: [], audit: [], categories: [{ id: 1, slug: 'puzzle', name: '益智' }], filter: {}, outbox: [], notice: '', integrations: null, posts: [] })],
  ['mailAdminPage', () => ui.mailAdminPage({ origin, user, stats: { sent: 1 }, suppressed: [], bounces: [], notice: '', webhook: null })],
  ['deleteGamePage', () => ui.deleteGamePage({ origin, user, game, counts: { plays: 12, comments: 1 } })],
  ['forumHomePage', () => ui.forumHomePage({ origin, user, forums: [{ id: 1, slug: 'general', name: '综合', desc: '', thread_count: 1, post_count: 2 }], threads: [{ ...thread, forum: { slug: 'general', name: '综合' } }], stats: { threads: 1, posts: 2, users: 1 }, q: '', page: 1, pages: 1, total: 1, base: '/forum', notice: '', tag: '' })],
  ['forumBoardPage', () => ui.forumBoardPage({ origin, user, forum: { id: 1, slug: 'general', name: '综合', desc: '' }, threads: [thread], q: '', page: 1, pages: 1, total: 1, base: '/forum', tag: '' })],
  ['forumThreadPage', () => ui.forumThreadPage({ origin, user, thread, forum: { id: 1, slug: 'general', name: '综合' }, posts: [{ ...thread, id: 2, body: '回复' }], page: 1, pages: 1, total: 1, base: '/forum', gate: null, error: '', notice: '', form: null, replyTo: null })],
  ['forumNewPage', () => ui.forumNewPage({ origin, user, forums: [{ id: 1, slug: 'general', name: '综合' }], forumSlug: 'general', error: '', values: {}, form: null, gate: null, base: '/forum' })],
  ['forumEditPage', () => ui.forumEditPage({ origin, user, post: thread, thread, error: '', form: null, base: '/forum' })],
  ['forumAdminPage', () => ui.forumAdminPage({ origin, user, stats: { threads: 1 }, pendingThreads: [thread], pendingPosts: [], reports: [], blacklist: [], muted: [], notice: '' })],
  ['attachAdminPage', () => ui.attachAdminPage({ origin, user, stats: { total: 1 }, pending: { rows: [] }, rejected: { rows: [] }, ok: '', err: '' })],
  ['dailyPage', () => ui.dailyPage({ origin, user, day: '2026-10-01', game, stats: { today: 1 }, ledger: { rows: [] }, board: null, notice: '' })],
  ['replayPage', () => ui.replayPage({ origin, user, replay: { id: 1, slug: 'r1', moves: [], result: 'win', created_at: '2026-10-01 10:00:00', game_id: 1, game_slug: 'demo', game_title: '演示游戏' }, game, more: list })],
  ['profilePage', () => ui.profilePage({ origin, user, profile: { id: 2, name: 'player', display_name: '玩家', created_at: '2026-10-01', favorites: 1, comments: 2, plays: 3 }, isSelf: false, counts: { plays: 3, favorites: 1 }, following: false, notice: '', ratings: [] })],
  ['notificationsPage', () => ui.notificationsPage({ origin, user, items: [], total: 0, unread: 0 })],
  ['feedPage', () => ui.feedPage({ origin, user, items: [], total: 0 })],
  ['messagesPage', () => ui.messagesPage({ origin, user, threads: [], total: 0 })],
  ['peoplePage', () => ui.peoplePage({ origin, user, list: [{ id: 2, name: 'player', display_name: '玩家' }], total: 1 })],
  ['ladderPage', () => ui.ladderPage({ origin, user, rows: [{ id: 2, name: 'player', display_name: '玩家', elo: 1200, wins: 3, losses: 1 }], total: 1 })],
  ['replaysPage', () => ui.replaysPage({ origin, user, items: [], total: 0 })],
];

console.log('渲染层冒烟（' + CASE.length + ' 个导出页面）');

for (const [name, fn] of CASE) {
  if (typeof ui[name] !== 'function' && !name.includes(' ')) {
    fail++;
    console.log('  FAIL ' + name + '：views.js 没有导出这个函数');
    continue;
  }
  let html;
  const t0 = Date.now();
  try {
    html = fn();
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + ' 抛异常：' + e.message);
    continue;
  }
  const ms = Date.now() - t0;
  if (typeof html !== 'string') {
    fail++;
    console.log('  FAIL ' + name + ' 返回的不是字符串');
    continue;
  }
  ok(html.length > 200, name + ' 输出过短（' + html.length + 'B）');
  ok(/<\/html>\s*$/.test(html), name + ' 没有正常的 </html> 结尾');
  ok(!/>undefined</.test(html), name + ' 把 undefined 渲染进 HTML');
  ok(!/\[object Object\]/.test(html), name + ' 把 [object Object] 渲染进 HTML');
  if (html.length > 200) console.log('  ok   ' + name.padEnd(22) + html.length + 'B ' + ms + 'ms');
}

console.log(fail ? '\nFAIL ' + fail + ' / PASS ' + pass : '\n全部通过（' + pass + ' 项断言，' + CASE.length + ' 个页面）');
process.exit(fail ? 1 : 0);
