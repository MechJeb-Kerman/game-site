/**
 * 联机棋类规则引擎回归测试：只跑 src/rules/*，不碰网络、浏览器和数据库。
 *   node tools/rules-test.mjs
 * 退出码 0 = 全部通过。所有用例都用真实对局走法（照抄客户端能下出来的局面），
 * 另用 create({ board }) 构造中局，覆盖从标准开局走不到的升王与和棋分支。
 */
import assert from 'node:assert/strict';
import { SLUGS, RULES, createGame, judge, toResult, isSupported, MAX_MOVE_LEN } from '../src/rules/index.js';
import { PIECE, startBoard } from '../src/rules/draughts.js';

let pass = 0;
const fails = [];
/** 覆盖率统计（报告里引用），只记录不参与判定 */
const stats = {};

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fails.push(name + ' —— ' + (e && e.message ? e.message : String(e)));
  }
}

/** 走一手棋并要求成功；失败时把错误码带进断言消息 */
function play(g, seat, move) {
  const r = g.apply({ seat, move });
  assert.ok(r.ok, (typeof move === 'string' ? move : JSON.stringify(move)) + ' 被拒：' + r.error);
  return r;
}

/** 走一整串 [{ seat, move }] */
function playAll(g, list) {
  for (const m of list) play(g, m.seat, m.move);
}

function rejected(g, seat, move) {
  const r = g.apply({ seat, move });
  assert.equal(r.ok, false, '本应被拒：' + move);
  return r.error;
}

function sortedNums(list) {
  return list.slice().sort((a, b) => a - b);
}

// ── 各款的元信息与索引契约 ───────────────────────────────────────────────
console.log('棋类规则引擎回归：' + SLUGS.join(', '));

t('SLUGS = 四款联机棋（国际象棋/中国象棋留扩展点，本轮不做）', () => {
  assert.deepEqual(SLUGS, ['connect4', 'reversi', 'draughts', 'gomoku']);
});

t('RULES 每款都有 slug/seats/moveFormat/note', () => {
  for (const slug of SLUGS) {
    const meta = RULES[slug];
    assert.ok(meta, slug + ' 缺元信息');
    assert.equal(meta.slug, slug);
    assert.equal(meta.seats, 2);
    assert.ok(typeof meta.moveFormat === 'string' && meta.moveFormat.length > 0, slug + ' 缺 moveFormat');
    assert.ok(typeof meta.note === 'string' && meta.note.length > 0, slug + ' 缺 note');
  }
});

t('未接入的棋类：isSupported=false / createGame 抛错 / judge 报 bad_game', () => {
  assert.equal(isSupported('chess'), false);
  assert.equal(isSupported('xiangqi'), false);
  assert.throws(() => createGame('chess'));
  assert.equal(judge('chess', []).error, 'bad_game');
});

t('空串走法重放：over=false / winner=0 / moveCount=0', () => {
  for (const slug of SLUGS) {
    const j = judge(slug, []);
    assert.equal(j.ok, true, slug);
    assert.equal(j.over, false, slug);
    assert.equal(j.winner, 0, slug);
    assert.equal(j.draw, false, slug);
    assert.equal(j.moveCount, 0, slug);
    assert.equal(j.index, -1, slug);
    assert.equal(j.error, '', slug);
  }
});

// ── 四子连珠 ────────────────────────────────────────────────────────────
console.log('\n== connect4 四子连珠 ==');

t('落子重力：棋子堆到该列最低空位，支持 "列" 与 "列,行" 两种写法', () => {
  const g = createGame('connect4');
  play(g, 0, '3');
  let v = g.view();
  assert.equal(v.board[5 * 7 + 3], 1); // 底行
  assert.equal(v.board[4 * 7 + 3], 0); // 上面还空着
  assert.deepEqual(v.last, { r: 5, c: 3 });
  play(g, 1, '3');
  v = g.view();
  assert.equal(v.board[4 * 7 + 3], 2); // 叠在对手棋子上
  assert.deepEqual(v.last, { r: 4, c: 3 });
  play(g, 0, '3,0'); // "列,行"：行号忽略，仍按重力落子
  v = g.view();
  assert.equal(v.board[3 * 7 + 3], 1);
  assert.equal(v.moveCount, 3);
  assert.deepEqual(g.moves(), [{ seat: 0, move: '3' }, { seat: 1, move: '3' }, { seat: 0, move: '3,0' }]);
});

