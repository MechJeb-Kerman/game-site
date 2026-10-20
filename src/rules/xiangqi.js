'use strict';

/* ============================================================
 * 中国象棋（xiangqi）服务端裁判
 *
 * 纯函数、零 I/O、零依赖：只用 Node 内置语言能力，
 * 状态全在闭包内，不读文件、不碰网络、不看时钟。
 *
 * 规则与 games/xiangqi/index.html 里的客户端实现逐条对齐：
 *   - 棋盘 9 列（x=0..8，左→右）× 10 行（y=0..9，上→下），索引 idx = y*9+x；
 *   - 红方在下（y=7..9）先手 = 联机 seat 0，黑方在上（y=0..2）= seat 1；
 *   - 棋子串 'r'/'b' + 类型：K 帅/将、A 仕/士、E 相/象、H 马、R 车、C 炮、P 兵/卒；
 *   - 马腿（蹩马腿）、象眼（塞象眼）、象不过河、士/将不出九宫、将帅照面（飞将）、
 *     炮必须隔一个炮架才能吃、兵过河前只能前进过河后可横走且永不后退；
 *   - 走法合法性的最终口径是「走完之后自己不被将军」（含送将与照面）；
 *   - 无合法着法即终局判负：被将死与困毙在客户端是同一个分支（winner = 对方），
 *     所以本模块也不区分，winner 都是「对手」；
 *   - 和棋只有一条：连续 120 个半步（plie）没有吃子 —— 客户端 DRAW_PLIES = 120
 *     （界面上写作「连续 60 回合无吃子」）。长将、长捉、双方均无进攻子力等一律
 *     不自动判和（客户端明确不判，由玩家自行认输或再来一局）。
 *
 * 走法串一律是「起点坐标-终点坐标」，写成 <起点>-<终点>，每格 <x>,<y>：
 *   '1,7-4,7'（红方左炮平中）、'0,9-0,8'、'4,3-4,4'。
 * 这就是 NetPlay 在联机对局里中继的那个字符串（客户端 enc/dec 的输出），
 * 刻意不额外支持 ICCS 那种 'h2e2' / 'b0c2' 简写：服务端若多认一种形状，
 * 就等于和一个线上客户端永远不会发出的形状产生分叉，只会掩盖真实的编码不一致。
 * 为兼容性只额外接受一个变体：把分隔符写成 ':' 或 ' ' 的 <起点>:<终点>
 * （'1,7:4,7'），两种写法解析结果完全一致，便于人工构造测试局面。
 * ============================================================ */

var COLS = 9;
var ROWS = 10;
var MAX_CELL = 8;
var BOARD_LEN = COLS * ROWS;   /* 90 */

var RED = 0;
var BLACK = 1;

var SIDE_CH = ['r', 'b'];
var KING = ['rK', 'bK'];
var TYPE_CH = { K: 1, A: 1, E: 1, H: 1, R: 1, C: 1, P: 1 };

/* 客户端同一份步子表：将/帅走直线，士走斜线，马走日，车走直线，象走田 */
var KSTEP = [[0, -1], [0, 1], [-1, 0], [1, 0]];
var AST = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
var EST = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
var HST = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
var RST = [[0, -1], [0, 1], [-1, 0], [1, 0]];

var INIT = (function () {
  var back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  var bd = new Array(BOARD_LEN);
  var i, x;
  for (i = 0; i < BOARD_LEN; i++) bd[i] = '';
  for (x = 0; x < 9; x++) {
    bd[x] = 'b' + back[x];              /* 黑方底线 y=0 */
    bd[81 + x] = 'r' + back[x];         /* 红方底线 y=9 */
  }
  bd[19] = 'bC'; bd[25] = 'bC';         /* 黑炮 (1,2) (7,2) */
  bd[64] = 'rC'; bd[70] = 'rC';         /* 红炮 (1,7) (7,7) */
  for (x = 0; x < 9; x += 2) {
    bd[27 + x] = 'bP';                  /* 黑卒 y=3 */
    bd[54 + x] = 'rP';                  /* 红兵 y=6 */
  }
  return bd;
})();

/* 连续多少手半步无吃子判和（客户端 DRAW_PLIES = 120） */
var DRAW_PLIES = 120;

var MOVE_FORMAT = 'start-end, each cell as <x>,<y> with x in 0..8 (left to right) and y in 0..9 (top to bottom); example "1,7-4,7" (red cannon to the middle file)';

