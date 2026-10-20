# 趣玩小游戏 · 类 4399 小游戏站原型

一个**开箱即跑**的在线小游戏聚合站最小原型：纯 HTML + Express 服务端渲染 + `node:sqlite` 存元数据。
零前端框架、零构建步骤、零图片文件（封面是运行时生成的 SVG），`pnpm install` 后一条命令即可访问。
自带完整的账号体系（注册登录、邮箱验证、找回密码、第三方登录、收藏、评论与楼中楼、举报）与站长后台（投稿审核、批量上下架、举报处理、封禁、彻底删除、操作日志与集成自检），外加 SQLite 排行榜与拼音搜索、站内公告与更新说明（`/notice`、`/changelog`）、隐私政策与用户协议（`/privacy`、`/terms`）；投稿可以直接上传**自包含的单文件 HTML**（存库、按 `/ugc/<slug>.html` 托管、用 CSP sandbox 隔离），全部落在本地 SQLite，不依赖任何外部服务；另外带一个**有审核与安全措施的论坛**（`/forum`，也可以单独挂到 `forum.fishport.cn`，与游戏站共用同一套账号与后台）。站内 20 款自研小游戏（其中六款棋类可联机对战）、每日挑战、成就徽章与个人主页（`/u/:name`）、棋谱回放与只读观战，全部零外部依赖。

![首页](docs/screens/home.png)

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 首页 | Hero（今日最热）、游戏分类、热门推荐、最新上架 |
| 游戏库 | 分类页 `/category/:slug`、标签页 `/tag/:tag`、全部游戏 `/games`，支持 `sort=hot\|new\|rating\|title` |
| 搜索 | `/search?q=` 与 `/games?q=`，按标题/副标题/描述/标签模糊匹配（已转义 LIKE 通配符），并支持**拼音全拼与首字母**（`xiao you xi`、`xyx` 都能搜到「小游戏」），同分时标题命中的排前面；输入框有实时联想 `/api/search/suggest`。取数走 `src/search.js` 的适配层：设了 `MEILI_HOST` 就用 Meilisearch 当主后端（`MEILI_API_KEY` / `MEILI_INDEX` / `SEARCH_TIMEOUT_MS` 可配），超时、报错或连挂三次触发熔断都自动退回 LIKE + 拼音，接口照样 200；结果里带 `source` / `backend`，能看出这一问是主后端答的还是兜底答的 |
| 排行榜 | `/rank` 今日 / 本周 / 本月 / 总榜 + 评分榜 / 收藏榜 / 新游榜，数据源是本地 SQLite 的 `play_logs`（**没有引入 Redis**，但每次取数走 `src/rank-cache.js` 的进程内缓存：30 秒 TTL + 单飞 + 按参数分键，远程缓存留了 `redisLikeAdapter` 接缝），首页与详情页都有入口 |
| 限流适配层 | `src/ratelimit.js`：滑动窗口限流器 + 封禁缓存，默认进程内 Map（惰性清理 + 容量上限 + LRU 淘汰），`createLimiter` 可注入 `store { get, set(key, value, ttlMs), del }` 换成 Redis / Cache API（口子与 `rank-cache` 同一套），`createBanCache` 命中缓存才免查库、失效时经 `store.del` 广播；限流是「尽力而为」——存储出错一律不抛，读失败就退化成纯内存，`stats().backend` 如实变 `memory`。Workers 侧（`worker/ratelimit.js`）同名同语义，跨实例共享介质默认 **Cache API** 而不是 Redis（零 schema、零绑定、自带 TTL 与删除，不用为计数多一张表） |
| 详情页 | 玩家信息 + 相关推荐 + 操作提示 + 游玩次数 + 5 星评分 + 收藏 + 玩家评论 |
| 播放器 | iframe `sandbox` 隔离 + 全屏 + 真·重开 + 新窗口打开 |
| 手柄 | 20 款游戏全部支持游戏手柄（十字键 / 摇杆 / A / B / X / Y / Start）；除黑洞吞噬（它在页面里自己轮询手柄）外都用同一个零依赖 shim `public/js/gamepad.js`：键盘型合成真按键事件、指针型在虚拟光标处发一次完整点击、棋盘型（扫雷 / 推箱子 / 黑白棋）用 `dpad` 标记 + 自己的 `keys` 映射把方向键与 A / B 接上，见「手柄支持」 |
| 20 款自研游戏 | 2048、贪吃蛇、记忆翻牌、打地鼠、井字棋（minimax AI）、俄罗斯方块、黑洞吞噬、扫雷、数独、推箱子、连连看、成语猜猜（中文 Wordle）、五子棋、中国象棋、国际象棋、四子棋、黑白棋（奥赛罗）、国际跳棋、宝石三消、纸牌接龙 |
| 棋类联机 | 五子棋 / 中国象棋 / 国际象棋 / 四子棋 / 黑白棋 / 国际跳棋六款棋类都能**联机对战**：房间码 + 快速匹配，匿名可玩（`public/js/net-play.js` 小部件 + `/api/play/*` 七个接口（含只读观战），服务端做轮流与走法中继，并对**六款全部自己裁判**（`src/rules/`：非法走法 400 `illegal_move` 且不落库、胜负由引擎判、客户端声明的 `result` 不再采信；中国象棋的走法码是 `x1,y1-x2,y2`、国际象棋是 UCI 式 `e2e4` / 升变 `e7e8q`，各自逐字对齐客户端联机中继的编码）；服务端与客户端两条线共用一份规则与数据层（`src/play.js`、`src/play-store.js` ↔ `worker/play-store.js`） |
| 棋类 AI | 六款棋类各自内置三档 AI（简单 / 普通 / 困难），纯前端实现、不联网；困难档都是带剪枝的浅搜索（国际象棋与中国象棋另含吃子排序与静止搜索） |
| 账号 | 注册 / 登录 / 退出；`scrypt` 加盐哈希存口令，`HttpOnly` 会话 cookie，30 天有效 |
| 账号增强 | 邮箱验证（`/verify-email`，24 小时有效）、找回密码（`/forgot` → `/reset`，token 30 分钟一次性）、改密码 / 改昵称 / 解绑第三方账号都在 `/account`；**邮件可走 Resend 或自建 HTTP 发信接口**（`MAIL_API_URL` + `MAIL_API_KEY`），没配就落「开发发件箱」，后台的「集成自检」面板会把当前邮件与登录配置摊开给你看 |
| 邮件发件箱 | 外发邮件**先落库再发**（`mail_outbox`：`status` / `attempts` / `next_attempt_at` / `last_error`），发失败按**指数退避**重试（基数 `MAIL_RETRY_BASE_MS` 默认 60 秒、上限 6 小时、`MAIL_MAX_ATTEMPTS` 默认 6 次），到上限落 `failed`、退信记 `bounced`，开发发件箱里能看到待发与失败的信；`src/outbox.js` 与 `worker/outbox.js` 同名同参同返回（少了「网络一抖这封信就没了」），Express 侧用 `ensureOutbox()` 幂等建表、D1 侧走 `migrations/0009_mail_outbox.sql`；**投递循环**由 `MAIL_TICK_MS`（默认 60 秒、`MAIL_TICK=0` 关闭）驱动，Express 侧是常驻定时器、Workers 侧是机会式 `mailRetryTick(ctx)`（挂在每次请求之后，建议再配一个 Cron Trigger），补发只走 `deliverNow`、不重入队；**退信 / 投诉回调** `POST /webhooks/mail-bounce`（校验 `MAIL_WEBHOOK_SECRET`）把地址写进抑制名单，`enqueue` 之后直接拒收（回 `{ suppressed: true }`）；站长后台 **`/admin/mail`** 一页看送达率（按状态 / 按 tag / TOP 错误）与抑制名单，可手工加 / 解抑制 |
| 第三方登录 | GitHub / Google / 微信（扫码登录要企业主体 + 微信开放平台认证，个人主体申请不到；没资质就继续用前两个）/ 演示登录（`/auth/:provider`），OAuth 2.0 授权码模式，原生 `fetch` 实现、零依赖；同一个第三方账号只绑一个站内用户，已绑过就直接登录；授权 / 令牌 / 用户资料端点都可用 `OAUTH_<PROVIDER>_*_URL` 覆盖（接自建网关或测试环境时用）；**回调地址跟着当前域名走**——用了第二个域名（比如 `forum.fishport.cn`）就要在 GitHub / Google 后台把它那两份回调地址也登记上，只登记主站的话在那台主机上点登录会报 `redirect_uri` 不匹配 |
| OAuth 网关 | 想把第三方密钥挪出本站，就把三条线都指到**自建网关**（`OAUTH_GATEWAY_URL`）：授权页跳 `<网关>/authorize`、回调换资料走 `<网关>/token`，本站不再持有任何第三方 Client Secret；请求带 HMAC-SHA256 签名 + 时间戳（`GATEWAY_TS_WINDOW = 300` 秒）防重放，`OAUTH_GATEWAY_PROVIDERS` 决定哪些 Provider 走网关（不配 = GitHub / Google / 微信都走）；网关的接口约定、错误码与最小实现示例写在 `docs/OAUTH.md` |
| 法律页面 | `/privacy` 隐私政策、`/terms` 用户协议，纯静态文本、登录与否都能看，页脚每页都有链接、`/sitemap.xml` 收录；注册页必须勾选「我已阅读并同意《用户协议》与《隐私政策》」才能提交（表单里是必填 checkbox，服务端还会兜一次，不勾就 400 回表单），勾选框旁边就是两份文档的链接 |
| 公告 | `/notice` 列表 + `/notice/:slug` 详情，站长在后台随时发布 / 修改 / **软撤回**（前台立刻消失、评论保留，重新发布即恢复）；公告自己也能被评论与举报（与游戏评论同一套分页 / 楼中楼 / 举报），首页顶部再挂一条最新公告的可关闭横幅（关掉写 `localStorage`，不再打扰） |
| 更新说明 | `/changelog`，**不手写**：`pnpm gen:changelog` 读 `git log` 生成 `src/changelog-data.js`（feat / fix / docs… 映射成中文标签），页脚有入口、`/sitemap.xml` 收录 |
| 论坛 | `/forum`：默认 4 个板块、主题列表与搜索、两级楼中楼回复、编辑留痕；发帖要登录 + **邮箱已验证** + 未被封禁 / 禁言；新人（发帖不足 3 条）的主题与回复自动进待审队列，站长在 `/forum/admin` 通过 / 拒绝 / 置顶 / 锁定 |
| 论坛的审核与安全 | 9 项措施：举报 + 后台审核队列 + 违规内容软下架、关键词 / 正则黑名单（命中「直接拒绝」或「转人工待审」）、发帖限流与每日配额（主题 60 秒 1 条 / 每天 10 条，回复 20 秒 / 每天 50 条，举报每小时 5 条）、禁言（到点自动解除）与封禁、操作日志（`audit_logs`）、新人限制、邮箱验证门槛、不依赖外部服务的人机校验（一次性表单令牌 + 蜜罐字段 + 最短填写耗时）、编辑留痕（`forum_post_edits` 存改前改后，普通用户一改就重新待审） |
| 论坛域名 | 同一套路由既能走 `/forum`，也能把 `forum.fishport.cn` 指到同一个 Worker：论坛主机上的请求在内部重写成 `/forum/*`、页面里的链接基址自动切换，账号 / 后台 / 审计日志完全共用（跨子域登录态靠 `COOKIE_DOMAIN=.fishport.cn`；`pnpm check:forum` 一条命令就能查主站与论坛主机两侧是否都正常，并会把「GitHub / Google 该登记哪些回调地址」原样列出来） |
| 论坛附件与标签精华 | 发主题与回复都能带附件（`enctype=multipart/form-data`、字段名 `files`、可多选、单文件 ≤ 4 MB），`src/multipart.js` 手写解析（零依赖，Workers 侧用自带 `request.formData()`），`src/attachments.js` 按**扩展名 + MIME + 魔数**三重校验并清洗文件名，存储是 fs / D1 双驱动适配层（Express 落 `data/attachments/`、Worker 落 D1）、按 `sha256` **内容寻址去重**；附件走 `pending → active → deleted` 生命周期，只有 `active`（已挂到帖子上）才在 `/ugc/a/:id` 给内容，`pending` 孤儿超 24 小时连行带内容清掉；主题可打标签（`thread_tags`，`/forum?tag=` 按标签筛）、站长可标**精华**（`featured`，只认 admin 与 mod，与置顶 / 锁定同一条审批路由）；这一轮又把附件这一层做厚了：存储能切**对象存储**（`ATTACH_STORE=local` 或 `ATTACH_STORE=s3`，S3 兼容端点 + 预签 URL，配不齐就回落本地盘并打一行日志），图片附件多两步复核——先按扩展名 / MIME / 体积 / 魔数 / 像素尺寸跑一遍自动规则（只拒不放行，判不准就留给人），再由站长在 `/forum/admin/attachments` 人工通过或拒绝（`reject` 是**软删 + 隐藏**，行与内容都留着、能翻案；`pending` 不挡正常展示） |
| 导航页 | `/nav`：`fishport.cn` 下所有能打开的站点一页直达（清单只有一份，在 `src/sites.js`，加子域只改它）；把 `fishport.cn` / `www.fishport.cn` 作为**自定义域**加到同一个 Worker 后，这两个主机的根路径**直接就是导航页**（判定见 `PORTAL_HOSTS`，三个门户主机之外的子域走 `/nav`）；邮件（`send` / `rsend`）与 Minecraft（`mc`）这类只给程序用的解析记录按需求不导航 |
| 每日挑战 | `/daily`：当天题目由「已上架游戏的 slug 排序后与日期一起哈希」选出，选题是纯函数（`src/daily.js`），Express 与 Workers 两条线**同日同题**，加游戏也不会把最近几天的题翻掉；登录后当天玩到那款游戏即打卡（`daily_results` 一天一人一条），页面给 28 天日历、连续天数、当月全勤与今日榜；**漏做的可以补做**（`/daily/makeup`，只放开最近两天），补做记在目标日那一行（`makeup=1`，`done_day` 记实际完成日），**不计连续天数、只计总完成数**——否则连续天数可以无限续，对按时打卡的人不公平；没登录能看题与榜，打卡要账号；**打卡还有实质奖励**——`src/rewards.js` 给连续 7 / 14 / 30 / 100 天、当月全勤、累计 30 / 100 / 365 次共 8 档（经验 + 称号，全拿满 8000 经验），与徽章等级是两套可叠加的口径（`rewardLevelOf` 一步出总经验），`/daily` 与个人主页都出进度条；奖励一发就落 `user_rewards` **流水**（幂等 + 只增），断签或翻月不会把已经拿到手的经验收回去，`/daily` 上有「🏆 奖励流水」面板 |
| 浏览器推送 | Web Push（VAPID）：通知中心里一键开关，有人回复你、@你、关注你或给你发私信时浏览器直接弹通知（点通知跳对应页面）。加密与签名是 `src/push-core.js` 的纯函数（RFC 8291 `aes128gcm` + RFC 8188 记录填充 + ES256 VAPID JWT，只用 `crypto.subtle`，Node 22 与 Workerd 双跑），订阅落 `push_subs`（`src/push.js` ↔ `worker/push.js`，同名同参）；投递遇 404 / 410 自动删订阅、连续失败满 5 次自动停投（只有重新订阅能复活）；**没配 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 时整条链路空转**，通知中心不显示按钮 |
| 成就与等级 | 16 枚徽章（首次评论 / 评论数 / 收藏 / 评分 / 发主题 / 回帖 / 每日打卡 / 连续天数 / 邮箱验证 / 注册天数 / 投稿上架…）＋ XP 与等级（上限 99 级，等级带「新面孔 → 骨灰级玩家」头衔）；统计与解锁判定都在 `src/badges.js` 的纯函数里，两条线共用一份、页面不各算一套；**刻意不做联机胜负类徽章**——六款棋类虽都已有服务端裁判，但对手多为匿名昵称（账号与匿名是两套身份键），跨游戏口径不齐，索性不做 |
| 个人主页 | `/u/:name`：用户名或昵称都能打开（大小写不敏感），一页看完等级 / XP 进度 / 头衔 / 已获与未获徽章（未获的显示进度）/ 每日挑战与连续天数 / 发帖评论数 / 注册时间；自己的主页会多一个「看我的徽章」入口 |
| 关注与好友 | 个人主页上的「＋ 关注」是普通表单 POST（`/u/:name/follow`，没 JS 也能用），已关注时按钮变「取消关注」；粉丝 / 关注 / 好友（**互关即成好友**）三种列表各一页（`/u/:name/followers\|following\|friends`），个人主页顶部三格数字可点进去 |
| 通知中心 | `/notifications`：别人回复你的主题、在帖子里 @你、关注你、评论你上架的游戏都会落一条通知（`reply` / `mention` / `follow` / `message` / `comment` / `system` 六类；同一人同一目标 10 分钟内去重，自己给自己不写），未读高亮、一键「全部标为已读」；`/api/notifications/unread` 给红点轮询 |
| 私信 | `/messages` 会话列表 + `/messages/:name` 单会话（同一个页面两种模式），发信校验自我 / 封禁 / 超长，打开会话即把对方发来的消息标为已读；`/api/messages/unread` 给红点 |
| 好友动态 | `/feed`：把你关注的人最近在玩什么（收藏 / 想玩与联机对局）、评论、发帖与每日打卡汇成一条时间线（`src/social.js` 的 `friendFeed`，四路 UNION ALL 后按人 + 游戏去重、`at DESC` 排序，最多看最近关注的 150 人；匿名对局不进流，避免把昵称当账号） |
| 棋谱回放与观战 | 棋类对局结束时由服务端落一条棋谱（`play_replays` 存每步走法），`/replay/:id` 用同一款游戏的播放器按走法复盘，页面下还列出同款游戏的其它棋谱，`/api/replays/:id` 给原始走法；对局中可开只读观战：`/api/play/watch` 按 `{ key, since }` 增量返回公开走法（座位是 `-1`、响应里没有双方 token）；`/replays` 还能按棋类 / 玩家 / 结果 / 日期区间检索，登录后可选「只看我的」（第十批起 `play_replays` 补了 `host_user_id` / `guest_user_id`，按账号匹配；更早的棋谱这两列是 0，自动回退按昵称匹配），并把当前筛选结果导出成 JSON；同一份筛选还能导成**棋谱专用格式**——`/replays/export.sgf`（五子棋 / 四子棋 / 黑白棋 / 国际跳棋 / 中国象棋，各按自己的坐标与手数映射）、`/replays/export.pgn`（国际象棋，SAN 记谱）、`/replays/export.tar.gz`（混合格式逐局一文件打包；Workers 侧没有 zlib，那边出未压缩的 tar），导出走 `src/record-export.js` 的纯函数（坏数据跳过并计数、不整包失败，翻页换筛选也跟着走） |
| 联机天梯 | `/ladder` 给六款**服务端裁判**棋类（四子棋 / 黑白棋 / 国际跳棋 / 五子棋 / 中国象棋 / 国际象棋）的 Elo 榜，`?game=<slug>` 切 tab（缺省第一款）、榜取前 50，赛季按 **UTC 自然季度**算（`YYYY-Q1`…`Q4`，不用另配赛季起点）；结算在 `src/elo.js`——纯函数、零 I/O，起始 1200、下限 100，K 值按已结算局数分档（<10 局 40 / <30 局 24 / 其余 16，与 FIDE 一样是「每人一份」，双方档位不同时一局不是零和）；`elo_history` 用 `room_id` 唯一索引兜住「同一局不许结算两次」，`/replays` 是棋谱列表（`?game=<slug>` 过滤、`?page=` 翻页，每页 20 条，还能按玩家 / 结果 / 日期区间检索并导出 JSON） |
| 分享卡 | `/play/:id/card.svg`、`/u/:name/card.svg`、`/daily/card.svg` 三条路由出 1200×630 的 SVG 卡片（`src/cards.js`，纯函数、零外链、两条线共用）：棋谱卡画出棋盘示意图与手数、个人主页卡是徽章墙（已获最多 8 枚 + 未获 4 枚）、每日挑战卡带 14 天打卡条带；页面里既当预览图也是 `og:image` |
| OG 位图 | 分享卡的**位图**版：`/play/:id/og.png` · `/u/:name/og.png` · `/daily/og.png` 把上面那张 1200×630 SVG 栅格化成 PNG（微信 / X 只认位图，SVG 的 `og:image` 在那边不显示）；`src/og.js` 与 `src/search.js` 同一套路数——**可配置 + 可回退 + 绝不抛错**：Express 线用本机 Chrome / Edge 无头截图（`CHROME_PATH` / `EDGE_PATH` 可覆盖），Worker 线必须显式走 Browser Rendering 端点（`CLOUDFLARE_BROWSER_RENDERING_URL` / `BROWSER_RENDERING_TOKEN`），两条线找不到浏览器或没配端点都**原样回退 `/card.svg`**，失败计数进 `stats()`，路由永不 500；成功时 `image/png` + `Cache-Control: public, max-age=300` |
| PWA | 可安装 + **真离线**：`public/manifest.webmanifest`（standalone、4 张图标、两个快捷方式进游戏库与每日挑战）与自写 `public/sw.js`。清单 `public/precache.json` 由 `pnpm gen:precache` 扫仓库生成（35 个条目 ≈ 884 KB：离线壳、20 款游戏页、6 个 `/static/js`、样式、4 张图标与 manifest），SW 在 install 时**逐条**缓存（单条失败不清空整批），导航对已预缓存页面 cache-first + 后台再验证——所以**断网能直接打开任意游戏页**，静态资源 stale-while-revalidate，`/api` `/auth` `/account` `/admin` `/u` `/login` `/register` `/logout` 与非 GET 一律直连网络；缓存桶按 `qw-shell-<版本>.<清单版本>` 命名，清单一变自动换桶。改过 `public/`、`games/*/index.html` 或图标后要重跑 `pnpm gen:precache`（`pnpm test:pwa` 里的 `--check` 会拦住忘了跑的情况），`pnpm gen:sw` 把 sw.js 同步进 Worker 侧的内联副本；图标由 `pnpm gen:icons` 生成；Express 与 Workers 两条线都提供 `/manifest.webmanifest`、`/sw.js` 与 `/precache.json`，注册只在 https 或 localhost 下进行；带 `data-offline` 的表单（打卡 / 补做 / 发帖 / 回复）断网时由 `public/js/offline-wire.js` 收进 `public/js/offline-queue.js` 的 IndexedDB 队列、联网后自动补传，在线时照旧直接提交（只在 `navigator.onLine === false` 时接管，拿不到 IndexedDB 就退回原生表单） |
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

