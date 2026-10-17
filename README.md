# 趣玩小游戏 · 类 4399 小游戏站原型

一个**开箱即跑**的在线小游戏聚合站最小原型：纯 HTML + Express 服务端渲染 + `node:sqlite` 存元数据。
零前端框架、零构建步骤、零图片文件（封面是运行时生成的 SVG），`pnpm install` 后一条命令即可访问。
自带完整的账号体系（注册登录、邮箱验证、找回密码、第三方登录、收藏、评论与楼中楼、举报）与站长后台（投稿审核、批量上下架、举报处理、封禁、彻底删除、操作日志与集成自检），外加 SQLite 排行榜与拼音搜索、站内公告与更新说明（`/notice`、`/changelog`）、隐私政策与用户协议（`/privacy`、`/terms`）；投稿可以直接上传**自包含的单文件 HTML**（存库、按 `/ugc/<slug>.html` 托管、用 CSP sandbox 隔离），全部落在本地 SQLite，不依赖任何外部服务；另外带一个**有审核与安全措施的论坛**（`/forum`，也可以单独挂到 `forum.fishport.cn`，与游戏站共用同一套账号与后台）。

![首页](docs/screens/home.png)

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 首页 | Hero（今日最热）、游戏分类、热门推荐、最新上架 |
| 游戏库 | 分类页 `/category/:slug`、标签页 `/tag/:tag`、全部游戏 `/games`，支持 `sort=hot\|new\|rating\|title` |
| 搜索 | `/search?q=` 与 `/games?q=`，按标题/副标题/描述/标签模糊匹配（已转义 LIKE 通配符），并支持**拼音全拼与首字母**（`xiao you xi`、`xyx` 都能搜到「小游戏」），同分时标题命中的排前面；输入框有实时联想 `/api/search/suggest` |
| 排行榜 | `/rank` 今日 / 本周 / 本月 / 总榜 + 评分榜 / 收藏榜 / 新游榜，数据源是本地 SQLite 的 `play_logs`（**没有引入 Redis**），首页与详情页都有入口 |
| 详情页 | 玩家信息 + 相关推荐 + 操作提示 + 游玩次数 + 5 星评分 + 收藏 + 玩家评论 |
| 播放器 | iframe `sandbox` 隔离 + 全屏 + 真·重开 + 新窗口打开 |
| 手柄 | 6 款游戏全部支持游戏手柄（十字键 / 摇杆 / A / B / Start），零依赖共享 shim，见「手柄支持」 |
| 6 款自研游戏 | 2048、贪吃蛇、记忆翻牌、打地鼠、井字棋（minimax AI）、俄罗斯方块 |
| 账号 | 注册 / 登录 / 退出；`scrypt` 加盐哈希存口令，`HttpOnly` 会话 cookie，30 天有效 |
| 账号增强 | 邮箱验证（`/verify-email`，24 小时有效）、找回密码（`/forgot` → `/reset`，token 30 分钟一次性）、改密码 / 改昵称 / 解绑第三方账号都在 `/account`；**邮件可走 Resend 或自建 HTTP 发信接口**（`MAIL_API_URL` + `MAIL_API_KEY`），没配就落「开发发件箱」，后台的「集成自检」面板会把当前邮件与登录配置摊开给你看 |
| 第三方登录 | GitHub / Google / 演示登录（`/auth/:provider`），OAuth 2.0 授权码模式，原生 `fetch` 实现、零依赖；同一个第三方账号只绑一个站内用户，已绑过就直接登录；授权 / 令牌 / 用户资料端点都可用 `OAUTH_<PROVIDER>_*_URL` 覆盖（接自建网关或测试环境时用） |
| 法律页面 | `/privacy` 隐私政策、`/terms` 用户协议，纯静态文本、登录与否都能看，页脚每页都有链接、`/sitemap.xml` 收录；注册页必须勾选「我已阅读并同意《用户协议》与《隐私政策》」才能提交（表单里是必填 checkbox，服务端还会兜一次，不勾就 400 回表单），勾选框旁边就是两份文档的链接 |
| 公告 | `/notice` 列表 + `/notice/:slug` 详情，站长在后台随时发布 / 修改 / **软撤回**（前台立刻消失、评论保留，重新发布即恢复）；公告自己也能被评论与举报（与游戏评论同一套分页 / 楼中楼 / 举报），首页顶部再挂一条最新公告的可关闭横幅（关掉写 `localStorage`，不再打扰） |
| 更新说明 | `/changelog`，**不手写**：`pnpm gen:changelog` 读 `git log` 生成 `src/changelog-data.js`（feat / fix / docs… 映射成中文标签），页脚有入口、`/sitemap.xml` 收录 |
| 论坛 | `/forum`：默认 4 个板块、主题列表与搜索、两级楼中楼回复、编辑留痕；发帖要登录 + **邮箱已验证** + 未被封禁 / 禁言；新人（发帖不足 3 条）的主题与回复自动进待审队列，站长在 `/forum/admin` 通过 / 拒绝 / 置顶 / 锁定 |
| 论坛的审核与安全 | 9 项措施：举报 + 后台审核队列 + 违规内容软下架、关键词 / 正则黑名单（命中「直接拒绝」或「转人工待审」）、发帖限流与每日配额（主题 60 秒 1 条 / 每天 10 条，回复 20 秒 / 每天 50 条，举报每小时 5 条）、禁言（到点自动解除）与封禁、操作日志（`audit_logs`）、新人限制、邮箱验证门槛、不依赖外部服务的人机校验（一次性表单令牌 + 蜜罐字段 + 最短填写耗时）、编辑留痕（`forum_post_edits` 存改前改后，普通用户一改就重新待审） |
| 论坛域名 | 同一套路由既能走 `/forum`，也能把 `forum.fishport.cn` 指到同一个 Worker：论坛主机上的请求在内部重写成 `/forum/*`、页面里的链接基址自动切换，账号 / 后台 / 审计日志完全共用（跨子域登录态靠 `COOKIE_DOMAIN=.fishport.cn`） |
| 收藏 | 详情页一键「♡ 收藏」，`/favorites` 我的收藏夹 |
| 评论 | 详情页发评论（≤500 字，同一用户同一游戏 10 秒限流），**分页**（每页 10 条顶层评论，回复默认折叠成「查看全部 N 条回复」）、**楼中楼两级回复**（回复别人时自动挂到同一顶层并 @昵称）、**举报**（spam / abuse / spoiler / other，同一人同一评论只算一次），站长可隐藏 / 恢复 / 处理举报 |
| 投稿与后台 | `/submit` 登录后投稿进待审队列；`/admin` 站长审核上架、上下架游戏、管理评论，另有**批量上下架**、**投稿预览**（`/admin/preview/:slug`，按详情页的形状看内容）、**处理举报**、**封禁/解封用户**（可带理由）、**手动标记邮箱已验证**、**操作日志**（`audit_logs`，谁什么时候对什么做了什么）与开发发件箱；**投稿上传单文件 HTML**（≤ 512 KB，存库、按 `/ugc/<slug>.html` 托管）；**彻底删除**（上架中的会先拒绝，确认页把要删掉的评论 / 举报 / 评分 / 收藏 / 游玩记录 / 上传文件逐项列出来） |
| 评分 | 登录后 5 星打分，一人一票、随时改票；均值实时回写数据库（未登录只能看，点星会引导去登录） |
| SEO | 每页独立 title/description/canonical/OG、JSON-LD（WebSite / CollectionPage / VideoGame，有人评分时才带 AggregateRating）、`/sitemap.xml`、`/robots.txt`；登录/注册/收藏/投稿/后台一律 `noindex` |
| 统计 | `POST /api/games/:slug/play`，同一 IP + 同一游戏 30 秒内去重 |
| 封面 | `/cover/:slug.svg` 按游戏的配色 + emoji 动态生成，无需任何图片素材 |

## 环境要求

- **Node.js >= 22.5**（用到内置 `node:sqlite`，需要 `--experimental-sqlite` 以下的新版本能力）
- pnpm 或 npm 任选其一

> 本机如果 `node` 不在 PATH 里，可以直接用 DSH 捆绑运行时：
>
> ```powershell
> $NODE = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
> $PNPM = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
> & $NODE $PNPM install --registry=https://registry.npmmirror.com
> & $NODE server.js
> ```

## 快速开始

```bash
pnpm install --registry=https://registry.npmmirror.com   # 国内网络走镜像源
pnpm start                                               # 或 pnpm dev（--watch 热重启）
```

打开 <http://localhost:3000>。首次启动会自动建表、灌入 4 个分类 + 6 款游戏，并创建默认站长账号。

> **默认管理员**：`admin` / `admin123`（用户名显示为「站长」）。
> 上线前务必用环境变量改掉：`ADMIN_USER=you ADMIN_PASS=一串强口令 pnpm start`。
> 只要还是默认口令，服务启动时就会打印一行 ⚠️ 警告。

