#!/usr/bin/env node
/**
 * 分享卡片 SVG 自测：node tools/cards-test.mjs
 *
 * 六组断言（全部是纯字符串断言：不启服务、不连数据库、不开浏览器）：
 *   ① 每张卡都能被极简 XML 解析器走通：标签闭合、无裸 & 与裸 <
 *   ② 用户名/徽章名/origin/accent 传入注入串时不产生可执行标签
 *   ③ 输出里没有外部资源引用（http(s)://、href/src、url(#以外)、<image>…）
 *   ④ 同一输入两次调用字符串完全一致（纯函数、无时钟无随机）
 *   ⑤ 尺寸与 viewBox 一致、观点合理、字符长度 < 200KB（含 2000 手棋谱）
 *   ⑥ 容错：空 moves / 未知游戏 / 脏字段都不抛错，认不出的走法直接跳过
 *
 * 退出码 0 = 全过。
 */
import { replayCardSvg, profileCardSvg, dailyCardSvg, esc, fmtTime } from '../src/cards.js';
import { badgesOf, levelOf, titleOf } from '../src/badges.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + String(extra).slice(0, 180)));
  }
}

/* ---------- 极简 XML 解析断言 ---------- */

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'/]|\/(?!>))*)(\/?)>/g;
const BARE_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/g;
const VALID_ENT = /&(?:amp|lt|gt|quot|apos|#\d{1,6}|#x[0-9a-fA-F]{1,6});/g;

/** 文本段检查：裸 < / 裸 & */
function checkChars(txt, errs, where) {
  if (txt.includes('<')) errs.push(where + ' 有裸 <：' + JSON.stringify(txt.slice(0, 40)));
  const amps = txt.match(BARE_AMP);
  if (amps) errs.push(where + ' 有裸 &：' + amps.slice(0, 3).join(','));
}

/** 逐标签扫描：属性写法、属性值里的裸 < / &、标签是否配对 */
function checkXml(svg) {
  const errs = [];
  if (typeof svg !== 'string' || !svg.length) return ['不是非空字符串'];
  const stack = [];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(svg)) !== null) {
    checkChars(svg.slice(last, m.index), errs, '文本段');
    last = TAG_RE.lastIndex;
    const name = m[2];
    const attrs = m[3];
    const rest = attrs.replace(/(?:"[^"]*"|'[^']*')/g, '§');
    if (!/^(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*§)*$/.test(rest)) errs.push('属性写法不合规：<' + name + attrs + '>');
    for (const q of attrs.match(/(?:"[^"]*"|'[^']*')/g) || []) {
      checkChars(q, errs, '<' + name + '> 属性值');
    }
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      const top = stack.pop();
      if (top !== name) errs.push('闭合不匹配：期望 </' + top + '>，实际 </' + name + '>');
    } else {
      stack.push(name);
    }
  }
  checkChars(svg.slice(last), errs, '文末文本段');
  if (stack.length) errs.push('未闭合标签：' + stack.join(' > '));
  if (svg.replace(VALID_ENT, '').includes('&')) errs.push('全文仍有裸 &');
  return errs;
}

/** 结构断言：返回问题数组，空数组 = 通过 */
function xmlProblems(svg) {
  return checkXml(svg);
}

/* ---------- 计数与提取小工具 ---------- */

const count = (svg, re) => (svg.match(re) || []).length;
const gridLines = (svg) => count(svg, /<line /g) - 1;   // 壳里有一条页脚分隔线，减掉
const SEAT_FILLS = ['#0f172a', '#f8fafc', '#ef4444', '#facc15', '#fbbf24', '#38bdf8'];
const marks = (svg) => [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)" fill="([^"]+)"/g)]
  .map((m) => ({ cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]), fill: m[4] }))
  .filter((c) => SEAT_FILLS.indexOf(c.fill) >= 0);

/* ---------- 固定数据（全部写死，测试本身也必须确定性） ---------- */

const GOMOKU = { slug: 'gomoku', title: '五子棋', emoji: '⚫', accent: '#6366f1', accent2: '#8b5cf6', category: { slug: 'board', name: '棋牌' } };

function replayFixture(over) {
  return Object.assign({
    id: 12,
    game: 'gomoku',
    code: 'ABC123',
    hostName: '小明',
    guestName: '小红',
    result: 'host',
    winner: '小明',
    moveCount: 3,
    moves: [{ seq: 1, seat: 0, move: '7,7' }, { seq: 2, seat: 1, move: '8,8' }, { seq: 3, seat: 0, move: '7,8' }],
    createdAt: Date.UTC(2026, 9, 20, 8, 11)
  }, over || {});
}

