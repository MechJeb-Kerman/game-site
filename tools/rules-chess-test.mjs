/**
 * 国际象棋服务端裁判自测（node tools/rules-chess-test.mjs）。
 *
 * 零依赖，只 import node:assert/strict 与被测的 ../src/rules/chess.js。
 * src/rules/index.js 这次不注册 chess（合并时统一注册，免得与别的棋类撞车），
 * 所以这里自带一份 index.js 的等价薄壳（createGame / judge / toResult 逐条照抄
 * src/rules/index.js:63-175 的口径：bad_move → game_over → not_your_turn → illegal_move），
 * 用来验证 chess.js 满足 index.js 要求的实例契约；另有直接调实例方法的用例。
 */
import assert from 'node:assert/strict';
import { META, create, parseMove, encodeMove, nameSq } from '../src/rules/chess.js';

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ' —— ' + (e && e.message ? e.message : String(e))); }
}

/* ===================== index.js 的等价薄壳（不改 index.js，这里照抄口径） ===================== */
const ERRORS = ['bad_move', 'game_over', 'not_your_turn', 'illegal_move', 'bad_game'];
const MAX_MOVE_LEN = 256;
const isSeat = (seat) => seat === 0 || seat === 1;
const statusOf = (g) => ({ over: !!g.over, winner: g.over ? g.winner : 0, draw: g.over ? !!g.draw : false });
function fail(error, inst) { return { ok: false, error: error, status: statusOf(inst) }; }

function createGame(options) {
  const inst = create(options || {});
  return {
    slug: 'chess',
    meta: META,
    apply(input) {
      if (!input || typeof input !== 'object') return fail('bad_move', inst);
      const seat = input.seat;
      if (!isSeat(seat)) return fail('bad_move', inst);
      const raw = input.move;
      let move;
      if (typeof raw === 'string') move = raw;
      else if (typeof raw === 'number' && Number.isFinite(raw)) move = String(raw);
      else return fail('bad_move', inst);
      if (move.length === 0 || move.length > MAX_MOVE_LEN) return fail('bad_move', inst);
      if (inst.over) return fail('game_over', inst);
      if (seat !== inst.turn) return fail('not_your_turn', inst);
      const err = inst.apply(seat, move);
      if (err) return fail(ERRORS.indexOf(err) >= 0 ? err : 'illegal_move', inst);
      return { ok: true, status: statusOf(inst) };
    },
    view: () => inst.view(),
    legalMoves: () => inst.legalMoves(),
    moves: () => inst.moves()
  };
}

function judge(moves) {
  if (!Array.isArray(moves)) {
    return { ok: false, error: 'bad_move', index: -1, over: false, winner: 0, draw: false, moveCount: 0, view: null };
  }
  const g = createGame();
  for (let i = 0; i < moves.length; i++) {
    const item = moves[i] && typeof moves[i] === 'object' ? moves[i] : {};
    const r = g.apply({ seat: item.seat, move: item.move });
    if (!r.ok) {
      const v = g.view();
      return { ok: false, error: r.error, index: i, over: v.over, winner: v.winner, draw: v.draw, moveCount: v.moveCount, view: v };
    }
  }
  const v = g.view();
  return { ok: true, error: '', index: -1, over: v.over, winner: v.winner, draw: v.draw, moveCount: v.moveCount, view: v };
}

function toResult(res) {
  if (!res || !res.ok) return '';
  const s = res.status || res;
  if (!s.over) return '';
  if (s.draw) return 'draw';
  if (s.winner === 1) return 'host';
  if (s.winner === 2) return 'guest';
  return '';
}

/* ===================== 小工具 ===================== */
function play(g, seat, move) {
  const r = g.apply({ seat: seat, move: move });
  assert.ok(r.ok, move + ' 被拒：' + r.error);
  return r.status;
}
/** 交替座位走一串（白先手，所以第 i 手的座位就是 i % 2） */
function run(g, list) { list.forEach((mv, i) => play(g, i % 2, mv)); return g; }
function seq(list) { return list.map((mv, i) => ({ seat: i % 2, move: mv })); }
function rejected(g, seat, move) {
  const r = g.apply({ seat: seat, move: move });
  assert.ok(!r.ok, move + ' 本应被拒，却通过了');
  return r.error;
}
function from(g, sq) { return g.legalMoves().filter((m) => m.slice(0, 2) === sq).sort(); }
const empty = () => new Array(64).fill('');
function lay(spec) {
  const b = empty();
  for (const k of Object.keys(spec)) {
    const i = nameSq(k);
    assert.ok(i >= 0, 'lay(): 非法格名 ' + k);
    b[i] = spec[k];
  }
  return b;
}
/** 用局面构造器摆一个中局（options 见 chess.js 的 create 文档） */
function pos(spec, options) {
  return createGame(Object.assign({ board: lay(spec) }, options || {}));
}