> 种子数据**不灌任何假数字**：所有游戏的游玩次数与评分都是 0，
> 没有票的时候页面显示「☆ 未评 / 还没有人评分」，而不是伪造一个 4.8 分。

想换端口：`PORT=8080 pnpm start`（PowerShell：`$env:PORT=8080; pnpm start`）。

想重置游戏数据：`pnpm reset`（等价于 `node src/seed.js --force`，清空 games / play_logs / ratings 后重灌种子，**不动账号**）。

想彻底回到出厂状态：停掉服务 → 删除 `data/games.db`（连同 `-wal` / `-shm`）→ 重新启动（账号、收藏、评论、投稿一起清空）。

想固定站点域名（影响 canonical / OG / sitemap）：`SITE_ORIGIN=https://example.com pnpm start`。

想真的发信（验证邮箱 / 找回密码）：`RESEND_API_KEY=...` 走 Resend，或用 `MAIL_API_URL` + `MAIL_API_KEY` 指向任何一个接受 `{from,to,subject,text,html}` 的 HTTP 接口，发件人用 `MAIL_FROM` 覆盖；都不配就落「开发发件箱」（控制台打印、后台可见），功能照常能测。

论坛与主站共用登录态（比如把 `forum.fishport.cn` 指到同一个 Worker）：设 `COOKIE_DOMAIN=.fishport.cn`，cookie 会带上这个 Domain，两个子域登录状态一致；**本机开发不要设**（127.0.0.1 带 Domain 的 cookie 浏览器会丢弃，登录会永远失败）。

第三方登录：配 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 就会在登录页出现对应按钮（回调地址固定是 `<站点>/auth/<provider>/callback`）；`OAUTH_DEV=1` 可以在生产环境里开「演示登录」。

## 目录结构

```
game-site/
├── server.js            Express 入口：安全头、静态目录、页面路由、API、登录守卫
├── package.json         type: module，scripts: start / dev / reset / smoke / test:account / test:gamepad / test:features / build:pages / zip:cf / serve:dist / smoke:pages / test:worker / serve:worker / test:worker-app / test:worker-features / test:mail / test:worker-mail / gen:changelog
├── data/games.db        SQLite 数据库（首次启动自动生成）
├── src/
│   ├── db.js            数据库连接、PRAGMA、建表与索引
│   ├── auth.js          账号：scrypt 口令哈希、会话 cookie、注册校验、默认站长
│   ├── seed.js          分类与游戏的种子数据（node src/seed.js --force 可重置）
│   ├── data.js          所有查询：列表/详情/搜索/评分/收藏/评论/投稿/公告/后台统计
│   ├── views.js         服务端字符串模板：首页/列表/详情/登录注册/收藏/投稿/公告/更新说明/后台/排行榜/账号
│   ├── mail.js          发信：Resend 或自定义 HTTP 接口，没配就落「开发发件箱」（outbox）
│   ├── oauth.js         第三方登录：GitHub / Google / 演示登录，授权码 + state 校验
│   ├── pinyin.js        拼音搜索：标题转全拼 + 首字母，匹配与相关度
│   ├── pinyin-data.js   拼音表（由 tools/gen-pinyin.mjs 生成，勿手改）
│   ├── changelog-data.js 更新说明数据（由 tools/gen-changelog.mjs 读 git log 生成，勿手改）
│   ├── data-forum.js    论坛查询：板块 / 主题 / 楼层 / 举报 / 黑名单 / 待审队列 / 禁言 / 一次性令牌
│   ├── forum-guard.js   两线共用的论坛规则：长度与空白清洗、黑名单匹配、新人待审判定、限流参数
│   └── cover.js         动态生成封面 SVG 与 OG 图 SVG
├── public/
│   ├── css/style.css    全站样式（暗色玻璃拟态，响应式，含播放器与后台表格样式）
│   ├── js/app.js        搜索回填与联想、游玩上报、评分、收藏、评论（分页 / 楼中楼 / 举报）、全屏 / 重开（Express 版）
│   ├── js/app-static.js 静态版前端：列表排序、前端搜索（拼音 / 首字母 / 相关度）、播放器全屏 / 重开
│   └── js/gamepad.js    手柄 shim：keys 模式合成键盘事件、pointer 模式虚拟光标，6 款游戏共用
├── tools/
│   ├── browser-smoke.mjs  无头 Chrome 真实交互冒烟测试（零依赖，pnpm smoke）
│   ├── account-test.mjs   账号系统 58 项断言测试（pnpm test:account，可反复跑）
│   ├── feature-test.mjs   功能 216 项断言：评论分页 / 楼中楼 / 举报、排行榜、拼音搜索、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除、公告与更新说明、隐私政策与用户协议与注册勾选同意、论坛（游客门槛 / 邮箱验证 / 黑名单 / 蜜罐 / 一次性令牌 / 限流 / 待审 / 编辑留痕 / 举报 / 后台审核与禁言 / 审计日志）（pnpm test:features）
│   ├── mail-oauth-test.mjs 邮件与第三方登录端到端 42 项：自起假邮件服务端 + 假 OAuth Provider（pnpm test:mail）
│   ├── worker-mail-oauth-test.mjs 同一套场景换成 D1 数据层（pnpm test:worker-mail）
│   ├── build-pages.mjs    静态导出：GitHub Pages / Cloudflare Pages + 构建自检（pnpm build:pages）
│   ├── zip-dist.mjs       把产物目录打成 zip：条目名用 /、中文名带 UTF-8 标志（pnpm zip:cf）
│   ├── serve-dist.mjs     本地预览 dist（模拟子路径部署，pnpm serve:dist）
│   ├── pages-smoke.mjs    静态版无头 Chrome 冒烟 + 截图 + 前端引用断言（pnpm smoke:pages）
│   ├── worker-test.mjs    Cloudflare Worker 离线自测：静态版 24 项 + html_handling 配置守卫（pnpm test:worker）
│   ├── d1-local.mjs       本机 D1 假实现：node:sqlite 冒充 D1（prepare/bind/first/all/run/batch）
│   ├── serve-worker.mjs   本机把 worker/app.js 跑起来（pnpm serve:worker，默认 :4400）
│   ├── worker-app-test.mjs 一条命令跑 Worker + D1 的 58 项账号验收（pnpm test:worker-app）
│   ├── worker-feature-test.mjs 同一份功能用例换成 D1 数据层（pnpm test:worker-features）
│   ├── gen-pinyin.mjs     重新生成 src/pinyin-data.js 的拼音表（--download 取数据源）
│   ├── gen-changelog.mjs  读 git log 重新生成 src/changelog-data.js（pnpm gen:changelog）
│   └── gamepad-test.mjs   手柄自测：注入假手柄跑 7 个用例（pnpm test:gamepad）
├── worker/index.js      Cloudflare Workers 静态版入口：安全头 / 缓存 / 干净地址 / 404
├── worker/app.js        Workers + D1 完整版入口：路由 / 安全头 / 会话（复用 src/views.js）
├── worker/data.js       D1 版全部查询（异步版 src/data.js）
├── worker/data-forum.js D1 版论坛查询（异步版 src/data-forum.js，SQL 与它一一对应）
├── worker/auth.js       D1 版账号：PBKDF2 口令、会话表、默认站长
├── worker/schema.js     建表 + 灌种子 + 站长自举（首次请求时跑，幂等）
├── worker/seed-data.js  4 个分类 / 6 款游戏的种子（由 src/seed.js 生成）
├── worker/mail.js       D1 版发信：配置从 env 读（RESEND_API_KEY / MAIL_API_URL / MAIL_FROM）
├── worker/oauth.js      D1 版第三方登录：密钥从 env 读（GITHUB_/GOOGLE_CLIENT_*、OAUTH_DEV，端点可用 OAUTH_<PROVIDER>_*_URL 覆盖）
├── wrangler.toml        Workers 静态版配置：[assets] 指向 dist-cf，绑定名 ASSETS
├── wrangler.d1.toml     Workers + D1 配置：多一个 [[d1_databases]] 绑定 DB
├── migrations/0001_init.sql  D1 建表脚本（由 worker/schema.js 的 DDL 生成）
├── migrations/0002_game_files.sql  投稿上传用的 game_files 表（0001 已在线上 apply 过，所以单开一个）
├── migrations/0003_posts.sql       公告 posts 表 + comments.target 列
├── migrations/0004_forum.sql       论坛 7 张表（不含 users.muted_until / mute_reason 的 ALTER，两条线会幂等补列）
├── dist/                静态版产物：GitHub Pages 用（--base=/仓库名/）
├── dist-cf/             静态版产物：Cloudflare Pages 用（--base=/，多一个 _headers）
├── cloudflare-pages.zip dist-cf 的 zip 包（pnpm zip:cf），Cloudflare 控制台可直接拖拽上传
├── docs/screens/        冒烟测试与手工验证产出的截图
├── DEPLOY-GITHUB-PAGES.md   静态版部署到 GitHub Pages 的步骤与各种坑
├── DEPLOY-CLOUDFLARE.md     部署到 Cloudflare Pages 的步骤（含 Tunnel 与 Workers 三条路）
├── DEPLOY-CLOUDFLARE-WORKERS.md   Workers + Static Assets 的部署步骤与取舍
├── DEPLOY-CLOUDFLARE-D1.md      Workers + D1 完整版（账号/评分/评论/后台）的部署步骤、限额与未验证项
└── games/<slug>/index.html   每个游戏一个自包含页面（内联 CSS/JS，支持触屏）
```

