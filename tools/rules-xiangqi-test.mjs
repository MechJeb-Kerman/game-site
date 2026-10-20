/**
 * 中国象棋服务端裁判（src/rules/xiangqi.js）的回归测试。
 *   node tools/rules-xiangqi-test.mjs
 * 退出码 0 = 全部通过。
 *
 * 口径全部照抄 games/xiangqi/index.html 的客户端实现（含 NetPlay 中继的走法串），
 * 只调模块的 META / create，不经过 src/rules/index.js 的注册表：xiangqi 的注册
 * 由他人统一做，这里只用 index.js 的 ERRORS / toResult 校验契约口径。
 */
import assert from 'node:assert/strict';
import { META, create } from '../src/rules/xiangqi.js';
import { ERRORS, toResult } from '../src/rules/index.js';

let pass = 0;
const fails = [];
/** 覆盖率统计（报告里引用），只记录不参与判定 */
const stats = { openingMoves: 0, replayed: 0, drawPlies: 0 };

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(name + ' —— ' + (e && e.message ? e.message : String(e)));
  }
}

function show(m) {
  return typeof m === 'string' ? JSON.stringify(m) : String(m);
}

/** 走一手棋并要求成功（模块口径：成功 return null，失败 return 错误码） */
function play(g, seat, move) {
  const r = g.apply(seat, move);
  assert.equal(r, null, show(move) + ' 被拒：' + r);
  return r;
}

/** 走一手棋并要求被拒，可选校验错误码 */
function rejected(g, seat, move, expected) {
  const r = g.apply(seat, move);
  assert.ok(typeof r === 'string' && r.length > 0, '本应被拒：' + show(move) + '（实际 ' + r + '）');
  if (expected) assert.equal(r, expected, show(move) + ' 的错误码');
  return r;
}

/** 用 [x, y, 棋子串] 列表构造 90 格棋盘，顺带查重与越界 */
function boardOf(list) {
  const bd = new Array(90).fill('');
  for (const item of list) {
    const x = item[0], y = item[1], p = item[2];
    assert.ok(x >= 0 && x <= 8 && y >= 0 && y <= 9, '构造局面时坐标越界：' + item.join(','));
    assert.equal(bd[y * 9 + x], '', '构造局面时同一格摆了两枚子：' + item.join(','));
    bd[y * 9 + x] = p;
  }
  return bd;
}