/* ===================== 1. 契约与走法编码 ===================== */
t('META 契约：slug/seats/moveFormat/note', () => {
  assert.equal(META.slug, 'chess');
  assert.equal(META.seats, 2);
  assert.equal(typeof META.moveFormat, 'string');
  assert.ok(META.moveFormat.includes('e2e4'), 'moveFormat 要能看出走法形状');
  assert.ok(META.moveFormat.includes('q/r/b/n'), 'moveFormat 要写清升变子');
  assert.ok(META.note.length > 20, 'note 太短');
  assert.equal(typeof META.create, 'undefined', 'META 只放元信息');
});

t('实例契约：字段与方法齐全', () => {
  const g = createGame();
  assert.equal(g.slug, 'chess');
  assert.equal(g.meta, META);
  for (const k of ['apply', 'legalMoves', 'moves', 'view']) assert.equal(typeof g[k], 'function', k);
  const inst = create();
  assert.equal(inst.slug, 'chess');
  assert.equal(inst.turn, 0, '白先手 = seat 0');
  assert.equal(inst.over, false);
  assert.equal(inst.winner, 0);
  assert.equal(inst.draw, false);
});

t('走法编码往返：e2e4 / e7e8q / e1g1 / e1c1', () => {
  for (const code of ['e2e4', 'e7e8q', 'e7e8r', 'e7e8b', 'e7e8n', 'e1g1', 'e1c1', 'a7a8q']) {
    const m = parseMove(code);
    assert.ok(m, code + ' 解析失败');
    assert.equal(encodeMove(m), code, code + ' 往返不一致');
  }
});

t('parseMove 收紧：长度必须正好 4 或 5、格子必须合法', () => {
  assert.equal(parseMove('e2e4zz'), null, '客户端只读前 5 字符，服务端必须拒绝尾部垃圾');
  assert.equal(parseMove('e2e4z'), null, '第 5 位不是升变子');
  assert.equal(parseMove('e2e4k'), null, '不能升变为王');
  assert.equal(parseMove('e2e'), null);
  assert.equal(parseMove('e2e45'), null);
  assert.equal(parseMove('e9e4'), null);
  assert.equal(parseMove('e2i4'), null);
  assert.equal(parseMove('e2e2'), null, '起点终点不能相同');
  assert.equal(parseMove('E2E4'), null, '格名必须小写（与客户端 nameSq 一致）');
  assert.equal(parseMove(''), null);
  assert.equal(parseMove(null), null);
  assert.equal(parseMove(1234), null);
});

t('升变子大小写与首尾空白：e7e8Q → e7e8q', () => {
  assert.equal(parseMove('e7e8Q').promo, 'q', '客户端 findMove 也把第 5 位转小写');
  assert.equal(encodeMove(parseMove('e7e8Q')), 'e7e8q');
  assert.equal(parseMove('  e2e4  ').from, nameSq('e2'), '客户端 findMove 先 trim');
  assert.equal(encodeMove(parseMove(' e2e4 ')), 'e2e4');
  assert.equal(parseMove('e7e8n').promo, 'n');
  assert.equal(parseMove('e2e4').promo, '');
});

t('格名口径：a1=0、h1=7、a8=56、h8=63', () => {
  assert.equal(encodeMove({ from: nameSq('a1'), to: nameSq('h8'), promo: '' }), 'a1h8');
  assert.equal(encodeMove({ from: nameSq('e2'), to: nameSq('e4'), promo: '' }), 'e2e4');
  assert.equal(nameSq('a1'), 0);
  assert.equal(nameSq('h1'), 7);
  assert.equal(nameSq('a8'), 56);
  assert.equal(nameSq('h8'), 63);
  assert.equal(nameSq('a9'), -1);
  assert.equal(nameSq('i1'), -1);
  assert.equal(nameSq(''), -1);
  assert.equal(nameSq('a'), -1);
});

/* ===================== 2. 开局与兵 ===================== */
t('开局 20 个合法走法：16 个兵步 + 4 个马步', () => {
  const g = createGame();
  assert.deepEqual(g.legalMoves().sort(), [
    'a2a3', 'a2a4', 'b1a3', 'b1c3', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
    'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g1f3', 'g1h3', 'g2g3', 'g2g4', 'h2h3', 'h2h4'
  ]);
  assert.equal(g.legalMoves().length, 20);
});