## 路由表

**页面**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 首页 |
| GET | `/games` | 全部游戏，支持 `?q= &category= &tag= &sort= &page=` |
| GET | `/category/:slug` | 分类页 |
| GET | `/tag/:tag` | 标签页 |
| GET | `/search` | 搜索结果页（`?q=`） |
| GET | `/game/:slug` | 游戏详情 + 播放器 + 评分 + 评论 |
| GET | `/games/:slug/index.html` | 游戏本体（静态目录，供 iframe 加载） |
| GET/POST | `/login` | 登录页 / 提交登录（失败 401 回显表单，支持 `?next=`） |
| GET/POST | `/register` | 注册页 / 提交注册（必须勾选同意《用户协议》与《隐私政策》，否则 400 回表单；用户名重复 409） |
| GET | `/privacy` | 隐私政策（纯静态文本，登录与否都能看） |
| GET | `/terms` | 用户协议（同上；两份都由页脚链到、`/sitemap.xml` 收录） |
| GET | `/notice` · `/notice/:slug` | 公告列表 / 公告详情（详情页带评论；已撤回的公告前台 404，后台仍可见） |
| GET | `/changelog` | 更新说明（由 git 提交历史生成，不需要手写） |
| POST | `/logout` | 退出登录，清掉会话 |
| GET | `/favorites` | 我的收藏夹（需登录） |
| GET/POST | `/submit` | 投稿表单 / 提交投稿（需登录；上传单文件 `.html`（≤ 512 KB）或填已有地址，成功进待审队列） |
| GET | `/admin` | 站长后台：统计 + 待审投稿 + 游戏管理 + 最新评论（需 admin） |
| POST | `/admin/games/:slug/status` | 上架 / 下架 / 通过 / 拒绝（需 admin） |
| POST | `/admin/comments/:id/status` | 隐藏 / 恢复评论（需 admin） |
| GET | `/rank` | 排行榜（`?range=day\|week\|month\|all` 或 `?by=rating\|fav\|new`，默认今日热玩） |
| GET/POST | `/account` | 账号中心：改昵称 / 改密码 / 绑定解绑第三方登录（需登录） |
| POST | `/account/email` · `/account/email/resend` | 绑定或换绑邮箱 · 重发验证信 |
| POST | `/account/password` · `/account/unlink` | 改密码（要旧密码）· 解绑第三方账号 |
| GET | `/verify-email` | 点邮件里的链接验证邮箱（`?token=`，24 小时内有效） |
| GET/POST | `/forgot` · `/reset` | 忘密码：申请重置信 · 用 token 设新密码（30 分钟一次性） |
| GET | `/auth/:provider` · `/auth/:provider/callback` | 第三方登录跳转与回调（`github` / `google` / `dev`） |
| GET | `/admin/preview/:slug` | 后台按详情页形状预览任意状态的游戏（含待审与已下架） |
| GET/POST | `/admin/games/:slug/delete` | 彻底删除一个游戏：GET 是确认页（列出会一起删掉的评论 / 举报 / 评分 / 收藏 / 游玩记录 / 上传文件），POST 真删；还在上架中的会被 400 拒绝 |
| GET | `/ugc/:file` | 投稿上传的单文件 HTML 本体（`/ugc/<slug>.html`）；已上架的谁都能取，待审 / 已下架只有站长能取 |
| POST | `/admin/games/batch` | 批量上架 / 下架 / 通过 / 拒绝（`slug` 可重复传多条） |
| POST | `/admin/reports/:id/status` | 处理 / 忽略一条举报（需 admin） |
| POST | `/admin/users/:id/ban` | 封禁 / 解封用户（`banned=1\|0`，可带理由）（需 admin） |
| POST | `/admin/users/:id/verify` | 手动把某个用户标记成邮箱已验证（需 admin） |
| GET/POST | `/admin/posts/new` · `/admin/posts/:slug/edit` | 后台写 / 改公告（需 admin） |
| POST | `/admin/posts/:slug/status` | 发布 / 撤回一条公告（需 admin） |
| GET | `/forum` | 论坛首页：板块导航 + 最新主题 + 搜索（`?q= &page=`，游客只见已发布） |
| GET | `/forum/f/:slug` | 板块页（`general` 综合讨论 / `guide` 攻略心得 / `help` 求助答疑 / `meta` 站务反馈） |
| GET | `/forum/t/:id` | 主题详情：楼层列表 + 回复框（`?page=`，`?reply=<楼层 id>` 会带上引用提示）；锁定 / 待审 / 待验证邮箱时回复框换成一行说明 |
| GET/POST | `/forum/new` | 发新帖：GET 是表单（未登录只显示登录提示、不签发令牌），POST 过蜜罐 + 一次性令牌 + 标题正文校验后进队列（站长直接公开） |
| POST | `/forum/t/:id/reply` | 回复（可带 `parent_id` 做楼中楼；锁定主题只有站长能回） |
| GET/POST | `/forum/post/:id/edit` | 编辑楼层：只有作者本人与站长能进；普通用户改完**重新待审**并留一条 `forum_post_edits` |
| POST | `/forum/report` | 举报主题或回复（`target_type=thread\|post`，同一人同一目标只算一次） |
| GET | `/forum/admin` | 论坛后台：待审主题 / 待审回复 / 待处理举报 / 关键词黑名单 / 被禁言用户（需 admin） |
| POST | `/forum/admin/threads/:id/status` · `/posts/:id/status` | 通过 / 拒绝主题、通过 / 隐藏楼层（下架主题会连首楼一起下架）（需 admin） |
| POST | `/forum/admin/threads/:id/flags` | 置顶 / 取消置顶、锁定 / 解锁（需 admin） |
| POST | `/forum/admin/reports/:id/status` | 处理 / 忽略一条论坛举报（需 admin） |
| POST | `/forum/admin/blacklist` · `/blacklist/:id/delete` | 增删关键词 / 正则黑名单规则（`kind=word\|regex`、`action=reject\|review`）（需 admin） |
| POST | `/forum/admin/users/mute` · `/users/:id/mute` | 按用户名或 id 禁言 / 解禁（`minutes=0` 即解除，最长 365 天）（需 admin） |
| GET | `/cover/:slug.svg` | 动态封面图 |
| GET | `/sitemap.xml` / `/robots.txt` / `/favicon.ico` | SEO 与图标（robots 屏蔽了 `/admin` `/forum/admin` `/login` `/register` `/favorites` `/submit` `/account` `/forgot` `/reset` `/auth` `/comments/`） |

