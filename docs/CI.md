# CI 说明（`.github/workflows/ci.yml`）

## 它会做什么

一次 run 分两个 job：`build` 跑下面六步，`browser-e2e` 跑真浏览器验收。

| 步骤 | 命令 | 抓什么 |
|---|---|---|
| 语法检查 | `node --check` 扫 `server.js`、`src/**`、`worker/*.js`、`public/js/*.js`、`tools/*.mjs` | 手滑写坏的文件，5 秒内定位 |
| 轻量 lint | `node tools/lint.mjs` | 相对 `import` 指向不存在的文件、同一模块重复导出、BOM / CRLF / 缺结尾换行、残留 `debugger`。**不做风格争论**：行尾空白、Tab、超长行只统计不判失败，所以不会因为排版习惯变红 |
| 构建静态站 | `node tools/build-pages.mjs --cf --base=/ --out=dist-cf` | 生成 `dist-cf/`，同时让下一步的静态站冒烟有东西可爬 |
| 单元 + 整合测试 | `node tools/test-all.mjs` | 45 组脚本：纯函数单测、两线（Node/Worker）功能对等、以及自带临时站点的账号/功能/对局接口整合 |
| 启动冒烟 | `npm run reset` → `node server.js` → 逐个 `curl` | 真建库、真起服务：首页/热度榜/论坛/每日挑战/PWA/游戏页/静态资源，外加 `/api/hot` 字段齐全 |
| 传输层断言 | `curl -D -` 比响应头 | 没压缩、缓存分级被改坏、登录页被公共缓存，都会直接红 |

`browser-e2e` 是独立 job：runner 自带 Chrome，所以不需要 `npx playwright install`，仓库仍然只有 express 一个依赖。
它起一个真服务，然后跑棋盘对战、手柄、离线上传队列、PWA 离线接管四套 CDP 验收脚本——这四套以前只能在开发机上手动跑。

冒烟阶段用 `PORT=3000` 起服务，30 秒内轮询到首页可用就继续；失败会把 `server.log` 尾部打出来。

## `tools/test-all.mjs` 里有哪些

`node tools/test-all.mjs --list` 可看全表；`--only=hot,seo` 只跑几组。分成三类：

- **纯函数单测**（大多数）：不开浏览器、不连外网，几十毫秒到几秒。
- **两线对等**：`worker-app / worker-feature / worker-play / worker-mail-oauth / worker-search / worker-static`——同一个功能在 Express 与 Workers 两边都要过。
- **整合测试**：`account / features / play-api` 需要站点在跑。`test-all` 会自己在随机端口（3300–3499）起一个临时服务，跑完杀掉，不碰你可能开着的 3000。

刻意不跑的三类：**需要真浏览器的**（`browser-smoke`、`pages-smoke`、`pwa-test`、`board-games-test`、`gamepad-test`）、**生成器**（`gen-*`、`meili-index`）、**本地服务器/打包**（`serve-dist`、`serve-worker`、`d1-local`、`zip-dist`）。

## 为什么是这些用例

- **零依赖、零外网优先**：绝大多数脚本只用 `node:sqlite` + 内置模块，CI 不会因为网络抖动假红。
- **静态站冒烟要基于刚构建的 `dist-cf/`**：`tools/worker-test.mjs` 是把 `dist-cf` 当 `env.ASSETS` 爬站内链接的，不先构建就会把「没有 `hot.html`」误判成 Worker 缺路由——这个坑真实踩过一次。
- **`node:sqlite` 与 Node 版本**：仓库 `engines.node >= 22.5`，但 22.x 用 `node:sqlite` 还得加 `--experimental-sqlite`；CI 直接钉 **Node 24**。本机开发用 Node 26 也不受影响。
- **依赖只有 express**：历史用 pnpm、仓库里没有 `package-lock.json`，所以 CI 用 `npm install` 现解析——要锁死版本就提交一份 lock 文件，见待办。

## 本地怎么复现

本机 node 在 `D:\CODE\nodejs\node.exe`，没有 npm 也能跑：

```bash
node tools/test-all.mjs                 # 44 组全跑（约 2 分钟，含临时站点）
node tools/test-all.mjs --only=hot,seo  # 只跑单测
node tools/seo-test.mjs                 # sitemap / robots / JSON-LD
node tools/hot-test.mjs                 # 热度打分

node src/seed.js --force          # 等价 npm run reset
PORT=3000 node server.js &        # 另开终端
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/hot
curl -sD - -o /dev/null -H 'Accept-Encoding: gzip' http://127.0.0.1:3000/ | grep -i content-encoding
curl -sD - -o /dev/null 'http://127.0.0.1:3000/static/css/style.css?v=10' | grep -i cache-control
```

Windows PowerShell 里把 `PORT=3000 node server.js` 换成 `$env:PORT=3000; node server.js`。
Git Bash 下构建静态站要加 `MSYS2_ARG_CONV_EXCL='*'`，否则 `--base=/` 会被 MSYS 改写成 Windows 路径。

## 已知缺口

- **浏览器端 E2E 没有进 CI**：棋盘拖动、离线队列、对局回放、PWA 安装这些只有 `tools/browser-smoke.mjs` / `tools/pwa-test.mjs` / `tools/board-games-test.mjs` 能测，需要 Chrome + CDP（runner 上装浏览器 + 起 `--remote-debugging-port` 才能进 CI）。
- **`worker/` 的部署没有 CI**：功能对等有测，但 `wrangler deploy` 与 D1 迁移不在流水线里。
- **没有 lock 文件**：`npm install` 每次解析出的 express 小版本可能不同；发布前建议 `npm install` 后提交 `package-lock.json`，CI 改 `npm ci`。
- **`data/games.db` 每次 CI 都是新建的**（`.gitignore` 已排除），榜单/热度在 CI 里恒为空表——断言只校验结构与状态码，不校验具体排名。