t('开局：象/车/后被己方兵堵死，一个走法都生成不出来', () => {
  const g = createGame();
  for (const sq of ['c1', 'f1', 'a1', 'h1', 'd1', 'e1']) {
    assert.deepEqual(from(g, sq), [], sq + ' 位的子不该有走法');
  }
  const v = g.view();
  assert.equal(v.turn, 0);
  assert.equal(v.over, false);
  assert.equal(v.winner, 0);
  assert.equal(v.draw, false);
  assert.equal(v.moveCount, 0);
  assert.equal(v.check, false, '开局没人被将');
  assert.equal(v.fullmove, 1);
  assert.equal(v.halfmove, 0);
  assert.equal(v.board[nameSq('e1')], 'K');
  assert.equal(v.board[nameSq('e8')], 'k');
  assert.equal(v.board[nameSq('a2')], 'P');
  assert.equal(v.board[nameSq('a7')], 'p');
  assert.equal(v.board[nameSq('d4')], '');
});

t('兵首步：单步双步都行，三格非法', () => {
  const g = createGame();
  const list = g.legalMoves();
  for (const mv of ['a2a3', 'a2a4', 'h2h3', 'h2h4', 'e2e4']) assert.ok(list.includes(mv), mv + ' 应合法');
  assert.equal(rejected(g, 0, 'a2a5'), 'illegal_move');
  assert.equal(rejected(g, 0, 'e2e5'), 'illegal_move');
});

t('兵双步只限首步：a2a3 之后再 a3a5 非法', () => {
  const g = createGame();
  run(g, ['a2a3', 'a7a6']);
  assert.deepEqual(from(g, 'a3'), ['a3a4'], 'a3 上的兵只剩一步');
  assert.equal(rejected(g, 0, 'a3a5'), 'illegal_move');
  assert.equal(rejected(g, 0, 'a3a2'), 'illegal_move', '兵不能后退');
});

t('兵只能斜前吃子：直吃与吃空都非法', () => {
  const g = pos({ b1: 'K', d4: 'P', d5: 'p', e5: 'p', d8: 'k' });
  assert.ok(g.legalMoves().includes('d4e5'), '斜前有敌子可吃');
  assert.equal(rejected(g, 0, 'd4d5'), 'illegal_move', '正前方被敌子挡住不能吃');
  assert.equal(rejected(g, 0, 'd4c5'), 'illegal_move', '斜前方是空格');
  assert.equal(rejected(g, 0, 'd4e4'), 'illegal_move', '兵不能横走');
});

t('不能穿子：象被 g2 挡、车被 a2 挡、后被 d2 挡', () => {
  const g = createGame();
  run(g, ['e2e4', 'e7e5']);
  assert.equal(rejected(g, 0, 'f1h3'), 'illegal_move', 'f1-h3 要穿过 g2 的己方兵');
  assert.equal(rejected(g, 0, 'a1a3'), 'illegal_move', 'a1-a3 要穿过 a2 的己方兵');
  assert.equal(rejected(g, 0, 'd1d3'), 'illegal_move', 'd1-d3 要穿过 d2 的己方兵');
  play(g, 0, 'f1a6');
  assert.equal(g.view().board[nameSq('a6')], 'B', 'e2 让开后象能走到 a6');
});

t('马可以跳子：开局 Ng1-f3 合法', () => {
  const g = createGame();
  play(g, 0, 'g1f3');
  const b = g.view().board;
  assert.equal(b[nameSq('f3')], 'N');
  assert.equal(b[nameSq('g1')], '');
});

/* ===================== 3. 各子的走法范围（构造局面） ===================== */
t('车：a1 车横竖到底，遇己方王停', () => {
  const g = pos({ e1: 'K', a1: 'R', e8: 'k' });
  assert.deepEqual(from(g, 'a1'), ['a1a2', 'a1a3', 'a1a4', 'a1a5', 'a1a6', 'a1a7', 'a1a8', 'a1b1', 'a1c1', 'a1d1']);
});

t('象：d4 象两条对角线共 13 步', () => {
  const g = pos({ e1: 'K', d4: 'B', e8: 'k' });
  const list = from(g, 'd4');
  assert.equal(list.length, 13);
  for (const mv of ['d4a1', 'd4h8', 'd4g1', 'd4a7', 'd4e3']) assert.ok(list.includes(mv), mv);
  assert.ok(!list.includes('d4d5'), '象不能走直线');
});

t('后：d4 后 = 车 14 步 + 象 13 步 = 27 步', () => {
  const g = pos({ e1: 'K', d4: 'Q', e8: 'k' });
  const list = from(g, 'd4');
  assert.equal(list.length, 27);
  for (const mv of ['d4h4', 'd4a4', 'd4d8', 'd4d1', 'd4a1', 'd4h8', 'd4g1', 'd4e3']) assert.ok(list.includes(mv), mv);
});

t('王：e1 王 5 步；不能走进对方王的邻格', () => {
  assert.deepEqual(from(pos({ e1: 'K', e8: 'k' }), 'e1'), ['e1d1', 'e1d2', 'e1e2', 'e1f1', 'e1f2']);
  /* 黑王在 e3 时，d2/e2/f2 都是它的邻格 */
  assert.deepEqual(from(pos({ e1: 'K', e3: 'k' }), 'e1'), ['e1d1', 'e1f1']);
});

