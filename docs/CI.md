# CI 说明（`.github/workflows/ci.yml`）

## 它会做什么

一次 run 只有三步真正干活：

| 步骤 | 命令 | 抓什么 |
|---|---|---|
| 语法检查 | `node --check <server.js + src/**/*.js + tools/*.mjs>` | 手滑写坏的文件，5 秒内就能定位 |
| 单元测试 | `tools/{hot,rules,adapters,cards,ratelimit}-test.mjs`、`tools/check-forum-host.mjs` | 纯函数逻辑：热度打分、SEO 文本、棋类规则、搜索/缓存适配器、限流、论坛主机判定 |
| 启动冒烟 | `npm run reset` → `node server.js` → 逐个 `curl` | 真建库、真起服务，确认首页/热度榜/论坛/每日挑战/PWA/游戏页/静态资源都能出 200，且 `/api/hot` 的字段齐全 |

冒烟阶段用 `PORT=3000` 起服务，30 秒内轮询到首页可用就继续；失败会把 `server.log` 的尾部打出来。

## 为什么是这些用例

- **只挑零依赖、零外网的脚本**：`hot/rules/adapters/cards/ratelimit/check-forum` 全都不开浏览器、不连数据库以外的外部服务，CI 里不会因为网络抖动假红。
- **不跑 `npm run smoke`（浏览器冒烟）**：它需要本机装好 Chrome 并用 CDP 连上去（见 `tools/browser-smoke.mjs`），runner 上没有，硬跑只会失败。这块留到下面「待办」。
- **`node:sqlite` 与 Node 版本**：仓库 `engines.node >= 22.5`，但 22.x 用 `node:sqlite` 还得加 `--experimental-sqlite`。CI 直接钉 **Node 24**（无需 flag）。本机开发用 Node 26 也不受影响。
- **依赖只有 express**：仓库没有 `package-lock.json`（历史用 pnpm），所以 CI 用 `npm install` 现解析；要锁死版本就得提交一份 lock 文件，见待办。

## 本地怎么复现

不用装 npm，手敲等价命令即可（本机 node 在 `D:\CODE\nodejs\node.exe`）：

```bash
node --check server.js
node tools/hot-test.mjs
node tools/rules-test.mjs
node tools/adapters-test.mjs
node tools/cards-test.mjs
node tools/ratelimit-test.mjs
node tools/check-forum-host.mjs

node src/seed.js --force          # 等价 npm run reset
PORT=3000 node server.js &        # 起来后另开一个终端 curl
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/hot
curl -s http://127.0.0.1:3000/api/hot | head -c 200
```

Windows PowerShell 里把 `PORT=3000 node server.js` 换成 `$env:PORT=3000; node server.js`。

## 已知缺口

- **浏览器端 E2E 没有进 CI**：棋盘拖动、离线队列、对局回放这些只有 `tools/browser-smoke.mjs` / `tools/pwa-test.mjs` 能测，需要 Chrome + CDP。
- **`worker/`（Cloudflare Workers 版）不在这条流水线里**：它的测试（`test:worker*`）依赖 `wrangler`，单开一条 job 更合理。
- **没有 lock 文件**：`npm install` 每次解析出的 express 小版本可能不同；发布前建议 `npm install` 后提交 `package-lock.json`，CI 改 `npm ci`。
- **`data/games.db` 每次 CI 都是新建的**（`.gitignore` 里已排除），所以榜单/热度在 CI 里恒为空表——断言只校验结构与状态码，不校验具体排名。
