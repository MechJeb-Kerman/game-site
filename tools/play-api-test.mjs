/* 联机对战（房间 + 走法中继）接口验收测试。
 * 前置条件：站点已在 BASE 上跑起来（默认 http://127.0.0.1:3000）。
 *   node tools/play-api-test.mjs          # Express 线，或 pnpm test:play
 *   node tools/worker-play-test.mjs       # Workers + D1 线（本机假 D1），或 pnpm test:worker-play
 *
 * 这套接口是匿名的（座位靠 token 认领，不用 cookie），所以同一个脚本两条线都能跑，
 * 只要把 BASE 指过去。会真的写库：房间里留下若干已结束/已关闭的房间，24 小时后由建房时的
 * sweep 自动清掉，重复跑不会互相干扰。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postRaw(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 就当错 */ }
  return { status: res.status, data, text };
}

/** 建房 / 快速匹配有 1 秒限速，撞上就等一会儿重试（限速本身另有断言） */
async function post(path, body) {
  for (let i = 0; i < 4; i++) {
    const r = await postRaw(path, body);
    if (r.status !== 429) return r;
    await sleep(1100);
  }
  return postRaw(path, body);
}

/** 读接口：回放 / 回放页这两个 GET 用得上（非 JSON 响应 data 为 null） */
async function getRaw(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 就当错 */ }
  return { status: res.status, data, text };
}

