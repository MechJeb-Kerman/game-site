# 部署到 Cloudflare Workers

把同一个静态站点从 Pages 换成 **Workers + Static Assets**：站点还是预渲染好的纯静态文件，但前面多挂了一个 Worker，于是能注入安全响应头、控制缓存、把 `/games` 这种干净地址映射到 `games.html`、统一 404。

## 先说清楚我做了什么、你需要做什么

这台机器的执行沙箱**没有外网出口**（装不了 npm 包，也就没有 `wrangler`），所以"登录 Cloudflare 并 deploy"这一步必须你来。我能做到并已经做完的：

| 文件 | 说明 |
| --- | --- |
| `worker/index.js` | Worker 本体：安全头 / 分级缓存 / 干净地址 / 404 / favicon / 405 |
| `wrangler.toml` | Workers 配置：`[assets]` 指向 `dist-cf/`，绑定名 `ASSETS` |
| `tools/worker-test.mjs` | **离线自测**：不用 wrangler、不用网络，22 项断言 + 53 条站内链接全量爬取 |
| `dist-cf/` | 要部署的静态产物（48 个文件 / 340 KB） |

运行自测：`node tools/worker-test.mjs` → 22 项断言全部通过。

## Page 版 vs Worker 版

| | Cloudflare Pages | Cloudflare Workers（本方案） |
| --- | --- | --- |
| 上传方式 | 控制台拖 zip / Git 集成 / wrangler | **只能** wrangler 或 Git 集成（没有拖拽上传） |
| 安全响应头 | `_headers` 文件 | Worker 代码里注入（Workers 不认 `_headers`） |
| 干净地址 `/games` | 平台自动把 `games.html` 映射过去 | `worker/index.js` 的 `candidates()` 处理（已实测） |
| 404 页面 | `404.html` 自动生效 | `not_found_handling = "404-page"` + Worker 兜底 |
| 免费额度 | 静态请求不限量、构建 500 次/月 | 免费版每天 10 万次请求（以 Cloudflare 当前公示额度为准） |
| 能不能加服务端逻辑 | 不能 | 能（下一步可以接 D1 做账号 / 评分 / 评论） |

两者产物是同一份 `dist-cf/`，部署了 Worker 就可以把 Pages 项目删掉，不用重复维护。

## 路线 A：wrangler 命令行（推荐）

```powershell
# 1. 装 Node 22+ 和 wrangler
npm i -g wrangler

# 2. 登录（会开浏览器授权）
wrangler login

# 3. 构建静态产物；origin 换成你的 Worker 域名，canonical / og / sitemap 才是对的
node tools/build-pages.mjs --cf --base=/ --origin=https://game-site.<你的账号>.workers.dev --out=dist-cf

# 4. 部署（读取 wrangler.toml，把 dist-cf 作为静态资源一起上传）
wrangler deploy
```

部署成功会输出 `https://game-site.<你的账号>.workers.dev`。（部署前想只校验配置可以跑 `wrangler deploy --dry-run`。）

## 路线 B：Git 集成（Workers Builds，push 自动部署）

1. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选仓库。
2. **Build command** 填 `node tools/build-pages.mjs --cf --base=/ --origin=https://game-site.<你的账号>.workers.dev --out=dist-cf`
3. **Deploy command** 保持默认的 `npx wrangler deploy`（它会读仓库里的 `wrangler.toml`）。
4. 环境变量加 `NODE_VERSION=22`（构建脚本用了 Node 内置的 `node:sqlite`，需要 Node ≥ 22.5）。

之后每次 push 都自动重建 + 重新部署。

> **踩坑：`assets.directory` 不存在（构建日志里没有 Build 步骤）**
> 如果日志是这样的：`Installing project dependencies: pnpm install --frozen-lockfile` → 直接跳到
> `Executing user deploy command: npx wrangler deploy`，然后报
> `✘ [ERROR] The directory specified by the "assets.directory" field in your configuration file does not exist: /opt/buildhome/repo/dist-cf`：
> 说明 **Build command 是空的**。`dist-cf/` 在 `.gitignore` 里、仓库中并不存在，只能靠构建命令现场生成。
> 把第 2 步那条命令填进项目的 **Settings → Build → Build command**，重新部署即可。
> `tools/build-pages.mjs` 内部自己会跑 `migrate()` + `seed()`，`data/` 目录和 `data/games.db` 都是自动创建的，
> 构建机上不需要预置数据库（`data/*.db` 本来就被 git 忽略）。

## 路线 C：CI / 脚本化部署