**API**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/games` | 列表，参数同上；返回 `{ total, limit, offset, items }` |
| GET | `/api/games/:slug` | 单个游戏详情 |
| POST | `/api/games/:slug/play` | 上报一次游玩，30 秒同 IP 去重，返回 `{ counted, plays }` |
| POST | `/api/games/:slug/rate` | 评分，**需登录**，body `{"stars": 1..5}`，返回 `{ stars, previous, isNew, rating, count }`；未登录 401、非法星级 400、游戏不存在 404 |
| GET | `/api/me` | 当前登录用户（未登录返回 `{ user: null }`） |
| POST | `/api/auth/login` | 登录，返回 `{ user }`；失败 401 `bad_credentials` |
| POST | `/api/auth/register` | 注册并登录，201 返回 `{ user }`；重名 409 `taken` |
| POST | `/api/auth/logout` | 退出，返回 `{ ok: true }` |
| POST | `/api/games/:slug/favorite` | 收藏 / 取消收藏（需登录），返回 `{ favorited, count }` |
| GET | `/api/games/:slug/comments` | 评论分页（`?page=`，每页 10 条顶层），返回 `{ items, total, page, pages, pageSize }`，每条回复带 `replies` / `replyCount` |
| POST | `/api/games/:slug/comments` | 发评论或回复（需登录），body `{"body": "...", "parent_id": 可选}`，返回 `{ id, body, parent_id, name }`；空白 400 `empty`、超长 400 `too_long`、10 秒内连发 429 `too_fast`、父评论不存在 400 `bad_parent` |
| POST | `/comments/:id/report` | 举报评论（需登录），body `{"reason": "spam\|abuse\|spoiler\|other"}`；同一人重复举报返回 `{ ok: true, already: true }` |
| GET | `/api/search/suggest` | 搜索联想（`?q=`，最多 8 条），拼音全拼与首字母同样命中 |
| GET | `/api/notices/:slug/comments` | 公告评论分页，形状与游戏评论完全一致（`?page=`，每页 10 条顶层） |
| POST | `/api/notices/:slug/comments` | 发公告评论或回复（需登录，body 同游戏评论；限流按「用户 + 这条公告」单独算） |

## 怎么加一个新游戏

1. 新建 `games/<slug>/index.html`，写一个**自包含**的单页游戏（**不要引用外部资源**，方便以后搬到独立域名）。
2. 在 `src/seed.js` 的 `GAMES` 数组里加一条：

```js
{
  slug: 'my-game',
  title: '我的游戏',
  subtitle: '一句话卖点',
  description: '详情页展示的玩法说明。',
  category: 'puzzle',              // 对应 CATEGORIES 里的 slug
  game_url: '/games/my-game/index.html',
  width: 480, height: 720,         // 播放器按这个比例留白
  orientation: 'portrait',         // portrait | landscape
  tags: ['益智', '休闲'],
  emoji: '🎯',
  accent: '#6366f1', accent2: '#a855f7',   // 封面渐变色 + 卡片配色
  license: '自研'          // plays / rating 不要写死，由真实游玩与评分累加
}
```

3. `pnpm reset` 重新灌种子（或删掉 `data/games.db` 后重启），刷新页面即可看到。

> 列表页的排序、搜索、标签聚合、sitemap、封面图全部由数据驱动，不需要改模板。
> 也可以直接注册一个账号走 `/submit` 投稿：填完进待审队列，站长在 `/admin` 点「✅ 通过上架」就公开了。

## 手柄支持

6 款自研游戏全部支持游戏手柄（Gamepad API），共用一个零依赖 shim：`public/js/gamepad.js`。

游戏页在引入 shim 之前先声明自己的映射：

- 键盘型（2048 / 贪吃蛇 / 俄罗斯方块）：`window.GAMEPAD = { mode: "keys", a: " ", b: "r", start: "p" }` —— shim 合成真的 `keydown` / `keyup` 事件，游戏本体一行都不用改。
- 指针型（记忆翻牌 / 井字棋 / 打地鼠）：`window.GAMEPAD = { mode: "pointer" }` —— 屏幕上出现虚拟光标，摇杆或十字键移动，A 键在光标处发一次完整点击（`pointerdown` + `mousedown` + `pointerup` + `mouseup` + `click`，因为打地鼠这类游戏监听的是 `pointerdown` + `closest(".mole")`，只调 `click()` 不会触发）。

| 按键 | 作用 |
| --- | --- |
| 左摇杆 / 十字键 | 键盘型发方向键；指针型移动虚拟光标（摇杆按住连续移动，十字键默认 150ms 走一步 / 发一次键） |
| A | 键盘型发 `KEY.a`；指针型在光标处点击；任何模式下只要屏幕上有可见的「开始 / 再来一局」按钮，就先点它 |
| B | 发 `KEY.b`（默认空，俄罗斯方块里映射成 `r` 重开） |
| Start | 先点当前可见的「开始 / 再来一局」按钮，没有才发 `KEY.start`（俄罗斯方块里映射成 `p` 暂停） |

映射既可以写成 `window.GAMEPAD.keys = { a: " ", start: "p" }`，也可以把 `a` / `b` / `start` / `up` / `down` / `left` / `right` 直接写在顶层，两种都认（`KEY` 的默认值是方向键 + 空格）。

详情页的游戏在 iframe 里，手柄输入只会送到有焦点的那一层：`public/js/app.js` 与 `public/js/app-static.js` 里挂了 helper —— 收到 `gamepadconnected` 或者轮询到 `navigator.getGamepads()` 里出现手柄时，就把焦点交给 `#gameFrame`（只在焦点还在 `body` 或已经在该 iframe 上时才抢，不会打断输入框）。游戏页自身也会 `window.focus()`。

### 自测

```bash
pnpm test:gamepad        # 等价于 node tools/gamepad-test.mjs
```

`tools/gamepad-test.mjs` 用无头 Chrome + CDP 注入一台假手柄（覆盖 `navigator.getGamepads()`，状态挂在 `window.top.__pad` 上，所以父页面调 `window.__pad.set(...)` 就等于在按 iframe 里那台手柄），跑 7 个用例：

- `gamepad-2048` 十字键让棋盘变化
- `gamepad-snake` A 开始 → A 暂停 → A 继续
- `gamepad-tetris` A 开始 → Start 暂停 → Start 继续
- `gamepad-tictactoe` / `gamepad-memory` / `gamepad-whack` 摇杆把光标开到目标上，A 键落子 / 翻牌 / 敲地鼠
- `gamepad-detail-iframe` 详情页：手柄一连上就自动把焦点交给 iframe，在父页面驱动手柄能在 iframe 里生效

环境变量：`BASE`（默认 `http://127.0.0.1:3000`）、`CHROME`、`SHOTS_DIR`、`CDP_PORT`（默认 9225）、`PROFILE`、`ONLY`（按用例名过滤，例如 `ONLY=snake`）。

坑：`/static` 有 7 天缓存，改完 `gamepad.js` 要么给页面里的引用加 `?v=`（游戏页已经是 `?v=1`），要么在自测里禁用缓存（工具里已经开了 `Network.setCacheDisabled`）。
## 数据模型

```sql
categories(id, slug, name, icon, sort)
games(id, slug, title, subtitle, description, category_id, engine,
      game_url, width, height, orientation, tags /* JSON 字符串 */,
      emoji, accent, accent2, plays, rating, rating_count, license,
      search_pinyin /* 标题的拼音全拼 + 首字母，搜索时与 LIKE 一起命中 */,
      status /* 1 已上架 / 0 已下架 / 2 待审核 */, submitted_by, created_at)
play_logs(id, game_id, day, created_at)   -- 按天统计游玩趋势
ratings(id, game_id, visitor, stars, created_at, updated_at)
      -- UNIQUE(game_id, visitor)：一人一票，可改票；visitor 存登录用户 id 的字符串
      -- CHECK(stars BETWEEN 1 AND 5)；game_id 外键 ON DELETE CASCADE
users(id, username UNIQUE, display_name, pass_hash, pass_salt, role, created_at,
      email, email_verified, banned, banned_reason, verify_token, verify_expires,
      muted_until, mute_reason /* 论坛禁言：到点自动失效，封禁仍走 banned */)
      -- role: user | admin；pass_hash 是 scrypt(password, salt) 的 64 字节 hex
sessions(id, token UNIQUE, user_id, created_at, expires_at)
      -- token 是 randomBytes(32) 的 hex，user_id 外键 ON DELETE CASCADE
favorites(user_id, game_id, created_at)   -- PRIMARY KEY(user_id, game_id)
comments(id, game_id, user_id, body, status, created_at, parent_id, target)
      -- status 1 显示 / 0 隐藏；JOIN users 取昵称
      -- parent_id 为 NULL 是顶层评论，非 NULL 指向顶层评论 id（只做两级）
      -- target 'game' 时 game_id 指 games.id，'post' 时指 posts.id：公告评论与游戏评论共用这张表与举报表

-- 第二批：评论举报 / 操作日志 / 第三方登录 / 找回密码
comment_reports(id, comment_id, user_id, reason, status, created_at)
      -- UNIQUE(comment_id, user_id)：一人对一条评论只算一次举报
      -- status 0 待处理 / 1 已处理 / 2 已忽略；reason: spam | abuse | spoiler | other
audit_logs(id, actor_id, actor_name, action, target, detail, created_at)
      -- 后台每个写操作都记一条，action 如 game.status / game.batch / comment.status /
      -- report.status / user.ban / user.unban / user.verify / email.verify / password.reset
oauth_accounts(provider, provider_uid, user_id, created_at)
      -- PRIMARY KEY(provider, provider_uid)：一个第三方身份只绑一个站内用户
password_resets(token PRIMARY KEY, user_id, created_at, expires_at, used_at)
      -- 用过就写 used_at，不能再用
game_files(slug PRIMARY KEY, filename, size, html, created_at)
      -- 投稿上传的单文件 HTML 正文直接存库（D1 单个值上限约 1MB，所以投稿限制 512 KB）
      -- slug 与 games.slug 一致，对应的 game_url 记成 /ugc/<slug>.html
posts(id, slug UNIQUE, title, body, pinned, status, author_id, created_at, updated_at, published_at)
      -- 公告；status 1 已发布 / 0 已撤回（软撤回，评论留着）；updated_at 只在改内容时写，发布 / 撤回不算改动
-- 第四批：论坛（表名带 forum_ 前缀，避开公告的 posts）
forums(id, slug UNIQUE, name, description, icon, sort, status, created_at)
      -- 默认 4 个板块，第一次访问时幂等插入（ensureForums）
forum_threads(id, forum_id, user_id, title, status, pinned, locked,
      reply_count, view_count, last_reply_at, created_at)
      -- status 0 待审 / 1 已发布 / 2 已下架（软删）；pinned / locked 站长在页内切换
forum_posts(id, thread_id, user_id, body, status, is_op, parent_id,
      edited_at, edit_count, created_at)
      -- 主题正文也是这里的一行（is_op=1）；status 0 待审 / 1 已发布 / 2 已隐藏
      -- parent_id 为 NULL 是直接回复，非 NULL 是楼中楼（只做两级）
forum_post_edits(id, post_id, editor_id, before_body, after_body, created_at)
      -- 编辑留痕：每次编辑写一条改前 / 改后
forum_reports(id, target_type, target_id, user_id, reason, detail, status, created_at)
      -- UNIQUE(target_type, target_id, user_id)：一人对同一主题 / 楼层只算一次
forum_blacklist(id, pattern, kind, action, note, created_at)
      -- kind word | regex，action reject（直接拒绝）| review（转人工待审）
form_nonces(token PRIMARY KEY, user_id, kind, used_at, created_at)
      -- 人机校验用的一次性表单令牌：一人一用、30 分钟过期、用过写 used_at
```