t('竖直四连获胜（seat 0 = 房主）', () => {
  const g = createGame('connect4');
  for (let i = 0; i < 3; i++) { play(g, 0, '3'); play(g, 1, '0'); }
  const r = play(g, 0, '3');
  assert.equal(r.status.over, true);
  assert.equal(r.status.winner, 1);
  assert.equal(r.status.draw, false);
  const v = g.view();
  assert.equal(v.turn, -1);
  assert.equal(v.over, true);
  assert.deepEqual(sortedNums(v.winLine), [17, 24, 31, 38]); // (2,3)(3,3)(4,3)(5,3)
  assert.deepEqual(g.legalMoves(), []);
  assert.equal(toResult(r), 'host');
  assert.equal(g.apply({ seat: 1, move: '0' }).error, 'game_over'); // 终局优先于错座位
  assert.equal(toResult(g.apply({ seat: 1, move: '0' })), '');
});

t('水平四连获胜', () => {
  const g = createGame('connect4');
  for (let i = 0; i < 4; i++) {
    play(g, 0, String(i));
    if (i < 3) play(g, 1, '6');
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.deepEqual(sortedNums(v.winLine), [35, 36, 37, 38]);
  assert.equal(toResult({ ok: true, status: { over: true, winner: 1, draw: false } }), 'host');
});

t('斜向四连：↙（/\）与 ↘（\\）两条都判', () => {
  const down = createGame('connect4'); // r 随 c 递减
  playAll(down, [
    { seat: 0, move: '0' }, { seat: 1, move: '1' }, { seat: 0, move: '1' }, { seat: 1, move: '2' },
    { seat: 0, move: '5' }, { seat: 1, move: '2' }, { seat: 0, move: '2' }, { seat: 1, move: '3' },
    { seat: 0, move: '5' }, { seat: 1, move: '3' }, { seat: 0, move: '5' }, { seat: 1, move: '3' },
    { seat: 0, move: '3' },
  ]);
  assert.equal(down.view().winner, 1);
  assert.deepEqual(sortedNums(down.view().winLine), [17, 23, 29, 35]); // (2,3)(3,2)(4,1)(5,0)

  const up = createGame('connect4'); // r 随 c 递增
  playAll(up, [
    { seat: 0, move: '6' }, { seat: 1, move: '5' }, { seat: 0, move: '5' }, { seat: 1, move: '4' },
    { seat: 0, move: '1' }, { seat: 1, move: '4' }, { seat: 0, move: '4' }, { seat: 1, move: '3' },
    { seat: 0, move: '1' }, { seat: 1, move: '3' }, { seat: 0, move: '1' }, { seat: 1, move: '3' },
    { seat: 0, move: '3' },
  ]);
  assert.equal(up.view().winner, 1);
  assert.deepEqual(sortedNums(up.view().winLine), [17, 25, 33, 41]); // (2,3)(3,4)(4,5)(5,6)
});

t('列满：第 7 子被拒，judge 在对应下标报 illegal_move', () => {
  const g = createGame('connect4');
  for (let i = 0; i < 3; i++) { play(g, 0, '0'); play(g, 1, '0'); }
  assert.equal(g.view().board[0], 2); // 最高位被对手占住
  assert.ok(!g.legalMoves().includes('0'));
  assert.equal(rejected(g, 0, '0'), 'illegal_move');
  const j = judge('connect4', g.moves().concat([{ seat: 0, move: '0' }]));
  assert.equal(j.ok, false);
  assert.equal(j.error, 'illegal_move');
  assert.equal(j.index, 6);
  assert.equal(j.moveCount, 6);
});

t('非法走法：越界列号/重复列写法/空串/超长/座位越界/非字符串', () => {
  const g = createGame('connect4');
  assert.equal(rejected(g, 0, '7'), 'illegal_move');  // 只有 0..6 列
  assert.equal(rejected(g, 0, '07'), 'illegal_move'); // 客户端同款正则不允许前导零
  assert.equal(rejected(g, 0, '-1'), 'illegal_move');
  assert.equal(rejected(g, 0, ''), 'bad_move');
  assert.equal(rejected(g, 0, 'x'.repeat(MAX_MOVE_LEN + 1)), 'bad_move');
  assert.equal(rejected(g, 0, undefined), 'bad_move');
  assert.equal(rejected(g, 2, '0'), 'bad_move');       // 座位只能 0/1
  assert.equal(rejected(g, 1, '0'), 'not_your_turn');  // 房主先手
  assert.deepEqual(g.moves(), []);                     // 被拒的走法不留痕
  assert.equal(g.view().moveCount, 0);
  assert.equal(g.legalMoves().length, 7);
});

t('judge：斜线胜局重放一致，错座位/终局后落子都被挡住', () => {
  const g = createGame('connect4');
  playAll(g, [
    { seat: 0, move: '0' }, { seat: 1, move: '1' }, { seat: 0, move: '1' }, { seat: 1, move: '2' },
    { seat: 0, move: '5' }, { seat: 1, move: '2' }, { seat: 0, move: '2' }, { seat: 1, move: '3' },
    { seat: 0, move: '5' }, { seat: 1, move: '3' }, { seat: 0, move: '5' }, { seat: 1, move: '3' },
    { seat: 0, move: '3' },
  ]);
  const moves = g.moves();
  const a = judge('connect4', moves);
  const b = judge('connect4', moves);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.over, true);
  assert.equal(a.winner, 1);
  assert.equal(a.draw, false);
  assert.equal(a.moveCount, 13);
  assert.deepEqual(a.view.board, g.view().board); // 重放快照 = 逐步 apply 的快照
  assert.equal(toResult(a), 'host');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 2, draw: false } }), 'guest');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 0, draw: true } }), 'draw');

  const wrongSeat = moves.slice();
  wrongSeat[1] = { seat: 0, move: '1' };
  const j2 = judge('connect4', wrongSeat);
  assert.equal(j2.ok, false);
  assert.equal(j2.error, 'not_your_turn');
  assert.equal(j2.index, 1);

  const afterOver = moves.concat([{ seat: 1, move: '6' }]);
  const j3 = judge('connect4', afterOver);
  assert.equal(j3.ok, false);
  assert.equal(j3.error, 'game_over');
  assert.equal(j3.index, 13);

  const bad = moves.slice();
  bad[0] = { seat: 0, move: '9' };
  const j4 = judge('connect4', bad);
  assert.equal(j4.error, 'illegal_move');
  assert.equal(j4.index, 0);

  assert.equal(judge('connect4', 'nope').error, 'bad_move');
  assert.equal(judge('connect4', [{ seat: 0, move: '0' }, 'x']).error, 'bad_move');
});

