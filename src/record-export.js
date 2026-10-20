/**
 * src/record-export.js —— 棋谱导出（SGF / PGN / 批量 / tar.gz / 导出任务化）
 *
 * 纯逻辑、零依赖、零 I/O，Express 线（server.js）与 Workers 线（worker/app.js）共用。
 * 输入是 src/play-store.js（或 worker/play-store.js）里那条棋谱记录的形状，字段名逐字复用、不另造：
 *   { id, game, hostName, guestName, result, moveCount, moves:[{seq,seat,move}] | moves:[[seat,move]],
 *     createdAt, plays, ... }   也接受未加工的库行（host_name / guest_name / created_at / moves JSON 串）。
 * result 取值沿用 toResult()：'host' | 'guest' | 'draw' | ''（空串 = 未分胜负/未结束）。
 *
 * ============================================================================================
 * 一、逐款坐标映射表（走法码出处：games/<slug>/index.html 客户端落子编码，与 src/rules/<slug>.js
 *     逐字一致；SGF 点 = 先列字母后行字母，字母 = String.fromCharCode(97 + 下标)）
 * --------------------------------------------------------------------------------------------
 * slug      棋种       客户端走法码原文                             SGF 点换算
 * gomoku    五子棋     "x,y"  x=列 0..14 左→右, y=行 0..14 上→下   [列字母+行字母]   'aa'=左上 'oo'=右下
 *                      （也接受 "3,4" 之类两位数字，正则不 trim）    引擎落点取自 view().last.{x,y}
 * connect4  四子棋     列号字符串 "c"（0..6；也接受 "c,r"，行忽略）  [列字母+行字母]，行 = 引擎落点 view().last.r
 *                      （重力决定行号 r，r=0 是最上面一行）          （idx = r*7+c，7 列 6 行）
 * reversi   黑白棋     "r,c"  r=行 0..7 上→下, c=列 0..7 左→右      [列字母+行字母]
 *                      （也接受 "a1".."h8"：r = 8-数字, c = 字母）   过手 'pass'/'skip'/'-' → 空值：;B[] / ;W[]
 * draughts  国际跳棋   "52-41"，连吃 "52-41-30"：每格两位数字，      多值 [起点][各落点…]
 *                      先 row(0=顶) 后 col(0=左)，'-' 连接整条路径     "52"→ 'cf'（col=2→'c', row=5→'f'）
 *                      强制吃子、兵在落点升王、吃子必须走完极大连跳    注释 C[吃 N]/C[升王] 取自 view().lastMove
 * xiangqi   中国象棋   "x,y-x,y"  x=列 0..8 左→右, y=行 0..9 上→下  多值 [起点][落点]
 *                      红在大 y=7..9（先手 seat 0）、黑在上 y=0..2     '1,7'→ 'hb'（col=1→'b', row=7→'h'）
 * chess     国际象棋   UCI: sqName(from)+sqName(to)+promo            PGN：SAN（默认）或原样 UCI（notation:'uci'）
 *                      'e2e4'、'e7e8q'、王车易位 'e1g1'/'e1c1'         列 a..h = file0..7，行 1..8 = rank+1
 * ============================================================================================
 * 二、SGF 变体与棋盘：GM 取值来自 SGF FF[4] 官方属性表（Properties: GM「Valid numbers are: Go = 1,
 *     Othello = 2, chess = 3, Gomoku+Renju = 4, ... Chinese chess = 7 ...」）；四子棋与国际跳棋
 *     官方没有 GM 编号，用 game-site 私有值 100 / 101（写在文件头，读的时候按本表认）。
 *     SZ：'N' 正方形；'列:行'（Properties: SZ「first number specifies the number of columns」）。
 *       gomoku GM[4]  SZ[15]     connect4 GM[100] SZ[7:6]   reversi GM[2] SZ[8]
 *       draughts GM[101] SZ[8]   xiangqi GM[7] SZ[9:10]      chess → PGN（不出 SGF）
 * ============================================================================================
 * 三、黑白（B/W）与结果：SGF 的 B/W 按棋子颜色，seat 0 永远是先手。
 *     gomoku/connect4/reversi/xiangqi：seat0 → B（黑/红先手）、seat1 → W。
 *     draughts：客户端 seat0 = 白方先手、seat1 = 黑方，所以 seat0 → W、seat1 → B（首个节点是 ;W[...]）。
 *     RE：官方格式（Properties: RE）—— 'B+' / 'W+'（分数可省，官方原文「Score is optional (some games
 *     don't have a score e.g. chess)」）、和棋 '0'、未知 '?'。本模块无分数棋一律写 'B+' / 'W+'。
 *     PGN 结果：host → '1-0'（seat0 执白）、guest → '0-1'、draw → '1/2-1/2'、'' → '*'。
 *     日期：PGN 头部用 'YYYY.MM.DD'（PGN 规范格式），SGF DT 用 ISO 'YYYY-MM-DD'（Properties: DT），
 *     都由 createdAt 毫秒数按 tz（分钟偏移，默认 0 = UTC）算，负数/缺失 → DT[]、Date "????.??.??"。
 * ============================================================================================
 * 四、刻意做出的取舍（细节见各函数注释）
 *   1) 多值落点：跳棋与象棋把「起点+落点」写成同一个属性的多值（;W[cf][be]），SGF 官方
 *      Backgammon(GM[6]) 用 B[骰子][着法] 属同一先例；这样任何一手都能原样还原客户端走法码。
 *   2) draughts 不写 'tt' 之类的过手占位（跳棋没有过手）；reversi 过手写空值 []（Properties: GO 的过手写法）。
 *   3) 单条记录里的非法走法默认整条跳过（ok:false + error），opts.onIllegal === 'truncate' 时截断到
 *      非法步之前并记 warnings —— 降级只发生在「数据缺失/坏」时，不整体抛异常。
 *   4) tar.gz 拆两层：tarOf() 是纯 tar（同步、无 node: 依赖，Worker 线也能用），tarGz()/exportArchive()
 *      是 async，惰性 import node:zlib（用变量拼模块名，Worker 打包器静态解析不到；同 src/attachments.js
 *      的既有约定：共享模块不许在 import 期静态 import node:*）。测试可用 opts.gzip 注入替身。
 *   5) 集合拼接：SGF 与 SGF 之间**零分隔**直接拼成标准集合 (;...)(;...)，其余相邻情况补一个 '\n'
 *      （PGN 自身以 '\n' 收尾，所以两条 PGN 之间正好是一个空行）。
 */

