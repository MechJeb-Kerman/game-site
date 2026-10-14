/**
 * 一条命令验收 Workers + D1 完整版：
 *   起一个本机 Worker（node:sqlite 冒充 D1，见 tools/d1-local.mjs）→ 跑 tools/account-test.mjs 的 57 项断言。
 * 与 Express 版共用同一套验收脚本，保证两边行为一致；不需要 wrangler、不需要外网。
 *
 *   node tools/worker-app-test.mjs
 *
 * 用独立数据库 data/worker-app-test.db，每次运行前删掉重建，不污染 data/worker.db。
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerServer } from './serve-worker.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DB = join(ROOT, 'data', 'worker-app-test.db');

(async () => {
  await rm(DB, { force: true });
  await rm(DB + '-wal', { force: true });
  await rm(DB + '-shm', { force: true });
  const s = await createWorkerServer({ port: 0, db: DB });
  const warm = await s.warmup();
  if (warm.status !== 200) {
    console.error('预热首页失败：HTTP ' + warm.status);
    process.exit(1);
  }
  console.log('Worker + D1 假实现已启动：http://127.0.0.1:' + s.port + '（' + warm.games + ' 款游戏）');
  process.env.BASE = 'http://127.0.0.1:' + s.port;
  // account-test.mjs 结尾会自己 process.exit，这里不用收尾清理
  await import('./account-test.mjs');
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
