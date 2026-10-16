# 趣玩小游戏 · 类 4399 小游戏站原型

一个**开箱即跑**的在线小游戏聚合站最小原型：纯 HTML + Express 服务端渲染 + `node:sqlite` 存元数据。
零前端框架、零构建步骤、零图片文件（封面是运行时生成的 SVG），`pnpm install` 后一条命令即可访问。
自带完整的账号体系（注册登录、邮箱验证、找回密码、第三方登录、收藏、评论与楼中楼、举报）与站长后台（投稿审核、批量上下架、举报处理、封禁、彻底删除、操作日志与集成自检），外加 SQLite 排行榜与拼音搜索；投稿可以直接上传**自包含的单文件 HTML**（存库、按 `/ugc/<slug>.html` 托管、用 CSP sandbox 隔离），全部落在本地 SQLite，不依赖任何外部服务。

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

第三方登录：配 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 就会在登录页出现对应按钮（回调地址固定是 `<站点>/auth/<provider>/callback`）；`OAUTH_DEV=1` 可以在生产环境里开「演示登录」。

## 目录结构

```
game-site/
├── server.js            Express 入口：安全头、静态目录、页面路由、API、登录守卫
├── package.json         type: module，scripts: start / dev / reset / smoke / test:account / test:gamepad / test:features / build:pages / zip:cf / serve:dist / smoke:pages / test:worker / serve:worker / test:worker-app / test:worker-features / test:mail / test:worker-mail
├── data/games.db        SQLite 数据库（首次启动自动生成）
├── src/
│   ├── db.js            数据库连接、PRAGMA、建表与索引
│   ├── auth.js          账号：scrypt 口令哈希、会话 cookie、注册校验、默认站长
│   ├── seed.js          分类与游戏的种子数据（node src/seed.js --force 可重置）
│   ├── data.js          所有查询：列表/详情/搜索/评分/收藏/评论/投稿/后台统计
│   ├── views.js         服务端字符串模板：首页/列表/详情/登录注册/收藏/投稿/后台/排行榜/账号
│   ├── mail.js          发信：Resend 或自定义 HTTP 接口，没配就落「开发发件箱」（outbox）
│   ├── oauth.js         第三方登录：GitHub / Google / 演示登录，授权码 + state 校验
│   ├── pinyin.js        拼音搜索：标题转全拼 + 首字母，匹配与相关度
│   ├── pinyin-data.js   拼音表（由 tools/gen-pinyin.mjs 生成，勿手改）
│   └── cover.js         动态生成封面 SVG 与 OG 图 SVG
├── public/
│   ├── css/style.css    全站样式（暗色玻璃拟态，响应式，含播放器与后台表格样式）
│   ├── js/app.js        搜索回填与联想、游玩上报、评分、收藏、评论（分页 / 楼中楼 / 举报）、全屏 / 重开（Express 版）
│   ├── js/app-static.js 静态版前端：列表排序、前端搜索（拼音 / 首字母 / 相关度）、播放器全屏 / 重开
│   └── js/gamepad.js    手柄 shim：keys 模式合成键盘事件、pointer 模式虚拟光标，6 款游戏共用
├── tools/
│   ├── browser-smoke.mjs  无头 Chrome 真实交互冒烟测试（零依赖，pnpm smoke）
│   ├── account-test.mjs   账号系统 58 项断言测试（pnpm test:account，可反复跑）
│   ├── feature-test.mjs   功能与投稿上传 104 项断言：评论分页 / 楼中楼 / 举报、排行榜、拼音搜索、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除（pnpm test:features）
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
│   └── gamepad-test.mjs   手柄自测：注入假手柄跑 7 个用例（pnpm test:gamepad）
├── worker/index.js      Cloudflare Workers 静态版入口：安全头 / 缓存 / 干净地址 / 404
├── worker/app.js        Workers + D1 完整版入口：路由 / 安全头 / 会话（复用 src/views.js）
├── worker/data.js       D1 版全部查询（异步版 src/data.js）
├── worker/auth.js       D1 版账号：PBKDF2 口令、会话表、默认站长
├── worker/schema.js     建表 + 灌种子 + 站长自举（首次请求时跑，幂等）
├── worker/seed-data.js  4 个分类 / 6 款游戏的种子（由 src/seed.js 生成）
├── worker/mail.js       D1 版发信：配置从 env 读（RESEND_API_KEY / MAIL_API_URL / MAIL_FROM）
├── worker/oauth.js      D1 版第三方登录：密钥从 env 读（GITHUB_/GOOGLE_CLIENT_*、OAUTH_DEV，端点可用 OAUTH_<PROVIDER>_*_URL 覆盖）
├── wrangler.toml        Workers 静态版配置：[assets] 指向 dist-cf，绑定名 ASSETS
├── wrangler.d1.toml     Workers + D1 配置：多一个 [[d1_databases]] 绑定 DB
├── migrations/0001_init.sql  D1 建表脚本（由 worker/schema.js 的 DDL 生成）
├── migrations/0002_game_files.sql  投稿上传用的 game_files 表（0001 已在线上 apply 过，所以单开一个）
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
| GET/POST | `/register` | 注册页 / 提交注册（用户名重复 409） |
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
| GET | `/cover/:slug.svg` | 动态封面图 |
| GET | `/sitemap.xml` / `/robots.txt` / `/favicon.ico` | SEO 与图标（robots 屏蔽了 `/admin` `/login` `/register` `/favorites` `/submit` `/account` `/forgot` `/reset` `/auth` `/comments/`） |

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
      email, email_verified, banned, banned_reason, verify_token, verify_expires)
      -- role: user | admin；pass_hash 是 scrypt(password, salt) 的 64 字节 hex
sessions(id, token UNIQUE, user_id, created_at, expires_at)
      -- token 是 randomBytes(32) 的 hex，user_id 外键 ON DELETE CASCADE
favorites(user_id, game_id, created_at)   -- PRIMARY KEY(user_id, game_id)
comments(id, game_id, user_id, body, status, created_at, parent_id)
      -- status 1 显示 / 0 隐藏；JOIN users 取昵称
      -- parent_id 为 NULL 是顶层评论，非 NULL 指向顶层评论 id（只做两级）

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
```

