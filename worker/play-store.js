/**
 * 联机对战数据层（Cloudflare Workers + D1 版）。
 * 与 src/play-store.js 一一对应，SQL 完全一样，只有三处区别：
 *   1) 第一个参数是 D1 绑定（env.DB），所有查询都 await；
 *   2) 取自增 id 用 meta.last_row_id，判断是否改动用 meta.changes；
 *   3) 需要多条语句一起成功的地方用 db.batch（D1 没有可交互事务）。
 * 规则判定在 src/play.js（两线共享）。
 */
import {
  STATUS, TTL_WAITING_MS, TTL_PLAYING_MS, CODE_LEN, MAX_MOVES_PER_POLL,
  makeCode, cleanName, cleanGame, cleanCode, cleanMove, cleanResult,
  seatOf, isMyTurn, isExpired, publicRoom, mapMoves
} from '../src/play.js';

/** 绑定参数：D1 的 prepare() 不带参数，必须 bind() 出新的语句对象 */
function stmt(db, sql, params) {
  const st = db.prepare(sql);
  return params && params.length ? st.bind.apply(st, params) : st;
}

async function one(db, sql, params) {
  return (await stmt(db, sql, params).first()) || null;
}

async function run(db, sql, params) {
  return stmt(db, sql, params).run();
}

/** 随机房间码字节：Workers 里没有 node:crypto 的 randomBytes */
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function room(db, id) {
  return one(db, 'SELECT * FROM play_rooms WHERE id = ?', [Number(id)]);
}

async function movesOf(db, id, since, limit = MAX_MOVES_PER_POLL) {
  const res = await stmt(
    db,
    'SELECT seq, seat, move FROM play_moves WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    [Number(id), Number(since) || 0, limit]
  ).all();
  return (res && res.results) || [];
}

/** 顺手清掉过期房间（没有后台任务，就在建房这条冷路径上做） */
export async function sweep(db, now = Date.now()) {
  await run(db, "DELETE FROM play_rooms WHERE status = 'waiting' AND updated_at < ?", [now - TTL_WAITING_MS]);
  await run(db, 'DELETE FROM play_rooms WHERE status <> ? AND updated_at < ?', [STATUS.WAITING, now - TTL_PLAYING_MS]);
}

/** 建房：6 位房间码，撞了就重摇（最多 8 次） */
export async function createRoom(db, game, name, now = Date.now()) {
  const g = cleanGame(game);
  if (!g) return { error: 'bad_game' };
  await sweep(db, now);
  let code = '';
  for (let i = 0; i < 8 && !code; i++) {
    const candidate = makeCode(randomBytes(CODE_LEN));
    const dup = await one(db, 'SELECT 1 AS x FROM play_rooms WHERE code = ?', [candidate]);
    if (!dup) code = candidate;
  }
  if (!code) return { error: 'busy' };
  const token = randomHex(16);
  const info = await run(
    db,
    'INSERT INTO play_rooms (code, game, status, host_name, guest_name, host_token, guest_token, turn, move_count, result, rematch, created_at, updated_at) ' +
      "VALUES (?, ?, 'waiting', ?, '', ?, '', 0, 0, '', 0, ?, ?)",
    [code, g, cleanName(name), token, now, now]
  );
  // 注意：只回 publicRoom + 本人的 token，绝不能把整行丢出去（里面有 host_token/guest_token）
  return { room: publicRoom(await room(db, Number(info.meta.last_row_id)), 0), token, seat: 0 };
}

/** 用房间码加入；座位只有一个，先到先得（UPDATE 里的 guest_token = '' 是并发闸门） */
export async function joinRoom(db, code, name, now = Date.now()) {
  const c = cleanCode(code);
  if (!c) return { error: 'bad_code' };
  const r = await one(db, 'SELECT * FROM play_rooms WHERE code = ?', [c]);
  if (!r) return { error: 'not_found' };
  if (r.status === STATUS.CLOSED || isExpired(r, now)) return { error: 'not_found' };
  if (r.guest_token) return { error: 'full' };
  if (r.status !== STATUS.WAITING) return { error: r.status };
  const token = randomHex(16);
  const info = await run(
    db,
    "UPDATE play_rooms SET guest_name = ?, guest_token = ?, status = 'playing', turn = 0, updated_at = ? WHERE id = ? AND guest_token = ''",
    [cleanName(name), token, now, r.id]
  );
  if (!info.meta.changes) return { error: 'full' };
  return { room: publicRoom(await room(db, r.id), 1), token, seat: 1 };
}

