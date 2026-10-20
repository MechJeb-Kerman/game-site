/**
 * 联机棋类服务端规则引擎的统一入口（纯函数、无 I/O、零依赖）。
 *
 * 现状：服务端只中继走法、胜负由客户端自己声明；本模块把客户端那份规则原样搬到服务端，
 * 让服务端能自己裁判走法与判胜负（src/play-store.js 的 sendMove 现在只认客户端给的 result）。
 *
 * 覆盖 4 款：connect4 / reversi / draughts / gomoku（与 games/<slug>/ 目录、play_rooms.game 同名）。
 * 扩展点：要加国际象棋 / 中国象棋，新建 src/rules/chess.js，照现有模块的样子导出
 *   META = { slug, seats, moveFormat, note } 与 create()（实例需实现
 *   turn / over / winner / draw 与 apply(seat, move) → null|错误码 / legalMoves() / moves() / view()），
 *   再把它的 slug 加进 SLUGS、把模块加进 REGS 即可，index.js 其余部分不用动。
 *
 * 座位与胜负口径：seat 一律 0 / 1（= play_rooms.turn、play_moves.seat 的原生编号，0 = 房主先手）；
 *   winner 用 1 / 2（座位号，即 seat + 1），平局 winner 为 0 且 draw 为 true，
 *   未结束 winner 为 0 且 over 为 false；toResult() 可把结果翻成服务端的 'host' / 'guest' / 'draw'。
 */

import * as connect4 from './connect4.js';
import * as reversi from './reversi.js';
import * as draughts from './draughts.js';
import * as gomoku from './gomoku.js';

/** 已接入规则引擎的棋类 slug（顺序即展示顺序） */
export const SLUGS = ['connect4', 'reversi', 'draughts', 'gomoku'];

/** slug → 规则模块（扩展点就在这一张表） */
const REGS = {
  connect4: connect4,
  reversi: reversi,
  draughts: draughts,
  gomoku: gomoku
};

/** slug → 元信息 { slug, seats, moveFormat, note } */
export const RULES = {};
for (let i = 0; i < SLUGS.length; i++) {
  const slug = SLUGS[i];
  RULES[slug] = {
    slug: slug,
    seats: REGS[slug].META.seats,
    moveFormat: REGS[slug].META.moveFormat,
    note: REGS[slug].META.note
  };
}

/** 走法字符串长度上限，与 src/play.js 的 MAX_MOVE_LEN 对齐 */
export const MAX_MOVE_LEN = 256;
/** apply() 可能返回的错误码（bad_game 只在 judge 遇到未知 slug 时出现） */
export const ERRORS = ['bad_move', 'game_over', 'not_your_turn', 'illegal_move', 'bad_game'];
/** 服务端结算用的结果串（与 src/play.js 的 RESULTS 一致） */
export const RESULTS = ['host', 'guest', 'draw'];

/** 这个 slug 有没有规则引擎 */
export function isSupported(slug) {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(REGS, slug);
}

/** 取某款的元信息（未接入返回 null） */
export function ruleOf(slug) {
  return isSupported(slug) ? RULES[slug] : null;
}

const isSeat = (seat) => seat === 0 || seat === 1;

/** 当前局的对外状态（未结束一律 winner 0 / draw false） */
function statusOf(g) {
  return { over: !!g.over, winner: g.over ? g.winner : 0, draw: g.over ? !!g.draw : false };
}

/**
 * 建一局新棋。
 * @param {string} slug connect4 | reversi | draughts | gomoku
 * @param {object} [options] 预留给以后（如让子/尺寸），当前实现忽略
 * @returns {{ slug: string, meta: object, apply: Function, view: Function, legalMoves: Function, moves: Function }}
 */
export function createGame(slug, options) {
  if (!isSupported(slug)) throw new Error('rules: 不支持的棋类 ' + String(slug));
  const inst = REGS[slug].create(options || {});
  const meta = RULES[slug];

  return {
    slug: slug,
    meta: meta,
    /**
     * 落一手。
     * @param {{ seat: 0|1, move: string }} input
     * @returns {{ ok: true, status: { over: boolean, winner: 0|1|2, draw: boolean } }
     *        | { ok: false, error: string, status: object }}
     *   错误优先级：bad_move（座位/走法形状不对）→ game_over → not_your_turn → illegal_move
     */
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
    /** 当前局面（turn / over / winner / draw / moveCount + 该款棋盘快照） */
    view() {
      return inst.view();
    },
    /** 当前该走方的全部合法走法（字符串数组；终局为 []） */
    legalMoves() {
      return inst.legalMoves();
    },
    /** 已应用的走法（[{ seat, move }] 副本） */
    moves() {
      return inst.moves();
    }
  };
}

/**
 * 把整串走法从空局重放一遍——服务端结算的唯一入口。
 *
 * @param {string} slug
 * @param {Array<{ seat: 0|1, move: string }>} moves 按 seq 升序的走法（就是 mapMoves 的输出）
 * @returns {{ ok: boolean, over: boolean, winner: 0|1|2, draw: boolean, error: string,
 *             index: number, moveCount: number, view: object }}
 *   第一个非法走法处 ok:false，error 为该错误码、index 为它在数组里的下标；
 *   全串合法时 ok:true、error:''。未知 slug → error 'bad_game'；moves 不是数组 → 'bad_move'。
 *   未结束时 winner 0 / draw false / over false。
 */
export function judge(slug, moves) {
  if (!isSupported(slug)) {
    return { ok: false, error: 'bad_game', index: -1, over: false, winner: 0, draw: false, moveCount: 0, view: null };
  }
  if (!Array.isArray(moves)) {
    return { ok: false, error: 'bad_move', index: -1, over: false, winner: 0, draw: false, moveCount: 0, view: null };
  }
  const g = createGame(slug);
  for (let i = 0; i < moves.length; i++) {
    const item = moves[i] && typeof moves[i] === 'object' ? moves[i] : {};
    const r = g.apply({ seat: item.seat, move: item.move });
    if (!r.ok) {
      const v = g.view();
      return {
        ok: false, error: r.error, index: i,
        over: v.over, winner: v.winner, draw: v.draw, moveCount: v.moveCount, view: v
      };
    }
  }
  const v = g.view();
  return {
    ok: true, error: '', index: -1,
    over: v.over, winner: v.winner, draw: v.draw, moveCount: v.moveCount, view: v
  };
}

/**
 * 把 createGame().apply() / judge() 的结果翻成服务端的 result 串。
 * 未结束（或调用失败）返回空串；winner 1 → 'host'、winner 2 → 'guest'、平局 → 'draw'。
 */
export function toResult(res) {
  if (!res || !res.ok) return '';
  const s = res.status || res;
  if (!s.over) return '';
  if (s.draw) return 'draw';
  if (s.winner === 1) return 'host';
  if (s.winner === 2) return 'guest';
  return '';
}

function fail(error, inst) {
  return { ok: false, error: error, status: statusOf(inst) };
}
