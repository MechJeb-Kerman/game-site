# 部署到 Cloudflare（Pages）

## 先说清楚我做了什么、你需要做什么

这台机器的执行沙箱**没有外网出口**（`registry.npmjs.org`、`api.cloudflare.com`、连 `example.com` 都是 fetch failed；PowerShell 的 `Invoke-WebRequest` 直接超时），也没有 `wrangler` / `cloudflared` / `git` / `npm`。所以"点一下部署到 Cloudflare"这一步必须由你在浏览器里完成。

我能做并且已经做好的：把 Cloudflare Pages **直接可上传的产物**构建好、加好 Cloudflare 专用配置、本地跑过完整冒烟测试：

| 产物 | 说明 |
| --- | --- |
| `dist-cf/` | Cloudflare 用构建产物，50 个文件 / 363.3 KB，`--base=/`（域名根） |
| `cloudflare-pages.zip` | 同一份内容的 zip，111 KB / 50 个条目，控制台可以直接拖 |
| `dist-cf/_headers` | Cloudflare Pages 专属：安全响应头 + 静态资源缓存策略 |

## 为什么 Cloudflare 版和 GitHub 版是两个目录

| 部署位置 | 站点地址 | `--base` |
| --- | --- | --- |
| GitHub Pages 项目站 | `https://用户名.github.io/仓库名/` | `/game-site/` |
| Cloudflare Pages | `https://项目名.pages.dev/` 或自定义域名根 | `/` |

同一份源码渲染两次：`dist/`（GitHub）和 `dist-cf/`（Cloudflare）。两个目录都通过了同样的 9 项冒烟测试。

## 路线 A：控制台直接上传（最快，本机什么都不用装）

1. 打开 <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 项目名填 `game-site`（如果被占用就换一个，换完要重新构建并改 `--origin`）。
3. 把 `cloudflare-pages.zip` 拖进去（或者直接把 `dist-cf` 文件夹拖进去）。
4. **Deploy**，几十秒后拿到 `https://game-site.pages.dev`。
5. 以后更新：改了内容先重新构建 —— `node tools/build-pages.mjs --cf --base=/ --origin=https://game-site.pages.dev`（`--cf` 时 `--out` 默认就是 `dist-cf`，不用再写），再 `pnpm zip:cf` 重打包（`node tools/zip-dist.mjs --dir=dist-cf`）；然后在同一个项目里点 **Create new deployment** 传新 zip，也可以直接 `dist-cf` 整个文件夹拖。

这条路不需要 Git、不需要 Node、不需要命令行。

## 路线 B：Git 集成（长期用最省事，push 自动部署）

1. 把项目推到 GitHub / GitLab（本机没装 git，可以用 GitHub Desktop 或网页上传）。
2. Pages → **Connect to Git** → 选仓库。
3. 两种配法，选一种：
   - **配法 1（直接把产物提交进仓库）**：Build command 留空，Build output directory 填 `dist-cf`。要把 `dist-cf/` 一起提交进仓库。
   - **配法 2（让 Cloudflare 自己构建，推荐）**：Build command 填 `node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名`，Build output directory 填 `dist-cf`，环境变量加 `NODE_VERSION=22`（项目要求 Node >= 22.5，用的是内置 `node:sqlite`）。这样每次改 `src/seed.js` / `src/views.js` / CSS 后 push 就自动重新预渲染。
4. Save and Deploy。之后每次 push 都会重新构建。

## 路线 C：wrangler 命令行（需要你在自己装了 Node 的机器上跑）

```bash
npm i -g wrangler
wrangler login                                   # 浏览器授权一次
wrangler pages project create game-site --production-branch=main
wrangler pages deploy dist-cf --project-name=game-site
```

CI 场景可以直接用 API Token（`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）跑最后一条，不弹浏览器。

## 自定义域名

1. Pages → 项目 → **Custom domains** → 填域名（域名已托管在 Cloudflare 时会自动加 CNAME；没有的话按提示把 CNAME 指到 `项目名.pages.dev`）。
2. **然后必须重新构建**：`node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名 --out=dist-cf`，再上传一次。否则页面里的 canonical / og:url / JSON-LD / sitemap 还写着 `game-site.pages.dev`，等于把权重送给自己另一个域名。
3. HTTPS 证书由 Cloudflare 自动签发，不用管。

## `_headers` 里装了什么

- **全站安全头**：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: SAMEORIGIN`、`Permissions-Policy` 关掉定位/麦克风/摄像头，以及一条 CSP（default-src self、frame-src self + http(s)（投稿允许嵌外站游戏）、frame-ancestors self，允许 inline/eval 因为游戏本体是自包含的）。与本项目 Express 版 `server.js:24-45` 那套保持一致。
- **静态资源缓存**：`/static/*` 7 天、`/cover/*` 1 天、`/games/*` 1 小时。
- **改了 CSS / JS 怎么办**：缓存是 7 天，靠 `?v=3` 这个版本号切换。改样式之后把 `src/views.js` 里两处 `?v=3`（`style.css` 和 `app.js`）一起改成 `?v=4` 再重新构建，用户和边缘节点才会拿新文件。
- `_headers` 是 Cloudflare Pages / Netlify 这类平台的约定文件，GitHub Pages 用不上（所以只在本目录生成，`dist/` 里没有）。