已建索引：`idx_games_cat`、`idx_games_plays`、`idx_logs_game`、`idx_logs_day`、`idx_ratings_game`、`idx_sessions_user`、`idx_fav_user`、`idx_comments_game`，以及第二批加的 `idx_games_status`、`idx_comments_parent`、`idx_reports_status`、`idx_audit_recent`、`idx_oauth_user`、`idx_reset_user`。
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

静态版保留：首页、分类、标签、搜索（前端过滤）、列表排序（前端排序）、详情页、iframe 播放器（全屏 / 重开）、6 款游戏本体。
静态版隐藏：登录注册、评分、评论、收藏、投稿（含上传单文件 HTML）、站长后台、游玩次数（详情页换成一句"静态演示版"说明）。

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
- 静态版 `pnpm smoke:pages` 共 **13 个页面全部通过**（无 console 报错、无资源 404）：
  首页 12 张卡片且无投稿入口、列表页按名称排序真的重排、搜索 `?q=2048` 过滤成 1 张卡、标签页、
  详情页确认收藏按钮 / 评论区 / 可点星级 / 游玩次数都不渲染且 iframe 地址带前缀、
  **在详情页 iframe 里按键真的把 2048 从 0 玩到 16 分**、俄罗斯方块本体可玩、404 页、390x844 手机端无横向溢出，另有新增的排行榜页（今日 / 本周切换）、拼音首字母搜索页（`?q=tcs` 命中的是「贪吃蛇」）与搜索联想下拉。
  截图：`docs/screens/pages-home.png`、`pages-list.png`、`pages-search.png`、`pages-tag.png`、`pages-detail.png`、`pages-play.png`、`pages-game-tetris.png`、`pages-404.png`、`pages-mobile.png`、`pages-rank.png`、`pages-rank-week.png`、`pages-search-pinyin.png`、`pages-suggest.png`。
