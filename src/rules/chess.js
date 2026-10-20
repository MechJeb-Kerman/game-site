/**
 * 国际象棋（chess）服务端裁判：把 games/chess/index.html 的引擎规则段
 * （第 173-445 行：newState / attacked / addCastles / genPseudo / makeMove / unmakeMove /
 *   legalMoves / posKey / insufficient / statusAfter）逐条搬到服务端，
 * 去掉客户端的搜索、评估与渲染，只留「走法合法性 + 终局判定」。
 *
 * 棋盘：长度 64 的一维数组，index = rank * 8 + file；rank 0 = 第 1 横线（白底线）、file 0 = a 列，
 *   于是 a1 = 0、h1 = 7、a8 = 56、h8 = 63。
 * 棋子：单字符，大写 = 白（K Q R B N P）、小写 = 黑，空串 = 空格。
 * 座位：seat 0 = 白 = 房主 = 先手，seat 1 = 黑 = 挑战者（与客户端 net.seat 一致）。
 *
 * 走法编码（必须与客户端 codeOf 一字不差，联机中继送的就是它）：
 *   sqName(from) + sqName(to) + promo，例如 'e2e4'、'e7e8q'、王车易位记成王的 'e1g1' / 'e1c1'。
 *   解析口径 = 客户端 findMove：trim → 起点终点各两字符小写字母 + 1-based 行号 → 第 5 个字符
 *   若存在则按升变子（转小写，必须是 q/r/b/n）。唯一收紧的地方：客户端只读第 5 个字符、
 *   对后面的多余字符不设防，这里要求长度正好 4 或 5，免得把 'e2e4zz' 这种脏串存进对局记录
 *   （客户端拿着它反而对不上本地着法）。
 *
 * 与客户端的偏向（服务端是裁判，客户端那句 result 不再采信）：
 *   - 终局之后的走法 → 'game_over'，错座位 → 'not_your_turn'（客户端 UI 层自己挡，不返回码）；
 *   - 客户端 commitMove 只是「试探性」算一下终局再决定要不要声明 result，这里 apply 真的落子。
 *   create(options) 支持 { board, turn, half, ep, cast } 构造中局局面（照抄 draughts.js 的先例），
 *   服务端回放与测试要用它摆终局/易位/升变的局面。
 */

const FILES = 'abcdefgh';
const WHITE = 'w', BLACK = 'b';
/** 升变四选一，顺序与客户端 PROMO 一致 */
const PROMO = ['q', 'r', 'b', 'n'];
/** 合法棋子字符（大写白 / 小写黑），options.board 校验用 */
const PIECE_CHARS = 'KQRBNPkqrbnp';
const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const isWhite = (p) => p >= 'A' && p <= 'Z';
const other = (c) => (c === WHITE ? BLACK : WHITE);
const fileOf = (i) => i & 7;
const rankOf = (i) => i >> 3;
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const sqName = (i) => FILES.charAt(fileOf(i)) + (rankOf(i) + 1);
const colorOfPiece = (p) => (isWhite(p) ? WHITE : BLACK);
/** 座位（0/1）→ 颜色；非法座位返回 '' */
const colorOfSeat = (seat) => (seat === 0 ? WHITE : seat === 1 ? BLACK : '');
const seatOfColor = (c) => (c === WHITE ? 0 : 1);

/** 'e2' → 12；非法返回 -1（与客户端 nameSq 同口径：区分大小写、不接受多余空格） */
export function nameSq(s) {
  if (typeof s !== 'string' || s.length < 2) return -1;
  const f = s.charCodeAt(0) - 97, r = Number(s.charAt(1)) - 1;
  if (!(f >= 0 && f <= 7) || !(r >= 0 && r <= 7)) return -1;
  return r * 8 + f;
}

/**
 * 走法字符串 → { from, to, promo }，不合法返回 null（与客户端 findMove 同口径，见文件头）。
 */