export const META = {
  slug: 'xiangqi',
  seats: 2,
  moveFormat: MOVE_FORMAT,
  note: 'red (x=0..8 left to right) starts on her side (y=7..9) and moves first as seat 0; black sits on y=0..2 as seat 1. Full server-side legality: horse-leg, elephant-eye, elephant never crosses the river, advisor/king stay in the palace, flying general, no move may leave your own king in check, a cannon captures only over exactly one screen, a soldier never retreats and only steps sideways after crossing the river. No legal move means the player who must move loses (checkmate and stalemate are the same outcome, matching the client). The game is drawn only after 120 consecutive plies without a capture (60 full moves); perpetual check, threefold repetition and both-sides-helpless endings are not auto-drawn. The only move string is the client wire format <from>-<to> such as "1,7-4,7"; ICCS shorthand like "h2e2" is deliberately not accepted.'
};

/* ------------------------------------------------------------
 * 棋盘小工具：一律深拷贝，绝不改外部传进来的数组
 * ---------------------------------------------------------- */
function inb(x, y) {
  return x >= 0 && x <= MAX_CELL && y >= 0 && y <= 9;
}
function inPalace(side, x, y) {
  if (x < 3 || x > 5) return false;
  return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}
function other(side) { return side === RED ? BLACK : RED; }
function sideOf(p) { return p.charAt(0) === 'r' ? RED : BLACK; }
function typeOf(p) { return p.charAt(1); }
function clone(bd) { return bd.slice(); }
function isBoard(bd) {
  if (!bd || typeof bd !== 'object' || typeof bd.length !== 'number' || bd.length !== BOARD_LEN) return false;
  for (var i = 0; i < BOARD_LEN; i++) {
    var p = bd[i];
    if (typeof p !== 'string') return false;
    if (p === '') continue;
    if (p.length !== 2) return false;
    if (SIDE_CH.indexOf(p.charAt(0)) < 0) return false;
    if (!TYPE_CH[p.charAt(1)]) return false;
  }
  return true;
}

/* ------------------------------------------------------------
 * 走法串解析 / 编码：'1,7-4,7'
 * ---------------------------------------------------------- */
function parseMove(move) {
  var txt;
  if (typeof move === 'string') txt = move;
  else if (typeof move === 'number' && isFinite(move)) txt = String(move);  /* 与 index.js 的 String() 口径一致 */
  else return null;

  var s = txt.replace(/\s+/g, '');
  if (!s) return null;

  var a, b;
  var sep = s.indexOf('-');
  if (sep >= 0) {
    a = s.slice(0, sep);
    b = s.slice(sep + 1);
  } else {
    sep = s.indexOf(':');
    if (sep < 0) return null;
    a = s.slice(0, sep);
    b = s.slice(sep + 1);
  }
  if (a.indexOf('-') >= 0 || a.indexOf(':') >= 0) return null;
  if (b.indexOf('-') >= 0 || b.indexOf(':') >= 0) return null;

  var c1 = a.split(',');
  var c2 = b.split(',');
  if (c1.length !== 2 || c2.length !== 2) return null;

  var n = [];
  var i, t, v;
  for (i = 0; i < 2; i++) {
    t = c1[i];
    if (typeof t !== 'string' || t === '' || t.length > 8) return null;
    v = Number(t);
    if (!isFinite(v) || Math.floor(v) !== v || v < 0 || v > 9) return null;
    n.push(v);
  }
  for (i = 0; i < 2; i++) {
    t = c2[i];
    if (typeof t !== 'string' || t === '' || t.length > 8) return null;
    v = Number(t);
    if (!isFinite(v) || Math.floor(v) !== v || v < 0 || v > 9) return null;
    n.push(v);
  }
  if (!inb(n[0], n[1]) || !inb(n[2], n[3])) return null;

  var m = { x1: n[0], y1: n[1], x2: n[2], y2: n[3], from: n[1] * 9 + n[0], to: n[3] * 9 + n[2] };
  m.str = enc(m);
  return m;
}

function enc(m) {
  return m.x1 + ',' + m.y1 + '-' + m.x2 + ',' + m.y2;
}

/* ------------------------------------------------------------
 * 着法生成：先伪合法（不含送将），再由 legalMoves 过滤
 * ---------------------------------------------------------- */