import { createGame, MAX_MOVE_LEN } from './rules/index.js';
import { parsePath as draughtsParsePath } from './rules/draughts.js';
import { parseMove as chessParseMove } from './rules/chess.js';

/** SGF 应用标识（AP[应用名:版本]，官方格式只允许一个冒号） */
export const AP_NAME = 'game-site:record-export';
/** 单条记录最多保留几条错误明细（job/批量共用；只计数不保留明细的部分用 skipped 表示） */
export const MAX_ERRORS = 20;
/** 任务化默认/最大分批条数（与 REPLAY_MAX_LIMIT = 500 对齐） */
export const DEFAULT_BATCH = 200;
export const MAX_BATCH = 500;

/** 五款 SGF 棋：gm = GM 编号，size = SZ，first = seat 0 的颜色，gmNote = 编号出处 */
export const SGF_GAMES = {
  gomoku: { gm: 4, size: '15', first: 'B', gmNote: '官方 GM 4 = Gomoku+Renju' },
  connect4: { gm: 100, size: '7:6', first: 'B', gmNote: '无官方 GM，game-site 私有值 100' },
  reversi: { gm: 2, size: '8', first: 'B', gmNote: '官方 GM 2 = Othello' },
  draughts: { gm: 101, size: '8', first: 'W', gmNote: '无官方 GM，game-site 私有值 101（客户端 seat0 = 白方先手）' },
  xiangqi: { gm: 7, size: '9:10', first: 'B', gmNote: '官方 GM 7 = Chinese chess（B = 红先手）' },
};

/** PGN 棋：目前只有国际象棋 */
export const PGN_GAMES = { chess: { gm: 3, gmNote: '官方 GM 3 = chess（本模块不出 SGF，仅登记）' } };

/** slug → 导出格式（'' = 不支持） */
export const FORMAT_OF = {
  gomoku: 'sgf', connect4: 'sgf', reversi: 'sgf', draughts: 'sgf', xiangqi: 'sgf', chess: 'pgn',
};

/** 任务 filter 允许的字段名：逐字复用 src/play-store.js replayFilters() 的键，不另造 */
export const FILTER_KEYS = ['game', 'player', 'result', 'mine', 'ownerId', 'from', 'to', 'fromMs', 'toMs', 'fromDay', 'toDay'];

/** 这个 slug 导出成什么格式：'sgf' | 'pgn' | ''（不支持） */
export function formatOf(slug) {
  const s = String(slug == null ? '' : slug);
  return FORMAT_OF[s] || '';
}

// ---------------------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function intOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function clamp(n, lo, hi) {
  return n < lo ? lo : (n > hi ? hi : n);
}

function utf8Len(s) {
  return encoder.encode(String(s)).length;
}

/** SGF 属性值转义：simpletext —— 控制字符（含换行）转空格、压空白、转义 '\\' 与 ']' */
export function sgfText(v, maxLen) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s.replace(/[\\\]]/g, function (m) { return '\\' + m; });
}