// ── 黑白棋 ──────────────────────────────────────────────────────────────
console.log('\n== reversi 黑白棋 ==');

/** 独立参考实现：从落点沿八方向找「对方子连 + 己方子」的夹吃（用来对照引擎的 flipped） */
function refFlips(board, r, c, p) {
  const out = [];
  const enemy = p === 1 ? 2 : 1;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const line = [];
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === enemy) {
        line.push(rr * 8 + cc);
        rr += dr; cc += dc;
      }
      if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === p) out.push(...line);
    }
  }
  return out;
}

/** 八方向归一化：同一条线上翻多个子仍算同一个方向 */
function dirKey(from, to) {
  const dr = Math.floor(to / 8) - Math.floor(from / 8);
  const dc = (to % 8) - (from % 8);
  return (dr > 0 ? 1 : dr < 0 ? -1 : 0) + ',' + (dc > 0 ? 1 : dc < 0 ? -1 : 0);
}

t('开局：四子，非法点/过手/错座位都被拒', () => {
  const g = createGame('reversi');
  const v = g.view();
  assert.deepEqual(v.counts, { black: 2, white: 2 });
  assert.equal(v.board[27], 2); // (3,3) 白
  assert.equal(v.board[28], 1); // (3,4) 黑
  assert.equal(v.turn, 0);
  assert.equal(g.legalMoves().filter((m) => m !== 'pass').length, 4); // 客户端开局四个合法点
  assert.equal(rejected(g, 0, '0,0'), 'illegal_move'); // 夹不到子
  assert.equal(rejected(g, 0, '3,3'), 'illegal_move'); // 已有子
  assert.equal(rejected(g, 0, '15,0'), 'illegal_move');
  assert.equal(rejected(g, 0, 'pass'), 'illegal_move'); // 有子可下不许过手
  assert.equal(rejected(g, 1, '2,3'), 'not_your_turn'); // 黑先手
});

