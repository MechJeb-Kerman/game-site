# 部署到 GitHub Pages（静态版）

Express 版是有服务端的（登录、评分、评论、后台都靠接口）。GitHub Pages 只能托管纯静态文件，所以这里做了一份**静态导出**：把服务端渲染出来的每个页面预先写成 HTML，把所有根绝对链接（`/game/2048`）改写成带仓库前缀的静态文件（`/仓库名/game/2048.html`），整站变成一堆可以直接丢给任意静态托管的文件。

静态版与 Express 版**共用** `src/views.js`、`src/cover.js`、`public/css/style.css`、`games/`，只是渲染时切到"静态模式"、换一份前端脚本（`public/js/app-static.js`）。改样式两边都会变，改完重跑构建即可。

## 能用的 / 不能用的

| 功能 | 静态版 |
| --- | --- |
| 首页、分类页、标签页、详情页、404 页 | ✅ 构建时全部预渲染 |
| 列表排序（最热 / 最新 / 好评 / 名称） | ✅ 浏览器里就地排序 |
| 搜索 | ✅ 构建时导出全部卡片，输入关键字在前端过滤；**支持拼音全拼与首字母**（`tcs` → 贪吃蛇）并按相关度排序 |
| 排行榜（今日 / 本周 / 本月 / 总榜 / 评分榜 / 收藏榜 / 新游榜） | ✅ 构建时预渲染成 `rank/*.html`（导航里的 `/rank` 落到 `rank/today.html`） |
| iframe 播放器、全屏、重开、新窗口 | ✅ |
| 6 款游戏本体 | ✅ 原样拷贝 |
| 隐私政策 `/privacy`、用户协议 `/terms` | ✅ 纯静态文本，照样导出，页脚每页都有链接、`sitemap.xml` 也收录 |
| 公告 `/notice` 与详情、更新说明 `/changelog` | ✅ 都是纯文本页，照样导出（首页的公告横幅也在，关闭状态写 `localStorage`）；公告的**评论区**不渲染——静态版没有服务端 |
| 评分、评论（分页 / 楼中楼 / 举报）、收藏、登录注册、邮箱验证、找回密码、第三方登录、投稿（含上传单文件 HTML）、站长后台、游玩次数 | ❌ 没有服务端，页面里已隐藏或只读；`/account`、`/forgot`、`/reset`、`/verify-email`、`/auth/*`、`/admin/*` 这些页面静态版根本不产出 |

也就是说：静态版适合**展示 + 玩**，不适合做社区运营。需要账号体系就走 Express 版。

## 一、构建

```bash
# 普通项目仓库（站点地址是 https://用户名.github.io/仓库名/）
node tools/build-pages.mjs --base=/仓库名/ --origin=https://用户名.github.io/仓库名

# 用户主页仓库（仓库名就叫 用户名.github.io，站点在域名根）
node tools/build-pages.mjs --base=/ --origin=https://用户名.github.io
```

两个参数必须和实际部署方式对上，否则必然白屏或 SEO 标签指向别人：

- `--base`：站点挂在哪个子路径下。项目仓库是 `/仓库名/`（前后都要有斜杠），用户主页仓库是 `/`。这是唯一会让"点开就 404"的参数，写错了页面里的 CSS / JS / 图片 / 游戏 iframe 全部找不到。
- `--origin`：canonical、`og:url`、JSON-LD、`sitemap.xml` 里使用的绝对域名。不传会默认成占位域名 `https://YOUR-USER.github.io/...` 并打印提醒。
- `--out`：输出目录，默认 `dist`。也可以用 `--out=docs` 直接输出到仓库的 `docs/`。

构建完成会打印一行汇总，例如：

```
游戏 6 款 / 分类 4 个 / 标签 13 个
文件 64 个，合计 482.2 KB
写入 dist（base=/仓库名/，origin=https://用户名.github.io/仓库名）
```

## 二、本地预览与自测

```bash
node tools/serve-dist.mjs --base=/仓库名/ --port=4173    # 或 pnpm serve:dist -- --base=/仓库名/
node tools/pages-smoke.mjs --base=/仓库名/               # 或 pnpm smoke:pages -- --base=/仓库名/
```

- `serve-dist.mjs` 是个小静态服务器，专门模拟 GitHub Pages 的**子路径**行为：路径要带 `--base` 前缀才认，目录自动补 `index.html`，找不到的文件返回 `dist/404.html` 且状态码是 404。浏览器打开 `http://127.0.0.1:4173/仓库名/` 就是线上效果。
- `pages-smoke.mjs` 用无头 Chrome 真实打开 18 个页面（含隐私政策与用户协议、公告与更新说明）：首页、列表（按名称排序真的重排了）、搜索（真的过滤了卡片）、标签页、详情页、**在详情页的 iframe 里真的按键玩 2048**、直接玩俄罗斯方块、404 页、390x844 手机端（检查横向溢出）。同时检查 console 报错、资源 404、以及"静态版该隐藏的东西（收藏按钮 / 评论区 / 可点星级 / 游玩次数）确实没了"。截图存到 `docs/screens/pages-*.png`，有问题退出码 1。

## 三、发布（三种方式，选一种）

**方式 A：`gh-pages` 分支（推荐，主分支保持干净）**