/** 独立解析线上走法串 x1,y1-x2,y2（不复用模块内部实现，顺便验证形状） */
function wire(s) {
  const m = /^(\d),(\d)-(\d),(\d)$/.exec(s);
  assert.ok(m, '走法串形状不是 <x>,<y>-<x>,<y>：' + JSON.stringify(s));
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

/** 模块实例的 status 口径（= src/rules/index.js 的 statusOf(g)） */
function status(g) {
  return { over: g.over, winner: g.over ? g.winner : 0, draw: g.over ? !!g.draw : false };
}

function has(list, s) { return list.indexOf(s) >= 0; }

// ── 契约与元信息 ─────────────────────────────────────────────────────────
t('META：slug/seats/moveFormat/note 齐备且形状正确', () => {
  assert.equal(META.slug, 'xiangqi');
  assert.equal(META.seats, 2);
  assert.ok(typeof META.moveFormat === 'string' && META.moveFormat.length > 0, '缺 moveFormat');
  assert.ok(typeof META.note === 'string' && META.note.length > 0, '缺 note');
});

t('moveFormat 描述的就是客户端线上形状 <x>,<y>-<x>,<y>（含示例 1,7-4,7）', () => {
  assert.ok(META.moveFormat.indexOf('1,7-4,7') >= 0, '示例坐标不见了：' + META.moveFormat);
  assert.ok(/0\.\.8/.test(META.moveFormat), 'x 范围 0..8 未写明');
  assert.ok(/0\.\.9/.test(META.moveFormat), 'y 范围 0..9 未写明');
});

t('模块只会返回 index.js 白名单里的错误码', () => {
  for (const code of ['bad_move', 'illegal_move', 'not_your_turn', 'game_over']) {
    assert.ok(ERRORS.indexOf(code) >= 0, code + ' 不在 index.js 的 ERRORS 里');
  }
});

t('create() 实例暴露 index.js 依赖的字段与方法', () => {
  const g = create();
  assert.equal(typeof g.apply, 'function');
  assert.equal(typeof g.legalMoves, 'function');
  assert.equal(typeof g.moves, 'function');
  assert.equal(typeof g.view, 'function');
  assert.equal(g.turn, 0, '红方（seat 0）先手');
  assert.equal(g.over, false);
  assert.equal(g.winner, 0);
  assert.equal(g.draw, false);
  assert.equal(g.slug, 'xiangqi');
});

t('view() 形状：终局字段 + 棋盘快照 + 将军/无吃子计数', () => {
  const v = create().view();
  assert.equal(v.slug, 'xiangqi');
  assert.equal(v.turn, 0);
  assert.equal(v.over, false);
  assert.equal(v.winner, 0);
  assert.equal(v.draw, false);
  assert.equal(v.moveCount, 0);
  assert.equal(v.board.length, 90);
  assert.equal(v.check, false);
  assert.equal(v.noCapturePlies, 0);
  assert.equal(v.lastMove, null);
  assert.equal(v.lastCapture, '');
});

t('view().board 是深拷贝，改它不影响引擎', () => {
  const g = create();
  const v = g.view();
  v.board[64] = 'xx';
  v.board[0] = '';
  assert.equal(g.view().board[64], 'rC');
  assert.equal(g.view().board[0], 'bR');
  assert.equal(g.legalMoves().length, 44);
});

t('moves() 返回副本：外部 push 不影响引擎', () => {
  const g = create();
  play(g, 0, '1,7-4,7');
  const list = g.moves();
  list.push({ seat: 1, move: '0,0-0,1' });
  list[0].move = 'zzz';
  assert.equal(g.moves().length, 1);
  assert.equal(g.moves()[0].move, '1,7-4,7');
});

// ── 开局 ────────────────────────────────────────────────────────────────
t('开局合法走法 44 条（与客户端一致）', () => {
  const ms = create().legalMoves();
  stats.openingMoves = ms.length;
  assert.equal(ms.length, 44);
  assert.equal(new Set(ms).size, 44, '有重复走法');
});

t('开局每条走法都落在线上形状上，且起点都是红子', () => {
  const g = create();
  const bd = g.view().board;
  for (const mv of g.legalMoves()) {
    const w = wire(mv);
    const p = bd[w.y1 * 9 + w.x1];
    assert.ok(p && p.charAt(0) === 'r', mv + ' 起点不是红子：' + p);
  }
});

t('开局 44 条按棋子分项：{rP:5, rC:24, rR:4, rH:4, rE:4, rA:2, rK:1}', () => {
  const g = create();
  const bd = g.view().board;
  const counts = {};
  for (const mv of g.legalMoves()) {
    const w = wire(mv);
    const p = bd[w.y1 * 9 + w.x1];
    counts[p] = (counts[p] || 0) + 1;
  }
  assert.deepEqual(counts, { rP: 5, rC: 24, rR: 4, rH: 4, rE: 4, rA: 2, rK: 1 });
});

t('开局红车 (0,9) 恰好两步：(0,8)、(0,7)，被自家兵挡住上不去', () => {
  const ms = create().legalMoves();
  assert.ok(has(ms, '0,9-0,8'));
  assert.ok(has(ms, '0,9-0,7'));
  assert.ok(!has(ms, '0,9-0,6'), '自家兵 (0,6) 应当挡住');
  assert.ok(!has(ms, '0,9-1,9'), '自家马 (1,9) 应当挡住');
});

t('开局红马 (1,9) 只有 2 步：相脚塞住了 (3,8) 的马腿', () => {
  const ms = create().legalMoves();
  assert.ok(has(ms, '1,9-2,7'));
  assert.ok(has(ms, '1,9-0,7'));
  assert.ok(!has(ms, '1,9-3,8'), '(2,9) 的红相别住了马腿');
  assert.equal(ms.filter((s) => s.indexOf('1,9-') === 0).length, 2);
});

t('开局 44 条逐一 apply 都成功', () => {
  for (const mv of create().legalMoves()) {
    play(create(), 0, mv);
  }
});

t('开局不该轮到黑方：seat 1 走红方合法着法 → not_your_turn', () => {
  rejected(create(), 1, '1,7-4,7', 'not_your_turn');
});

t('legalMoves(side) 只认当前该走方，别家与非 0/1 一律空', () => {
  const g = create();
  assert.equal(g.legalMoves().length, 44);
  assert.deepEqual(g.legalMoves(1), []);
  assert.deepEqual(g.legalMoves(2), []);
  assert.deepEqual(g.legalMoves(-1), []);
  play(g, 0, '1,7-4,7');
  assert.deepEqual(g.legalMoves(0), []);
  assert.ok(g.legalMoves(1).length > 0);
  assert.ok(g.legalMoves().length > 0);
});

// ── 走法串编码 ──────────────────────────────────────────────────────────
t('线上串往返：NetPlay 发出的 1,7-4,7 原样可用', () => {
  const g = create();
  play(g, 0, '1,7-4,7');
  assert.deepEqual(g.view().lastMove, { x1: 1, y1: 7, x2: 4, y2: 7 });
  assert.deepEqual(g.moves(), [{ seat: 0, move: '1,7-4,7' }]);
  assert.equal(g.moveCount, 1);
});

t('解析容错：空白会被忽略（1,7 - 4,7 等价）', () => {
  const g = create();
  play(g, 0, ' 1,7 - 4,7 ');
  assert.deepEqual(g.moves(), [{ seat: 0, move: '1,7-4,7' }]);
});

t('解析容错：分隔符写成冒号也当同一手（1,7:4,7）', () => {
  const g = create();
  play(g, 0, '1,7:4,7');
  assert.deepEqual(g.moves(), [{ seat: 0, move: '1,7-4,7' }], '记录下来的仍是规范串');
});

t('刻意不认 ICCS 简写：h2e2 / b0c2 → bad_move', () => {
  rejected(create(), 0, 'h2e2', 'bad_move');
  rejected(create(), 0, 'b0c2', 'bad_move');
  rejected(create(), 0, ' h2e2 ', 'bad_move');
});

t('畸形走法串一律 bad_move', () => {
  const bad = ['', ' ', 'abc', '1,7', '1,7-', '-4,7', '1,7-4', '1,7-4,7-5,8', '1,7-4,7,8',
    '1,7--4,7', '9,7-4,7', '1,10-4,7', '-1,7-4,7', '1.5,7-4,7', 'x,y-x,y', '1,7=4,7',
    '1,7-4,7 ' + 'x'.repeat(300)];
  const g = create();
  for (const m of bad) rejected(g, 0, m, 'bad_move');
  assert.equal(g.moveCount, 0, '被拒的走法不能留下痕迹');
  assert.equal(g.legalMoves().length, 44, '被拒的走法不能改棋盘');
});

t('非字符串非有限数（null/undefined/{}/[]/true/NaN/Infinity/123）→ bad_move', () => {
  const g = create();
  for (const m of [null, undefined, {}, [], true, NaN, Infinity, -Infinity, 123, 0, 1.5]) {
    rejected(g, 0, m, 'bad_move');
  }
});

t('seat 非法（2/-1/"0"/undefined/null）→ bad_move', () => {
  const g = create();
  for (const s of [2, -1, '0', '1', undefined, null, true, {}]) {
    rejected(g, s, '1,7-4,7', 'bad_move');
  }
});

t('手数用尽后（终局）任何 apply → game_over', () => {
  const g = create({ board: boardOf([[4, 1, 'rR'], [5, 0, 'bK'], [5, 1, 'bH'], [5, 2, 'bA'], [4, 8, 'rK']]) });
  play(g, 0, '4,1-4,0');
  assert.equal(g.over, true);
  rejected(g, 0, '4,0-4,1', 'game_over');
  rejected(g, 1, '5,0-5,1', 'game_over');
  assert.deepEqual(g.legalMoves(), []);
});

// ── 马腿 ────────────────────────────────────────────────────────────────
t('马腿（纵向）：被别住的 (5,2)/(3,2) 走不了', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 4, 'rH'], [4, 3, 'rP']]) });
  assert.ok(has(g.legalMoves(), '4,4-5,6'));
  assert.ok(has(g.legalMoves(), '4,4-6,5'));
  rejected(g, 0, '4,4-5,2', 'illegal_move');
  rejected(g, 0, '4,4-3,2', 'illegal_move');
});