t("夹吃：'3,2' 翻 (3,3)，坐标别名 e3 是同一格的另一种写法", () => {
  const g = createGame('reversi');
  play(g, 0, '3,2');
  let v = g.view();
  assert.deepEqual(v.flipped, [27]); // (3,3) 白子被翻
  assert.deepEqual(v.counts, { black: 4, white: 1 });
  play(g, 1, '2,2'); // 白从 (2,2) 夹回 (3,3)
  v = g.view();
  assert.deepEqual(v.flipped, [27]);
  assert.deepEqual(v.counts, { black: 3, white: 3 });

  const alias = createGame('reversi');
  play(alias, 0, 'e3'); // 坐标别名 → (5,4)
  const av = alias.view();
  assert.equal(av.board[5 * 8 + 4], 1);
  assert.deepEqual(av.flipped, [36]); // (4,4) 被翻
  assert.deepEqual(alias.moves(), [{ seat: 0, move: 'e3' }]);
});

t('八向夹吃：整局每个局面的每个合法走法都对照参考实现，八方向全覆盖', () => {
  const g = createGame('reversi');
  const dirsSeen = new Set();
  let positions = 0, checked = 0, guard = 0;
  while (!g.view().over && guard++ < 200) {
    const v = g.view();
    const lm = g.legalMoves();
    positions++;
    // 对每个候选走法：用「前缀重放 + 同一手」造出该走法落地后的局面，再和参考实现比翻转集合
    for (const move of lm) {
      if (move === 'pass') continue;
      const probe = createGame('reversi');
      for (const h of g.moves()) play(probe, h.seat, h.move);
      play(probe, v.turn, move); // 合法走法（走完可能就终局了：最后一步填满棋盘）
      const [r, c] = move.split(',').map(Number);
      const expect = refFlips(v.board, r, c, v.turn === 0 ? 1 : 2);
      assert.ok(expect.length > 0, move + ' 竟然不翻子');
      assert.deepEqual(sortedNums(probe.view().flipped), sortedNums(expect), '翻转集合不符：' + move);
      for (const to of expect) dirsSeen.add(dirKey(r * 8 + c, to));
      checked++;
    }
    play(g, v.turn, lm[lm.length - 1]); // 固定策略（列表末位）保证可复现
  }
  assert.equal(dirsSeen.size, 8, '八方向没全命中：' + [...dirsSeen].sort().join(' '));
  stats.reversiPositions = positions;
  stats.reversiChecked = checked;
  stats.reversiDirs = dirsSeen.size;
});

t('无子可下必须过手；双方都无子时终局并按子数判胜负', () => {
  const g = createGame('reversi');
  let passes = 0;
  let guard = 0;
  while (!g.view().over && guard++ < 200) {
    const v = g.view();
    const lm = g.legalMoves();
    if (lm.length === 1 && lm[0] === 'pass') {
      passes++;
      assert.equal(v.board.length, 64);
      play(g, v.turn, 'pass'); // 无子可下 → 唯一合法走法就是过手
    } else {
      assert.ok(!lm.includes('pass'), '有子可下时不该出现 pass');
      play(g, v.turn, lm[lm.length - 1]);
    }
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.turn, -1);
  assert.deepEqual(g.legalMoves(), []);
  assert.ok(passes >= 1, '整局一次过手都没出现（passes=' + passes + '）');
  assert.ok(v.counts.black + v.counts.white <= 64);
  const expectWinner = v.counts.black > v.counts.white ? 1 : (v.counts.white > v.counts.black ? 2 : 0);
  assert.equal(v.winner, expectWinner);
  assert.equal(v.draw, expectWinner === 0);
  if (v.draw) assert.equal(v.winner, 0);

  // 整局重放（含 pass）与逐步走的终局一致
  stats.reversiPlies = g.moves().length;
  stats.reversiPasses = passes;
  stats.reversiCounts = JSON.stringify(v.counts);
  const moves = g.moves();
  const j = judge('reversi', moves);
  const j2 = judge('reversi', moves);
  assert.deepEqual(j, j2);
  assert.equal(j.ok, true);
  assert.equal(j.moveCount, moves.length);
  assert.equal(j.over, true);
  assert.equal(j.winner, v.winner);
  assert.deepEqual(j.view.board, v.board);
  assert.equal(toResult(j), v.draw ? 'draw' : (v.winner === 1 ? 'host' : 'guest'));
});