t('送王非法：钉住的车不能离开直线', () => {
  const g = pos({ e1: 'K', e2: 'R', e8: 'r', h8: 'k' });
  assert.equal(rejected(g, 0, 'e2a2'), 'illegal_move', '离开 e 线就暴露自己的王');
  assert.equal(rejected(g, 0, 'e2b2'), 'illegal_move');
  play(g, 0, 'e2e3');
  assert.equal(g.view().board[nameSq('e3')], 'R');
});

/* ===================== 4. 王车易位 ===================== */
t('易位两侧都成立：王车在原位、中间空、都没被攻击', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k' });
  const list = from(g, 'e1');
  assert.deepEqual(list, ['e1c1', 'e1d1', 'e1d2', 'e1e2', 'e1f1', 'e1f2', 'e1g1']);
  assert.ok(g.legalMoves().includes('e1g1'));
  assert.ok(g.legalMoves().includes('e1c1'));
});

t('王翼易位执行：王到 g1、车到 f1、原位清空、易位权全丢', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', a8: 'r', h8: 'r' });
  play(g, 0, 'e1g1');
  const v = g.view();
  assert.equal(v.board[nameSq('g1')], 'K');
  assert.equal(v.board[nameSq('f1')], 'R');
  assert.equal(v.board[nameSq('e1')], '');
  assert.equal(v.board[nameSq('h1')], '');
  assert.deepEqual(v.castling, { wk: false, wq: false, bk: true, bq: true });
  assert.equal(v.last.code, 'e1g1');
  assert.equal(v.turn, 1);
});

t('后翼易位执行：王到 c1、车到 d1', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k' });
  play(g, 0, 'e1c1');
  const v = g.view();
  assert.equal(v.board[nameSq('c1')], 'K');
  assert.equal(v.board[nameSq('d1')], 'R');
  assert.equal(v.board[nameSq('a1')], '');
  assert.equal(v.board[nameSq('e1')], '');
});

t('易位不成立：王动过（哪怕走回原位）', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k' });
  run(g, ['e1f1', 'e8d8', 'f1e1', 'd8e8']);
  assert.ok(!g.legalMoves().includes('e1g1'), '王动过就不能再易位');
  assert.ok(!g.legalMoves().includes('e1c1'));
  assert.equal(g.view().castling.wk, false);
  assert.equal(g.view().castling.wq, false);
});

t('易位不成立：车动过（h1 车走回来）', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k' });
  run(g, ['h1h2', 'e8d8', 'h2h1', 'd8e8']);
  assert.ok(!g.legalMoves().includes('e1g1'), '王翼车动过');
  assert.ok(g.legalMoves().includes('e1c1'), '后翼车没动过，仍可易位');
});

t('易位不成立：车被吃也丢权', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', b2: 'b' }, { turn: 1 });
  play(g, 1, 'b2a1');
  const v = g.view();
  assert.equal(v.board[nameSq('a1')], 'b');
  assert.equal(v.castling.wq, false, 'a1 的车被吃，后翼易位权作废');
  assert.ok(!g.legalMoves().includes('e1c1'));
  assert.ok(g.legalMoves().includes('e1g1'), '王翼没受影响');
});

t('易位不成立：中间有子', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', f1: 'B', d1: 'Q', e8: 'k' });
  assert.ok(!g.legalMoves().includes('e1g1'), 'f1 有子');
  assert.ok(!g.legalMoves().includes('e1c1'), 'd1 有子');
});

t('易位不成立：王经过的 f1 被攻击', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', f8: 'r' });
  assert.ok(!g.legalMoves().includes('e1g1'), 'f8 车控制 f 线');
  assert.ok(g.legalMoves().includes('e1c1'), '后翼不受影响');
});

t('易位不成立：王到达的 g1 被攻击', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', g8: 'r' });
  assert.ok(!g.legalMoves().includes('e1g1'), 'g8 车控制 g 线');
});

t('易位口径：后翼 d1 被攻击不能易位，b1 被攻击可以（与 FIDE 一致，车不受保护）', () => {
  const bad = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', d8: 'r' });
  assert.ok(!bad.legalMoves().includes('e1c1'), '王经过 d1，d1 不能被攻击');
  const ok = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', b8: 'r' });
  assert.ok(ok.legalMoves().includes('e1c1'), 'b1 只过车，被攻击也应允许');
});

t('易位不成立：王正被将军', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', e7: 'r' });
  const list = g.legalMoves();
  assert.ok(!list.includes('e1g1'));
  assert.ok(!list.includes('e1c1'));
  assert.deepEqual(from(g, 'e1'), ['e1d1', 'e1d2', 'e1f1', 'e1f2'], '被将时只能逃王');
  assert.equal(g.view().check, true);
});

