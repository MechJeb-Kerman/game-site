# game-site 還原記錄（2026-10-21）

原目錄 `D:\CODE\game-site` 在 10/20 23:23 前後被清空，只剩一個 0 byte 的 `NUL` 檔與空 `worker\` 資料夾（無 `.git`、無遠端 URL、資源回收桶內無此專案）。
本次還原依「本地仍存在的證據」分成三層，**每一層的來源都不同，請勿混用**。

## 1. 逐字還原（10/20 當天的真實快照）

來源：`D:\CODE\undefined\temp\og-e2e-yucM8N\site`（10/20 14:21 由 E2E 測試建立的整份副本，109 檔 / 2,501,956 B）

已還原：`src\`（34 檔，含 elo/play/play-store/forum 等）、`src\rules\`（7 檔）、`tools\`（63 檔）、`seed.mjs`、`data\games.db`（+ `-shm`/`-wal`）。

這部分是 10/20 的最終版，與當時跑測試的程式碼一致。

## 2. 由 DSH 檔案快照補回（10/17 版，非 10/20 最終版）

來源：`%TEMP%\dsh-workspace-changes-efFivE\captures\`（DSH 編輯前自動留存的内容尋址快照，2026-10-17 22:06）

| 檔案 | 說明 |
| --- | --- |
| `server.js` (44,029 B) | Express 入口，10/17 最大的一份 |
| `package.json` (1,275 B) | 真實的 scripts／`express ^4.22.3`，取代 E2E 的 stub |
| `public\css\style.css` (30,964 B) | 全站樣式，10/17 最新一份 |
| `public\js\app.js` (18,649 B) | 前端互動，10/17 最新一份 |
| `public\js\app-static.js` (11,364 B) | 靜態版（GitHub Pages）前端 |
| `README.md` (54,515 B) | 專案說明 |

## 3. 由同一快照庫取回、但放到 `recovered-archive\`（不參與執行）

`recovered-archive\docs\`：`deploy-github-pages.md`、`deploy-cloudflare-workers.md`、`deploy-cloudflare-workers-d1.md`、`deploy-cloudflare-pages.md`
`recovered-archive\migrations\`：`batch3-posts.sql`、`batch4-forum.sql`（原檔名不明，依內容批次命名）
`recovered-archive\wrangler.toml`

## 仍然缺失（本地已確認無任何副本）

10/20 當天新增、但沒有進入 E2E 副本也沒有進入 10/17 快照的檔案：

- `worker\`：`app.js`、`hot.js`、`schema.js`、`attachments.js`、`data-forum.js`、`ratelimit.js`、`play-store.js`、`social.js`
- `src\hot.js`、`src\seo.js`
- `migrations\0005_play.sql`、`0010_elo.sql`、`0014_play_enhance.sql`、`0023_hot.sql`
- `.github\workflows\ci.yml`、`docs\CI.md`、`docs\ROADMAP-NEXT.md`
- `public\sw.js`、`public\precache.json`、`public\manifest.webmanifest`、`public\icons\*`、`public\covers\*`、`public\og\*`（多由 `tools\gen-sw.mjs` / `gen-icons.mjs` / `gen-covers.mjs` 產生）
- `games\`（上傳的單檔遊戲）、`.tmp-*` 探針檔

### 因此造成的行為差異

- `GET /forum` 目前 404：`src\views.js`、`src\data-forum.js` 仍是 10/20 版（有完整論壇 UI/資料層），但手上的 10/17 `server.js` 沒有論壇路由。
- `/hot`、`/seo` 同理（模組缺失）。
- 首頁、`/games`、`/api/games`、`/rank`、靜態資源皆正常。

## 如何執行

```powershell
cd D:\CODE\game-site
D:\CODE\nodejs\node.exe server.js     # http://localhost:3000
```

- 依賴已裝好：`node_modules\express@4.22.3`（用 `nodejs\node.exe` v26.10.0 + `.tools\npm` 安裝）。
- 這台機器的 `D:\CODE\nodejs` 只有 `node.exe`、沒有 npm；`.tools\npm` 是從 registry 取回 npm 12.2.0 tarball 解開的臨時工具，可保留或刪除（不影響執行）。
- 資料庫 `data\games.db` 首次啟動會補建拼音索引（已跑過一次，20 款遊戲）。

## 驗證結果

- 全部 34 個 `src\*.js` 以 `node --check` 通過語法檢查、`import()` 載入成功。
- 啟動輸出一致：`🎮 趣玩小游戏 已启动 … 游戏 20 款`。
- `GET /` 200（15,716 B）、`/games` 200、`/api/games` 200（5,846 B JSON）、`/rank` 200、`/static/css/style.css` 200、`/static/js/app.js` 200。

## 若仍要完整回到 10/20 狀態

需要 `worker\`、`src\hot.js`、`src\seo.js` 與 `server.js` 的 10/20 版本。本地線索只剩：

- 論壇／熱度／CI 的檔案名稱與路徑（見 `D:\CODE\dsh-home\storages\session_projcache_archive_manager_v2\sessions\*.json`）
- `%TEMP%\dsh-spill-*\...\*-run_code.txt` 內 10/20 的執行紀錄（只含輸出片段，沒有完整檔案）

沒有任何 `github.com` 遠端位址可供 clone；若你有 repo，重新 clone 再覆蓋 `src\` 會是最快的方式。
