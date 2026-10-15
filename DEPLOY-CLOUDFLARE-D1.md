# 部署到 Cloudflare Workers + D1（完整版：账号 / 评分 / 评论 / 收藏 / 投稿 / 后台）

纯静态版（`worker/index.js`）只能浏览和玩游戏；这一份用 `worker/app.js` + **D1**（Cloudflare 的托管 SQLite）
把 Express 版的服务端能力整体搬到边缘：注册登录、评分、评论、收藏、投稿、管理后台、游玩次数统计全都在。

> 我在本机把整条链路跑通了（57 项账号验收 + 14 个页面的浏览器冒烟），但**没有外网、没有 Cloudflare 凭证**，
> 所以最后那几条 `wrangler` 命令需要你在自己机器上执行。下面每条都写清了预期输出。

## 一、两个版本的区别

| | 静态版 | **D1 完整版** |
|---|---|---|
| 入口 | `worker/index.js` | `worker/app.js` |
| 配置 | `wrangler.toml` | `wrangler.d1.toml` |
| 数据 | 无 | Cloudflare D1 |
| 功能 | 浏览 / 搜索 / 玩游戏 | 以上全部 **+ 账号 / 评分 / 评论 / 收藏 / 投稿 / 后台** |
| 部署 | `npx wrangler deploy` | `npx wrangler deploy --config wrangler.d1.toml` |

两者 Worker 名字不同（`game-site` / `game-site-d1`），可以同时存在，互不覆盖。

## 二、先构建静态产物（每次改内容都要重做）

```bash
node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名 --out=dist-cf
```

- `--base=/`：Worker 部署在根路径（GitHub 项目站才需要 `/仓库名/`）。
- `--origin=`：写进 canonical / og / JSON-LD / sitemap.xml 的绝对地址。**绑定自定义域名后必须换成真实域名重新构建**，否则搜索结果里全是错的 URL。
- `dist-cf/` 里既是被预渲染的页面，也是游戏本体（`dist-cf/games/<slug>/`）和 CSS/JS（`dist-cf/static/`）的来源，所以必须先构建再部署。

## 三、路线 A：wrangler 命令行（推荐）

```bash
npm i -g wrangler          # 或全程用 npx wrangler
wrangler login
wrangler d1 create game-site-db
#   ↑ 输出里有一行 database_id = "xxxx-xxxx-..."，把它填进 wrangler.d1.toml
wrangler d1 migrations apply game-site-db --remote   # 建表（本地预览用 --local）
wrangler deploy --config wrangler.d1.toml
```

部署成功会打印 `https://game-site-d1.<账号>.workers.dev`。**第一次打开这个地址时**，Worker 会自动：

1. 建表（`CREATE TABLE IF NOT EXISTS`，和 `migrations/0001_init.sql` 一致，就算忘了 apply 迁移也能跑）；
2. 灌种子数据：4 个分类 + 6 款游戏（2048 / 贪吃蛇 / 记忆翻牌 / 打地鼠 / 井字棋 / 俄罗斯方块）；
3. 创建站长账号 `admin` / `admin123`（可被环境变量覆盖）。

### 先改掉默认密码（重要）

`ensureAdmin()` 只在站长**不存在**时创建，所以部署前设好、或用 `wrangler secret` 设完再删掉那行重建：

```bash
wrangler secret put ADMIN_USER    # 输入你的站长用户名
wrangler secret put ADMIN_PASS    # 输入一个强密码
# 如果 admin/admin123 已经建出来了，删掉它再访问一次站点即可用新密码重建：
wrangler d1 execute game-site-db --remote --command "DELETE FROM users WHERE username='admin'"
```

### 绑定自定义域名

控制台 → Workers & Pages → 该 Worker → Settings → Domains & Routes → Add custom domain。
绑定后**重新构建并重新部署**（`--origin=https://新域名`），否则页面里的绝对链接还是 workers.dev。

## 四、路线 B：Git 集成（控制台连仓库，push 即部署）

适合「以后改内容不想每次在自己电脑上 build + deploy」的场景。代价：构建跑在 Cloudflare 的机器上，失败信息要去控制台看；`database_id` 这类东西要么提交进仓库，要么配进面板。

### 1. 先把仓库推上 GitHub

本机的 git 在 `D:\CODE\git\cmd\git.exe`（v2.55.0，只是没进 PATH，用全路径调用、或把它的 `cmd` 目录加进 PATH 即可）；本地仓库已经初始化好了（`D:\CODE\game-site\.git`，`main` 分支，当前提交 `ee99992`）。注意这台机器**只连得通 GitHub**（`gitlab.com` 的 443 超时），而且 git 访问 GitHub 建议先 `git config --global http.version HTTP/1.1`（默认路径要 35 秒，换成 HTTP/1.1 后 4~7 秒）。仓库根放哪儿都行，但记住两点：