function findKing(bd, side) {
  /* 与客户端一致：只在九宫里找王（飞将/双王照面局面下，王永远出不了九宫） */
  var y0 = side === BLACK ? 0 : 7;
  var y1 = side === BLACK ? 2 : 9;
  for (var y = y0; y <= y1; y++) {
    for (var x = 3; x <= 5; x++) {
      if (bd[y * 9 + x] === KING[side]) return { x: x, y: y, idx: y * 9 + x };
    }
  }
  return null;
}

/* 王是否正被攻击（含将帅照面、无王）——照抄客户端 inCheck 的判定口径 */
function inCheck(bd, side) {
  var k = findKing(bd, side);
  if (!k) return true;                    /* 王没了：一律视为被将 */

  var opp = other(side);
  var x = k.x, y = k.y;
  var i, j, dx, dy, nx, ny, p;

  /* 将帅照面（飞将）：同列且中间无子 */
  for (ny = y - 1; ny >= 0; ny--) {
    p = bd[ny * 9 + x];
    if (p) {
      if (p === KING[opp]) return true;
      break;
    }
  }
  for (ny = y + 1; ny <= 9; ny++) {
    p = bd[ny * 9 + x];
    if (p) {
      if (p === KING[opp]) return true;
      break;
    }
  }

  /* 直线：第一枚敌车 → 将军；第一枚是炮架时，第二枚敌炮 → 将军 */
  for (i = 0; i < 4; i++) {
    dx = RST[i][0]; dy = RST[i][1];
    nx = x + dx; ny = y + dy;
    while (inb(nx, ny) && !bd[ny * 9 + nx]) { nx += dx; ny += dy; }
    if (!inb(nx, ny)) continue;
    var first = bd[ny * 9 + nx];
    if (typeOf(first) === 'R' && sideOf(first) === opp) return true;
    nx += dx; ny += dy;
    while (inb(nx, ny) && !bd[ny * 9 + nx]) { nx += dx; ny += dy; }
    if (!inb(nx, ny)) continue;
    var second = bd[ny * 9 + nx];
    if (typeOf(second) === 'C' && sideOf(second) === opp) return true;
  }

  /* 马：从王的 8 个反向位置找敌马，检查对应马腿 */
  for (i = 0; i < HST.length; i++) {
    var hx = x + HST[i][0], hy = y + HST[i][1];
    if (!inb(hx, hy)) continue;
    p = bd[hy * 9 + hx];
    if (typeOf(p) !== 'H' || sideOf(p) !== opp) continue;
    var vx = x - hx, vy = y - hy;
    var lx = hx, ly = hy;
    if (Math.abs(vx) === 2) lx = hx + vx / 2;
    else ly = hy + vy / 2;
    if (inb(lx, ly) && bd[ly * 9 + lx]) continue;   /* 马腿被别 */
    return true;
  }

  /* 兵/卒：正前方一格，或过河后的左右一格 */
  var fy = y + (side === RED ? -1 : 1);
  if (inb(x, fy)) {
    p = bd[fy * 9 + x];
    if (typeOf(p) === 'P' && sideOf(p) === opp) return true;
  }
  var wx;
  for (i = -1; i <= 1; i += 2) {
    wx = x + i;
    if (!inb(wx, y)) continue;
    p = bd[y * 9 + wx];
    if (typeOf(p) !== 'P' || sideOf(p) !== opp) continue;
    /* 敌兵能横走 = 它已经过河：黑卒 y>=5，红兵 y<=4 */
    if (opp === BLACK ? y >= 5 : y <= 4) return true;
  }

  return false;
}