/** PGN 标签值转义：引号与反斜杠加 '\\'，控制字符转空格（PGN 规范：标签里不得有裸引号） */
export function pgnText(v, maxLen) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s.replace(/([\\"])/g, '\\$1');
}

/**
 * 棋谱记录归一化：同时吃 replay() 的返回形状与未加工的库行（host_name / guest_name / created_at）。
 * 返回 { id, game, hostName, guestName, result, moveCount, moves, createdAt }，不改动入参。
 */
export function recordOf(rec) {
  const r = (rec && typeof rec === 'object') ? rec : {};
  const pick = function (a, b) {
    if (a !== undefined && a !== null && a !== '') return a;
    return b;
  };
  return {
    id: pick(r.id, null),
    game: String(pick(pick(r.game, r.slug), '')),
    hostName: String(pick(pick(r.hostName, r.host_name), '黑方')),
    guestName: String(pick(pick(r.guestName, r.guest_name), '白方')),
    result: String(pick(r.result, '')),
    moveCount: intOr(pick(pick(r.moveCount, r.move_count), 0), 0),
    moves: r.moves,
    createdAt: intOr(pick(pick(r.createdAt, r.created_at), 0), 0),
  };
}

/** 记录 id（数字优先，非数字原样给字符串），用于文件名/errors 明细 */
export function idOf(rec) {
  const r = (rec && typeof rec === 'object') ? rec : {};
  const v = r.id !== undefined && r.id !== null ? r.id : r.recordId;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/** createdAt(ms) + 时区偏移(分钟) → 日期三件套；非法/缺失返回 ok:false */
export function dateOf(createdAt, tzMinutes) {
  const ms = intOr(createdAt, 0);
  if (!(ms > 0)) return { ok: false, ms: 0, iso: '', dot: '', year: 0, month: 0, day: 0 };
  const tz = intOr(tzMinutes, 0);
  const d = new Date(ms + tz * 60000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
  return { ok: true, ms: ms, iso: y + '-' + p2(m) + '-' + p2(day), dot: y + '.' + p2(m) + '.' + p2(day), year: y, month: m, day: day };
}

/** 走法归一化：接受 [{seat,move}] 与 [[seat,move]] 与 JSON 串，非法返回 { ok:false, error } */
function movesOf(rec) {
  let raw = rec.moves;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') raw = [];
    else {
      try { raw = JSON.parse(s); } catch (e) { return { ok: false, error: 'bad_moves', at: -1 }; }
    }
  }
  if (raw === undefined || raw === null) return { ok: false, error: 'missing_moves', at: -1 };
  if (!Array.isArray(raw)) return { ok: false, error: 'bad_moves', at: -1 };
  const list = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    let seatRaw, moveRaw;
    if (Array.isArray(it)) { seatRaw = it[0]; moveRaw = it[1]; }
    else if (it && typeof it === 'object') { seatRaw = it.seat; moveRaw = it.move; }
    else return { ok: false, error: 'bad_moves', at: i };
    const seat = (seatRaw === 0 || seatRaw === '0') ? 0 : ((seatRaw === 1 || seatRaw === '1') ? 1 : -1);
    if (seat < 0) return { ok: false, error: 'bad_moves', at: i };
    if (typeof moveRaw !== 'string' || moveRaw.length === 0 || moveRaw.length > MAX_MOVE_LEN) {
      return { ok: false, error: 'bad_moves', at: i };
    }
    list.push({ seq: i + 1, seat: seat, move: moveRaw });
  }
  return { ok: true, list: list };
}

/** seat → SGF 颜色：seat 0 的颜色由本款棋定（见文件头「三」） */
function seatColors(slug) {
  const meta = SGF_GAMES[slug];
  return (meta && meta.first === 'W') ? ['W', 'B'] : ['B', 'W'];
}

/** 根节点结果：'host'/'guest' 用坐 seat 0/1 的颜色判，和棋 '0'，未知 '?' */
function sgfResultOf(result, colors) {
  const r = String(result || '');
  if (r === 'draw') return '0';
  if (r === 'host') return colors[0] + '+';
  if (r === 'guest') return colors[1] + '+';
  return '?';
}

/** SGF 点：先列字母后行字母（官方：first letter = column left to right, second = row top to bottom） */
function sgfPoint(col, row) {
  if (!(col >= 0 && col < 26 && row >= 0 && row < 26)) return '';
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + row);
}

/** PGN 行棋方结果标记 */
function pgnResultOf(result) {
  const r = String(result || '');
  if (r === 'host') return '1-0';
  if (r === 'guest') return '0-1';
  if (r === 'draw') return '1/2-1/2';
  return '*';
}

function okResult(format, text, extra) {
  const out = { ok: true, format: format, text: text, skipped: 0, error: '', at: -1, warnings: [], bytes: utf8Len(text) };
  if (extra) for (const k in extra) out[k] = extra[k];
  return out;
}

function failResult(format, error, at, detail) {
  return { ok: false, format: format, text: '', skipped: 1, error: String(error || 'bad_record'), at: intOr(at, -1), detail: detail || '', warnings: [], bytes: 0 };
}

// ---------------------------------------------------------------------------------------
// SGF
// ---------------------------------------------------------------------------------------

/** 一手棋 → SGF 点（多值）+ 注释；失败返回 { ok:false, error } */
function sgfPointsOf(slug, mv, view) {
  const v = view || {};
  if (slug === 'gomoku') {
    const last = v.last;
    if (!last) return { ok: false, error: 'bad_move' };
    const p = sgfPoint(intOr(last.x, -1), intOr(last.y, -1));
    return p ? { ok: true, pts: [p], comment: '' } : { ok: false, error: 'bad_move' };
  }
  if (slug === 'connect4') {
    const last = v.last;
    if (!last) return { ok: false, error: 'bad_move' };
    const p = sgfPoint(intOr(last.c, -1), intOr(last.r, -1));
    return p ? { ok: true, pts: [p], comment: '' } : { ok: false, error: 'bad_move' };
  }
  if (slug === 'reversi') {
    if (v.lastPass || !v.last) return { ok: true, pts: [], comment: '过手' };
    const p = sgfPoint(intOr(v.last.c, -1), intOr(v.last.r, -1));
    return p ? { ok: true, pts: [p], comment: '' } : { ok: false, error: 'bad_move' };
  }
  if (slug === 'draughts') {
    const idx = draughtsParsePath(mv.move);
    if (!idx) return { ok: false, error: 'bad_move' };
    const pts = [];
    for (let i = 0; i < idx.length; i++) {
      const p = sgfPoint(idx[i] & 7, idx[i] >> 3);
      if (!p) return { ok: false, error: 'bad_move' };
      pts.push(p);
    }
    const lm = v.lastMove || null;
    const notes = [];
    if (lm && lm.caps && lm.caps.length) notes.push('吃 ' + lm.caps.length);
    if (lm && lm.promote) notes.push('升王');
    return { ok: true, pts: pts, comment: notes.join(' ') };
  }
  if (slug === 'xiangqi') {
    const lm = v.lastMove;
    if (!lm) return { ok: false, error: 'bad_move' };
    const a = sgfPoint(intOr(lm.x1, -1), intOr(lm.y1, -1));
    const b = sgfPoint(intOr(lm.x2, -1), intOr(lm.y2, -1));
    if (!a || !b) return { ok: false, error: 'bad_move' };
    return { ok: true, pts: [a, b], comment: '' };
  }
  return { ok: false, error: 'bad_game' };
}

/**
 * 单条棋谱 → SGF FF[4] 文本（不含结尾换行，以 ')' 收尾，便于集合拼接）。
 * opts: { tz = 0, onIllegal = 'skip' | 'truncate', event, gameName }
 *   注意：GN 恒为记录身份 '<slug> #<id>'（拼成集合后每局仍可辨认），**不取 opts.name**——
 *   name 是上层导出产物的名字（集合文件名 / 归档名 / 作业名）；要自定义棋局名用 opts.gameName。
 * 返回 { ok, format:'sgf', text, skipped, error, at, detail, warnings, bytes, gm, size, moves }
 *   失败（不支持的游戏 / 走法缺失 / 走法非法）→ ok:false, skipped:1，不抛异常。
 */
export function sgfOf(rec, opts) {
  const o = opts || {};
  const r = recordOf(rec);
  const meta = SGF_GAMES[r.game];
  if (!meta) return failResult('sgf', 'bad_game', -1, r.game);
  const mv = movesOf(r);
  if (!mv.ok) return failResult('sgf', mv.error, mv.at, r.game);
  const colors = seatColors(r.game);
  const dt = dateOf(r.createdAt, o.tz);
  const game = createGame(r.game);
  const nodes = [];
  const warnings = [];
  let applied = 0;
  for (let i = 0; i < mv.list.length; i++) {
    const m = mv.list[i];
    const res = game.apply({ seat: m.seat, move: m.move });
    if (!res || !res.ok) {
      if (o.onIllegal === 'truncate') { warnings.push({ at: i, error: (res && res.error) || 'illegal_move' }); break; }
      return failResult('sgf', 'illegal_move', i, (res && res.error ? res.error + ' ' : '') + 'seat=' + m.seat + ' move=' + m.move);
    }
    const p = sgfPointsOf(r.game, m, game.view());
    if (!p.ok) return failResult('sgf', p.error, i, 'seat=' + m.seat + ' move=' + m.move);
    nodes.push(';' + colors[m.seat] + p.pts.map(function (x) { return '[' + x + ']'; }).join('') + (p.comment ? 'C[' + sgfText(p.comment, 32) + ']' : ''));
    applied++;
  }
  const id = idOf(r);
  const gn = r.game + (id === null ? '' : ' #' + id);
  const head = [
    '(;FF[4]',
    'GM[' + meta.gm + ']',
    'CA[UTF-8]',
    'AP[' + AP_NAME + ']',
    'SZ[' + meta.size + ']',
    'DT[' + (dt.ok ? dt.iso : '') + ']',
    'EV[' + sgfText(o.event || 'game-site', 64) + ']',
    'GN[' + sgfText(o.gameName || gn, 128) + ']',
    // PB/PW 跟着颜色映射走：draughts 的 seat 0 执白，所以这里的名字会和 host/guest 顺序互换
    'PB[' + sgfText(seatColors(r.game)[0] === 'B' ? r.hostName : r.guestName, 64) + ']',
    'PW[' + sgfText(seatColors(r.game)[1] === 'W' ? r.guestName : r.hostName, 64) + ']',
    'RE[' + sgfResultOf(r.result, colors) + ']',
  ].join('');
  const text = head + nodes.join('') + ')';
  return okResult('sgf', text, {
    gm: meta.gm, size: meta.size, moves: applied, total: mv.list.length, warnings: warnings,
  });
}

// ---------------------------------------------------------------------------------------
// PGN（仅国际象棋；含 SAN 生成，仓库里原本没有任何 SAN 实现）
// ---------------------------------------------------------------------------------------

function chessFileChar(i) { return String.fromCharCode(97 + (i & 7)); }
function chessRankChar(i) { return String.fromCharCode(49 + (i >> 3)); }
function chessIsWhite(piece) { return piece !== '' && piece === piece.toUpperCase(); }
function chessSameSide(a, b) {
  if (!a || !b) return false;
  return chessIsWhite(a) === chessIsWhite(b);
}

/** 几何可达（不判将军/自将）：只用于 SAN 消歧候选，够用且不会造出假候选 */
function chessPseudoReach(piece, from, to, board) {
  const lower = piece.toLowerCase();
  const df = (to & 7) - (from & 7);
  const dr = (to >> 3) - (from >> 3);
  const adf = Math.abs(df), adr = Math.abs(dr);
  if (chessSameSide(piece, board[to])) return false;
  const clear = function () {
    const sf = Math.sign(df), sr = Math.sign(dr);
    let f = (from & 7) + sf, r = (from >> 3) + sr;
    while ((f & 7) !== (to & 7) || (r >> 3) !== (to >> 3)) {
      if (board[(r << 3) + f]) return false;
      f += sf; r += sr;
    }
    return true;
  };
  if (lower === 'n') return (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
  if (lower === 'k') return adf <= 1 && adr <= 1;
  if (lower === 'p') {
    const dir = chessIsWhite(piece) ? 1 : -1;
    return adf === 1 && dr === dir;
  }
  if (lower === 'r') return (df === 0 || dr === 0) && (df !== 0 || dr !== 0) && clear();
  if (lower === 'b') return adf === adr && adf > 0 && clear();
  if (lower === 'q') return ((df === 0 || dr === 0 || adf === adr) && (df !== 0 || dr !== 0)) && clear();
  return false;
}

/** SAN 消歧后缀：文件字母优先、再行数字、必要时两者都写 */
function chessDisambiguation(board, from, to) {
  const piece = board[from];
  if (!piece || piece.toLowerCase() === 'p' || piece.toLowerCase() === 'k') return '';
  let others = 0, sameFile = 0, sameRank = 0;
  for (let i = 0; i < 64; i++) {
    if (i === from || board[i] !== piece) continue;
    if (!chessPseudoReach(piece, i, to, board)) continue;
    others++;
    if ((i & 7) === (from & 7)) sameFile++;
    if ((i >> 3) === (from >> 3)) sameRank++;
  }
  if (!others) return '';
  const f = chessFileChar(from), r = chessRankChar(from);
  if (sameFile === 0) return f;
  if (sameRank === 0) return r;
  return f + r;
}

/** 一手 → SAN 主体（不含 +/#）：吃子、易位、升变、消歧都在这里 */
function chessSanOf(board, code) {
  const mv = chessParseMove(code);
  if (!mv) return '';
  const piece = board[mv.from] || '';
  if (!piece) return '';
  const lower = piece.toLowerCase();
  if (lower === 'k' && Math.abs((mv.to & 7) - (mv.from & 7)) === 2) {
    return (mv.to & 7) === 6 ? 'O-O' : 'O-O-O';
  }
  const isCapture = !!board[mv.to] || (lower === 'p' && (mv.from & 7) !== (mv.to & 7));
  let s = '';
  if (lower !== 'p') s += piece.toUpperCase() + chessDisambiguation(board, mv.from, mv.to);
  if (isCapture) {
    if (lower === 'p') s += chessFileChar(mv.from);
    s += 'x';
  }
  s += chessSquareName(mv.to);
  if (mv.promo) s += '=' + mv.promo.toUpperCase();
  return s;
}

/** 格子下标 → 棋谱名（'e2'）。注意 chess.js 的 nameSq 是反方向的（名字 → 下标），不能拿它格式化。 */
function chessSquareName(i) {
  return (i >= 0 && i < 64) ? chessFileChar(i) + chessRankChar(i) : '';
}

function wrapTokens(tokens, width) {
  const lines = [];
  let cur = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (cur === '') { cur = t; continue; }
    if (cur.length + 1 + t.length > width) { lines.push(cur); cur = t; }
    else cur += ' ' + t;
  }
  if (cur !== '') lines.push(cur);
  return lines.join('\n');
}

/**
 * 单条棋谱 → PGN 文本（以 '\n' 收尾，两条之间补一个 '\n' 正好是空行）。
 * opts: { tz = 0, notation = 'san' | 'uci', onIllegal = 'skip' | 'truncate', event, site, round }
 *   name 不参与 PGN（记录身份走 [Game] + [RecordId]；name 见 sgfOf 同上，是导出产物名）。
 * 返回 { ok, format:'pgn', text, skipped, error, at, detail, warnings, bytes, moves, result, notation }
 * PGN 标签：Event / Site / Date / Round / White / Black / Result / PlyCount / Termination / Game / RecordId。
 */
export function pgnOf(rec, opts) {
  const o = opts || {};
  const r = recordOf(rec);
  if (!PGN_GAMES[r.game]) return failResult('pgn', 'bad_game', -1, r.game);
  const mv = movesOf(r);
  if (!mv.ok) return failResult('pgn', mv.error, mv.at, r.game);
  const notation = String(o.notation || 'san').toLowerCase() === 'uci' ? 'uci' : 'san';
  const game = createGame(r.game);
  const tokens = [];
  const warnings = [];
  const board = [];
  const view0 = game.view();
  for (let i = 0; i < 64; i++) board.push(view0 && view0.board ? view0.board[i] : '');
  let applied = 0;
  let over = !!(view0 && view0.over);
  for (let i = 0; i < mv.list.length; i++) {
    const m = mv.list[i];
    const san = chessSanOf(board, m.move);
    const res = game.apply({ seat: m.seat, move: m.move });
    if (!res || !res.ok) {
      if (o.onIllegal === 'truncate') { warnings.push({ at: i, error: (res && res.error) || 'illegal_move' }); break; }
      return failResult('pgn', 'illegal_move', i, (res && res.error ? res.error + ' ' : '') + 'seat=' + m.seat + ' move=' + m.move);
    }
    const v = game.view();
    for (let k = 0; k < 64; k++) board[k] = v.board ? v.board[k] : '';
    let suffix = '';
    if (v.over && v.kind === 'mate') suffix = '#';
    else if (!v.over && v.check) suffix = '+';
    if (m.seat === 0) tokens.push((Math.floor(i / 2) + 1) + '.');
    tokens.push(notation === 'uci' ? m.move : (san || m.move) + suffix);
    applied++;
    over = !!v.over;
  }
  const dt = dateOf(r.createdAt, o.tz);
  const id = idOf(r);
  const result = pgnResultOf(r.result);
  const tags = [
    ['Event', String(o.event || 'game-site 联机对战')],
    ['Site', String(o.site || 'game-site')],
    ['Date', dt.ok ? dt.dot : '????.??.??'],
    ['Round', String(o.round || '-')],
    ['White', r.hostName],
    ['Black', r.guestName],
    ['Result', result],
    ['PlyCount', String(applied)],
    ['Termination', over ? 'normal' : 'unterminated'],
    ['Game', r.game],
    ['RecordId', id === null ? '' : String(id)],
  ];
  const header = tags.map(function (t) { return '[' + t[0] + ' "' + pgnText(t[1], 128) + '"]'; }).join('\n');
  const movetext = wrapTokens(tokens, 80);
  const body = (movetext === '' ? '' : movetext + ' ') + result;
  const text = header + '\n\n' + body + '\n';
  return okResult('pgn', text, {
    moves: applied, total: mv.list.length, result: result, notation: notation, warnings: warnings,
  });
}

/**
 * 按 game 自动分派导出一条记录。opts.format 给 'sgf'|'pgn' 时强制格式（不匹配 → format_mismatch）。
 * 返回形状与 sgfOf/pgnOf 一致，失败时 format 为该记录应有的格式或 ''。
 */
export function exportText(rec, opts) {
  const o = opts || {};
  const r = recordOf(rec);
  const slug = r.game;
  const fmt = formatOf(slug);
  if (!fmt) return failResult('', 'bad_game', -1, slug);
  const want = String(o.format || 'auto').toLowerCase();
  if (want !== 'auto' && want !== '' && want !== fmt) return failResult(fmt, 'format_mismatch', -1, fmt + ' != ' + want);
  return fmt === 'sgf' ? sgfOf(r, o) : pgnOf(r, o);
}

// ---------------------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------------------

function sepOf(prevFormat, nextFormat) {
  return (prevFormat === 'sgf' && nextFormat === 'sgf') ? '' : '\n';
}

/** 一批记录 → 分块（内部用，exportMany / exportArchive 共享同一遍转换） */
function collect(records, opts) {
  const list = Array.isArray(records) ? records : [];
  const chunks = [];
  const errors = [];
  const formats = { sgf: 0, pgn: 0 };
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const r = exportText(list[i], opts);
    if (!r.ok) {
      skipped++;
      if (errors.length < MAX_ERRORS) errors.push({ id: idOf(list[i]), index: i, error: r.error, at: r.at, detail: r.detail });
      continue;
    }
    formats[r.format]++;
    chunks.push({ format: r.format, text: r.text, id: idOf(list[i]), game: recordOf(list[i]).game });
  }
  let text = '';
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) text += sepOf(chunks[i - 1].format, chunks[i].format);
    text += chunks[i].text;
  }
  const count = chunks.length;
  const format = count === 0 ? '' : (formats.sgf > 0 && formats.pgn > 0 ? 'mixed' : (formats.sgf > 0 ? 'sgf' : 'pgn'));
  return {
    ok: count > 0, format: format, text: text, count: count, skipped: skipped,
    errors: errors, formats: formats, chunks: chunks, bytes: utf8Len(text),
    partial: skipped > 0 && count > 0,
  };
}