已建索引：`idx_games_cat`、`idx_games_plays`、`idx_logs_game`、`idx_logs_day`、`idx_ratings_game`、`idx_sessions_user`、`idx_fav_user`、`idx_comments_game`，以及第二批加的 `idx_games_status`、`idx_comments_parent`、`idx_reports_status`、`idx_audit_recent`、`idx_oauth_user`、`idx_reset_user`、`idx_posts_status`，以及第四批论坛的 `idx_threads_forum`、`idx_threads_recent`、`idx_threads_user`、`idx_fposts_thread`、`idx_fposts_user`、`idx_fedits_post`、`idx_freports_status`、`idx_nonces_created`。
数据库开启了 WAL 与 `foreign_keys=ON`。

**评分是怎么算的**：写票用 SQLite 的 UPSERT
（`INSERT ... ON CONFLICT(game_id, visitor) DO UPDATE SET stars = excluded.stars`），
写完立刻 `SELECT COUNT(*), AVG(stars)` 重算，把均值（保留 1 位小数）和票数**回写到 games 表**，
这样列表页排序（`sort=rating`）和 JSON-LD 都只需要读 games 一个表。

**登录与会话**：口令用 `node:crypto` 的 `scryptSync` 加盐哈希成 64 字节 hex，比对走 `timingSafeEqual`。
登录成功后往 `sessions` 插一条 `randomBytes(32)` 的 token，通过 `sid` cookie（`HttpOnly; SameSite=Lax; Max-Age=30 天）`下发；
每个请求先按 `/^[a-f0-9]{64}$/` 校验格式再查库、看是否过期，得到 `req.user`。
用户不存在时也会跑一次哈希，避免用响应时间探测哪个用户名存在。

**投稿与上架**：新投稿写进 `games` 但 `status=2` 且记下 `submitted_by`，
公开列表（首页/分类/搜索/API）只查 `status=1`，所以待审与已下架的投稿不会漏出来；
站长在后台改 `status`（`2 → 1` 通过、`2 → 0` 拒绝、`1 → 0` 下架、`0 → 1` 重新上架）。

**投稿上传**：投稿可以只上传一个自包含的 `.html`（也可以继续填已有地址，两边都填时以文件为准）。
文件正文存进 `game_files` 表、`games.game_url` 记成 `/ugc/<slug>.html`，不落磁盘；上限 512 KB（`UPLOAD_MAX`，表单文案 `UPLOAD_LABEL`），扩展名必须 `.html` / `.htm`，还要过「非空 / 是文本 / 含 HTML 标签」三道校验——规则只有一份 `src/upload.js`，Express 与 Workers 共用。
`/ugc/:file` 只认「库里真有这个文件」且「已上架」，其余一律 404；响应带 `Content-Security-Policy: sandbox …`（**不含** `allow-same-origin`）把它降级成不透明源，详情页 iframe 对这种来源也只给 `allow-scripts allow-pointer-lock allow-orientation-lock`，比站内自带游戏更严。
静态导出线没有服务端，因此静态版不提供投稿与上传。

**公告与更新说明**：公告存在 `posts` 表——后台 `/admin/posts/new` 写、`/admin/posts/:slug/edit` 改、`/admin/posts/:slug/status` 发布或软撤回；
撤回只是把 `status` 置 0，前台（列表 / 详情 / 首页横幅 / `sitemap.xml`）立刻看不到，后台仍列出来并且能再发布，评论与举报一直留着。
首页横幅只挂「置顶优先、其次最新」的那一条，关闭状态写在浏览器 `localStorage` 的 `noticeOff:<slug>` 里。
公告评论与游戏评论**共用 `comments` 表**（靠 `target` 区分 `'game'` / `'post'`），也共用分页 / 楼中楼 / 举报与 10 秒限流，只是限流键按公告单独算（`post:<用户>:<公告 id>`），所以同一秒里评游戏与评公告互不影响。
更新说明**不手写**：`pnpm gen:changelog` 跑 `git log --no-merges`（最多 300 条）生成 `src/changelog-data.js`，`feat` / `fix` / `test` / `docs` / `chore` / `refactor` / `perf` / `style` 前缀映射成中文标签，发版前跑一次就能把最近的提交带上去。

**论坛**：公告与论坛是两套数据（`posts` vs `forum_threads`/`forum_posts`），论坛靠 `forum_id` 分板块，
主题正文就是 `forum_posts` 里 `is_op=1` 的那一行，所以「编辑主题」与「编辑回复」是同一条路径。
游客只能看到 `status=1` 的主题与楼层，**作者本人能看到自己的待审内容**（页面会标「待审核」），站长看全部。
发帖门槛 = 登录 + 邮箱已验证 + 未封禁 + 未禁言（`muted_until > now`），四道都在 `forumGate()` 里；
新人与命中「转人工」黑名单的内容一律 `status=0` 进待审队列，站长在 `/forum/admin` 里通过才公开。
普通用户编辑自己的帖子会**重新进待审**（先发干净再改成广告这条路被堵住），每次编辑都往 `forum_post_edits` 写一条留痕。
**首楼被改回待审时整个主题也跟着回待审**，所以后台「待审主题」里一定能看到那条改动。

## 安全设计

- **游戏全部在 iframe 沙箱里跑**：`sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock allow-popups"`，刻意**不给** `allow-top-navigation`，恶意/第三方游戏无法把整站跳走。
- **用户上传的 HTML 比自带游戏更不被信任**：`/ugc/*` 响应头带 `Content-Security-Policy: sandbox …`（`default-src 'none'`、无 `allow-same-origin`、`frame-ancestors 'self'`），详情页 iframe 也只给 `allow-scripts allow-pointer-lock allow-orientation-lock`——不给 `allow-same-origin` 就等于跨源，上传内容拿不到本站 cookie / localStorage / DOM。
- 全站安全头：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、`Permissions-Policy`，以及一条 CSP（因为自研游戏用了内联脚本，放行了 `unsafe-inline`/`unsafe-eval`/`blob:`）。**唯一一处刻意放宽的是 `frame-src`**：写的是 `frame-src 'self' https: http:`——投稿允许填任意外站地址，本站玩法就是把那个地址 iframe 进来，而不同子域也不算 `'self'`，只写 `'self'` 会让外站游戏框整块变成 Chromium 的「该内容被屏蔽了」（`ERR_BLOCKED_BY_CSP`）；其余指令仍然锁死 `'self'`。
- 所有模板输出都过 `esc()` 转义，SQL 查询全部使用参数绑定，LIKE 通配符已转义；评论正文在写库前折叠空白并限长 500。
- 口令只存 scrypt 哈希（不存明文、不存可逆加密），接口返回的 user 只带 id / 用户名 / 昵称 / 角色。
- 会话 cookie 是 `HttpOnly` + `SameSite=Lax`：脚本读不到，跨站表单 POST 也带不上；
  加上登录/收藏/评论都走同源 POST，CSRF 风险被这两层压住（真要更严可以再加一次性 token）。