function pseudo(bd, side) {
  var out = [];
  var opp = other(side);
  var i, j, x, y, dx, dy, nx, ny, p, same, screen;

  for (y = 0; y < 10; y++) {
    for (x = 0; x < 9; x++) {
      p = bd[y * 9 + x];
      if (!p || sideOf(p) !== side) continue;
      var t = typeOf(p);

      if (t === 'K') {
        for (i = 0; i < KSTEP.length; i++) {
          nx = x + KSTEP[i][0]; ny = y + KSTEP[i][1];
          if (!inb(nx, ny) || !inPalace(side, nx, ny)) continue;
          same = bd[ny * 9 + nx];
          if (same && sideOf(same) === side) continue;
          out.push({ x1: x, y1: y, x2: nx, y2: ny });
        }
        /* 飞将：同列第一枚子若是对方王，可直接吃（与客户端一致） */
        dy = side === RED ? -1 : 1;
        for (ny = y + dy; inb(x, ny); ny += dy) {
          p = bd[ny * 9 + x];
          if (!p) continue;
          if (p === KING[opp]) out.push({ x1: x, y1: y, x2: x, y2: ny });
          break;
        }
        continue;
      }

      if (t === 'A') {
        for (i = 0; i < AST.length; i++) {
          nx = x + AST[i][0]; ny = y + AST[i][1];
          if (!inb(nx, ny) || !inPalace(side, nx, ny)) continue;
          same = bd[ny * 9 + nx];
          if (same && sideOf(same) === side) continue;
          out.push({ x1: x, y1: y, x2: nx, y2: ny });
        }
        continue;
      }

      if (t === 'E') {
        for (i = 0; i < EST.length; i++) {
          dx = EST[i][0]; dy = EST[i][1];
          nx = x + dx; ny = y + dy;
          if (!inb(nx, ny)) continue;
          if (side === RED ? ny < 5 : ny > 4) continue;    /* 象不过河 */
          if (bd[(y + dy / 2) * 9 + (x + dx / 2)]) continue; /* 塞象眼 */
          same = bd[ny * 9 + nx];
          if (same && sideOf(same) === side) continue;
          out.push({ x1: x, y1: y, x2: nx, y2: ny });
        }
        continue;
      }

      if (t === 'H') {
        for (i = 0; i < HST.length; i++) {
          dx = HST[i][0]; dy = HST[i][1];
          nx = x + dx; ny = y + dy;
          if (!inb(nx, ny)) continue;
          if (Math.abs(dx) === 2 ? bd[y * 9 + x + dx / 2] : bd[(y + dy / 2) * 9 + x]) continue; /* 蹩马腿 */
          same = bd[ny * 9 + nx];
          if (same && sideOf(same) === side) continue;
          out.push({ x1: x, y1: y, x2: nx, y2: ny });
        }
        continue;
      }

      if (t === 'R') {
        for (i = 0; i < RST.length; i++) {
          dx = RST[i][0]; dy = RST[i][1];
          nx = x + dx; ny = y + dy;
          while (inb(nx, ny)) {
            p = bd[ny * 9 + nx];
            if (!p) { out.push({ x1: x, y1: y, x2: nx, y2: ny }); }
            else {
              if (sideOf(p) === opp) out.push({ x1: x, y1: y, x2: nx, y2: ny });
              break;
            }
            nx += dx; ny += dy;
          }
        }
        continue;
      }

      if (t === 'C') {
        for (i = 0; i < RST.length; i++) {
          dx = RST[i][0]; dy = RST[i][1];
          nx = x + dx; ny = y + dy;
          screen = false;
          while (inb(nx, ny)) {
            p = bd[ny * 9 + nx];
            if (!screen) {
              if (!p) out.push({ x1: x, y1: y, x2: nx, y2: ny });
              else screen = true;   /* 第一枚子成为炮架 */
            } else if (p) {
              if (sideOf(p) === opp) out.push({ x1: x, y1: y, x2: nx, y2: ny });  /* 炮架后只能吃第一枚 */
              break;
            }
            nx += dx; ny += dy;
          }
        }
        continue;
      }

      if (t === 'P') {
        dy = side === RED ? -1 : 1;
        ny = y + dy;
        if (inb(x, ny)) {
          p = bd[ny * 9 + x];
          if (!p || sideOf(p) === opp) out.push({ x1: x, y1: y, x2: x, y2: ny });
        }
        if (side === RED ? y <= 4 : y >= 5) {   /* 过河后才能横走，永不后退 */
          for (i = -1; i <= 1; i += 2) {
            nx = x + i;
            if (!inb(nx, y)) continue;
            p = bd[y * 9 + nx];
            if (!p || sideOf(p) === opp) out.push({ x1: x, y1: y, x2: nx, y2: y });
          }
        }
        continue;
      }
    }
  }
  return out;
}

/* 走一步到副本上（不校验合法性，调用方保证） */
function applyRaw(bd, side, m) {
  var next = bd.slice();
  var to = m.y2 * 9 + m.x2;
  next[to] = next[m.y1 * 9 + m.x1];
  next[m.y1 * 9 + m.x1] = '';
  return next;
}

function legalMovesFor(bd, side) {
  var ms = pseudo(bd, side);
  var out = [];
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (bd[m.y2 * 9 + m.x2] === KING[other(side)]) { out.push(m); continue; }  /* 吃王的着法本身不需要再验 */
    if (!inCheck(applyRaw(bd, side, m), side)) out.push(m);
  }
  return out;
}