```bash
cd dist
git init
git add -A
git commit -m "build: pages"
git branch -M gh-pages
git remote add origin git@github.com:用户名/仓库名.git
git push -f origin gh-pages
```

然后仓库 **Settings → Pages → Source** 选 `Deploy from a branch`，分支 `gh-pages`、目录 `/(root)`。

**方式 B：主分支的 `/docs` 目录**

```bash
node tools/build-pages.mjs --base=/仓库名/ --origin=https://用户名.github.io/仓库名 --out=docs
git add docs && git commit -m "build: pages" && git push
```

Settings → Pages → Source 选 `main` / `/docs`。注意 `--out=docs` 会覆盖 `docs/` 下的同名文件（`docs/screens/` 不在输出目录里，不会被动）。

**方式 C：把 `dist/` 交给其它静态托管**

Cloudflare Pages / Netlify / Vercel 直接拖 `dist/` 或连 Git 仓库，构建命令留空、输出目录填 `dist` 即可。这种托管通常挂在域名根，记得用 `--base=/` 重新构建。

## 四、必须知道的几个坑

1. **`.nojekyll` 别删**。GitHub Pages 默认用 Jekyll 处理静态站点，会忽略下划线开头或含特殊字符的文件。构建会在 `dist/` 里放一个空的 `.nojekyll` 来关掉 Jekyll，删了它可能就有文件 404。
2. **中文文件名要 URL 编码**。标签页是 `tag/益智.html`，页面里链接写成 `/仓库名/tag/%E7%9B%8A%E6%99%BA.html`。GitHub Pages 能正常提供，但你自己手写链接时别直接写中文路径。
3. **项目站的 `robots.txt` / `sitemap.xml` 基本是摆设**。`robots.txt` 只对域名根（`https://用户名.github.io/robots.txt`）有效，搜索引擎不会读 `https://用户名.github.io/仓库名/robots.txt`。想让它们真正生效，得绑定自定义域名并用 `--base=/` 部署到根。
4. **自定义域名**。在 Pages 设置里填，或在 `dist/CNAME` 写一行域名——构建**不会**自动生成这个文件，需要你自己放进 `--out` 目录。加完之后要用 `--base=/ --origin=https://你的域名` 重新构建，canonical / sitemap 才是对的。
5. **内容改了一定要重新构建**。静态站的 HTML 是构建那一刻"冻"住的：在 `src/seed.js` 加了游戏、改了 `views.js` 或 `style.css`，都必须重跑 `build-pages` 再 push，否则线上还是旧的。
6. **构建前先决定数据**。静态版导出的就是当时数据库里的内容。想要一个干净的展示站（游玩次数 0、评分"还没有人评分"），先 `node src/seed.js --force` 再构建。
7. **GitHub Pages 有自己的 CDN 缓存**。push 之后一般 1 分钟内生效，没变化就用无痕窗口或加个 query 再看。
8. **宁可是 `/仓库名/` 而不是 `/仓库名`**。`--base` 不带结尾斜杠也能构建（脚本会补），但手动拼链接时很容易漏，建议一开始就写 `/仓库名/`。

## 五、构建产物长什么样

```
dist/
├── .nojekyll                       关掉 Jekyll（别删）
├── index.html                      首页（12 张卡片 = 6 款 × 热门/最新）
├── games.html                      全部游戏（?sort= 排序、?q= 过滤都在前端做）
├── search.html                     搜索页（拼音 / 首字母 / 相关度都在前端算）
├── rank/today.html 等 7 个榜单页     排行榜（today / week / month / all / rating / fav / new）
├── 404.html                         GitHub Pages 会自动拿它当 404 页面
├── favicon.svg
├── robots.txt / sitemap.xml
├── category/<slug>.html            4 个分类页
├── tag/<名称>.html                 13 个标签页（中文文件名）
├── game/<slug>.html                6 个详情页（含 VideoGame 结构化数据）
├── cover/<slug>.svg                封面图
├── static/css/style.css
├── static/js/app.js                内容来自 public/js/app-static.js
├── static/img/og.svg               社交分享图
├── data/games.json                 全量数据（想自己接前端时用；每款游戏多一个 `py` 字段 = 全拼 + 首字母）
└── games/<slug>/index.html         6 个游戏本体（与源文件一致，只多一行 favicon）
```

## 六、和 Express 版的关系

- 页面模板、样式、游戏本体都是同一份源码，只有"渲染模式"和前端脚本不同，不存在两套需要同步的代码。
- 静态版构建时会调用 `setStaticMode(true)`：导航里去掉"投稿"（静态线没有服务端，投稿与上传单文件 HTML 都不导出）、页脚去掉"开放接口"、账号区留空、评分面板换成只读星级加一句说明、收藏按钮与"已玩 N 次"不渲染、整个评论区不渲染。
- 因此**同一个仓库可以同时存在两个版本**：Express 版（`pnpm start`）跑完整功能，静态版（`dist/`）给 GitHub Pages 免服务器展示。
- 第二批功能里能静态化的都静态化了：排行榜 7 个榜单在构建时算好（数据来自 `play_logs`），搜索的拼音 / 首字母 / 相关度改成在浏览器里用 `data/games.json` 的 `py` 字段算；需要服务端的（账号、评论、举报、后台）依旧只在 Express 版和 Workers + D1 版里。

