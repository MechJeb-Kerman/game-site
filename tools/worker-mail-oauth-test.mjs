/**
 * 一条命令验收 Workers + D1 版的邮件与第三方登录：
 *   起假的邮件服务端与假的 OAuth Provider（tools/mail-oauth-test.mjs）→
 *   起本机 Worker（node:sqlite 冒充 D1）→ 把假服务端的地址灌进 env → 跑同一套断言场景。
 * 与 Express 版共用同一份 runScenario，保证两边行为一致；不需要 wrangler、不需要外网。
 *
 *   node tools/worker-mail-oauth-test.mjs      # 或 pnpm test:worker-mail
 *
 * 用独立数据库 data/worker-mail-test.db，每次运行前删掉重建。
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerServer } from './serve-worker.mjs';
import { startFakes, runScenario, summary } from './mail-oauth-test.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DB = join(ROOT, 'data', 'worker-mail-test.db');

(async () => {
  const fakes = await startFakes();
  await rm(DB, { force: true });
  await rm(DB + '-wal', { force: true });
  await rm(DB + '-shm', { force: true });
  const s = await createWorkerServer({ port: 0, db: DB, env: fakes.env });
  const warm = await s.warmup();
  if (warm.status !== 200) {
    console.error('预热首页失败：HTTP ' + warm.status);
    process.exit(1);
  }
  const base = 'http://127.0.0.1:' + s.port;
  console.log('Worker + D1 假实现已启动：' + base + '（' + warm.games + ' 款游戏）');
  console.log('假邮件服务端：' + fakes.mailUrl + '　假 OAuth Provider：' + fakes.provider);
  await runScenario(base, fakes, {});
  const st = summary();
  console.log('');
  console.log('通过 ' + st.pass + ' 项，失败 ' + st.fail + ' 项');
  await s.close();
  await fakes.close();
  process.exit(st.fail ? 1 : 0);
})().catch(async (e) => { console.error('脚本异常:', e); process.exit(2); });