- 仓库根如果是整个 `D:\CODE` 目录（里面还有别的东西），面板里的 **Root directory** 要填 `game-site`；
- 仓库里已经有 `.gitignore`，会挡掉 `node_modules/`、`dist/`、`dist-cf/`、`data/*.db`、`.wrangler/`、`.dev.vars`。构建命令会在云端重新生成 `dist-cf/`，产物不用提交；`.dev.vars` 里通常放着管理员口令，**绝不能提交**。

### 2. 建 D1 库，把 id 写进配置

```bash
npx wrangler d1 create game-site-db      # 输出里的 database_id 填进 wrangler.d1.toml 的 database_id 一行
```

本机连不上 Cloudflare 的 API 时（拿不到 `wrangler login` 的浏览器授权），也可以完全在控制台建库：
**Workers & Pages → D1 SQL database → Create database** → 名字填 `game-site-db` → 建好后在详情页复制 **Database ID**（一串 UUID），填进 `wrangler.d1.toml`。

`wrangler.d1.toml` 是要提交的，里面用的是真实 `database_id`（它不是密钥，公开没有风险）。不想把 id 写进仓库，就把 `[[d1_databases]]` 删掉、改在面板里手动加绑定（Binding 名必须是 `DB`）；但**推荐写进配置**——面板绑定和配置文件不一致时以面板的产物设置为准，很容易出现「部署成功却报 503」。

### 3. 面板里连仓库

Workers & Pages → **Create application** → 选 **Workers** → 连接 Git 仓库（这个入口在不同时间点叫过 `Connect to Git` / `Import a repository`，以你看到的面板为准）→ 授权 GitHub → 选仓库和**生产分支**（一般是 `main`）。

### 4. 填构建与部署设置

| 设置项 | 值 |
|---|---|
| Root directory | 留空（本仓库根目录就是本站；只有把本站塞进一个更大的仓库时，才填 `game-site`） |
| Build command | `node tools/build-pages.mjs --cf --base=/ --origin=https://game-site-d1.<账号>.workers.dev --out=dist-cf` |
| Deploy command | `npx wrangler deploy --config wrangler.d1.toml` |
| 环境变量 | `NODE_VERSION=22` |
| 环境变量（可选） | `SITE_ORIGIN=https://你的域名`（想固定 canonical / og / JSON-LD 的域名时用；也可以靠 build 的 `--origin`） |

绑了自定义域名之后，把 Build command 里的 `--origin` 换成真实域名（或干脆删掉 `--origin`、改用 `SITE_ORIGIN`），再 push 一次即可。

> **已经有静态版在线上（同一个域名），想原地换成完整版**：
> 1. 让 `wrangler.d1.toml` 的 `name` 与静态版一致（本仓库静态版是 `game-site`，见 `wrangler.toml:9`，D1 配置里已经这么写了）；
> 2. 把 Deploy command 从 `npx wrangler deploy` 改成 `npx wrangler deploy --config wrangler.d1.toml`；
> 3. 填好 `database_id` 后 push —— 同一个 Worker 名，所以 `game-site.fishport.cn` 与 `*.workers.dev` 地址不变，只是内容从静态站变成带账号/评分/评论/后台的完整版。
>
> 想让两个版本并存：把 `name` 改回 `game-site-d1`（会新建一个 Worker），部署完再在 Settings → Domains & Routes 里把域名挪过去、旧 Worker 删掉。

> **Build command 千万别留空**：`dist-cf/` 被 `.gitignore` 挡着、仓库里没有这个目录，不跑构建命令的话 deploy 会直接报
> `The directory specified by the "assets.directory" field in your configuration file does not exist: /opt/buildhome/repo/dist-cf`。
> 判断方法：构建日志里如果没有 Build 步骤、`pnpm install` 之后直接 `Executing user deploy command`，就是漏填了。

### 5. 建表（两种做法任选）

- **在面板外跑一次**（最省事，也最不容易撞权限问题）：本机执行 `npx wrangler d1 migrations apply game-site-db --remote`；
- **挂在构建里**：Build command 改成 `node tools/build-pages.mjs --cf --base=/ --out=dist-cf && npx wrangler d1 migrations apply game-site-db --remote`，每次构建都跑一遍。D1 的迁移有记录表，重复执行是空操作。

> 就算这两步都忘了，站点第一次被访问时 Worker 也会自己 `CREATE TABLE IF NOT EXISTS` 并灌种子数据。所以「部署成功但页面报 503」基本只会是 `DB` 绑定没生效，而不是没建表。

### 6. 首次部署之后

