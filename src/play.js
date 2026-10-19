/**
 * 联机对战的共享纯逻辑（不碰数据库、不碰网络）。
 * Express 线 src/play-store.js 与 Workers 线 worker/play-store.js 都 import 这里，
 * 保证房间码、名字清洗、走法校验、状态推导两条线完全一致（先例：src/forum-guard.js）。
 *
 * 设计取舍（服务端只做「轮流 + 走法中继」）：
 *   - 不校验走法是否合法、不判胜负 —— 三条棋的规则都跑在浏览器里（同一个页面文件
 *     在两条线共用），服务端收到的 result 只当玩家声明照单转发；
 *   - 匿名可玩，房间靠 6 位房间码 + 每人一枚随机 token 认领座位，不做账号绑定；
 *   - 没有 Durable Objects，客户端 1~2 秒轮询 /api/play/poll 拉增量走法。
 */

/** 还没等到对手的空房，多久回收 */
export const TTL_WAITING_MS = 2 * 60 * 60 * 1000;
/** 开局后 / 结束后多久没动静回收（结束后保留一天，让双方都看得到结果） */
export const TTL_PLAYING_MS = 24 * 60 * 60 * 1000;
/** 单步走法上限（坐标 / 着法的 JSON 串，实际都很短） */
export const MAX_MOVE_LEN = 256;
export const MAX_NAME_LEN = 12;
/** 房间码字母表：去掉 I/O/0/1 这些口头/手抄容易混的字符 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;
/** 一次最多给多少步增量（正常轮询只会有一两步，防止 since=0 时拉爆） */
export const MAX_MOVES_PER_POLL = 400;

export const STATUS = { WAITING: 'waiting', PLAYING: 'playing', DONE: 'done', CLOSED: 'closed' };
export const RESULTS = ['host', 'guest', 'draw'];

/** 用一串随机字节生成房间码（两条线各自的 crypto 都能给字节） */
export function makeCode(bytes) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/** 昵称清洗：去控制字符、限长、空则给个随机默认名 */
export function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return '玩家' + Math.floor(1000 + Math.random() * 9000);
  return s.slice(0, MAX_NAME_LEN);
}

/** 游戏 slug：只认小写字母 / 数字 / 连字符 */
export function cleanGame(game) {
  const s = String(game == null ? '' : game).toLowerCase().trim();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s) ? s : '';
}

/** 房间码：大小写不敏感，只留字母数字，长度必须正好 CODE_LEN */
export function cleanCode(code) {
  const s = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === CODE_LEN ? s : '';
}

/** 走法：字符串或可 JSON 化的对象，统一存成字符串 */
export function cleanMove(move) {
  let s;
  if (typeof move === 'string') s = move;
  else {
    try { s = JSON.stringify(move); } catch { return ''; }
  }
  if (typeof s !== 'string' || !s.length || s.length > MAX_MOVE_LEN) return '';
  return s;
}

export function cleanResult(result) {
  return RESULTS.indexOf(result) >= 0 ? result : '';
}

/** token 认领座位；-1 表示这枚 token 不属于这个房间 */
export function seatOf(room, token) {
  if (!room || !token) return -1;
  if (token === room.host_token) return 0;
  if (room.guest_token && token === room.guest_token) return 1;
  return -1;
}

export function isMyTurn(room, seat) {
  return !!room && room.status === STATUS.PLAYING && Number(room.turn) === seat;
}

/** 过期判定：空房 2 小时、开局后 24 小时没动静 */
export function isExpired(room, now) {
  if (!room) return true;
  const age = now - Number(room.updated_at || room.created_at || 0);
  if (room.status === STATUS.WAITING) return !room.guest_token && age > TTL_WAITING_MS;
  // 结束 / 已关闭的房间也要能轮询到（双方得看得到结果与「对方已离开」），同样 24 小时回收
  return age > TTL_PLAYING_MS;
}

/**
 * 观战钥匙：`<房间 id>-<watch_token>`。房间里的两位玩家拿得到，用来把这一局分享给别人看；
 * 观战只看不走，钥匙不是座位 token，露出去也拿不到落子权。
 */
export function watchKeyOf(room) {
  if (!room || !room.watch_token) return '';
  return Number(room.id) + '-' + room.watch_token;
}

/** 解析观战钥匙；格式不对返回 null（观战是公开入口，先做严格校验再查库） */
export function parseWatchKey(key) {
  const s = String(key || '').trim();
  const i = s.indexOf('-');
  if (i <= 0) return null;
  const id = Number(s.slice(0, i));
  const token = s.slice(i + 1);
  if (!Number.isInteger(id) || id <= 0 || !/^[a-f0-9]{12,64}$/.test(token)) return null;
  return { id: id, token: token };
}

/** 给客户端看的房间视图：座位号与 token 只回给本人，对手的 token 不外泄 */
export function publicRoom(room, seat) {
  return {
    id: Number(room.id),
    code: room.code,
    game: room.game,
    status: room.status,
    turn: Number(room.turn),
    moveCount: Number(room.move_count),
    result: room.result || '',
    rematch: Number(room.rematch || 0),
    seat: seat,
    myTurn: isMyTurn(room, seat),
    // 已存档的棋谱 id（0 = 还没存，对局结束后才会补上）；观战钥匙只给房间里的玩家
    replayId: Number(room.replay_id || 0),
    watchKey: seat >= 0 ? watchKeyOf(room) : '',
    players: [
      { seat: 0, name: room.host_name || '', joined: true },
      { seat: 1, name: room.guest_name || '', joined: !!room.guest_token }
    ]
  };
}

export function mapMoves(rows) {
  return (rows || []).map((r) => ({ seq: Number(r.seq), seat: Number(r.seat), move: r.move }));
}