打开 <http://localhost:3000>。首次启动会自动建表、灌入 4 个分类 + 20 款游戏，并创建默认站长账号。

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

想接邮件服务商的退信 / 投诉回调：设 `MAIL_WEBHOOK_SECRET=...`，把它配到服务商的 webhook 地址 `POST <站点>/webhooks/mail-bounce`（查询串 `?token=` 与 `Authorization: Bearer` 两种写法都认）——命中就记 `bounced` 并把地址写进**抑制名单**，之后 `enqueue` 直接拒收回 `{ suppressed: true }`；名单与送达率在 `/admin/mail` 看，也能在那手工加 / 解。

想开浏览器推送：`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（不写主题默认 `mailto:admin@fishport.cn`），生成命令写在 `src/push-core.js` 的文件头注释里。三件套齐了通知中心才出现推送开关（公钥由 `/api/push/key` 下发，私钥只在服务端）；不配则整条链路空转——`/api/push/key` 回 `configured: false`，页面不显示按钮，也不发任何请求。

想给论坛附件换存储后端：`ATTACH_STORE=local`（默认，落 `data/attachments/`）或 `ATTACH_STORE=s3` 走任意 S3 兼容端点，配 `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`，对外地址用 `S3_PUBLIC_BASE`（或 `ATTACH_PUBLIC_BASE`）、预签 URL 有效期 `S3_URL_TTL`（默认 3600 秒）、路径风格寻址 `S3_PATH_STYLE=1`；缺配置或写了不认识的取值会回落 `local` 并打一行日志（密钥不进日志），Worker 侧同一套配置走 `objectStoreFor(env, cfg)`。图片附件的自动规则与人工复核都在 `/forum/admin/attachments`：「🤖 跑一遍自动规则」只做「拒」，通过与否留给人工（`pending` 不挡展示，`reject` 是软删 + 隐藏且能翻案）。

想让 OG 位图不再现场栅格化：`pnpm gen:og` 会按当前棋谱 / 每日挑战 / 个人主页把 PNG 预生成到 `public/og/` 并写一份清单，服务端命中清单就直接发文件（启动日志里 `[og] 预生成命中 7/7 张`），`OG_PREGEN=0` 关掉、`OG_PREGEN_ROOT` 换目录，`pnpm gen:og --check` 只比对不写（0 一致 / 1 有差异 / 2 缺清单），`pnpm test:og-warm` 是它的验收。产物**不进仓库**（`.gitignore` 里放掉了 `public/og/`）——它随库里的棋谱 / 主页 / 每日题变，本机生成即可；目录缺失 / 清单坏了 / 尺寸不符都静默回落现场渲染，永远不 500。

论坛与主站共用登录态（比如把 `forum.fishport.cn` 指到同一个 Worker）：设 `COOKIE_DOMAIN=.fishport.cn`，cookie 会带上这个 Domain，两个子域登录状态一致；**本机开发不要设**（127.0.0.1 带 Domain 的 cookie 浏览器会丢弃，登录会永远失败）。

第三方登录：配 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 就会在登录页出现对应按钮（回调地址固定是 `<站点>/auth/<provider>/callback`）；`OAUTH_DEV=1` 可以在生产环境里开「演示登录」。

## 目录结构

```
game-site/
├── server.js            Express 入口：安全头、静态目录、页面路由、API、登录守卫
├── package.json         type: module，scripts: start / dev / reset / smoke / check:forum / test:account / test:features / test:gamepad / test:play / test:boards / test:worker / test:worker-play / test:worker-app / test:worker-features / test:mail / test:worker-mail / test:rules / test:cards / test:adapters / test:search / test:worker-search / test:pwa / build:pages / smoke:pages / zip:cf / serve:dist / serve:worker / gen:changelog / gen:seed / gen:icons / gen:precache / gen:sw / index:meili / test:attachments / test:daily / test:elo / test:tags / test:oauth / test:og / test:outbox / test:ratelimit / test:rules-xiangqi / test:rules-chess / test:meili / test:feed / test:replay
├── data/games.db        SQLite 数据库（首次启动自动生成）
├── src/
│   ├── db.js            数据库连接、PRAGMA、建表与索引
│   ├── auth.js          账号：scrypt 口令哈希、会话 cookie、注册校验、默认站长
│   ├── seed.js          分类与游戏的种子数据（node src/seed.js --force 可重置）
│   ├── data.js          所有查询：列表/详情/搜索/评分/收藏/评论/投稿/公告/后台统计
│   ├── views.js         服务端字符串模板：首页/列表/详情/登录注册/收藏/投稿/公告/更新说明/后台/排行榜/账号/每日挑战/个人主页/回放
│   ├── mail.js          发信：Resend 或自定义 HTTP 接口，没配就落「开发发件箱」（outbox）
│   ├── outbox.js        邮件发件箱：外发邮件先落库，失败按指数退避重试、退信可查（与 worker/outbox.js 同名同参）
│   ├── oauth.js         第三方登录：GitHub / Google / 演示登录，授权码 + state 校验
│   ├── pinyin.js        拼音搜索：标题转全拼 + 首字母，匹配与相关度
│   ├── pinyin-data.js   拼音表（由 tools/gen-pinyin.mjs 生成，勿手改）
│   ├── changelog-data.js 更新说明数据（由 tools/gen-changelog.mjs 读 git log 生成，勿手改）
│   ├── data-forum.js    论坛查询：板块 / 主题 / 楼层 / 举报 / 黑名单 / 待审队列 / 禁言 / 一次性令牌
│   ├── forum-guard.js   两线共用的论坛规则：长度与空白清洗、黑名单匹配、新人待审判定、限流参数
│   ├── attachments.js   论坛附件：白名单校验（扩展名 / MIME / 魔数 / 文件名清洗）+ fs / D1 双驱动存储适配层
│   ├── upload.js        投稿单文件 HTML 的校验：扩展名 / 尺寸 / 文本 HTML 三件事（两条线共用同一份规则）
│   ├── multipart.js     手写 multipart/form-data 解析（零依赖，只给 Express 线用；Workers 自带 request.formData()）
│   ├── play.js          两线共用的联机规则：房间码 / 昵称与走法清洗、座位与轮次判定、过期清理、房间公开展示
│   ├── elo.js           联机天梯 Elo 与赛季：起始分 / K 值分档 / 季度赛季（纯函数零 I/O，两条线共用）
│   ├── play-store.js    Express 线联机数据层（房间与走法的同步 SQL 实现）
│   ├── badges.js        成就徽章 / XP / 等级：16 枚徽章的定义与进度判定（纯函数，Express 与 Workers 共用）
│   ├── daily.js         每日挑战的选题与连续天数（纯函数：日期 + 已上架 slug 一起哈希，保证两条线同日同题）
│   ├── social.js        Express 线社交查询：打卡 / 玩家统计 / 徽章与等级 / 个人主页 / 今日榜 / 关注与好友 / 通知 / 私信（同步 SQL 实现）
│   ├── cards.js         分享卡 SVG：棋谱 / 个人主页 / 每日挑战三种 1200×630 卡片（纯函数零外链，两条线共用）
│   ├── og.js            OG 位图适配层：把 cards.js 的 1200×630 SVG 栅格化成 PNG，任何失败都回退 SVG
│   ├── search.js        搜索适配层：内置 LIKE + 拼音后端与 Meilisearch 后端可切换（没配 Meili 就走内置，两条线共用）
│   ├── rank-cache.js    榜单缓存适配层：可对接 Redis 之类的 KV（没配就直算，零强制依赖）
│   ├── ratelimit.js     限流与封禁缓存适配层：滑动窗口 + TTL 封禁缓存，store 可注入（Redis / Cache API）
│   ├── rules/           联机棋类的服务端裁判：四子棋 / 黑白棋 / 国际跳棋 / 五子棋 / 中国象棋 / 国际象棋六款（纯函数，座位 0/1、判和与终局都在这）
│   ├── sites.js         fishport.cn 的站点清单：导航页唯一数据源 + 门户主机判定（三条线共用）
│   ├── push-core.js     Web Push 纯函数层：RFC 8291 `aes128gcm` 加密与 RFC 8188 记录填充、ES256 VAPID JWT，只用 `crypto.subtle`（Node 22 与 Workerd 双跑，两条线共用）
│   ├── push.js          Express 线推送数据层：`push_subs` 建表 / 订阅与退订 / 投递与失效清理（worker/push.js 是「db 第一参数、全程 await」的镜像）
│   ├── rewards.js       打卡奖励：连续 7 / 14 / 30 / 100 天、当月全勤、累计 30 / 100 / 365 次共 8 档（纯函数，两条线共用）
│   └── cover.js         动态生成封面 SVG 与 OG 图 SVG
├── public/
│   ├── css/style.css    全站样式（暗色玻璃拟态，响应式，含播放器与后台表格样式）
│   ├── js/app.js        搜索回填与联想、游玩上报、评分、收藏、评论（分页 / 楼中楼 / 举报）、全屏 / 重开（Express 版）
│   ├── js/app-static.js 静态版前端：列表排序、前端搜索（拼音 / 首字母 / 相关度）、播放器全屏 / 重开
│   ├── js/gamepad.js    手柄 shim：keys 模式合成键盘事件、pointer 模式虚拟光标，除黑洞吞噬（自己轮询）外 19 款共用；扫雷 / 推箱子 / 黑白棋用 dpad 标记 + 自己的 keys 映射
│   ├── js/net-play.js   联机对战小部件：快速匹配 / 房间码 / 复制邀请链接 / 认输 / 再来一局，轮询增量走法、只读观战（六款棋类共用）
│   ├── js/offline-queue.js 离线队列：IndexedDB 存待补传的表单（断网时用，见 public/js/offline-wire.js）
│   ├── js/offline-wire.js  离线兜底接线：接管 form[data-offline]，联网后自动补传
│   ├── manifest.webmanifest  PWA 应用清单（两条线都提供，Worker 侧内联同一份）
│   ├── precache.json    PWA 预缓存清单：35 个 URL + 每个的字节数 + 清单版本（tools/gen-precache.mjs 生成）
│   ├── sw.js            Service Worker：按清单逐条预缓存（离线可直开游戏页）+ 静态资源 SWR，动态路径一律直连网络（Worker 侧内联副本由 tools/gen-sw.mjs 同步）
│   ├── icons/           PWA 图标 4 张（由 tools/gen-icons.mjs 生成）
│   ├── covers/          20 款游戏的静态封面 SVG（由 tools/gen-covers.mjs 生成；卡片 / 排行榜 / 首页 hero 都用它，动态 `/cover/:slug.svg` 只剩 SEO 的 `og:image` 在用）
│   └── og/              OG 位图的预生成产物 + `manifest.json`（由 tools/gen-og.mjs 生成；没有它时现场栅格化）
├── tools/
│   ├── browser-smoke.mjs  无头 Chrome 真实交互冒烟测试（零依赖，pnpm smoke）
│   ├── account-test.mjs   账号系统 58 项断言测试（pnpm test:account，可反复跑）
│   ├── feature-test.mjs   功能 255 项断言：评论分页 / 楼中楼 / 举报、排行榜、拼音搜索、导航页（fishport.cn 门户与 Host 判定）、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除、公告与更新说明、每日挑战（打卡落库 / 榜单 / 连续天数）与个人主页（徽章 / 等级 / 大小写不敏感）、隐私政策与用户协议与注册勾选同意、论坛（游客门槛 / 邮箱验证 / 黑名单 / 蜜罐 / 一次性令牌 / 限流 / 待审 / 编辑留痕 / 举报 / 后台审核与禁言 / 审计日志 / 附件（multipart 发帖、回复、编辑三处调用点））（pnpm test:features）
│   ├── mail-oauth-test.mjs 邮件与第三方登录端到端 42 项：自起假邮件服务端 + 假 OAuth Provider（pnpm test:mail）
│   ├── worker-mail-oauth-test.mjs 同一套场景换成 D1 数据层（pnpm test:worker-mail）
│   ├── build-pages.mjs    静态导出：GitHub Pages / Cloudflare Pages + 构建自检（pnpm build:pages）
│   ├── zip-dist.mjs       把产物目录打成 zip：条目名用 /、中文名带 UTF-8 标志（pnpm zip:cf）
│   ├── serve-dist.mjs     本地预览 dist（模拟子路径部署，pnpm serve:dist）
│   ├── pages-smoke.mjs    静态版无头 Chrome 冒烟 + 截图 + 前端引用断言（pnpm smoke:pages）
│   ├── worker-test.mjs    Cloudflare Worker 离线自测：静态版 26 项 + html_handling 配置守卫（pnpm test:worker）
│   ├── d1-local.mjs       本机 D1 假实现：node:sqlite 冒充 D1（prepare/bind/first/all/run/batch）
│   ├── serve-worker.mjs   本机把 worker/app.js 跑起来（pnpm serve:worker，默认 :4400）
│   ├── worker-app-test.mjs 一条命令跑 Worker + D1 的 58 项账号验收（pnpm test:worker-app）
│   ├── worker-feature-test.mjs 同一份功能用例换成 D1 数据层（pnpm test:worker-features）
│   ├── gen-pinyin.mjs     重新生成 src/pinyin-data.js 的拼音表（--download 取数据源）
│   ├── gen-changelog.mjs  读 git log 重新生成 src/changelog-data.js（pnpm gen:changelog）
│   ├── check-forum-host.mjs 论坛上线检查：主站 /forum 与 forum.fishport.cn 自定义域是否生效（pnpm check:forum，只读）
│   ├── play-api-test.mjs  联机对战接口 67 项断言：建房 / 房间码 / 加入与满员 / 轮次 / 走法增量 / 认输 / 再来一局 / 离开 / 快速匹配 / 限速 / 只读观战（座位 -1、不外泄 token）/ 棋谱回放（落库、增量、非法 id）（pnpm test:play，Express 线与 Worker 线共用同一份）
│   ├── worker-play-test.mjs 同一套联机断言换成 D1 数据层（pnpm test:worker-play）
│   ├── board-games-test.mjs 六款棋类的浏览器验收（共 61 项）：人机模式点棋盘落子且 AI 应手、联机模式双标签页同步走法（pnpm test:boards）
│   ├── gen-seed-data.mjs  由 src/seed.js 重新生成 worker/seed-data.js（pnpm gen:seed，两边种子不再手抄）
│   ├── gen-icons.mjs    生成 public/icons 下 4 张 PNG 图标（png 手写编码，零依赖）
│   ├── gen-precache.mjs 扫仓库生成 public/precache.json 并刷新 public/sw.js 里的生成块（pnpm gen:precache；--check 只比对不写，不一致 exit 1）
│   ├── gen-sw.mjs       把 public/sw.js 同步进 worker/app.js 的内联副本（pnpm gen:sw；--check 只比对，比对前把 CRLF 与结尾空行归一化，免得 Windows 上 core.autocrlf 换来行尾就假报不一致）
│   ├── gen-og.mjs       预生成 OG 位图到 public/og/（pnpm gen:og；--check 只比对不写，0 一致 / 1 有差异 / 2 缺清单。清单是**本地库内容的快照**——棋谱与打卡记录增长后会报「新增条目」，跑一次 pnpm gen:og 跟上即可，不是代码漂移）
│   ├── gen-covers.mjs   重新生成 public/covers 下 20 张封面 SVG（pnpm gen:covers）
│   ├── pwa-test.mjs     PWA 验收（pnpm test:pwa，共 176 项）：自起 :3101 与 :3102 两条线，比对 manifest / sw / 图标 / 预缓存清单与 public/ 逐字节一致、清单里 35 个 URL 都真 200，再无头浏览器里断网（CDP offline）直开两款游戏页核对 window.GAME 与缓存命中
│   ├── gamepad-test.mjs   手柄自测：注入假手柄跑 11 个用例（pnpm test:gamepad）
│   ├── rules-test.mjs     服务端裁判契约回归 29 项：六款棋类的注册表 / 合法与非法走法 / 终局判定 / 同串重放（pnpm test:rules）
│   ├── rules-xiangqi-test.mjs 中国象棋裁判 72 项：马腿 / 象眼 / 九宫 / 炮架 / 照面 / 应将 / 送将 / 将死与困毙 / 120 半步判和（pnpm test:rules-xiangqi）
│   ├── rules-chess-test.mjs 国际象棋裁判 63 项：易位（含七种不成立）/ 吃过路兵 / 升变 / 送王 / 将军与将死逼和 / 50 回合与三次重复与子力不足（pnpm test:rules-chess）
│   ├── cards-test.mjs     分享卡渲染 109 项：三种卡片的尺寸、转义、无外链（pnpm test:cards）
│   ├── adapters-test.mjs  搜索与榜单适配层自测：假 Redis + 假时钟，整轮 1 秒内跑完（pnpm test:adapters）
│   ├── search-fallback-test.mjs 搜索降级集成测试 38 项：起假 Meilisearch（正常 / 500 / 拒连 / 挂住），真跑主后端命中与超时熔断回落（pnpm test:search）
│   ├── worker-search-test.mjs   同上换成直接调 Worker 的 fetch 与 D1 私有库（pnpm test:worker-search）
│   ├── attachments-test.mjs     论坛附件 234 项：校验规则 / fs 与 d1 两驱动（去重 / 认领 / 软删 / 孤儿回收）/ multipart 原始字节 / /ugc/a/:id 响应（pnpm test:attachments）
│   ├── daily-streak-test.mjs    每日挑战 256 项：打卡与连续天数 / 全勤日历 / 补做窗口 / 月度全勤，Express 与 Workers 各跑一遍（pnpm test:daily）
│   ├── elo-test.mjs             天梯 Elo 五段：纯函数与 K 分档 / 真 play-store 结算与榜单 / Express 线端到端 / Workers 线端到端 / 两条线同题同解（pnpm test:elo）
│   ├── forum-tags-test.mjs      主题标签与精华 / 置顶：两条线各跑同一套断言，建表走各自正式入口（pnpm test:tags）
│   ├── replay-search-test.mjs  棋谱检索与导出 275 项（Express 139 + Workers 136）：过滤口径 / 日期闭区间 / 只看我的 / 分页与夹紧 / /replays 页面 / export.json 与响应头 / 导出限流（pnpm test:replay）
│   ├── oauth-gateway-test.mjs   第三方登录：直连格式 / 微信扫码 / 网关模式往返 / 签名与重放拒绝 / profile 归一（pnpm test:oauth）
│   ├── og-detect.mjs            本机浏览器路径探测：候选表唯一出处是 src/og.js 的 browserCandidates()，没找到 exit 1
│   ├── og-raster-test.mjs       位图 OG 自测：假 spawn / 假 fetch / 假时钟的边界用例，最后一节真机渲染，找不到浏览器记 SKIP（pnpm test:og）
│   ├── outbox-test.mjs          发件箱：入队 / dueList 挑拣 / 指数退避 / 达上限落 failed / markSent 与退信 / stats，两条线都跑（pnpm test:outbox）
│   ├── ratelimit-test.mjs       限流与封禁缓存 66 项：滑动窗口 / LRU 淘汰 / 存储出错退化为纯内存 / forum-guard 频控（pnpm test:ratelimit）
│   ├── mail-report-test.mjs     邮件送达率与抑制名单 114 项（Express 57 + Workers 57）：suppress / unsuppress / isSuppressed / 入队拒收 / deliveryStats 分档（pnpm test:outbox-report）
│   ├── mail-admin-test.mjs      /admin/mail 后台与退信回调 68 项：后台页六区块 / 权限 / 抑制与解除 / 名单挡投递 / 退信与投诉四分支 / 进程内闸门（pnpm test:mail-admin）
│   ├── push-test.mjs            Web Push 129 项：RFC 8291 测试向量 / 头布局与密文长度 / VAPID JWT / 假推送服务 404·410·500·201 / 两条线装配一致性 / 未配置空转（pnpm test:push）
│   ├── daily-reward-test.mjs    打卡奖励 143 项：8 档奖励清单 / 连续与累计的临界值 / 月度全勤与跨月 / 补做与断签口径 / 缺字段降级 / 等级叠加与徽章回归（pnpm test:rewards）
│   ├── replay-identity-test.mjs 棋谱账号级绑定 133 项（两条线各一套）：建房 / 加入 / 匹配落 userId、saveReplay 拷进棋谱、ownerId 过滤、老库自动补列与回退昵称（pnpm test:replay-identity）
│   ├── attachment-store-test.mjs 附件对象存储与图片复核 566 项：SigV4 官方向量 / 本地盘与假 S3（预签 URL 真去 GET）/ 尺寸识别与自动规则 / 审核状态机两条线 / DDL 幂等（pnpm test:attachment-store）
│   ├── offline-queue-test.mjs    离线队列 90 项：假 IndexedDB 跑逻辑 + 真无头 Edge 断网入队与恢复补传（pnpm test:offline-queue）
│   ├── offline-wire-test.mjs     离线接线 33 项：接管条件 / 提示位 / 在线时照旧直提（pnpm test:offline-wire）
│   ├── export-record-test.mjs    棋谱专用格式 242 项：六款棋的 SGF / PGN / tar.gz 逐字比对、坏数据降级、两条线一致（pnpm test:export-records）
│   ├── rewards-ledger-test.mjs   奖励流水 143 项：发放幂等 / 断签与翻月不回落 / 两条线（pnpm test:rewards-ledger）
│   ├── ratelimit-shared-test.mjs 跨实例规则缓存 32 项：共享介质命中 / 规则指纹失效 / 介质出错退化（pnpm test:ratelimit-shared）
│   ├── forum-rules-cache-test.mjs 黑名单规则缓存 19 项：指纹只认 kind / action / pattern，行序无关（pnpm test:forum-rules）
│   ├── cover-test.mjs            静态封面 32 项：20 张 SVG 的尺寸 / 文案 / 零外链（pnpm test:covers）
│   ├── og-warm-test.mjs          OG 预生成与缓存预热验收（pnpm test:og-warm）：命中清单与现场渲染逐字节比对
│   └── push-wiring-test.mjs     Web Push 接线端到端 115 项（pnpm test:push-wiring）：建表 / 三个路由的形状与权限 / 关注触发真推送（假推送服务验 VAPID 头与 aes128gcm 密文）/ 410 删订阅与连败停投 / Workers 线同一套 / 未配 VAPID 时全链路空转
├── worker/index.js      Cloudflare Workers 静态版入口：安全头 / 缓存 / 干净地址 / 404
├── worker/app.js        Workers + D1 完整版入口：路由 / 安全头 / 会话（复用 src/views.js；PWA 的 manifest / Service Worker / 图标在这里内联提供）
├── worker/data.js       D1 版全部查询（异步版 src/data.js）
├── worker/data-forum.js D1 版论坛查询（异步版 src/data-forum.js，SQL 与它一一对应）
├── worker/ratelimit.js D1 版限流与封禁缓存：接口同 src/ratelimit.js，差别是跨实例读写一律 async、共享介质默认 Cache API
├── worker/attachments.js D1 版论坛附件：把 src/attachments.js 的存储层包成 d1 驱动（db 第一参数、全程 await）
├── worker/play-store.js D1 版联机数据层（异步版 src/play-store.js，SQL 与它一一对应）
├── worker/social.js     D1 版社交查询（异步版 src/social.js：打卡 / 统计 / 徽章 / 个人主页 / 今日榜 / 关注 / 通知 / 私信，SQL 与它一一对应）
├── worker/auth.js       D1 版账号：PBKDF2 口令、会话表、默认站长
├── worker/schema.js     建表 + 灌种子 + 站长自举（首次请求时跑，幂等）
├── worker/seed-data.js  4 个分类 / 20 款游戏的种子（由 src/seed.js 生成，`pnpm gen:seed` 重生成）
├── worker/mail.js       D1 版发信：配置从 env 读（RESEND_API_KEY / MAIL_API_URL / MAIL_FROM）
├── worker/outbox.js     D1 版发件箱：与 src/outbox.js 逻辑一致，db 从第一个参数来（DDL 单行、逐条 run）
├── worker/oauth.js      D1 版第三方登录：密钥从 env 读（GITHUB_/GOOGLE_CLIENT_*、OAUTH_DEV，端点可用 OAUTH_<PROVIDER>_*_URL 覆盖）
├── worker/push.js       D1 版推送数据层：与 src/push.js 逻辑一致（db 第一参数、全程 await），VAPID 三件套从 env 读
├── wrangler.toml        Workers 静态版配置：[assets] 指向 dist-cf，绑定名 ASSETS
├── wrangler.d1.toml     Workers + D1 配置：多一个 [[d1_databases]] 绑定 DB
├── migrations/0001_init.sql  D1 建表脚本（由 worker/schema.js 的 DDL 生成）
├── migrations/0002_game_files.sql  投稿上传用的 game_files 表（0001 已在线上 apply 过，所以单开一个）
├── migrations/0003_posts.sql       公告 posts 表 + comments.target 列
├── migrations/0004_forum.sql       论坛 7 张表（不含 users.muted_until / mute_reason 的 ALTER，两条线会幂等补列）
├── migrations/0005_play.sql        联机对战 2 张表：play_rooms / play_moves
├── migrations/0006_social.sql      棋谱回放 / 每日挑战 2 张表：play_replays / daily_results（回放 / 观战 / 打卡都只用服务端可验证的数据）
├── migrations/0007_social_graph.sql 社交图谱 3 张表：follows / notifications / messages（幂等，给已部署的远程 D1 用）
├── migrations/0008_forum_tags.sql  主题标签 thread_tags + forum_threads.featured（精华；置顶 / 锁定是既有的 pinned / locked）
├── migrations/0009_mail_outbox.sql 邮件发件箱 mail_outbox：status / attempts / next_attempt_at / last_error
├── migrations/0010_elo.sql         联机天梯 player_ratings + elo_history 两张表（Elo 结算与赛季）
├── migrations/0011_attachments.sql 论坛附件 attachments + attachments_blob（内容寻址去重，D1 侧实体表）
├── migrations/0012_comments_no_game_fk.sql 摘掉 comments 指向 games 的外键（SQLite 不支持 DROP CONSTRAINT，只能整表重建）
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
| GET | `/nav` | fishport.cn 站点导航；门户主机（`fishport.cn` / `www.fishport.cn` / `nav.fishport.cn`）的**根路径**也走它 |
| POST | `/logout` | 退出登录，清掉会话 |
| GET | `/favorites` | 我的收藏夹（需登录） |
| GET/POST | `/submit` | 投稿表单 / 提交投稿（需登录；上传单文件 `.html`（≤ 512 KB）或填已有地址，成功进待审队列） |
| GET | `/admin` | 站长后台：统计 + 待审投稿 + 游戏管理 + 最新评论（需 admin） |
| POST | `/admin/games/:slug/status` | 上架 / 下架 / 通过 / 拒绝（需 admin） |
| POST | `/admin/comments/:id/status` | 隐藏 / 恢复评论（需 admin） |
| GET | `/rank` | 排行榜（`?kind=today\|week\|month\|all\|rating\|fav\|new`，默认 `today` 今日热玩；取数走 30 秒进程内缓存） |
| GET | `/daily` | 每日挑战：当天题目 + 登录用户的打卡状态 / 连续天数 / 最近 28 天日历（补做过的日子单独标出）+ 当月全勤 + 今日榜 |
| POST | `/daily/makeup` | 补做：表单 `day`，只开放最近两天（含昨天、前天，不含今天；超窗或未来日期回 `?notice=too_late`）；补做记在目标日那一行、`makeup=1`，**不计连续天数、只计总完成数**（需登录） |
| GET | `/u/:name` | 个人主页（用户名或昵称，大小写不敏感）：等级 / XP 进度 / 徽章 / 打卡与连续天数 / 统计 |
| GET | `/replay/:id` | 棋谱回放：用该游戏的播放器按走法复盘，页面还列出同款游戏的其它棋谱 |
| GET | `/ladder` | 联机天梯：六款服务端裁判棋（四子棋 / 黑白棋 / 国际跳棋 / 五子棋 / 中国象棋 / 国际象棋）的 Elo 榜，`?game=<slug>` 切 tab（缺省第一款），赛季按 UTC 自然季度算，榜取前 50 |
| GET | `/replays` | 棋谱列表：只列裁判棋的对局；`?game=<slug>`、`?player=<名字>`（房主或访客，不区分大小写）、`?result=host\|guest\|draw`、`?from=YYYY-MM-DD&to=YYYY-MM-DD`（含当天，按本地时区）、登录后 `?mine=1` 只看我的（按昵称精确匹配）过滤，`?page=` 翻页（每页 20 条）；筛选条件跟着翻页与导出走 |
| POST | `/u/:name/follow` | 关注 / 取关（同一个表单来回切；关注自己 → `?notice=self_follow`，没有这个人 404）（需登录） |
| GET | `/u/:name/followers` · `/following` · `/friends` | 粉丝 / 关注 / 好友（互关）列表（每页 24 条；没有这个人 404） |
| GET | `/notifications` | 通知中心（分页；未读高亮）（需登录） |
| POST | `/notifications/read` | 全部标为已读（表单 `next` 只放行站内路径）（需登录） |
| GET | `/messages` · `/messages/:name` | 私信：会话列表 / 与某人的单会话（需登录） |
| POST | `/messages/:name` | 发一条私信（需登录） |
| GET | `/feed` | 好友动态流（需登录），`?page=` 翻页，每页 20 条 |
| GET/POST | `/account` | 账号中心：改昵称 / 改密码 / 绑定解绑第三方登录（需登录） |
| POST | `/account/email` · `/account/email/resend` | 绑定或换绑邮箱 · 重发验证信 |
| POST | `/account/password` · `/account/unlink` | 改密码（要旧密码）· 解绑第三方账号 |
| GET | `/verify-email` | 点邮件里的链接验证邮箱（`?token=`，24 小时内有效） |
| GET/POST | `/forgot` · `/reset` | 忘密码：申请重置信 · 用 token 设新密码（30 分钟一次性） |
| GET | `/auth/:provider` · `/auth/:provider/callback` | 第三方登录跳转与回调（`github` / `google` / `wechat` / `dev`；微信扫码登录要企业主体 + 微信开放平台认证，没有资质就继续用前两个，或把这一跳交给自建 OAuth 网关） |
| GET | `/admin/preview/:slug` | 后台按详情页形状预览任意状态的游戏（含待审与已下架） |
| GET/POST | `/admin/games/:slug/delete` | 彻底删除一个游戏：GET 是确认页（列出会一起删掉的评论 / 举报 / 评分 / 收藏 / 游玩记录 / 上传文件），POST 真删；还在上架中的会被 400 拒绝 |
| GET | `/ugc/:file` | 投稿上传的单文件 HTML 本体（`/ugc/<slug>.html`）；已上架的谁都能取，待审 / 已下架只有站长能取 |
| GET | `/ugc/a/:id` | 论坛附件文件（两段路径，与上一行的单段 `/ugc/:file` 不冲突）；只有已挂到帖子上的（`active`）才给内容，其余状态一律 404 |
| POST | `/admin/games/batch` | 批量上架 / 下架 / 通过 / 拒绝（`slug` 可重复传多条） |
| POST | `/admin/reports/:id/status` | 处理 / 忽略一条举报（需 admin） |
| POST | `/admin/users/:id/ban` | 封禁 / 解封用户（`banned=1\|0`，可带理由）（需 admin） |
| POST | `/admin/users/:id/verify` | 手动把某个用户标记成邮箱已验证（需 admin） |
| GET/POST | `/admin/posts/new` · `/admin/posts/:slug/edit` | 后台写 / 改公告（需 admin） |
| POST | `/admin/posts/:slug/status` | 发布 / 撤回一条公告（需 admin） |
| GET | `/admin/mail` | 邮件送达率与抑制名单（需 admin）：状态与 tag 分档、TOP 错误、名单增删 |
| POST | `/admin/mail/suppress` · `/admin/mail/unsuppress` | 手工加 / 解邮件抑制地址（需 admin），顺手把队里待发的那封落 `failed` |
| POST | `/webhooks/mail-bounce` | 邮件服务商的退信 / 投诉回调：校验 `MAIL_WEBHOOK_SECRET`，命中就记 `bounced` 并把地址加进抑制名单 |
| GET | `/forum` | 论坛首页：板块导航 + 最新主题 + 搜索（`?q= &tag= &page=`，`tag` 取前 24 字符，游客只见已发布） |
| GET | `/forum/f/:slug` | 板块页（`general` 综合讨论 / `guide` 攻略心得 / `help` 求助答疑 / `meta` 站务反馈） |
| GET | `/forum/t/:id` | 主题详情：楼层列表 + 主题与各楼层的附件列表 + 回复框（`?page=`，`?reply=<楼层 id>` 会带上引用提示）；锁定 / 待审 / 待验证邮箱时回复框换成一行说明 |
| GET/POST | `/forum/new` | 发新帖：GET 是表单（未登录只显示登录提示、不签发令牌），POST 过蜜罐 + 一次性令牌 + 标题 / 正文 / 标签校验后进队列，附件随表单一起传（`enctype=multipart/form-data`，字段名 `files`，可多选，单文件 ≤ 4 MB）（站长直接公开） |
| POST | `/forum/t/:id/reply` | 回复（可带 `parent_id` 做楼中楼；锁定主题只有站长能回） |
| GET/POST | `/forum/post/:id/edit` | 编辑楼层：只有作者本人与站长能进；普通用户改完**重新待审**并留一条 `forum_post_edits` |
| POST | `/forum/report` | 举报主题或回复（`target_type=thread\|post`，同一人同一目标只算一次） |
| GET | `/forum/admin` | 论坛后台：待审主题 / 待审回复 / 待处理举报 / 关键词黑名单 / 被禁言用户（需 admin） |
| POST | `/forum/admin/threads/:id/status` · `/posts/:id/status` | 通过 / 拒绝主题、通过 / 隐藏楼层（下架主题会连首楼一起下架）（需 admin） |
| POST | `/forum/admin/threads/:id/flags` | 置顶 / 取消置顶、锁定 / 解锁、精华 / 取消精华（精华只认 admin 与 mod） |
| POST | `/forum/admin/reports/:id/status` | 处理 / 忽略一条论坛举报（需 admin） |
| POST | `/forum/admin/blacklist` · `/blacklist/:id/delete` | 增删关键词 / 正则黑名单规则（`kind=word\|regex`、`action=reject\|review`）（需 admin） |
| POST | `/forum/admin/users/mute` · `/users/:id/mute` | 按用户名或 id 禁言 / 解禁（`minutes=0` 即解除，最长 365 天）（需 admin） |
| GET | `/forum/admin/attachments` | 附件复核队列：待审 / 已拒两栏 + 存储与队列统计，「🤖 跑一遍自动规则」与逐条通过 / 拒绝都在这一页（需 admin） |
| POST | `/forum/admin/attachments/auto` | 对队里所有待审图片跑一遍自动规则（只拒不放行）（需 admin） |
| POST | `/forum/admin/attachments/:id/review` | 人工复核一条附件：`action=approve` 或 `action=reject` + 可选理由；`reject` 是软删 + 隐藏，通过时能翻案（需 admin） |
| GET | `/covers/<slug>.svg` | 20 款游戏的**静态封面**（`public/covers/`，`pnpm gen:covers` 生成；卡片 / 排行榜小图 / 首页 hero 都用它，缓存 7 天） |
| GET | `/cover/:slug.svg` | 动态封面图（现在只剩 SEO 的 `og:image` 在用） |
| GET | `/play/:id/card.svg` · `/u/:name/card.svg` · `/daily/card.svg` | 分享卡（1200×630 SVG）：棋谱卡 / 徽章墙卡 / 每日挑战卡；页面里既是预览图也是 `og:image`，`image/svg+xml` + `Cache-Control: public, max-age=300` |
| GET | `/play/:id/og.png` · `/u/:name/og.png` · `/daily/og.png` | 同一张卡的**位图**版（微信 / X 只认位图）：把上面的 SVG 栅格化成 PNG，`image/png` + `Cache-Control: public, max-age=300`；本机找不到 Chrome / Edge、或 Worker 侧没配 Browser Rendering 时**原样回退上面的 SVG**，永不 500 |
| GET | `/manifest.webmanifest` | PWA 应用清单（两条线都提供；Worker 侧内联、与 `public/manifest.webmanifest` 逐字节一致） |
| GET | `/sw.js` | Service Worker（`no-cache`，改动立刻生效；`Service-Worker-Allowed: /`，Worker 侧同样内联） |
| GET | `/precache.json` | PWA 预缓存清单（两条线都提供；Service Worker 在 install 时拉取，见 `pnpm gen:precache`） |
| GET | `/icons/icon-192.png` · `/icons/icon-512.png` · `/icons/icon-maskable-512.png` · `/icons/apple-touch-icon-180.png` | PWA 图标（`pnpm gen:icons` 生成） |
| GET | `/sitemap.xml` / `/robots.txt` / `/favicon.ico` | SEO 与图标（robots 屏蔽了 `/admin` `/forum/admin` `/login` `/register` `/favorites` `/submit` `/account` `/forgot` `/reset` `/auth` `/comments/`） |

