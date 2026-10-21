# 路线图 · 下一步做什么

> 状态截至 2026-10-21。上一轮（10/20）已经把论坛、每日挑战、在线对战、排行榜、PWA、附件、推送这些大块铺进来了，
> 这一轮补的是**没来得及提交的三件事**：热度榜、SEO 收敛、CI。

## 已落地（本轮）

- **热度榜**（`src/hot.js` + `GET /hot` + `GET /api/hot`）：按今日 ×3、近 3 日 ×1.5、近 7 日 ×1 的窗口播放量加权，叠加评分质量与历史播放对数，
  再乘 90 天半衰期衰减；60 秒进程内缓存；页面走 `views.hotPage`，接口给客户端/第三方用。
- **SEO 收敛**（`src/seo.js`）：`/robots.txt` 与 `/sitemap.xml` 从 server.js 里的硬编码搬到模块，URL 全部 XML 转义、按 loc 去重，
  首页/游戏页的 JSON-LD 也换成 `websiteJsonLd` / `gameJsonLd`，避免两处各写一份。
- **CI**（`.github/workflows/ci.yml` + `docs/CI.md`）：语法检查 → 零依赖单元测试 → 建库 → 真起服务打 18 条关键路由。
- `npm run test:hot`（`tools/hot-test.mjs`）：40 条断言，覆盖打分、趋势、年龄衰减、robots/sitemap 文本与两个 JSON-LD。

## 近期（下一两个迭代）

### 1. 浏览器端 E2E 进 CI
`tools/browser-smoke.mjs`、`tools/pwa-test.mjs` 已经在本地跑得通，缺的是 runner 里的 Chrome。
两条路：`ubuntu-latest` 上装 `google-chrome-stable` + `xvfb`，或者引 `playwright` 只做 CI 专用。
优先覆盖：棋盘拖拽落子、离线队列断网重连、对局回放的每一步时间轴。

### 2. `worker/` 与主站对齐
Cloudflare Workers 版（`worker/app.js`，218 KB）仍是 10/20 的快照，没有 `/hot`、没有新的 sitemap 逻辑。
需要抽一个 `worker/hot.js`（D1 里用窗口聚合 SQL，思路同 `src/hot.js` 的 `countsByWindow`），并补 `test:worker-hot`。

### 3. 静态导出带上热度榜
`build:pages`（`tools/build-pages.mjs`）产出的是纯静态站，目前没有 `/hot` 页面。
导出时把 `hotGames()` 的结果固化进 HTML，并在 `precache.json` 里登记，否则 PWA 离线时这一页 404。

### 4. 锁文件
仓库只有 `pnpm-lock.yaml`，CI 用 `npm install` 现解析。发布前跑一次 `npm install` 提交 `package-lock.json`，
CI 改 `npm ci`，构建才可复现。

## 中期

- **DB 迁移工具**：`src/db.js` 的 `migrate()` 是「一堆 DDL 直接执行」，而 `migrations/` 目录只给 D1 用，两套 schema 已经靠人肉保持同步。
  引入一个轻量版本表（`schema_migrations`）让 `0001…0013` 在 SQLite 侧也按序执行，彻底告别两处手改。
- **限流观测**：`src/ratelimit.js` 的 `createBanCache` 失败会退化成内存（见测试日志），线上应暴露一个 `/admin/ratelimit-stats`。
- **搜索后端**：`meiliBackend` / `sqlBackend` 已有适配层与测试，缺的是后台索引重建的定时任务与失败回退策略。
- **附件审核**：`attachAdminPage` 与 `ATTACH_REVIEW_DDL` 已就位，缺批量审核与过期清理。

## 长期

- 国际化：目前文案全中文硬编码在 `views.js`，抽 `i18n` 字典前先把 `SITE` 常量里的 slogan/联系方式收敛。
- 内容安全：`src/record-export.js` 已能导出评分/评论记录，配合论坛举报链路补一个申诉流。
- 性能：`listGames()` 全量取 100 条再在 JS 里拼计数（`hotGames`），游戏量破千后应改成 SQL 侧 `ORDER BY` + 分页。

## 怎么验收这一轮

```bash
node tools/hot-test.mjs                 # 40 条断言
node src/seed.js --force                # 23 款游戏、39 张表
PORT=3000 node server.js &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/hot        # 200
curl -s http://127.0.0.1:3000/api/hot | head -c 200                       # {"updated":...,"games":[...]}
curl -s http://127.0.0.1:3000/robots.txt | head -3                        # User-agent: *
curl -s http://127.0.0.1:3000/sitemap.xml | head -c 60                    # <?xml ...<urlset
```

注意：`play_logs` 为空时热度榜所有数字都是 0、trend 全是 `flat`，这是**预期行为**——想看真实排名就先玩几把，或 `node tools/seed-play-logs.mjs`（如需，待补）。