/** 快速匹配：同一局游戏里最早那间空房，没有就自己开一间 */
export async function quickMatch(db, game, name, now = Date.now()) {
  const g = cleanGame(game);
  if (!g) return { error: 'bad_game' };
  const wait = await one(
    db,
    "SELECT code FROM play_rooms WHERE game = ? AND status = 'waiting' AND guest_token = '' ORDER BY id ASC LIMIT 1",
    [g]
  );
  if (wait) {
    const full = await one(db, 'SELECT * FROM play_rooms WHERE code = ?', [wait.code]);
    if (full && !isExpired(full, now)) return { ...(await joinRoom(db, wait.code, name, now)), created: false };
  }
  return { ...(await createRoom(db, g, name, now)), created: true };
}

/** 轮询：返回增量走法，同时刷新心跳（有人在轮询说明这局还活着） */
export async function poll(db, id, token, since, now = Date.now()) {
  const r = await room(db, id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  await run(db, 'UPDATE play_rooms SET updated_at = ? WHERE id = ?', [now, r.id]);
  return { room: publicRoom(r, seat), seat, moves: mapMoves(await movesOf(db, r.id, since)) };
}

/** 落子：只认「轮到你 + 房间在局中」，不校验走法本身合不合法 */
export async function sendMove(db, id, token, move, result, now = Date.now()) {
  const r = await room(db, id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.PLAYING) return { error: r.status === STATUS.DONE || r.status === STATUS.CLOSED ? r.status : 'not_playing' };
  if (!isMyTurn(r, seat)) return { error: 'not_your_turn' };
  const m = cleanMove(move);
  if (!m) return { error: 'bad_move' };
  const res = cleanResult(result);
  const seq = Number(r.move_count) + 1;
  const done = !!res;
  await db.batch([
    stmt(db, 'INSERT INTO play_moves (room_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)', [r.id, seq, seat, m, now]),
    stmt(db, 'UPDATE play_rooms SET turn = ?, move_count = ?, status = ?, result = ?, updated_at = ? WHERE id = ?', [
      done ? Number(r.turn) : 1 - seat, seq, done ? STATUS.DONE : STATUS.PLAYING, done ? res : '', now, r.id
    ])
  ]);
  const after = await room(db, r.id);
  return { room: publicRoom(after, seat), seat, seq, finished: done, result: done ? res : '' };
}

/** 认输：对手获胜；空房（还没人进来）直接关掉 */
export async function resign(db, id, token, now = Date.now()) {
  const r = await room(db, id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status === STATUS.DONE || r.status === STATUS.CLOSED) return { error: r.status };
  const waiting = r.status === STATUS.WAITING;
  await run(db, 'UPDATE play_rooms SET status = ?, result = ?, updated_at = ? WHERE id = ?', [
    waiting ? STATUS.CLOSED : STATUS.DONE, waiting ? '' : seat === 0 ? 'guest' : 'host', now, r.id
  ]);
  return { room: publicRoom(await room(db, r.id), seat), seat };
}

/** 再来一局：两边都点才重开（rematch 是按位存的 1=host / 2=guest） */
export async function rematch(db, id, token, now = Date.now()) {
  const r = await room(db, id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.DONE) return { error: r.status === STATUS.PLAYING ? 'playing' : r.status };
  let bits = Number(r.rematch || 0) | (seat === 0 ? 1 : 2);
  let restarted = false;
  if (bits === 3) {
    await db.batch([
      stmt(db, 'DELETE FROM play_moves WHERE room_id = ?', [r.id]),
      stmt(db, "UPDATE play_rooms SET status = 'playing', turn = 0, move_count = 0, result = '', rematch = 0, updated_at = ? WHERE id = ?", [now, r.id])
    ]);
    bits = 0;
    restarted = true;
  } else {
    await run(db, 'UPDATE play_rooms SET rematch = ?, updated_at = ? WHERE id = ?', [bits, now, r.id]);
  }
  return { room: publicRoom(await room(db, r.id), seat), seat, restarted };
}

/** 离开：关掉房间（对手下一次轮询会看到 closed） */
export async function leave(db, id, token, now = Date.now()) {
  const r = await room(db, id);
  if (!r) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.CLOSED) {
    await run(db, 'UPDATE play_rooms SET status = ?, updated_at = ? WHERE id = ?', [STATUS.CLOSED, now, r.id]);
  }
  return { room: publicRoom(await room(db, r.id), seat), seat };
}