function statusOf(bd, side) {
  var ms = legalMovesFor(bd, side);
  if (!ms.length) return { over: true, winner: other(side), check: inCheck(bd, side), moves: ms };
  return { over: false, winner: 0, check: inCheck(bd, side), moves: ms };
}

function idxOf(m) { return m.y1 * 9 + m.x1; }

function err(code) { return typeof code === 'string' && code ? code : 'illegal_move'; }

/* ------------------------------------------------------------
 * 实例
 * ---------------------------------------------------------- */
export function create(options) {
  var opts = (options && typeof options === 'object') ? options : {};
  var board = opts.board ? clone(opts.board) : INIT.slice();
  if (!isBoard(board)) throw new Error('xiangqi: bad board');

  var g = {
    slug: 'xiangqi',
    turn: RED,
    over: false,
    winner: 0,
    draw: false,
    noCap: 0,
    moveCount: 0
  };
  var applied = [];
  var last = null;
  var lastCap = '';
  var lastCheck = inCheck(board, RED); // 自定义局面也要如实报告初始是否被将军

  g.apply = function (seat, move) {
    if (g.over) return 'game_over';
    if (seat !== RED && seat !== BLACK) return 'bad_move';
    if (seat !== g.turn) return 'not_your_turn';

    var m = parseMove(move);
    if (!m) return 'bad_move';

    var p = board[m.from];
    if (typeof p !== 'string' || p === '') return 'illegal_move';
    if (sideOf(p) !== seat) return 'illegal_move';

    var target = board[m.to];
    if (target && sideOf(target) === seat) return 'illegal_move';

    /* 生成着法只做一次：合法性、王的安全、终局判定都用它 */
    var ms = legalMovesFor(board, seat);
    var found = null;
    for (var i = 0; i < ms.length; i++) {
      if (idxOf(ms[i]) === m.from && ms[i].x2 === m.x2 && ms[i].y2 === m.y2) { found = ms[i]; break; }
    }
    if (!found) return 'illegal_move';

    var cap = board[m.to];
    if (cap && cap === KING[other(seat)] && board[m.from] !== KING[seat]) {
      /* 客户端只会用「飞将」吃到王，其余手段吃王在正常对局里到不了 */
      return 'illegal_move';
    }

    var mv = enc(m);
    board = applyRaw(board, seat, m);
    g.noCap = cap ? 0 : g.noCap + 1;
    lastCap = cap;
    applied.push({ seat: seat, move: mv });
    g.moveCount = applied.length;
    last = { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2 };

    g.turn = other(seat);

    var st = statusOf(board, g.turn);
    lastCheck = st.check;

    if (cap === KING[g.turn]) {
      /* 正常对局里走不出来（将帅照面与将军都会先拦住），按吃王者胜兜底 */
      g.over = true;
      g.winner = seat + 1;
      g.draw = false;
      g.turn = -1;
      return null;
    }

    if (st.over) {
      /* 被将死与困毙在客户端是同一个分支：无着可走的一方判负 */
      g.over = true;
      g.winner = seat + 1;
      g.draw = false;
      g.turn = -1;
      return null;
    }

    if (g.noCap >= DRAW_PLIES) {
      g.over = true;
      g.winner = 0;
      g.draw = true;
      g.turn = -1;
      return null;
    }

    return null;
  };

  g.legalMoves = function (side) {
    if (side !== undefined && side !== null) {
      if (g.over) return [];
      if (side !== RED && side !== BLACK) return [];
      if (side !== g.turn) return [];
    }
    if (g.over) return [];
    return legalMovesFor(board, g.turn).map(function (m) { return enc(m); });
  };

  g.moves = function () {
    return applied.map(function (e) { return { seat: e.seat, move: e.move }; });
  };

  g.view = function () {
    return {
      slug: 'xiangqi',
      turn: g.over ? -1 : g.turn,
      over: g.over,
      winner: g.over ? g.winner : 0,
      draw: g.over ? !!g.draw : false,
      moveCount: applied.length,
      board: clone(board),
      check: lastCheck,
      noCapturePlies: g.noCap,
      lastMove: last ? { x1: last.x1, y1: last.y1, x2: last.x2, y2: last.y2 } : null,
      lastCapture: lastCap || ''
    };
  };

  return g;
}