// ── 西洋跳棋 ────────────────────────────────────────────────────────────
console.log('\n== draughts 西洋跳棋 ==');

const sq = (r, c) => (r << 3) | c;
/** 用棋子码构造自定义局面（create 支持 board/side，服务端中局恢复同款入口） */
function boardOf(pieces) {
  const bd = new Array(64).fill(PIECE.EMPTY);
  for (const [r, c, v] of pieces) bd[sq(r, c)] = v;
  return bd;
}

t('标准开局：白 12 子、黑 12 子，白先手七个合法走法', () => {
  const g = createGame('draughts');
  const v = g.view();
  assert.deepEqual(v.counts, { white: 12, black: 12 });
  assert.equal(v.turn, 0);
  assert.equal(v.board[sq(5, 0)], PIECE.WM);
  assert.equal(v.board[sq(2, 1)], PIECE.BM);
  assert.deepEqual(g.legalMoves(), ['50-41', '52-41', '52-43', '54-43', '54-45', '56-45', '56-47']);
  assert.equal(startBoard().length, 64);
  assert.equal(rejected(g, 0, '70-61'), 'illegal_move'); // (7,0) 被 (6,1) 挡住
  assert.equal(rejected(g, 0, '50-40'), 'illegal_move'); // 不是斜走
  assert.equal(rejected(g, 0, '50-99'), 'illegal_move');
  assert.equal(rejected(g, 1, '25-34'), 'not_your_turn');
});

t('强制吃子 + 连跳：真实对局第 9 手只能吃，且必须走完极大序列', () => {
  const g = createGame('draughts');
  const game = [
    { seat: 0, move: '54-43' }, { seat: 1, move: '25-36' },
    { seat: 0, move: '63-54' }, { seat: 1, move: '21-30' },
    { seat: 0, move: '56-45' }, { seat: 1, move: '14-25' },
    { seat: 0, move: '65-56' }, { seat: 1, move: '30-41' },
  ];
  playAll(g, game);
  const lm = g.legalMoves();
  assert.ok(lm.length >= 1);
  // 有吃子时只许吃子：静着全部消失，剩下两条吃子（连跳按客户端写法是多段字符串）
  assert.deepEqual(lm.slice().sort(), ['50-32-14', '52-30']);
  assert.equal(lm.filter((m) => m.split('-').length === 3).length, 1); // 只有 "50-32-14" 是连跳
  assert.equal(rejected(g, 0, '56-47'), 'illegal_move');  // 静着被拒（强制吃子）
  assert.equal(rejected(g, 0, '50-32'), 'illegal_move');  // 半截连跳被拒（必须吃到底）
  assert.deepEqual(g.legalMoves(), lm);                   // 被拒的走法不改局面

  const r = play(g, 0, '50-32-14');
  assert.equal(r.status.over, false);
  const v = g.view();
  assert.equal(v.board[sq(1, 4)], PIECE.WM);   // 兵落 (1,4)，第 1 行不是白兵升王线
  assert.equal(v.board[sq(3, 2)], PIECE.EMPTY);
  assert.equal(v.board[sq(4, 1)], PIECE.EMPTY);
  assert.equal(v.board[sq(2, 3)], PIECE.EMPTY);
  assert.deepEqual(v.counts, { white: 12, black: 10 });
  assert.equal(v.kings.white, 0);
  assert.equal(v.noProgress, 0);               // 吃子后重新计
  assert.equal(v.turn, 1);
  assert.equal(v.lastMove.from, sq(5, 0));
  assert.equal(v.lastMove.to, sq(1, 4));
  assert.equal(v.lastMove.caps.length, 2);
  assert.equal(v.lastMove.promote, false);

  const moves = g.moves();
  assert.equal(moves.length, 9);
  const j1 = judge('draughts', moves);
  const j2 = judge('draughts', moves);
  assert.deepEqual(j1, j2);
  assert.equal(j1.ok, true);
  assert.equal(j1.over, false);
  assert.equal(j1.moveCount, 9);
  assert.deepEqual(j1.view.board, v.board);

  const wrongSeat = moves.slice();
  wrongSeat[0] = { seat: 1, move: '54-43' };
  assert.deepEqual(
    [judge('draughts', wrongSeat).error, judge('draughts', wrongSeat).index],
    ['not_your_turn', 0],
  );
  const partial = moves.slice();
  partial[8] = { seat: 0, move: '50-32' };
  assert.deepEqual([judge('draughts', partial).error, judge('draughts', partial).index], ['illegal_move', 8]);
});

