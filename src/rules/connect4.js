/**
 * 四子棋（connect4）服务端裁判：逐条照抄 games/connect4/index.html 的判定逻辑。
 * 客户端里落子是 commit(c, p)，这里把同一套规则拆成 create() 出来的实例状态机，
 * 不改任何判定口径（重力、四连方向、落满 42 手判和）。
 *
 * 走法编码：列号字符串 "0".."6"（客户端 np.send(String(c)) 发出的就是它）。
 *   客户端 parseMove 还允许 "列,行"（行只校验 0..5，落点仍由重力决定），这里一并接受。
 * 座位：seat 0 = 房主 = 客户端 P1 / 红 / 先手，seat 1 = 挑战者 = P2 / 黄。
 */

const COLS = 7, ROWS = 6, CELLS = COLS * ROWS, EMPTY = 0;
/** 与客户端 DIRS 一致，元素是 (dr, dc)：横、竖、↘、↙ */
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

const idx = (r, c) => r * COLS + c;
/** 座位 → 棋子码（客户端 P1=1 红先手 / P2=2 黄） */
const colorOf = (seat) => (seat === 0 ? 1 : 2);

export const META = {
  slug: 'connect4',
  seats: 2,
  moveFormat: '列号字符串 "0".."6"（也接受客户端允许的 "列,行"，行号忽略、落点由重力决定）',
  note: '7 列 x 6 行，seat 0 = 红 = 先手。横/竖/两条斜线四连即胜；42 手落满判和。'
};

/** 解析走法 → 列号，非法返回 -1（正则与客户端 parseMove 一字不差） */
export function parseMove(move) {
  if (typeof move !== 'string') return -1;
  const m = /^\s*([0-6])(?:\s*,\s*[0-5])?\s*$/.exec(move);
  return m ? parseInt(m[1], 10) : -1;
}

/** 该列最低的空行（重力），-1 = 列满（客户端 lowestEmpty） */
function lowestEmpty(cells, c) {
  for (let r = ROWS - 1; r >= 0; r--) if (cells[idx(r, c)] === EMPTY) return r;
  return -1;
}

/** 从落点向两侧延伸找同色连线，长度 >= 4 即胜（客户端 findWin） */
function findWin(cells, c, r, p) {
  for (let d = 0; d < DIRS.length; d++) {
    const dr = DIRS[d][0], dc = DIRS[d][1];
    const line = [idx(r, c)];
    for (let i = 1; i < ROWS; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || cells[idx(rr, cc)] !== p) break;
      line.push(idx(rr, cc));
    }
    for (let i = 1; i < ROWS; i++) {
      const rr = r - dr * i, cc = c - dc * i;
      if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || cells[idx(rr, cc)] !== p) break;
      line.unshift(idx(rr, cc));
    }
    if (line.length >= 4) return line;
  }
  return null;
}

/** 建一局新棋（cells 按 idx(r,c)=r*COLS+c 存放，r=0 是最上面一行，与客户端一致） */
export function create() {
  const cells = new Array(CELLS).fill(EMPTY);
  const applied = [];
  let winLine = [];
  let last = -1;

  const g = {
    slug: 'connect4',
    turn: 0,
    over: false,
    winner: 0,
    draw: false,
    /** 落一手；返回 null 表示成功，否则返回错误码（座位与终局由 index.js 先判） */
    apply(seat, move) {
      const c = parseMove(move);
      if (c < 0) return 'illegal_move';
      const r = lowestEmpty(cells, c);
      if (r < 0) return 'illegal_move';                 // 列满
      const p = colorOf(seat);
      cells[idx(r, c)] = p;
      applied.push({ seat: seat, move: move });
      last = idx(r, c);
      const line = findWin(cells, c, r, p);
      if (line) {
        g.over = true; g.winner = seat + 1; g.turn = -1; winLine = line;
      } else if (applied.length >= CELLS) {
        g.over = true; g.winner = 0; g.draw = true; g.turn = -1;   // 落满判和
      } else {
        g.turn = 1 - seat;
      }
      return null;
    },
    legalMoves() {
      if (g.over) return [];
      const out = [];
      for (let c = 0; c < COLS; c++) if (lowestEmpty(cells, c) >= 0) out.push(String(c));
      return out;
    },
    moves() {
      return applied.map((m) => ({ seat: m.seat, move: m.move }));
    },
    view() {
      return {
        slug: 'connect4',
        turn: g.turn,
        over: g.over,
        winner: g.over ? g.winner : 0,
        draw: g.over ? g.draw : false,
        moveCount: applied.length,
        rows: ROWS,
        cols: COLS,
        board: cells.slice(),
        winLine: winLine.slice(),
        last: last < 0 ? null : { r: Math.floor(last / COLS), c: last % COLS }
      };
    }
  };
  return g;
}
