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
import { seasonOf, playerKey, blankRating, normRating, nextRatings, ratingRows } from '../src/elo.js';

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

/**
 * 房间里的玩家 id：0 = 未登录 / 匿名（老调用点不传 opts 时就是这个值，落库行为与改前逐字相同）。
 * 非数字 / NaN / 负数 / 小数都归一成 0 或正整数，避免把脏值写进库。
 */
function userIdOf(opts) {
  const n = Number((opts && opts.userId) || 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 建房：6 位房间码，撞了就重摇（最多 8 次）；opts.userId 是建房者的账号 id（0 = 匿名） */
export async function createRoom(db, game, name, now = Date.now(), opts = {}) {
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
    'INSERT INTO play_rooms (code, game, status, host_name, guest_name, host_token, guest_token, turn, move_count, result, rematch, watch_token, replay_id, host_user_id, guest_user_id, created_at, updated_at) ' +
      "VALUES (?, ?, 'waiting', ?, '', ?, '', 0, 0, '', 0, ?, 0, ?, 0, ?, ?)",
    [code, g, cleanName(name), token, watch, userIdOf(opts), now, now]
  );
  // 注意：只回 publicRoom + 本人的 token，绝不能把整行丢出去（里面有 host_token/guest_token）
  return { room: publicRoom(await room(db, Number(info.meta.last_row_id)), 0), token, seat: 0 };
}

/** 用房间码加入；座位只有一个，先到先得（UPDATE 里的 guest_token = '' 是并发闸门）；opts.userId 是加入者的账号 id（0 = 匿名） */
export async function joinRoom(db, code, name, now = Date.now(), opts = {}) {
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
    "UPDATE play_rooms SET guest_name = ?, guest_user_id = ?, guest_token = ?, status = 'playing', turn = 0, updated_at = ? WHERE id = ? AND guest_token = ''",
    [cleanName(name), userIdOf(opts), token, now, r.id]
  );
  if (!info.meta.changes) return { error: 'full' };
  return { room: publicRoom(await room(db, r.id), 1), token, seat: 1 };
}

/** 快速匹配：同一局游戏里最早那间空房，没有就自己开一间；opts.userId 原样带给 joinRoom / createRoom */
export async function quickMatch(db, game, name, now = Date.now(), opts = {}) {
  const g = cleanGame(game);
  if (!g) return { error: 'bad_game' };
  const wait = await one(
    db,
    "SELECT code FROM play_rooms WHERE game = ? AND status = 'waiting' AND guest_token = '' ORDER BY id ASC LIMIT 1",
    [g]
  );
  if (wait) {
    const full = await one(db, 'SELECT * FROM play_rooms WHERE code = ?', [wait.code]);
    if (full && !isExpired(full, now)) return { ...(await joinRoom(db, wait.code, name, now, opts)), created: false };
  }
  return { ...(await createRoom(db, g, name, now, opts)), created: true };
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
  // 玩家 id 优先取显式字段（r.hostUserId / r.guestUserId），其次取房间行的原始列
  // （内部调用传的就是 room(db, id) 整行，列名是 snake_case），都没有 = 0 = 匿名 / 老调用
  const hostUserId = userIdOf({ userId: r.hostUserId !== undefined ? r.hostUserId : r.host_user_id });
  const guestUserId = userIdOf({ userId: r.guestUserId !== undefined ? r.guestUserId : r.guest_user_id });
  const res = await stmt(db, 'SELECT seat, move FROM play_moves WHERE room_id = ? ORDER BY seq ASC LIMIT 2000', [r.id]).all();
  const rows = (res && res.results) || [];
  if (!rows.length) return 0;
  const info = await run(
    db,
    'INSERT INTO play_replays (game, room_code, host_name, guest_name, result, move_count, moves, plays, host_user_id, guest_user_id, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [r.game, r.code || '', r.host_name || '', r.guest_name || '', r.result || '', rows.length,
      JSON.stringify(rows.map((x) => [Number(x.seat), x.move])), hostUserId, guestUserId, now]
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

/* ---------- 棋谱检索（第九批：按玩家 / 日期 / 结果检索 + JSON 导出） ---------- */
/* 这一段与 src/play-store.js 的同名段落逐字对应，只是全程 await + 首参是 D1 绑定。 */

/** JSON 导出的硬上限（页面翻页仍是 50 夹紧；导出默认 200、最多 500） */
export const REPLAY_MAX_LIMIT = 500;

/** 查询参数取单值：数组取第一个，其它非字符串当空串（与 Express 的 req.query 同口径） */
function paramOne(v) {
  if (Array.isArray(v)) v = v.length ? v[0] : '';
  if (v == null || typeof v === 'object') return '';
  return String(v);
}

/**
 * 时间参数 → 毫秒时间戳；解析不了返回 null（调用方忽略这一项，不报错）。
 * 认两种写法：纯数字（毫秒；小于 1e11 当秒级时间戳再乘 1000）+ YYYY-MM-DD（服务器本地日的边界）。
 * end=true 取当天 23:59:59.999（用次日 0 点减 1ms，跨夏令时不会丢一天）。
 */
function replayTime(v, end) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d{1,16}$/.test(s)) {
    let n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e11) n *= 1000;
    return Math.floor(n);
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;  // 2026-02-31 这类回读挡掉
  return end ? new Date(y, mo - 1, d + 1).getTime() - 1 : dt.getTime();
}

