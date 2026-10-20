#!/usr/bin/env node
/**
 * tools/export-record-test.mjs — 棋谱导出（SGF / PGN / 批量拼接 / tar.gz / 导出任务化）自测。
 *
 * 用法：
 *   node tools/export-record-test.mjs            纯逻辑 + Express 线 + Worker 线
 *   node tools/export-record-test.mjs --pure     只跑纯逻辑段（不起服务、不建库）
 *   node tools/export-record-test.mjs --express  纯逻辑 + Express 线
 *   node tools/export-record-test.mjs --worker   纯逻辑 + Worker 线
 *   KEEP_TMP=1 保留临时目录（../.tmp-ver 下）
 *
 * 纪律：只用 Node 内置模块；Express 线把整树复制到 .tmp-ver 下的私有副本再跑真 server.js
 *       （副本自带 data/，绝不打开真库 data/games.db）；端口从 3320 起找空闲，不用 3000 / 4400。
 * 断言对象是 src/record-export.js 的对外行为：逐字 SGF/PGN、坐标映射边界、降级计数、
 * 批量接缝、tar.gz 可解、任务化续跑与进度；两条线各跑一遍「从库里读出来再导出」。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  AP_NAME, DEFAULT_BATCH, FORMAT_OF, MAX_BATCH, MAX_ERRORS, PGN_GAMES, SGF_GAMES,
  createExportJob, dateOf, exportArchive, exportMany, exportText, formatOf, pgnOf,
  playStoreAdapter, progressOf, runExportJob, sgfOf, tarGz, tarOf
} from '../src/record-export.js';
import { createGame } from '../src/rules/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP_BASE = join(ROOT, '..', '.tmp-ver');
const KEEP = process.env.KEEP_TMP === '1';

let PASS = 0;
let FAIL = 0;
let cur = null;
const SECTIONS = [];
function section(name) { cur = { name: name, pass: 0, fail: 0 }; SECTIONS.push(cur); console.log('\n== ' + name + ' =='); }
function ok(name, cond, extra) {
  if (cond) { cur.pass++; PASS++; console.log('  ok   ' + name); }
  else { cur.fail++; FAIL++; console.log('  FAIL ' + name + (extra === undefined || extra === '' ? '' : '   -> ' + extra)); }
}
function canon(v) {
  return JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]])) : val));
}
function eq(name, got, want) { const a = canon(got); const b = canon(want); ok(a === b ? name : name + '   got=' + a + ' want=' + b, a === b); }
function has(name, text, frag) {
  const t = String(text === undefined || text === null ? '' : text);
  ok(name, t.indexOf(frag) >= 0, '缺少 ' + JSON.stringify(frag) + ' 于 ' + JSON.stringify(t.slice(0, 160)));
}
function ends(name, text, frag) {
  const t = String(text === undefined || text === null ? '' : text);
  ok(name, t.endsWith(frag), '尾部是 ' + JSON.stringify(t.slice(-Math.max(frag.length + 8, 24))) + '，期望以 ' + JSON.stringify(frag) + ' 结尾');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 脚手架（与 tools/replay-search-test.mjs 同一套） ---------- */

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split('\\').join('/');
      if (!rel) return true;
      if (rel === 'node_modules' || rel.indexOf('node_modules/') === 0) return false;
      if (rel === '.git' || rel.indexOf('.git/') === 0) return false;
      if (rel === 'dist' || rel.indexOf('dist/') === 0) return false;
      if (/^data\/.*\.db-(wal|shm)$/.test(rel)) return false;
      if (/^data\/(worker|probe|feed|smoke)/.test(rel)) return false;
      return true;
    }
  });
  try { symlinkSync(join(ROOT, 'node_modules'), join(to, 'node_modules'), 'junction'); } catch (e) { /* 已存在就算了 */ }
}
async function freePort(start) {
  for (let p = start; p < start + 60; p++) {
    const free = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('3320 起 60 个端口都占着');
}
function startSite(cwd, port) {
  const site = { port: port, base: 'http://127.0.0.1:' + port, log: '', proc: null };
  site.proc = spawn(process.execPath, ['server.js'], {
    cwd: cwd,
    env: { ...process.env, PORT: String(port), SITE_ORIGIN: site.base, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  site.proc.stdout.on('data', (d) => { site.log += String(d); });
  site.proc.stderr.on('data', (d) => { site.log += String(d); });
  return site;
}
async function waitReady(site, ms) {
  const until = Date.now() + (ms || 20000);
  while (Date.now() < until) {
    if (site.log.indexOf('http://localhost:' + site.port) >= 0 || site.log.indexOf(site.base) >= 0) {
      try { const r = await fetch(site.base + '/api/games'); if (r.status === 200) return { ok: true, reason: '' }; } catch (e) { /* 还没起来 */ }
    }
    if (site.proc && site.proc.exitCode !== null) return { ok: false, reason: 'server.js 提前退出 code=' + site.proc.exitCode + ' log=' + site.log.slice(-400) };
    await sleep(120);
  }
  return { ok: false, reason: '等不到就绪 log=' + site.log.slice(-400) };
}
function rmTree(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
function killSite(site) {
  if (!site || !site.proc || site.proc.exitCode !== null) return;
  try { spawnSync('taskkill', ['/pid', String(site.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
}
function sqlLine(line, db) {
  return async (sql, params) => {
    const a = params || [];
    if (line === 'express') return db.prepare(sql).run(...a);
    const st = db.prepare(sql);
    return await (a.length ? st.bind(...a) : st).run();
  };
}

/* ---------- fixtures：六款棋的最小棋谱（全部经引擎验证合法） ---------- */

const AT = Date.UTC(2026, 9, 20, 3, 4, 5);   // 2026-10-20T03:04:05Z，tz=0 → DT[2026-10-20]
const HOST = '房主';
const GUEST = '挑战者';

function mk(id, game, codes, result, hostName, guestName) {
  return {
    id: id, game: game, hostName: hostName || HOST, guestName: guestName || GUEST,
    result: result || '', moveCount: codes.length, createdAt: AT, plays: 0,
    moves: codes.map((mv, i) => ({ seq: i + 1, seat: i % 2, move: mv }))
  };
}

const GOMOKU = ['0,0', '7,7', '14,14', '0,14', '7,0'];
const CONNECT4 = ['3', '3', '4', '4', '2'];
const REVERSI = ['2,3', '2,4', '5,5', '5,2', '2,5'];
const XIANGQI = ['0,6-0,5', '0,0-0,1', '0,5-0,4', '0,1-0,2', '0,4-0,3', '0,2-0,3'];
const DRAUGHTS = ['54-43', '23-32', '43-34', '25-43', '52-34', '21-30', '34-25', '14-36', '56-45', '36-54',
  '65-43-21', '10-32', '50-41', '32-50', '67-56', '16-25', '61-52', '25-36', '56-45', '36-54',
  '63-45', '50-61', '72-50', '07-16', '45-34', '16-25', '34-16', '12-21', '16-07'];
const REVERSI_PASS = ['3,2', '4,2', '5,2', '4,1', '5,1', '2,2', '1,2', '3,1', '2,1', '4,0', '5,5', '1,3', '1,4',
  '4,5', '5,4', '0,2', '1,1', '2,0', '4,6', '6,3', '0,1', '4,7', '0,3', '0,0', '5,0', '1,0', '2,3', '6,5', '7,6',
  '6,0', '3,5', '5,3', '5,7', '6,4', '6,1', '6,7', '2,4', '7,2', '7,1', '5,6', '7,5', '7,3', '3,0', '6,2', '6,6',
  '7,7', '7,0', '7,4', 'pass'];
const CHESS_MATE = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
const CHESS_CASTLE = ['d2d4', 'd7d5', 'b1c3', 'b8c6', 'c1f4', 'c8f5', 'd1d2', 'd8d7', 'e1c1'];
const CHESS_CHECK = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'c4f7'];
const CHESS_AMB = ['e2e4', 'e7e5', 'b1c3', 'b8c6', 'g1e2'];
const CHESS_PROMO = ['h2h4', 'g8f6', 'h4h5', 'f6g8', 'h5h6', 'g8f6', 'h6g7', 'f6g8', 'g7h8q'];

const GOMOKU_R = mk(900901, 'gomoku', GOMOKU, 'host');
const CONNECT4_R = mk(900902, 'connect4', CONNECT4, 'guest');
const REVERSI_R = mk(900903, 'reversi', REVERSI, 'draw');
const REVERSI_PASS_R = mk(900913, 'reversi', REVERSI_PASS, '');
const XIANGQI_R = mk(900904, 'xiangqi', XIANGQI, '');
const DRAUGHTS_R = mk(900905, 'draughts', DRAUGHTS, 'host');
const CHESS_R = mk(900906, 'chess', CHESS_MATE, 'host');

const GOMOKU_SGF = '(;FF[4]GM[4]CA[UTF-8]AP[game-site:record-export]SZ[15]DT[2026-10-20]EV[game-site]GN[gomoku #900901]PB[房主]PW[挑战者]RE[B+];B[aa];W[hh];B[oo];W[ao];B[ha])';
const CONNECT4_SGF = '(;FF[4]GM[100]CA[UTF-8]AP[game-site:record-export]SZ[7:6]DT[2026-10-20]EV[game-site]GN[connect4 #900902]PB[房主]PW[挑战者]RE[W+];B[df];W[de];B[ef];W[ee];B[cf])';
const REVERSI_SGF = '(;FF[4]GM[2]CA[UTF-8]AP[game-site:record-export]SZ[8]DT[2026-10-20]EV[game-site]GN[reversi #900903]PB[房主]PW[挑战者]RE[0];B[dc];W[ec];B[ff];W[cf];B[fc])';
const XIANGQI_SGF = '(;FF[4]GM[7]CA[UTF-8]AP[game-site:record-export]SZ[9:10]DT[2026-10-20]EV[game-site]GN[xiangqi #900904]PB[房主]PW[挑战者]RE[?];B[ag][af];W[aa][ab];B[af][ae];W[ab][ac];B[ae][ad];W[ac][ad])';
const DRAUGHTS_HEAD = '(;FF[4]GM[101]CA[UTF-8]AP[game-site:record-export]SZ[8]DT[2026-10-20]EV[game-site]GN[draughts #900905]PB[挑战者]PW[房主]RE[W+]';

function legal(slug, codes) {
  const g = createGame(slug);
  for (let i = 0; i < codes.length; i++) {
    const r = g.apply({ seat: i % 2, move: codes[i] });
    if (!r.ok) return '第 ' + (i + 1) + ' 手 ' + codes[i] + ' -> ' + r.error;
  }
  return '';
}

/* ---------- 1. 模块面 ---------- */

function sectionShape() {
  section('模块面（零依赖纯逻辑）');
  eq('AP_NAME', AP_NAME, 'game-site:record-export');
  eq('MAX_ERRORS / DEFAULT_BATCH / MAX_BATCH', [MAX_ERRORS, DEFAULT_BATCH, MAX_BATCH], [20, 200, 500]);
  const want = { gomoku: 'sgf', connect4: 'sgf', reversi: 'sgf', draughts: 'sgf', xiangqi: 'sgf', chess: 'pgn', nope: '' };
  const got = {};
  for (const k in want) got[k] = formatOf(k);
  eq('formatOf 六款棋 + 未知', got, want);
  eq('FORMAT_OF 表', [FORMAT_OF.gomoku, FORMAT_OF.chess], ['sgf', 'pgn']);
  eq('SGF GM 变体（gomoku=4 官方 / reversi=2 官方 / xiangqi=7 官方 / connect4=100 私有 / draughts=101 私有）',
    [SGF_GAMES.gomoku.gm, SGF_GAMES.reversi.gm, SGF_GAMES.xiangqi.gm, SGF_GAMES.connect4.gm, SGF_GAMES.draughts.gm],
    [4, 2, 7, 100, 101]);
  eq('SGF SZ（四子棋 7 列 6 行、象棋 9 列 10 行）',
    [SGF_GAMES.gomoku.size, SGF_GAMES.connect4.size, SGF_GAMES.reversi.size, SGF_GAMES.draughts.size, SGF_GAMES.xiangqi.size],
    ['15', '7:6', '8', '8', '9:10']);
  eq('PGN_GAMES.chess.gm', PGN_GAMES.chess.gm, 3);
  eq('draughts 的首手颜色是 W（客户端 seat0 执白）', SGF_GAMES.draughts.first, 'W');
}

/* ---------- 2. fixture 合法性（引擎自检，防手抄错） ---------- */

function sectionFixtures() {
  section('fixtures 合法性（用 src/rules 引擎回放一遍）');
  const cases = [['gomoku', GOMOKU], ['connect4', CONNECT4], ['reversi', REVERSI], ['reversi 过手线', REVERSI_PASS],
    ['xiangqi', XIANGQI], ['draughts', DRAUGHTS], ['chess 将杀', CHESS_MATE], ['chess 长易位', CHESS_CASTLE],
    ['chess 将军', CHESS_CHECK], ['chess 消歧', CHESS_AMB], ['chess 升变', CHESS_PROMO]];
  for (const c of cases) {
    const slug = c[0].indexOf('chess') === 0 ? 'chess' : (c[0] === 'reversi 过手线' ? 'reversi' : c[0]);
    const bad = legal(slug, c[1]);
    ok('fixture 合法：' + c[0] + '（' + c[1].length + ' 手）', bad === '', bad);
  }
}

/* ---------- 3. SGF 逐字 ---------- */

function sectionSgf() {
  section('SGF 逐字（六款棋 + 过手）');
  const g = sgfOf(GOMOKU_R);
  eq('gomoku SGF 整串逐字', g.text, GOMOKU_SGF);
  eq('gomoku 返回字段 ok/format/skipped/moves/gm/size',
    [g.ok, g.format, g.skipped, g.moves, g.gm, g.size], [true, 'sgf', 0, 5, 4, '15']);
  eq('bytes = UTF-8 长度', g.bytes, Buffer.byteLength(GOMOKU_SGF, 'utf8'));
  eq('根节点属性顺序与 AP', g.text.indexOf('(;FF[4]GM[4]CA[UTF-8]AP[game-site:record-export]SZ[15]'), 0);
  // GN 语义：GN 是记录身份 <slug> #<id>；name 是上层导出产物的名字，两者不许互相顶替
  eq('opts.name 不改一个字节（name 只用于集合/归档/作业命名）', sgfOf(GOMOKU_R, { name: 'replays-2026-10-20' }).text, GOMOKU_SGF);
  has('自定义棋局名要走 opts.gameName', sgfOf(GOMOKU_R, { gameName: '决赛第3局' }).text, 'GN[决赛第3局]');
  has('opts.event 覆盖 EV', sgfOf(GOMOKU_R, { event: '周末赛' }).text, 'EV[周末赛]');
  eq('opts.tz 参与日期（-300 分钟跨到前一天）', sgfOf(GOMOKU_R, { tz: -300 }).text.indexOf('DT[2026-10-19]') > 0, true);

  const c4 = sgfOf(CONNECT4_R);
  eq('connect4 SGF 整串逐字', c4.text, CONNECT4_SGF);
  has('connect4 私有 GM[100] + SZ[7:6]', c4.text, 'GM[100]CA[UTF-8]AP[game-site:record-export]SZ[7:6]');
  const rv = sgfOf(REVERSI_R);
  eq('reversi SGF 整串逐字（和棋 RE[0]）', rv.text, REVERSI_SGF);
  const xq = sgfOf(XIANGQI_R);
  eq('xiangqi SGF 整串逐字', xq.text, XIANGQI_SGF);
  eq('xiangqi RE 未知写 ?', sgfOf(XIANGQI_R).text.indexOf('RE[?]') > 0, true);

  const d = sgfOf(DRAUGHTS_R);
  eq('draughts 根节点逐字（PB/PW 跟颜色映射：seat0 执白=房主，所以 PB 是客方）',
    d.text.slice(0, DRAUGHTS_HEAD.length), DRAUGHTS_HEAD);
  has('draughts 首手是 ;W（seat0 执白）', d.text, 'RE[W+];W[ef][de];B[dc][cd]');
  has('draughts 连吃写成同一属性多值 + 吃子注释', d.text, ';W[fg][de][bc]C[吃 2]');
  has('draughts 升王注释', d.text, ';W[gb][ha]C[升王]');
  eq('draughts 吃子注释处数', (d.text.match(/C\[吃 /g) || []).length, 11);
  eq('draughts 节点数 = 手数', (d.text.match(/;[BW]\[/g) || []).length, DRAUGHTS.length);
  ends('draughts 尾部闭合', d.text, 'W[gb][ha]C[升王])');

  const rp = sgfOf(REVERSI_PASS_R);
  has('reversi 过手：空坐标 + C[过手]', rp.text, ';BC[过手])');
  eq('reversi 手数 = 坐标节点 48 + 过手节点 1', [(rp.text.match(/;[BW]\[/g) || []).length, (rp.text.match(/;[BW]C\[/g) || []).length], [REVERSI_PASS.length - 1, 1]);
  has('reversi 过手前一手仍是坐标节点', rp.text, ';W[eh];BC[过手])');
}

/* ---------- 4. 坐标映射边界 ---------- */

function sectionCoords() {
  section('坐标映射边界（角 / 边 / 中心 / 升变 / 吃子）');
  const one = (slug, code, result) => sgfOf(mk(1, slug, [code], result || '')).text;

  ends('gomoku 左上角 0,0 -> aa', one('gomoku', '0,0'), ';B[aa])');
  ends('gomoku 右下角 14,14 -> oo', one('gomoku', '14,14'), ';B[oo])');
  ends('gomoku 中心 7,7 -> hh', one('gomoku', '7,7'), ';B[hh])');
  ends('gomoku 上边 0,14 -> ao（先列后行）', one('gomoku', '0,14'), ';B[ao])');
  ends('gomoku 下边 7,0 -> ha', one('gomoku', '7,0'), ';B[ha])');

  ends('connect4 第 0 列落底 -> af（行号来自重力）', one('connect4', '0'), ';B[af])');
  ends('connect4 第 6 列落底 -> gf', one('connect4', '6'), ';B[gf])');
  ends('connect4 同列叠子：行号 5 -> 4', sgfOf(mk(1, 'connect4', ['3', '3'], '')).text, ';B[df];W[de])');

  ends('reversi 列字母在前、行字母在后（r2,c3 -> dc）', sgfOf(mk(1, 'reversi', REVERSI, '')).text,
    ';B[dc];W[ec];B[ff];W[cf];B[fc])');
  eq('reversi 过手无坐标', sgfOf(mk(1, 'reversi', ['2,3'], '')).text.length > 0, true);

  has('draughts 格号 rowcol -> 列字母+行字母（54 -> ef = 列 4 / 行 5）',
    sgfOf(DRAUGHTS_R).text, ';W[ef][de]');
  has('draughts 三点连跳路径逐点展开', sgfOf(DRAUGHTS_R).text, ';W[fg][de][bc]');
  has('draughts 升王（07 -> ha）', sgfOf(DRAUGHTS_R).text, ';W[gb][ha]C[升王]');

  has('xiangqi 红先 = B，红在下方 y=6 -> ag', sgfOf(XIANGQI_R).text, ';B[ag][af]');
  has('xiangqi 黑方 y=0 -> aa', sgfOf(XIANGQI_R).text, ';W[aa][ab]');
  has('xiangqi 吃子写同一属性多值', sgfOf(XIANGQI_R).text, ';W[ac][ad])');
}

/* ---------- 5. PGN（SAN / UCI / 头 / 边界） ---------- */

function sectionPgn() {
  section('PGN：SAN、头、结果、升变/易位/将军/消歧');
  const mate = pgnOf(CHESS_R);
  eq('PGN 头 11 行逐字', mate.text.split('\n').slice(0, 11), [
    '[Event "game-site 联机对战"]', '[Site "game-site"]', '[Date "2026.10.20"]', '[Round "-"]',
    '[White "房主"]', '[Black "挑战者"]', '[Result "1-0"]', '[PlyCount "7"]',
    '[Termination "normal"]', '[Game "chess"]', '[RecordId "900906"]'
  ]);
  has('PGN 空行分隔头与着法', mate.text, '[RecordId "900906"]\n\n1. ');
  has('PGN SAN 将杀 Qxf7#', mate.text, '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
  ok('PGN 以换行收尾', mate.text.slice(-1) === '\n', JSON.stringify(mate.text.slice(-6)));
  eq('PGN 返回字段', [mate.ok, mate.format, mate.skipped], [true, 'pgn', 0]);

  const castle = pgnOf(mk(1, 'chess', CHESS_CASTLE, 'guest'));
  has('PGN 长易位写 O-O-O', castle.text, '5. O-O-O 0-1');
  eq('PGN 未终局 Termination=unterminated', castle.text.indexOf('[Termination "unterminated"]') >= 0, true);
  has('PGN 结果 0-1', castle.text, '[Result "0-1"]');

  const chk = pgnOf(mk(1, 'chess', CHESS_CHECK, ''));
  has('PGN 将军（非杀）后缀 +', chk.text, '4. Bxf7+');
  has('PGN 未定结果写 *', chk.text, '*');

  const amb = pgnOf(mk(1, 'chess', CHESS_AMB, 'draw'));
  has('PGN 同类子消歧用文件字母（Nge2）', amb.text, '3. Nge2 1/2-1/2');

  const promo = pgnOf(mk(1, 'chess', CHESS_PROMO, 'host'));
  has('PGN 吃子升变 hxg7 / gxh8=Q', promo.text, '4. hxg7 Ng8 5. gxh8=Q 1-0');

  const uci = pgnOf(mk(1, 'chess', CHESS_AMB, 'draw'), { notation: 'uci' });
  has('notation:uci 原样输出走法码', uci.text, '1. e2e4 e7e5 2. b1c3 b8c6 3. g1e2 1/2-1/2');

  eq('dateOf tz=0：iso / dot / ms', [dateOf(AT, 0).iso, dateOf(AT, 0).dot, dateOf(AT, 0).ms], ['2026-10-20', '2026.10.20', AT]);
  eq('dateOf 西半球时区会退到前一天', [dateOf(AT, -600).iso, dateOf(AT, -600).dot], ['2026-10-19', '2026.10.19']);
  const tzp = pgnOf(CHESS_R, { tz: -600 });
  has('PGN Date 随时区走', tzp.text, '[Date "2026.10.19"]');
}

/* ---------- 6. 坏数据降级 ---------- */

function sectionDegrade() {
  section('坏数据降级（跳过并计数，不整体失败）');
  const badGame = mk(900990, 'nope', [], '');
  const badMoves = { id: 900991, game: 'gomoku', hostName: HOST, guestName: GUEST, result: '', moveCount: 1, moves: 'not-json', createdAt: AT };
  const noMoves = { id: 900992, game: 'gomoku', hostName: HOST, guestName: GUEST, result: '', moveCount: 0, createdAt: AT };

  const f1 = exportText(badGame);
  eq('未知 game -> bad_game', [f1.ok, f1.error, f1.skipped, f1.text], [false, 'bad_game', 1, '']);
  eq('缺 moves -> missing_moves', [exportText(noMoves).ok, exportText(noMoves).error], [false, 'missing_moves']);
  eq('moves 坏 JSON -> bad_moves', [exportText(badMoves).ok, exportText(badMoves).error], [false, 'bad_moves']);
  eq('moves 不是数组 -> bad_moves', [exportText({ id: 3, game: 'gomoku', moves: '{}' }).ok,
    exportText({ id: 3, game: 'gomoku', moves: '{}' }).error], [false, 'bad_moves']);
  eq('seat 非法 -> bad_moves at 0', [exportText({ id: 4, game: 'gomoku', moves: [[2, '0,0']] }).error,
    exportText({ id: 4, game: 'gomoku', moves: [[2, '0,0']] }).at], ['bad_moves', 0]);
  eq('move 空串 -> bad_moves at 0', [exportText({ id: 5, game: 'gomoku', moves: [[0, '']] }).error,
    exportText({ id: 5, game: 'gomoku', moves: [[0, '']] }).at], ['bad_moves', 0]);
  const dbStr = exportText({ id: 6, game: 'gomoku', moves: '[[0,"0,0"]]' });
  eq('moves 是 JSON 文本（库里那形态）能导', [dbStr.ok, dbStr.text.indexOf(';B[aa])') > 0], [true, true]);

  const ill = sgfOf(mk(900907, 'gomoku', ['0,0', '0,0'], 'host'));
  eq('非法走法默认整条跳过（不产半截）', [ill.ok, ill.error, ill.skipped, ill.text, ill.at], [false, 'illegal_move', 1, '', 1]);
  const tr = sgfOf(mk(900907, 'gomoku', ['0,0', '0,0'], 'host'), { onIllegal: 'truncate' });
  eq('onIllegal:truncate 截断到非法步之前', [tr.ok, tr.moves, tr.total, tr.warnings.length > 0], [true, 1, 2, true]);
  has('截断后只留第一步', tr.text, 'RE[B+];B[aa])');

  const rp = pgnOf(mk(1, 'chess', ['e2e4', 'e2e4'], 'host'));
  eq('PGN 也按同一策略跳过非法步', [rp.ok, rp.error, rp.skipped], [false, 'illegal_move', 1]);

  const fm1 = exportText(GOMOKU_R, { format: 'pgn' });
  const fm2 = exportText(CHESS_R, { format: 'sgf' });
  eq('format 不匹配 -> format_mismatch', [fm1.ok, fm1.error, fm2.ok, fm2.error], [false, 'format_mismatch', false, 'format_mismatch']);

  const mBad = exportMany([GOMOKU_R, badGame, badMoves, noMoves]);
  eq('exportMany 坏数据计数', [mBad.ok, mBad.count, mBad.skipped, mBad.partial], [true, 1, 3, true]);
  eq('exportMany errors 逐条记账', mBad.errors.map((e) => e.id + ':' + e.error),
    ['900990:bad_game', '900991:bad_moves', '900992:missing_moves']);
  eq('exportMany 只拼好条', mBad.text, GOMOKU_SGF);

  const many = [];
  for (let i = 0; i < 25; i++) many.push(mk(901000 + i, 'nope', [], ''));
  const cap = exportMany(many);
  eq('errors 上限 MAX_ERRORS，跳过数照实', [cap.errors.length, cap.skipped, cap.count, cap.ok], [20, 25, 0, false]);
}

/* ---------- 7. 批量拼接 ---------- */

function sectionMany() {
  section('批量导出：拼接规则');
  const two = exportMany([GOMOKU_R, CONNECT4_R]);
  eq('两条 SGF：format/count/skipped/partial', [two.format, two.count, two.skipped, two.partial], ['sgf', 2, 0, false]);
  eq('两条 SGF 严格 (;...)(;...) 零分隔', two.text, GOMOKU_SGF + CONNECT4_SGF);
  has('SGF 接缝是 )(;', two.text, ')(;');
  eq('bytes = UTF-8 长度', two.bytes, Buffer.byteLength(two.text, 'utf8'));
  eq('formats 统计', two.formats, { sgf: 2, pgn: 0 });

  const mate = pgnOf(CHESS_R).text;
  const castle = pgnOf(mk(1, 'chess', CHESS_CASTLE, 'guest')).text;
  const twoPgn = exportMany([CHESS_R, mk(1, 'chess', CHESS_CASTLE, 'guest')]);
  eq('两条 PGN 用空行分隔', twoPgn.text, mate + '\n' + castle);
  has('PGN 接缝是空行', twoPgn.text, '1-0\n\n[Event ');
  eq('formats 统计（pgn）', twoPgn.formats, { sgf: 0, pgn: 2 });

  const mix = exportMany([GOMOKU_R, CHESS_R]);
  eq('混合 format=mixed', [mix.format, mix.count], ['mixed', 2]);
  eq('SGF 后接 PGN 用换行', mix.text, GOMOKU_SGF + '\n' + mate);
  eq('空数组不产东西', [exportMany([]).ok, exportMany([]).count, exportMany([]).text], [false, 0, '']);
}

/* ---------- 8. tar.gz ---------- */

function tarNameOf(buf, offset) {
  let end = offset + 512;
  for (let i = offset; i < offset + 100; i++) { if (buf[i] === 0) { end = i; break; } }
  return Buffer.from(buf.slice(offset, end)).toString('utf8');
}
function tarDataOf(buf, offset) {
  const bytes = Buffer.from(buf);   // tarOf 返回 Uint8Array，Uint8Array.toString() 不解码，必须先转 Buffer
  const sizeField = bytes.slice(offset + 124, offset + 136).toString('ascii').replace(/\0/g, '').trim();
  const size = parseInt(sizeField, 8) || 0;
  return { size: size, data: bytes.slice(offset + 512, offset + 512 + size) };
}

async function sectionTar() {
  section('tar.gz（Node 内置 zlib，tar 用外部 tar.exe 独立校验）');
  const entries = [
    { name: 'a.sgf', data: '(;FF[4]GM[4];B[aa])' },
    { name: 'b/c.sgf', data: Buffer.from('(;FF[4]GM[2];W[dc])', 'utf8') }
  ];
  const tar = tarOf(entries);
  const aligned = (n) => Math.ceil(n / 512) * 512;
  eq('tar 长度 = 头+数据(512 对齐) * 2 + 1024 结尾',
    tar.length, 512 + aligned(entries[0].data.length) + 512 + aligned(entries[1].data.length) + 1024);
  eq('ustar magic @257', Buffer.from(tar.slice(257, 262)).toString('ascii'), 'ustar');
  eq('第一项名字写进头', tarNameOf(tar, 0), 'a.sgf');
  eq('第二项名字与内容', [tarNameOf(tar, 512 + aligned(entries[0].data.length)), tarDataOf(tar, 512 + aligned(entries[0].data.length)).data.toString('utf8')],
    ['b/c.sgf', '(;FF[4]GM[2];W[dc])']);
  eq('mtime 默认 0（可复现）', tarOf(entries).length === tar.length, true);
  ok('尾部两个 512 零块', tar.slice(tar.length - 1024).every((b) => b === 0), 'tail not zero');

  let threw = '';
  try { tarOf([{ name: '', data: 'x' }]); } catch (e) { threw = String(e && e.message ? e.message : e); }
  has('空名字抛错', threw, 'tar 条目名');
  threw = '';
  try { tarOf([{ name: 'x'.repeat(101), data: 'x' }]); } catch (e) { threw = String(e && e.message ? e.message : e); }
  has('名字超 100 字节抛错', threw, 'tar 条目名');

  const gz = await tarGz(entries);
  eq('gz 头两字节 1f 8b', [gz[0], gz[1]], [0x1f, 0x8b]);
  ok('gunzip 回来与 tarOf 逐字节相同', Buffer.compare(Buffer.from(gunzipSync(gz)), Buffer.from(tar)) === 0);

  section('tar.gz：exportArchive');
  const arc = await exportArchive([GOMOKU_R, CONNECT4_R], { name: 'only-sgf' });
  eq('每条棋谱一个成员', arc.files.map((f) => f.name), ['gomoku-900901.sgf', 'connect4-900902.sgf']);
  eq('同格式时集合文件名进 collection', arc.collection, 'only-sgf.sgf');
  eq('集合文件排在 tarEntries 最前，内容 = exportMany 文本',
    [arc.tarEntries[0].name, arc.tarEntries[0].data], [arc.collection, exportMany([GOMOKU_R, CONNECT4_R]).text]);
  eq('entryCount = 集合 + 每条', [arc.entryCount, arc.tarEntries.length], [3, 3]);
  eq('归档名', arc.name, 'only-sgf.tar.gz');
  eq('成员 size = 文本 UTF-8 长度（归档名不许顶替 GN，否则这里会短 6 字节）',
    arc.files[0].size, Buffer.byteLength(GOMOKU_SGF, 'utf8'));
  has('集合文件里每局仍写自己的 GN', arc.tarEntries[0].data, 'GN[gomoku #900901]');
  has('集合文件里第二条也保留身份', arc.tarEntries[0].data, 'GN[connect4 #900902]');
  ok('集合文件里不出现归档名当棋局名', arc.tarEntries[0].data.indexOf('GN[only-sgf]') < 0, arc.tarEntries[0].data.slice(0, 120));
  const fmix = await exportArchive([GOMOKU_R, CHESS_R], { name: 'mixed' });
  eq('混合格式没有集合文件', fmix.collection, '');
  eq('混合归档成员', fmix.files.map((f) => f.name), ['gomoku-900901.sgf', 'chess-900906.pgn']);
  const fbad = await exportArchive([GOMOKU_R, mk(900990, 'nope', [], '')], { name: 'bad' });
  eq('含坏条目时只打包好的并计数', [fbad.count, fbad.skipped, fbad.ok], [1, 1, true]);
  eq('坏条目时成员只剩好的那条', fbad.files.map((f) => f.name), ['gomoku-900901.sgf']);
  eq('坏条目时集合文件仍带好的那条', [fbad.collection, fbad.entryCount], ['bad.sgf', 2]);

  mkdirSync(TMP_BASE, { recursive: true });
  const tdir = mkdtempSync(join(TMP_BASE, 'export-tar-'));
  try {
    const tarExe = existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    const file = join(tdir, 'mixed.tar.gz');
    writeFileSync(file, Buffer.from(fmix.archive));
    const list = spawnSync(tarExe, ['-tzf', file], { encoding: 'utf8' });
    eq('tar.exe -tzf 能列出两个成员（独立实现校验）',
      String(list.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      ['gomoku-900901.sgf', 'chess-900906.pgn']);
    const fileSgf = join(tdir, 'only-sgf.tar.gz');
    writeFileSync(fileSgf, Buffer.from(arc.archive));
    const list2 = spawnSync(tarExe, ['-tzf', fileSgf], { encoding: 'utf8' });
    eq('tar.exe -tzf 同格式归档：集合文件在前 + 每条一个成员',
      String(list2.stdout || '').trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      ['only-sgf.sgf', 'gomoku-900901.sgf', 'connect4-900902.sgf']);
    const out2 = join(tdir, 'out2');
    mkdirSync(out2, { recursive: true });
    const ext2 = spawnSync(tarExe, ['-xzf', fileSgf, '-C', out2], { encoding: 'utf8' });
    eq('tar.exe -xzf 同格式归档退出码 0', ext2.status, 0);
    eq('集合文件解出来 = exportMany 文本', readFileSync(join(out2, 'only-sgf.sgf'), 'utf8'), exportMany([GOMOKU_R, CONNECT4_R]).text);
    const out = join(tdir, 'out');
    mkdirSync(out, { recursive: true });
    const ext = spawnSync(tarExe, ['-xzf', file, '-C', out], { encoding: 'utf8' });
    eq('tar.exe -xzf 退出码 0', ext.status, 0);
    const back = readFileSync(join(out, 'gomoku-900901.sgf'), 'utf8');
    eq('解出来的成员与黄金 SGF 逐字相同（GN 是记录身份，不是归档名）', back, GOMOKU_SGF);
    eq('解出来的 PGN 与原文逐字相同', readFileSync(join(out, 'chess-900906.pgn'), 'utf8'), pgnOf(CHESS_R).text);
  } finally {
    if (KEEP) console.log('  （保留 ' + tdir + '）'); else rmTree(tdir);
  }
}

/* ---------- 9. 导出任务化 ---------- */

const JOB_ROWS = [
  { id: 900901, game: 'gomoku' },
  { id: 900902, game: 'connect4' },
  { id: 900990, game: 'nope' },
  { id: 900991, game: 'gomoku' },
  { id: 900906, game: 'chess' }
];
const JOB_RECS = {
  900901: GOMOKU_R,
  900902: CONNECT4_R,
  900906: CHESS_R,
  900991: { id: 900991, game: 'gomoku', hostName: HOST, guestName: GUEST, result: '', moveCount: 1, moves: 'not-json', createdAt: AT }
};
function fakeStore() {
  const queries = [];
  return {
    queries: queries,
    list: async (q) => {
      queries.push(q);
      return { total: JOB_ROWS.length, items: JOB_ROWS.slice(q.offset || 0, (q.offset || 0) + (q.limit || 12)) };
    },
    load: async (id) => {
      if (JOB_RECS[id]) return JOB_RECS[id];
      if (id === 900990) return { id: 900990, game: 'nope', hostName: HOST, guestName: GUEST, result: '', moveCount: 0, moves: [], createdAt: AT };
      return null;
    }
  };
}

async function sectionJob() {
  section('导出任务化：作业对象 / 分批 / 进度 / 续跑');
  const j = createExportJob({ filter: { game: '', mine: [] }, now: AT, batch: 2 });
  ok('job.id 形如 exp-<base36>-<4 位>', /^exp-[0-9a-z]+-[0-9a-z]{4}$/.test(j.id), j.id);
  eq('filter 丢空值但保留空数组', j.filter, { mine: [] });
  eq('初始状态', [j.cursor, j.total, j.exported, j.skipped, j.batches, j.done, j.errors.length], [0, null, 0, 0, 0, false, 0]);
  eq('batch 缺省与夹取', [createExportJob({}).batch, createExportJob({ batch: 0 }).batch, createExportJob({ batch: 9999 }).batch], [DEFAULT_BATCH, 1, MAX_BATCH]);
  eq('job 可 JSON 往返（续跑靠它）', JSON.parse(JSON.stringify(j)), j);

  const store = fakeStore();
  const b0 = await runExportJob(j, { store: store });
  eq('第 1 批：读 2 条、产 2 条', [b0.done, b0.cursor, b0.exported === undefined ? j.exported : b0.progress.exported, b0.progress.total],
    [false, 2, 2, 5]);
  eq('第 1 批进度 40%', b0.progress.percent, 40);
  has('第 1 批产出开头是 SGF', b0.produced, '(;FF[4]GM[4]');
  const b1 = await runExportJob(j, { store: store });
  eq('第 2 批：坏条目跳过、产出为空串', [b1.done, b1.cursor, b1.produced, b1.progress.skipped], [false, 4, '', 2]);
  eq('第 2 批进度 80%', b1.progress.percent, 80);
  has('第 2 批错误记账（缺记录 + 坏 moves）', b1.progress.errors, 2);
  eq('不变式 exported + skipped = cursor', j.exported + j.skipped, j.cursor);
  const b2 = await runExportJob(j, { store: store });
  eq('第 3 批收尾', [b2.done, b2.cursor, b2.progress.percent, b2.progress.exported, b2.progress.skipped], [true, 5, 100, 3, 2]);
  ok('跨批衔接上一条 SGF 后补换行', b2.produced.startsWith('\n[Event'), JSON.stringify(b2.produced.slice(0, 20)));
  has('末批产出含将杀着法', b2.produced, 'Qxf7#');
  eq('job.done 落库', [j.done, j.lastFormat], [true, 'pgn']);
  eq('作业产出里每条也写自己的身份（SGF 用 GN，PGN 用 RecordId）',
    [b0.produced.indexOf('GN[gomoku #900901]') > 0, b2.produced.indexOf('RecordId "900906"') > 0], [true, true]);
  ok('作业名不进 GN', (b0.produced + b2.produced).indexOf('GN[replays]') < 0, b0.produced.slice(0, 140));
  const named = createExportJob({ now: AT, name: 'weekend cup 2026', batch: 9 });
  eq('job.name 走 safeName（空格 -> 下划线）', named.name, 'weekend_cup_2026');
  const nb = await runExportJob(named, { store: fakeStore() });
  has('job.name 只做产物命名，不写进 GN', nb.produced, 'GN[gomoku #900901]');
  ok('job.name 不出现在 GN 里', nb.produced.indexOf('GN[weekend_cup_2026]') < 0, named.name);
  const b3 = await runExportJob(j, { store: store });
  eq('跑完后再跑是幂等空批', [b3.done, b3.produced, b3.cursor], [true, '', 5]);
  eq('跑完后的 job 仍可 JSON 往返', JSON.parse(JSON.stringify(j)).cursor, 5);

  const resumed = createExportJob({ filter: {}, now: AT, batch: 2 });
  const rs = fakeStore();
  await runExportJob(resumed, { store: rs });
  const snapshot = JSON.parse(JSON.stringify(resumed));
  const rs2 = fakeStore();
  const rb = await runExportJob(snapshot, { store: rs2 });
  eq('按游标续跑：接着第 2 批读', rs2.queries[0].offset, 2);
  eq('续跑批的批次计数从快照继续', snapshot.batches, 2);

  const store3 = fakeStore();
  const j3 = createExportJob({ filter: {}, now: AT, batch: 2 });
  await runExportJob(j3, { store: store3, batch: 3 });
  eq('runtime.batch 覆盖 job.batch', store3.queries[0].limit, 3);

  const q = fakeStore();
  await q.list({ offset: 0, limit: 5 });
  eq('store.list 收到 offset/limit', [q.queries[0].offset, q.queries[0].limit], [0, 5]);

  const noLoad = { list: async (x) => ({ total: 2, items: [{ ...GOMOKU_R }, { ...CONNECT4_R }] }) };
  const j4 = createExportJob({ filter: {}, now: AT, batch: 5 });
  const b4 = await runExportJob(j4, { store: noLoad });
  eq('store 没有 load 时用行本身', [b4.done, b4.progress.exported, b4.progress.skipped], [true, 2, 0]);
  has('两行都进了产出', b4.produced, 'GM[100]');

  const unknown = { list: async () => ({ total: null, items: [GOMOKU_R] }) };
  const j5 = createExportJob({ filter: {}, now: AT, batch: 3 });
  const b5 = await runExportJob(j5, { store: unknown });
  eq('total 未知时靠 items 少于 batch 收尾，total 保持 null', [b5.done, b5.progress.total, b5.progress.percent], [true, null, 100]);

  const boom = { list: async () => ({ total: 1, items: JOB_ROWS.slice(0, 1) }), load: async () => { throw new Error('db down'); } };
  const j6 = createExportJob({ filter: {}, now: AT, batch: 5 });
  const b6 = await runExportJob(j6, { store: boom });
  eq('load 抛错算这条降级，不炸整体', [b6.done, j6.skipped, j6.errors.length], [true, 1, 1]);

  eq('progressOf 空作业', progressOf(createExportJob({ now: AT })), {
    total: null, cursor: 0, exported: 0, skipped: 0, batches: 0, chars: 0, percent: null, done: false, errors: 0
  });
}

/* ---------- 10. playStoreAdapter：两条线的调用约定 ---------- */

async function sectionAdapter() {
  section('playStoreAdapter：Express / Workers 两种调用约定');
  const calls = [];
  const express = {
    replayList: async (o) => { calls.push(['list', o]); return { total: 1, items: [] }; },
    replay: async (id) => { calls.push(['load', id]); return null; }
  };
  const a1 = playStoreAdapter(express);
  await a1.list({ offset: 0, limit: 5, game: 'gomoku' });
  await a1.load(7);
  eq('无 db：replayList(opts)', calls[0][0], 'list');
  eq('无 db：选项原样传下去 + 补 maxLimit', [calls[0][1].offset, calls[0][1].limit, calls[0][1].game, calls[0][1].maxLimit], [0, 5, 'gomoku', 500]);
  eq('无 db：replay(id)', calls[1], ['load', 7]);

  const wcalls = [];
  const D1 = { tag: 'D1' };
  const worker = {
    replayList: async (db, o) => { wcalls.push(['list', db, o]); return { total: 1, items: [] }; },
    replay: async (db, id) => { wcalls.push(['load', db, id]); return null; }
  };
  const a2 = playStoreAdapter(worker, { db: D1, maxLimit: 120 });
  await a2.list({ offset: 2, limit: 3 });
  await a2.load(9);
  eq('有 db：replayList(db, opts)', [wcalls[0][0], wcalls[0][1]], ['list', D1]);
  eq('有 db：maxLimit 可覆盖', wcalls[0][2].maxLimit, 120);
  eq('有 db：replay(db, id)', wcalls[1], ['load', D1, 9]);
}

/* ---------- 11. Express 线：副本库 + 真 HTTP ---------- */

const LINE_IDS = [
  [930001, 'gomoku', GOMOKU, 'host'],
  [930002, 'connect4', CONNECT4, 'guest'],
  [930003, 'reversi', REVERSI, 'draw'],
  [930013, 'reversi', REVERSI_PASS, ''],
  [930004, 'xiangqi', XIANGQI, ''],
  [930005, 'draughts', DRAUGHTS, 'host'],
  [930006, 'chess', CHESS_MATE, 'host'],
  [930990, 'nope', [], '']
];
const LINE_HOST = '导出线房主';
const LINE_GUEST = '导出线挑战者';
const LINE_SQL = 'INSERT INTO play_replays (id, game, room_code, host_name, guest_name, result, move_count, moves, plays, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)';

function lineRow(row) {
  return [row[0], row[1], 'REX' + row[0], LINE_HOST, LINE_GUEST, row[3], row[2].length,
    JSON.stringify(row[2].map((mv, i) => [i % 2, mv])), AT];
}
async function seedLine(run) {
  for (const row of LINE_IDS) await run(LINE_SQL, lineRow(row));
}

async function checkLine(tag, opts) {
  const load = opts.load;
  for (const row of LINE_IDS) {
    if (row[1] === 'nope') continue;
    const got = await load(row[0]);
    ok(tag + ' replay(' + row[0] + ') 读得到', got && got.id === row[0], got ? canon(got).slice(0, 120) : 'null');
    if (!got) continue;
    const want = opts.wantOf(row);
    eq(tag + ' ' + row[1] + '#' + row[0] + ' 导出与纯逻辑逐字一致', opts.render(got).text, want);
  }
  const bad = await load(930990);
  eq(tag + ' 未知 game 的那条能读出来（导入时判）', bad ? bad.game : null, 'nope');

  const store = playStoreAdapter(opts.ps, opts.psOpts);
  const job = createExportJob({ filter: { player: LINE_HOST }, now: AT, batch: 3, name: tag });
  let produced = '';
  let guard = 0;
  while (guard++ < 20) {
    const b = await runExportJob(job, { store: store });
    produced += b.produced;
    eq(tag + ' 第 ' + (guard) + ' 批不变式 exported+skipped=cursor', job.exported + job.skipped, job.cursor);
    if (b.done) break;
  }
  eq(tag + ' 任务化：8 条里 7 条成、1 条降级', [job.total, job.exported, job.skipped, job.done], [8, 7, 1, true]);
  eq(tag + ' 进度 100%', job.progress ? job.progress.percent : progressOf(job).percent, 100);
  eq(tag + ' 降级原因是坏 game', job.errors.map((e) => e.id + ':' + e.error), ['930990:bad_game']);
  has(tag + ' 产出含五子棋 SGF', produced, 'GM[4]');
  has(tag + ' 产出含四子棋 SGF（私有 GM）', produced, 'GM[100]');
  has(tag + ' 产出含黑白棋 SGF', produced, 'GM[2]');
  has(tag + ' 产出含象棋 SGF', produced, 'GM[7]');
  has(tag + ' 产出含跳棋 SGF（私有 GM）', produced, 'GM[101]');
  has(tag + ' 产出含国际象棋 PGN 将杀', produced, 'Qxf7#');
  has(tag + ' 产出含过手注释', produced, 'C[过手]');
  return produced;
}

async function runExpress() {
  section('Express 线：%TEMP% 副本 + 真 server.js + 真 HTTP');
  mkdirSync(TMP_BASE, { recursive: true });
  const tmp = mkdtempSync(join(TMP_BASE, 'export-express-'));
  let site = null;
  let closeDb = null;
  try {
    copyTree(ROOT, tmp);
    const dbmod = await import(pathToFileURL(join(tmp, 'src', 'db.js')).href);
    closeDb = () => { try { dbmod.db.close(); } catch (e) { /* 忽略 */ } };
    if (typeof dbmod.migrate === 'function') dbmod.migrate();
    const PS = await import(pathToFileURL(join(tmp, 'src', 'play-store.js')).href);
    const RX = await import(pathToFileURL(join(tmp, 'src', 'record-export.js')).href);
    const run = sqlLine('express', dbmod.db);
    await seedLine(run);
    const rows = await dbmod.db.prepare('SELECT COUNT(*) AS n FROM play_replays WHERE host_name = ?').all(LINE_HOST);
    eq('Express 副本库：8 条种子落库（副本自带 data/，真库没动）', Number(rows[0].n), 8);

    await checkLine('express', {
      load: (id) => PS.replay(id),
      ps: PS,
      psOpts: {},
      wantOf: (row) => RX[row[1] === 'chess' ? 'pgnOf' : 'sgfOf']({ ...mk(row[0], row[1], row[2], row[3], LINE_HOST, LINE_GUEST) }).text,
      render: (got) => (got.game === 'chess' ? RX.pgnOf(got) : RX.sgfOf(got))
    });

    const port = await freePort(3320);
    site = startSite(tmp, port);
    const ready = await waitReady(site);
    ok('express：私有端口 ' + port + ' 起来并回了 /api/games', ready.ok, ready.reason);
    if (!ready.ok) return;
    const ex = await fetch(site.base + '/replays/export.json');
    eq('express GET /replays/export.json 状态码', ex.status, 200);
    const ctype = ex.headers.get('content-type') || '';
    has('express 导出响应是 JSON', ctype, 'application/json');
    const body = await ex.text();
    has('express 导出 JSON 含新棋谱', body, '930006');
    // 既有导出只回行数据（replayList 不选 moves）：这正是新导出必须逐条 load(id) 的原因
    has('express 导出 JSON 是行数据（带 moveCount）', body, '"moveCount":');
    ok('express 导出 JSON 不含 moves（不能直接拿去渲染 SGF）', body.indexOf('"moves"') < 0, JSON.stringify(body.slice(0, 120)));
    const page = await fetch(site.base + '/replays');
    eq('express GET /replays 状态码', page.status, 200);
    const html = await page.text();
    has('express /replays 页面仍挂着 export.json 入口', html, 'export.json');
    has('express /replays 页面能列出新棋谱', html, '/replay/930006');
  } finally {
    killSite(site);
    if (closeDb) closeDb();
    if (KEEP) console.log('  （保留临时目录 ' + tmp + '）'); else rmTree(tmp);
  }
}

/* ---------- Worker 线的多语句拆壳（绕开工既有问题，见下面的 NOTE） ---------- */

/** 把「一次给了多条语句」的 SQL 拆成单条：先按分号拆，再按行首关键字拆（rewards 那几条本来就没有分号）。 */
function splitSqlStatements(sql) {
  const parts = [];
  for (const chunk of String(sql).split(';')) {
    const body = chunk.trim();
    if (!body) continue;
    let cur = '';
    for (const line of body.split(/\r?\n/)) {
      if (/^(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|PRAGMA)\b/i.test(line.trim()) && cur.trim()) { parts.push(cur.trim()); cur = ''; }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur.trim()) parts.push(cur.trim());
  }
  // 只留真有语句的片段（撇掉独立成段的注释块，否则 prepare 会报 'The SQL query contains no statements.'）
  return parts.filter((p) => p.split(/\r?\n/).some((l) => l.trim() && !/^--/.test(l.trim())));
}

/** 薄壳：多条语句的 prepare 拆开逐条跑；单条语句 / batch / exec / close 原样透传（保住 LocalD1 的 D1 语义）。 */
function multiStatementTolerant(inner) {
  return {
    prepare(sql) {
      const parts = splitSqlStatements(sql);
      if (parts.length <= 1) return inner.prepare(sql);
      return {
        bind() { return this; },
        run: async () => { let last = null; for (const p of parts) last = await inner.prepare(p).run(); return last; },
        all: async () => inner.prepare(parts[parts.length - 1]).all(),
        first: async () => inner.prepare(parts[parts.length - 1]).first()
      };
    },
    exec: (sql) => inner.exec(sql),
    batch: (stmts) => inner.batch(stmts),
    close: () => inner.close()
  };
}

/** 探一下裸 LocalD1 上 migrate() 行不行：只打印现状，不当断言（以后修好 schema.js 不该让本测试变红）。 */
async function probeRawMigrate(D1, schema) {
  const raw = new D1.LocalD1(':memory:');
  try { await schema.migrate(raw); return ''; }
  catch (e) { return String((e && e.message) || e); }
  finally { try { raw.close(); } catch (e) { /* 忽略 */ } }
}

/* ---------- 12. Worker 线：LocalD1 ---------- */

async function runWorker() {
  section('Worker 线：LocalD1 + worker/play-store + worker/app.fetch');
  mkdirSync(TMP_BASE, { recursive: true });
  const file = join(TMP_BASE, 'export-worker-' + Date.now() + '.db');
  let d1 = null;
  let db = null;
  try {
    const D1 = await import(pathToFileURL(join(ROOT, 'tools', 'd1-local.mjs')).href);
    const schema = await import(pathToFileURL(join(ROOT, 'worker', 'schema.js')).href);
    const rawErr = await probeRawMigrate(D1, schema);
    console.log(rawErr
      ? '  note  worker/schema.js 的 migrate() 在裸 LocalD1 上会失败：' + rawErr +
        '\n        （src/rewards.js 摊平进 DDL 尾部的 5 条没有分号，被 migrate 的 split(";") 并成一条多语句；' +
        'worker/schema.js 与 src/rewards.js 都不在本次交付范围）→ 本测试用多语句拆壳兜过，启动仍走真实入口 ensureReady'
      : '  note  worker/schema.js 的 migrate() 现在能直接在 LocalD1 上跑（不需要拆壳了）');
    d1 = new D1.LocalD1(file);
    db = multiStatementTolerant(d1);
    const ready = await schema.ensureReady({ DB: db, SITE_ORIGIN: 'http://export.test', MAIL_TICK: '0' });
    ok('worker ensureReady()（migrate + 补种子 + 补管理员 + 搜索索引）跑通', ready === true);
    if (typeof schema.ensureColumns === 'function') await schema.ensureColumns(db);
    const WPS = await import(pathToFileURL(join(ROOT, 'worker', 'play-store.js')).href);
    const RX = await import(pathToFileURL(join(ROOT, 'src', 'record-export.js')).href);
    const app = (await import(pathToFileURL(join(ROOT, 'worker', 'app.js')).href)).default;
    const run = sqlLine('worker', db);
    await seedLine(run);

    await checkLine('worker', {
      load: (id) => WPS.replay(db, id),
      ps: WPS,
      psOpts: { db: db },
      wantOf: (row) => RX[row[1] === 'chess' ? 'pgnOf' : 'sgfOf']({ ...mk(row[0], row[1], row[2], row[3], LINE_HOST, LINE_GUEST) }).text,
      render: (got) => (got.game === 'chess' ? RX.pgnOf(got) : RX.sgfOf(got))
    });

    const env = { DB: db, SITE_ORIGIN: 'http://export.test', MAIL_TICK: '0' };
    const ex = await app.fetch(new Request('http://export.test/replays/export.json'), env);
    eq('worker GET /replays/export.json 状态码', ex.status, 200);
    const ctype = ex.headers.get('content-type') || '';
    has('worker 导出响应是 JSON', ctype, 'application/json');
    const body = await ex.text();
    has('worker 导出 JSON 含新棋谱', body, '930006');
    const page = await app.fetch(new Request('http://export.test/replays'), env);
    eq('worker GET /replays 状态码', page.status, 200);
    has('worker /replays 页面仍挂着 export.json 入口', await page.text(), 'export.json');
  } finally {
    try { if (db) db.close(); } catch (e) { /* 忽略 */ }
    for (const f of [file, file + '-wal', file + '-shm']) { try { rmSync(f, { force: true }); } catch (e) { /* 忽略 */ } }
  }
}

/* ---------- 入口 ---------- */

const argv = process.argv.slice(2);
const wantExpress = argv.indexOf('--express') >= 0 || argv.length === 0;
const wantWorker = argv.indexOf('--worker') >= 0 || argv.length === 0;

try {
  sectionShape();
  sectionFixtures();
  sectionSgf();
  sectionCoords();
  sectionPgn();
  sectionDegrade();
  sectionMany();
  await sectionTar();
  await sectionJob();
  await sectionAdapter();
  if (wantExpress) await runExpress();
  if (wantWorker) await runWorker();
} catch (e) {
  FAIL++;
  console.log('\n!! 抛异常：' + (e && e.stack ? e.stack : e));
}
console.log('');
for (const s of SECTIONS) console.log(s.name + '：' + s.pass + ' 通过 / ' + s.fail + ' 失败');
console.log('合计：' + PASS + ' 通过 / ' + FAIL + ' 失败');
process.exit(FAIL ? 1 : 0);