**API**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/games` | 列表，参数同上；返回 `{ total, limit, offset, items }` |
| GET | `/api/games/:slug` | 单个游戏详情 |
| POST | `/api/games/:slug/play` | 上报一次游玩，30 秒同 IP 去重；已登录时顺带打当天的每日挑战卡，返回 `{ counted, plays, daily }`（`daily` 是打卡成功那天的 `YYYY-MM-DD`，没打卡是空串） |
| POST | `/api/games/:slug/rate` | 评分，**需登录**，body `{"stars": 1..5}`，返回 `{ stars, previous, isNew, rating, count }`；未登录 401、非法星级 400、游戏不存在 404 |
| GET | `/api/me` | 当前登录用户（未登录返回 `{ user: null }`） |
| GET | `/api/notifications/unread` | 通知未读数（未登录 401 `{ok:false,error:"login_required",unread:0}`） |
| GET | `/api/messages/unread` | 私信未读数（同上） |
| GET | `/api/push/key` | 浏览器推送的公钥与订阅状态（未登录也能拿公钥，`subscribed` 恒 false），返回 `{ ok, configured, publicKey, subscribed }` |
| POST | `/api/push/subscribe` | 保存浏览器订阅（**需登录**），body 收 `{ subscription }` 或订阅对象本身，返回 `{ ok, id, error }`；重复订阅同一 endpoint 只更新不新增 |
| POST | `/api/push/unsubscribe` | 退订（**需登录**），带 `endpoint` 退那一条、不带就退这个账号的全部，返回 `{ ok, removed }` |
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
| POST | `/api/play/watch` | 只读观战：body `{ "key": "观战令牌", "since": 0 }`，按增量返回公开走法（座位是 `-1`、响应里没有双方 token）；令牌不对 403 `bad_token`、房间不存在或已过期 404 `not_found` |
| GET | `/api/replays` | 棋谱检索（JSON，公开）：同一套查询参数（`game` / `player` / `result` / `from` / `to` / `mine` / `limit` / `offset`），回 `{ ok, total, count, items }`，`limit` 缺省 200、夹到 1..500，`cache-control: no-store` |
| GET | `/replays/export.json` | 导出棋谱 JSON：与上面同参数，带 `Content-Disposition: attachment; filename=replays-YYYYMMDD.json`；几个导出接口（JSON / SGF / PGN / tar.gz）共用 **60 次 / 60 秒 / IP** 的窗口限流（HTML 页面不占配额），超限 429 `busy` |
| GET | `/replays/export.sgf` · `.pgn` · `.tar.gz` | 棋谱专用格式导出：SGF（五子棋 / 四子棋 / 黑白棋 / 国际跳棋 / 中国象棋）、PGN（国际象棋，SAN 记谱）、tar.gz（混合格式逐局一文件；Workers 侧没有 zlib，那边出未压缩的 tar）；与 `export.json` 共用同一套参数与 60 次 / 60 秒限流，文件名 `replays-YYYYMMDD.<ext>` |
| GET | `/api/replays/:id` | 棋谱原始数据 `{ ok, replay: { game, roomCode, hostName, guestName, result, winner, moveCount, moves: [{ seq, seat, move }], plays, createdAt } }`；id 非法 400 `bad_id`、不存在 404 `not_found`（对局结束时由服务端落库，客户端改不了） |

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

3. 重启服务就会按 slug 自动补齐缺的游戏（种子是幂等的，线上同理，push 后第一次请求就补上）；要全量重灌用 `pnpm reset`，或删掉 `data/games.db` 后重启。刷新页面即可看到。

> 列表页的排序、搜索、标签聚合、sitemap、封面图全部由数据驱动，不需要改模板。
> 也可以直接注册一个账号走 `/submit` 投稿：填完进待审队列，站长在 `/admin` 点「✅ 通过上架」就公开了。

## 手柄支持

20 款自研游戏全部支持游戏手柄（Gamepad API）。除黑洞吞噬外都用同一个零依赖 shim：`public/js/gamepad.js`（黑洞吞噬在页面内自己轮询手柄：摇杆 / 十字键移动、A 冲刺、B 无敌、X 引力爆发、Y 炸弹、Start 暂停）。

游戏页在引入 shim 之前先声明自己的映射：

- 键盘型（2048 / 贪吃蛇 / 俄罗斯方块）：`window.GAMEPAD = { mode: "keys", a: " ", b: "r", start: "p" }` —— shim 合成真的 `keydown` / `keyup` 事件，游戏本体一行都不用改。
- 指针型（记忆翻牌 / 井字棋 / 打地鼠 / 数独 / 五子棋 / 中国象棋 / 国际象棋 / 四子棋 / 国际跳棋 / 连连看 / 成语猜猜 / 宝石三消 / 纸牌接龙）：`window.GAMEPAD = { mode: "pointer" }` —— 屏幕上出现虚拟光标，摇杆或十字键移动，A 键在光标处发一次完整点击（`pointerdown` + `mousedown` + `pointerup` + `mouseup` + `click`，因为打地鼠这类游戏监听的是 `pointerdown` + `closest(".mole")`，只调 `click()` 不会触发）。
- 棋盘型（扫雷 / 推箱子 / 黑白棋）：`window.GAMEPAD = { mode: "dpad" }` —— 这一档只是给游戏自己的标记，shim 仍按键盘型发方向键，游戏自己监听方向键移动光标，再补一份 `keys` 映射（扫雷 A 挖开 / B 插旗 / Start 重开，推箱子 A、B 都是撤销）。

| 按键 | 作用 |
| --- | --- |
| 左摇杆 / 十字键 | 键盘型发方向键；指针型移动虚拟光标（摇杆按住连续移动，十字键默认 150ms 走一步 / 发一次键） |
| A | 键盘型发 `KEY.a`；指针型在光标处点击；棋盘型发它 `keys.a` 映射的键（扫雷是空格 = 挖开）；任何模式下只要屏幕上有可见的「开始 / 再来一局」按钮，就先点它 |
| B | 发 `KEY.b`（默认空；俄罗斯方块映射成 `r` 重开，扫雷映射成 `f` 插旗） |
| Start | 先点当前可见的「开始 / 再来一局」按钮，没有才发 `KEY.start`（俄罗斯方块里映射成 `p` 暂停） |

映射既可以写成 `window.GAMEPAD.keys = { a: " ", start: "p" }`，也可以把 `a` / `b` / `start` / `up` / `down` / `left` / `right` 直接写在顶层，两种都认（`KEY` 的默认值是方向键 + 空格）。

详情页的游戏在 iframe 里，手柄输入只会送到有焦点的那一层：`public/js/app.js` 与 `public/js/app-static.js` 里挂了 helper —— 收到 `gamepadconnected` 或者轮询到 `navigator.getGamepads()` 里出现手柄时，就把焦点交给 `#gameFrame`（只在焦点还在 `body` 或已经在该 iframe 上时才抢，不会打断输入框）。游戏页自身也会 `window.focus()`。