export function parseMove(code) {
  if (typeof code !== 'string') return null;
  const s = code.trim();
  if (s.length !== 4 && s.length !== 5) return null;
  const from = nameSq(s.slice(0, 2)), to = nameSq(s.slice(2, 4));
  if (from < 0 || to < 0 || from === to) return null;
  const promo = s.length > 4 ? s.charAt(4).toLowerCase() : '';
  if (promo && PROMO.indexOf(promo) < 0) return null;
  return { from: from, to: to, promo: promo };
}

/** 着法对象 → 走法字符串（客户端 codeOf） */
export function encodeMove(m) {
  return sqName(m.from) + sqName(m.to) + (m.promo || '');
}

export const META = {
  slug: 'chess',
  seats: 2,
  moveFormat: 'UCI 式 "起点+终点[升变子]"：如 "e2e4"、"e7e8q"；小写字母 + 1-based 行号，'
    + '升变子 q/r/b/n 只在兵到达底线时带上，王车易位记成王的两格移动（"e1g1" / "e1c1"）',
  note: 'seat 0 = 白 = 先手。完整规则：王车易位（王/车未动过、中间空、王不在被将、经过格不被攻击）、'
    + '吃过路兵（只接在对方兵首步两格之后的紧接一手）、兵升变四选一、送王非法、将军/将死/逼和；'
    + '和棋判定依次为 逼和、50 回合（半回合计数 >= 100）、三次重复局面、双方子力不足（各只剩王或王+单轻子）。'
};

/** 造一个着法对象（客户端 move()） */
function move(from, to, p, cap, promo) {
  return {
    from: from, to: to, p: p, cap: cap || '', promo: promo || '',
    epCap: false, castle: '', dbl: false, chk: false
  };
}

/** 标准开局（客户端 newState） */
export function newState() {
  const st = {
    b: new Array(64), turn: WHITE,
    cast: { wk: true, wq: true, bk: true, bq: true },
    ep: -1, half: 0, full: 1, hist: [],
    kw: 4, kb: 60                                /* 王的位置 e1 / e8：atk/inCheck 依赖它 */
  };
  const back = 'RNBQKBNR';
  for (let i = 0; i < 64; i++) st.b[i] = '';
  for (let f = 0; f < 8; f++) {
    st.b[f] = back.charAt(f);                      /* 白方底线 rank1 */
    st.b[8 + f] = 'P';                             /* 白兵 rank2 */
    st.b[48 + f] = 'p';                            /* 黑兵 rank7 */
    st.b[56 + f] = back.charAt(f).toLowerCase();   /* 黑方底线 rank8 */
  }
  return st;
}

/** 某个格子是否被 byW（true = 白方）攻击（客户端 attacked） */
function attacked(st, sq, byW) {
  const f0 = fileOf(sq), r0 = rankOf(sq), b = st.b;
  let f, r, p;
  /* 兵：白兵在目标格的下方（rank 小 1），黑兵在上方 */
  const pr = r0 + (byW ? -1 : 1);
  if (pr >= 0 && pr < 8) {
    for (let df = -1; df <= 1; df += 2) {
      f = f0 + df;
      if (f < 0 || f > 7) continue;
      p = b[pr * 8 + f];
      if (p && isWhite(p) === byW && (p === 'P' || p === 'p')) return true;
    }
  }
  /* 马 */
  for (let i = 0; i < 8; i++) {
    f = f0 + KNIGHT_D[i][0]; r = r0 + KNIGHT_D[i][1];
    if (!onBoard(f, r)) continue;
    p = b[r * 8 + f];
    if (p && isWhite(p) === byW && (p === 'N' || p === 'n')) return true;
  }
  /* 王（相邻格） */
  for (let i = 0; i < 8; i++) {
    f = f0 + KING_D[i][0]; r = r0 + KING_D[i][1];
    if (!onBoard(f, r)) continue;
    p = b[r * 8 + f];
    if (p && isWhite(p) === byW && (p === 'K' || p === 'k')) return true;
  }
  /* 斜线：象 / 后 */
  for (let d = 0; d < 4; d++) {
    f = f0 + DIAG_D[d][0]; r = r0 + DIAG_D[d][1];
    while (onBoard(f, r)) {
      p = b[r * 8 + f];
      if (p) {
        if (isWhite(p) === byW && (p === 'B' || p === 'b' || p === 'Q' || p === 'q')) return true;
        break;
      }
      f += DIAG_D[d][0]; r += DIAG_D[d][1];
    }
  }
  /* 直线：车 / 后 */
  for (let e = 0; e < 4; e++) {
    f = f0 + ORTH_D[e][0]; r = r0 + ORTH_D[e][1];
    while (onBoard(f, r)) {
      p = b[r * 8 + f];
      if (p) {
        if (isWhite(p) === byW && (p === 'R' || p === 'r' || p === 'Q' || p === 'q')) return true;
        break;
      }
      f += ORTH_D[e][0]; r += ORTH_D[e][1];
    }
  }
  return false;
}

