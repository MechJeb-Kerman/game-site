/**
 * 联机对战数据层（Express / node:sqlite 版）。
 * 与 worker/play-store.js 一一对应：那边每个函数第一个参数是 D1 绑定、全程 await，
 * 这里的 SQL 完全一样，方便两条线对读。共享纯逻辑在 src/play.js、棋类裁判在 src/rules/index.js（都是两线共享）。
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import {
  STATUS, TTL_WAITING_MS, TTL_PLAYING_MS, CODE_LEN, MAX_MOVES_PER_POLL,
  makeCode, cleanName, cleanGame, cleanCode, cleanMove, cleanResult,
  seatOf, isMyTurn, isExpired, publicRoom, mapMoves, parseWatchKey
} from './play.js';
import { isSupported, createGame, toResult } from './rules/index.js';
import { seasonOf, playerKey, blankRating, normRating, nextRatings, ratingRows } from './elo.js';

function room(id) {
  return db.prepare('SELECT * FROM play_rooms WHERE id = ?').get(Number(id)) || null;
}

function movesOf(id, since, limit = MAX_MOVES_PER_POLL) {
  return db
    .prepare('SELECT seq, seat, move FROM play_moves WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(Number(id), Number(since) || 0, limit);
}

/** 顺手清掉过期房间（没有后台任务，就在建房这条冷路径上做） */
export function sweep(now = Date.now()) {
  db.prepare("DELETE FROM play_rooms WHERE status = 'waiting' AND updated_at < ?").run(now - TTL_WAITING_MS);
  db.prepare('DELETE FROM play_rooms WHERE status <> ? AND updated_at < ?').run(STATUS.WAITING, now - TTL_PLAYING_MS);
}

/** 建房：6 位房间码，撞了就重摇（最多 8 次） */
export function createRoom(game, name, now = Date.now()) {
  const g = cleanGame(game);
  if (!g) return { error: 'bad_game' };
  sweep(now);
  let code = '';
  for (let i = 0; i < 8 && !code; i++) {
    const candidate = makeCode(randomBytes(CODE_LEN));
    if (!db.prepare('SELECT 1 FROM play_rooms WHERE code = ?').get(candidate)) code = candidate;
  }
  if (!code) return { error: 'busy' };
  const token = randomBytes(16).toString('hex');
  // watch_token 是观战钥匙的后半截：发给房间里的两位玩家，用来把这一局分享给别人看（只看不走）
  const watch = randomBytes(12).toString('hex');
  const info = db
    .prepare(
      'INSERT INTO play_rooms (code, game, status, host_name, guest_name, host_token, guest_token, turn, move_count, result, rematch, watch_token, replay_id, created_at, updated_at) ' +
      "VALUES (?, ?, 'waiting', ?, '', ?, '', 0, 0, '', 0, ?, 0, ?, ?)"
    )
    .run(code, g, cleanName(name), token, watch, now, now);
  // 注意：只回 publicRoom + 本人的 token，绝不能把 row 整个丢出去（里面有 host_token/guest_token）
  return { room: publicRoom(room(Number(info.lastInsertRowid)), 0), token, seat: 0 };
}

/** 用房间码加入；座位只有一个，先到先得（UPDATE 里的 guest_token = '' 是并发闸门） */
export function joinRoom(code, name, now = Date.now()) {
  const c = cleanCode(code);
  if (!c) return { error: 'bad_code' };
  const r = db.prepare('SELECT * FROM play_rooms WHERE code = ?').get(c);
  if (!r) return { error: 'not_found' };
  if (r.status === STATUS.CLOSED || isExpired(r, now)) return { error: 'not_found' };
  if (r.guest_token) return { error: 'full' };
  if (r.status !== STATUS.WAITING) return { error: r.status };
  const token = randomBytes(16).toString('hex');
  const info = db
    .prepare("UPDATE play_rooms SET guest_name = ?, guest_token = ?, status = 'playing', turn = 0, updated_at = ? WHERE id = ? AND guest_token = ''")
    .run(cleanName(name), token, now, r.id);
  if (!info.changes) return { error: 'full' };
  return { room: publicRoom(room(r.id), 1), token, seat: 1 };
}

/** 快速匹配：同一局游戏里最早那间空房，没有就自己开一间 */
export function quickMatch(game, name, now = Date.now()) {
  const g = cleanGame(game);
  if (!g) return { error: 'bad_game' };
  const wait = db
    .prepare("SELECT code FROM play_rooms WHERE game = ? AND status = 'waiting' AND guest_token = '' ORDER BY id ASC LIMIT 1")
    .get(g);
  if (wait && !isExpired(db.prepare('SELECT * FROM play_rooms WHERE code = ?').get(wait.code), now)) {
    return { ...joinRoom(wait.code, name, now), created: false };
  }
  return { ...createRoom(g, name, now), created: true };
}