/**
 * 多条棋谱 → 一个文本产物：SGF 之间零分隔直接拼成 (;...)(;...)，其余相邻补 '\n'（PGN 之间即空行）。
 * 返回 { ok, format:'sgf'|'pgn'|'mixed'|'', text, count, skipped, errors, formats, bytes, partial }
 */
export function exportMany(records, opts) {
  const c = collect(records, opts);
  return {
    ok: c.ok, format: c.format, text: c.text, count: c.count, skipped: c.skipped,
    errors: c.errors, formats: c.formats, bytes: c.bytes, partial: c.partial,
  };
}

// ---------------------------------------------------------------------------------------
// tar / tar.gz（ustar 格式，Node 内置 zlib；Worker 线只用 tarOf 或不打包）
// ---------------------------------------------------------------------------------------

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data == null ? '' : data));
}

function octal(v, len) {
  const s = Math.trunc(v).toString(8);
  if (s.length > len - 1) throw new Error('record-export: tar 字段溢出（' + v + '）');
  return '0'.repeat(len - 1 - s.length) + s + '\0';
}

function padTo512(n) {
  const r = n % 512;
  return r === 0 ? new Uint8Array(0) : new Uint8Array(512 - r);
}

/**
 * 纯 tar（ustar，POSIX.1-1988）：entries = [{ name, data: string|Uint8Array, mtime?, mode? }]。
 * 同步、无 node: 依赖，两条线都能跑；不带 gzip（要 gzip 用 tarGz）。mtime 默认 0（产物可复现）。
 * 只支持常规文件、条目名 ≤ 100 字节（不写 ustar prefix / PAX 扩展）。
 */