```bash
export CLOUDFLARE_API_TOKEN=...        # 权限：Workers Scripts: Edit
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler deploy
```

Token 在 Cloudflare 控制台 **My Profile → API Tokens** 建，选 "Edit Cloudflare Workers" 模板即可。

## 自定义域名

1. 控制台 → Workers & Pages → 选 `game-site` → **Settings → Domains & Routes → Add → Custom domain**（域名要在同一个 Cloudflare 账号下）。
2. **然后必须重新构建再部署**，否则页面里的 canonical / og:url / JSON-LD / sitemap 还写着 `*.workers.dev`：

```powershell
node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名 --out=dist-cf
wrangler deploy
```

## 本地预览

- **有 wrangler**：`wrangler dev` —— 跑真实的 workerd，最接近线上。本机已经装了 wrangler 4.151.0 实测过一轮（命令见文末）：`/`、`/index.html`、`/games`、`/games.html`、`/games/`、`/game/2048`、`/category/puzzle/`、`/static/*`、`/nope`、`/favicon.ico` 的行为都与线上预期一致。
- **没有 wrangler / 没有网络**：`node tools/worker-test.mjs` —— 用假的 `env.ASSETS` 直接调用 Worker 的 `fetch`，断言状态码、响应头、正文，并把 8 个页面的全部站内链接爬一遍。

## 关于 `wrangler.toml` 里的 `run_worker_first`

Cloudflare 的静态资源默认**不经过 Worker**（省 CPU）。要让每个请求都先进 Worker（这样安全头、缓存策略、干净地址才有机会生效），配置里写了：

```toml
[assets]
run_worker_first = true
```

如果你的 wrangler 版本还不支持这个字段，删掉它也能部署成功：站点照常能开，只是静态资源会绕过 Worker 直接返回，安全响应头不会注入（`dist-cf/_headers` 是给 Pages 用的，Workers 不读它）。报错信息里会提到 `run_worker_first`，认准这一行即可。

## 踩坑：打开就 ERR_TOO_MANY_REDIRECTS（重定向次数过多）

线上真实踩到的：`https://你的域名/` 与 `*.workers.dev/` 都刷不出来，浏览器报「重定向次数过多」。原因在 `wrangler.toml` 的 `html_handling` —— 它原来是 `auto-trailing-slash`。

| 配置 | `/` 的资源层行为 | Worker 拿到什么 | 结果 |
| --- | --- | --- | --- |
| `auto-trailing-slash`（错） | 把 `/index.html` **308** 回 `/` | 一个 308，被 `decorate()` 原样透传 | 浏览器回到 `/`，无限环 |
| `none`（对） | 精确返回 `/index.html` | 200 + 正文 | 正常 |

`auto-trailing-slash` 会把所有 `.html` 路径 308 跳回无后缀地址（`/index.html` → `/`、`/games.html` → `/games`），偏偏 `worker/index.js:60-68` 的 `candidates()` 就是显式去取 `xxx.html` 的路径，于是 `/` → 取 `/index.html` → 308 → `/` 打转。修法是让资源层只按精确路径发文件：

```toml
[assets]
html_handling = "none"      # 不能用 auto-trailing-slash / force-trailing-slash / drop-trailing-slash
not_found_handling = "404-page"
```

干净地址不受影响：`/games` → `/games.html` 这段映射本来就是 Worker 自己做的。改完必须重新部署（`wrangler deploy`，或在 Git 集成里 Retry deployment）才生效。

两层保险已经加进代码：

- `worker/index.js` 的候选循环把 3xx 也算「未命中」，宁可回 404 也不再透传跳转；
- `tools/worker-test.mjs` 开跑前先读 `wrangler*.toml`，`html_handling` 不是 `none` 直接失败退出；另有一条断言「静态路径不产生任何跳转」。

为什么之前 22 项断言全过还是漏了：`tools/worker-test.mjs` 里的假 `env.ASSETS` 只读磁盘、**不模拟 `html_handling` 语义**，等于一直按 `none` 在测。这个差异只有 `wrangler dev`（或线上）才暴露得出来。

## 部署完的自查清单

```bash
curl -sI https://你的域名/                     # 200，有 content-security-policy / x-content-type-options
curl -sI https://你的域名/static/css/style.css  # cache-control: public, max-age=604800
curl -sI https://你的域名/games                 # 200（干净地址，不用写 .html）
curl -sI https://你的域名/nope                  # 404 + x-robots-tag: noindex
curl -sI https://你的域名/favicon.ico           # 302 -> /favicon.svg
```