function atk(st, sq, byColor) { return attacked(st, sq, byColor === WHITE); }
function kingSq(st, c) { return c === WHITE ? st.kw : st.kb; }
function inCheck(st, color) { return atk(st, kingSq(st, color), other(color)); }

/* 王车易位：王与对应车都没动过、中间两格为空、王不在被将状态、经过格不被攻击
   （到达格是否被攻击由 legalMovesFor 的通用合法性检查兜底） */
function addCastles(st, color, from, out) {
  const w = color === WHITE, b = st.b;
  const home = w ? 4 : 60;
  if (from !== home) return;
  const enemy = other(color);
  if (atk(st, home, enemy)) return;
  const rook = w ? 'R' : 'r';
  if ((w ? st.cast.wk : st.cast.bk) === true &&
      b[home + 1] === '' && b[home + 2] === '' && b[home + 3] === rook &&
      !atk(st, home + 1, enemy) && !atk(st, home + 2, enemy)) {
    const m1 = move(from, home + 2, b[from], '', '');
    m1.castle = 'k';
    out.push(m1);
  }
  if ((w ? st.cast.wq : st.cast.bq) === true &&
      b[home - 1] === '' && b[home - 2] === '' && b[home - 3] === '' && b[home - 4] === rook &&
      !atk(st, home - 1, enemy) && !atk(st, home - 2, enemy)) {
    const m2 = move(from, home - 2, b[from], '', '');
    m2.castle = 'q';
    out.push(m2);
  }
}

/* 伪合法着法生成：不检查走完之后自己的王是否被将（由 legalMovesFor 过滤）
   capsOnly = true 时只生成吃子 / 升变，也顺带省掉易位 */
function genPseudo(st, color, capsOnly) {
  const out = [], b = st.b, w = color === WHITE;
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || isWhite(p) !== w) continue;
    const type = p.toUpperCase(), f0 = fileOf(from), r0 = rankOf(from);
    if (type === 'P') {
      const dir = w ? 1 : -1, promoRank = w ? 7 : 0, startRank = w ? 1 : 6;
      const r1 = r0 + dir;
      if (onBoard(f0, r1)) {
        const one = r1 * 8 + f0;
        if (!b[one]) {
          if (r1 === promoRank) {
            for (let k = 0; k < 4; k++) out.push(move(from, one, p, '', PROMO[k]));
          } else if (!capsOnly) {
            out.push(move(from, one, p, '', ''));
            if (r0 === startRank) {
              const two = (r0 + dir * 2) * 8 + f0;
              if (!b[two]) { const dm = move(from, two, p, '', ''); dm.dbl = true; out.push(dm); }
            }
          }
        }
      }
      for (let df = -1; df <= 1; df += 2) {
        const f = f0 + df, r = r0 + dir;
        if (!onBoard(f, r)) continue;
        const to = r * 8 + f, t = b[to];
        if (t && isWhite(t) !== w) {
          if (r === promoRank) {
            for (let k2 = 0; k2 < 4; k2++) out.push(move(from, to, p, t, PROMO[k2]));
          } else out.push(move(from, to, p, t, ''));
        } else if (!t && to === st.ep) {
          /* 吃过路兵：目标格是空格，被吃的兵在旁边的 rank 上 */
          const em = move(from, to, p, w ? 'p' : 'P', '');
          em.epCap = true;
          out.push(em);
        }
      }
    } else if (type === 'N') {
      for (let i = 0; i < 8; i++) {
        const nf = f0 + KNIGHT_D[i][0], nr = r0 + KNIGHT_D[i][1];
        if (!onBoard(nf, nr)) continue;
        const nt = b[nr * 8 + nf];
        if (nt && isWhite(nt) === w) continue;
        if (capsOnly && !nt) continue;
        out.push(move(from, nr * 8 + nf, p, nt, ''));
      }
    } else if (type === 'K') {
      for (let j = 0; j < 8; j++) {
        const kf = f0 + KING_D[j][0], kr = r0 + KING_D[j][1];
        if (!onBoard(kf, kr)) continue;
        const kt = b[kr * 8 + kf];
        if (kt && isWhite(kt) === w) continue;
        if (capsOnly && !kt) continue;
        out.push(move(from, kr * 8 + kf, p, kt, ''));
      }
      if (!capsOnly) addCastles(st, color, from, out);
    } else {
      const dirs = type === 'B' ? DIAG_D : (type === 'R' ? ORTH_D : DIAG_D.concat(ORTH_D));
      for (let d2 = 0; d2 < dirs.length; d2++) {
        let sf = f0 + dirs[d2][0], sr = r0 + dirs[d2][1];
        while (onBoard(sf, sr)) {
          const t2 = b[sr * 8 + sf];
          if (!t2) { if (!capsOnly) out.push(move(from, sr * 8 + sf, p, '', '')); }
          else {
            if (isWhite(t2) !== w) out.push(move(from, sr * 8 + sf, p, t2, ''));
            break;
          }
          sf += dirs[d2][0]; sr += dirs[d2][1];
        }
      }
    }
  }
  return out;
}