/* ===================== 5. 吃过路兵 ===================== */
t('吃过路兵：对方兵首步两格后立刻可吃', () => {
  const g = createGame();
  run(g, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  const list = g.legalMoves();
  assert.ok(list.includes('e5d6'), '可以吃过路兵');
  assert.ok(list.includes('e5e6'), '也可以直进');
  assert.equal(g.view().ep, nameSq('d6'), 'ep 目标格 = d6');
});

t('吃过路兵执行：d5 的兵消失、白兵落到 d6', () => {
  const g = createGame();
  run(g, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  play(g, 0, 'e5d6');
  const v = g.view();
  assert.equal(v.board[nameSq('d6')], 'P');
  assert.equal(v.board[nameSq('d5')], '');
  assert.equal(v.board[nameSq('e5')], '');
  assert.equal(v.last.code, 'e5d6');
  assert.equal(v.ep, -1, '吃过路兵用完即清');
  assert.equal(v.turn, 1);
});

t('吃过路兵只在紧接的一手有效：隔一手就没了', () => {
  const g = createGame();
  run(g, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'g1f3', 'a6a5']);
  assert.equal(g.view().ep, -1);
  assert.ok(!g.legalMoves().includes('e5d6'));
  assert.equal(rejected(g, 0, 'e5d6'), 'illegal_move');
  assert.ok(g.legalMoves().includes('e5e6'));
});

t('吃过路兵会暴露自己的王时非法（同排钉子）', () => {
  const g = pos({ a5: 'K', e5: 'P', d5: 'p', h5: 'r', e8: 'k' }, { ep: nameSq('d6') });
  assert.ok(!g.legalMoves().includes('e5d6'), 'd6 吃完后 h5 车照到 a5 王');
  assert.ok(g.legalMoves().includes('e5e6'), '直进时 d5 的兵仍然挡着');
});

/* ===================== 6. 兵升变 ===================== */
t('升变四选一：四个都在 legalMoves，普通一步与升王都非法', () => {
  const g = pos({ e1: 'K', e7: 'P', h8: 'k' });
  assert.deepEqual(from(g, 'e7'), ['e7e8b', 'e7e8n', 'e7e8q', 'e7e8r']);
  assert.equal(rejected(g, 0, 'e7e8'), 'illegal_move', '到底线必须带升变子');
  assert.equal(rejected(g, 0, 'e7e8k'), 'illegal_move', '不能升变为王');
});

t('升变执行与编码往返：e7e8n → 盘上是 N、moves() 记 e7e8n', () => {
  const g = pos({ e1: 'K', e7: 'P', h8: 'k', a7: 'p' });
  play(g, 0, 'e7e8n');
  const v = g.view();
  assert.equal(v.board[nameSq('e8')], 'N');
  assert.equal(v.board[nameSq('e7')], '');
  assert.equal(v.last.code, 'e7e8n');
  assert.deepEqual(g.moves(), [{ seat: 0, move: 'e7e8n' }]);
  assert.equal(v.turn, 1);
});

t('升变为后并将军：e7e8q 后黑被将，只能逃到 h7', () => {
  const g = pos({ e1: 'K', e7: 'P', h8: 'k' });
  play(g, 0, 'e7e8q');
  const v = g.view();
  assert.equal(v.board[nameSq('e8')], 'Q');
  assert.equal(v.check, true, 'e8 的后沿第 8 横线照到 h8');
  assert.ok(g.legalMoves().includes('h8h7'));
  assert.equal(rejected(g, 1, 'h8g8'), 'illegal_move', 'g8 仍在第 8 横线上');
});

t('吃子升变：f7g8q / f7g8n 都合法，吃完盘上换子', () => {
  const g = pos({ e1: 'K', f7: 'P', g8: 'r', h8: 'k' });
  const list = g.legalMoves();
  for (const mv of ['f7g8q', 'f7g8n', 'f7g8r', 'f7g8b']) assert.ok(list.includes(mv), mv);
  play(g, 0, 'f7g8q');
  const b = g.view().board;
  assert.equal(b[nameSq('g8')], 'Q');
  assert.equal(b[nameSq('f7')], '');
});

/* ===================== 7. 将军 / 将死 / 逼和 ===================== */
t('被将军时必须应将：无关的兵步非法，逃王合法', () => {
  const g = pos({ e1: 'K', a1: 'Q', h8: 'k', a7: 'p' }, { turn: 1 });
  assert.equal(g.view().check, true, '黑被 a1 后沿对角线将');
  assert.equal(rejected(g, 1, 'a7a6'), 'illegal_move', '不解决将军的走法一律非法');
  play(g, 1, 'h8g8');
  assert.equal(g.view().check, false);
  assert.equal(g.view().board[nameSq('g8')], 'k');
});

t('将军标记：白 Qd1-h5 之后不是将军，Qxe5 才是', () => {
  const g = createGame();
  run(g, ['e2e4', 'e7e5', 'd1h5', 'b8c6']);
  assert.equal(g.view().check, false, 'Qh5 被 f7 兵挡着');
  play(g, 0, 'h5e5');
  const v = g.view();
  assert.equal(v.check, true, 'Qxe5 沿 e 线照到 e8');
  assert.equal(v.halfmove, 0, '吃子清零半回合计数');
});

t('将死：后 + 王的基本杀（Qg7#）', () => {
  const g = pos({ f6: 'K', g6: 'Q', h8: 'k' });
  assert.ok(g.legalMoves().includes('g6g7'));
  const st = play(g, 0, 'g6g7');
  assert.deepEqual(st, { over: true, winner: 1, draw: false });
  const v = g.view();
  assert.equal(v.kind, 'mate');
  assert.equal(v.board[nameSq('g7')], 'Q');
  assert.equal(v.turn, -1, '终局后没有行棋方');
  assert.deepEqual(g.legalMoves(), [], '终局后没有合法走法');
  assert.deepEqual(g.moves(), [{ seat: 0, move: 'g6g7' }]);
});

t('将死：学者将杀（judge 全串重放，winner 1 → host）', () => {
  const r = judge(seq(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']));
  assert.equal(r.ok, true, r.error + ' @' + r.index);
  assert.equal(r.over, true);
  assert.equal(r.winner, 1);
  assert.equal(r.draw, false);
  assert.equal(r.moveCount, 7);
  assert.equal(r.view.kind, 'mate');
  assert.equal(toResult(r), 'host');
});

t('将死：愚人将杀（黑胜，winner 2 → guest）', () => {
  const r = judge(seq(['f2f3', 'e7e5', 'g2g4', 'd8h4']));
  assert.equal(r.ok, true, r.error + ' @' + r.index);
  assert.equal(r.over, true);
  assert.equal(r.winner, 2);
  assert.equal(r.draw, false);
  assert.equal(r.view.kind, 'mate');
  assert.equal(toResult(r), 'guest');
});

t('逼和（stalemate）：Qg6 之后黑无子可动却没被将', () => {
  const g = pos({ f7: 'K', g5: 'Q', h8: 'k' });
  const st = play(g, 0, 'g5g6');
  assert.deepEqual(st, { over: true, winner: 0, draw: true });
  const v = g.view();
  assert.equal(v.kind, 'stale');
  assert.equal(v.check, false, '逼和不是将军');
  assert.deepEqual(g.legalMoves(), []);
  assert.equal(toResult({ ok: true, status: st }), 'draw');
});

/* ===================== 8. 和棋：50 回合 / 三次重复 / 子力不足 ===================== */
t('50 回合规则：半回合计数 99 时走一步非兵非吃子即判和', () => {
  const g = pos({ e1: 'K', h1: 'R', e8: 'k', a8: 'r' }, { half: 99 });
  assert.equal(g.view().halfmove, 99);
  const st = play(g, 0, 'h1h2');
  assert.deepEqual(st, { over: true, winner: 0, draw: true });
  assert.equal(g.view().kind, 'fifty');
  assert.equal(g.view().halfmove, 100);
});

t('50 回合规则优先于子力不足（只剩双方王时 kind 仍是 fifty）', () => {
  const g = pos({ e1: 'K', e8: 'k' }, { half: 99 });
  play(g, 0, 'e1d1');
  assert.equal(g.view().over, true);
  assert.equal(g.view().kind, 'fifty');
});

t('半回合计数：兵动清零、其余累加', () => {
  const g = createGame();
  assert.equal(g.view().halfmove, 0);
  play(g, 0, 'e2e4');
  assert.equal(g.view().halfmove, 0, '兵动清零');
  play(g, 1, 'g8f6');
  assert.equal(g.view().halfmove, 1);
  play(g, 0, 'g1f3');
  assert.equal(g.view().halfmove, 2);
  assert.equal(g.view().fullmove, 3, '客户端 full 跟着白方走子递增：1.e4 Nf6 2.Nf3 之后是 3');
});

t('三次重复局面判和（马来回两次；两次时不判）', () => {
  const g = createGame();
  const cyc = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  run(g, cyc);                   /* 4 手：盘面回到开局，同一局面出现第 2 次 */
  assert.equal(g.view().over, false, '第 2 次出现同一局面还不该判和');
  run(g, cyc);                   /* 再 4 手：同一局面第 3 次 → 判和 */
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.kind, 'rep');
  assert.equal(v.draw, true);
  assert.equal(v.winner, 0);
  assert.equal(toResult({ ok: true, status: { over: v.over, winner: v.winner, draw: v.draw } }), 'draw');
});

t('三次重复对易位权敏感：车来回但不改权的局面要第 3 次才算和', () => {
  const g = pos({ e1: 'K', a1: 'R', h1: 'R', e8: 'k', a8: 'r', h8: 'r' });
  const cycle = ['h1h2', 'a8a7', 'h2h1', 'a7a8'];
  run(g, cycle.concat(cycle));   /* 8 手：盘面已回到初始，但双方各一辆车动过、易位权已失去 */
  assert.equal(g.view().over, false, '同一盘面只出现 2 次（含初始局面），不该判和');
  assert.deepEqual(g.view().castling, { wk: false, wq: true, bk: true, bq: false });
  run(g, ['h1h2', 'a8a7']);      /* 再 2 手：同一盘面 + 同一易位权第 3 次出现 → 判和 */
  assert.equal(g.view().over, true);
  assert.equal(g.view().kind, 'rep');
  assert.equal(g.view().draw, true);
});

t('子力不足：K vs K 判和（kind material）', () => {
  const g = pos({ e1: 'K', e8: 'k' }, { turn: 1 });
  const st = play(g, 1, 'e8d8');
  assert.deepEqual(st, { over: true, winner: 0, draw: true });
  assert.equal(g.view().kind, 'material');
});

t('子力不足：K+B vs K+B 判和；K+R vs K 不判和', () => {
  const g = pos({ e1: 'K', c1: 'B', e8: 'k', c8: 'b' }, { turn: 1 });
  play(g, 1, 'e8d8');
  assert.equal(g.view().over, true);
  assert.equal(g.view().kind, 'material');
  const r = pos({ e1: 'K', a1: 'R', e8: 'k' }, { turn: 1 });
  play(r, 1, 'e8d8');
  assert.equal(r.view().over, false, '一方有车，不能判子力不足');
});

t('子力不足不包括兵：K+P vs K 不判和', () => {
  const g = pos({ e1: 'K', a2: 'P', e8: 'k' }, { turn: 1 });
  play(g, 1, 'e8d8');
  assert.equal(g.view().over, false);
});

/* ===================== 9. index.js 薄壳口径（实例契约） ===================== */
t('薄壳：座位/走法形状不对 → bad_move', () => {
  let g = createGame();
  assert.equal(g.apply(null).error, 'bad_move');
  assert.equal(g.apply({ seat: 2, move: 'e2e4' }).error, 'bad_move');
  assert.equal(g.apply({ seat: -1, move: 'e2e4' }).error, 'bad_move');
  assert.equal(g.apply({ seat: '0', move: 'e2e4' }).error, 'bad_move', '座位必须是数字 0/1');
  assert.equal(g.apply({ seat: 0, move: '' }).error, 'bad_move');
  assert.equal(g.apply({ seat: 0, move: null }).error, 'bad_move');
  assert.equal(g.apply({ seat: 0, move: true }).error, 'bad_move');
  assert.equal(g.apply({ seat: 0, move: 'e2e4'.repeat(70) }).error, 'bad_move', '超过 MAX_MOVE_LEN');
  assert.equal(g.view().moveCount, 0, '被拒的手不能落盘');
});

t('薄壳：数字走法会被 index.js 转成字符串再判 → illegal_move', () => {
  const g = createGame();
  assert.equal(g.apply({ seat: 0, move: 1234 }).error, 'illegal_move');
  assert.equal(g.apply({ seat: 0, move: NaN }).error, 'bad_move');
});

t('薄壳：错座位 → not_your_turn；错座位非法手不改局面', () => {
  const g = createGame();
  assert.equal(g.apply({ seat: 1, move: 'e7e5' }).error, 'not_your_turn');
  assert.equal(g.apply({ seat: 0, move: 'e2e4' }).ok, true);
  assert.equal(g.apply({ seat: 0, move: 'e2e4' }).error, 'not_your_turn');
  assert.equal(g.apply({ seat: 1, move: 'e2e4' }).error, 'illegal_move', '座位对了但棋子不在那儿');
  assert.equal(g.view().moveCount, 1);
});

t('薄壳：status 形状（未结束 winner 0 / draw false）', () => {
  const g = createGame();
  assert.deepEqual(g.apply({ seat: 0, move: 'e2e4' }).status, { over: false, winner: 0, draw: false });
  assert.deepEqual(g.apply({ seat: 1, move: 'e7e5' }).status, { over: false, winner: 0, draw: false });
});

t('薄壳：终局后再落子 → game_over（优先于 not_your_turn）', () => {
  const g = pos({ f6: 'K', g6: 'Q', h8: 'k' });
  play(g, 0, 'g6g7');
  assert.equal(g.apply({ seat: 1, move: 'h8h7' }).error, 'game_over');
  assert.equal(g.apply({ seat: 0, move: 'g7g8' }).error, 'game_over');
  assert.equal(g.view().moveCount, 1);
});

t('judge：非法手定位到 index，错误码正确', () => {
  const bad = judge(seq(['e2e4', 'e7e5', 'f1h3']));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'illegal_move');
  assert.equal(bad.index, 2);
  assert.equal(bad.moveCount, 2, '非法手不算落子');
  const wrong = judge([{ seat: 0, move: 'e2e4' }, { seat: 0, move: 'd7d5' }]);
  assert.equal(wrong.error, 'not_your_turn');
  assert.equal(wrong.index, 1);
});

t('judge：合法但未结束的整串 → ok 且 over false', () => {
  const r = judge(seq(['e2e4', 'e7e5', 'g1f3', 'b8c6']));
  assert.equal(r.ok, true);
  assert.equal(r.over, false);
  assert.equal(r.winner, 0);
  assert.equal(r.draw, false);
  assert.equal(r.moveCount, 4);
  assert.equal(toResult(r), '', '没结束就没有 result 串');
});

t('judge 幂等：同一串重放两次得到同一局面（没有隐藏状态）', () => {
  const list = seq(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7']);
  const a = judge(list), b = judge(list);
  assert.deepEqual(a.view.board, b.view.board);
  assert.equal(a.view.fullmove, b.view.fullmove);
  assert.equal(a.view.halfmove, b.view.halfmove);
  assert.equal(a.winner, b.winner);
  assert.equal(a.view.kind, b.view.kind);
});

t('toResult：未结束或失败 → 空串；host/guest/draw 三种映射', () => {
  assert.equal(toResult({ ok: true, status: { over: false, winner: 0, draw: false } }), '');
  assert.equal(toResult({ ok: false, error: 'illegal_move', status: { over: true, winner: 1, draw: false } }), '');
  assert.equal(toResult(null), '');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 1, draw: false } }), 'host');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 2, draw: false } }), 'guest');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 0, draw: true } }), 'draw');
});

