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
  seatOf, isMyTurn, isExpired, publicRoom, mapMoves
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
  const info = db
    .prepare(
      'INSERT INTO play_rooms (code, game, status, host_name, guest_name, host_token, guest_token, turn, move_count, result, rematch, created_at, updated_at) ' +
      "VALUES (?, ?, 'waiting', ?, '', ?, '', 0, 0, '', 0, ?, ?)"
    )
    .run(code, g, cleanName(name), token, now, now);
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
  const after = room(r.id);
  return { room: publicRoom(after, seat), seat, seq, finished: done, result: next.result };
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
    db.prepare("UPDATE play_rooms SET status = 'playing', turn = 0, move_count = 0, result = '', rematch = 0, updated_at = ? WHERE id = ?").run(now, r.id);
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