/** 走一步（改局面 + 记录撤销信息），客户端 makeMove */
function makeMove(st, m) {
  const b = st.b, w = isWhite(m.p);
  const undo = {
    m: m, ep: st.ep, half: st.half, full: st.full,
    wk: st.cast.wk, wq: st.cast.wq, bk: st.cast.bk, bq: st.cast.bq,
    kw: st.kw, kb: st.kb
  };
  if (m.epCap) b[m.to + (w ? -8 : 8)] = '';       /* 被吃的兵不在 to 格 */
  b[m.from] = '';
  b[m.to] = m.promo ? (w ? m.promo.toUpperCase() : m.promo) : m.p;
  if (m.p === 'K') st.kw = m.to;
  if (m.p === 'k') st.kb = m.to;
  if (m.castle === 'k') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = ''; }
  if (m.castle === 'q') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = ''; }
  /* 易位权：王一动就全丢；车离开原位或被吃也丢 */
  if (m.p === 'K') { st.cast.wk = false; st.cast.wq = false; }
  if (m.p === 'k') { st.cast.bk = false; st.cast.bq = false; }
  if (m.from === 0 || m.to === 0) st.cast.wq = false;
  if (m.from === 7 || m.to === 7) st.cast.wk = false;
  if (m.from === 56 || m.to === 56) st.cast.bq = false;
  if (m.from === 63 || m.to === 63) st.cast.bk = false;
  /* 吃过路兵目标格：只有兵首步两格才留下，下一步就走完作废 */
  st.ep = m.dbl ? (m.from + m.to) / 2 : -1;
  /* 50 回合规则：兵动或吃子清零，其余累加 */
  st.half = (m.p === 'P' || m.p === 'p' || m.cap) ? 0 : st.half + 1;
  if (w) st.full++;
  st.turn = other(st.turn);
  st.hist.push(undo);
  return undo;
}

function unmakeMove(st) {
  const u = st.hist.pop(), m = u.m, b = st.b, w = isWhite(m.p);
  if (m.castle === 'k') { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = ''; }
  if (m.castle === 'q') { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = ''; }
  b[m.from] = m.p;
  b[m.to] = '';
  if (m.epCap) b[m.to + (w ? -8 : 8)] = m.cap;
  else if (m.cap) b[m.to] = m.cap;
  st.ep = u.ep; st.half = u.half; st.full = u.full;
  st.cast.wk = u.wk; st.cast.wq = u.wq; st.cast.bk = u.bk; st.cast.bq = u.bq;
  st.kw = u.kw; st.kb = u.kb;
  st.turn = other(st.turn);
}