- Cloudflare 版产物 `pnpm smoke:pages` 同样 **13 个页面全部通过**（`--base=/ --out=dist-cf`），GitHub 版与 Cloudflare 版两份产物分别构建、分别冒烟。
- Workers 版 `pnpm test:worker` **24 项断言全部通过**：安全响应头与 `server.js:24-45` 逐字段一致、`/static/*` 7 天 / `/cover/*` 1 天 / `/games/*` 1 小时 / HTML 不缓存的缓存策略、`/games` 与 `/game/2048` 干净地址、`/favicon.ico` 302、非 GET 405、404 带 noindex、路径穿越不外泄、「静态路径不产生任何跳转」（防 `html_handling` 配错导致重定向死循环）、外加 8 个页面 **54 条站内链接全部 200**；另有一条断言把 `dist-cf/_headers` 里的 CSP 与代码常量逐字段比对（Pages 静态线的放行策略不会悄悄跟代码走偏）。
- Workers + D1 完整版 `pnpm test:worker-app` **58 项账号断言全部通过**（复用 Express 版同一套 `tools/account-test.mjs`），并用 `pnpm smoke` 对 `http://127.0.0.1:4400` 跑了 **18 项全过**（含 6 款游戏真操作、后台、收藏、投稿），无 console 报错、无资源 404；出厂态复核：首页 12 张「☆ 未评」、`<b>0</b> 次游玩`、详情页「还没有人评分」且无 `aggregateRating`。
- 两套 Workers 产物都在**真实 workerd** 上复验过（`wrangler dev`，wrangler 4.151.0）：静态版逐路径实测无跳转、安全头与缓存头正确；Workers + D1 版逐页面 200、`/favorites` 与 `/admin` 未登录正确 302 到登录，`account-test.mjs` 在真 workerd + 真 D1 语义下 **58 项断言全过**。
  这一步捞出并修掉了两个只有真运行时才暴露的问题：`html_handling` 配成 `auto-trailing-slash` 会让站点陷入 `ERR_TOO_MANY_REDIRECTS`；真实 D1 的 `exec()` 按换行切语句，导致多行建表 SQL 直接 500。细节见两份 Cloudflare 部署文档。
- 后台与账号相关的页面在无头 Chrome 里截图确认过：`docs/screens/login.png`、`register.png`、`submit.png`、`admin.png`、`favorites.png`、`rating.png`。
  手柄自测也会留下 `docs/screens/gamepad-2048.png`、`gamepad-tictactoe.png`、`gamepad-memory.png`、`gamepad-whack.png`、`gamepad-detail-iframe.png`（能直接看到虚拟光标和底部的「🎮 手柄已连接」提示）。
- 手柄支持在无头 Chrome 里跑过 `pnpm test:gamepad`：注入一台假手柄（挂在 `window.top.__pad` 上），**7 个用例全过**（2048 / 贪吃蛇 / 俄罗斯方块 / 井字棋 / 记忆翻牌 / 打地鼠 / 详情页 iframe 自动聚焦并接收手柄输入）；静态版导出后游戏页与 `gamepad.js` 都带 `--base` 前缀，冒烟同样通过。
  - **第二批功能 + 投稿上传 + 彻底删除（评论分页/楼中楼/举报、排行榜、拼音与首字母搜索、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除）`pnpm test:features` 共 104 项断言全部通过**，同一套用例换成 D1 数据层再跑 `pnpm test:worker-features` 同样 **104 项全过**（见 `tools/feature-test.mjs`，两套共用一个文件）；其中 1 项专门盯着 `frame-src`（详情页 CSP 必须放行 `http(s)`，否则投稿的外站游戏打不开）；另有 18 项是投稿上传：文件框 + multipart 表单、上传后进待审、待审对游客 404 而站长能取、响应是 `text/html` + sandbox CSP（不含 `allow-same-origin`）、后台预览与详情页 iframe 都是严格沙箱、超 512 KB / 扩展名不对 / 非文本一律 400、只填地址的老投稿仍可用、站长上架后游客能取到并能直接玩、退回待审后又 404；最后 15 项是「彻底删除」：造一条带文件的投稿并写上评分 / 收藏 / 评论 / 游玩记录，上架中删不掉（400），下架后确认页把 6 项数据量逐一对上，POST 删除 302 回后台、详情页与 `/ugc/` 随即 404、操作日志里留下 `game.delete`。
