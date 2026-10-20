/**
 * 联机对战数据层（Cloudflare Workers + D1 版）。
 * 与 src/play-store.js 一一对应，SQL 完全一样，只有三处区别：
 *   1) 第一个参数是 D1 绑定（env.DB），所有查询都 await；
 *   2) 取自增 id 用 meta.last_row_id，判断是否改动用 meta.changes；
 *   3) 需要多条语句一起成功的地方用 db.batch（D1 没有可交互事务）。
 * 共享纯逻辑在 src/play.js、棋类裁判在 src/rules/index.js（两线共享）。
 */
import {
  STATUS, TTL_WAITING_MS, TTL_PLAYING_MS, CODE_LEN, MAX_MOVES_PER_POLL,
  makeCode, cleanName, cleanGame, cleanCode, cleanMove, cleanResult,
  seatOf, isMyTurn, isExpired, publicRoom, mapMoves, parseWatchKey
} from '../src/play.js';
import { isSupported, createGame, toResult } from '../src/rules/index.js';

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
  // watch_token 是观战钥匙的后半截：发给房间里的两位玩家，用来把这一局分享给别人看（只看不走）
  const watch = randomHex(12);
  const info = await run(
    db,
    'INSERT INTO play_rooms (code, game, status, host_name, guest_name, host_token, guest_token, turn, move_count, result, rematch, watch_token, replay_id, created_at, updated_at) ' +
      "VALUES (?, ?, 'waiting', ?, '', ?, '', 0, 0, '', 0, ?, 0, ?, ?)",
    [code, g, cleanName(name), token, watch, now, now]
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

/**
 * 对局结束时把整局走法存成一份棋谱，并把 id 写回房间。
 * 一局只存一份：replay_id 有值就直接返回（重赛会把 play_moves 清空并重置 replay_id，
 * 所以「局」的边界是清楚的）。走法在 play_moves 里最多留 2000 手。
 */
export async function saveReplay(db, r, now = Date.now()) {
  if (!r || r.status !== STATUS.DONE) return 0;
  const saved = Number(r.replay_id || 0);
  if (saved) return saved;
  const res = await stmt(db, 'SELECT seat, move FROM play_moves WHERE room_id = ? ORDER BY seq ASC LIMIT 2000', [r.id]).all();
  const rows = (res && res.results) || [];
  if (!rows.length) return 0;
  const info = await run(
    db,
    'INSERT INTO play_replays (game, room_code, host_name, guest_name, result, move_count, moves, plays, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
    [r.game, r.code || '', r.host_name || '', r.guest_name || '', r.result || '', rows.length,
      JSON.stringify(rows.map((x) => [Number(x.seat), x.move])), now]
  );
  const id = Number(info.meta.last_row_id);
  await run(db, 'UPDATE play_rooms SET replay_id = ? WHERE id = ?', [id, r.id]);
  return id;
}

/** 棋谱详情：存的是 [[seat, move], …]，读出来还原成走法列表 */
export async function replay(db, id) {
  const row = await one(db, 'SELECT * FROM play_replays WHERE id = ?', [Number(id)]);
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
export async function replayList(db, { game = '', limit = 12, offset = 0 } = {}) {
  const g = cleanGame(game);
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  const cols = 'id, game, host_name, guest_name, result, move_count, plays, created_at';
  const res = g
    ? await stmt(db, 'SELECT ' + cols + ' FROM play_replays WHERE game = ? ORDER BY id DESC LIMIT ? OFFSET ?', [g, lim, off]).all()
    : await stmt(db, 'SELECT ' + cols + ' FROM play_replays ORDER BY id DESC LIMIT ? OFFSET ?', [lim, off]).all();
  const cnt = g
    ? await one(db, 'SELECT COUNT(*) AS n FROM play_replays WHERE game = ?', [g])
    : await one(db, 'SELECT COUNT(*) AS n FROM play_replays');
  return { total: Number((cnt && cnt.n) || 0), items: ((res && res.results) || []).map(replayRow) };
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
export async function bumpReplayPlays(db, id) {
  await run(db, 'UPDATE play_replays SET plays = plays + 1 WHERE id = ?', [Number(id)]);
}

/** 观战：凭观战钥匙只读看一局（不占座位、不能落子；钥匙只在房间内部分享） */
export async function watchRoom(db, key, since, now = Date.now()) {
  const k = parseWatchKey(key);
  if (!k) return { error: 'bad_token' };
  const r = await room(db, k.id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  if (!r.watch_token || r.watch_token !== k.token) return { error: 'bad_token' };
  // 有人在看也算这局还活着（不然观众看着看着房间被回收了）
  if (r.status === STATUS.PLAYING) await run(db, 'UPDATE play_rooms SET updated_at = ? WHERE id = ?', [now, r.id]);
  return { room: publicRoom(r, -1), moves: mapMoves(await movesOf(db, r.id, since)), watch: true };
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
export async function sendMove(db, id, token, move, result, now = Date.now()) {
  const r = await room(db, id);
  if (!r || isExpired(r, now)) return { error: 'not_found' };
  const seat = seatOf(r, token);
  if (seat < 0) return { error: 'bad_token' };
  if (r.status !== STATUS.PLAYING) return { error: r.status === STATUS.DONE || r.status === STATUS.CLOSED ? r.status : 'not_playing' };
  if (!isMyTurn(r, seat)) return { error: 'not_your_turn' };
  const m = cleanMove(move);
  if (!m) return { error: 'bad_move' };
  let done = false;
  let res = '';
  const g = isSupported(r.game) ? replayGame(r.game, await movesOf(db, r.id, 0, MAX_REPLAY_MOVES), r.move_count) : null;
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
  await db.batch([
    stmt(db, 'INSERT INTO play_moves (room_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)', [r.id, seq, seat, m, now]),
    stmt(db, 'UPDATE play_rooms SET turn = ?, move_count = ?, status = ?, result = ?, updated_at = ? WHERE id = ?', [
      done ? Number(r.turn) : 1 - seat, seq, done ? STATUS.DONE : STATUS.PLAYING, done ? res : '', now, r.id
    ])
  ]);
  if (done) await saveReplay(db, await room(db, r.id), now);
  const after = await room(db, r.id);
  return { room: publicRoom(after, seat), seat, seq, finished: done, result: done ? res : '', replayId: Number(after.replay_id || 0) };
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
  const after = await room(db, r.id);
  if (after.status === STATUS.DONE) await saveReplay(db, after, now);
  return { room: publicRoom(after, seat), seat };
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
      // 重赛 = 新的一局：清空走法，并把上一局的棋谱 id 归零（下一局结束时再存一份新的）
      stmt(db, "UPDATE play_rooms SET status = 'playing', turn = 0, move_count = 0, result = '', rematch = 0, replay_id = 0, updated_at = ? WHERE id = ?", [now, r.id])
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