/** 合法着法：伪合法走一步，看自己的王是否被攻击（送王与易位到达格都靠它兜底） */
function legalMovesFor(st, color, capsOnly) {
  const ps = genPseudo(st, color, capsOnly), out = [], enemy = other(color);
  for (let i = 0; i < ps.length; i++) {
    const m = ps[i];
    makeMove(st, m);
    if (!atk(st, kingSq(st, color), enemy)) {
      if (!capsOnly) m.chk = atk(st, kingSq(st, enemy), color);  /* 顺手标注将军 */
      out.push(m);
    }
    unmakeMove(st);
  }
  return out;
}

/** 局面去重键（三次重复判和用）：棋子 + 行棋方 + 易位权 + 吃过路兵目标格 */
function posKey(st) {
  let s = '';
  for (let i = 0; i < 64; i++) s += (st.b[i] || '.');
  return s + st.turn + (st.cast.wk ? 'K' : '') + (st.cast.wq ? 'Q' : '') +
         (st.cast.bk ? 'k' : '') + (st.cast.bq ? 'q' : '') + '|' + st.ep;
}

/* 双方都只剩王（或各带一个轻子）时判和 —— 谁也杀不了谁 */
function insufficient(st) {
  const w = [], b = [];
  for (let i = 0; i < 64; i++) {
    const p = st.b[i];
    if (!p) continue;
    const t = p.toUpperCase();
    if (t === 'K') continue;
    (isWhite(p) ? w : b).push(t);
  }
  const weak = (list) => list.length === 0 || (list.length === 1 && (list[0] === 'N' || list[0] === 'B'));
  return weak(w) && weak(b);
}

/** 刚走完 mover 这一手之后的局面判定（mover 是颜色字符；顺序与客户端 statusAfter 一致） */
function statusAfter(st, mover, reps) {
  const opp = other(mover);
  const chk = atk(st, kingSq(st, opp), mover);
  if (!legalMovesFor(st, opp, false).length) {
    if (chk) return { over: true, kind: 'mate', winner: mover };
    return { over: true, kind: 'stale', winner: '' };
  }
  if (st.half >= 100) return { over: true, kind: 'fifty', winner: '' };
  if ((reps[posKey(st)] || 0) >= 3) return { over: true, kind: 'rep', winner: '' };
  if (insufficient(st)) return { over: true, kind: 'material', winner: '' };
  return { over: false, kind: '', winner: '', check: chk };
}

/** options.board → 内部局面（长度 64 的棋子码数组，必须正好一个 K 和一个 k） */
function stateFromBoard(opt) {
  const list = opt.board;
  if (!Array.isArray(list) || list.length !== 64) {
    throw new Error('rules/chess: options.board 必须是长度 64 的棋子码数组');
  }
  const st = newState();
  let kw = -1, kb = -1;
  for (let i = 0; i < 64; i++) {
    const p = list[i] == null ? '' : String(list[i]);
    if (p !== '' && (p.length !== 1 || PIECE_CHARS.indexOf(p) < 0)) {
      throw new Error('rules/chess: options.board 第 ' + i + ' 格不是合法棋子码：' + JSON.stringify(list[i]));
    }
    st.b[i] = p;
    if (p === 'K') kw = i;
    if (p === 'k') kb = i;
  }
  if (kw < 0 || kb < 0 || list.indexOf('K') !== kw || list.lastIndexOf('K') !== kw
      || list.lastIndexOf('k') !== kb) {
    throw new Error('rules/chess: options.board 里必须正好一个白王 K 和一个黑王 k');
  }
  st.kw = kw; st.kb = kb;
  /* 易位权默认按「王与车都还在原位」推导，可用 options.cast 覆盖 */
  st.cast.wk = st.b[4] === 'K' && st.b[7] === 'R';
  st.cast.wq = st.b[4] === 'K' && st.b[0] === 'R';
  st.cast.bk = st.b[60] === 'k' && st.b[63] === 'r';
  st.cast.bq = st.b[60] === 'k' && st.b[56] === 'r';
  return st;
}