- **邮件与第三方登录端到端 `pnpm test:mail` 共 42 项断言全部通过**（脚本自己起一个假邮件服务端与一个假 OAuth Provider，随机端口、不连外网）：绑定邮箱 → 收到验证信（`Authorization: Bearer` 的令牌、收件人、`MAIL_FROM` 发件人逐项核对）→ 点链接变成已验证；`/forgot` → 重置信 → `/reset` 改密 → 新密码能登、旧密码登不上、账号不存在时也是同一套说辞；GitHub 走完授权 → 回调 → 建号 → 换个浏览器再登还是同一个账号（不重复建号）→ 解绑；Google 同样走通，且资料里的邮箱被存下来并当成已验证；`state` 对不上 400、没开启的 provider 404；后台「集成自检」认出邮件走的是自建 HTTP 服务、GitHub / Google 的 client_id 与 secret 都是 ✅、回调地址与站点一致。同一套场景换成 D1 数据层再跑 `pnpm test:worker-mail` 同样 **42 项全过**。
- `pnpm smoke`（Express）**18 项全部通过**，含新增的排行榜页（7 个榜单 tab、名次与「新上榜」标记）、搜索联想（首字母 / 全拼 / 中文三条路径）与 `frame-src` 探针（测试进程自己起一个别的 origin 的小页面塞进 iframe，靠它 `postMessage` 回来证明没被 CSP 拦住——把 CSP 锁回 `'self'` 时这一项确实会红）；`pnpm smoke`（Workers + D1）同样 **18 项全部通过**。
> `pnpm smoke` 会用默认管理员真登录一次，并给 2048 留一条评分与一条收藏记录；
  > `pnpm test:account` 会留下 tester1 / tester2 两个账号和一条待审投稿；`pnpm test:features` 会再留下两条测试投稿（其中一条是上传的单文件 HTML，跑完会退回待审），并且**真删掉它自己造的那条投稿**（日志里因此多一条 `game.delete`）。
  > `pnpm test:mail` / `pnpm test:worker-mail` 会自己起假邮件服务端与假 OAuth Provider（随机端口、不走外网），只往库里写测试账号，跑完不删数据。
  > 两份脚本都按「增量」写断言——评分只看自己那一票、收藏只看总数的变化——所以先跑谁、重复跑几轮结果都一样（同一个库上连跑两遍 account-test 仍是 58/58），前提只是 2048 这个 slug 还在；
  > 跑完想干净就按上面「彻底回到出厂状态」删库重启。

## 后续可做

- 排行榜现在是「SQLite 实时算」，量大了可以换成 Redis 的 `ZINCRBY` / `ZREVRANGE`（`/rank` 这一层不用改，只换数据源）。
- 搜索仍是 LIKE + 拼音表（覆盖 `U+4E00..U+9FFF`）；要错字容错、词义相关性就换 Meilisearch 之类，接口形状已经收在 `searchGames()` 里。
- 微信登录需要企业主体与审核，代码里留的是 GitHub / Google 两条线；再加 Provider 只需往 `src/oauth.js` 的 `META` 里填一组地址即可。
- 邮件现在支持 Resend 或自建 HTTP 发信接口（`MAIL_API_URL` + `MAIL_API_KEY`）；正式发信还该配好 SPF/DKIM、退信与重试。
- 第三方登录的授权 / 令牌 / 用户资料端点已经能用 `OAUTH_<PROVIDER>_*_URL` 覆盖，要接自建 OAuth 网关（比如把 GitHub 藏在公司出口后面）不用改代码。
- 图片/视频素材、真实 OG 截图。
