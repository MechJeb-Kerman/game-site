/**
 * 端到端跑一遍「全部不需要浏览器」的测试。
 *
 * 为什么要有这个文件：CI 之前只挑了 6 个脚本，结果 /hot 这种「Node 版加了、Worker 版忘了」
 * 的缺口要等到有人手动跑 worker-test 才会暴露。这里把能自动跑的脚本一次性收齐，
 * 任何一条失败就让 CI 红。
 *
 * 不在这里跑的三类（原因见 docs/CI.md 与各脚本头部注释）：
 *   1) 需要站点在跑的整合测试（account/feature/play-api —— 它们自己会起临时端口，这里照跑）；
 *   2) 需要真浏览器的（browser-smoke / pages-smoke / pwa-test / board-games / gamepad / offline-queue）；
 *   3) 生成器与本地服务器（gen-* / build-pages / zip-dist / serve-* / d1-local / meili-index）。
 *
 *   node tools/test-all.mjs [--only=hot,seo] [--list]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

/** 纯 Node 测试：无外网、无浏览器、失败即 CI 红 */
const SUITES = [
  ['hot', 'hot-test.mjs', '热度打分 / 趋势 / 站点地图 / robots'],
  ['seo', 'seo-test.mjs', 'sitemap / robots / JSON-LD 文案'],
  ['rules', 'rules-test.mjs', '五子棋/黑白棋/象棋等规则'],
  ['rules-chess', 'rules-chess-test.mjs', '象棋规则细化'],
  ['rules-xiangqi', 'rules-xiangqi-test.mjs', '象棋走子与将军'],
  ['adapters', 'adapters-test.mjs', '存储/缓存适配层'],
  ['cards', 'cards-test.mjs', '卡片 SVG'],
  ['cover', 'cover-test.mjs', '封面 SVG'],
  ['ratelimit', 'ratelimit-test.mjs', '限流令牌桶'],
  ['ratelimit-shared', 'ratelimit-shared-test.mjs', '跨实例共享限流'],
  ['attachments', 'attachments-test.mjs', '附件审核'],
  ['attachment-store', 'attachment-store-test.mjs', '附件存储'],
  ['attachments-queue', 'offline-queue-test.mjs', '离线投稿队列（纯函数部分）'],
  ['daily-reward', 'daily-reward-test.mjs', '每日挑战奖励'],
  ['daily-streak', 'daily-streak-test.mjs', '连续挑战与补做'],
  ['elo', 'elo-test.mjs', 'ELO 与赛季'],
  ['export-record', 'export-record-test.mjs', '对局导出'],
  ['feed', 'feed-test.mjs', '动态流'],
  ['forum-rules-cache', 'forum-rules-cache-test.mjs', '论坛版规缓存'],
  ['forum-tags', 'forum-tags-test.mjs', '论坛标签'],
  ['mail-admin', 'mail-admin-test.mjs', '站内信后台'],
  ['mail-oauth', 'mail-oauth-test.mjs', '邮件 OAuth'],
  ['mail-report', 'mail-report-test.mjs', '举报与站内信'],
  ['meili-index', 'meili-index-test.mjs', '搜索引擎索引计划'],
  ['oauth-gateway', 'oauth-gateway-test.mjs', '第三方登录网关'],
  ['offline-wire', 'offline-wire-test.mjs', '离线队列与网络事件'],
  ['outbox', 'outbox-test.mjs', '发件箱重试'],
  ['push', 'push-test.mjs', 'Web Push 负载'],
  ['push-wiring', 'push-wiring-test.mjs', '推送装配'],
  ['replay-identity', 'replay-identity-test.mjs', '回放身份'],
  ['replay-search', 'replay-search-test.mjs', '回放搜索'],
  ['rewards-ledger', 'rewards-ledger-test.mjs', '奖励账本'],
  ['search-fallback', 'search-fallback-test.mjs', '搜索降级'],
  ['worker-app', 'worker-app-test.mjs', 'Worker 动态版应用'],
  ['worker-feature', 'worker-feature-test.mjs', 'Worker 功能对等'],
  ['worker-play', 'worker-play-test.mjs', 'Worker 对局'],
  ['worker-mail-oauth', 'worker-mail-oauth-test.mjs', 'Worker 邮件/登录'],
  ['worker-search', 'worker-search-test.mjs', 'Worker 搜索'],
  ['worker-static', 'worker-test.mjs', 'Worker 静态版冒烟'],
  ['check-forum', 'check-forum-host.mjs', '论坛主机判定'],
  ['check-game', 'game-contract-check.mjs', '游戏契约（每个 games/<slug>/index.html）'],
  ['account', 'account-test.mjs', '账号整合（跑在临时站点上）', true],
  ['features', 'feature-test.mjs', '功能整合（跑在临时站点上）', true],
  ['play-api', 'play-api-test.mjs', '对局接口整合（跑在临时站点上）', true]
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return fallback;
  const i = hit.indexOf('=');
  return i < 0 ? '' : hit.slice(i + 1);
};