/** options 里的 turn / half / ep / cast 覆盖（构造中局局面用；board 给的只有默认值，这里逐项覆盖） */
function applyOptions(st, opt) {
  if (opt.turn !== undefined) {
    const c = opt.turn === 'w' || opt.turn === 'b' ? opt.turn : colorOfSeat(opt.turn);
    if (c) st.turn = c;
  }
  if (opt.half !== undefined && Number.isFinite(Number(opt.half))) st.half = Math.max(0, Math.floor(Number(opt.half)));
  if (opt.ep !== undefined && opt.ep !== null && opt.ep !== -1) {
    const e = Number(opt.ep);
    if (Number.isFinite(e) && e >= 0 && e < 64) st.ep = Math.floor(e);
  }
  if (opt.cast && typeof opt.cast === 'object') {
    for (const k of ['wk', 'wq', 'bk', 'bq']) {
      if (opt.cast[k] !== undefined) st.cast[k] = !!opt.cast[k];
    }
  }
}

/**
 * 建一局新棋。
 * options（都可选，照 draughts.js 的先例，给服务端回放 / 测试构造局面用）：
 *   board  长度 64 的棋子码数组（单字符 KQRBNP/kqrbnp 或空串）
 *   turn   0|1（或 'w'|'b'）行棋方，默认 0
 *   half   半回合计数（50 回合规则），默认 0
 *   ep     吃过路兵目标格下标，默认 -1
 *   cast   { wk, wq, bk, bq } 易位权覆盖
 */
export function create(options) {
  const opt = options || {};
  const st = opt.board ? stateFromBoard(opt) : newState();
  applyOptions(st, opt);
  const reps = {};
  const applied = [];
  let last = null;
  let kind = '';
  const repsAdd = (s) => { const k = posKey(s); reps[k] = (reps[k] || 0) + 1; };
  repsAdd(st);

  const g = {
    slug: 'chess',
    turn: seatOfColor(st.turn),
    over: false,
    winner: 0,
    draw: false,
    apply(seat, moveStr) {
      if (g.over) return 'game_over';
      if (seat !== 0 && seat !== 1) return 'bad_move';
      if (seatOfColor(st.turn) !== seat) return 'not_your_turn';
      const want = parseMove(moveStr);
      if (!want) return 'illegal_move';
      const list = legalMovesFor(st, st.turn, false);
      let mv = null;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.from === want.from && m.to === want.to && (m.promo || '') === want.promo) { mv = m; break; }
      }
      if (!mv) return 'illegal_move';
      const mover = colorOfPiece(mv.p);
      const code = encodeMove(mv);
      makeMove(st, mv);
      repsAdd(st);
      const stt = statusAfter(st, mover, reps);
      applied.push({ seat: seat, move: code });
      last = { seat: seat, code: code };
      if (stt.over) {
        g.over = true;
        g.draw = stt.winner === '';
        g.winner = stt.winner === '' ? 0 : (stt.winner === mover ? seat + 1 : 0);
        g.turn = -1;
        kind = stt.kind;
      } else {
        g.turn = seatOfColor(st.turn);
      }
      return null;
    },
    legalMoves() {
      if (g.over) return [];
      return legalMovesFor(st, st.turn, false).map((m) => encodeMove(m));
    },
    moves() {
      return applied.map((m) => ({ seat: m.seat, move: m.move }));
    },
    view() {
      return {
        slug: 'chess',
        turn: g.turn,
        over: g.over,
        winner: g.over ? g.winner : 0,
        draw: g.over ? g.draw : false,
        moveCount: applied.length,
        board: st.b.slice(),
        castling: { wk: st.cast.wk, wq: st.cast.wq, bk: st.cast.bk, bq: st.cast.bq },
        ep: st.ep,
        halfmove: st.half,
        fullmove: st.full,
        check: !g.over && inCheck(st, st.turn),
        kind: kind,
        last: last ? { seat: last.seat, code: last.code } : null
      };
    }
  };
  return g;
}