- 跳转参数走白名单 `safeNext()`，`?next=//evil.com`、`?next=https://evil.com` 一律改写成 `/`，挡掉开放重定向。
- 受限接口都有守卫：`requireLogin`（页面 302 去登录、接口 401）与 `requireAdmin`（非站长 302 / 403）。
- **邮箱验证 / 找回密码都是一次性 token**（`randomBytes(32)`）：验证信 24 小时（`VERIFY_HOURS = 24`）、重置信 30 分钟（`RESET_MINUTES = 30`），重置 token 用过就写 `used_at` 作废，重新申请时旧的未用 token 直接删掉。
- 找回密码**不泄露账号是否存在**：用户名不存在 / 没绑邮箱 / 账号被封，接口一律返回 `{ ok: true }`（内部 `sent:false`），只有真正发了信才 `sent:true`。
- 第三方登录走 OAuth 2.0 授权码模式，`state` 存 cookie、回调时比对（防 CSRF）；`oauth_accounts` 的主键是 `(provider, provider_uid)`，同一个第三方身份只能绑一个站内用户，已绑过的再次点登录会直接进对应账号（不会新建）。演示登录（`dev`）只在非生产环境或 `OAUTH_DEV=1` 时出现。
- **封禁即时生效**：封禁时清掉该用户全部 `sessions`，会话恢复那里再兜一道（`activeOrNull`），已登录的当场掉线；登录被拒时文案带上封禁理由。
- 后台每个写操作都写 `audit_logs`（操作人、动作、目标、明细），后台页直接显示最近 50 条；举报有 `UNIQUE(comment_id, user_id)`，同一人同一条只能算一次。
- **彻底删除是「先下架才能删」**：`status=1` 时直接 400 拒绝，避免一次误点让线上游戏消失；删除走一个事务（先清 `comment_reports` → `comments` → `ratings` → `favorites` → `play_logs` → `game_files` → `games`），删完 `game.delete` 连同数据量一起写进 `audit_logs`，那张投稿的上传文件也一起没了。
- **集成自检只回答「配没配」**：后台那块面板显示邮件走的哪种 transport（Resend / 自建 HTTP / 开发发件箱）、发件人、以及每个第三方登录的 client_id / secret 是否已配置与回调地址，**不回显 secret 明文**，也不发起任何外部请求。

- **论坛的九项审核与安全措施**：①举报 + 后台审核队列 + 违规内容软下架（`status=2`，随时可恢复，不物理删除）；②关键词 / 正则黑名单（命中 `reject` 直接不发，`review` 转人工待审，规则改了立刻失效缓存）；③发帖限流与每日配额（主题 60 秒 / 每天 10 条，回复 20 秒 / 每天 50 条，举报每小时 5 条，按「这个用户最近发了什么」的滚动窗口算，跨 Worker 实例也准）；④禁言（`muted_until` 到点自动解除）与封禁（复用 `banned`，封禁即时清会话）；⑤操作日志（`forum.*` 全部写 `audit_logs`）；⑥新人限制；⑦邮箱验证门槛；⑧人机校验；⑨编辑留痕。
- **人机校验不依赖任何外部服务**：每个表单页面签发一个一次性令牌（`randomBytes(16)` → 32 位 hex，一人一用、30 分钟过期、用过写 `used_at`，提交即核销），外加一个对用户隐藏的蜜罐字段（填了就是机器人）与「打开页面到提交的最短耗时」判断；脚本批量灌水与重放都被这三层挡住，代价是用户无感（没有验证码要认）。
- **论坛的 CSRF 靠同源 + SameSite cookie**：会话 cookie 是 `HttpOnly; SameSite=Lax`，跨站表单带不上；所有论坛 POST 只认表单、且一次性令牌与用户绑定（换个账号的令牌无效），所以即使 Cookie 被带上也无法被第三方站点代发。
- **`forum.fishport.cn` 与主站共用一个登录态**：设了 `COOKIE_DOMAIN=.fishport.cn` 后 cookie 的 Domain 跟着走，两个子域登录状态一致；没设时是普通的主机级 cookie（本机 127.0.0.1 与 `*.workers.dev` 必须这样，写了 Domain 浏览器会丢弃整条 cookie）。
- 论坛的表名统一 `forum_` 前缀，与公告的 `posts` 表区分开；帖子正文写库前统一走 `cleanText()`（CRLF 归一、去控制字符、折叠 3 个以上空行、限长 3000），模板输出一律 `esc()`。

> **上线前必做**：把游戏资源挪到**独立域名**（例如 `games.example.com`），详情页 iframe 指向该域名，并把 `allow-same-origin` 去掉——这样才能真正隔离第三方游戏，防止它读到主站 cookie。
> 另外记得改掉默认管理员口令，并在前面挂 HTTPS。
> 接了 Cloudflare 之后，源站要读 `CF-Connecting-IP` / `X-Forwarded-For` 才能拿到真实访客 IP（现在的去重逻辑用的是 `req.ip`）。

## 部署（Cloudflare 路线）

1. 主站：Node 进程放 VPS，或把渲染层改造成 Serverless（Cloudflare Workers + Hono 等），前面挂 Cloudflare 橙云代理，SSL/TLS 用 **Full (Strict)**。
2. 游戏资源：`games/*` 传 R2 / OSS，走 CDN，用独立域名承载。
3. 数据库：SQLite 单机够用；要上云就换 PostgreSQL 或 Cloudflare D1，`src/data.js` 是唯一需要改的层。
4. `SITE_ORIGIN` 设成正式域名，sitemap / canonical / OG 才会输出正确链接。
5. 国内服务器需 ICP 备案；`robots.txt` 与 sitemap 交给搜索引擎收录是这类站点的主要流量来源。

## 静态版（部署到 GitHub Pages）

GitHub Pages 只能托管静态文件，所以另做了一条导出路线：把服务端渲染结果全部预渲染成 HTML，并把根绝对链接改写成带仓库前缀的静态文件路径（`/game/2048` → `/仓库名/game/2048.html`）。

```bash
node tools/build-pages.mjs --base=/仓库名/ --origin=https://用户名.github.io/仓库名
node tools/serve-dist.mjs --base=/仓库名/ --port=4173   # 本地预览（模拟子路径部署）
node tools/pages-smoke.mjs --base=/仓库名/              # 无头 Chrome 冒烟 + 截图
```

静态版保留：首页、分类、标签、搜索（前端过滤）、列表排序（前端排序）、详情页、iframe 播放器（全屏 / 重开）、6 款游戏本体，以及公告列表 / 公告详情 / 更新说明（都是纯文本页，公告的评论区在静态版不渲染）。
静态版隐藏：登录注册、评分、评论（含公告评论）、收藏、投稿（含上传单文件 HTML）、站长后台、游玩次数（详情页换成一句"静态演示版"说明）；**论坛整块不导出**（论坛是纯动态功能：待审队列、禁言、黑名单都要服务端），静态版导航里因此不出现论坛入口。隐私政策与用户协议是纯静态文本，静态版照样导出（页脚可达）。

参数含义、发布步骤、`.nojekyll` 与中文文件名等坑，见 **[DEPLOY-GITHUB-PAGES.md](DEPLOY-GITHUB-PAGES.md)**。

> **静态版前端与动态版前端是两个文件，别写混**：`public/js/app-static.js` 是静态版（列表排序、前端搜索），
> `public/js/app.js` 是动态版（游玩上报、评分、评论、收藏）。静态导出后 `dist/static/js/` 下**两个都要有**，
> 静态页面引 `app-static.js`；而 Workers / D1 版把 `dist-cf/` 直接当 ASSETS 目录，动态页面必须能拿到 `app.js`。
> `pnpm build:pages` 结束时会自检（`app.js` 必须含 `/api/games/` 与 `ratePanel`，每个 HTML 只能引 `app-static.js`），
> 写错直接 `exit 1`。2026-10 线上「游玩次数不变 / 打不了星 / 发不出评论」就是这个文件被顶掉造成的：
> 本机 Express 版直接服务 `public/js/app.js`，所以怎么测都正常，只有部署到 Workers / D1 才暴露。

## 静态版（部署到 Cloudflare Pages）

同一份代码换个前缀就是 Cloudflare 版：Pages 默认挂在域名根（`https://项目名.pages.dev/`），所以 `--base=/`，并多输出一个 Cloudflare 专属的 `_headers`（安全响应头 + 静态资源分级缓存）。

```bash
node tools/build-pages.mjs --cf --base=/ --origin=https://项目名.pages.dev --out=dist-cf
node tools/pages-smoke.mjs --base=/ --out=dist-cf      # 无头 Chrome 冒烟 + 截图
```

产物 `dist-cf/`（50 个文件 / 363 KB，含 `_headers`）已打包成 **`cloudflare-pages.zip`**（111 KB / 50 个条目；条目名一律用 `/`、中文文件名带 UTF-8 标志，所以拖上去不会解出 `tag\益智.html` 这种怪名字，内容改了以后用 `pnpm zip:cf` 重打），在 Cloudflare 控制台 *Workers & Pages → Create → Pages → Upload assets* 里拖上去即可，不用装 wrangler、不用 Git。三条发布路线（控制台上传 / Git 集成 / wrangler）、自定义域名后的重建、`_redirects` 漂亮地址、以及想挂**有服务端**的完整版时走 Cloudflare Tunnel 的完整命令，见 **[DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)**。

> 本机（开发环境）没有外网出口也没有 Cloudflare 凭证，最后一步上传需要你自己在浏览器里完成；`dist-cf/` 与 zip 都已经构建并本地验证过。

## 静态版（部署到 Cloudflare Workers）