if (argv.includes('--list')) {
  for (const [id, file, what] of SUITES) console.log(id.padEnd(20), file.padEnd(28), what);
  process.exit(0);
}

const only = String(opt('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const picked = only.length ? SUITES.filter((s) => only.includes(s[0])) : SUITES;

/* 需要「站点在跑」的整合测试：自己起一个临时服务，别去碰使用者可能正开着的 3000 端口。
   BASE 通过环境变量传给脚本（三者都读 process.env.BASE）。 */
let server = null;
let BASE = '';
async function startServer() {
  const { spawn } = await import('node:child_process');
  const port = 3300 + Math.floor(Math.random() * 200);
  BASE = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/games');
      if (res.ok) {
        console.log('临时站点已就绪：' + BASE);
        return true;
      }
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('临时站点启动超时：' + BASE);
  return false;
}
function stopServer() {
  if (!server) return;
  try { server.kill('SIGTERM'); } catch (e) { /* ignore */ }
  server = null;
}

const needServer = picked.some((s) => s[3]);
let serverOk = true;
if (needServer) serverOk = await startServer();

const results = [];
for (const [id, file, what, needsServer] of picked) {
  const filePath = path.join(HERE, file);
  if (!fs.existsSync(filePath)) {
    results.push({ id, file, what, status: 'missing', ms: 0 });
    console.log('MISS ' + id.padEnd(18) + file);
    continue;
  }
  if (needsServer && !serverOk) {
    results.push({ id, file, what, status: 'fail', ms: 0, tail: '临时站点没起来' });
    console.log('FAIL ' + id.padEnd(18) + '   站点未就绪');
    continue;
  }
  const started = Date.now();
  const env = needsServer ? { ...process.env, BASE } : process.env;
  const r = spawnSync(process.execPath, [filePath], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env });
  const ms = Date.now() - started;
  const out = String(r.stdout || '') + String(r.stderr || '');
  const tail = out.trim().split(/\r?\n/).slice(-3).join(' | ');
  const status = r.status === 0 ? 'ok' : 'fail';
  results.push({ id, file, what, status, ms, tail });
  console.log((status === 'ok' ? 'PASS ' : 'FAIL ') + id.padEnd(18) + (ms + 'ms').padStart(7) + '  ' + tail.slice(0, 110));
}
stopServer();

const failed = results.filter((r) => r.status === 'fail');
const missing = results.filter((r) => r.status === 'missing');
const ok = results.length - failed.length - missing.length;
console.log('');
console.log('通过 ' + ok + ' / 失败 ' + failed.length + ' / 缺失 ' + missing.length + '（共 ' + results.length + ' 组）');
if (failed.length) {
  console.log('失败的组：' + failed.map((r) => r.id).join(', '));
  process.exit(1);
}
if (missing.length) {
  console.log('缺失的脚本：' + missing.map((r) => r.file).join(', '));
  process.exit(1);
}