function statsFixture(over) {
  return Object.assign({
    id: 1, username: 'xiaoming', name: '小明', role: 'user',
    comments: 12, favorites: 6, ratings: 3, threads: 4, replies: 30,
    submitted: 1, published: 1, verified: 1, days: 40, daily: 15, streak: 9,
    doneToday: true, joinedAt: 1760000000000
  }, over || {});
}

function profileFixture(over) {
  const st = statsFixture(over);
  const lv = levelOf(st);
  const list = badgesOf(st);
  return Object.assign({}, st, {
    badges: over && Array.isArray(over.badges) ? over.badges : list,
    badgesOwned: list.filter((b) => b.done).length,
    level: lv.level, xp: lv.xp, xpFloor: lv.floor, xpNext: lv.next, xpNeed: lv.need,
    title: titleOf(lv.level)
  });
}

function dailyFixture(over) {
  return Object.assign({
    day: '2026-10-20',
    game: GOMOKU,
    stats: {
      day: '2026-10-20', slug: 'gomoku', total: 23, streak: 9, doneToday: true,
      done: ['2026-10-20 00:05:00', '2026-10-19 08:00:00', '2026-10-18']
    }
  }, over || {});
}

const CARDS = {
  replay: () => replayCardSvg({ replay: replayFixture(), game: GOMOKU, origin: 'http://127.0.0.1:3000' }),
  profile: () => profileCardSvg({ profile: profileFixture(), origin: 'https://game.example.com' }),
  daily: () => dailyCardSvg(dailyFixture())
};

/* ================= 跑测试 ================= */

console.log('分享卡片 SVG 自测');