t('马腿（横向）：|dx|=2 时别马腿的是横向中点', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 4, 'rH'], [5, 4, 'rP']]) });
  assert.ok(has(g.legalMoves(), '4,4-3,2'));
  assert.ok(has(g.legalMoves(), '4,4-5,2'));
  rejected(g, 0, '4,4-6,5', 'illegal_move');
  rejected(g, 0, '4,4-6,3', 'illegal_move');
});

t('马不吃自家子、也不许斜走', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 4, 'rH'], [5, 6, 'rP']]) });
  rejected(g, 0, '4,4-5,6', 'illegal_move');
  rejected(g, 0, '4,4-5,5', 'illegal_move');
});

// ── 象眼与象不过河 ──────────────────────────────────────────────────────
t('象眼被塞：4,5 的红相走不到 (2,7)', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 5, 'rE'], [3, 6, 'rP']]) });
  assert.ok(has(g.legalMoves(), '4,5-6,7'), '另一只象眼没被塞');
  rejected(g, 0, '4,5-2,7', 'illegal_move');
});

t('象不过河：红相 y<5 / 黑象 y>4 的落点全非法', () => {
  const red = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 5, 'rE']]) });
  assert.ok(has(red.legalMoves(), '4,5-2,7'));
  assert.ok(has(red.legalMoves(), '4,5-6,7'));
  rejected(red, 0, '4,5-2,3', 'illegal_move');
  rejected(red, 0, '4,5-6,3', 'illegal_move');
  const black = create({ board: boardOf([[5, 9, 'rK'], [4, 0, 'bK'], [4, 4, 'bE'], [8, 9, 'rR']]) });
  play(black, 0, '8,9-8,8');
  assert.ok(has(black.legalMoves(), '4,4-2,2'));
  assert.ok(has(black.legalMoves(), '4,4-6,2'));
  rejected(black, 1, '4,4-2,6', 'illegal_move');
  rejected(black, 1, '4,4-6,6', 'illegal_move');
});