1. 打开 `https://game-site-d1.<账号>.workers.dev`：首页 6 款游戏、游玩次数 0 就对了；
2. 立刻改站长口令：面板里加 `ADMIN_USER` / `ADMIN_PASS` 环境变量（或 `npx wrangler secret put ADMIN_PASS`），然后**删掉默认站长让新口令生效**——执行一句 SQL `DELETE FROM users WHERE username='admin'`（命令写法见路线 A），再访问一次站点；
3. 非生产分支（比如 PR）默认也会触发构建并给一个预览 URL；不需要就在面板里关掉，或只保留生产分支。

### 7. 这条路线我没法在本机验证的部分

面板里的确切字段名与步骤会随 Cloudflare 改版变化；`npx wrangler deploy --config` 在 Workers Builds 的构建环境里是否被允许（它等价于默认的 `npx wrangler deploy` 多一个 `--config`，我倾向于可以），以及构建环境里跑 D1 迁移的权限，都需要你第一次部署时看构建日志确认（面板里该 Worker 的 Builds 页）。

## 五、路线 C：CI（GitHub Actions）

```yaml
- run: node tools/build-pages.mjs --cf --base=/ --origin=https://你的域名 --out=dist-cf
- run: npx wrangler d1 migrations apply game-site-db --remote
- run: npx wrangler deploy --config wrangler.d1.toml
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## 六、数据维护

```bash
wrangler d1 export game-site-db --remote --output backup.sql          # 备份
wrangler d1 execute game-site-db --remote --command "SELECT slug, plays, rating, rating_count FROM games"
# 把站点恢复到出厂态（评分为 0、没有评论/收藏/投稿）
wrangler d1 execute game-site-db --remote --command "DELETE FROM comments; DELETE FROM ratings; DELETE FROM favorites; DELETE FROM play_logs; DELETE FROM games;"
```

表结构见 `migrations/0001_init.sql`，与 `worker/schema.js` 里的 DDL 完全一致（后者是源，前者由它生成）。

## 七、本机怎么验证（不需要 Cloudflare 账号）

```bash
node tools/serve-worker.mjs --reset        # http://127.0.0.1:4400，node:sqlite 冒充 D1
node tools/worker-app-test.mjs             # 一条命令跑 57 项账号验收（自动挑端口、自动建库）
node tools/browser-smoke.mjs               # 另开终端，BASE=http://127.0.0.1:4400
```

- `tools/d1-local.mjs`：用 Node 22 的 `node:sqlite` 实现 D1 的 `prepare/bind/first/all/run/batch/exec`，
  `tools/serve-worker.mjs`：Node http 当壳、把请求交给真正的 `worker/app.js`。
- 本机实测结果：**57 项账号断言全过**（注册/登录/评分/收藏/评论/投稿/后台/开放重定向），
  **14 个页面浏览器冒烟全过**（含 6 款游戏真操作、后台页、收藏页、投稿页），无 console 报错、无资源 404。
- 后来又在**真实 workerd + 真实 D1 语义**下跑了一遍（`wrangler dev -c wrangler.d1.toml`，wrangler 4.151.0，端口 8790）：
  首页 / 列表 / 详情 / 分类 / 标签 / 搜索 / 注册 / 登录 / 404 / sitemap / robots 全部 200，`/favorites`、`/admin` 未登录正确 302 到 `/login?next=…`，
  `BASE=http://127.0.0.1:8790 node tools/account-test.mjs` **57 项断言全过**。这一步捞出两个只在真运行时才暴露的 bug，见第九节。

## 八、本机假实现与真实 D1 的差异（别忽略）

| 项目 | 本机 `tools/d1-local.mjs` | 真实 D1 |
|---|---|---|
| 事务 | `batch()` 用 `BEGIN`/`COMMIT` | D1 的 batch 是隐式事务 |
| 限额 | 无 | 有（库大小、每日读写行数、单次查询复杂度等，**具体数字以 Cloudflare 官网为准**，本机无网络无法核对） |
| 读延迟 | 本地文件，微秒级 | 有读复制延迟 |
| `exec()` | 按换行拆语句逐条执行（对齐真实 D1），多行 DDL 会被切坏 | 一样按换行切 |

### 两个只在真运行时才暴露的 bug（都已修）

1. **`db.exec(多行 DDL)` 在真 D1 上直接失败**。真实 D1 的 `exec()` 是**按换行切语句**再逐条执行的，所以原来 `worker/schema.js` 里 `await db.exec(DDL)`（二十多个跨多行的 `CREATE TABLE`）报：

   ```
   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS categories (: incomplete input: SQLITE_ERROR
   ```

   配合 `run_worker_first = true`，每个请求都会 500。现在 `migrate()` 改成按 `;` 拆开、逐条 `db.prepare(sql).run()`；`tools/d1-local.mjs` 的 `exec()` 也改成同样的按行切分，免得再出现「本地过、线上 500」。