再打开首页确认「已累计 0 次游玩」、12 张卡片，进任意详情页确认游戏能玩（静态版没有登录 / 评分 / 评论 / 收藏 / 后台，页面里只读）。

## 这个 Worker 不能做什么

它只负责"把静态站好好发出去"。**账号、评分、评论、收藏、投稿、站长后台、游玩次数统计都不在里面**——那些需要数据库和会话。要在 Workers 上补齐，路线是：

1. **D1**（Workers 自带的 SQLite）建 `users / sessions / games / ratings / comments / favorites / play_logs` 表——现有 `src/db.js` 的建表 SQL 可以直接改成 D1 的 migration。
2. **会话**：现在的实现是服务端 `sessions` 表 + HttpOnly cookie，搬到 Worker 后完全可行（`crypto.randomUUID()` 生成 sid）。密码哈希从 `node:crypto` 的 scrypt 换成 WebCrypto 的 PBKDF2（Workers 里没有 node:crypto 的 scrypt）。
3. **页面**：`src/views.js` 是纯字符串模板、没有用到 Node API，理论上可以直接被 Worker 复用；`src/data.js` 那层把同步的 `node:sqlite` 调用改成 `await env.DB.prepare(...).all()`。
4. **静态与动态混合**：列表 / 详情页改成在 Worker 里实时渲染（`run_worker_first` 按路径放行），游戏本体仍走静态资源。

这套改造的核心工作是把数据层从同步 SQLite 换成异步 D1、把 `express` 的路由换成 Worker 里的 `URL` 分发。

> **这些都已经做好了。** 想要带服务端的完整版，直接看 [`DEPLOY-CLOUDFLARE-D1.md`](DEPLOY-CLOUDFLARE-D1.md)：账号 / 邮箱验证 / 找回密码 / 第三方登录 / 评分 / 评论与楼中楼 / 举报 / 收藏 / 投稿（含上传单文件 HTML） / 后台 / 排行榜 / 拼音搜索全部在 Workers + D1 上，本机验收 **58 项账号 + 70 项功能断言**、**23 项产物冒烟**与 **17 项浏览器冒烟**全部通过。

## 我这边验证过的

```
node tools/worker-test.mjs
  → worker 冒烟：23 项断言全部通过（含安全头与 server.js:24-45 逐字段比对）
  → 站内链接全部可访问（54 条，新增了 /rank）
```

```
    node tools/worker-test.mjs               → 23 项断言全部通过（含「静态路径不产生任何跳转」）
    node tools/worker-app-test.mjs           → 58 项账号断言全部通过
    node tools/worker-feature-test.mjs       → 88 项第二批功能断言全部通过（同一份用例换 D1 数据层，含投稿上传单文件 HTML）
    BASE=http://127.0.0.1:4400 node tools/browser-smoke.mjs → 17 项浏览器冒烟全部通过
    wrangler dev（真 workerd，端口 8788）     → 逐路径实测：无跳转，安全头 / 缓存头 / 404 / favicon 302 全部正确
    wrangler dev -c wrangler.d1.toml（8790）  → D1 版逐页面 200，/favorites 与 /admin 正确 302 到登录
    BASE=http://127.0.0.1:8790 node tools/account-test.mjs → 58 项断言全部通过（这次跑在真 workerd + 真 D1 语义上）
```

没验证的：`wrangler login` / `wrangler deploy` 本身（要用你的 Cloudflare 账号），以及线上真实的缓存命中与免费额度数字。

## 本机怎么跑 wrangler（我用的命令）

本机没有全局 node / npm，所以把 wrangler 装在一个仓库外的探针目录里（不污染仓库、不改 `pnpm-lock.yaml`）：

```powershell
# $node、$pnpm 见 README「环境要求」里的 DSH 运行时路径
& $node $pnpm add --save-dev wrangler@4 --dir D:\CODE\_wprobe --registry=https://registry.npmmirror.com

# 静态版（在 D:\CODE\game-site 下执行）
& $node D:\CODE\_wprobe\node_modules\wrangler\bin\wrangler.js dev --port 8788 --ip 127.0.0.1

# 完整版 Workers + D1（本地 D1 会自动建表、灌种子；库在 .wrangler/state 下）
& $node D:\CODE\_wprobe\node_modules\wrangler\bin\wrangler.js dev -c wrangler.d1.toml --port 8790 --ip 127.0.0.1
```

`wrangler dev` 只在本机跑 workerd，不联网、不需要登录，是目前最接近线上的一层验证。