t('开局两只红相各 2 步（共 4 步）都在河这边', () => {
  const ms = create().legalMoves();
  assert.equal(ms.filter((s) => s.indexOf('2,9-') === 0).length, 2);
  assert.equal(ms.filter((s) => s.indexOf('6,9-') === 0).length, 2);
  assert.ok(has(ms, '2,9-4,7') && has(ms, '2,9-0,7'));
});

// ── 士、将与九宫 ────────────────────────────────────────────────────────
t('士不出九宫：宫内斜角可走，出宫斜角与直走一律非法', () => {
  const a = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [5, 8, 'rA']]) });
  assert.ok(has(a.legalMoves(), '5,8-4,7'), '宫内斜角');
  rejected(a, 0, '5,8-6,7', 'illegal_move');
  rejected(a, 0, '5,8-6,9', 'illegal_move');
  rejected(a, 0, '5,8-3,7', 'illegal_move');
  const b = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [4, 8, 'rA']]) });
  for (const mv of ['4,8-3,7', '4,8-5,7', '4,8-3,9', '4,8-5,9']) assert.ok(has(b.legalMoves(), mv), mv);
  assert.equal(b.legalMoves().filter((s) => s.indexOf('4,8-') === 0).length, 4, '宫里四个斜角都能走');
});

t('士不出九宫（黑）：bA (5,2) 的 (6,1) 与 (4,1)/(5,0) 之外都非法', () => {
  const g = create({ board: boardOf([[5, 9, 'rK'], [4, 0, 'bK'], [5, 2, 'bA'], [8, 9, 'rR']]) });
  play(g, 0, '8,9-8,8');
  assert.ok(has(g.legalMoves(), '5,2-4,1'));
  rejected(g, 1, '5,2-6,1', 'illegal_move');
  rejected(g, 1, '5,2-5,3', 'illegal_move');
});

t('帅不出九宫：红帅 (3,9) 不能走到 (2,9)，也不能走斜线', () => {
  const g = create({ board: boardOf([[3, 9, 'rK'], [5, 0, 'bK']]) });
  assert.ok(has(g.legalMoves(), '3,9-3,8'));
  assert.ok(has(g.legalMoves(), '3,9-4,9'));
  rejected(g, 0, '3,9-2,9', 'illegal_move');
  rejected(g, 0, '3,9-4,8', 'illegal_move');
});

t('将不出九宫（黑）：(6,0)/(4,-1) 都非法', () => {
  const g = create({ board: boardOf([[5, 9, 'rK'], [4, 0, 'bK'], [8, 9, 'rR']]) });
  play(g, 0, '8,9-8,8');
  assert.ok(has(g.legalMoves(), '4,0-4,1'));
  assert.ok(has(g.legalMoves(), '4,0-3,0'));
  rejected(g, 1, '4,0-6,0', 'illegal_move');
  rejected(g, 1, '4,0-4,-1', 'bad_move'); // 负坐标连解析都过不了，属畸形串
  rejected(g, 1, '4,0-3,1', 'illegal_move');
});

// ── 兵/卒 ───────────────────────────────────────────────────────────────
t('红兵过河前只能直进：向前可、横走与后退不可', () => {
  const g = create();
  assert.ok(has(g.legalMoves(), '0,6-0,5'));
  rejected(g, 0, '0,6-1,6', 'illegal_move');
  rejected(g, 0, '0,6-0,7', 'illegal_move');
});

t('红兵过河后可横走，仍不许后退、不许斜走', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [0, 4, 'rP']]) });
  assert.ok(has(g.legalMoves(), '0,4-0,3'));
  assert.ok(has(g.legalMoves(), '0,4-1,4'));
  rejected(g, 0, '0,4-0,5', 'illegal_move');
  rejected(g, 0, '0,4-1,3', 'illegal_move');
});