### 自测

```bash
pnpm test:gamepad        # 等价于 node tools/gamepad-test.mjs
```

`tools/gamepad-test.mjs` 用无头 Chrome + CDP 注入一台假手柄（覆盖 `navigator.getGamepads()`，状态挂在 `window.top.__pad` 上，所以父页面调 `window.__pad.set(...)` 就等于在按 iframe 里那台手柄），跑 11 个用例：

- `gamepad-2048` 十字键让棋盘变化
- `gamepad-snake` A 开始 → A 暂停 → A 继续
- `gamepad-tetris` A 开始 → Start 暂停 → Start 继续
- `gamepad-tictactoe` / `gamepad-memory` / `gamepad-whack` 摇杆把光标开到目标上，A 键落子 / 翻牌 / 敲地鼠
- `gamepad-blackhole` 摇杆开动黑洞（它自带手柄轮询，不吃 shim）
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

-- 第六批：棋谱回放 / 观战 / 每日挑战（三样都只用服务端可验证的数据）
play_replays(id PRIMARY KEY AUTOINCREMENT, game, room_code, host_name, guest_name,
      result, move_count, moves /* JSON：每步 { seq, seat, move } */, plays, created_at)
      -- 对局结束时由服务端落库（saveReplay）；回放页与游戏页的 ?replay= 都只读它