2. **`html_handling` 不是 `none` 会死循环**（浏览器报 `ERR_TOO_MANY_REDIRECTS`）：资源层把 `/index.html`、`/games.html` 这类 `.html` 路径 308 跳回无后缀地址，而 Worker 正是显式去取这些路径的。`wrangler.toml` 与 `wrangler.d1.toml` 都已改成 `html_handling = "none"`，细节见 `DEPLOY-CLOUDFLARE-WORKERS.md` 的「踩坑：打开就 ERR_TOO_MANY_REDIRECTS」。

另外一处**需要你实测的点**：口令哈希用的是 PBKDF2-SHA256、10 万次迭代（`worker/auth.js` 的 `ITERATIONS`），
在低配的 Workers 免费计划里可能撞上单请求 CPU 时间上限（登录 / 注册那一下会很慢或直接 1102）。
用 `wrangler tail` 看日志，如果报 CPU 超限，把 `ITERATIONS` 降到 1 万～5 万重新部署即可（安全性换 CPU）。
Express 版用的是 `scrypt`，Node 侧没有这个限制。

## 九、部署后自查

```bash
curl -sI https://你的域名/                     # 应有 x-content-type-options: nosniff、referrer-policy、permissions-policy
curl -s  https://你的域名/robots.txt           # Worker 动态生成，Cloudflare 上真正生效
curl -s  https://你的域名/sitemap.xml          # 里应是你的真实域名
```

浏览器里依次确认：首页 6 款游戏、游玩次数为 0（种子不灌假数字）、能注册、能评分（一人一票、可改）、
能评论、能收藏、`/submit` 投稿后出现在 `/admin` 的待审核里、站长能上架/下架。

## 十、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面正常但没有登录入口、不能评分 | 请求没进 Worker，被当成纯静态站 | 确认用的是 `--config wrangler.d1.toml`（`main = worker/app.js`）且 `run_worker_first = true` |
| 纯文本 503「这个 Worker 需要 D1」 | 没绑定 DB | `wrangler.d1.toml` 里补 `[[d1_databases]]` 或控制台加绑定 |
| 登录后一刷新又变游客 | Cookie 没写进去 | 必须用 https 域名访问，不要用 IP；确认浏览器没屏蔽第三方 Cookie 扩展 |
| 改了 CSS/JS 不生效 | `/static/*` 缓存 7 天 | 把 `src/views.js` 里两个 `?v=` 的版本号 +1（现为 `?v=4`），重新构建 + 部署 |
| 游玩次数不变、打不了星、发不出评论，页面却看着一切正常 | `dist-cf/static/js/app.js` 被静态版前端顶掉了：Workers/D1 把 `dist-cf/` 当 ASSETS 目录，动态页面加载到的是没有 `/api/...` 逻辑的 `app-static.js` | 重新 `pnpm build:pages`（构建自检会直接拦住）；规则是 `static/js/app.js` = 动态版（来自 `public/js/app.js`）、`app-static.js` = 静态版，静态页面只引后者 |
| `d1 migrations apply` 说找不到迁移 | `migrations_dir` 不对 | 确认是仓库根的 `migrations/`，且 `0001_init.sql` 在里面 |
| `wrangler deploy` 报 assets 目录不存在 | 没构建 | 先跑第二步的 `build-pages` |
| 打开就「重定向次数过多」/ `ERR_TOO_MANY_REDIRECTS` | `html_handling` 不是 `none`，资源层把 `.html` 路径 308 回去了 | 把 `wrangler*.toml` 改回 `html_handling = "none"` 再部署；`node tools/worker-test.mjs` 会拦住这个改错 |
| 每个页面都 500，日志里 `D1_EXEC_ERROR: ... incomplete input` | 用了 `db.exec()` 执行多行 DDL | 逐条 `prepare().run()`（`worker/schema.js` 已改好，不要回退成 `exec`） |
| 游戏 iframe 白屏 | 同上，`/games/xxx/index.html` 被 308 或 404 | 同上：静态资源一律由 Worker 精确取路径 |

## 十一、我没法在本机验证的部分（照实说）

- `wrangler login` / `d1 create` / `d1 migrations apply` / `deploy` 的真实行为；
- `run_worker_first` 在你的 wrangler 版本上是否被识别；
- 真实 Workers 运行时里 PBKDF2 的 CPU 时间、线上响应头与缓存的实际表现；
- D1 的免费额度与限额数字。

已经在本机验证过的：`worker/app.js` 的全部路由与业务逻辑（57 项账号断言，且在真 workerd + 真 D1 语义下复跑通过）、
14 个页面的浏览器渲染与交互、静态资源与安全响应头（23 项断言，见 `tools/worker-test.mjs`）。