同一份 `dist-cf/` 也可以挂到 **Workers + Static Assets** 上，前面多一个 Worker，于是能注入安全响应头（Workers 不认 Pages 的 `_headers`）、控制缓存、并把 `/games`、`/game/2048` 这种干净地址映射到对应的 `.html`。

```bash
node tools/build-pages.mjs --cf --base=/ --origin=https://game-site.<账号>.workers.dev --out=dist-cf
wrangler deploy                 # 读取 wrangler.toml，把 dist-cf 作为静态资源一起上传
node tools/worker-test.mjs      # 没有 wrangler / 没有网络时的离线自测（pnpm test:worker）
```

这个 Worker 只负责发静态站。想要账号、评分、评论、收藏、后台，用下面的 **[完整版（Workers + D1）](#完整版部署到-cloudflare-workers--d1)**。

## 完整版（部署到 Cloudflare Workers + D1）

纯静态版没有服务端，账号、评分、评论、收藏、投稿、后台都不在。把 `worker/app.js` + **Cloudflare D1**（托管 SQLite）配上，就能把这些功能整体搬到边缘：模板仍是同一个 `src/views.js`，账号验收测试也是同一套 `tools/account-test.mjs`。

```bash
node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名 --out=dist-cf
wrangler d1 create game-site-db                  # 把返回的 database_id 填进 wrangler.d1.toml（也能在控制台 D1 里建库、复制 Database ID）
wrangler d1 migrations apply game-site-db --remote   # 可选：首次访问时 Worker 也会自己建表灌种子
wrangler deploy --config wrangler.d1.toml        # 与静态版同名，等于原地升级，域名不用重绑
```

本机不需要 Cloudflare 账号、不需要外网也能验证（Node 22 的 `node:sqlite` 冒充 D1，见 `tools/d1-local.mjs`）：

```bash
node tools/serve-worker.mjs --reset    # http://127.0.0.1:4400（pnpm serve:worker）
node tools/worker-app-test.mjs         # 一条命令跑 58 项账号验收（pnpm test:worker-app）
node tools/browser-smoke.mjs           # 另开终端，BASE=http://127.0.0.1:4400
```

论坛与主站是同一个 Worker：把 `forum.fishport.cn` 作为**自定义域**加到这个 Worker 上，论坛主机的根路径（`/`、`/f/:slug`、`/t/:id`、`/new`…）会在 Worker 内部重写成 `/forum/*`，`/static` `/login` `/admin` 这些公共前缀照旧。跨子域登录态靠 `wrangler.d1.toml` 的 `COOKIE_DOMAIN = ".fishport.cn"`（**本机开发不要设**，127.0.0.1 带 Domain 的 cookie 浏览器会丢掉）。论坛的表由 `worker/schema.js` 在首次请求时自建，也可以先跑 `wrangler d1 migrations apply`（含 `migrations/0004_forum.sql`）。

完整步骤（建库、绑自定义域名、改默认站长密码、备份与重置、排错），以及**我没能在本机验证的部分**（需要账号的 `wrangler login` / `wrangler deploy`、真实 Workers 上 PBKDF2 的 CPU 时间、D1 限额）都写在 **[DEPLOY-CLOUDFLARE-D1.md](DEPLOY-CLOUDFLARE-D1.md)**；`wrangler dev`（真 workerd）后来已经在本机跑通，命令见 **[DEPLOY-CLOUDFLARE-WORKERS.md](DEPLOY-CLOUDFLARE-WORKERS.md)** 文末。

## 已验证

- 全部页面 / API 路由返回 200，不存在的游戏与路径正确返回 404。
- 6 款游戏均在无头 Chrome 中**真实交互**通过：2048 合出分数、贪吃蛇可转向移动、俄罗斯方块开始后消行计分、记忆翻牌连配 2 对、打地鼠命中计分、井字棋人机交替落子。
- 页面无 console 报错、无 404 资源。
- 线上四连（无法评论 / 贪吃蛇玩不了 / 无法打星 / 游玩次数不变）的回归断言已固化：
  `pnpm smoke` 的 `game-snake` 会断言「开局有可见的开始按钮 → 点完遮罩消失 → 运行中按空格标题变`已暂停` → 恢复后继续跑」；
  `pnpm build:pages` 会自检 `static/js/app.js` 必须是动态前端、且每个 HTML 只引 `app-static.js`（写错 exit 1）；
  `pnpm smoke:pages` 会断言静态详情页引的是 `app-static.js`。
- 账号系统 `pnpm test:account` 共 **58 项断言全部通过**（改造成可以反复跑：注册撞 409 自动改用登录、收藏状态先归零、撞上 10 秒评论限流会等待重发，连跑两次结果一致）：
  游客评分/收藏/评论一律 401、未登录访问 `/submit` 与 `/admin` 跳登录页、
  注册 201 且重名 409 / 非法用户名 400 / 短密码 400、错密码 401 文案统一、
  首评建票、同一人改票票数不涨、非法星数 400、详情页按登录态渲染可点或只读星级、
  收藏来回切换计数正确、`/favorites` 列出收藏、收藏不存在的游戏 404、
  评论空白折叠、空评论 400、超长 400、10 秒内连发 429、
  投稿成功返回编号、非法游戏地址被拒、待审不出现在列表、普通用户改状态 403、
  站长审核上架后出现在列表与详情页、下架后从列表消失、隐藏评论后游客看不到、
  退出后 `/api/me` 归 null、开放重定向被改写成 `/`。
- 静态版 `pnpm smoke:pages` 共 **18 个页面全部通过**（无 console 报错、无资源 404）：
  首页 12 张卡片且无投稿入口、列表页按名称排序真的重排、搜索 `?q=2048` 过滤成 1 张卡、标签页、
  详情页确认收藏按钮 / 评论区 / 可点星级 / 游玩次数都不渲染且 iframe 地址带前缀、
  **在详情页 iframe 里按键真的把 2048 从 0 玩到 16 分**、俄罗斯方块本体可玩、404 页、390x844 手机端无横向溢出，另有新增的排行榜页（今日 / 本周切换）、拼音首字母搜索页（`?q=tcs` 命中的是「贪吃蛇」）与搜索联想下拉、以及新增的隐私政策页与用户协议页（章节数、联系方式 `mailto:` 链接都在），还有公告列表页（条目链到 `/notice/<slug>.html`，空态也有兜底）、有公告时的公告详情页（正文非空、静态版不出评论表单）与更新说明页（20 条提交、类型标签与短哈希、计数与条数一致）。
  截图：`docs/screens/pages-home.png`、`pages-list.png`、`pages-search.png`、`pages-tag.png`、`pages-detail.png`、`pages-play.png`、`pages-game-tetris.png`、`pages-404.png`、`pages-mobile.png`、`pages-rank.png`、`pages-rank-week.png`、`pages-search-pinyin.png`、`pages-suggest.png`、`pages-privacy.png`、`pages-terms.png`、`pages-changelog.png`、`pages-notice.png`、`pages-notice-detail.png`。
- Cloudflare 版产物 `pnpm smoke:pages` 同样 **18 个页面全部通过**（`--base=/ --out=dist-cf`），GitHub 版与 Cloudflare 版两份产物分别构建、分别冒烟。
- Workers 版 `pnpm test:worker` **24 项断言全部通过**：安全响应头与 `server.js:24-45` 逐字段一致、`/static/*` 7 天 / `/cover/*` 1 天 / `/games/*` 1 小时 / HTML 不缓存的缓存策略、`/games` 与 `/game/2048` 干净地址、`/favicon.ico` 302、非 GET 405、404 带 noindex、路径穿越不外泄、「静态路径不产生任何跳转」（防 `html_handling` 配错导致重定向死循环）、外加 10 个页面（含 `/notice`、`/changelog`）**61 条站内链接全部 200**（多了页脚的两份条款、公告与更新说明）；另有一条断言把 `dist-cf/_headers` 里的 CSP 与代码常量逐字段比对（Pages 静态线的放行策略不会悄悄跟代码走偏）。
- Workers + D1 完整版 `pnpm test:worker-app` **58 项账号断言全部通过**（复用 Express 版同一套 `tools/account-test.mjs`），并用 `pnpm smoke` 对 `http://127.0.0.1:4400` 跑了 **23 项全过**（含 6 款游戏真操作、后台、收藏、投稿、论坛首页与主题页），无 console 报错、无资源 404；出厂态复核：首页 12 张「☆ 未评」、`<b>0</b> 次游玩`、详情页「还没有人评分」且无 `aggregateRating`。
- 两套 Workers 产物都在**真实 workerd** 上复验过（`wrangler dev`，wrangler 4.151.0）：静态版逐路径实测无跳转、安全头与缓存头正确；Workers + D1 版逐页面 200、`/favorites` 与 `/admin` 未登录正确 302 到登录，`account-test.mjs` 在真 workerd + 真 D1 语义下 **58 项断言全过**。
  这一步捞出并修掉了两个只有真运行时才暴露的问题：`html_handling` 配成 `auto-trailing-slash` 会让站点陷入 `ERR_TOO_MANY_REDIRECTS`；真实 D1 的 `exec()` 按换行切语句，导致多行建表 SQL 直接 500。细节见两份 Cloudflare 部署文档。
- 后台与账号相关的页面在无头 Chrome 里截图确认过：`docs/screens/login.png`、`register.png`、`submit.png`、`admin.png`、`favorites.png`、`rating.png`。
  手柄自测也会留下 `docs/screens/gamepad-2048.png`、`gamepad-tictactoe.png`、`gamepad-memory.png`、`gamepad-whack.png`、`gamepad-detail-iframe.png`（能直接看到虚拟光标和底部的「🎮 手柄已连接」提示）。
- 手柄支持在无头 Chrome 里跑过 `pnpm test:gamepad`：注入一台假手柄（挂在 `window.top.__pad` 上），**7 个用例全过**（2048 / 贪吃蛇 / 俄罗斯方块 / 井字棋 / 记忆翻牌 / 打地鼠 / 详情页 iframe 自动聚焦并接收手柄输入）；静态版导出后游戏页与 `gamepad.js` 都带 `--base` 前缀，冒烟同样通过。
  - **第二批功能 + 投稿上传 + 彻底删除 + 公告与更新说明（评论分页/楼中楼/举报、排行榜、拼音与首字母搜索、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除、公告发布/编辑/撤回与公告评论）`pnpm test:features` 共 216 项断言全部通过**（其中论坛一节 67 项），同一套用例换成 D1 数据层再跑 `pnpm test:worker-features` 同样 **216 项全过**（见 `tools/feature-test.mjs`，两套共用一个文件）；其中 1 项专门盯着 `frame-src`（详情页 CSP 必须放行 `http(s)`，否则投稿的外站游戏打不开）；另有 12 项是隐私政策 / 用户协议与注册同意：两页都 200 且写了 Cookie 名、第三方登录与邮件，页脚与 `sitemap.xml` 都收录，注册页带必填的 `name="agree"` 与两份文档的链接，不勾同意 400 且不会偷偷建号，勾了就能注册并直接登录；另有 18 项是投稿上传：文件框 + multipart 表单、上传后进待审、待审对游客 404 而站长能取、响应是 `text/html` + sandbox CSP（不含 `allow-same-origin`）、后台预览与详情页 iframe 都是严格沙箱、超 512 KB / 扩展名不对 / 非文本一律 400、只填地址的老投稿仍可用、站长上架后游客能取到并能直接玩、退回待审后又 404；最后 15 项是「彻底删除」：造一条带文件的投稿并写上评分 / 收藏 / 评论 / 游玩记录，上架中删不掉（400），下架后确认页把 6 项数据量逐一对上，POST 删除 302 回后台、详情页与 `/ugc/` 随即 404、操作日志里留下 `game.delete`；还有 30 项是「公告与更新说明」：后台发一条置顶公告、列表与首页横幅都能看到、详情页游客看到登录引导、两个账号（分开发评论与回复，避开 10 秒限流）把分页与楼中楼跑一遍、举报成功且重复举报只算一次、改公告后前台看到新段落与「最后修改」、撤回后详情 404 而重新发布后评论与回复都还在、操作日志留下 `post.create` / `post.update` / `post.retract`，以及 `/changelog` 与 `sitemap.xml` 的收录。
- **邮件与第三方登录端到端 `pnpm test:mail` 共 42 项断言全部通过**（脚本自己起一个假邮件服务端与一个假 OAuth Provider，随机端口、不连外网）：绑定邮箱 → 收到验证信（`Authorization: Bearer` 的令牌、收件人、`MAIL_FROM` 发件人逐项核对）→ 点链接变成已验证；`/forgot` → 重置信 → `/reset` 改密 → 新密码能登、旧密码登不上、账号不存在时也是同一套说辞；GitHub 走完授权 → 回调 → 建号 → 换个浏览器再登还是同一个账号（不重复建号）→ 解绑；Google 同样走通，且资料里的邮箱被存下来并当成已验证；`state` 对不上 400、没开启的 provider 404；后台「集成自检」认出邮件走的是自建 HTTP 服务、GitHub / Google 的 client_id 与 secret 都是 ✅、回调地址与站点一致。同一套场景换成 D1 数据层再跑 `pnpm test:worker-mail` 同样 **42 项全过**。
- `pnpm smoke`（Express）**23 项全部通过**，含新增的排行榜页（7 个榜单 tab、名次与「新上榜」标记）、搜索联想（首字母 / 全拼 / 中文三条路径）、更新说明页、公告列表与详情、首页公告横幅（点关闭后真的消失且写了 `localStorage`）与 `frame-src` 探针（测试进程自己起一个别的 origin 的小页面塞进 iframe，靠它 `postMessage` 回来证明没被 CSP 拦住——把 CSP 锁回 `'self'` 时这一项确实会红）；`pnpm smoke`（Workers + D1）同样 **21 项全部通过**。
> `pnpm smoke` 会用默认管理员真登录一次，并给 2048 留一条评分与一条收藏记录；
  > `pnpm test:account` 会留下 tester1 / tester2 两个账号和一条待审投稿；`pnpm test:features` 会再留下两条测试投稿（其中一条是上传的单文件 HTML，跑完会退回待审）、一条已发布公告（带评论 / 回复 / 举报）与几个测试账号，并且**真删掉它自己造的那条投稿**（日志里因此多一条 `game.delete`）。
  > `pnpm test:mail` / `pnpm test:worker-mail` 会自己起假邮件服务端与假 OAuth Provider（随机端口、不走外网），只往库里写测试账号，跑完不删数据。
  > 两份脚本都按「增量」写断言——评分只看自己那一票、收藏只看总数的变化——所以先跑谁、重复跑几轮结果都一样（同一个库上连跑两遍 account-test 仍是 58/58），前提只是 2048 这个 slug 还在；
  > 论坛那一节还会留下两个论坛测试账号（甲 / 乙）、一条站长主题与若干待审帖，并临时加一条黑名单规则（跑完自己删掉）、禁言再解禁一次；这些都不影响重复运行。
  > 跑完想干净就按上面「彻底回到出厂状态」删库重启。

- **论坛（带审核与安全措施）**：`pnpm test:features` 里 67 项断言一次跑完两条线——游客只能看已发布内容、未登录发帖跳登录、未验证邮箱不给表单、黑名单命中直接拒绝、蜜罐字段命中判机器人、伪造 / 过期令牌被拒、新人主题与回复进待审（游客看不到、作者自己看得到、列表页没有）、连发主题 60 秒 / 连发回复 20 秒被限流、举报与重复举报、站长在 `/forum/admin` 通过 / 置顶 / 锁定、编辑后重新待审（首楼一改整个主题退回待审）、禁言后拿着有效令牌也发不出、`minutes=0` 解除禁言、黑名单增删，以及 `forum.*` 全部写进审计日志。
- **论坛的两种访问形态都实测过**：本机用 `curl -H 'Host: forum.fishport.cn'`（`tools/serve-worker.mjs` 按 Host 拼 URL，等价于真域名）验证论坛主机的 `/` 会走成论坛首页、`/f/general` 200、`/static` 照样出静态资源、主站访问不受影响；设了 `COOKIE_DOMAIN` 时注册响应里确实带 `Domain=.fishport.cn`。

## 后续可做

- 排行榜现在是「SQLite 实时算」，量大了可以换成 Redis 的 `ZINCRBY` / `ZREVRANGE`（`/rank` 这一层不用改，只换数据源）。
- 搜索仍是 LIKE + 拼音表（覆盖 `U+4E00..U+9FFF`）；要错字容错、词义相关性就换 Meilisearch 之类，接口形状已经收在 `searchGames()` 里。
- 微信登录需要企业主体与审核，代码里留的是 GitHub / Google 两条线；再加 Provider 只需往 `src/oauth.js` 的 `META` 里填一组地址即可。
- 邮件现在支持 Resend 或自建 HTTP 发信接口（`MAIL_API_URL` + `MAIL_API_KEY`）；正式发信还该配好 SPF/DKIM、退信与重试。
- 第三方登录的授权 / 令牌 / 用户资料端点已经能用 `OAUTH_<PROVIDER>_*_URL` 覆盖，要接自建 OAuth 网关（比如把 GitHub 藏在公司出口后面）不用改代码。
- 论坛现在用的是「滚动窗口计数」限流（按库里最近的行数算，多实例也准）；要是量再大，可以换成 Cloudflare 的 Rate Limiting 或 Redis 计数器。
- 论坛还缺 @提醒与站内通知、主题标签与精华、附件 / 图片上传（要配套对象存储与审核），以及黑名单正则缓存的跨实例共享（现在是每个实例各缓存 10 秒）。
- 图片/视频素材、真实 OG 截图。