daily_results(id PRIMARY KEY AUTOINCREMENT, day, user_id, slug, created_at)
      -- UNIQUE(day, user_id)：一天一人一条，重复提交写不进去，连续天数由它算

-- 第七批：社交图谱（关注 / 站内通知 / 私信）
follows(user_id, followee_id, created_at)
      -- UNIQUE(user_id, followee_id)：双向都建了索引，互关即好友
notifications(id PRIMARY KEY AUTOINCREMENT, user_id, kind, actor_id, target_type,
      target_id, body, read_at, created_at)
      -- kind: reply | mention | follow | message | comment | system；actor_id = 0 是系统
      -- 同一人同一目标 10 分钟内去重、自己给自己不写；read_at 为空即未读
messages(id PRIMARY KEY AUTOINCREMENT, from_id, to_id, body, read_at, created_at)
      -- 一对一会话，body ≤ 1000 字符；read_at 为空即未读

-- 第八批：主题标签与精华（精华是 forum_threads 上新增的 featured 列，见下面「后几批的列变更」）
thread_tags(thread_id, tag)
      -- PRIMARY KEY(thread_id, tag)：一个主题同一个标签只存一行；筛选时 ?tag= 取前 24 字符
      -- 索引只按 tag 一条：进标签页就是「按标签列主题」

-- 第九批：发件箱（外发邮件先落库，失败按指数退避重试，退信可查，见 docs/EMAIL.md）
mail_outbox(id PRIMARY KEY AUTOINCREMENT, to_addr, subject, body_text, tag, status,
      attempts, last_error, next_attempt_at, created_at, updated_at)
      -- status: queued | sent | failed | bounced，默认 queued；attempts 默认 0
      -- 第 n 次失败后等 base * 2^(n-1)（base 默认 60 秒），封顶 6 小时；试满 6 次落 failed
      -- next_attempt_at 写「下次该试的时刻」，取信时按字符串大小挑到期的那些

-- 第十批：联机棋类 Elo（只结算服务端裁判的四款棋；赛季 = UTC 自然季度）
player_ratings(user_id, game, season, rating, games, wins, losses, draws, peak, updated_at)
      -- PRIMARY KEY(user_id, game, season)：一人一游戏一赛季一行，结算走 UPSERT
      -- 起始分 1200、下限 100；peak 是这一行的赛季最高分
      -- 必须恰好这 10 列：少一列多一列都会让 upsert 静默失败
elo_history(id PRIMARY KEY AUTOINCREMENT, room_id, game, season, host_id, guest_id,
      host_delta, guest_delta, host_after, guest_after, result, created_at)
      -- 一局一条流水：双方各加 / 减多少、结算后各多少分
      -- UNIQUE(room_id) 防一局结两次；故意不加 REFERENCES play_rooms(id)——房间被清理后
      -- 也要留着「这局结算过」的凭据

-- 第十一批：论坛附件（内容寻址去重 + 软删，两线各一套存储）
attachments(id PRIMARY KEY AUTOINCREMENT, owner_id, thread_id, post_id, filename, mime,
      bytes, sha256, storage, key, created_at, status)
      -- status: pending（已传未挂帖）→ active（随帖发布）→ deleted（软删，行留着内容可回收）
      -- 同一 sha256 + storage 只留一份实体，多条附件行可以指向同一个 key
      -- owner_id / thread_id / post_id 都不加外键：附件是软删 + 共用实体，删帖不该连带删内容
attachments_blob(id INTEGER PRIMARY KEY AUTOINCREMENT, data_b64 TEXT NOT NULL)
      -- D1 线的内容实体（base64 存一列）；本机 fs 线落 data/attachments/，不建这张表

-- 第十二批：Web Push 订阅（VAPID，见 src/push.js ↔ worker/push.js）
push_subs(id PRIMARY KEY AUTOINCREMENT, user_id, endpoint UNIQUE, p256dh, auth, ua,
      created_at, ok_at, fail_count, disabled)
      -- endpoint 唯一：同一浏览器换账号登录时这条订阅改归新账号，旧账号名下不再有它
      -- 投递 404 / 410 直接删行；连败满 5 次置 disabled=1，之后不再投，只有重新订阅能复活
      -- p256dh / auth 是浏览器给的加密材料（aes128gcm），服务端只存不解析

-- 第十三批：邮件抑制名单（退信 / 投诉 / 硬失败自动进名单，也能在 /admin/mail 手工加）
mail_suppression(address PRIMARY KEY, reason, source, created_at INTEGER)
      -- address 存 trim + 小写，主键天然去重（比对时也按大小写不敏感匹配）
      -- source: bounce | complaint | hardfail | manual；名单上的地址 enqueue 直接拒收
      -- created_at 存毫秒数：名单要按时间倒序翻页，秒级文本时间会同批并列

-- 第十四批：每日挑战奖励流水（「拿到就不掉」的发放凭据，见 src/rewards.js ↔ worker/rewards.js）
user_rewards(id PRIMARY KEY AUTOINCREMENT, user_id, day, tier, kind, amount, title, month,
      need, value, created_at INTEGER)
      -- day 是发放日（日界同 src/daily.js 的 dayKey），month 是达成月（只有「当月全勤」档非空）
      -- title 存**发放时**的称号，是资产：以后改文案 / 改档位都不动已发出的记录
      -- 幂等靠两个唯一索引 + INSERT OR IGNORE：idx_user_rewards_once(user_id, day, tier)
      -- 与 idx_user_rewards_grant(user_id, tier, month)；value 存未夹取的真实进度
      -- 有了流水，断签 / 进度回落 / 翻月都不会再把已拿到手的经验收回去

-- 第十五批：附件图片复核（列走运行期幂等补列，见 src/attachments.js 的 ATTACH_REVIEW_COLUMNS / ATTACH_REVIEW_DDL）
attachments 追加 review_status（pending | approved | rejected）、review_by、review_at、
      review_reason、review_source（auto | manual | classifier）、review_hidden
      -- pending 不挡展示（队列口径看 pending_live）；rejected 是软删 + 隐藏，行与内容都留着
      -- 通过时若 review_hidden=1 就退回 active / pending 并清零——被拒的东西能翻案
      -- 自动规则只拒不放行（判不准一律留 pending），分类器没注入时也只标 pending