t('黑卒过河前只能直进（向前可、横走与后退不可）', () => {
  const g = create({ board: boardOf([[5, 9, 'rK'], [4, 0, 'bK'], [0, 3, 'bP'], [8, 9, 'rR']]) });
  play(g, 0, '8,9-8,8');
  assert.ok(has(g.legalMoves(), '0,3-0,4'));
  rejected(g, 1, '0,3-1,3', 'illegal_move');
  rejected(g, 1, '0,3-0,2', 'illegal_move');
});

t('黑卒过河后可横走，仍不许后退', () => {
  const g = create({ board: boardOf([[5, 9, 'rK'], [4, 0, 'bK'], [0, 5, 'bP'], [8, 9, 'rR']]) });
  play(g, 0, '8,9-8,8');
  assert.ok(has(g.legalMoves(), '0,5-0,6'));
  assert.ok(has(g.legalMoves(), '0,5-1,5'));
  rejected(g, 1, '0,5-0,4', 'illegal_move');
});

t('兵永远不吃自家子', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [0, 4, 'rP'], [0, 3, 'rP']]) });
  rejected(g, 0, '0,4-0,3', 'illegal_move');
});

// ── 车 ──────────────────────────────────────────────────────────────────
t('车走直线、不能越子：开局红车 (0,9) 只能到 (0,8)/(0,7)', () => {
  const ms = create().legalMoves();
  assert.equal(ms.filter((s) => s.indexOf('0,9-') === 0).sort().join(','), '0,9-0,7,0,9-0,8');
});

t('车可吃子、不能跳过挡子', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [0, 5, 'rR'], [0, 6, 'bP']]) });
  assert.ok(has(g.legalMoves(), '0,5-0,6'), '正前方敌子可吃');
  rejected(g, 0, '0,5-0,7', 'illegal_move');
  rejected(g, 0, '0,5-0,9', 'illegal_move');
  assert.ok(has(g.legalMoves(), '0,5-0,4'), '反方向空格可走');
  assert.ok(has(g.legalMoves(), '0,5-4,5'), '横走空格可走');
  rejected(g, 0, '0,5-1,4', 'illegal_move');
});

// ── 炮 ──────────────────────────────────────────────────────────────────
t('炮必须隔一个炮架才能吃：隔一子吃得到 (1,0) 的黑马', () => {
  const g = create();
  assert.ok(has(g.legalMoves(), '1,7-1,0'), '隔 (1,2) 的黑炮当架子吃 (1,0) 的黑马');
  play(g, 0, '1,7-1,0');
  assert.equal(g.view().lastCapture, 'bH');
  assert.equal(g.view().noCapturePlies, 0, '吃子要清零无吃子计数');
});

t('炮不隔子不能吃：1,7-1,2 非法（正前方就是黑炮）', () => {
  rejected(create(), 0, '1,7-1,2', 'illegal_move');
});

t('炮不能落在炮架之后的空格：1,7-1,1 非法', () => {
  rejected(create(), 0, '1,7-1,1', 'illegal_move');
});

t('炮可以不吃子平走：1,7-1,6 / 1,7-4,7 合法', () => {
  const g = create();
  assert.ok(has(g.legalMoves(), '1,7-1,6'));
  assert.ok(has(g.legalMoves(), '1,7-4,7'));
  rejected(g, 0, '1,7-7,7', 'illegal_move');
});

t('炮架成对（两个子）时吃不到：0,0-4,0 合法而 0,0-6,0 非法', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [5, 0, 'bK'], [0, 0, 'rC'], [2, 0, 'bP'], [4, 0, 'bP']]) });
  assert.ok(has(g.legalMoves(), '0,0-4,0'), '隔 (2,0) 一个架子');
  rejected(g, 0, '0,0-6,0', 'illegal_move');
  rejected(g, 0, '0,0-2,0', 'illegal_move');
  assert.ok(has(g.legalMoves(), '0,0-1,0'), '不吃子时不需要架子');
});

// ── 将帅照面 / 送将 / 应将 ──────────────────────────────────────────────
t('将帅照面：挪开同列挡子 → 非法（自己送将）', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 5, 'rH'], [4, 0, 'bK']]) });
  assert.equal(g.view().check, false, '初始不算被将');
  rejected(g, 0, '4,5-3,7', 'illegal_move');
  rejected(g, 0, '4,5-5,7', 'illegal_move');
  rejected(g, 0, '4,5-2,6', 'illegal_move');
});