t('升王：白兵走到底线变王，之后可后退', () => {
  const g = createGame('draughts', { board: boardOf([[1, 0, PIECE.WM], [0, 7, PIECE.BM]]), side: 0 });
  const r = play(g, 0, '10-01');
  const v = g.view();
  assert.equal(v.board[sq(0, 1)], PIECE.WK);
  assert.equal(v.board[sq(1, 0)], PIECE.EMPTY);
  assert.equal(v.kings.white, 1);
  assert.equal(v.lastMove.promote, true);
  assert.equal(r.status.over, false);
  play(g, 1, '07-16');
  const lm = g.legalMoves();
  assert.ok(lm.includes('01-10'), '升王后应能后退：' + lm.join(','));
  assert.ok(lm.includes('01-12'));
  play(g, 0, '01-10');
  assert.equal(g.view().board[sq(1, 0)], PIECE.WK);
});

t('王吃子只跳相邻两格（无 flying king），吃完对方归零即终局', () => {
  // 隔一格（3,2 空）：普通跳棋够不着，只能走静着
  const far = createGame('draughts', { board: boardOf([[2, 1, PIECE.WK], [4, 3, PIECE.BM]]), side: 0 });
  const farMoves = far.legalMoves();
  assert.ok(farMoves.every((m) => m.split('-').length === 2), '不该有吃子：' + farMoves.join(','));
  assert.deepEqual(sortedNums2(farMoves), ['21-10', '21-12', '21-30', '21-32']);

  // 相邻：只能吃，而且唯一
  const near = createGame('draughts', { board: boardOf([[3, 2, PIECE.WK], [4, 3, PIECE.BM]]), side: 0 });
  assert.deepEqual(near.legalMoves(), ['32-54']);
  const r = play(near, 0, '32-54');
  const v = near.view();
  assert.equal(v.board[sq(5, 4)], PIECE.WK);
  assert.equal(v.board[sq(4, 3)], PIECE.EMPTY);
  assert.deepEqual(v.counts, { white: 1, black: 0 });
  assert.equal(r.status.over, true);
  assert.equal(r.status.winner, 1); // seat 0 = 白 = 房主
  assert.equal(r.status.draw, false);
  assert.equal(v.turn, -1);
  assert.equal(v.reason, '黑方棋子被吃光，白方获胜');
  assert.deepEqual(near.legalMoves(), []);
  assert.equal(toResult(r), 'host');
});

function sortedNums2(list) { return list.slice().sort(); }

t('和棋：连续 50 个半回合无吃子也无兵移动', () => {
  const g = createGame('draughts', { board: boardOf([[7, 0, PIECE.WK], [0, 7, PIECE.BK]]), side: 0 });
  for (let i = 0; i < 25; i++) {
    play(g, 0, i % 2 ? '61-70' : '70-61');
    play(g, 1, i % 2 ? '16-07' : '07-16');
  }
  const v = g.view();
  assert.equal(v.moveCount, 50);
  assert.equal(v.noProgress, 50);
  assert.equal(v.over, true);
  assert.equal(v.draw, true);
  assert.equal(v.winner, 0);
  assert.equal(v.turn, -1);
  assert.equal(v.reason, '连续 25 回合没有吃子也没有兵移动，判和');
  assert.equal(toResult({ ok: true, status: { over: true, winner: 0, draw: true } }), 'draw');
  assert.equal(g.apply({ seat: 0, move: '70-61' }).error, 'game_over');
});

