/**
 * 黑白棋（reversi）服务端裁判：逐条照抄 games/reversi/index.html 的判定逻辑。
 * 客户端里棋盘是共享变量 board，这里把它搬进 create() 出来的实例里，判定口径不变
 * （八方向夹吃、必须有夹吃才能落子、无子可下只能过手、双方都无子可下按子数判胜负）。
 *
 * 走法编码："r,c"（r=行 0..7 上→下，c=列 0..7 左→右，客户端 np.send(r + ',' + c)）。
 *   客户端 parseMove 还接受 "a1".."h8" 与过手 'pass' / 'skip' / '-'，这里一并接受。
 * 座位：seat 0 = 房主 = 黑 = 先手，seat 1 = 挑战者 = 白。
 *
 * 与服务端的口径：严格轮流，turn 恒为 1 - seat；轮到的一方若无子可下，
 * 唯一合法走法就是 'pass'（客户端 maybeAutoPass 会自动替玩家发），过手不翻子。
 */

const N = 8, EMPTY = 0, BLACK = 1, WHITE = 2;
/** 与客户端 DIRS 一致：8 邻域 */
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

const idx = (r, c) => r * N + c;
const other = (p) => (p === BLACK ? WHITE : BLACK);
/** 座位 → 棋子色（客户端座位 0 先手 = 黑） */
const colorOf = (seat) => (seat === 0 ? BLACK : WHITE);

export const META = {
  slug: 'reversi',
  seats: 2,
  moveFormat: '"r,c"（行,列 均 0..7）；也接受 "a1".."h8"；无子可下时走法为 "pass"（客户端原文，也认 "skip"/"-"）',
  note: '8x8 标准开局四子，seat 0 = 黑 = 先手。八方向夹吃、必须夹吃至少一子；无子可下的一方只能过手；双方都无子可下时按子数判胜负，相等判和。'
};

/** 解析走法 → { r, c } / { pass: true } / null（与客户端 parseMove 一字不差） */
export function parseMove(move) {
  if (typeof move !== 'string') return null;
  const s = move.trim().toLowerCase();
  if (s === 'pass' || s === 'skip' || s === '-') return { pass: true };
  let m = /^([0-7])\s*,\s*([0-7])$/.exec(s);
  if (m) return { r: parseInt(m[1], 10), c: parseInt(m[2], 10) };
  m = /^([a-h])\s*([1-8])$/.exec(s);
  if (m) return { r: 8 - parseInt(m[2], 10), c: m[1].charCodeAt(0) - 97 };
  return null;
}

/** 沿 8 个方向走：把被夹住的对方子收进 out（out 为 null 时只计数），返回能翻的子数 */
function walk(cells, r, c, p, out) {
  let n = 0;
  const opp = other(p);
  for (let d = 0; d < 8; d++) {
    const dr = DIRS[d][0], dc = DIRS[d][1];
    let rr = r + dr, cc = c + dc, k = 0;
    const start = out ? out.length : 0;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === opp) {
      if (out) out.push(rr * 8 + cc);
      k++; rr += dr; cc += dc;
    }
    if (k && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === p) n += k;
    else if (out) out.length = start;
  }
  return n;
}

/** 在 (r,c) 落 p 子能翻掉的对方子（空数组 = 该点不合法） */
function flipsFor(cells, r, c, p) {
  const out = [];
  if (r < 0 || r > 7 || c < 0 || c > 7 || cells[idx(r, c)] !== EMPTY) return out;
  walk(cells, r, c, p, out);
  return out;
}

/** 该方是否还有合法落点（客户端 hasMoves） */
function hasMoves(cells, p) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (cells[idx(r, c)] !== EMPTY) continue;
    if (walk(cells, r, c, p, null) > 0) return true;
  }
  return false;
}

function place(cells, r, c, p, f) {
  cells[idx(r, c)] = p;
  for (let i = 0; i < f.length; i++) cells[f[i]] = p;
}

function countOf(cells, p) {
  let n = 0;
  for (let i = 0; i < N * N; i++) if (cells[i] === p) n++;
  return n;
}

/** 建一局新棋（board 索引 = r*8+c，与客户端一致） */
export function create() {
  const cells = new Array(N * N).fill(EMPTY);
  cells[idx(3, 3)] = WHITE; cells[idx(3, 4)] = BLACK;
  cells[idx(4, 3)] = BLACK; cells[idx(4, 4)] = WHITE;
  const applied = [];
  let flipped = [];
  let last = null;
  let lastPass = false;

  const g = {
    slug: 'reversi',
    turn: 0,
    over: false,
    winner: 0,
    draw: false,
    apply(seat, move) {
      const m = parseMove(move);
      if (!m) return 'illegal_move';
      const p = colorOf(seat);
      flipped = [];
      if (m.pass) {
        if (hasMoves(cells, p)) return 'illegal_move';   // 有子可下就不许过手
        last = null; lastPass = true;
      } else {
        const f = flipsFor(cells, m.r, m.c, p);
        if (!f.length) return 'illegal_move';            // 必须夹吃至少一子
        place(cells, m.r, m.c, p, f);
        flipped = f.slice();
        last = { r: m.r, c: m.c }; lastPass = false;
      }
      applied.push({ seat: seat, move: move });
      const oppColor = other(p);
      if (!hasMoves(cells, oppColor) && !hasMoves(cells, p)) {
        // 双方都无子可下 → 终局，按子数判胜负（客户端 turnInfo/ countResult）
        const b = countOf(cells, BLACK), w = countOf(cells, WHITE);
        g.over = true; g.turn = -1; g.winner = b > w ? 1 : (w > b ? 2 : 0); g.draw = b === w;
      } else {
        g.turn = 1 - seat;   // 严格轮流：无子可下的一方下一手只能发 "pass"
      }
      return null;
    },
    legalMoves() {
      if (g.over) return [];
      const p = colorOf(g.turn);
      const out = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (cells[idx(r, c)] !== EMPTY) continue;
        if (flipsFor(cells, r, c, p).length) out.push(r + ',' + c);
      }
      if (!out.length) out.push('pass');   // 无子可下：唯一合法走法是过手
      return out;
    },
    moves() {
      return applied.map((m) => ({ seat: m.seat, move: m.move }));
    },
    view() {
      return {
        slug: 'reversi',
        turn: g.turn,
        over: g.over,
        winner: g.over ? g.winner : 0,
        draw: g.over ? g.draw : false,
        moveCount: applied.length,       // 含过手（= 服务端 play_moves 的条数）
        size: N,
        board: cells.slice(),
        counts: { black: countOf(cells, BLACK), white: countOf(cells, WHITE) },
        flipped: flipped.slice(),
        last: last ? { r: last.r, c: last.c } : null,
        lastPass: lastPass
      };
    }
  };
  return g;
}
