/**
 * 五子棋（gomoku）服务端裁判：逐条照抄 games/gomoku/index.html 的判定逻辑。
 * 客户端里落子是 commit(x, y, p)，这里把同一套规则拆成 create() 出来的实例状态机。
 *
 * 走法编码："x,y"（x=列 0..14 左→右，y=行 0..14 上→下，客户端 np.send(x + ',' + y)）。
 *   客户端 parseMove 用的是 /^(\d{1,2}),(\d{1,2})$/ 且不 trim，这里保持同一口径。
 * 座位：seat 0 = 房主 = 黑 = 先手，seat 1 = 挑战者 = 白。
 *
 * 与客户端的唯一差别：客户端 commit 明知终局也不拒绝落子（联机时对手的决胜手是
 * onEnd 之后才轮询到的，挡了就画不出那一步）；服务端裁判按契约用 game_over 拒绝
 * 终局后的走法，这一手由 index.js 统一返回。
 */

const N = 15, EMPTY = 0, BLACK = 1, WHITE = 2;
/** 与客户端 DIRS 一致，元素是 (dx, dy)：横、竖、↘、↙ */
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** 座位 → 棋子码（客户端 seat 0 先手 = 黑） */
const colorOf = (seat) => (seat === 0 ? BLACK : WHITE);

export const META = {
  slug: 'gomoku',
  seats: 2,
  moveFormat: '坐标字符串 "x,y"（x=列 0..14、y=行 0..14，不接受空格）',
  note: '15x15，seat 0 = 黑 = 先手。横/竖/两条斜线连成 5 子及以上即胜（六连长连同样算胜，无禁手）；225 手落满判和。'
};

/** 解析走法 → { x, y }，非法返回 null（正则与客户端 parseMove 一字不差） */
export function parseMove(move) {
  if (typeof move !== 'string') return null;
  const m = /^(\d{1,2}),(\d{1,2})$/.exec(move);
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]);
  if (x < 0 || y < 0 || x >= N || y >= N) return null;
  return { x: x, y: y };
}

/** 找出 (x,y) 处刚落下的 p 子所在的、长度 >= 5 的整条连线（客户端 winLineAt） */
function winLineAt(cells, x, y, p) {
  for (let d = 0; d < DIRS.length; d++) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    const line = [y * N + x];
    for (let i = 1; i < N; i++) {
      const xx = x + dx * i, yy = y + dy * i;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N || cells[yy * N + xx] !== p) break;
      line.push(yy * N + xx);
    }
    for (let i = 1; i < N; i++) {
      const xx = x - dx * i, yy = y - dy * i;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N || cells[yy * N + xx] !== p) break;
      line.unshift(yy * N + xx);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

/** 建一局新棋（board 索引 = y*N+x，与客户端一致） */
export function create() {
  const cells = new Array(N * N).fill(EMPTY);
  const applied = [];
  let winLine = [];
  let last = -1;

  const g = {
    slug: 'gomoku',
    turn: 0,
    over: false,
    winner: 0,
    draw: false,
    apply(seat, move) {
      const m = parseMove(move);
      if (!m) return 'illegal_move';
      const k = m.y * N + m.x;
      if (cells[k]) return 'illegal_move';               // 该点已有子
      const p = colorOf(seat);
      cells[k] = p;
      applied.push({ seat: seat, move: move });
      last = k;
      const line = winLineAt(cells, m.x, m.y, p);
      if (line) {
        g.over = true; g.winner = seat + 1; g.turn = -1; winLine = line;
      } else if (applied.length >= N * N) {
        g.over = true; g.winner = 0; g.draw = true; g.turn = -1;   // 棋盘落满判和
      } else {
        g.turn = 1 - seat;
      }
      return null;
    },
    legalMoves() {
      if (g.over) return [];
      const out = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (cells[y * N + x] === EMPTY) out.push(x + ',' + y);
      }
      return out;
    },
    moves() {
      return applied.map((m) => ({ seat: m.seat, move: m.move }));
    },
    view() {
      return {
        slug: 'gomoku',
        turn: g.turn,
        over: g.over,
        winner: g.over ? g.winner : 0,
        draw: g.over ? g.draw : false,
        moveCount: applied.length,
        size: N,
        board: cells.slice(),
        winLine: winLine.slice(),
        last: last < 0 ? null : { x: last % N, y: Math.floor(last / N) }
      };
    }
  };
  return g;
}