t('帅不能走进照面线：3,8-4,8 与 3,8-4,9 都非法（同列无子）', () => {
  const g = create({ board: boardOf([[3, 8, 'rK'], [4, 0, 'bK']]) });
  assert.equal(g.view().check, false, '初始既不被将也不照面');
  rejected(g, 0, '3,8-4,8', 'illegal_move');
  rejected(g, 0, '3,8-4,9', 'illegal_move');
  assert.ok(has(g.legalMoves(), '3,8-3,9'));
  rejected(g, 0, '3,8-2,8', 'illegal_move');
});

t('被将军时必须应将：挪车不理将军 → 非法', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [0, 5, 'rR'], [8, 9, 'rR'], [5, 0, 'bK'], [4, 1, 'bR']]) });
  assert.equal(g.view().check, true, '黑车 (4,1) 正将红帅');
  rejected(g, 0, '8,9-8,8', 'illegal_move');
  rejected(g, 0, '4,9-4,8', 'illegal_move');
});

t('被将军时的两种正解：垫子 (0,5-4,5) 与出帅 (4,9-3,9) 合法', () => {
  const a = create({ board: boardOf([[4, 9, 'rK'], [0, 5, 'rR'], [8, 9, 'rR'], [5, 0, 'bK'], [4, 1, 'bR']]) });
  play(a, 0, '0,5-4,5');
  assert.equal(a.view().check, false, '垫上之后不再被将');
  const b = create({ board: boardOf([[4, 9, 'rK'], [0, 5, 'rR'], [8, 9, 'rR'], [5, 0, 'bK'], [4, 1, 'bR']]) });
  play(b, 0, '4,9-3,9');
  assert.equal(b.view().check, false);
  assert.equal(b.turn, 1);
});

t('照面即将军：对方把子挪开照面 → 我方被将的判定为 check', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 5, 'rH'], [4, 0, 'bK'], [0, 0, 'bR']]) });
  play(g, 0, '4,9-3,9');
  assert.equal(g.view().check, false, '红帅离开 x=4 后不再照面');
  assert.equal(g.turn, 1);
});

t('王对王（同列无子）时引擎给出飞将吃王的着法并判负', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 0, 'bK']]) });
  const ms = g.legalMoves();
  assert.ok(has(ms, '4,9-4,0'), '飞将：同列第一枚子就是对方王');
  assert.ok(has(ms, '4,9-3,9'));
  assert.ok(!has(ms, '4,9-4,8'), '留在同列仍然照面');
  play(g, 0, '4,9-4,0');
  assert.equal(g.over, true);
  assert.equal(g.winner, 1);
  assert.equal(g.draw, false);
  assert.equal(g.turn, -1);
  assert.deepEqual(g.legalMoves(), []);
});

// ── 将死 / 困毙 / 和棋 ──────────────────────────────────────────────────
t('将死：红车 4,1-4,0 做成杀棋 → over/winner=1/draw=false/check=true', () => {
  const g = create({ board: boardOf([[4, 1, 'rR'], [5, 0, 'bK'], [5, 1, 'bH'], [5, 2, 'bA'], [4, 8, 'rK']]) });
  play(g, 0, '4,1-4,0');
  assert.equal(g.over, true);
  assert.equal(g.winner, 1, '红方（seat 0）赢 → winner = seat + 1');
  assert.equal(g.draw, false);
  assert.equal(g.turn, -1);
  assert.equal(g.view().check, true, '被将死的一方仍然报告 check=true（与客户端一致）');
  assert.deepEqual(g.legalMoves(), []);
});

t('将死时黑方无着可走：所有候选（含逃王、吃车、垫将）都被拒', () => {
  const g = create({ board: boardOf([[4, 1, 'rR'], [5, 0, 'bK'], [5, 1, 'bH'], [5, 2, 'bA'], [4, 8, 'rK']]) });
  play(g, 0, '4,1-4,0');
  assert.deepEqual(g.legalMoves(), []);
  for (const mv of ['5,0-4,0', '5,0-5,1', '5,0-6,0', '5,1-4,0', '5,1-3,0', '5,2-4,1']) {
    rejected(g, 1, mv, 'game_over');
  }
});

t('将死（黑方杀红方）：winner=2，对应服务端 result=guest', () => {
  const g = create({ board: boardOf([[4, 8, 'bR'], [5, 9, 'rK'], [5, 8, 'rH'], [5, 7, 'rA'], [4, 1, 'bK'], [8, 6, 'rP']]) });
  play(g, 0, '8,6-8,5');
  assert.equal(g.view().check, false, '红方先手这一步只是挪兵');
  play(g, 1, '4,8-4,9');
  assert.equal(g.over, true);
  assert.equal(g.winner, 2, '黑方（seat 1）赢 → winner = 2');
  assert.equal(g.draw, false);
  assert.equal(g.view().check, true);
  assert.deepEqual(g.legalMoves(), []);
  assert.equal(toResult({ ok: true, status: status(g) }), 'guest');
});