export function tarOf(entries, opts) {
  const o = opts || {};
  const baseMtime = intOr(o.mtime, 0);
  const list = Array.isArray(entries) ? entries : [];
  const parts = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    const name = String(e.name == null ? '' : e.name);
    const nameBytes = encoder.encode(name);
    if (!name || nameBytes.length > 100) {
      throw new Error('record-export: tar 条目名必须是 1..100 字节（当前 ' + nameBytes.length + '）：' + name);
    }
    const data = toBytes(e.data);
    const header = new Uint8Array(512);
    header.set(nameBytes, 0);
    header.set(encoder.encode(octal(e.mode === undefined ? 0o644 : e.mode, 8)), 100);
    header.set(encoder.encode(octal(0, 8)), 108);
    header.set(encoder.encode(octal(0, 8)), 116);
    header.set(encoder.encode(octal(data.length, 12)), 124);
    header.set(encoder.encode(octal(intOr(e.mtime, baseMtime), 12)), 136);
    header.set(encoder.encode('        '), 148);
    header.set(encoder.encode('0'), 156);
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    header.set(encoder.encode('game-site\0'), 265);
    header.set(encoder.encode('game-site\0'), 297);
    header.set(encoder.encode(octal(0, 8)), 329);
    header.set(encoder.encode(octal(0, 8)), 337);
    let sum = 0;
    for (let k = 0; k < 512; k++) sum += header[k];
    header.set(encoder.encode(octal(sum, 7) + ' '), 148);
    parts.push(header, data, padTo512(data.length));
    total += 512 + data.length + padTo512(data.length).length;
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(total + 1024);
  let off = 0;
  for (let i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
  return out;
}

let gzipImpl;
let gzipProbed = false;

/** 惰性取 node:zlib（变量拼模块名 → Worker 打包器静态解析不到，同 src/attachments.js 的约定） */
async function defaultGzip() {
  if (gzipProbed) return gzipImpl;
  gzipProbed = true;
  try {
    const name = 'node:' + 'zlib';
    const mod = await import(name);
    gzipImpl = function (bytes, level) { return mod.gzipSync(bytes, { level: level }); };
  } catch (e) {
    gzipImpl = null;
  }
  return gzipImpl;
}

/**
 * tar + gzip（Node 内置 zlib，不加依赖）。async！
 * opts.gzip 可注入替身 (bytes, level) => Uint8Array（测试用；Worker 线也能借此绕开 zlib）。
 * Worker 线没有 zlib 时抛错 —— 那一条线上请用 tarOf() 出未压缩 tar，或注入 opts.gzip。
 */
export async function tarGz(entries, opts) {
  const o = opts || {};
  const raw = tarOf(entries, o);
  const impl = (typeof o.gzip === 'function') ? o.gzip : await defaultGzip();
  if (typeof impl !== 'function') {
    throw new Error('record-export: 当前运行时没有 zlib，无法 gzip（请用 tarOf 或注入 opts.gzip）');
  }
  const out = impl(raw, clamp(intOr(o.level, 9), 1, 9));
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

function safeName(s, maxLen) {
  const t = String(s == null ? '' : s).replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^[._]+/, '').slice(0, maxLen || 48);
  return t || 'x';
}

/**
 * 多条棋谱 → .tar.gz：内含每个条目的单独文件 <slug>-<id>.<sgf|pgn>，外加同格式时的一份集合文件
 * <name>.<ext>（内容与 exportMany 一致，方便整包导入）。async（要走 gzip）。
 * 返回 { ok, format, text, count, skipped, errors, files:[{name,size,id,game,format}],
 *        archive: Uint8Array, archiveBytes, name, entryCount, tarEntries:[{name,data}] }
 *  tarEntries 是给 tarOf() 用的原始条目表（Worker 线没有 zlib 时可以拿它出未压缩 tar）。
 */
export async function exportArchive(records, opts) {
  const o = opts || {};
  const c = collect(records, o);
  const base = safeName(o.name || 'replays', 48);
  const entries = [];
  const files = [];
  const used = Object.create(null);
  for (let i = 0; i < c.chunks.length; i++) {
    const ch = c.chunks[i];
    const ext = ch.format;
    const stem = safeName(ch.game || 'game', 24) + '-' + safeName(ch.id === null ? String(i + 1) : String(ch.id), 24);
    let name = stem + '.' + ext;
    let n = 2;
    while (used[name]) { name = stem + '-' + n + '.' + ext; n++; }
    used[name] = true;
    entries.push({ name: name, data: ch.text, mtime: o.mtime });
    files.push({ name: name, size: utf8Len(ch.text), id: ch.id, game: ch.game, format: ch.format });
  }
  let collection = '';
  if (c.count > 0 && c.format !== 'mixed') {
    collection = base + '.' + c.format;
    entries.unshift({ name: collection, data: c.text, mtime: o.mtime });
  }
  const archive = await tarGz(entries, o);
  return {
    ok: entries.length > 0, format: c.format, text: c.text, count: c.count, skipped: c.skipped,
    errors: c.errors, files: files, archive: archive, archiveBytes: archive.length,
    name: base + '.tar.gz', entryCount: entries.length, tarEntries: entries,
    collection: collection, bytes: c.bytes,
  };
}

// ---------------------------------------------------------------------------------------
// 导出任务化（大库分批；job 是纯 JSON，可存起来中断后按游标续跑）
// ---------------------------------------------------------------------------------------

function randTag(seed) {
  const r = Math.random().toString(36).slice(2, 6);
  return (r + '0000').slice(0, 4);
}

/**
 * 建导出任务。input: { filter, now, format, notation, tz, batch, name, onIllegal }
 *  - filter 的键逐字复用 replayFilters()（见 FILTER_KEYS），空值会被丢掉；
 *  - now 缺省 Date.now()（纯逻辑优先传 now，便于测试与复现）；
 *  - format 'auto'（默认，按每条记录的 game 分派）/ 'sgf' / 'pgn'（不匹配的条目降级为 format_mismatch 跳过）。
 * 返回 job：{ id, format, notation, tz, name, filter, now, createdAt, batch, cursor:0, total:null,
 *            exported:0, skipped:0, batches:0, chars:0, lastFormat:'', done:false, errors:[] }
 */
export function createExportJob(input) {
  const inp = input || {};
  const now = intOr(inp.now, Date.now());
  const src = (inp.filter && typeof inp.filter === 'object') ? inp.filter : {};
  const filter = {};
  for (let i = 0; i < FILTER_KEYS.length; i++) {
    const k = FILTER_KEYS[i];
    const v = src[k];
    if (v === undefined || v === null || v === '') continue;
    filter[k] = v;
  }
  const format = ['sgf', 'pgn'].indexOf(String(inp.format || '').toLowerCase()) >= 0 ? String(inp.format).toLowerCase() : 'auto';
  const notation = String(inp.notation || '').toLowerCase() === 'uci' ? 'uci' : 'san';
  const onIllegal = inp.onIllegal === 'truncate' ? 'truncate' : 'skip';
  return {
    id: 'exp-' + now.toString(36) + '-' + randTag(now),
    kind: 'record-export',
    format: format,
    notation: notation,
    tz: intOr(inp.tz, 0),
    name: safeName(inp.name || 'replays', 48),
    filter: filter,
    now: now,
    createdAt: now,
    batch: clamp(intOr(inp.batch, DEFAULT_BATCH), 1, MAX_BATCH),
    cursor: 0,
    total: null,
    exported: 0,
    skipped: 0,
    batches: 0,
    chars: 0,
    lastFormat: '',
    done: false,
    errors: [],
  };
}

/** job → 进度快照（percent：总数已知时按游标算，未知时未完成给 null、已完成给 100） */
export function progressOf(job) {
  const j = job || {};
  const total = (j.total === null || j.total === undefined) ? null : intOr(j.total, 0);
  const cursor = intOr(j.cursor, 0);
  let percent = null;
  if (total !== null && total > 0) percent = clamp(Math.round((cursor / total) * 100), 0, 100);
  else if (j.done) percent = 100;
  return {
    total: total, cursor: cursor, exported: intOr(j.exported, 0), skipped: intOr(j.skipped, 0),
    batches: intOr(j.batches, 0), chars: intOr(j.chars, 0), percent: percent, done: !!j.done,
    errors: Array.isArray(j.errors) ? j.errors.length : 0,
  };
}

function jobOptions(job) {
  return { format: job.format, notation: job.notation, tz: job.tz, onIllegal: job.onIllegal || 'skip' };
}

function jobFail(job, row, error, at, detail) {
  job.skipped++;
  if (!Array.isArray(job.errors)) job.errors = [];
  if (job.errors.length < MAX_ERRORS) {
    job.errors.push({ id: idOf(row), error: String(error || 'error'), at: intOr(at, -1), detail: detail ? String(detail).slice(0, 120) : '' });
  }
}

function mergeRow(rec, row) {
  if (!row || typeof row !== 'object') return rec;
  if (!rec || typeof rec !== 'object') return row;
  const out = {};
  for (const k in row) out[k] = row[k];
  for (const k in rec) {
    const v = rec[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * 跑一批导出。runtime: { store: { list(query) -> {total, items}, load?(id) -> record }, batch? }
 *  - store.list 收到 { ...job.filter, offset: job.cursor, limit: batch }（与 replayList 的参数名一致）；
 *  - 每条 load(id) 取走法（play-store 的 list 不给 moves），load 缺失/返回 null/转换失败 → 跳过并计数；
 *  - 游标按**读到的行数**前进，坏条目不会把游标卡死；exported + skipped === cursor 恒成立；
 *  - total 未知时用「本批不足 batch 条」判定收尾；job 可 JSON 序列化后按游标续跑。
 * 返回 { done, produced, cursor, progress }：produced 是这一批的文本，按 job.lastFormat 与上一批正确衔接。
 */
export async function runExportJob(job, runtime) {
  if (!job || typeof job !== 'object') throw new Error('record-export: runExportJob 需要 job 对象');
  const rt = runtime || {};
  const store = rt.store;
  if (!store || typeof store.list !== 'function') throw new Error('record-export: runExportJob 需要 { store: { list, load? } }');
  const batch = clamp(intOr(rt.batch, intOr(job.batch, DEFAULT_BATCH)), 1, MAX_BATCH);
  job.batch = batch;
  if (!Array.isArray(job.errors)) job.errors = [];
  if (job.done) return { done: true, produced: '', cursor: intOr(job.cursor, 0), progress: progressOf(job) };
  const query = {};
  const f = job.filter || {};
  for (const k in f) query[k] = f[k];
  query.offset = intOr(job.cursor, 0);
  query.limit = batch;
  const page = await store.list(query);
  if (page && page.total !== undefined && page.total !== null && Number.isFinite(Number(page.total))) {
    job.total = Math.max(0, Math.trunc(Number(page.total)));
  }
  const items = (page && Array.isArray(page.items)) ? page.items : [];
  let produced = '';
  let prevFormat = (intOr(job.chars, 0) > 0 && job.lastFormat) ? job.lastFormat : '';
  let consumed = 0;
  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    consumed++;
    let rec = null;
    if (typeof store.load === 'function') {
      try {
        rec = await store.load(idOf(row), row);
      } catch (e) {
        jobFail(job, row, 'load_failed', -1, (e && e.message) || e);
        continue;
      }
    } else {
      rec = row;
    }
    if (!rec) { jobFail(job, row, 'missing_record', -1, ''); continue; }
    const res = exportText(mergeRow(rec, row), jobOptions(job));
    if (!res.ok) { jobFail(job, row, res.error, res.at, res.detail); continue; }
    if (prevFormat) produced += sepOf(prevFormat, res.format);
    produced += res.text;
    prevFormat = res.format;
    job.exported = intOr(job.exported, 0) + 1;
    job.chars = intOr(job.chars, 0) + res.text.length;
  }
  job.cursor = intOr(job.cursor, 0) + consumed;
  job.batches = intOr(job.batches, 0) + 1;
  if (prevFormat) job.lastFormat = prevFormat;
  if (items.length === 0) job.done = true;
  else if (job.total !== null && job.cursor >= intOr(job.total, 0)) job.done = true;
  else if (items.length < batch) job.done = true;
  else job.done = false;
  return { done: !!job.done, produced: produced, cursor: job.cursor, progress: progressOf(job) };
}

// ---------------------------------------------------------------------------------------
// play-store 适配器（两条线同名不同签名：worker 版首参是 db）
// ---------------------------------------------------------------------------------------

/**
 * 把 src/play-store.js 或 worker/play-store.js 包成任务化要的 store。
 *   Express： playStoreAdapter(require('../src/play-store.js'))
 *   Workers： playStoreAdapter(workerPlayStore, { db: env.DB })
 * 返回 { list(query) -> { total, items }, load(id) -> record }。
 * 注意：replayList 的 limit 会被 maxLimit 夹住（play-store 默认 50、上限 500），这里显式传 maxLimit。
 */
export function playStoreAdapter(ps, opts) {
  if (!ps || typeof ps.replayList !== 'function') throw new Error('record-export: playStoreAdapter 需要 play-store 模块');
  const o = opts || {};
  const db = o.db;
  const maxLimit = clamp(intOr(o.maxLimit, MAX_BATCH), 1, MAX_BATCH);
  return {
    async list(query) {
      const q = {};
      const src = query || {};
      for (const k in src) q[k] = src[k];
      q.limit = clamp(intOr(src.limit, intOr(o.batch, DEFAULT_BATCH)), 1, maxLimit);
      q.maxLimit = maxLimit;
      const page = db ? await ps.replayList(db, q) : await ps.replayList(q);
      const totalRaw = page ? Number(page.total) : NaN;
      const items = (page && Array.isArray(page.items)) ? page.items : [];
      return { total: Number.isFinite(totalRaw) ? totalRaw : -1, items: items };
    },
    async load(id) {
      if (id === null || id === undefined) return null;
      return db ? await ps.replay(db, id) : await ps.replay(id);
    },
  };
}