/** 毫秒 → YYYY-MM-DD（本地日，给 <input type="date"> 回填） */
function replayDay(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 棋谱筛选条件（页面 / 翻页链接 / JSON 导出共用；src/play-store.js 有一份逐字镜像）。
 * - game：只认六款裁判棋的 slug（src/rules 的 SLUGS），其它当没传；
 * - player：昵称子串匹配（LIKE，ASCII 大小写不敏感），命中 host_name 或 guest_name 任一边；
 * - result：只认 host / guest / draw；
 * - from / to：YYYY-MM-DD 或数字时间戳，闭区间，解析不了的忽略；
 * - mine：'1' / 'on' / 'true' =「只看我的」，匹配谁由调用方按登录用户算（见 replayList 的 mine / ownerId）。
 * 「只看我的」的口径（第十批改成账号级）：play_replays 有 host_user_id / guest_user_id 两列
 * （0 = 匿名 / 这次改动之前落的老棋谱），登录用户按 id 匹配（ownerId），改昵称也认；
 * 老棋谱那两列是 0，所以调用方把昵称一起传（mine）在同一组 OR 里兜底 —— 昵称不唯一，回退不保证不误命中。
 */
export function replayFilters(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const want = paramOne(r.result);
  const mineRaw = paramOne(r.mine).trim().toLowerCase();
  const fromRaw = paramOne(r.from).trim();
  const toRaw = paramOne(r.to).trim();
  const fromMs = replayTime(fromRaw, false);
  const toMs = replayTime(toRaw, true);
  return {
    game: cleanGame(paramOne(r.game)),
    player: paramOne(r.player).trim().slice(0, 32),
    result: want === 'host' || want === 'guest' || want === 'draw' ? want : '',
    mine: mineRaw === '1' || mineRaw === 'on' || mineRaw === 'true',
    from: fromRaw,                          // 原样回显（表单 / 翻页链接 / 导出链接）
    to: toRaw,
    fromMs: fromMs,                         // null 或毫秒（SQL 用）
    toMs: toMs,
    fromDay: replayDay(fromMs),             // 给 <input type="date"> 的值
    toDay: replayDay(toMs)
  };
}

/**
 * 棋谱列表（game / player / result / 日期区间过滤，id 倒序）。
 * 旧调用 replayList(db, { game, limit, offset })：筛选条件（WHERE 的文本与参数顺序）与夹紧口径逐字没变；
 * 返回的行多了 hostUserId / guestUserId 两个字段（第十批的账号级绑定，见 replayRow）。
 * @param {object} [opts] replayFilters 的那些原始参数，外加
 *   limit（默认 12，夹 1..maxLimit）、offset（≥0）、maxLimit（默认 50，夹 1..REPLAY_MAX_LIMIT，导出传 500）、
 *   mine（登录用户名数组：host_name / guest_name 精确匹配其中之一，空数组 = 不筛；老棋谱的用户列是 0，靠它兜底）、
 *   ownerId（登录用户 id：> 0 时按 host_user_id / guest_user_id 匹配；与 mine 同时给就并进同一组 OR）
 */
export async function replayList(db, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const f = replayFilters(o);
  const cap = Math.min(Math.max(Number(o.maxLimit) || 50, 1), REPLAY_MAX_LIMIT);
  const lim = Math.min(Math.max(Number(o.limit) || 12, 1), cap);
  const off = Math.max(Number(o.offset) || 0, 0);

  const where = [];
  const params = [];
  if (f.game) { where.push('game = ?'); params.push(f.game); }
  if (f.player) {
    const like = '%' + f.player.replace(/[\\%_]/g, (c) => '\\' + c) + '%';   // 昵称里的 % _ \ 按字面匹配
    where.push("(host_name LIKE ? ESCAPE '\\' OR guest_name LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (f.result) { where.push('result = ?'); params.push(f.result); }
  if (f.fromMs != null) { where.push('created_at >= ?'); params.push(f.fromMs); }
  if (f.toMs != null) { where.push('created_at <= ?'); params.push(f.toMs); }
  const mine = Array.isArray(o.mine)
    ? o.mine.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 4)
    : [];
  // ownerId 是登录用户的账号 id：不传 / 0 / 负数 / NaN 都当「没给」，此时下面的筛选 SQL 与改前逐字一致
  const ownerId = Number(o.ownerId) > 0 ? Math.trunc(Number(o.ownerId)) : 0;
  if (mine.length) {
    const byName = mine.map(() => '(LOWER(TRIM(host_name)) = LOWER(?) OR LOWER(TRIM(guest_name)) = LOWER(?))').join(' OR ');
    // 给了 ownerId 就并进同一组 OR：id 认新棋谱（改名也认），昵称认老棋谱（用户列是 0）
    where.push(ownerId ? '(' + byName + ' OR host_user_id = ? OR guest_user_id = ?)' : '(' + byName + ')');
    for (const n of mine) params.push(n, n);
    if (ownerId) params.push(ownerId, ownerId);
  } else if (ownerId) {
    // 只给 ownerId：不再按昵称匹配（否则会把同名的别人的棋谱捞进来）
    where.push('(host_user_id = ? OR guest_user_id = ?)');
    params.push(ownerId, ownerId);
  }

  const cols = 'id, game, host_name, guest_name, result, move_count, plays, created_at, host_user_id, guest_user_id';
  const cond = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const res = await stmt(db, 'SELECT ' + cols + ' FROM play_replays' + cond + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    params.concat([lim, off])).all();
  const cnt = await one(db, 'SELECT COUNT(*) AS n FROM play_replays' + cond, params);
  return { total: Number((cnt && cnt.n) || 0), items: ((res && res.results) || []).map(replayRow) };
}

function replayRow(row) {
  return {
    id: Number(row.id), game: row.game, hostName: row.host_name || '黑方', guestName: row.guest_name || '白方',
    result: row.result || '', winner: winnerName(row), moveCount: Number(row.move_count || 0),
    plays: Number(row.plays || 0), createdAt: Number(row.created_at || 0),
    // 第十批：账号级绑定（0 = 匿名 / 这批之前落的老棋谱）—— 加在末尾，既有字段名与顺序不动
    hostUserId: Number(row.host_user_id || 0), guestUserId: Number(row.guest_user_id || 0)
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
  if (done) {
    const fin = await room(db, r.id);
    await saveReplay(db, fin, now);
    // Elo 结算：只读 fin 的 game/status/result/昵称，失败也只打一行日志、不影响这次落子的返回
    await settleRatings(db, fin, now);
  }
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
  if (after.status === STATUS.DONE) {
    await saveReplay(db, after, now);
    await settleRatings(db, after, now); // 认输也是「一局结束」：照常结算，否则认输就能躲开分数的变化
  }
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
// ---------- Elo 评分 / 天梯 / 赛季 ----------
//
// 只有「服务端裁判的棋类 + 一局真的结束了」才结算（sendMove 判出胜负、或认输），读写
// player_ratings / elo_history 两张表（DDL 见 migrations/0010_elo.sql）。算法全在 src/elo.js
// （两条线共用），本段只做「查、算、写」，与 src/play-store.js 的同名函数一一对应、SQL 一样。
//
// D1 没有可交互事务，所以结算的三条写放在一个 db.batch 里（任何一条失败整批回滚）；
// elo_history.room_id 的 UNIQUE 索引兜住并发窗口，撞车时 batch 抛错 → 当作「已结算过」跳过。

/** 读一行评分记录；没有就用起始行当底（返回的一定是完整行） */
async function ratingRowOf(db, key, game, season) {
  return normRating(await one(db, ELO_SELECT, [key, game, season]), blankRating(key, game, season));
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
 * @param {object} db D1 绑定（env.DB）
 * @param {string} game 游戏标识（cleanGame 归一，大小写不敏感）
 * @param {string} userId 身份键：匿名用 playerKey(昵称)，接入账号后用 String(user.id)
 * @param {string} [season] 赛季串（'2026-Q4'），省略 = 当前赛季
 * @returns {Promise<object>} 与 src/play-store.js 的 ratingOf 同一形状
 */
export async function ratingOf(db, game, userId, season) {
  const g = cleanGame(game);
  const key = String(userId == null ? '' : userId).trim();
  const sea = String(season || '') || seasonOf(Date.now());
  if (!g || !key) return blankRating(key, g, sea);
  return ratingRowOf(db, key, g, sea);
}

/**
 * 天梯榜：分数降序，同分比局数，再同则按身份键升序（顺序稳定，不会两次渲染互换）。
 * @returns {Promise<{game: string, season: string, total: number, items: Array<object>}>}
 *   total = 这个赛季的总人数（不受 limit 影响）；items 的 rank 从 1 开始连续编号。
 */
export async function ratingBoard(db, game, season, limit = 50) {
  const g = cleanGame(game);
  const sea = String(season || '') || seasonOf(Date.now());
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);
  if (!g) return { game: '', season: sea, total: 0, items: [] };
  const cnt = await one(db, ELO_COUNT, [g, sea]);
  const res = await stmt(db, ELO_BOARD, [g, sea, lim]).all();
  return { game: g, season: sea, total: Number((cnt && cnt.n) || 0), items: ratingRows((res && res.results) || []) };
}

/**
 * 结算一局（幂等）。结算条件全中才写库：服务端裁判的棋类（isSupported）+ 房间已结束 +
 * result 是 'host' / 'guest' / 'draw' 之一 + 两边都有非空身份键 + 两边不是同一个人。
 * 不满足其一就跳过（reason 说明原因）；同一 room_id 只结一次——正常路径靠先查后插，
 * elo_history.room_id 的 UNIQUE 索引兜住并发窗口。
 * 绝不抛异常：任何失败只打一行日志并返回 {settled:false, reason:'error'}，结算不该影响接口返回。
 * @param {object} db D1 绑定（env.DB）
 * @param {object} r play_rooms 的整行（sendMove / resign 里 room(db, id) 的产物）
 * @param {number} [now] 结算时间（同时决定赛季），默认当前时间
 * @returns {Promise<{settled: boolean, reason: string, season?: string, hostDelta?: number, guestDelta?: number, hostAfter?: number, guestAfter?: number}>}
 */
export async function settleRatings(db, r, now = Date.now()) {
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
    if (await one(db, 'SELECT room_id FROM elo_history WHERE room_id = ?', [roomId])) {
      return { settled: false, reason: 'duplicate' };
    }
    const next = nextRatings(await ratingRowOf(db, hostKey, game, season), await ratingRowOf(db, guestKey, game, season), result);
    if (!next) return { settled: false, reason: 'no_result' };
    // 三条写一个 batch：历史与两份新分要么都落、要么都不落（重赛 / 并发时不会只改一半）
    await db.batch([
      stmt(db, ELO_HISTORY, [roomId, game, season, hostKey, guestKey, next.hostDelta, next.guestDelta, next.host.rating, next.guest.rating, result, now]),
      stmt(db, ELO_UPSERT, eloParams(next.host, now)),
      stmt(db, ELO_UPSERT, eloParams(next.guest, now))
    ]);
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