/* ---- ① XML 结构 ---- */
console.log('· ① XML 结构与转义');
for (const [name, make] of Object.entries(CARDS)) {
  const svg = make();
  const errs = xmlProblems(svg);
  ok(name + ' 卡：标签闭合 / 无裸 & / 无裸 <', errs.length === 0, errs.join(' | '));
}
ok('checkXml 能抓到未闭合的标签（自检）', xmlProblems('<svg><text>x</text>').length > 0);
ok('checkXml 能抓到裸 & 与裸 <（自检）', xmlProblems('<svg><text>a & b < c</text></svg>').length >= 2);
ok('esc 转义五个字符', esc('&<>"\'') === '&amp;&lt;&gt;&quot;&apos;');
ok('esc 把 script 标签整体转义', esc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
ok('esc 对 null/undefined 返回空串', esc(null) === '' && esc(undefined) === '');

/* ---- ② 注入 ---- */
console.log('· ② 注入与转义（用户名 / 徽章名 / origin / accent）');
const EVIL = '<script>alert(1)</script>';
const EVIL_TEXT = EVIL + ' "双引号" \'单引号\' & 中文😀 <img src=x onerror=alert(2)>';
const BAD_RE = /<script|<img|onerror\s*=|onload\s*=|javascript:|<iframe/i;

const injReplay = replayCardSvg({
  replay: replayFixture({ hostName: EVIL_TEXT, guestName: EVIL, winner: EVIL_TEXT }),
  game: Object.assign({}, GOMOKU, { title: EVIL_TEXT, accent: '"><script>alert(3)</script>', accent2: 'x' }),
  origin: 'https://evil.example/"><script>alert(4)</script>'
});
const injProfile = profileCardSvg({
  profile: profileFixture({
    name: EVIL_TEXT,
    badges: [
      { id: 'x', icon: '<b>', name: EVIL_TEXT, desc: EVIL, need: 1, now: 1, done: false },
      { id: 'y', icon: '🏅', name: EVIL, desc: '', need: 1, now: 1, done: true }
    ]
  }),
  origin: 'http://evil.example"><script>alert(5)</script>'
});
const injDaily = dailyCardSvg({
  day: '2026-10-20',
  game: Object.assign({}, GOMOKU, { title: EVIL_TEXT, emoji: '<svg>' }),
  stats: { total: 1, streak: 1, doneToday: true, done: ['<script>'] },
  origin: EVIL
});

for (const [name, svg] of [['replay', injReplay], ['profile', injProfile], ['daily', injDaily]]) {
  ok(name + ' 卡：注入输入不产生可执行标签', !BAD_RE.test(svg), (svg.match(BAD_RE) || [])[0]);
  ok(name + ' 卡：注入串以转义形态出现（证明数据确实进了图）', svg.includes('&lt;script&gt;'), svg.includes('&lt;script&gt;'));
  ok(name + ' 卡：注入输入下仍是合法 XML', xmlProblems(svg).length === 0, xmlProblems(svg).join(' | '));
}
ok('非法 accent 回落到默认色而不是写进属性', injReplay.includes('stop-color="#6366f1"') && !injReplay.includes('alert(3)'));
ok('origin 只保留主机名（协议与路径被剥掉）', injReplay.includes('evil.example') && !injReplay.includes('evil.example/'));
ok('origin 里的注入串被转义成文本（不留 tag 边界）', injProfile.includes('&quot;&gt;') && !BAD_RE.test(injProfile) && !BAD_RE.test(injDaily));

/* ---- ③ 无外部资源 ---- */
console.log('· ③ 外部资源引用');
for (const [name, svg] of Object.entries(Object.assign({}, CARDS, { injReplay })) ) {
  const body = typeof svg === 'function' ? svg() : svg;
  const refs = [...body.matchAll(/(?:href|src|xlink:href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  ok(name + ' 卡：没有 href/src/xlink:href', refs.length === 0, refs.join(','));
  const urls = [...body.matchAll(/url\(\s*([^)]+?)\s*\)/g)].map((m) => m[1]);
  ok(name + ' 卡：url() 只指向文档内渐变', urls.every((u) => u.startsWith('#')), urls.filter((u) => !u.startsWith('#')).join(','));
  const noXmlns = body.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
  ok(name + ' 卡：去掉 xmlns 后无 http(s):// 外链', !/https?:\/\//i.test(noXmlns), (noXmlns.match(/https?:\/\/\S{0,40}/i) || [])[0]);
  ok(name + ' 卡：无 <image>/<script>/@import/data:', !/<image|<script|@import|data:/i.test(body));
}
const withHttpOrigin = replayCardSvg({ replay: replayFixture(), game: GOMOKU, origin: 'http://127.0.0.1:3000' });
ok('origin 带 http:// 也不会写出外链', !/https?:\/\//i.test(withHttpOrigin.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')));

/* ---- ④ 确定性 ---- */
console.log('· ④ 确定性（同一输入两次调用完全一致）');
for (const [name, make] of Object.entries(CARDS)) {
  const a = make();
  const b = make();
  ok(name + ' 卡：两次调用字符串完全相同', a === b, a.length + ' vs ' + b.length);
}
ok('换个对象但内容相同，输出仍一致', profileCardSvg({ profile: profileFixture() }) === profileCardSvg({ profile: profileFixture() }));
ok('fmtTime 用 UTC 且不读时钟', fmtTime(Date.UTC(2026, 9, 20, 8, 11)) === '2026-10-20 08:11' && fmtTime(0) === '');
ok('输出里没有当日/当前时间戳痕迹', !/\bDate\.now\b|toLocaleString/.test(CARDS.replay()));

/* ---- ⑤ 尺寸、viewBox、体量 ---- */
console.log('· ⑤ 尺寸 / viewBox / 长度');
for (const [name, make] of Object.entries(CARDS)) {
  const svg = make();
  ok(name + ' 卡：viewBox 与 width/height 一致（1200×630）',
    svg.includes('viewBox="0 0 1200 630"') && svg.includes('width="1200"') && svg.includes('height="630"'));
  ok(name + ' 卡：有 role="img" 与 aria-label', svg.includes('role="img"') && svg.includes('aria-label="'));
  ok(name + ' 卡：长度在合理区间（<200KB）', svg.length > 2000 && svg.length < 200 * 1024, svg.length);
}
for (const [name, make] of Object.entries(CARDS)) {
  const svg = name === 'replay'
    ? replayCardSvg({ replay: replayFixture(), game: GOMOKU, width: 800, height: 400 })
    : (name === 'profile' ? profileCardSvg({ profile: profileFixture(), width: 800, height: 400 })
      : dailyCardSvg(Object.assign(dailyFixture(), { width: 800, height: 400 })));
  ok(name + ' 卡：自定义 800×400 时 viewBox 同步', svg.includes('viewBox="0 0 800 400"') && svg.includes('width="800"') && svg.includes('height="400"'));
  ok(name + ' 卡：自定义尺寸下仍是合法 XML', xmlProblems(svg).length === 0);
  ok(name + ' 卡：自定义尺寸下仍无外链', !/https?:\/\//i.test(svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')));
}
const clamped = replayCardSvg({ replay: replayFixture(), game: GOMOKU, width: 1, height: 999999 });
ok('尺寸越界被夹到安全区间', clamped.includes('width="200"') && clamped.includes('height="4096"'));
const nanSize = replayCardSvg({ replay: replayFixture(), game: GOMOKU, width: NaN, height: 'abc' });
ok('尺寸非法值回落到默认 1200×630', nanSize.includes('viewBox="0 0 1200 630"'));
const huge = replayCardSvg({
  replay: replayFixture({ moveCount: 2000, moves: Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, seat: i % 2, move: (i % 15) + ',' + (Math.floor(i / 15) % 15) })) }),
  game: GOMOKU
});
ok('2000 手棋谱仍 <200KB 且仍是合法 XML', huge.length < 200 * 1024 && xmlProblems(huge).length === 0, huge.length);
ok('棋子数被封顶（最多 240 枚）', marks(huge).length <= 240, marks(huge).length);

/* ---- ⑥ 容错与棋盘缩略图 ---- */
console.log('· ⑥ 容错 / 各游戏棋盘缩略图');
const tolerant = [
  ['空对象 replayCardSvg({})', () => replayCardSvg({})],
  ['replay 无 moves', () => replayCardSvg({ replay: replayFixture({ moves: [], moveCount: 0 }), game: GOMOKU })],
  ['moves 不是数组', () => replayCardSvg({ replay: replayFixture({ moves: 'oops', moveCount: NaN }), game: GOMOKU })],
  ['未知游戏 + 垃圾走法', () => replayCardSvg({ replay: replayFixture({ game: 'no-such-game', moves: [{ seq: 1, seat: 0, move: '???' }, { seq: 2, seat: 1, move: null }, { seq: 3, seat: 9, move: '' }] }), game: { slug: 'no-such-game' } })],
  ['game 为 null 且 moves 越界', () => replayCardSvg({ replay: replayFixture({ moves: [{ seat: 0, move: '99,99' }, { seat: 1, move: '-1,-1' }] }), game: null })],
  ['profileCardSvg({})', () => profileCardSvg({})],
  ['profile 只有统计字段', () => profileCardSvg({ profile: statsFixture() })],
  ['profile.badges 是脏数据', () => profileCardSvg({ profile: profileFixture({ badges: [null, {}, { done: true }] }) })],
  ['dailyCardSvg({})', () => dailyCardSvg({})],
  ['daily day 非法', () => dailyCardSvg(dailyFixture({ day: 'not-a-day' }))],
  ['daily stats.done 脏数据', () => dailyCardSvg(dailyFixture({ stats: { total: 'x', streak: -3, doneToday: 1, done: [null, 7, ''] } }))]
];
for (const [name, fn] of tolerant) {
  let svg = '';
  let threw = '';
  try { svg = fn(); } catch (e) { threw = e && e.message; }
  ok('不抛错：' + name, threw === '' && typeof svg === 'string' && svg.startsWith('<svg'), threw || (svg || '').slice(0, 40));
  ok('仍合法：' + name, threw === '' && xmlProblems(svg).length === 0, xmlProblems(svg).join(' | '));
}

// 各游戏走法编码 → 棋盘上应有的棋子数
const GAME_CASES = [
  ['gomoku', { slug: 'gomoku' }, ['7,7', '8,8', '7,8'], 3],
  ['reversi', { slug: 'reversi' }, ['3,3', '4,4', 'pass'], 2],
  ['xiangqi', { slug: 'xiangqi' }, ['3,6-3,4', '0,3-0,4'], 2],
  ['chess', { slug: 'chess' }, ['e2e4', 'e7e5', 'g1f3'], 3],
  ['draughts', { slug: 'draughts' }, ['52-41', '52-41-30'], 2],
  ['tictactoe', { slug: 'tictactoe' }, ['4', '0'], 2]
];
for (const [label, game, moves, expect] of GAME_CASES) {
  const svg = replayCardSvg({
    replay: replayFixture({ game: label, moves: moves.map((mv, i) => ({ seq: i + 1, seat: i % 2, move: mv })) }),
    game: game
  });
  ok(label + ' 走法解析出 ' + expect + ' 枚棋子', marks(svg).length === expect, marks(svg).length);
}
const c4 = replayCardSvg({ replay: replayFixture({ game: 'connect4', moves: [{ seq: 1, seat: 0, move: '3' }, { seq: 2, seat: 1, move: '3' }, { seq: 3, seat: 0, move: '3' }] }), game: { slug: 'connect4' } });
const c4red = marks(c4).filter((c) => c.fill === '#ef4444');
const c4yellow = marks(c4).filter((c) => c.fill === '#facc15');
ok('connect4 按列落子并向上叠（同列两枚一红一黄、红在下方）',
  c4red.length === 2 && c4yellow.length === 1 && c4red[0].cy !== c4red[1].cy && c4red[1].cy < c4red[0].cy,
  JSON.stringify([c4red, c4yellow]));
ok('connect4 列号越界被忽略', marks(replayCardSvg({ replay: replayFixture({ game: 'connect4', moves: [{ seq: 1, seat: 0, move: '9' }, { seq: 2, seat: 0, move: 'x' }] }), game: { slug: 'connect4' } })).length === 0);

const gomokuBig = replayCardSvg({ replay: replayFixture(), game: GOMOKU });
const ttt = replayCardSvg({ replay: replayFixture({ game: 'tictactoe', moves: [{ seq: 1, seat: 0, move: '4' }] }), game: { slug: 'tictactoe' } });
const unknown = replayCardSvg({ replay: replayFixture({ game: 'mystery', moves: [{ seq: 1, seat: 0, move: '3,3' }] }), game: { slug: 'mystery' } });
const reversi = replayCardSvg({ replay: replayFixture({ game: 'reversi', moves: [{ seq: 1, seat: 0, move: '3,3' }] }), game: { slug: 'reversi' } });
ok('gomoku 是 15×15 网格（16+16 条线）', gridLines(gomokuBig) === 32, gridLines(gomokuBig));
ok('tictactoe 是 3×3 网格（4+4 条线）', gridLines(ttt) === 8, gridLines(ttt));
ok('未知游戏退回 8×8 网格示意（与 reversi 同构）', gridLines(unknown) === 18 && gridLines(unknown) === gridLines(reversi), gridLines(unknown) + '/' + gridLines(reversi));
ok('未知游戏不画棋子也不抛错', marks(unknown).length === 0);
ok('回放卡把结果、手数、时间写进图里',
  CARDS.replay().includes('🏆 小明 获胜') && CARDS.replay().includes('共 3 手') && CARDS.replay().includes('2026-10-20 08:11'));
ok('和棋口径与回放页一致', replayCardSvg({ replay: replayFixture({ result: 'draw', winner: '和棋' }), game: GOMOKU }).includes('🤝 和棋'));
ok('无结果时显示「对局结束」', replayCardSvg({ replay: replayFixture({ result: '', winner: '' }), game: GOMOKU }).includes('对局结束'));

// 个人卡与每日卡的内容口径
const prof = CARDS.profile();
ok('个人卡含昵称/称号/等级/四项统计',
  prof.includes('小明') && prof.includes(profileFixture().title) && prof.includes('Lv.') &&
  prof.includes('>评论<') && prof.includes('>收藏<') && prof.includes('>评分<') && prof.includes('>连续打卡（天）<'));
ok('个人卡徽章墙最多 12 枚、未解锁灰显带进度',
  (prof.match(/fill-opacity="0\.5"/g) || []).length > 0 && (prof.match(/\d+\/\d+<\/text>/g) || []).length > 0);
const manyBadges = profileCardSvg({ profile: profileFixture({ badges: Array.from({ length: 16 }, (_, i) => ({ id: 'b' + i, icon: '🏅', name: '徽章' + i, need: 1, now: 1, done: i < 10 })) }) });
ok('徽章超过 12 枚时只展示 12 枚并注明剩余', (manyBadges.match(/🏅<\/text>/g) || []).length === 12 && manyBadges.includes('还有'), (manyBadges.match(/🏅<\/text>/g) || []).length);
const dl = CARDS.daily();
ok('每日卡含日期/题目/打卡状态/连续天数', dl.includes('>2026-10-20<') && dl.includes('五子棋') && dl.includes('今天已打卡') && dl.includes('>9<'));
ok('每日卡画出最近 14 天条带（3 天已打卡）', (dl.match(/fill="url\(#ring\)"/g) || []).length === 3, (dl.match(/fill="url\(#ring\)"/g) || []).length);
ok('每日卡未打卡时换成待打卡文案', dailyCardSvg(dailyFixture({ stats: { total: 1, streak: 1, doneToday: false } })).includes('今天还没打卡'));
ok('每日卡无日期时不画条带也不抛错', xmlProblems(dailyCardSvg({ day: '', game: GOMOKU, stats: {} })).length === 0);

console.log('');
console.log((fail === 0 ? 'PASS' : 'FAIL') + '：' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' 项断言');
process.exit(fail ? 1 : 0);