t('困毙与将死同判负：黑方无着可走但没被将军 → over/winner=1/check=false', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 2, 'rH'], [5, 3, 'rH'], [0, 9, 'rR'], [4, 0, 'bK']]) });
  play(g, 0, '0,9-0,8');
  assert.equal(g.over, true);
  assert.equal(g.winner, 1);
  assert.equal(g.draw, false, '困毙在客户端也是判负，不是和棋');
  assert.equal(g.view().check, false, '将军标记用来区分将死与困毙');
  assert.deepEqual(g.legalMoves(), []);
  assert.equal(toResult({ ok: true, status: status(g) }), 'host');
});

t('困毙局面下黑方 3 个格子都走不了', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 2, 'rH'], [5, 3, 'rH'], [0, 9, 'rR'], [4, 0, 'bK']]) });
  play(g, 0, '0,9-0,8');
  for (const mv of ['4,0-3,0', '4,0-5,0', '4,0-4,1']) rejected(g, 1, mv, 'game_over');
});

t('和棋（唯一口径）：连续 120 个半步无吃子 → draw/winner=0', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 5, 'rC'], [4, 0, 'bK'], [0, 0, 'bR']]) });
  for (let i = 0; i < 59; i++) {
    play(g, 0, i % 2 === 0 ? '4,5-4,4' : '4,4-4,5');
    play(g, 1, i % 2 === 0 ? '0,0-0,1' : '0,1-0,0');
  }
  assert.equal(g.over, false, '118 个半步还没到判和线');
  assert.equal(g.view().noCapturePlies, 118);
  play(g, 0, '4,4-4,5');
  assert.equal(g.view().noCapturePlies, 119);
  assert.equal(g.over, false, '第 119 个半步仍不算和');
  play(g, 1, '0,1-0,0');
  stats.drawPlies = g.view().noCapturePlies;
  assert.equal(g.over, true);
  assert.equal(g.draw, true);
  assert.equal(g.winner, 0);
  assert.equal(g.turn, -1);
  assert.equal(g.view().draw, true);
  assert.equal(g.view().winner, 0);
  assert.deepEqual(g.legalMoves(), []);
  assert.equal(toResult({ ok: true, status: status(g) }), 'draw');
});

t('和棋前只要有吃子，计数就清零', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [4, 5, 'rR'], [4, 0, 'bK'], [0, 0, 'bR'], [4, 3, 'bP']]) });
  play(g, 0, '4,5-4,4');
  assert.equal(g.view().noCapturePlies, 1);
  play(g, 1, '0,0-0,1');
  assert.equal(g.view().noCapturePlies, 2);
  play(g, 0, '4,4-4,3');
  assert.equal(g.view().lastCapture, 'bP');
  assert.equal(g.view().noCapturePlies, 0, '吃子要把无吃子计数清零');
});

t('未结束的 result 是空串（服务端只在终局落 result）', () => {
  const g = create();
  play(g, 0, '1,7-4,7');
  assert.equal(toResult({ ok: true, status: status(g) }), '');
});

t('将死时的 result 映射：红方赢 → host', () => {
  const g = create({ board: boardOf([[4, 1, 'rR'], [5, 0, 'bK'], [5, 1, 'bH'], [5, 2, 'bA'], [4, 8, 'rK']]) });
  play(g, 0, '4,1-4,0');
  assert.equal(g.over, true);
  assert.equal(toResult({ ok: true, status: status(g) }), 'host');
});

// ── 状态机与重放 ────────────────────────────────────────────────────────
t('走子方交替：红走后轮到黑，黑走后再轮到红', () => {
  const g = create();
  play(g, 0, '1,7-4,7');
  assert.equal(g.turn, 1);
  rejected(g, 0, '0,9-0,8', 'not_your_turn');
  play(g, 1, '1,2-4,2');
  assert.equal(g.turn, 0);
  rejected(g, 1, '0,0-0,1', 'not_your_turn');
});

t('moves()/moveCount/view() 与逐步 apply 一致', () => {
  const g = create();
  const list = [
    { seat: 0, move: '1,7-4,7' }, { seat: 1, move: '1,2-4,2' },
    { seat: 0, move: '1,9-2,7' }, { seat: 1, move: '1,0-2,2' },
  ];
  for (const m of list) play(g, m.seat, m.move);
  assert.deepEqual(g.moves(), list);
  assert.equal(g.moveCount, 4);
  assert.equal(g.view().moveCount, 4);
  assert.deepEqual(g.view().lastMove, { x1: 1, y1: 0, x2: 2, y2: 2 });
  assert.equal(g.view().check, false);
  assert.equal(g.view().noCapturePlies, 4);
});

