/**
 * 联机对战数据层（Express / node:sqlite 版）。
 * 与 worker/play-store.js 一一对应：那边每个函数第一个参数是 D1 绑定、全程 await，
 * 这里的 SQL 完全一样，方便两条线对读。规则判定在 src/play.js（两线共享）。
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import {
  STATUS, TTL_WAITING_MS, TTL_PLAYING_MS, CODE_LEN, MAX_MOVES_PER_POLL,
  makeCode, cleanName, cleanGame, cleanCode, cleanMove, cleanResult,
  seatOf, isMyTurn, isExpired, publicRoom, mapMoves, parseWatchKey
} from './play.js';

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

/**
 * 落子：只认「轮到你 + 房间在局中」，不校验走法本身合不合法。
 * result 由客户端判定后带上（'host' / 'guest' / 'draw'），带上即结束这局。
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
  const res = cleanResult(result);
  const seq = Number(r.move_count) + 1;
  db.prepare('INSERT INTO play_moves (room_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)').run(r.id, seq, seat, m, now);
  const done = !!(res);
  const next = {
    turn: done ? Number(r.turn) : 1 - seat,
    move_count: seq,
    status: done ? STATUS.DONE : STATUS.PLAYING,
    result: done ? res : ''
  };
  db.prepare('UPDATE play_rooms SET turn = ?, move_count = ?, status = ?, result = ?, updated_at = ? WHERE id = ?')
    .run(next.turn, next.move_count, next.status, next.result, now, r.id);
  if (done) saveReplay(room(r.id), now);
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
  if (after.status === STATUS.DONE) saveReplay(after, now);
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
