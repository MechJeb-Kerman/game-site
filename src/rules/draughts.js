/**
 * 西洋跳棋（draughts）服务端裁判：逐条照抄 games/draughts/index.html 的判定逻辑。
 * 客户端里棋盘是 G.bd（Int8Array）加一堆自由函数，这里整体搬进 create() 出来的实例，
 * 判定口径一字不改：吃子必须走完极大序列（连跳）、有吃子就只许吃子（强制吃子，
 * 但不要求吃最多）、兵只在落点那一步升王、25 回合无吃子也无兵移动判和。
 *
 * 走法编码："52-41" = 起点格 + 落点格，每格两位数字（行号 + 列号，0=最上/最左）；
 *   连吃写成完整路径 "52-41-30"，路径上每一跳都必须是吃子。
 * 座位：seat 0 = 房主 = 白 = 先手，seat 1 = 挑战者 = 黑（客户端 badge「座位 0 房主(白)」）。
 */

const EMPTY = 0, WM = 1, WK = 2, BM = 3, BK = 4;
const WHITE = 0, BLACK = 1;
/** 王的方向（客户端 DIRS） */
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
/** 兵的方向，按 side 索引（客户端 MAN_DIRS：白兵向上 r-1，黑兵向下 r+1） */
const MAN_DIRS = [[[-1, -1], [-1, 1]], [[1, -1], [1, 1]]];
/** 连续多少手没有吃子也没有兵移动就判和（客户端 DRAW_PLIES = 50 个半回合 = 25 回合） */
const DRAW_PLIES = 50;

const sideOfSeat = (seat) => (seat === 0 ? WHITE : BLACK);
const seatOfSide = (side) => (side === WHITE ? 0 : 1);
const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const sq = (r, c) => (r << 3) | c;
const rowOf = (i) => i >> 3;
const colOf = (i) => i & 7;
const colorOf = (v) => (v === EMPTY ? -1 : (v <= 2 ? WHITE : BLACK));
const isKing = (v) => v === WK || v === BK;
const mkPiece = (color, king) => (color === WHITE ? (king ? WK : WM) : (king ? BK : BM));
const opp = (side) => (side === WHITE ? BLACK : WHITE);
/** 客户端 sideName()：给终局文案用 */
const sideName = (side) => (side === WHITE ? '白方' : '黑方');
const isPromoRow = (side, r) => (side === WHITE ? r === 0 : r === 7);
const manDirs = (side) => MAN_DIRS[side];

/** 棋子码与两方编号（构造局面时用；同样照抄客户端常量） */
export const PIECE = { EMPTY: EMPTY, WM: WM, WK: WK, BM: BM, BK: BK, WHITE: WHITE, BLACK: BLACK };

export const META = {
  slug: 'draughts',
  seats: 2,
  moveFormat: '"52-41"（起点格-落点格，每格两位：行号+列号）；连吃写成完整路径 "52-41-30"',
  note: '8x8 深色格，每方 12 子，seat 0 = 白 = 先手。有吃子时必须吃子（不要求吃最多），吃子要走完极大连跳序列；兵走到对方底线升王；对方无子可走或子被吃光即负；连续 25 回合无吃子也无兵移动判和。'
};

/** 开局棋盘（客户端 startBoard） */
export function startBoard() {
  const bd = new Array(64).fill(EMPTY);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (((r + c) & 1) !== 1) continue;      // 只占深色格
    if (r < 3) bd[sq(r, c)] = BM;
    else if (r > 4) bd[sq(r, c)] = WM;
  }
  return bd;
}

