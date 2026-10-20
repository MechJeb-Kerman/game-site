/**
 * 棋谱「只看我的」账号级绑定（第十批）回归测试：play_replays 的 host_user_id / guest_user_id。
 *
 * 运行：node tools/replay-identity-test.mjs
 * 前置：无。自己造临时库，不碰 data/games.db，不占端口，不发网络请求。
 *
 * 每条断言跑两遍：
 *   express 线：把 src/ 整树复制到 %TEMP% 的私有目录（src/db.js 的库路径由 import.meta.url 推出，
 *     副本会把库建在 <tmp>/data/games.db），调它的 migrate() 后动态 import src/play-store.js；
 *   worker 线：tools/d1-local.mjs 的 LocalD1 指向临时文件，先跑 worker/schema.js 的 migrate()，
 *     再 import worker/play-store.js（首个参数是 db 绑定、全程 await）。
 * 最后一段是「老库补列」：用 node:sqlite 手工造一张没有用户列的老表 + 一条老棋谱，再跑 migrate()，
 * 断言自动补列、老数据仍然可读、补列后新房新谱都能写上账号 id。
 *
 * 「现在」固定成本地 2026-05-20 中午：断言只依赖它，跟跑测试的真实时钟无关。
 * 期望值由本文件自己写 SQL 算，不拿被测模块算期望值。结尾打印「通过 N / 失败 M」，有失败 exit 1。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra));
  }
}

function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, 'got ' + a + ' want ' + b);
}

function line(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

/** 本地时间：2026-05-20 12:00（真实时钟无关） */
const NOW = new Date(2026, 4, 20, 12, 0, 0, 0).getTime();

/** 一个反斜杠字符：老 SQL 里 LIKE 的 ESCAPE '\\' 用的就是它（写成 fromCharCode 免得本文件里到处是转义） */
const BS = String.fromCharCode(92);

/** 改之前的 mine 筛选 SQL 片段（改前逐字）：LOWER(TRIM(host_name)) 或 guest_name 精确匹配 */
const MINE_SQL = '(LOWER(TRIM(host_name)) = LOWER(?) OR LOWER(TRIM(guest_name)) = LOWER(?))';

/**
 * 改之前 replayList 生成的 WHERE 片段（逐字抄自改前源码的顺序与括号）：
 * game → player(LIKE ESCAPE) → result → created_at >= → created_at <= → mine。
 * 「旧调用生成的 SQL 必须与改前逐字一致」这条就靠它钉住。
 */
const OLD_WHERE =
  ' WHERE game = ? AND (host_name LIKE ? ESCAPE ' + "'" + BS + "'" + ' OR guest_name LIKE ? ESCAPE ' + "'" + BS + "'" + ')'
  + ' AND result = ? AND created_at >= ? AND created_at <= ? AND (' + MINE_SQL + ')';

/* ---------- 手工老库（第六批之前的样子：没有 watch_token / replay_id / 用户列） ---------- */

const OLD_PLAY_ROOMS = "CREATE TABLE play_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, game TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', host_name TEXT NOT NULL DEFAULT '', guest_name TEXT NOT NULL DEFAULT '', host_token TEXT NOT NULL, guest_token TEXT NOT NULL DEFAULT '', turn INTEGER NOT NULL DEFAULT 0, move_count INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '', rematch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)";
const OLD_PLAY_REPLAYS = "CREATE TABLE play_replays (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, room_code TEXT NOT NULL DEFAULT '', host_name TEXT NOT NULL DEFAULT '', guest_name TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', move_count INTEGER NOT NULL DEFAULT 0, moves TEXT NOT NULL DEFAULT '[]', plays INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)";
const OLD_ROW_SQL = 'INSERT INTO play_replays (game, room_code, host_name, guest_name, result, move_count, moves, plays, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)';
const OLD_ROW_ARGS = ['gomoku', 'OLD001', 'legacy-me', 'legacy-rival', 'host', 2, JSON.stringify([[0, 'a1'], [1, 'b1']]), NOW];

function makeOldDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(OLD_PLAY_ROOMS);
  raw.exec(OLD_PLAY_REPLAYS);
  raw.prepare(OLD_ROW_SQL).run.apply(raw.prepare(OLD_ROW_SQL), OLD_ROW_ARGS);
  raw.close();
}

/* ---------- 两条线的装载 ---------- */

async function setupExpress(tmp) {
  const dir = join(tmp, 'express');
  mkdirSync(join(dir, 'public'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  const dbmod = await import(pathToFileURL(join(dir, 'src', 'db.js')).href);
  dbmod.migrate();
  const S = await import(pathToFileURL(join(dir, 'src', 'play-store.js')).href);
  return { db: dbmod.db, S: S };
}

async function setupWorker(tmp) {
  const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
  const db = new LocalD1(join(tmp, 'worker', 'd1.db'));
  const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
  await schema.migrate(db);
  const S = await import(pathToFileURL(join(ROOT, 'worker', 'play-store.js')).href);
  return { db: db, S: S };
}

async function setupExpressOld(tmp) {
  const dir = join(tmp, 'express-old');
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  makeOldDb(join(dir, 'data', 'games.db'));          // 必须在 import db.js 之前把老库放好
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  const dbmod = await import(pathToFileURL(join(dir, 'src', 'db.js')).href);
  dbmod.migrate();                                    // 老库补列就发生在这一步
  const S = await import(pathToFileURL(join(dir, 'src', 'play-store.js')).href);
  return { db: dbmod.db, S: S };
}

async function setupWorkerOld(tmp) {
  const file = join(tmp, 'worker-old', 'd1.db');
  makeOldDb(file);
  const { LocalD1 } = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
  const db = new LocalD1(file);
  const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
  await schema.migrate(db);                           // 老库补列就发生在这一步
  const S = await import(pathToFileURL(join(ROOT, 'worker', 'play-store.js')).href);
  return { db: db, S: S };
}

/** 把两条线包成同一组方法：断言只写一遍；worker 线自动补 db 首参 */
function api(kind, S, db) {
  const isExpress = kind === 'express';
  const bind = (sql, params) => {
    const st = db.prepare(sql);
    return params && params.length ? st.bind.apply(st, params) : st;
  };
  const run = async (sql, params) => (isExpress ? db.prepare(sql).run.apply(db.prepare(sql), params || []) : bind(sql, params).run());
  const all = async (sql, params) => (isExpress
    ? db.prepare(sql).all.apply(db.prepare(sql), params || [])
    : (((await bind(sql, params).all()) || {}).results) || []);
  const first = async (sql, params) => (isExpress
    ? (db.prepare(sql).get.apply(db.prepare(sql), params || []) || null)
    : await bind(sql, params).first());
  const call = (name, args) => (isExpress ? S[name].apply(S, args) : S[name].apply(S, [db].concat(args)));

  // SQL 文本探针：老调用生成的 SQL 有没有变，靠它直接看语句本身（劫持不了就跳过那两条断言）
  let capture = null;
  const origPrepare = db.prepare.bind(db);
  try {
    db.prepare = function (sql) {
      if (capture) capture.push(String(sql));
      return origPrepare(sql);
    };
  } catch (e) {
    // 劫持不了就算了：行为断言仍然覆盖
  }

  const A = {
    kind: kind,
    run: run,
    all: all,
    first: first,
    /** 老调用形状：不传 opts 时只给三个参数（server.js / worker/app.js 改前就是这么调的） */
    createRoom: (game, name, now, opts) => (opts === undefined ? call('createRoom', [game, name, now]) : call('createRoom', [game, name, now, opts])),
    joinRoom: (code, name, now, opts) => (opts === undefined ? call('joinRoom', [code, name, now]) : call('joinRoom', [code, name, now, opts])),
    quickMatch: (game, name, now, opts) => (opts === undefined ? call('quickMatch', [game, name, now]) : call('quickMatch', [game, name, now, opts])),
    saveReplay: (r, now) => (now === undefined ? call('saveReplay', [r, NOW]) : call('saveReplay', [r, now])),
    replayList: (opts) => call('replayList', [opts === undefined ? {} : opts]),
    roomRow: (id) => first('SELECT * FROM play_rooms WHERE id = ?', [id]),
    replayRow: (id) => first('SELECT * FROM play_replays WHERE id = ?', [id]),
    ids: async (sql, params) => (await all(sql, params)).map((r) => Number(r.id)),
    sqlSeen: async (fn) => {
      const seen = [];
      capture = seen;
      try { await fn(); } finally { capture = null; }
      return seen;
    }
  };
  return A;
}

/** 往房间里塞几步走法 + 置 done，返回整行（saveReplay 的两条内部调用点就是这么传的） */
async function finishRoom(A, roomId, result) {
  const moves = [[0, 'a1'], [1, 'b1'], [0, 'a2']];
  for (let i = 0; i < moves.length; i++) {
    await A.run('INSERT INTO play_moves (room_id, seq, seat, move, created_at) VALUES (?, ?, ?, ?, ?)',
      [roomId, i + 1, moves[i][0], moves[i][1], NOW]);
  }
  await A.run('UPDATE play_rooms SET status = ?, result = ?, updated_at = ? WHERE id = ?', ['done', result || 'host', NOW, roomId]);
  return await A.roomRow(roomId);
}

/** 造一间已结束的房：建房（可带 hostOpts）→ 有人加入（可带 guestOpts）→ 塞走法置 done */
async function doneRoom(A, game, hostName, guestName, hostOpts, guestOpts) {
  const created = await A.createRoom(game, hostName, NOW, hostOpts);
  const id = created.room.id;
  if (guestName) {
    const joined = await A.joinRoom(created.room.code, guestName, NOW, guestOpts);
    if (joined.error) throw new Error('joinRoom 失败：' + joined.error);
  }
  return await finishRoom(A, id, 'host');
}

const UID_A = 4242;
const UID_B = 4343;
const UID_C = 4444;
const UID_X = 9999;
const UID_OLD = 5151;
const NAME_A = 'identity-a';
const NAME_B = 'identity-b';
const NAME_OTHER = 'other-name';
const NAME_RENAMED = 'renamed-a';
const LEGACY_NAME = 'legacy-me';
const LEGACY_RIVAL = 'legacy-rival';

const REPLAY_COLS = 'game, room_code, host_name, guest_name, result, move_count, moves, plays, created_at';
const INS_LEGACY = 'INSERT INTO play_replays (' + REPLAY_COLS + ') VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)';
const INS_OTHER = 'INSERT INTO play_replays (game, room_code, host_name, guest_name, result, move_count, moves, plays, host_user_id, guest_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)';

/* ---------- 一条线的全部断言 ---------- */

async function runLine(kind, S, db) {
  const A = api(kind, S, db);
  line(kind + ' 线');

  /* ---------- A 房间记住建房者 / 加入者的账号 id ---------- */
  console.log('--- A createRoom / joinRoom / quickMatch 的 userId ---');
  const rA = await A.createRoom('gomoku', NAME_A, NOW, { userId: UID_A });
  eq('A1 createRoom 传 userId：host_user_id 落库', Number((await A.roomRow(rA.room.id)).host_user_id), UID_A);
  eq('A1 createRoom 传 userId：guest_user_id 仍是 0', Number((await A.roomRow(rA.room.id)).guest_user_id), 0);

  const r0 = await A.createRoom('reversi', NAME_A, NOW);
  const row0 = await A.roomRow(r0.room.id);
  eq('A2 createRoom 老调用（不传 opts）：两个用户列都是 0', [Number(row0.host_user_id), Number(row0.guest_user_id)], [0, 0]);
  eq('A2 老调用返回的房间视图形状没变', Object.keys(r0.room).sort().join(','), Object.keys(rA.room).sort().join(','));
  ok('A2 房间视图里没有用户列（publicRoom 白名单没被撑大）',
    !('host_user_id' in rA.room) && !('hostUserId' in rA.room) && !('guest_user_id' in rA.room) && !('guestUserId' in rA.room));

  const jB = await A.joinRoom(rA.room.code, NAME_B, NOW, { userId: UID_B });
  eq('A3 joinRoom 传 userId：guest_user_id 落库', Number((await A.roomRow(rA.room.id)).guest_user_id), UID_B);
  eq('A3 joinRoom 的返回形状没变（座位 / 状态 / token / replayId）',
    [jB.seat, jB.room.status, typeof jB.token, jB.room.replayId], [1, 'playing', 'string', 0]);

  const rJoin0 = await A.createRoom('xiangqi', NAME_A, NOW, { userId: UID_A });
  await A.joinRoom(rJoin0.room.code, NAME_B, NOW);
  const rowJoin0 = await A.roomRow(rJoin0.room.id);
  eq('A4 joinRoom 老调用（不传 opts）：guest_user_id = 0，房主 id 保留',
    [Number(rowJoin0.guest_user_id), Number(rowJoin0.host_user_id)], [0, UID_A]);

  const q1 = await A.quickMatch('connect4', NAME_A, NOW, { userId: UID_A });
  eq('A5 quickMatch 传 userId 自己开房：created=true 且 host_user_id 记上',
    [q1.created, Number((await A.roomRow(q1.room.id)).host_user_id)], [true, UID_A]);
  const q2 = await A.quickMatch('connect4', NAME_B, NOW, { userId: UID_B });
  eq('A5 quickMatch 传 userId 加入空房：created=false、进的是同一间房、guest_user_id 记上',
    [q2.created, q2.room.id === q1.room.id, Number((await A.roomRow(q2.room.id)).guest_user_id)], [false, true, UID_B]);
  const q3 = await A.quickMatch('draughts', NAME_A, NOW);
  eq('A5 quickMatch 老调用（不传 opts）：host_user_id = 0', Number((await A.roomRow(q3.room.id)).host_user_id), 0);

  eq('A6 userId 负数当 0', Number((await A.roomRow((await A.createRoom('chess', NAME_A, NOW, { userId: -5 })).room.id)).host_user_id), 0);
  eq('A6 userId 数字串按整数收下', Number((await A.roomRow((await A.createRoom('chess', NAME_A, NOW, { userId: '777' })).room.id)).host_user_id), 777);
  eq('A6 userId 非数字当 0', Number((await A.roomRow((await A.createRoom('chess', NAME_A, NOW, { userId: 'abc' })).room.id)).host_user_id), 0);

  /* ---------- B saveReplay 写两个用户列 ---------- */
  console.log('--- B saveReplay 的两个 id ---');
  const doneHost = await doneRoom(A, 'gomoku', NAME_A, NAME_B, { userId: UID_A }, { userId: UID_B });
  const rid1 = Number(await A.saveReplay(doneHost));
  const rep1 = await A.replayRow(rid1);
  eq('B1 saveReplay(房间整行)：两个 id 拷进棋谱', [Number(rep1.host_user_id), Number(rep1.guest_user_id)], [UID_A, UID_B]);
  eq('B1 saveReplay(房间整行)：昵称 / 结果 / 走法数 / plays 照旧',
    [rep1.host_name, rep1.guest_name, rep1.result, Number(rep1.move_count), Number(rep1.plays)], [NAME_A, NAME_B, 'host', 3, 0]);
  eq('B1 saveReplay 仍然把 replay_id 写回房间', Number((await A.roomRow(doneHost.id)).replay_id), rid1);
  // 真实调用点每次都重新读房间行（saveReplay 只看传进来那一行的 replay_id，这是改前就有的形状）
  const doneHostAgain = await A.roomRow(doneHost.id);
  eq('B1 同一局重复调用（刷新后的房间整行）：还是同一个 id（一局只存一份）', Number(await A.saveReplay(doneHostAgain)), rid1);
  eq('B1 重复调用没有多插一行', (await A.ids('SELECT id FROM play_replays WHERE room_code = ?', [doneHost.code])).length, 1);

  const doneExplicit = await doneRoom(A, 'reversi', 'explicit-h', 'explicit-g');
  const rid2 = Number(await A.saveReplay(Object.assign({}, doneExplicit, { hostUserId: UID_C, guestUserId: 0 })));
  const rep2 = await A.replayRow(rid2);
  eq('B2 saveReplay 显式 hostUserId / guestUserId 覆盖房间行里的列', [Number(rep2.host_user_id), Number(rep2.guest_user_id)], [UID_C, 0]);

  const doneLegacy = await doneRoom(A, 'draughts', 'legacy-h', 'legacy-g');
  const rid3 = Number(await A.saveReplay(doneLegacy));
  const rep3 = await A.replayRow(rid3);
  eq('B3 saveReplay 老调用（只给 hostName / guestName）：两个用户列都是 0',
    [Number(rep3.host_user_id), Number(rep3.guest_user_id)], [0, 0]);
  eq('B3 saveReplay 老调用：昵称 / 结果 / 走法数照旧',
    [rep3.host_name, rep3.guest_name, rep3.result, Number(rep3.move_count)], ['legacy-h', 'legacy-g', 'host', 3]);

  const doneGuest = await doneRoom(A, 'xiangqi', NAME_B, NAME_A, { userId: UID_B }, { userId: UID_A });
  const rid4 = Number(await A.saveReplay(doneGuest));
  const rep4 = await A.replayRow(rid4);
  eq('B4 A 当访客那局：host 是 B、guest 是 A', [Number(rep4.host_user_id), Number(rep4.guest_user_id)], [UID_B, UID_A]);

  /* ---------- C replayList：老调用逐字兼容 + ownerId ---------- */
  console.log('--- C replayList 的 ownerId ---');
  await A.run(INS_LEGACY, ['gomoku', 'LEG000', LEGACY_NAME, LEGACY_RIVAL, 'host', 2, JSON.stringify([[0, 'a1'], [1, 'b1']]), NOW]);
  const legacyId = Number((await A.first('SELECT MAX(id) AS id FROM play_replays')).id);
  await A.run(INS_OTHER, ['reversi', 'SAME00', NAME_A, NAME_OTHER, 'draw', 1, JSON.stringify([[0, 'a1']]), UID_X, 0, NOW]);
  const sameNameId = Number((await A.first('SELECT MAX(id) AS id FROM play_replays')).id);
  eq('C0 手工插的两条：用户列读出来是 0 与 9999',
    [Number((await A.replayRow(legacyId)).host_user_id), Number((await A.replayRow(sameNameId)).host_user_id)], [0, UID_X]);

  const allIds = await A.ids('SELECT id FROM play_replays ORDER BY id DESC');
  const allList = await A.replayList({});
  eq('C1 不给 ownerId：行与测试自己写的 SQL 完全一致', allList.items.map((x) => x.id), allIds);
  eq('C1 不给 ownerId：total 一致', allList.total, allIds.length);
  eq('C1 行字段名与顺序：两个新字段加在末尾',
    Object.keys(allList.items[0]),
    ['id', 'game', 'hostName', 'guestName', 'result', 'winner', 'moveCount', 'plays', 'createdAt', 'hostUserId', 'guestUserId']);
  eq('C1 老调用（只给 game/limit/offset）：与改前同一组行',
    (await A.replayList({ game: 'reversi', limit: 5, offset: 0 })).items.map((x) => x.id),
    await A.ids('SELECT id FROM play_replays WHERE game = ? ORDER BY id DESC LIMIT ? OFFSET ?', ['reversi', 5, 0]));
  eq('C1 只给 mine（老口径）：仍是昵称精确匹配、大小写不敏感',
    (await A.replayList({ mine: [NAME_A.toUpperCase()] })).items.map((x) => x.id),
    await A.ids('SELECT id FROM play_replays WHERE (' + MINE_SQL + ') ORDER BY id DESC', [NAME_A.toUpperCase(), NAME_A.toUpperCase()]));
  for (const bad of [0, -1, NaN, 'abc', null]) {
    eq('C1 ownerId=' + String(bad) + ' 与不传等价（同一组行）', (await A.replayList({ ownerId: bad })).items.map((x) => x.id), allIds);
  }

  const ownerA = await A.replayList({ ownerId: UID_A });
  eq('C2 ownerId=A：只命中 id 匹配的行（测试自己写的 SQL）',
    ownerA.items.map((x) => x.id),
    await A.ids('SELECT id FROM play_replays WHERE (host_user_id = ? OR guest_user_id = ?) ORDER BY id DESC', [UID_A, UID_A]));
  ok('C2 ownerId=A：host 侧（B1 那局）与 guest 侧（B4 那局）都命中',
    ownerA.items.some((x) => x.id === rid1) && ownerA.items.some((x) => x.id === rid4));
  ok('C2 ownerId=A：不含用户列为 0 的老棋谱', !ownerA.items.some((x) => x.id === legacyId));
  ok('C2 ownerId=A：不含别人的棋谱（B2 那局）', !ownerA.items.some((x) => x.id === rid2));
  eq('C2 ownerId 时 total 与 items 同口径', ownerA.total, ownerA.items.length);
  ok('C2 行里带 hostUserId / guestUserId（数值）',
    ownerA.items.length > 0 && ownerA.items.every((x) => typeof x.hostUserId === 'number' && typeof x.guestUserId === 'number'));

  const renamed = await A.replayList({ ownerId: UID_A, mine: [NAME_RENAMED] });
  eq('C3 ownerId + mine：并进同一组 OR（测试自己写的 SQL）',
    renamed.items.map((x) => x.id),
    await A.ids('SELECT id FROM play_replays WHERE ((' + MINE_SQL + ') OR host_user_id = ? OR guest_user_id = ?) ORDER BY id DESC',
      [NAME_RENAMED, NAME_RENAMED, UID_A, UID_A]));
  ok('C3 玩家改名后仍命中（棋谱里存的是旧名，靠 id 出现）', renamed.items.some((x) => x.id === rid1));
  ok('C3 改名场景下不含别人的棋谱', !renamed.items.some((x) => x.id === rid2));

  ok('C4 老棋谱（用户列 0）靠昵称回退仍可见',
    (await A.replayList({ ownerId: UID_A, mine: [LEGACY_NAME] })).items.some((x) => x.id === legacyId));
  ok('C4 只给 ownerId：不再按昵称匹配，老棋谱不出现', !ownerA.items.some((x) => x.id === legacyId));
  ok('C4 只给 mine（老调用口径）：仍能按昵称找到老棋谱',
    (await A.replayList({ mine: [LEGACY_NAME] })).items.some((x) => x.id === legacyId));
  ok('C4 mine 里带首尾空格 / 大小写也认（老口径的 TRIM + LOWER 没变）',
    (await A.replayList({ ownerId: UID_A, mine: ['  LEGACY-ME  '] })).items.some((x) => x.id === legacyId));

  ok('C5 只给 ownerId：同名的别人的棋谱不出现', !ownerA.items.some((x) => x.id === sameNameId));
  ok('C5 ownerId + mine：同名的别人的棋谱会因昵称分支出现（老棋谱回退的已知代价）',
    (await A.replayList({ ownerId: UID_A, mine: [NAME_A] })).items.some((x) => x.id === sameNameId));

  const p1 = await A.replayList({ ownerId: UID_A, limit: 1, offset: 0 });
  const p2 = await A.replayList({ ownerId: UID_A, limit: 1, offset: 1 });
  eq('C6 ownerId + 翻页：offset 在过滤后的集合里生效',
    [p1.total, p1.items.map((x) => x.id), p2.items.map((x) => x.id)],
    [ownerA.total, ownerA.items.slice(0, 1).map((x) => x.id), ownerA.items.slice(1, 2).map((x) => x.id)]);
  eq('C6 ownerId + game 组合：AND 到一起（测试自己写的 SQL）',
    (await A.replayList({ ownerId: UID_A, game: 'gomoku' })).items.map((x) => x.id),
    await A.ids('SELECT id FROM play_replays WHERE game = ? AND (host_user_id = ? OR guest_user_id = ?) ORDER BY id DESC', ['gomoku', UID_A, UID_A]));

  const seenOld = await A.sqlSeen(() => A.replayList({
    game: 'reversi', player: 'x', result: 'draw', from: '2026-05-20', to: '2026-05-20', mine: ['y'], limit: 5, offset: 0
  }));
  const selOld = seenOld.filter((s) => s.indexOf('FROM play_replays') >= 0 && s.indexOf('ORDER BY') >= 0);
  if (!selOld.length) {
    console.log('  （提示：没能劫持 db.prepare，跳过 SQL 文本逐字断言；行为断言已覆盖同一条口径）');
  } else {
    eq('C7 不给 ownerId 的老调用：WHERE 文本与改前逐字一致',
      selOld[0].slice(selOld[0].indexOf(' WHERE '), selOld[0].indexOf(' ORDER BY')), OLD_WHERE);
    eq('C7 不给 ownerId 的老调用：SELECT 列里不多不少（老列 + 两个新列）',
      selOld[0].slice(0, selOld[0].indexOf(' FROM ')),
      'SELECT id, game, host_name, guest_name, result, move_count, plays, created_at, host_user_id, guest_user_id');
  }
  const seenOwner = await A.sqlSeen(() => A.replayList({ mine: ['y'], ownerId: UID_A, limit: 5 }));
  const selOwner = seenOwner.filter((s) => s.indexOf('FROM play_replays') >= 0 && s.indexOf('ORDER BY') >= 0);
  if (selOwner.length) {
    ok('C7 ownerId + mine：OR 合并后 host_user_id / guest_user_id 在同一组 OR 里',
      selOwner[0].indexOf('host_user_id = ? OR guest_user_id = ?)') >= 0 && selOwner[0].indexOf('ORDER BY') > selOwner[0].indexOf('host_user_id'));
  }
  const seenOwnerOnly = await A.sqlSeen(() => A.replayList({ ownerId: UID_A, limit: 5 }));
  const selOwnerOnly = seenOwnerOnly.filter((s) => s.indexOf('FROM play_replays') >= 0 && s.indexOf('ORDER BY') >= 0);
  if (selOwnerOnly.length) {
    ok('C7 只给 ownerId：WHERE 里没有昵称条件',
      selOwnerOnly[0].indexOf('LOWER(TRIM(host_name))') < 0 && selOwnerOnly[0].indexOf('host_user_id = ? OR guest_user_id = ?') >= 0);
  }

  const snapRows = (await A.all('SELECT id, game, host_name, guest_name, result, host_user_id, guest_user_id FROM play_replays ORDER BY id ASC'))
    .map((r) => [r.game, r.host_name, r.guest_name, r.result, Number(r.host_user_id), Number(r.guest_user_id)]);
  const snapRooms = (await A.all('SELECT game, status, host_name, guest_name, host_user_id, guest_user_id FROM play_rooms ORDER BY id ASC'))
    .map((r) => [r.game, r.status, r.host_name, r.guest_name, Number(r.host_user_id), Number(r.guest_user_id)]);
  return { rows: snapRows, rooms: snapRooms };
}

/* ---------- 老库补列 ---------- */

async function runOldLine(kind, S, db) {
  const A = api(kind, S, db);
  line(kind + ' 线（老库补列）');

  const colsRep = (await A.all('PRAGMA table_info(play_replays)')).map((c) => c.name);
  const colsRoom = (await A.all('PRAGMA table_info(play_rooms)')).map((c) => c.name);
  ok('D1 老库打开后自动补列：play_replays 有 host_user_id / guest_user_id',
    colsRep.indexOf('host_user_id') >= 0 && colsRep.indexOf('guest_user_id') >= 0, JSON.stringify(colsRep));
  ok('D1 老库打开后自动补列：play_rooms 有 host_user_id / guest_user_id',
    colsRoom.indexOf('host_user_id') >= 0 && colsRoom.indexOf('guest_user_id') >= 0, JSON.stringify(colsRoom));

  const oldList = await A.replayList({});
  eq('D2 老数据可读：只有手工插的那一条', oldList.total, 1);
  eq('D2 老数据可读：昵称 / 走法数照旧',
    [oldList.items[0].hostName, oldList.items[0].guestName, oldList.items[0].moveCount], [LEGACY_NAME, LEGACY_RIVAL, 2]);
  eq('D2 老数据的两个用户列补出来是 0（NOT NULL DEFAULT 0）', [oldList.items[0].hostUserId, oldList.items[0].guestUserId], [0, 0]);
  const oldId = oldList.items[0].id;
  ok('D2 只给 ownerId：老棋谱不命中（用户列是 0）', !(await A.replayList({ ownerId: UID_OLD })).items.some((x) => x.id === oldId));
  ok('D2 ownerId + mine：老棋谱靠昵称回退命中',
    (await A.replayList({ ownerId: UID_OLD, mine: [LEGACY_NAME] })).items.some((x) => x.id === oldId));

  const created = await A.createRoom('gomoku', 'old-uid-a', NOW, { userId: UID_OLD });
  const joined = await A.joinRoom(created.room.code, 'old-uid-b', NOW, { userId: 6161 });
  if (joined.error) throw new Error('老库补列后 joinRoom 失败：' + joined.error);
  const rowRoom = await A.roomRow(created.room.id);
  eq('D3 老库补列后：建房 / 加入都能写进新列', [Number(rowRoom.host_user_id), Number(rowRoom.guest_user_id)], [UID_OLD, 6161]);
  const done = await finishRoom(A, created.room.id, 'draw');
  const rid = Number(await A.saveReplay(done));
  const mine = await A.replayList({ ownerId: UID_OLD });
  ok('D3 老库补列后：新棋谱能被 ownerId 命中，老棋谱仍不出现', mine.items.length === 1 && mine.items[0].id === rid);
  eq('D3 老棋谱还在（id 倒序：新谱在前）', (await A.replayList({})).items.map((x) => x.id), [rid, oldId]);

  return {
    rows: (await A.all('SELECT game, host_name, guest_name, result, host_user_id, guest_user_id FROM play_replays ORDER BY id ASC'))
      .map((r) => [r.game, r.host_name, r.guest_name, r.result, Number(r.host_user_id), Number(r.guest_user_id)])
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'game-site-replay-id-'));
  console.log('临时目录：' + tmp);
  const handles = [];   // 结束时挨个 close()：Windows 上 WAL 文件被占用就删不掉临时目录
  try {
    const ex = await setupExpress(tmp);
    handles.push(ex.db);
    const exSnap = await runLine('express', ex.S, ex.db);
    const wk = await setupWorker(tmp);
    handles.push(wk.db);
    const wkSnap = await runLine('worker', wk.S, wk.db);

    line('两线一致性');
    eq('两线：棋谱行快照一致（game / 昵称 / 结果 / 两个用户列）', wkSnap.rows, exSnap.rows);
    eq('两线：房间快照一致（房主 / 访客 / 两个用户列）', wkSnap.rooms, exSnap.rooms);

    const exOld = await setupExpressOld(tmp);
    handles.push(exOld.db);
    const exOldSnap = await runOldLine('express', exOld.S, exOld.db);
    const wkOld = await setupWorkerOld(tmp);
    handles.push(wkOld.db);
    const wkOldSnap = await runOldLine('worker', wkOld.S, wkOld.db);

    line('两线一致性（老库）');
    eq('两线（老库）：补列后的棋谱快照一致', wkOldSnap.rows, exOldSnap.rows);
  } catch (e) {
    fail++;
    console.log('  FAIL 测试执行中断 :: ' + (e && e.stack ? e.stack : e));
  }
  if (fail) {
    console.log('');
    console.log('（临时目录保留以便排查：' + tmp + '）');
  } else {
    for (const h of handles) {
      try { h.close(); } catch (e) { /* 已关或本来就是坏的，忽略 */ }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      console.log('');
      console.log('（临时目录没删掉，无害：' + tmp + '）');
    }
  }
  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main();