t('moves() 返回副本：外部改动不影响内部', () => {
  const g = createGame();
  run(g, ['e2e4']);
  const mv = g.moves();
  assert.deepEqual(mv, [{ seat: 0, move: 'e2e4' }]);
  mv[0].move = 'zzz';
  mv.push({ seat: 1, move: 'd7d5' });
  assert.deepEqual(g.moves(), [{ seat: 0, move: 'e2e4' }]);
});

t('直接调实例方法：apply 返回 null/错误码，错误码都在 index.js 的 ERRORS 里', () => {
  const g = create();
  assert.equal(g.apply(2, 'e2e4'), 'bad_move', '实例层也拦非法座位');
  assert.equal(g.apply(1, 'e7e5'), 'not_your_turn');
  assert.equal(g.apply(0, 'e2e9'), 'illegal_move');
  assert.equal(g.apply(0, 'zzz'), 'illegal_move');
  assert.equal(g.apply(0, 'e2e4'), null, '成功返回 null');
  assert.equal(g.turn, 1);
  assert.equal(g.over, false);
  assert.equal(g.apply(1, 'e7e5'), null);
  const seen = ['bad_move', 'not_your_turn', 'illegal_move'];
  for (const code of seen) assert.ok(ERRORS.includes(code), code + ' 不在 ERRORS 里');
  const mate = create({ board: lay({ f6: 'K', g6: 'Q', h8: 'k' }) });
  assert.equal(mate.apply(0, 'g6g7'), null);
  assert.equal(mate.over, true);
  assert.equal(mate.winner, 1);
  assert.equal(mate.draw, false);
  assert.equal(mate.turn, -1);
  const stale = create({ board: lay({ f7: 'K', g5: 'Q', h8: 'k' }) });
  assert.equal(stale.apply(0, 'g5g6'), null);
  assert.equal(stale.over, true);
  assert.equal(stale.draw, true);
  assert.equal(stale.winner, 0);
  assert.equal(stale.apply(0, 'a1a2'), 'game_over');
});

t('create({board}) 校验：长度、棋子码、双方王各一个', () => {
  assert.throws(() => create({ board: [] }), /长度 64/);
  assert.throws(() => create({ board: new Array(64).fill('') }), /白王|黑王/);
  const bad = lay({ e1: 'K', e8: 'k' });
  bad[0] = 'X';
  assert.throws(() => create({ board: bad }), /棋子码/);
  const twoK = lay({ e1: 'K', d1: 'K', e8: 'k' });
  assert.throws(() => create({ board: twoK }), /白王|黑王/);
  assert.doesNotThrow(() => create({ board: lay({ e1: 'K', e8: 'k' }) }));
});

/* ===================== 汇总 ===================== */
for (const f of fails) console.log('FAIL ' + f);
console.log('PASS ' + pass + ' / FAIL ' + fails.length + '（共 ' + (pass + fails.length) + ' 项）');
if (fails.length) process.exitCode = 1;