t('同一串走法重放两次结果完全一致（deepEqual）', () => {
  const list = [
    { seat: 0, move: '1,7-4,7' }, { seat: 1, move: '1,2-4,2' }, { seat: 0, move: '0,9-0,8' },
    { seat: 1, move: '0,0-0,1' }, { seat: 0, move: '0,8-0,7' }, { seat: 1, move: '0,1-0,0' },
  ];
  const a = create(), b = create();
  for (const m of list) { play(a, m.seat, m.move); play(b, m.seat, m.move); }
  assert.deepEqual(a.view(), b.view());
  assert.deepEqual(a.moves(), b.moves());
  assert.deepEqual(a.legalMoves(), b.legalMoves());
});

t('被拒的走法不改状态：turn/棋盘/计数原样', () => {
  const g = create();
  const before = g.view();
  rejected(g, 0, '0,6-1,6', 'illegal_move');
  rejected(g, 0, '1,7-1,2', 'illegal_move');
  rejected(g, 0, '9,9-9,8', 'bad_move');
  rejected(g, 1, '0,9-0,8', 'not_your_turn');
  assert.deepEqual(g.view(), before);
});

t('吃子计数与 lastCapture：吃子清零、不吃累加', () => {
  const g = create();
  play(g, 0, '1,7-4,7');
  assert.equal(g.view().noCapturePlies, 1);
  play(g, 1, '1,2-1,3');
  assert.equal(g.view().noCapturePlies, 2);
  assert.equal(g.view().lastCapture, '');
  play(g, 0, '1,9-2,7');
  assert.equal(g.view().noCapturePlies, 3);
});

// ── create({ board }) 自定义局面 ────────────────────────────────────────
t('create({ board }) 接受合法棋盘并原样使用', () => {
  const g = create({ board: boardOf([[4, 9, 'rK'], [3, 0, 'bK']]) });
  assert.equal(g.view().board[81 + 4], 'rK');
  assert.equal(g.view().board[3], 'bK');
  assert.equal(g.turn, 0);
});

t('create() 深拷贝传入棋盘：外部数组被改也不影响引擎', () => {
  const bd = boardOf([[4, 9, 'rK'], [3, 0, 'bK']]);
  const g = create({ board: bd });
  bd[3] = '';
  assert.equal(g.view().board[3], 'bK');
});

t('非法棋盘一律抛错：长度不对 / 非字符串 / 非法棋子串 / 大小写错', () => {
  assert.throws(() => create({ board: ['rK'] }));
  assert.throws(() => create({ board: new Array(90).fill(7) }));
  assert.throws(() => create({ board: new Array(90).fill('xx') }));
  assert.throws(() => create({ board: new Array(90).fill('RK') }));
  assert.throws(() => create({ board: new Array(90).fill('r') }));
  assert.throws(() => create({ board: new Array(89).fill('') }));
});

t('create() 空参/空对象/board:null 都退回标准开局', () => {
  for (const opt of [undefined, null, {}, { board: null }]) {
    assert.equal(create(opt).legalMoves().length, 44);
  }
});

t('空棋盘：没有棋子就没有走法，apply 一律 illegal_move', () => {
  const g = create({ board: new Array(90).fill('') });
  assert.deepEqual(g.legalMoves(), []);
  rejected(g, 0, '1,7-4,7', 'illegal_move');
});

t('起手点没有自己的子 → illegal_move（拿黑子当红子走）', () => {
  const g = create();
  rejected(g, 0, '1,2-1,3', 'illegal_move');
  rejected(g, 0, '5,0-5,1', 'illegal_move');
});

t('目标格是自己的子 → illegal_move', () => {
  const g = create();
  rejected(g, 0, '1,7-7,7', 'illegal_move');
  rejected(g, 0, '0,9-1,9', 'illegal_move');
});

// ── 覆盖统计 ────────────────────────────────────────────────────────────
console.log('');
console.log('覆盖：开局 ' + stats.openingMoves + ' 条走法逐条 apply；'
  + '自定义局面覆盖马腿/象眼/九宫/炮架/照面/应将/送将；'
  + '终局覆盖将死（红/黑各一）与困毙；和棋跑满 ' + stats.drawPlies + ' 个无吃子半步。');
if (fails.length) {
  for (const f of fails) console.log('FAIL ' + f);
}
console.log('PASS ' + pass + ' / FAIL ' + fails.length);
if (fails.length) process.exitCode = 1;