/** 递归找「吃到不能再吃」的极大吃子序列（客户端 captureSeq，原样搬运） */
function captureSeq(bd, side, from, piece, r, c, path, caps, out) {
  const dirs = isKing(piece) ? DIRS : manDirs(side);
  let any = false;
  for (let k = 0; k < dirs.length; k++) {
    const dr = dirs[k][0], dc = dirs[k][1];
    const mr = r + dr, mc = c + dc, lr = r + dr * 2, lc = c + dc * 2;
    if (!inb(lr, lc)) continue;
    const mid = bd[sq(mr, mc)];
    if (mid === EMPTY || colorOf(mid) === side) continue;   // 必须吃对方的子
    if (bd[sq(lr, lc)] !== EMPTY) continue;                 // 落点必须空
    any = true;
    bd[sq(mr, mc)] = EMPTY; bd[sq(r, c)] = EMPTY; bd[sq(lr, lc)] = piece;
    path.push(sq(lr, lc)); caps.push(sq(mr, mc));
    captureSeq(bd, side, from, piece, lr, lc, path, caps, out);
    path.pop(); caps.pop();
    bd[sq(lr, lc)] = EMPTY; bd[sq(r, c)] = piece; bd[sq(mr, mc)] = mid;
  }
  if (!any && path.length) {
    out.push({
      from: from, path: path.slice(), caps: caps.slice(), to: path[path.length - 1],
      promote: (!isKing(piece)) && isPromoRow(side, r)
    });
  }
}

/** 该方全部合法走法（客户端 genMoves：有吃子就只返回吃子） */
export function genMoves(bd, side) {
  const caps = [];
  for (let i = 0; i < 64; i++) {
    const v = bd[i];
    if (v === EMPTY || colorOf(v) !== side) continue;
    captureSeq(bd, side, i, v, rowOf(i), colOf(i), [], [], caps);
  }
  if (caps.length) return caps;      // 强制吃子：有得吃就只能吃
  const quiet = [];
  for (let i = 0; i < 64; i++) {
    const v = bd[i];
    if (v === EMPTY || colorOf(v) !== side) continue;
    const r = rowOf(i), c = colOf(i);
    const dirs = isKing(v) ? DIRS : manDirs(side);
    for (let k = 0; k < dirs.length; k++) {
      const tr = r + dirs[k][0], tc = c + dirs[k][1];
      if (!inb(tr, tc) || bd[sq(tr, tc)] !== EMPTY) continue;
      quiet.push({
        from: i, path: [sq(tr, tc)], caps: [], to: sq(tr, tc),
        promote: (!isKing(v)) && isPromoRow(side, tr)
      });
    }
  }
  return quiet;
}

/** 落子（客户端 applyM），返回被吃子信息，供调用方算 noProgress */
export function applyMove(bd, m) {
  const u = { from: m.from, piece: bd[m.from], caps: [] };
  for (let i = 0; i < m.caps.length; i++) {
    const s = m.caps[i];
    u.caps.push(s, bd[s]);
    bd[s] = EMPTY;
  }
  bd[m.from] = EMPTY;
  bd[m.to] = m.promote ? mkPiece(colorOf(u.piece), true) : u.piece;
  return u;
}

/** 走法 → 字符串（客户端 encodeMove） */
export function encodeMove(m) {
  const pts = [m.from].concat(m.path);
  const out = [];
  for (let i = 0; i < pts.length; i++) out.push('' + rowOf(pts[i]) + colOf(pts[i]));
  return out.join('-');
}

/** 字符串 → 格子序列（客户端 parsePath），非法返回 null */
export function parsePath(str) {
  if (typeof str !== 'string') return null;
  const parts = String(str).trim().split('-');
  if (parts.length < 2) return null;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].replace(/[^0-9]/g, '');
    if (seg.length !== 2) return null;
    const r = seg.charCodeAt(0) - 48, c = seg.charCodeAt(1) - 48;
    if (r > 7 || c > 7) return null;
    out.push(sq(r, c));
  }
  return out;
}

/** 在合法走法里按字符串找（客户端 findMove：起点 + 整条路径逐格比对） */
export function findMove(list, str) {
  const pts = parsePath(str);
  if (!pts) return null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.from !== pts[0]) continue;
    if (m.path.length !== pts.length - 1) continue;
    let ok = true;
    for (let j = 0; j < m.path.length; j++) if (m.path[j] !== pts[j + 1]) { ok = false; break; }
    if (ok) return m;
  }
  return null;
}

/** 该方全部合法走法的字符串形式（客户端 legalStrs） */
export function legalStrs(bd, side) {
  return genMoves(bd, side).map(encodeMove);
}