/**
 * 对局结束时把整局走法存成一份棋谱，并把 id 写回房间。
 * 一局只存一份：replay_id 有值就直接返回（重赛会把 play_moves 清空并重置 replay_id，
 * 所以「局」的边界是清楚的）。走法在 play_moves 里最多留 2000 手。
 */
export function saveReplay(r, now = Date.now()) {
  if (!r || r.status !== STATUS.DONE) return 0;
  const saved = Number(r.replay_id || 0);
  if (saved) return saved;
  const rows = db
    .prepare('SELECT seat, move FROM play_moves WHERE room_id = ? ORDER BY seq ASC LIMIT 2000')
    .all(r.id);
  if (!rows.length) return 0;
  const info = db
    .prepare(
      'INSERT INTO play_replays (game, room_code, host_name, guest_name, result, move_count, moves, plays, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    )
    .run(r.game, r.code || '', r.host_name || '', r.guest_name || '', r.result || '', rows.length,
      JSON.stringify(rows.map((x) => [Number(x.seat), x.move])), now);
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE play_rooms SET replay_id = ? WHERE id = ?').run(id, r.id);
  return id;
}

/** 棋谱详情：存的是 [[seat, move], …]，读出来还原成走法列表 */
export function replay(id) {
  const row = db.prepare('SELECT * FROM play_replays WHERE id = ?').get(Number(id));
  if (!row) return null;
  let raw = [];
  try { raw = JSON.parse(row.moves || '[]'); } catch { raw = []; }
  const moves = (Array.isArray(raw) ? raw : []).map((x, i) => ({
    seq: i + 1, seat: Number(x && x[0]), move: String((x && x[1]) || '')
  }));
  return {
    id: Number(row.id), game: row.game, code: row.room_code || '',
    hostName: row.host_name || '黑方', guestName: row.guest_name || '白方',
    result: row.result || '', winner: winnerName(row),
    moveCount: Number(row.move_count || moves.length), moves: moves,
    plays: Number(row.plays || 0), createdAt: Number(row.created_at || 0)
  };
}

/** 棋谱列表（某个游戏的最近对局；game 为空则全部） */
export function replayList({ game = '', limit = 12, offset = 0 } = {}) {
  const g = cleanGame(game);
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = g
    ? db.prepare('SELECT id, game, host_name, guest_name, result, move_count, plays, created_at FROM play_replays WHERE game = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(g, lim, off)
    : db.prepare('SELECT id, game, host_name, guest_name, result, move_count, plays, created_at FROM play_replays ORDER BY id DESC LIMIT ? OFFSET ?').all(lim, off);
  const total = g
    ? db.prepare('SELECT COUNT(*) AS n FROM play_replays WHERE game = ?').get(g).n
    : db.prepare('SELECT COUNT(*) AS n FROM play_replays').get().n;
  return { total: Number(total || 0), items: (rows || []).map(replayRow) };
}

function replayRow(row) {
  return {
    id: Number(row.id), game: row.game, hostName: row.host_name || '黑方', guestName: row.guest_name || '白方',
    result: row.result || '', winner: winnerName(row), moveCount: Number(row.move_count || 0),
    plays: Number(row.plays || 0), createdAt: Number(row.created_at || 0)
  };
}

/** 谁赢了（'host' → 房主名，'guest' → 挑战者名，'draw' → 和棋） */
function winnerName(row) {
  const res = String((row && row.result) || '');
  if (res === 'host') return row.host_name || '房主';
  if (res === 'guest') return row.guest_name || '挑战者';
  if (res === 'draw') return '和棋';
  return '';
}

/** 回放被打开一次就记一次，用来排序「热门棋谱」 */
export function bumpReplayPlays(id) {
  db.prepare('UPDATE play_replays SET plays = plays + 1 WHERE id = ?').run(Number(id));
}

/** 观战：凭观战钥匙只读看一局（不占座位、不能落子；钥匙只在房间内部分享） */
export function watchRoom(key, since, now = Date.now()) {
  const k = parseWatchKey(key);
  if (!k) return { error: 'bad_token' };
  const r = room(k.id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  if (!r.watch_token || r.watch_token !== k.token) return { error: 'bad_token' };
  // 有人在看也算这局还活着（不然观众看着看着房间被回收了）
  if (r.status === STATUS.PLAYING) db.prepare('UPDATE play_rooms SET updated_at = ? WHERE id = ?').run(now, r.id);
  return { room: publicRoom(r, -1), moves: mapMoves(movesOf(r.id, since)), watch: true };
}

/** 轮询：返回增量走法，同时刷新心跳（有人在轮询说明这局还活着） */
export function poll(id, token, since, now = Date.now()) {
  const r = room(id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  db.prepare('UPDATE play_rooms SET updated_at = ? WHERE id = ?').run(now, r.id);
  return { room: publicRoom(r, seat), seat, moves: mapMoves(movesOf(r.id, since)) };
}

/** 重建局面时最多回放多少手（draughts 有「25 回合无进展判和」，实际用不到这么多，留足余量） */
const MAX_REPLAY_MOVES = 2000;

/**
 * 按库里已有的走法序列重建局面（服务端裁判用）。
 * 返回 null 表示这份历史不该交给规则引擎判：走法被 LIMIT 截断，或里面有意外的走法
 * （上线前遗留的房间：旧代码只中继、什么字符串都存得下）。调用方据此退回旧的中继行为，
 * 免得把本来没问题的房间卡死；新房间每一手都过引擎，历史里不会再出现非法走法。
 */
function replayGame(slug, rows, moveCount) {
  if (rows.length !== Number(moveCount)) return null;
  const g = createGame(slug);
  for (let i = 0; i < rows.length; i++) {
    if (!g.apply({ seat: Number(rows[i].seat), move: rows[i].move }).ok) return null;
  }
  return g;
}

/**
 * 落子：轮到你 + 房间在局中。
 * connect4 / reversi / draughts / gomoku 有服务端规则引擎：按库里的走法重建局面 → 校验这一手
 * （轮次 / 合法性，非法回引擎的错误码且不落库）→ 终局时按引擎判出的胜负写房间结果，
 * 客户端声明的那份 result 一律不采信。
 * 其余棋类（chess / xiangqi / tictactoe …）没有引擎，沿用旧行为：走法只中继、result 由客户端声明。
 */
export function sendMove(id, token, move, result, now = Date.now()) {
  const r = room(id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.PLAYING) return { error: r.status === STATUS.DONE || r.status === STATUS.CLOSED ? r.status : 'not_playing' };
  if (!isMyTurn(r, seat)) return { error: 'not_your_turn' };
  const m = cleanMove(move);
  if (!m) return { error: 'bad_move' };
  let done = false;
  let res = '';
  const g = isSupported(r.game) ? replayGame(r.game, movesOf(r.id, 0, MAX_REPLAY_MOVES), r.move_count) : null;
  if (g) {
    const judged = g.apply({ seat: seat, move: m });
    if (!judged.ok) return { error: judged.error };
    done = !!judged.status.over;
    res = done ? toResult(judged) : '';
  } else {
    res = cleanResult(result);
    done = !!res;
  }
  const seq = Number(r.move_count) + 1;
  db.prepare('INSERT INTO play_moves (room_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)').run(r.id, seq, seat, m, now);
  const next = {
    turn: done ? Number(r.turn) : 1 - seat,
    move_count: seq,
    status: done ? STATUS.DONE : STATUS.PLAYING,
    result: res
  };
  db.prepare('UPDATE play_rooms SET turn = ?, move_count = ?, status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(next.turn, next.move_count, next.status, next.result, now, r.id);
  if (done) {
    const fin = room(r.id);
    saveReplay(fin, now);
    // Elo 结算：只读 fin 的 game/status/result/昵称，失败也只打一行日志、不影响这次落子的返回
    settleRatings(db, fin, now);
  }
  const after = room(r.id);
  return { room: publicRoom(after, seat), seat, seq, finished: done, result: next.result, replayId: Number(after.replay_id || 0) };
}

/** 认输：对手获胜；空房（还没人进来）直接关掉 */
export function resign(id, token, now = Date.now()) {
  const r = room(id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status === STATUS.DONE || r.status === STATUS.CLOSED) return { error: r.status };
  const done = r.status === STATUS.WAITING;
  db.prepare('UPDATE play_rooms SET status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(done ? STATUS.CLOSED : STATUS.DONE, done ? '' : seat === 0 ? 'guest' : 'host', now, r.id);
  const after = room(r.id);
  if (after.status === STATUS.DONE) {
    saveReplay(after, now);
    settleRatings(db, after, now); // 认输也是「一局结束」：照常结算，否则认输就能躲开分数的变化
  }
  return { room: publicRoom(room(r.id), seat), seat };
}

/** 再来一局：两边都点才重开（rematch 是按位存的 1=host / 2=guest） */
export function rematch(id, token, now = Date.now()) {
  const r = room(id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.DONE) return { error: r.status === STATUS.PLAYING ? 'playing' : r.status };
  let bits = Number(r.rematch || 0) | (seat === 0 ? 1 : 2);
  let restarted = false;
  if (bits === 3) {
    db.prepare('DELETE FROM play_moves WHERE room_id = ?').run(r.id);
    // 重赛 = 新的一局：清空走法，并把上一局的棋谱 id 归零（下一局结束时再存一份新的）
    db.prepare("UPDATE play_rooms SET status = 'playing', turn = 0, move_count = 0, result = '', rematch = 0, replay_id = 0, updated_at = ? WHERE id = ?").run(now, r.id);
    bits = 0;
    restarted = true;
  } else {
    db.prepare('UPDATE play_rooms SET rematch = ?, updated_at = ? WHERE id = ?').run(bits, now, r.id);
  }
  return { room: publicRoom(room(r.id), seat), seat, restarted };
}

/** 离开：关掉房间（对手下一次轮询会看到 closed） */
export function leave(id, token, now = Date.now()) {
  const r = room(id);
  if (!r) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.CLOSED) {
    db.prepare('UPDATE play_rooms SET status = ?, updated_at = ? WHERE id = ?').run(STATUS.CLOSED, now, r.id);
  }
  return { room: publicRoom(room(r.id), seat), seat };
}

// ---------- Elo 评分 / 天梯 / 赛季 ----------
//
// 只有「服务端裁判的棋类 + 一局真的结束了」才结算（sendMove 判出胜负、或认输），读写
// player_ratings / elo_history 两张表（DDL 见 migrations/0010_elo.sql）。算法全在 src/elo.js
// （两条线共用），本段只做「查、算、写」，与 worker/play-store.js 的同名函数一一对应、SQL 一样。
//
// 这一组函数的第一个参数是 db 句柄，而不是像本文件其它函数那样直接用模块级 db 单例：
// 页面侧传 src/db.js 的 db，测试里可以传临时库（两条线签名一致，对读方便）。

/** 读一行评分记录；没有就用起始行当底（返回的一定是完整行） */
function ratingRowOf(db, key, game, season) {
  return normRating(db.prepare(ELO_SELECT).get(key, game, season), blankRating(key, game, season));
}

/** upsert 的参数顺序与 ELO_UPSERT 对齐（updated_at 记结算时间） */
function eloParams(row, now) {
  return [row.userId, row.game, row.season, row.rating, row.games, row.wins, row.losses, row.draws, row.peak, now];
}

/** 报错信息（日志只打一行） */
function messageOf(e) {
  return e && e.message ? String(e.message) : String(e);
}

/** UNIQUE 冲突 = 另一个请求抢先结算了，属于正常情况（不算失败、不写日志） */
function isUniqueError(e) {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(messageOf(e));
}

const ELO_UPSERT = 'INSERT INTO player_ratings (user_id, game, season, rating, games, wins, losses, draws, peak, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(user_id, game, season) DO UPDATE SET rating = excluded.rating, games = excluded.games, ' +
  'wins = excluded.wins, losses = excluded.losses, draws = excluded.draws, peak = excluded.peak, updated_at = excluded.updated_at';
const ELO_HISTORY = 'INSERT INTO elo_history (room_id, game, season, host_id, guest_id, host_delta, guest_delta, host_after, guest_after, result, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const ELO_SELECT = 'SELECT user_id, game, season, rating, games, wins, losses, draws, peak, updated_at ' +
  'FROM player_ratings WHERE user_id = ? AND game = ? AND season = ?';
const ELO_BOARD = 'SELECT user_id, rating, games, wins, losses, draws, peak ' +
  'FROM player_ratings WHERE game = ? AND season = ? ORDER BY rating DESC, games DESC, user_id ASC LIMIT ?';
const ELO_COUNT = 'SELECT COUNT(*) AS n FROM player_ratings WHERE game = ? AND season = ?';

/**
 * 某人某赛季的评分（没有记录就返回起始行 1200 / 0 局，不写库）。
 * @param {object} db node:sqlite 句柄
 * @param {string} game 游戏标识（cleanGame 归一，大小写不敏感）
 * @param {string} userId 身份键：匿名用 playerKey(昵称)，接入账号后用 String(user.id)
 * @param {string} [season] 赛季串（'2026-Q4'），省略 = 当前赛季
 * @returns {{userId: string, game: string, season: string, username: string, rating: number, games: number, wins: number, losses: number, draws: number, peak: number, updatedAt: number}}
 */
export function ratingOf(db, game, userId, season) {
  const g = cleanGame(game);
  const key = String(userId == null ? '' : userId).trim();
  const sea = String(season || '') || seasonOf(Date.now());
  if (!g || !key) return blankRating(key, g, sea);
  return ratingRowOf(db, key, g, sea);
}

/**
 * 天梯榜：分数降序，同分比局数，再同则按身份键升序（顺序稳定，不会两次渲染互换）。
 * @param {object} db node:sqlite 句柄
 * @param {string} game 游戏标识
 * @param {string} [season] 赛季串，省略 = 当前赛季
 * @param {number} [limit=50] 最多几行（1..200）
 * @returns {{game: string, season: string, total: number, items: Array<{rank: number, userId: string, username: string, rating: number, games: number, wins: number, losses: number, draws: number, peak: number}>}}
 *   total = 这个赛季的总人数（不受 limit 影响）；items 的 rank 从 1 开始连续编号。
 */
export function ratingBoard(db, game, season, limit = 50) {
  const g = cleanGame(game);
  const sea = String(season || '') || seasonOf(Date.now());
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);
  if (!g) return { game: '', season: sea, total: 0, items: [] };
  const total = Number(((db.prepare(ELO_COUNT).get(g, sea)) || {}).n || 0);
  return { game: g, season: sea, total, items: ratingRows(db.prepare(ELO_BOARD).all(g, sea, lim)) };
}

/**
 * 结算一局（幂等）。结算条件全中才写库：服务端裁判的棋类（isSupported）+ 房间已结束 +
 * result 是 'host' / 'guest' / 'draw' 之一 + 两边都有非空身份键 + 两边不是同一个人。
 * 不满足其一就跳过（reason 说明原因）；同一 room_id 只结一次——正常路径靠先查后插，
 * elo_history.room_id 的 UNIQUE 索引兜住并发窗口。
 * 绝不抛异常：任何失败只打一行日志并返回 {settled:false, reason:'error'}，结算不该影响接口返回。
 * @param {object} db node:sqlite 句柄
 * @param {object} r play_rooms 的整行（sendMove / resign 里 room(id) 的产物）
 * @param {number} [now] 结算时间（同时决定赛季），默认当前时间
 * @returns {{settled: boolean, reason: string, season?: string, hostDelta?: number, guestDelta?: number, hostAfter?: number, guestAfter?: number}}
 */
export function settleRatings(db, r, now = Date.now()) {
  let roomId = 0;
  let game = '';
  try {
    roomId = r ? Number(r.id) : 0;
    game = cleanGame(r && r.game);
    if (!isSupported(game)) return { settled: false, reason: 'not_judged' };
    if (!r || r.status !== STATUS.DONE) return { settled: false, reason: 'not_done' };
    const result = cleanResult(r.result);
    if (!result) return { settled: false, reason: 'no_result' };
    const hostKey = playerKey(r.host_name);
    const guestKey = playerKey(r.guest_name);
    if (!hostKey || !guestKey || hostKey === guestKey) return { settled: false, reason: 'bad_players' };
    if (!Number.isInteger(roomId) || roomId <= 0) return { settled: false, reason: 'bad_room' };
    const season = seasonOf(now);
    if (db.prepare('SELECT room_id FROM elo_history WHERE room_id = ?').get(roomId)) {
      return { settled: false, reason: 'duplicate' };
    }
    const next = nextRatings(ratingRowOf(db, hostKey, game, season), ratingRowOf(db, guestKey, game, season), result);
    if (!next) return { settled: false, reason: 'no_result' };
    // 三条写一个事务：历史与两份新分要么都落、要么都不落（重赛 / 并发时不会只改一半）
    db.exec('BEGIN');
    try {
      db.prepare(ELO_HISTORY).run(roomId, game, season, hostKey, guestKey, next.hostDelta, next.guestDelta, next.host.rating, next.guest.rating, result, now);
      db.prepare(ELO_UPSERT).run(...eloParams(next.host, now));
      db.prepare(ELO_UPSERT).run(...eloParams(next.guest, now));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* 事务可能已经自己回滚了 */ }
      throw e;
    }
    return {
      settled: true, reason: '', season,
      hostDelta: next.hostDelta, guestDelta: next.guestDelta,
      hostAfter: next.host.rating, guestAfter: next.guest.rating
    };
  } catch (e) {
    if (isUniqueError(e)) return { settled: false, reason: 'duplicate' };
    console.error('[elo] 结算失败 room=' + roomId + ' game=' + game + '：' + messageOf(e));
    return { settled: false, reason: 'error' };
  }
}