t('无棋可走：对方还有子但一步都动不了，同样判负', () => {
  // 黑兵 (0,1) 被白子 (1,0)(1,2) 顶住，唯一的吃子落点 (2,3) 也被白子占着
  const g = createGame('draughts', {
    board: boardOf([[0, 1, PIECE.BM], [1, 0, PIECE.WM], [1, 2, PIECE.WM], [2, 3, PIECE.WM], [5, 0, PIECE.WM]]),
    side: 0,
  });
  play(g, 0, '50-41'); // 白走一步闲棋（远处，不影响黑方的死活）
  const v = g.view();
  assert.deepEqual(v.counts, { white: 4, black: 1 }); // 黑子还在
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.equal(v.draw, false);
  assert.equal(v.turn, -1);
  assert.equal(v.reason, '黑方无棋可走，白方获胜');
  assert.deepEqual(g.legalMoves(), []);
});

// ── 五子棋 ──────────────────────────────────────────────────────────────
console.log('\n== gomoku 五子棋 ==');

t('横五连（贴左边界）获胜', () => {
  const g = createGame('gomoku');
  const blacks = ['0,7', '1,7', '2,7', '3,7', '4,7'];
  const whites = ['0,0', '2,2', '4,4', '6,6'];
  for (let i = 0; i < 5; i++) {
    play(g, 0, blacks[i]);
    if (i < 4) play(g, 1, whites[i]);
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.equal(v.turn, -1);
  assert.deepEqual(v.winLine, [105, 106, 107, 108, 109]); // y=7, x=0..4
  assert.deepEqual(v.last, { x: 4, y: 7 });
  assert.deepEqual(g.legalMoves(), []);
  const j = judge('gomoku', g.moves());
  assert.equal(j.ok, true);
  assert.equal(j.over, true);
  assert.equal(j.winner, 1);
  assert.deepEqual(j.view.board, v.board);
  assert.deepEqual(judge('gomoku', g.moves()), j);
  assert.equal(judge('gomoku', g.moves().concat([{ seat: 1, move: '8,8' }])).error, 'game_over');
  assert.equal(judge('gomoku', g.moves().concat([{ seat: 1, move: '8,8' }])).index, 9);
});

t('竖五连（贴下边界与右边界）获胜', () => {
  const g = createGame('gomoku');
  const blacks = ['14,10', '14,11', '14,12', '14,13', '14,14'];
  const whites = ['1,1', '3,3', '5,5', '7,7'];
  for (let i = 0; i < 5; i++) {
    play(g, 0, blacks[i]);
    if (i < 4) play(g, 1, whites[i]);
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.deepEqual(sortedNums(v.winLine), [164, 179, 194, 209, 224]); // 索引 = y*15+x，x=14, y=10..14
});

t('斜五连获胜', () => {
  const g = createGame('gomoku');
  const blacks = ['0,0', '1,1', '2,2', '3,3', '4,4'];
  const whites = ['10,0', '10,2', '10,4', '10,6'];
  for (let i = 0; i < 5; i++) {
    play(g, 0, blacks[i]);
    if (i < 4) play(g, 1, whites[i]);
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.deepEqual(sortedNums(v.winLine), [0, 16, 32, 48, 64]);
  assert.equal(toResult({ ok: true, status: v }), 'host');
});

t('长连（六连）也算胜，winLine 给出整条线', () => {
  const g = createGame('gomoku');
  const blacks = ['0,7', '2,7', '3,7', '4,7', '5,7', '1,7'];
  const whites = ['0,0', '2,2', '4,4', '6,6', '8,8'];
  for (let i = 0; i < 6; i++) {
    play(g, 0, blacks[i]);
    if (i < 5) play(g, 1, whites[i]);
  }
  const v = g.view();
  assert.equal(v.over, true);
  assert.equal(v.winner, 1);
  assert.equal(v.winLine.length, 6);
  assert.deepEqual(sortedNums(v.winLine), [105, 106, 107, 108, 109, 110]);
});

t('非法走法：越界/空格/多余字段/重复落子/错座位', () => {
  const g = createGame('gomoku');
  assert.equal(rejected(g, 0, '15,0'), 'illegal_move');
  assert.equal(rejected(g, 0, '-1,0'), 'illegal_move');
  assert.equal(rejected(g, 0, '0,15'), 'illegal_move');
  assert.equal(rejected(g, 0, ' 1,2'), 'illegal_move'); // 客户端同款不做 trim
  assert.equal(rejected(g, 0, '1, 2'), 'illegal_move');
  assert.equal(rejected(g, 0, '1,2,3'), 'illegal_move');
  assert.equal(rejected(g, 0, ''), 'bad_move');
  assert.equal(rejected(g, 0, '1'), 'illegal_move'); // 客户端正则要求 "x,y"
  assert.equal(rejected(g, 1, '7,7'), 'not_your_turn');
  play(g, 0, '7,7');
  assert.equal(rejected(g, 1, '7,7'), 'illegal_move'); // 重复落子
  assert.equal(g.moves().length, 1);
  assert.equal(g.legalMoves().length, 224); // 225 - 1
});

// ── 索引层 judge 的统一口径 ──────────────────────────────────────────────
console.log('\n== judge 统一口径 ==');

t('judge 遇到非数组/空位/未知棋类时的口径', () => {
  assert.equal(judge('connect4', null).error, 'bad_move');
  assert.equal(judge('connect4', {}).error, 'bad_move');
  assert.equal(judge('connect4', [null]).error, 'bad_move');
  assert.equal(judge('connect4', [{ seat: 3, move: '0' }]).error, 'bad_move');
  assert.equal(judge('reversi', [{ seat: 0, move: 123 }]).error, 'illegal_move'); // 数字会被转成字符串
  assert.equal(judge('chess', [{ seat: 0, move: '0' }]).error, 'bad_game');
});

t('createGame 未知棋类抛错，已知棋类返回四件套', () => {
  assert.throws(() => createGame('chess'), /chess/);
  for (const slug of SLUGS) {
    const g = createGame(slug);
    assert.equal(g.slug, slug);
    assert.equal(g.meta.slug, slug);
    assert.equal(typeof g.apply, 'function');
    assert.equal(typeof g.view, 'function');
    assert.equal(typeof g.legalMoves, 'function');
    assert.equal(typeof g.moves, 'function');
    assert.deepEqual(g.moves(), []);
    assert.ok(g.legalMoves().length > 0);
  }
});

t('每款：同一串走法两次 judge 结果一致（deepEqual）', () => {
  const samples = {
    connect4: [{ seat: 0, move: '3' }, { seat: 1, move: '3' }, { seat: 0, move: '4' }, { seat: 1, move: '2' }],
    reversi: [{ seat: 0, move: '5,4' }, { seat: 1, move: '5,5' }, { seat: 0, move: '5,6' }, { seat: 1, move: '6,6' }],
    draughts: [{ seat: 0, move: '54-43' }, { seat: 1, move: '25-36' }, { seat: 0, move: '63-54' }, { seat: 1, move: '21-30' }],
    gomoku: [{ seat: 0, move: '7,7' }, { seat: 1, move: '8,8' }, { seat: 0, move: '6,6' }, { seat: 1, move: '9,9' }],
  };
  for (const slug of SLUGS) {
    const moves = samples[slug];
    const a = judge(slug, moves);
    const b = judge(slug, moves);
    assert.deepEqual(a, b, slug);
    assert.equal(a.ok, true, slug);
    assert.equal(a.moveCount, moves.length, slug);
    assert.equal(a.over, false, slug);
    assert.equal(a.winner, 0, slug);
    // 逐步 apply 的快照与重放快照一致
    const g = createGame(slug);
    playAll(g, moves);
    assert.deepEqual(a.view, g.view(), slug);
  }
});

// ── 结果汇总 ────────────────────────────────────────────────────────────
console.log('');
if (stats.reversiChecked) {
  console.log('覆盖：reversi 整局 ' + stats.reversiPositions + ' 个局面 / ' + stats.reversiChecked
    + ' 个合法走法逐一对照参考实现，命中 ' + stats.reversiDirs + ' 个方向；全局 '
    + stats.reversiPlies + ' 手（过手 ' + stats.reversiPasses + ' 次），终局 ' + stats.reversiCounts);
}
if (fails.length) {
  for (const f of fails) console.log('FAIL ' + f);
}
console.log('PASS ' + pass + ' / FAIL ' + fails.length);
if (fails.length) process.exitCode = 1;