/** 数子（客户端 countPieces） */
export function countPieces(bd, side) {
  let n = 0;
  for (let i = 0; i < 64; i++) if (bd[i] !== EMPTY && colorOf(bd[i]) === side) n++;
  return n;
}

/** 把 options.board（长度 64 的棋子码数组）转成内部棋盘，非法则抛错 */
function boardOf(list) {
  if (!Array.isArray(list) || list.length !== 64) {
    throw new Error('rules/draughts: options.board 必须是长度 64 的棋子码数组');
  }
  const bd = new Array(64).fill(EMPTY);
  for (let i = 0; i < 64; i++) {
    const v = list[i] | 0;
    if (v < EMPTY || v > BK) throw new Error('rules/draughts: 棋子码只能是 0..4');
    bd[i] = v;
  }
  return bd;
}

/**
 * 建一局新棋（客户端 G 初始：bd=startBoard()、side=WHITE、noProgress=0）。
 * options.board / options.side 可选，用来从中局局面恢复（服务端回放快照、测试构造局面）；
 * 不给就是标准开局。
 */
export function create(options) {
  const opt = options || {};
  const bd = opt.board ? boardOf(opt.board) : startBoard();
  const applied = [];
  let side = opt.side === 1 ? BLACK : WHITE;
  let noProgress = 0;
  let lastMove = null;
  let reason = '';

  const g = {
    slug: 'draughts',
    turn: seatOfSide(side),
    over: false,
    winner: 0,
    draw: false,
    apply(seat, move) {
      if (sideOfSeat(seat) !== side) return 'not_your_turn';   // index.js 已判，这里兜底
      const m = findMove(genMoves(bd, side), move);
      if (!m) return 'illegal_move';
      const u = applyMove(bd, m);
      const capN = m.caps.length, wasMan = !isKing(u.piece);
      applied.push({ seat: seat, move: move });
      noProgress = (capN > 0 || wasMan) ? 0 : noProgress + 1;
      lastMove = { from: m.from, to: m.to, caps: m.caps.slice(), promote: !!m.promote };
      side = opp(side);
      g.turn = seatOfSide(side);
      // 客户端 checkEnd()：该走方无棋可走 → 对方胜；否则看和棋计数
      const mv = genMoves(bd, side);
      if (!mv.length) {
        g.over = true;
        g.winner = seatOfSide(opp(side)) + 1;
        g.turn = -1;
        // 文案照抄客户端 checkEnd()：sideName + 结局 + '，' + 胜方 + '获胜'
        reason = (countPieces(bd, side) === 0 ? sideName(side) + '棋子被吃光' : sideName(side) + '无棋可走')
          + '，' + sideName(opp(side)) + '获胜';
      } else if (noProgress >= DRAW_PLIES) {
        g.over = true; g.winner = 0; g.draw = true; g.turn = -1;
        reason = '连续 25 回合没有吃子也没有兵移动，判和';
      }
      return null;
    },
    legalMoves() {
      if (g.over) return [];
      return legalStrs(bd, side);
    },
    moves() {
      return applied.map((m) => ({ seat: m.seat, move: m.move }));
    },
    view() {
      return {
        slug: 'draughts',
        turn: g.turn,
        over: g.over,
        winner: g.over ? g.winner : 0,
        draw: g.over ? g.draw : false,
        moveCount: applied.length,
        size: 8,
        board: bd.slice(),
        counts: { white: countPieces(bd, WHITE), black: countPieces(bd, BLACK) },
        kings: { white: countKings(bd, WHITE), black: countKings(bd, BLACK) },
        noProgress: noProgress,
        lastMove: lastMove ? { from: lastMove.from, to: lastMove.to, caps: lastMove.caps.slice(), promote: lastMove.promote } : null,
        reason: reason
      };
    }
  };
  return g;
}

function countKings(bd, side) {
  let n = 0;
  for (let i = 0; i < 64; i++) if (bd[i] === (side === WHITE ? WK : BK)) n++;
  return n;
}