```

已建索引：`idx_games_cat`、`idx_games_plays`、`idx_logs_game`、`idx_logs_day`、`idx_ratings_game`、`idx_sessions_user`、`idx_fav_user`、`idx_comments_game`，以及第二批加的 `idx_games_status`、`idx_comments_parent`、`idx_reports_status`、`idx_audit_recent`、`idx_oauth_user`、`idx_reset_user`、`idx_posts_status`，以及第四批论坛的 `idx_threads_forum`、`idx_threads_recent`、`idx_threads_user`、`idx_fposts_thread`、`idx_fposts_user`、`idx_fedits_post`、`idx_freports_status`、`idx_nonces_created`，以及第六批的 `idx_replays_game`（按游戏列棋谱）与 `idx_daily_user`（UNIQUE(day, user_id)），以及第七批的 `idx_follows_user`、`idx_follows_followee`、`idx_notifications_user`、`idx_notifications_unread`、`idx_messages_pair`、`idx_messages_to`（通知与私信都按「某人 + 倒序 id」查，粉丝 / 关注两个方向各一条），以及第八到第十一批的 `idx_thread_tags_tag`（按标签列主题）、`idx_mail_outbox_status`（扫「到点该重试的信」）、`idx_ratings_board`（榜按分数倒序、同分看局数）、`idx_elo_history_room`（UNIQUE(room_id)，一局只结算一次）、`idx_elo_history_season`（赛季流水倒序）、`idx_attachments_post`、`idx_attachments_thread`、`idx_attachments_owner`、`idx_attachments_sha`（按 sha256 + storage 找现成实体去重）、`idx_attachments_gc`（回收没挂上帖的孤儿），以及第十二 / 第十三批的 `idx_push_subs_user`（按用户列可用订阅，`disabled` 一起进索引）、`idx_mail_suppression_created`（抑制名单按时间倒序翻页），以及第十四 / 第十五批的 `idx_user_rewards_once`（UNIQUE(user_id, day, tier)，同一天同一档只发一次）、`idx_user_rewards_grant`（UNIQUE(user_id, tier, month)，当月全勤只发一次）、`idx_user_rewards_user`（按用户倒序列流水）、`idx_user_rewards_day`（按天统计）与 `idx_attach_review`、`idx_attach_review_by`（附件复核队列；名字故意不带 `idx_attachments_` 前缀，好让既有测试继续按前缀数出那 5 条）。
数据库开启了 WAL 与 `foreign_keys=ON`。

**后几批的列变更**：`forum_threads` 加 `featured`（精华，默认 0）——置顶 / 锁定是既有的 `pinned` / `locked`，精华跟它们走同一条审批路由，只是只认 admin 与 mod；`games` 加 `rating_count`（票数，写票后回填，列表排序与 JSON-LD 都读它）；`daily_results` 加 `makeup` 与 `done_day`；`play_replays` 加 `host_user_id` 与 `guest_user_id`（棋局结束时把双方账号写进棋谱，「只看我的」按账号匹配；更早的行这两列是 0，查询时回退按昵称匹配）。
补做**记在目标日那一行**（`makeup=1`，行里的 `day` 是「本该完成的那天」），`done_day` 记服务端实际收到上报的日期；**补做不计连续天数**（连续只喂 `makeup=0` 的那些行）——否则一天补一次就能把连续天数无限续下去，对按时打卡的人不公平；补做照常进总完成数、当月全勤与日历格子。
前两处列跟着建表语句与幂等补列走（Express 线 `src/db.js` 的 `addColumn`、D1 线 `worker/schema.js` 的 `ADD_COLUMNS`）；`daily_results` 这两列是**运行期自愈**补的：`src/social.js` 与 `worker/social.js` 的 `ensureDaily()` 先 `PRAGMA table_info` 查一遍，缺了才 `ALTER TABLE`——那一轮 `src/db.js` 的 `migrate()` 与 `worker/schema.js` 都不许动，走这套幂等补列两边才不会打架。
第十四批的 `user_rewards` 同样是**运行期自愈**的：`src/rewards.js` 带着 `REWARD_LEDGER_DDL` 建表建索引（`ensureLedger()`，`src/db.js` 的 `migrate()` 与 `worker/schema.js` 也各自摊平了同一份常量），第十五批附件那 6 列跟着 `src/db.js` 的 `ATTACH_REVIEW_COLUMNS` / `ATTACH_REVIEW_DDL` 与 `worker/schema.js` 的同名块走；两者都没有单独写进 `migrations/`，两条线都在各自正式入口里幂等补齐。

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
`comments.game_id` 上**没有外键**——它是「通用目标 id」：`target='game'` 存游戏 id、`target='post'` 存公告帖 id（`src/data.js` 的 `addCommentTo`）。早期它被建成 `REFERENCES games(id)`，于是公告帖 id 一旦大于 `games` 表的最大 id，插评论就直接 `FOREIGN KEY constraint failed`，Express 线表现为公告评论一律 500（Worker 线不强制外键，所以没暴露）。
现在老库由 `src/db.js` 末尾的 `rebuildCommentsNoGameFk()` 在 `migrate()` 时修：照 `sqlite_master` 里的原 DDL 复刻一张新表、摘掉指向 `games` 的那条外键，拷行、换名、重建索引；`user_id` 指向 `users` 的外键与三个索引都保留，列集合完全按原 DDL、不写死。它只在外键还在时才动手（幂等），D1 侧对应 `migrations/0012_comments_no_game_fk.sql`（SQLite 不能 DROP CONSTRAINT，同样只能整表重建）。
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
- **推送与邮件回调的密钥都只在服务端**：VAPID 私钥只从环境变量读、只参与服务端签名（下发给浏览器的只有 `/api/push/key` 那支公钥），投递头是 `Authorization: vapid t=…,k=…`（JWT 12 小时过期、`aud` 绑端点来源）；退信 / 投诉回调必须带 `MAIL_WEBHOOK_SECRET`（`Authorization: Bearer` 或 `?token=` 两种写法都认，比较走定长的 `timingSafeEqual`），没配密钥一律 403 `not_configured`，配了但不对是 403 `forbidden`——挡掉伪造退信往抑制名单里塞地址。
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

静态版保留：首页、分类、标签、搜索（前端过滤）、列表排序（前端排序）、详情页、iframe 播放器（全屏 / 重开）、20 款游戏本体，以及公告列表 / 公告详情 / 更新说明（都是纯文本页，公告的评论区在静态版不渲染）。
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
- 20 款游戏均在无头 Chrome 中**真实交互**通过（`pnpm smoke`）：2048 合出分数、贪吃蛇可转向移动、俄罗斯方块开始后消行计分、记忆翻牌连配 2 对、打地鼠命中计分、井字棋人机交替落子、黑洞吞噬吃掉天体后质量变大且方向键能开动它、五子棋 / 中国象棋 / 国际象棋真鼠标落子（棋类在加载后先切到联机模式再验入口）。
  新增的 10 款（扫雷 / 数独 / 推箱子 / 连连看 / 成语猜猜 / 四子棋 / 黑白棋 / 国际跳棋 / 宝石三消 / 纸牌接龙）走同一条用例模板：打开时状态码必须真是 200、资源里不许出现别的域名、不许有 4xx/5xx、`window.GAME` 的 `slug` / `state()` / `restart()` 契约必须在、点一次页面上可见的「开始 / 重开」按钮、再在棋盘中心真派发一次 `pointerdown` + `pointerup` 与一次方向键；全程挂 `error` / `unhandledrejection` 监听，有错即失败。扫雷那一次点击真翻开了 40/71 格，所以是真落子不是空转。截图：`docs/screens/game-<slug>.png` 十张。
- 棋类联机另有一套自己的验收 **`pnpm test:boards` 共 61 项全部通过**：六款棋类（五子棋 / 中国象棋 / 国际象棋 / 四子棋 / 黑白棋 / 国际跳棋）各跑两组、每组 10 项——人机模式（无 console 报错、点棋盘能落子、AI 会应手）与联机模式（两个标签页，房主建房拿到 6 位房间码、对手用 `?room=` 自动加入、房主落子后对手棋盘同步），截图 `docs/screens/board-<slug>-{ai,online-host,online-guest}.png` 共 18 张；这一轮还顺手修掉了脚本「跑完不退出」的老毛病（`ChildProcess` 句柄吊住事件循环，`process.on('exit')` 里的 `chrome.kill()` 永不触发）。已知残留：中国象棋联机组在同时压别的浏览器测试时偶发「房主页面还停在等待中、点击全被丢弃」，代码在 [games/xiangqi/index.html:837](games/xiangqi/index.html#L837) 的落子闸门 `st.state === 'playing' && st.myTurn`，属脚本侧对「访客已进对局 ⇒ 房主可落子」的时序假设，未根治。2026-10-20 又在 38 套串行批里复现一次（59 通过 / 2 失败：`点了很多次都没有落子（走子数一直是 0）` 与 `对手的棋盘同步到这一手`），同一条用例单独重跑即 61/0，再次确认是并发负载下的偶发而非回归——排查时先单独复跑，别改断言。
- 页面无 console 报错、无 404 资源。
- 线上四连（无法评论 / 贪吃蛇玩不了 / 无法打星 / 游玩次数不变）的回归断言已固化：
  `pnpm smoke` 的 `game-snake` 会断言「开局有可见的开始按钮 → 点完遮罩消失 → 运行中按空格标题变`已暂停` → 恢复后继续跑」；
  `pnpm build:pages` 会自检 `static/js/app.js` 必须是动态前端、且每个 HTML 只引 `app-static.js`，并检查 PWA 四件套（`manifest.webmanifest` / `sw.js` / `precache.json` / `icons/*`）与 `index.html` 里的 manifest、apple-touch-icon 链接都随产物导出（少 `precache.json` 说明忘了先跑 `pnpm gen:precache`；写错 exit 1）；
  `pnpm smoke:pages` 会断言静态详情页引的是 `app-static.js`、列表页卡片数与 `data/games.json` 里的游戏数一致（以后加游戏不用再改断言）。
- 账号系统 `pnpm test:account` 共 **58 项断言全部通过**（改造成可以反复跑：注册撞 409 自动改用登录、收藏状态先归零、撞上 10 秒评论限流会等待重发，连跑两次结果一致）：
  游客评分/收藏/评论一律 401、未登录访问 `/submit` 与 `/admin` 跳登录页、
  注册 201 且重名 409 / 非法用户名 400 / 短密码 400、错密码 401 文案统一、
  首评建票、同一人改票票数不涨、非法星数 400、详情页按登录态渲染可点或只读星级、
  收藏来回切换计数正确、`/favorites` 列出收藏、收藏不存在的游戏 404、
  评论空白折叠、空评论 400、超长 400、10 秒内连发 429、
  投稿成功返回编号、非法游戏地址被拒、待审不出现在列表、普通用户改状态 403、
  站长审核上架后出现在列表与详情页、下架后从列表消失、隐藏评论后游客看不到、
  退出后 `/api/me` 归 null、开放重定向被改写成 `/`。
- 静态版 `pnpm smoke:pages` 共 **19 个页面全部通过**（无 console 报错、无资源 404）：
  首页 16 张卡片（热门 / 最新每个区块各 8 张上限）且无投稿入口、列表页按名称排序真的重排、搜索 `?q=2048` 过滤成 1 张卡、标签页、
  详情页确认收藏按钮 / 评论区 / 可点星级 / 游玩次数都不渲染且 iframe 地址带前缀、
  **在详情页 iframe 里按键真的把 2048 从 0 玩到 16 分**、俄罗斯方块本体可玩、黑洞吞噬本体可玩（关掉教学后方向键真把它开动了）、404 页、390x844 手机端无横向溢出，另有新增的排行榜页（今日 / 本周切换）、拼音首字母搜索页（`?q=tcs` 命中的是「贪吃蛇」）与搜索联想下拉、以及新增的隐私政策页与用户协议页（章节数、联系方式 `mailto:` 链接都在），还有公告列表页（条目链到 `/notice/<slug>.html`，空态也有兜底）、有公告时的公告详情页（正文非空、静态版不出评论表单）与更新说明页（46 条提交、类型标签与短哈希、计数与条数一致）。
  截图：`docs/screens/pages-home.png`、`pages-list.png`、`pages-search.png`、`pages-tag.png`、`pages-detail.png`、`pages-play.png`、`pages-game-tetris.png`、`pages-game-blackhole.png`、`pages-404.png`、`pages-mobile.png`、`pages-rank.png`、`pages-rank-week.png`、`pages-search-pinyin.png`、`pages-suggest.png`、`pages-privacy.png`、`pages-terms.png`、`pages-changelog.png`、`pages-notice.png`、`pages-notice-detail.png`。
- Cloudflare 版产物 `pnpm smoke:pages` 同样 **19 个页面全部通过**（`--base=/ --out=dist-cf`），GitHub 版与 Cloudflare 版两份产物分别构建、分别冒烟；这一轮两份产物都带上了 PWA 三件套，head 里无条件输出的 manifest 与 apple-touch-icon 链接不再 404。
- Workers 版 `pnpm test:worker` **26 项断言全部通过**：安全响应头与 `server.js:24-45` 逐字段一致、`/static/*` 7 天 / `/cover/*` 1 天 / `/games/*` 1 小时 / HTML 不缓存的缓存策略、`/games` 与 `/game/2048` 干净地址、`/favicon.ico` 302、非 GET 405、404 带 noindex、路径穿越不外泄、「静态路径不产生任何跳转」（防 `html_handling` 配错导致重定向死循环）、外加 10 个页面（含 `/notice`、`/changelog`）**105 条站内链接全部 200**（游戏、标签与导航变多时这个数字跟着涨）；另有一条断言把 `dist-cf/_headers` 里的 CSP 与代码常量逐字段比对（Pages 静态线的放行策略不会悄悄跟代码走偏）。
- Workers + D1 完整版 `pnpm test:worker-app` **58 项账号断言全部通过**（复用 Express 版同一套 `tools/account-test.mjs`），`pnpm test:worker-play` **76 项联机断言全部通过**，`pnpm test:worker-features` **255 项全部通过**；并用 `pnpm smoke` 对 `http://127.0.0.1:4400` 跑了 **38 项全过**（含 20 款游戏真操作、导航页、后台、收藏、投稿、论坛首页与主题页），无 console 报错、无资源 404；出厂态复核（全新 `data/worker.db`）：首页 16 张「☆ 未评」、`<b>0</b> 次游玩`、详情页「还没有人评分」且无 `aggregateRating`。
- 服务端裁判与社交三件套：`pnpm test:rules` **29 项**全过（黑白棋 64 个局面 / 299 个合法走法逐一对照参考实现），`pnpm test:play`（Express）与 `pnpm test:worker-play`（Workers + D1）各 **76 项**全过——含三条这轮新增的回归断言：客户端乱报的 `result` 不被采信、非法走法 400 `illegal_move` 且不落库、不支持的棋类（军棋 `junqi`——六款联机棋都已注册裁判，样本换成没注册的棋）仍按旧中继行为走；`pnpm test:cards` **109 项**（三种分享卡的尺寸 / 转义 / 零外链：用户名里的空格与 `&` 会被 URI 编码、`hostName` 里的 `<img onerror>` 被转义），`pnpm test:adapters` **146 项**（假 Redis + 假时钟，验证 TTL / 容量上限 / 单飞 / 熔断退避）。
  Express 线的关注 / 通知 / 私信另外用 curl 端到端走过：注册两个账号 → A 关注 B（302 `?notice=followed`，B 的 `/api/notifications/unread` 变 1）→ A 给 B 发私信（B 的 `/api/messages/unread` 变 1）→ B `POST /notifications/read` 后未读归 0、打开会话后私信未读归 0；关注自己 → `?notice=self_follow`，关注不存在的人与给不存在的人发私信都是 404。
- 两套 Workers 产物都在**真实 workerd** 上复验过（`wrangler dev`，wrangler 4.151.0）：静态版逐路径实测无跳转、安全头与缓存头正确；Workers + D1 版逐页面 200、`/favorites` 与 `/admin` 未登录正确 302 到登录，`account-test.mjs` 在真 workerd + 真 D1 语义下 **58 项断言全过**。
  这一步捞出并修掉了两个只有真运行时才暴露的问题：`html_handling` 配成 `auto-trailing-slash` 会让站点陷入 `ERR_TOO_MANY_REDIRECTS`；真实 D1 的 `exec()` 按换行切语句，导致多行建表 SQL 直接 500。细节见两份 Cloudflare 部署文档。
- PWA `pnpm test:pwa` 共 **176 项断言全部通过**（`node tools/pwa-test.mjs` → `PASS 176 · FAIL 0`，4.6s）：Express 与 Workers 两侧的 `/manifest.webmanifest`、`/sw.js`、`/precache.json`、4 张图标都与 `public/` 下的文件**逐字节一致**（Worker 侧是内联的模板串与 base64，防的就是这种漂移——这一轮就是它先抓出「磁盘 sw.js 已改、Worker 内联副本还是旧版」的 5806 B vs 13924 B 漂移），`gen:precache --check` 报「✓ 清单与磁盘一致：35 条 · 883.4 KB」，清单里 35 个 URL 逐个真 200；无头浏览器里 `navigator.serviceWorker.ready` 后有 active worker、scope `/`、`controller=true`，缓存桶 `qw-shell-v1.<清单版本>` / `qw-assets-v1.<清单版本>` 按清单版本建立，**把网络断掉（CDP `offline=true`）后直开 `/games/match3/index.html` 与 `/games/connect4/index.html`：标题、`window.GAME.state()`（19 / 15 个字段）都正常返回、DOM 完整、SW 报 `cached=true`，断网期间 0 个被承诺缓存的资源失败、0 console 报错**，全程 107 个请求零外部域名；图标由 `pnpm gen:icons` 用纯 CSS 几何图形渲染后重编码成 PNG（零字体、零外部图片），注册只在 https 或 localhost 下进行，静态版导出后 `app-static.js` 只在根部署（`BASE === "/"`）时注册 Service Worker。截图 `docs/screens/pwa-home.png`、`pwa-offline.png`、`pwa-offline-games.png`（断网直开游戏页）。
- 后台与账号相关的页面在无头 Chrome 里截图确认过：`docs/screens/login.png`、`register.png`、`submit.png`、`admin.png`、`favorites.png`、`rating.png`。
  手柄自测也会留下 `docs/screens/gamepad-2048.png`、`gamepad-blackhole.png`、`gamepad-tictactoe.png`、`gamepad-memory.png`、`gamepad-whack.png`、`gamepad-detail-iframe.png`（能直接看到虚拟光标和底部的「🎮 手柄已连接」提示）。
- 手柄支持在无头 Chrome 里跑过 `pnpm test:gamepad`：注入一台假手柄（挂在 `window.top.__pad` 上），**11 个用例全过**（2048 / 贪吃蛇 / 俄罗斯方块 / 井字棋 / 记忆翻牌 / 打地鼠 / 黑洞吞噬 / 五子棋 / 中国象棋 / 国际象棋 / 详情页 iframe 自动聚焦并接收手柄输入）；棋类走的是摇杆把虚拟光标开到 `BOARD.sampleClicks()` 给出的格点上按 A（合法着法由页面自己算），静态版导出后游戏页与 `gamepad.js` 都带 `--base` 前缀，冒烟同样通过。
  - **第二批功能 + 投稿上传 + 彻底删除 + 公告与更新说明（评论分页/楼中楼/举报、排行榜、拼音与首字母搜索、账号增强、后台增强、投稿上传单文件 HTML、游戏彻底删除、公告发布/编辑/撤回与公告评论）`pnpm test:features` 共 255 项断言全部通过**（其中论坛一节 70 项、每日挑战与个人主页 22 项），同一套用例换成 D1 数据层再跑 `pnpm test:worker-features` 同样 **255 项全过**（见 `tools/feature-test.mjs`，两套共用一个文件）；其中 1 项专门盯着 `frame-src`（详情页 CSP 必须放行 `http(s)`，否则投稿的外站游戏打不开）；另有 12 项是隐私政策 / 用户协议与注册同意：两页都 200 且写了 Cookie 名、第三方登录与邮件，页脚与 `sitemap.xml` 都收录，注册页带必填的 `name="agree"` 与两份文档的链接，不勾同意 400 且不会偷偷建号，勾了就能注册并直接登录；另有 18 项是投稿上传：文件框 + multipart 表单、上传后进待审、待审对游客 404 而站长能取、响应是 `text/html` + sandbox CSP（不含 `allow-same-origin`）、后台预览与详情页 iframe 都是严格沙箱、超 512 KB / 扩展名不对 / 非文本一律 400、只填地址的老投稿仍可用、站长上架后游客能取到并能直接玩、退回待审后又 404；最后 15 项是「彻底删除」：造一条带文件的投稿并写上评分 / 收藏 / 评论 / 游玩记录，上架中删不掉（400），下架后确认页把 6 项数据量逐一对上，POST 删除 302 回后台、详情页与 `/ugc/` 随即 404、操作日志里留下 `game.delete`；还有 30 项是「公告与更新说明」：后台发一条置顶公告、列表与首页横幅都能看到、详情页游客看到登录引导、两个账号（分开发评论与回复，避开 10 秒限流）把分页与楼中楼跑一遍、举报成功且重复举报只算一次、改公告后前台看到新段落与「最后修改」、撤回后详情 404 而重新发布后评论与回复都还在、操作日志留下 `post.create` / `post.update` / `post.retract`，以及 `/changelog` 与 `sitemap.xml` 的收录。
- **第二轮剩下的功能自测全部 0 失败**：`pnpm test:attachments` **234 项**（校验规则、fs 与 D1 两驱动的去重 / 认领 / 软删 / 孤儿回收、multipart 原始字节、`/ugc/a/:id` 应答）、`pnpm test:daily` **256 项**（打卡连续天数、全勤日历、补做窗口、当月全勤，两条线各跑一遍）、`pnpm test:ratelimit` **66 项**（滑动窗口 / LRU 淘汰 / 存储出错退化为纯内存 / forum-guard 频控）、`pnpm test:search`（`tools/search-fallback-test.mjs`）**38 项**（主后端超时 / 报错回退与熔断）、`pnpm test:worker-search` **73 项**、`pnpm test:feed` **101 项**（Express 53 + Workers 48：四路来源 UNION、按人 + 游戏去重、匿名对局不进流、同刻并列稳定、未登录 302）、`pnpm test:rules-xiangqi` **72 项**与 `pnpm test:rules-chess` **63 项**（两款新裁判的全部规则细节，见上面 tools 树）、`pnpm test:meili` **67 项**（灌索引脚本的参数优先级 / 字段口径 / 幂等覆盖）；同一轮里账号 / 联机 / 功能三套复跑仍是 `pnpm test:worker-app` **58 项**、`pnpm test:worker-play` **76 项**、`pnpm test:features` 与 `pnpm test:worker-features` 各 **255 项**，全部 0 失败。
- **第三轮（浏览器推送 / 邮件后台与补发 / 打卡奖励 / 棋谱账号级绑定）自测全部 0 失败**：`pnpm test:push` **129 项**（RFC 8291 测试向量、记录头布局与密文长度、ES256 VAPID JWT、假推送服务的 404 / 410 / 500 / 201 分支、两条线装配逐条一致、未配 VAPID 空转）、`pnpm test:rewards` **143 项**（8 档奖励清单与连续 / 累计的临界值、月度全勤与跨月、补做不计连续、断签回落、缺字段降级、与徽章等级叠加不冲突）、`pnpm test:replay-identity` **133 项**（建房 / 加入 / 匹配把 userId 落进房间与棋谱、`saveReplay` 拷进 `host_user_id` / `guest_user_id`、`ownerId` 过滤只认账号、老库自动补列后老棋谱仍回退昵称）、`pnpm test:outbox-report` **114 项**（抑制名单增删查、入队拒收、送达率按状态与 tag 分档、TOP 错误）、`pnpm test:mail-admin` **68 项**（`/admin/mail` 后台六个区块、退信与投诉两种回调四个分支、名单真的挡住投递、进程内闸门）、`pnpm test:push-wiring` **115 项**（两条线的 `push_subs` 建表、`/api/push/key|subscribe|unsubscribe` 的形状与未登录 401、关注触发一条真推送并核对 `Authorization: vapid t=…` 与 `aes128gcm` 密文、404/410 删订阅与连败 5 次停投、`endpoint` UNIQUE 与重复订阅只更新、未配 VAPID 时四处全空转，并命中真库零改动）；同一轮里 `pnpm test:outbox` **119 项**、`pnpm test:mail` **42 项**与 `pnpm test:worker-mail` **42 项**复跑仍全过。
- **第四轮（对象存储与图片复核 / 棋谱专用格式导出 / OG 预生成 / 奖励流水 / 跨实例规则缓存 / 离线队列 / 静态封面）自测全部 0 失败**：`pnpm test:attachment-store` **566 项**（SigV4 官方向量、本地盘与假 S3 两驱动、预签 URL 真去 GET、扩展名 + MIME + 体积 + 魔数 + 尺寸的自动规则、审核状态机在 Express 与 Workers 两线上的行为、DDL 幂等与老库补列，全程只碰临时副本、真库零改动）、`pnpm test:export-records` **242 项**（六款棋的 SGF / 国际象棋 PGN / tar.gz 逐字比对，坏数据降级跳过，Express 与 Workers 逐字节一致）、`pnpm test:rewards-ledger` **143 项**（发放幂等、断签与翻月不回落、两条线同一份 DDL）、`pnpm test:ratelimit-shared` **32 项**（共享介质命中、规则指纹失效、介质报错退化成内存）、`pnpm test:forum-rules` **19 项**（指纹只认 kind / action / pattern）、`pnpm test:offline-queue` **90 项** + `pnpm test:offline-wire` **33 项**（断网入队与恢复补传，真无头浏览器验过）、`pnpm test:covers` **32 项**（20 张封面 SVG 的尺寸 / 文案 / 零外链）、`pnpm test:og-warm`（预生成命中与现场渲染逐字节一致）；同一轮里 `pnpm test:push` **129 项**、`pnpm test:push-wiring` **115 项**、`pnpm test:daily` **256 项**、`pnpm test:attachments` **234 项**、`pnpm test:ratelimit` **66 项**复跑仍全过，`pnpm test:pwa` 的断网用例在重跑 `pnpm gen:precache` + `pnpm gen:sw` 之后照旧全过。
- **棋谱检索与导出（第九批）**：`pnpm test:replay` **275 项** 0 失败（Express 139 + Workers 136）——数据层旧签名 / 无参行为与改前逐项一致、`game` / `player` / `result` / 日期闭区间 / `mine` 各口径条数与 `total`、分页不重叠与参数夹紧、`/replays` 页面表单与空态（未登录不出「只看我的」）、`/api/replays` 与 `/replays/export.json` 的形状 / 两个响应头 / 当天日期文件名、以及 60 次 / 60 秒 / IP 的导出限流（HTML 页面不占配额）在两线上各跑一遍；改动后 `pnpm test:boards` **61 项**、`pnpm test:play` 与 `pnpm test:worker-play` 各 **76 项** 仍是 0 失败，`pnpm test:pwa` 的断网用例在重跑 `gen:precache` 之后照旧全过。
- 下面几套自测只列覆盖面（项数脚本自己会打印，这里不抄）：`pnpm test:elo`（纯函数 K 分档 → 真 play-store 结算与榜单 → Express 端到端 → Workers 端到端 → 两线同题同解）、`pnpm test:tags`（主题标签与精华 / 置顶，两条线跑同一套断言）、`pnpm test:oauth`（直连 Provider 的请求格式、微信扫码、自建网关往返、签名与重放被拒、profile 归一）、`pnpm test:og`（假 spawn / 假 fetch / 假时钟的边界用例，末节才真机渲染，找不到浏览器记 SKIP）、`pnpm test:outbox`（入队、dueList、指数退避、试满上限落 `failed`、markSent 与退信、stats，两条线各跑一遍）。
- **邮件与第三方登录端到端 `pnpm test:mail` 共 42 项断言全部通过**（脚本自己起一个假邮件服务端与一个假 OAuth Provider，随机端口、不连外网）：绑定邮箱 → 收到验证信（`Authorization: Bearer` 的令牌、收件人、`MAIL_FROM` 发件人逐项核对）→ 点链接变成已验证；`/forgot` → 重置信 → `/reset` 改密 → 新密码能登、旧密码登不上、账号不存在时也是同一套说辞；GitHub 走完授权 → 回调 → 建号 → 换个浏览器再登还是同一个账号（不重复建号）→ 解绑；Google 同样走通，且资料里的邮箱被存下来并当成已验证；`state` 对不上 400、没开启的 provider 404；后台「集成自检」认出邮件走的是自建 HTTP 服务、GitHub / Google 的 client_id 与 secret 都是 ✅、回调地址与站点一致。同一套场景换成 D1 数据层再跑 `pnpm test:worker-mail` 同样 **42 项全过**。
- `pnpm smoke`（Express）**38 项全部通过**（老 28 项 + 新增 10 款游戏各一条真交互用例），含新增的黑洞吞噬（方向键真的把它开动了）、导航页（9 张卡片、分组齐全、都是带 `noopener` 的新窗口外链；线上截图 `docs/screens/nav.png`）与排行榜页（7 个榜单 tab、名次与「新上榜」标记）、搜索联想（首字母 / 全拼 / 中文三条路径）、更新说明页、公告列表与详情、首页公告横幅（点关闭后真的消失且写了 `localStorage`）与 `frame-src` 探针（测试进程自己起一个别的 origin 的小页面塞进 iframe，靠它 `postMessage` 回来证明没被 CSP 拦住——把 CSP 锁回 `'self'` 时这一项确实会红）；`pnpm smoke`（Workers + D1）用同一套用例、同样 38 项全过（`BASE=http://127.0.0.1:4400`）。
> `pnpm smoke` 会用默认管理员真登录一次，并给 2048 留一条评分与一条收藏记录；
  > `pnpm test:account` 会留下 tester1 / tester2 两个账号和一条待审投稿；`pnpm test:features` 会再留下两条测试投稿（其中一条是上传的单文件 HTML，跑完会退回待审）、一条已发布公告（带评论 / 回复 / 举报）与几个测试账号，并且**真删掉它自己造的那条投稿**（日志里因此多一条 `game.delete`）。
  > `pnpm test:mail` / `pnpm test:worker-mail` 会自己起假邮件服务端与假 OAuth Provider（随机端口、不走外网），只往库里写测试账号，跑完不删数据。
  > 两份脚本都按「增量」写断言——评分只看自己那一票、收藏只看总数的变化——所以先跑谁、重复跑几轮结果都一样（同一个库上连跑两遍 account-test 仍是 58/58），前提只是 2048 这个 slug 还在；
  > 论坛那一节还会留下两个论坛测试账号（甲 / 乙）、一条站长主题与若干待审帖，并临时加一条黑名单规则（跑完自己删掉）、禁言再解禁一次；这些都不影响重复运行。
  > 跑完想干净就按上面「彻底回到出厂状态」删库重启。

- **论坛（带审核与安全措施）**：`pnpm test:features` 里 70 项断言一次跑完两条线——游客只能看已发布内容、未登录发帖跳登录、未验证邮箱不给表单、黑名单命中直接拒绝、蜜罐字段命中判机器人、伪造 / 过期令牌被拒、新人主题与回复进待审（游客看不到、作者自己看得到、列表页没有）、连发主题 60 秒 / 连发回复 20 秒被限流、带附件的 multipart 发帖 / 回复 / 编辑（`/forum/new` 与 `/forum/t/:id/reply`、`/forum/post/:id/edit` 三处调用点都必须拿 `formOf(req)` 解析后的字段判令牌——直接读 `req.body` 时它是 `express.raw` 给的 Buffer，`form_token` 恒为空、一律 `err=stale`），以及置顶 / 锁定用完复原（不往论坛首页堆测试主题）、举报与重复举报、站长在 `/forum/admin` 通过 / 置顶 / 锁定、编辑后重新待审（首楼一改整个主题退回待审）、禁言后拿着有效令牌也发不出、`minutes=0` 解除禁言、黑名单增删，以及 `forum.*` 全部写进审计日志。
- **线上实测（`forum.fishport.cn` 自定义域）**：主站与论坛主机两侧共 **18 项全过、1 项 skipped**（`skipped` = 需要账号才能验证的「共用登录态」）。论坛主机根路径就是论坛首页、页面链接是相对根路径的 `/f/…`、`/forum` 与 `/static` 照旧可访问、后台 302 到登录；两个子域都在发 `Domain=.fishport.cn` 的会话 cookie（用 `POST /logout` 的清 cookie 响应验证，不需要登录），所以跨子域共用登录态是生效的。第三方登录的回调地址随当前域名变化，脚本会把 GitHub / Google 该登记的 4 条地址打印出来。
- **论坛上线检查脚本 `pnpm check:forum`**（只读）：主站侧查 9 项（板块与发帖入口、游客不发令牌、板块页、404、后台 302、robots、sitemap），论坛主机侧查根路径重写、链接基址、`/forum` 与 `/static`、登录页与后台 302；自定义域没加时那一侧标 `skip` 并提示去哪加；带 `FORUM_USER` / `FORUM_PASS` 时再加两项——`sid` 是否带 `Domain=`、拿论坛主机的 cookie 访问主站 `/api/me` 是不是同一账号。
- **导航页（`/nav` 与 `fishport.cn` 门户）**：`pnpm test:features` 里 11 项断言在 Express 与 Workers + D1 两条线上各跑一遍——清单里 9 个子域都出外链、卡片数与说明数对得上、`send` / `rsend` / `mc` 不出现在任何链接里、`/sitemap.xml` 收录 `/nav`。门户主机的判定用裸 `node:http` 发带自定义 `Host` 的真实请求验证（`fetch` 会丢掉 Host 头，验不了）：`Host: fishport.cn` / `www.fishport.cn` / `nav.fishport.cn` 的 `/` 直接是导航页，`Host: game-site.fishport.cn` 的 `/` 仍是游戏站首页，论坛主机的 `/nav` 也能拿到（`/nav` 与 `/privacy` 一样进了 `FORUM_SHARED`，否则会被重写成 `/forum/nav` 而 404——这条就是测试先抓出来的）。`tools/browser-smoke.mjs` 新增 `nav` 目标，在无头 Chrome 里核对卡片都是带 `noopener` 的新窗口外链、分组齐全、无 console 报错。**线上实测（2026-10-19）**：`fishport.cn` 与 `www.fishport.cn` 两个自定义域都已生效——两个根路径渲染的是同一页导航（HTTP 200、无 console 报错、无失败请求、9 张卡片分组齐全，截图 `docs/screens/nav-apex-fishport-cn.png` 桌面 1280×1184 与 `docs/screens/nav-apex-mobile.png` 手机 414）。
- **论坛的两种访问形态都实测过**：本机用 `curl -H 'Host: forum.fishport.cn'`（`tools/serve-worker.mjs` 按 Host 拼 URL，等价于真域名）验证论坛主机的 `/` 会走成论坛首页、`/f/general` 200、`/static` 照样出静态资源、主站访问不受影响；设了 `COOKIE_DOMAIN` 时注册响应里确实带 `Domain=.fishport.cn`。

## 后续可做

- 排行榜现在是「SQLite 实时算 + 30 秒进程内缓存」（`src/rank-cache.js`：TTL + 容量上限 + 单飞 + 显式失效）：量再大就换 Redis 的 `ZINCRBY` / `ZREVRANGE`，适配器接缝（`redisLikeAdapter`）已经留好，`/rank` 这一层不用改、只换数据源——接真 Redis 得引入一个客户端依赖，仓库目前是零依赖，所以只做到「进程内缓存 + 可注入的远程适配器」。
- 搜索已经能换 Meilisearch：`src/search.js` 是「主后端 + 兜底 + 熔断」适配层，设了 `MEILI_HOST` 就走 Meili、超时或报错自动退回 LIKE + 拼音（结果带 `source: 'fallback'`，页面照常 200）。真要用起来先把游戏灌进 Meili 索引：`tools/meili-index.mjs` 就是那一步（`node tools/meili-index.mjs --settings` 先配可搜 / 可筛字段，`--dry-run` 预览，`--batch=N` 分批，字段口径 title > subtitle > tags > category > pinyin > description，slug 作 primaryKey 所以重复跑是幂等覆盖，`pnpm test:meili` 67 项覆盖参数与降级），兜底的 LIKE + 拼音表仍覆盖 `U+4E00..U+9FFF`。
- 微信登录需要企业主体 + 微信开放平台认证（约 300 元/年）与审核，个人主体申请不到；`wechat` 这一跳的代码已经写好（`src/oauth.js` 的 `PROVIDERS` 含 `github` / `google` / `wechat`），有资质时填 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 就能用，没资质可以继续用前两条，或把这一跳交给有资质的自建网关。再加 Provider 只需往 `META` 里填一组地址（端点还能用 `OAUTH_<PROVIDER>_AUTHORIZE_URL` / `_TOKEN_URL` / `_USER_URL` 单独覆盖）。
- 邮件支持 Resend 或自建 HTTP 发信接口（`MAIL_API_URL` + `MAIL_API_KEY`），发件箱也已经做了（外发先落库、失败按指数退避重试、试满 6 次落 `failed`、退信记 `bounced`，见 `migrations/0009_mail_outbox.sql`）；这一轮把后半段补齐了：**投递循环**（Express 常驻定时器 / Workers 机会式 `mailRetryTick`，`MAIL_TICK_MS` 默认 60 秒、`MAIL_TICK=0` 关）、**退信与投诉回调**（`POST /webhooks/mail-bounce` 校验 `MAIL_WEBHOOK_SECRET`，命中记 `bounced` 并把地址写进 `mail_suppression`，之后 `enqueue` 直接拒收回 `{ suppressed: true }`）、**抑制名单**（连续硬失败自动进名单，也能在 `/admin/mail` 手工加 / 解）与**送达率后台**（按状态 / 按 tag / TOP 错误分档）。真要再说剩下，就是真实发信域的 SPF / DKIM / DMARC，以及打开 / 点击这类只有服务商才有的指标。
- 自建 OAuth 网关已经做了：设了 `OAUTH_GATEWAY_URL` 之后站点只跟网关说话，第三方密钥留在网关侧，跳转用 HMAC-SHA256 + 时间戳防重放，接口约定与最小网关示例见 [docs/OAUTH.md](docs/OAUTH.md)；授权 / 令牌 / 用户资料端点仍可用 `OAUTH_<PROVIDER>_*_URL` 单独覆盖。余量在网关那一侧——`docs/OAUTH.md` 给的是最小实现，密钥托管、限流与监控得自己补。
- 论坛的频控与封禁缓存换成了 `src/ratelimit.js`：`createLimiter` 是滑动窗口（默认进程内 Map + LRU，可注入 `store` 换成 Redis / Cache API，Worker 侧默认就用 `caches.default`），`createBanCache` 管封禁 / 黑名单的 TTL 缓存与失效广播；要换 Cloudflare 的 Rate Limiting 或 Redis 计数器只需换一个 store，调用点不动。
- 论坛的 @提醒与站内通知已经做了（`@用户名` 落 `mention` 通知，回复主题 / 回帖 / 被关注 / 游戏被评论各有类型与 10 分钟去重）；主题标签与精华、附件上传这一轮也做了（单文件 ≤ 4 MB，扩展名 + MIME + 魔数校验，sha256 内容寻址去重，fs / D1 两套驱动——D1 单值上限约 1 MB，所以那边另有 256 KB 的天花板）；这一轮把这两项补齐了：附件存储能切**对象存储**（`ATTACH_STORE=s3` + 预签 URL，缺配置回落本地盘）并且多了**图片两步复核**（自动规则只拒 + 站长人工通过 / 拒绝，`reject` 是软删 + 隐藏且能翻案），黑名单 / 频控规则换成了**跨实例共享缓存**（`createRuleCache` + 规则指纹 `rulesFingerprint`：介质默认 Worker 的 Cache API、可注入 Redis 同形客户端，规则一改指纹就换键、天然失效；介质报错永久退化成每实例内存并只打一行 `[ban-cache]` 日志）。余量只剩「真有多机部署时把介质换成 Redis」——接缝就在 `redisLikeAdapter` 上。
- 联机棋类的服务端裁判已经**六款全覆盖**（四子棋 / 黑白棋 / 国际跳棋 / 五子棋 / 中国象棋 / 国际象棋走 `src/rules/`：非法走法拒绝、胜负由引擎判、客户端声明的 `result` 不采信；中国象棋的走法码 `x1,y1-x2,y2`、国际象棋用 UCI 式 `e2e4`，各自逐字对齐客户端中继的编码），Elo / 天梯 / 赛季也跟着做了（`/ladder` 六个 tab，赛季按 UTC 自然季度分）；余量在权威房间本身——现在仍是客户端算规则、服务端复核，走法靠轮询同步，要真权威得上 Durable Objects（顺带把观战从轮询换成 WebSocket / SSE）。
- 棋谱列表页 `/replays`（按游戏过滤 + 翻页，每页 20 条）与分享图（SVG 与 PNG 两条都出）已经做了，这一轮补上了按玩家 / 结果 / 日期区间检索、`?mine=1`「只看我的」与 JSON 导出（`/api/replays` + `/replays/export.json`，60 次 / 分钟 / IP 限流、单次 ≤ 500 条）；这一轮又把「只看我的」做成了**账号级绑定**：`play_rooms` 与 `play_replays` 都加了 `host_user_id` / `guest_user_id`（建房 / 加入 / 快速匹配时落库，对局结束拷进棋谱），老库打开时自动补列，更早的棋谱这两列是 0 所以仍回退按昵称匹配。SGF / PGN 与导出任务化这一轮也做了：`src/record-export.js` 按棋种做坐标与手数映射（五子棋 / 四子棋 / 黑白棋 / 国际跳棋 / 中国象棋出 SGF，国际象棋出 SAN 记谱的 PGN），多局能打成 tar.gz（Workers 侧没有 zlib，那边出未压缩 tar），导出走**任务化**的 `createExportJob` / `runExportJob`（游标 + 分批 + 可续跑，`progressOf` 出百分比），坏数据逐条跳过并计数、不整包失败。余量在超大库的**后台异步打包**：现在仍是请求内跑完，靠 60 次 / 分钟 / IP 限流兜底。
- 成就徽章 16 枚的分享卡已经能做（`src/cards.js` 出 1200×630 SVG，`/u/:name/card.svg` 等三条路由），只认位图的微信 / X 也有位图版了（`/play/:id/og.png` 等三条，`src/og.js` 把同一张 SVG 栅格化成 PNG，出不来就原样回退 SVG）；这一轮补上了**预生成 / 缓存预热**：`pnpm gen:og` 把棋谱 / 每日挑战 / 个人主页三种位图落到 `public/og/` 并写一份清单，服务端命中清单就直接发文件（`OG_PREGEN=0` 关、`OG_PREGEN_ROOT` 换目录、`pnpm gen:og --check` 只比对不写、`pnpm test:og-warm` 验收），目录缺失 / 清单坏了 / 尺寸不符都静默回落现场栅格化。余量只剩真机：没在真实微信 / X 里抓过预览（本机没外网出口），Workers 侧也仍是「得配 Browser Rendering 端点、否则回退 SVG」。
- 每日挑战是一天一道固定题，补做与当月全勤这一轮做了（补做只放开最近两天、不计连续天数只计总完成数，全勤只算已经过去的日子）；这一轮把**实质奖励**也做了：`src/rewards.js` 8 档（连续 7 / 14 / 30 / 100 天、当月全勤、累计 30 / 100 / 365 次），给经验与称号，与徽章等级是两套能叠加的口径（`rewardLevelOf` 一步出总经验），`/daily` 与个人主页都出进度条。这一轮补上了 `user_rewards` **发放流水**：达成即落一行（`day` 发放日、`month` 达成月、`title` 存发放时的称号——是资产），幂等靠 `UNIQUE(user_id, day, tier)` + `INSERT OR IGNORE`，所以断签、进度回落、翻月都不会再把已拿到的经验收回去；`/daily` 的「🏆 奖励流水」面板直接读 `ledgerSummary`（项数 / 经验 / 称号墙 / 每档次数与最近一次），它与页面顶部那份实时快照对不上是正常的——一个会变，一个只增。
- 个人主页、关注与好友、私信都已经有了，好友动态流（`/feed`，「关注的人最近在玩什么」）这一轮也做了——四路来源（在玩 / 评论 / 发帖 / 打卡）合并后按人 + 游戏去重；这一轮把主动推送补上了：Web Push 全链路——`push_subs` 存订阅、`src/push-core.js` 做 RFC 8291 `aes128gcm` 加密与 ES256 VAPID 签名（纯函数、Node 与 Workerd 双跑）、`src/push.js` ↔ `worker/push.js` 管投递与失效清理，`notify()` 写完站内通知就顺手推一条，通知中心里一键开关；没配 `VAPID_*` 时整条链路空转。余量在真机：iOS 要先「添加到主屏幕」才收得到，各家浏览器的通知样式与限流也只能在真设备上验。
- PWA 已经从「只缓存壳」升级成真离线：35 条预缓存清单含 20 款游戏页，断网能直接打开任意游戏页（`pnpm test:pwa` 用 CDP 断网实测）；推送（Web Push）这一轮做了：Service Worker 里加了 `push` 与 `notificationclick` 两个事件，载荷固定 `{ title, body, url, tag, kind }`，点通知跳站内深链（`/forum/t/:id`、`/game/:slug`、`/u/:name`、`/daily`、`/notifications`）；**后台同步也做了**：`public/js/offline-queue.js` 是 IndexedDB 队列、`public/js/offline-wire.js` 是接线层，给表单加一个 `data-offline="打卡"` 就归它管（打卡 / 补做 / 发帖 / 回复四处已经接上）——断网时先入队、联网后按原表单补传（带去重键），在线时完全不插手，拿不到 IndexedDB（隐私模式）就退回原生表单。余量是更狠的「离线投稿大文件」：附件是大 body，存不下时仍会失败。
- 图片素材这一轮做了：`public/covers/` 下 20 张静态封面 SVG（`pnpm gen:covers` 生成、`pnpm test:covers` 32 项验收），首页 hero、排行榜小图与游戏卡片全换成它（`/covers/*` 缓存 7 天），原来的动态 `/cover/:slug.svg` 只剩 SEO 的 `og:image` 在用；爬虫要的预生成也补了（`pnpm gen:og` + `public/og/` 清单，见上一条）。剩下的仍是**视频**：玩法演示视频还没有；真实微信 / X 的预览也没抓过（本机没外网出口）。