async function main() {
  console.log('联机对战接口验收：' + BASE);

  /* ---------- 建房 ---------- */
  let r = await post('/api/play/create', { game: 'BAD GAME!', name: '甲' });
  ok('游戏标识非法 → 400 bad_game', r.status === 400 && r.data && r.data.error === 'bad_game', r.status + ' ' + r.text.slice(0, 120));

  r = await postRaw('/api/play/create', { game: 'gomoku', name: '甲' });
  const rapid = await postRaw('/api/play/create', { game: 'gomoku', name: '甲2' });
  ok('建房连点 → 第二下被限速（429 busy）', rapid.status === 429 && rapid.data.error === 'busy', rapid.status + ' ' + rapid.text.slice(0, 120));
  const first = r.status === 429 ? await post('/api/play/create', { game: 'gomoku', name: '甲' }) : r;
  r = first;
  const host = r.data || {};
  ok('建房 → 201 ok', r.status === 201 && host.ok === true, r.status + ' ' + r.text.slice(0, 160));
  ok('房间码是 6 位、字符集不含 I/O/0/1', /^[A-HJ-NP-Z2-9]{6}$/.test(host.room ? host.room.code : ''), host.room && host.room.code);
  ok('建房者是 0 号座位', host.seat === 0 && host.room.seat === 0, JSON.stringify(host.seat));
  ok('给了本人的座位 token（32 位 hex）', /^[0-9a-f]{32}$/.test(host.token || ''), String(host.token).slice(0, 8));
  ok('房间初始为等待中，对手未加入', host.room.status === 'waiting' && host.room.players[1].joined === false, JSON.stringify(host.room));
  ok('响应里没有 host_token / guest_token 字段（不外泄）',
    !('host_token' in host.room) && !('guest_token' in host.room) && !/host_token|guest_token/.test(r.text), r.text.slice(0, 120));

  const code = host.room.code;
  const roomId = host.room.id;
  const hostToken = host.token;

  /* ---------- 轮询（等待中） ---------- */
  r = await post('/api/play/poll', { id: roomId, token: hostToken, since: 0 });
  ok('房主轮询 → 200，还没开局、没有走法',
    r.status === 200 && r.data.room.status === 'waiting' && r.data.moves.length === 0 && r.data.seat === 0,
    r.status + ' ' + r.text.slice(0, 160));

  /* ---------- 加入 ---------- */
  r = await post('/api/play/join', { code: 'ZZ', name: '乙' });
  ok('房间码长度不对 → 400 bad_code', r.status === 400 && r.data.error === 'bad_code', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/join', { code: 'AAAAAA', name: '乙' });
  ok('房间不存在 → 404 not_found', r.status === 404 && r.data.error === 'not_found', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/join', { code: code.toLowerCase(), name: '乙' });
  const guest = r.data || {};
  ok('用小写房间码也能加入，对手拿到 1 号座位', r.status === 200 && guest.seat === 1, r.status + ' ' + r.text.slice(0, 160));
  ok('开局：状态 playing，房主先手（turn=0）', guest.room.status === 'playing' && guest.room.turn === 0, JSON.stringify(guest.room && guest.room.status));
  ok('双方名字都在玩家列表里', guest.room.players[0].name === '甲' && guest.room.players[1].name === '乙' && guest.room.players[1].joined === true,
    JSON.stringify(guest.room.players));
  const guestToken = guest.token;

  r = await post('/api/play/join', { code: code, name: '丙' });
  ok('第三个人进来 → 409 full（座位只有一个）', r.status === 409 && r.data.error === 'full', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/poll', { id: roomId, token: 'f'.repeat(32), since: 0 });
  ok('拿错 token 轮询 → 403 bad_token', r.status === 403 && r.data.error === 'bad_token', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/poll', { id: 99999999, token: hostToken, since: 0 });
  ok('房间不存在 → 404 not_found', r.status === 404 && r.data.error === 'not_found', r.status + ' ' + r.text.slice(0, 120));

  /* ---------- 走法与轮流 ---------- */
  r = await post('/api/play/move', { id: roomId, token: guestToken, move: { x: 1, y: 1 } });
  ok('没轮到就落子 → 409 not_your_turn', r.status === 409 && r.data.error === 'not_your_turn', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/move', { id: roomId, token: hostToken, move: { x: 7, y: 7 } });
  ok('房主第一手 → 200，seq=1，未结束', r.status === 200 && r.data.seq === 1 && r.data.finished === false, r.status + ' ' + r.text.slice(0, 160));
  ok('落子后轮到对手（turn=1）', r.data.room.turn === 1 && r.data.room.myTurn === false && r.data.room.moveCount === 1, JSON.stringify({ t: r.data.room.turn }));

  r = await post('/api/play/move', { id: roomId, token: hostToken, move: { x: 0, y: 0 } });
  ok('连下两手 → 409 not_your_turn', r.status === 409 && r.data.error === 'not_your_turn', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/poll', { id: roomId, token: guestToken, since: 0 });
  ok('对手轮询拿到增量走法（seq + 座位 + 内容）',
    r.status === 200 && r.data.moves.length === 1 && r.data.moves[0].seq === 1 && r.data.moves[0].seat === 0 &&
    JSON.parse(r.data.moves[0].move).x === 7, JSON.stringify(r.data.moves));
  r = await post('/api/play/poll', { id: roomId, token: guestToken, since: 1 });
  ok('since 之后没有新走法 → 空增量', r.status === 200 && r.data.moves.length === 0, JSON.stringify(r.data.moves));

  r = await post('/api/play/move', { id: roomId, token: guestToken, move: '' });
  ok('走法是空串 → 400 bad_move', r.status === 400 && r.data.error === 'bad_move', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/move', { id: roomId, token: guestToken, move: 'x'.repeat(300) });
  ok('走法超长（>256）→ 400 bad_move', r.status === 400 && r.data.error === 'bad_move', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/move', { id: roomId, token: guestToken, move: { x: 7, y: 8 }, result: 'guest' });
  const fin = r.data || {};   /* 终局响应：后面那局棋的回放断言要用它的 replayId（重赛会把房间的 replay_id 归零） */
  ok('对手落子并声明胜负 → 对局结束', r.status === 200 && r.data.finished === true && r.data.result === 'guest' && r.data.room.status === 'done',
    r.status + ' ' + r.text.slice(0, 160));
  ok('client 声明的 result 原样转发（服务端不判棋）', r.data.room.result === 'guest', r.data.room.result);

  r = await post('/api/play/move', { id: roomId, token: hostToken, move: { x: 1, y: 1 } });
  ok('结束后再落子 → 409 done', r.status === 409 && r.data.error === 'done', r.status + ' ' + r.text.slice(0, 120));

  /* ---------- 再来一局 ---------- */
  r = await post('/api/play/rematch', { id: roomId, token: hostToken });
  ok('一方点再来一局 → 等待对方（restarted=false）', r.status === 200 && r.data.restarted === false && r.data.room.rematch === 1, r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/rematch', { id: roomId, token: guestToken });
  ok('双方都点 → 重开：playing、turn=0、步数清零', r.status === 200 && r.data.restarted === true &&
    r.data.room.status === 'playing' && r.data.room.turn === 0 && r.data.room.moveCount === 0, r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/poll', { id: roomId, token: hostToken, since: 0 });
  ok('重开后历史走法被清空', r.status === 200 && r.data.moves.length === 0, JSON.stringify(r.data.moves));
  r = await post('/api/play/rematch', { id: roomId, token: hostToken });
  ok('开局中再点再来一局 → 409 playing', r.status === 409 && r.data.error === 'playing', r.status + ' ' + r.text.slice(0, 120));

  /* ---------- 认输 / 离开 ---------- */
  r = await post('/api/play/resign', { id: roomId, token: hostToken });
  ok('房主认输 → 对手获胜', r.status === 200 && r.data.room.status === 'done' && r.data.room.result === 'guest', r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/poll', { id: roomId, token: guestToken, since: 0 });
  ok('对手轮询看得到 result=guest', r.status === 200 && r.data.room.result === 'guest', r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/leave', { id: roomId, token: guestToken });
  ok('离开 → 房间关闭', r.status === 200 && r.data.room.status === 'closed', r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/poll', { id: roomId, token: hostToken, since: 0 });
  ok('对手下一次轮询看到「对方已离开」（closed 也能轮询到）', r.status === 200 && r.data.room.status === 'closed', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/move', { id: roomId, token: hostToken, move: { x: 2, y: 2 } });
  ok('关闭后落子 → 409 closed', r.status === 409 && r.data.error === 'closed', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/resign', { id: roomId, token: hostToken });
  ok('关闭后再认输 → 409 closed', r.status === 409 && r.data.error === 'closed', r.status + ' ' + r.text.slice(0, 120));

  /* ---------- 快速匹配 ---------- */
  // 每次运行换一个没人用过的棋种标识，免得撞上上一轮遗留的等待中房间
  const qg = 'q-' + Date.now().toString(36);
  const qg2 = 'r-' + Date.now().toString(36);
  r = await post('/api/play/quick', { game: qg, name: '快1' });
  const q1 = r.data || {};
  ok('快速匹配没人等 → 自己开一间（201、0 号座位、waiting）',
    r.status === 201 && q1.seat === 0 && q1.room.status === 'waiting', r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/quick', { game: qg, name: '快2' });
  const q2 = r.data || {};
  ok('第二个人快速匹配 → 进同一间房、1 号座位、开局（200 而非 201）', r.status === 200 && q2.seat === 1 &&
    q2.room.code === q1.room.code && q2.room.status === 'playing', r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/quick', { game: qg, name: '快3' });
  ok('第三个人快速匹配 → 另开一间（不会挤进对局中的房）',
    r.status === 201 && r.data.room.code !== q1.room.code && r.data.seat === 0, r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/quick', { game: qg2, name: '快4' });
  ok('不同棋种不互相匹配', r.status === 201 && r.data.room.game === qg2 && r.data.seat === 0, r.status + ' ' + r.text.slice(0, 160));

  /* ---------- 棋谱回放：用上面那局 2 手的棋（甲 7,7 → 乙 7,8 收尾） ---------- */
  const replayId = Number(fin.replayId || 0);
  ok('终局响应里带 replayId', replayId > 0, JSON.stringify({ replayId: fin.replayId, result: fin.result }));
  ok('房间视图里带的是同一个 replayId', Number((fin.room && fin.room.replayId) || 0) === replayId, String(fin.room && fin.room.replayId));

  r = await getRaw('/api/replays/' + replayId);
  const rep = (r.data && r.data.replay) || {};
  ok('读棋谱 → 200 {ok:true}', r.status === 200 && r.data && r.data.ok === true, r.status + ' ' + r.text.slice(0, 160));
  ok('棋谱记的是这款棋，手数＝实际走子数（2）',
    rep.game === 'gomoku' && rep.moveCount === 2, JSON.stringify({ game: rep.game, moveCount: rep.moveCount }));
  ok('moves 长度与 moveCount 一致，首手座位是 0/1、内容是字符串',
    Array.isArray(rep.moves) && rep.moves.length === rep.moveCount &&
    (rep.moves[0].seat === 0 || rep.moves[0].seat === 1) && typeof rep.moves[0].move === 'string' && rep.moves[0].move.length > 0,
    JSON.stringify(rep.moves));
  ok('两手棋按座位 0 → 1 记', !!rep.moves && rep.moves.length === 2 && rep.moves[0].seat === 0 && rep.moves[1].seat === 1,
    JSON.stringify(rep.moves));

  r = await getRaw('/api/replays/abc');
  ok('棋谱 id 不是数字 → 400 bad_id', r.status === 400 && r.data && r.data.error === 'bad_id', r.status + ' ' + r.text.slice(0, 120));
  r = await getRaw('/api/replays/0');
  ok('棋谱 id 是 0 → 400 bad_id', r.status === 400 && r.data && r.data.error === 'bad_id', r.status + ' ' + r.text.slice(0, 120));
  r = await getRaw('/api/replays/99999999');
  ok('棋谱不存在 → 404 not_found', r.status === 404 && r.data && r.data.error === 'not_found', r.status + ' ' + r.text.slice(0, 120));

  r = await getRaw('/replay/' + replayId);
  ok('回放页 → 200，内嵌该棋的游戏页 iframe（?replay=<id>）',
    r.status === 200 && r.text.includes('/games/gomoku/index.html?replay=' + replayId), r.status + ' ' + r.text.slice(0, 160));
  ok('回放页给出「回放链接」与双方名字', r.text.includes('回放链接') && r.text.includes('甲') && r.text.includes('乙'), '');
  r = await getRaw('/replay/99999999');
  ok('回放页棋谱不存在 → 404 页', r.status === 404 && r.text.includes('404'), r.status);

  /* ---------- 观战：只看不走 ---------- */
  r = await post('/api/play/create', { game: 'gomoku', name: '观战甲' });
  const wHost = r.data || {};
  const wRoom = wHost.room || {};
  const wKey = wRoom.watchKey || '';
  ok('为观战另开一间房（201、0 号座位、拿得到观战钥匙）',
    r.status === 201 && wHost.seat === 0 && /^\d+-[a-f0-9]{12,64}$/.test(wKey), r.status + ' ' + r.text.slice(0, 160));
  ok('建房响应里没有 host_token / guest_token', !/host_token|guest_token/.test(r.text), r.text.slice(0, 160));

  r = await post('/api/play/join', { code: wRoom.code, name: '观战乙' });
  const wGuest = r.data || {};
  ok('第二个人加入观战房 → 1 号座位、开局',
    r.status === 200 && wGuest.seat === 1 && !!wGuest.room && wGuest.room.status === 'playing', r.status + ' ' + r.text.slice(0, 160));
  r = await post('/api/play/move', { id: wRoom.id, token: wHost.token, move: { x: 7, y: 7 } });
  ok('观战房第一手（房主）', r.status === 200 && r.data.seq === 1, r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/move', { id: wRoom.id, token: wGuest.token, move: { x: 7, y: 8 } });
  ok('观战房第二手（对手），棋还没下完', r.status === 200 && r.data.seq === 2 && r.data.finished === false, r.status + ' ' + r.text.slice(0, 120));

  r = await post('/api/play/watch', { key: wKey, since: 0 });
  const w1 = r.data || {};
  ok('凭观战钥匙看棋 → 200，座位 -1（只看不走）',
    r.status === 200 && w1.ok === true && !!w1.room && w1.room.seat === -1 && w1.watch === true, r.status + ' ' + r.text.slice(0, 200));
  ok('观战拿到公开房间视图与已有走子',
    !!w1.room && w1.room.id === wRoom.id && !!w1.room.players && w1.room.players[0].name === '观战甲' &&
    Array.isArray(w1.moves) && w1.moves.length === 2, JSON.stringify(w1.moves));
  ok('观战走子带座位与内容（0 → 1）',
    Array.isArray(w1.moves) && w1.moves[0].seat === 0 && w1.moves[1].seat === 1 && typeof w1.moves[1].move === 'string',
    JSON.stringify(w1.moves));
  ok('观战的公开视图里没有 host_token / guest_token，也不回发观战钥匙',
    !!w1.room && !('host_token' in w1.room) && !('guest_token' in w1.room) && w1.room.watchKey === '' && !/host_token|guest_token/.test(r.text),
    r.text.slice(0, 200));

  r = await post('/api/play/watch', { key: wKey, since: 1 });
  ok('观战增量：since=1 只回第二手',
    r.status === 200 && !!r.data && Array.isArray(r.data.moves) && r.data.moves.length === 1 && r.data.moves[0].seq === 2,
    JSON.stringify(r.data && r.data.moves));

  r = await post('/api/play/watch', { key: 'not-a-key', since: 0 });
  ok('乱写的观战钥匙 → 403 bad_token', r.status === 403 && !!r.data && r.data.error === 'bad_token', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/watch', { key: wRoom.id + '-' + 'f'.repeat(24), since: 0 });
  ok('房间号对、钥匙不对 → 403 bad_token', r.status === 403 && !!r.data && r.data.error === 'bad_token', r.status + ' ' + r.text.slice(0, 120));
  r = await post('/api/play/watch', { key: '99999999-' + 'a'.repeat(24), since: 0 });
  ok('钥匙格式合法但房间不存在 → 404 not_found', r.status === 404 && !!r.data && r.data.error === 'not_found', r.status + ' ' + r.text.slice(0, 120));

  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
}

export const finished = main().catch((err) => {
  console.error('测试脚本自身出错：', err);
  process.exitCode = 1;
});