## 404 与 SEO

- `404.html` 会被 Pages 自动用作 404 页面，跟 GitHub Pages 一样，不用配。
- **`robots.txt` 和 `sitemap.xml` 在 Cloudflare 上是真正生效的**（Pages 部署在域名根，不像 GitHub 的项目站那样被忽略）。提交收录时用 `https://你的域名/sitemap.xml`。
- 想被搜索引擎收录，请务必先用真实域名重建一次，让 canonical 和 sitemap 里的地址是对的。

## 可选：让 `/game/2048` 这种"不带 .html"的地址也能打开

站内链接用的是真实文件名（`/game/2048.html`、`/games.html`），Cloudflare Pages 直接就能服务，**默认不需要任何额外配置**。
如果你还希望 Express 版那种 `/game/2048`、`/category/puzzle` 也能访问，就在 `dist-cf/` 里放一个 `_redirects`：

```
/games /games.html 200
/search /search.html 200
/game/2048 /game/2048.html 200
/game/snake /game/snake.html 200
/category/puzzle /category/puzzle.html 200
/tag/益智 /tag/益智.html 200
```

`200` 表示内部重写（浏览器地址不变）。注意**别用 `/game/*` 通配**，它会把已经带 `.html` 的地址也匹配进去。
⚠️ 这一段我无法在本机验证 Cloudflare 的真实行为（沙箱没有外网，只能验证文件本身没问题），要启用建议先拿一个路径试一下，确认没问题再补齐全部。

## 如果要用「有服务端」的 Express 版（不是静态版）

静态版没有登录 / 评分 / 评论 / 收藏 / 投稿（含上传单文件 HTML）/ 后台（页面里已经隐藏或只读）。要把完整功能挂到公网，三条路：

1. **Cloudflare Tunnel**（最快，不需要公网 IP、不用开路由器端口）：
   ```powershell
   winget install --id Cloudflare.cloudflared
   cloudflared tunnel login
   cloudflared tunnel create game-site
   cloudflared tunnel route dns game-site game.你的域名
   cloudflared tunnel run --url http://127.0.0.1:3000 game-site
   ```
   效果：`https://game.你的域名` 就是本机 3000 端口那个 Express 站，账号 / 评分 / 评论 / 后台全都能用。代价是**你的电脑要一直开着**（或者把服务放到一台常开的机器上）。
2. **Workers + D1 重写**：把 Express 改写成 Hono on Workers、SQLite 换 D1。工作量不小（路由、会话、SQL 都要动），现在这套代码不能直接搬上去。
3. **VPS + Cloudflare 橙云**：静态版放 Pages 免费托管，需要服务端的部分放自己的 VPS，前面挂 Cloudflare 代理（本项目 README 的「部署（Cloudflare 路线）」章节就是这条路）。

## 部署完的自查清单

- 打开首页：Hero 显示「已累计 0 次游玩 · 共 6 款游戏」，下面是 12 张卡片（6 款 × 热门/最新）。
- 打开任意详情页：游戏能玩，能全屏、能重开，评分区显示「静态演示版没有服务端，评分与评论已关闭」。
- 随便输一个不存在的地址（`/nope`）：出现 404 页面。
- 手机浏览器打开：导航换行、无横向滚动条。
- 验证 `_headers` 生效：`curl -sI https://你的域名/static/css/style.css` 应看到 `cache-control: public, max-age=604800` 和 `x-content-type-options: nosniff`。

## 我这边已经验证过的

```
node tools/build-pages.mjs --cf --base=/ --origin=https://game-site.pages.dev --out=dist-cf
  → 游戏 6 款 / 分类 4 个 / 标签 13 个 / 排行榜 7 个；56 个文件，427.6 KB

node tools/pages-smoke.mjs --base=/ --out=dist-cf
  → pages-home / pages-list / pages-search / pages-tag / pages-detail /
    pages-play / pages-game-tetris / pages-404 / pages-mobile /
    pages-rank / pages-rank-week / pages-search-pinyin / pages-suggest  13 项全部通过
    （无 console 报错、无资源 404；含在详情页 iframe 里真按键把 2048 打到 20 分）
```

冒烟测试用本地静态服务器 + 无头 Chrome，模拟的就是"域名根 + 纯静态文件"这种部署形态，和 Cloudflare Pages 的行为一致（唯一没法本地模拟的是 Cloudflare 自己的 `_headers` 与 `_redirects` 处理）。

