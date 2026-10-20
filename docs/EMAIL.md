# 邮件运营手册：SPF / DKIM / DMARC 与退信重试

这份文档写给「负责把信真正发出去的人」：域名要加哪些 DNS 记录、怎么验证、退信码是什么意思、
发件箱在哪里看、失败的信怎么重试。

代码位置：发信 `src/mail.js`（Express 线）、`worker/mail.js`（Workers 线）；
发件箱 `src/outbox.js` / `worker/outbox.js`；建表 `migrations/0009_mail_outbox.sql`；
自测 `node tools/outbox-test.mjs`。

## 0. 本仓库的邮件是怎么发出去的

`sendMail()` 两条线语义一致，流程是「先落库、再投递、按结果改状态」：

1. 先写持久化发件箱 `mail_outbox`，状态 `queued`（这一步失败只打一行 `[mail:outbox-error]` 日志，不会影响注册 / 找回密码）；
2. 立刻尝试投递一次：
   - 配了传输（`RESEND_API_KEY` 或 `MAIL_API_URL`）→ 真发 HTTP 请求；
   - 没配传输 → 落「开发发件箱」：控制台打印 + 后台 `/admin` 的「📮 开发发件箱」可见（内存里，重启即失，只适合本地预览）；
3. 成功 → `sent`，清空 `last_error`；失败 → `queued` 并按指数退避排下一次，重试用尽 → `failed`。

`sendMail()` 永远不抛异常，只返回 `{ ok, id, queued, error }`：

| 返回 | 含义 | 你该做什么 |
| --- | --- | --- |
| `{ ok:true, id, queued:false, error:'' }` | 已投递（`dev:true` 表示只是落进了开发发件箱，没真发） | 不用管 |
| `{ ok:false, error:'mail_500' }` | 发信接口返回 5xx（我们自己的错误码，不是 SMTP 码，原文在 `last_error`） | 看 `last_error` 里的服务商原文；`queued:true` 说明已自动重试 |
| `{ ok:false, error:'mail_network' }` | 连不上 / 超时 / DNS 挂 | 同上，等自动重试；一直失败说明网络或接口地址不对 |
| `{ ok:false, error:'no_recipient' }` | 收件人为空 | 调用方的问题，没有入队 |

四种状态：`queued`（排队中，`next_attempt_at` 到点可重发）、`sent`（已投递）、
`failed`（重试用尽或明确不重试）、`bounced`（收件方退信 / 明确拒绝，不再重试）。

## 1. DNS 三件套：SPF / DKIM / DMARC

三件套缺一个，收信方就可能把信丢进垃圾箱、甚至直接 550 拒收。**顺序建议：先用一个子域跑通，再动主域。**

### 1.1 用子域发信（强烈建议）

主域（`example.com`）大概率已经有一条 SPF 记录，动它会波及公司其它邮件。
惯例是拿 `send.example.com` 专门发事务邮件，然后把发件人写成 `noreply@send.example.com`：

`~ini
MAIL_FROM=趣玩小游戏 <noreply@send.example.com>
`~

### 1.2 SPF：告诉世界「谁能替我发信」

一条 TXT 记录，**一个域名只能有一条 SPF**（两条会一起失效）：

`~dns
send.example.com.  TXT  "v=spf1 include:amazonses.com ~all"
`~

- `include:` 后面填发信服务商要求的值（Resend 后台给的通常是 `include:amazonses.com`），**以服务商后台原样给的记录为准**，不要自己拼。
- 结尾 `~all`（软失败，建议先用）或 `-all`（硬失败，确认没漏发信源后再用）；别用 `+all`。
- 自建 HTTP 接口发信（`MAIL_API_URL`）时，SPF 要包含真正发出这封信的那台机器的出口 IP 或它的域名。

### 1.3 DKIM：给每封信盖一个可验证的签名

服务商会给你一个选择器（selector，常见 `resend` / `default` / `s1`）和一段公钥：

`~dns
resend._domainkey.send.example.com.  TXT  "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD..."
`~

- `p=` 后面那一长串原样粘贴，别换行、别加空格（超过 255 字符时按服务商给的拆法拆成多段引号）。
- 顺手把服务商要求的**退信 MX** 也加上，退信（bounce）是回到 Return-Path 那个地址的，不加 MX 就收不到退信：

`~dns
send.send.example.com.  MX  10 feedback-smtp.us-east-1.amazonses.com.
`~

### 1.4 DMARC：告诉世界「SPF/DKIM 没过时怎么办」

`~dns
_dmarc.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; adkim=r; aspf=r"
`~

- 上线顺序：先 `p=none`（只收报告不拦截）跑 1~2 周 → 报告干净后改 `p=quarantine` → 最后 `p=reject`。
- `rua=` 收汇总报告的邮箱，建议单独建一个 `dmarc@` 邮箱，别用会被人读的个人邮箱。
- 只想给子域单独定策略时用 `sp=`（例如主域 `p=reject`，`sp=none` 让新子域先观察）。

### 1.5 验证命令（改完记录等 5 分钟到 1 小时）

`dig`（Linux / macOS / WSL / Git Bash）：

`~bash
dig +short TXT send.example.com            # 看 SPF
dig +short TXT resend._domainkey.send.example.com   # 看 DKIM（选择器换成服务商给的那个）
dig +short TXT _dmarc.example.com          # 看 DMARC
dig +short MX  send.send.example.com       # 看退信 MX
`~

`nslookup`（Windows 自带 PowerShell / cmd）：

`~powershell
nslookup -type=TXT send.example.com 1.1.1.1
nslookup -type=TXT resend._domainkey.send.example.com 1.1.1.1
nslookup -type=TXT _dmarc.example.com 1.1.1.1
nslookup -type=MX  send.send.example.com 1.1.1.1
`~

自检要点：

- SPF 那条必须**只有一条** `v=spf1`；`dig` 出来带引号的整串要能一眼读完，且结尾是 `~all` / `-all`。
- DKIM 的 `p=` 与后台给的一模一样（少一个字符签名就不过）；选择器名字要对上。
- DMARC 记录必须挂在 `_dmarc.` 前缀上，挂在主域上无效。
- 服务商后台的「Verify / 验证域名」按钮全绿，再发真信。
- 真发一封到 Gmail / Outlook，点开「显示原始邮件」，看 `Authentication-Results` 里 `spf=pass`、`dkim=pass`、`dmarc=pass`。

## 2. 退信码速查与处理

退信分两类：**4xx 是软退**（临时，等一会儿能好，我们让它自动重试）；
**5xx 是硬退**（永久，重试没意义，应该把地址标成 `bounced` 并从名单里去掉）。

| 退信码 | 含义 | 怎么处理 |
| --- | --- | --- |
| `421 4.7.0` / `450 4.2.0` / `451 4.7.1` | 临时限流 / 灰名单（greylisting） | 软退，自动退避重试即可 |
| `452 4.2.2` | 收件箱满了 | 软退，等用户清理；连续失败就人工联系 |
| `550 5.1.1` | 用户不存在（最常见的硬退） | 硬退：`markBounced(address, reason)` 标掉，别再发 |
| `550 5.7.1` / `550 5.7.26` | 被策略拒收，多半是 SPF/DKIM/DMARC 没配好或 IP 声誉差 | 先查第 1 节的记录与 `Authentication-Results` |
| `552 5.2.2` / `552 5.2.3` | 收件箱超配额 | 软退，隔天再试 |
| `554 5.7.1` / `554 5.7.0` | 被判为垃圾邮件 | 查内容（链接过多、纯图片）与域名信誉；别立刻重发同一封 |
| `535 5.7.8` | SMTP 认证失败（自建接口时） | 检查 `MAIL_API_KEY` / `RESEND_API_KEY` 是否是当前有效的 key |
| `5xx 其它` | 其它永久失败 | 标 `bounced`，把 `last_error` 原文留档 |

我们自己的错误码只有两种，别和 SMTP 码混了：
`mail_<HTTP 状态码>`（发信接口返回非 2xx，例如 `mail_500`、`mail_503`）和 `mail_network`（连不上/超时）。
服务端返回的原文会截断 200 字存进 `last_error`。

收到退信后的动作（当前是手动/代码触发，退信 webhook 自动接线属于后续工作）：

`~js
import { markBounced, bounceSummary } from './src/outbox.js';   // Workers 线：worker/outbox.js，第一个参数传 env.DB
markBounced('user@example.com', '550 5.1.1 user unknown');      // 该地址排队中/失败的信一起标 bounced
console.log(bounceSummary(20));                                  // { count, rows: [...最近 20 条退信] }
`~

## 3. 查看发件箱与重试状态

### 3.1 直接查库（Express 线：`data/games.db`）

`~bash
sqlite3 data/games.db "SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status;"
sqlite3 data/games.db "SELECT id, status, attempts, next_attempt_at, to_addr, subject, substr(last_error,1,60)
                       FROM mail_outbox ORDER BY id DESC LIMIT 20;"
sqlite3 data/games.db "SELECT id, to_addr, attempts, next_attempt_at, last_error FROM mail_outbox
                       WHERE status='queued' AND next_attempt_at <= datetime('now','localtime')
                       ORDER BY next_attempt_at LIMIT 20;"   -- 现在就该重发的信
sqlite3 data/games.db "SELECT id, to_addr, last_error, updated_at FROM mail_outbox WHERE status='bounced' ORDER BY updated_at DESC;"
`~

没有 `sqlite3` 命令的话，用和 `server.js` 同款的 Node 内置 sqlite：

`~bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/games.db');console.log(d.prepare('SELECT status,COUNT(*) n FROM mail_outbox GROUP BY status').all())"
`~

### 3.2 Workers 线（D1 的 `mail_outbox`）

`~bash
npx wrangler d1 execute game-site-db --remote --command "SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status"
npx wrangler d1 execute game-site-db --remote --command "SELECT id, to_addr, attempts, next_attempt_at, last_error FROM mail_outbox WHERE status='queued' ORDER BY next_attempt_at LIMIT 20"
`~

### 3.3 代码里看

`~js
import { stats, dueList, bounceSummary } from './src/outbox.js';
stats();              // { queued, sent, failed, bounced, total }
dueList(Date.now(), 20);   // 到期该发的信（按 next_attempt_at 升序）
bounceSummary(20);         // 退信一览
`~

Workers 线同签名，只是第一个参数传 `env.DB`（`dueList(db, now, limit)` / `markFailed(env, db, id, error)`）。

### 3.4 后台页

没配传输时，`/admin` 的「📮 开发发件箱」列出内存里的最近邮件（只适合本地预览）。
配了传输后请用上面 3.1 / 3.2 的查询，或让后续的后台改版把它接进「集成自检」面板。

## 4. 重试机制

- 第 n 次失败后的等待：`base * 2^(n-1)`，即 60s → 2m → 4m → 8m → 16m → …，**封顶 6 小时**（`RETRY_MAX_MS`）。
- 累计尝试次数达到上限（默认 6）就落 `failed`，不再自动重试；`markFailed(id, err, { retry:false })` 可以立即放弃（例如 4xx 参数错误）。
- 成功那次也算一次 `attempts`；`sent` / `bounced` 的信不会再被 `dueList()` 捞出来。
- **重试循环本身要由后台定时任务驱动**（本项目当前留了接口还没接线）：

`~js
// Express 线：每分钟跑一次；Workers 线用 Cron Trigger 调同样的逻辑（记得 await）
import { dueList, markSent, markFailed } from './src/outbox.js';
import * as mail from './src/mail.js';

export async function retryDue(now = Date.now(), limit = 20) {
  for (const row of dueList(now, limit)) {
    const r = await mail.sendMail({ to: row.to_addr, subject: row.subject, text: row.body_text, tag: row.tag });
    // sendMail 内部会写一条新记录；重试循环要把「老那条」按结果收尾
    if (r.ok) markSent(row.id); else markFailed(row.id, r.error);
  }
}
`~

- 手动催一次某一封（把下次时间改到现在）：

`~bash
sqlite3 data/games.db "UPDATE mail_outbox SET next_attempt_at = datetime('now','localtime') WHERE id = 123;"
`~

- 想清空积压：先导出再删，别直接 `DELETE`（`failed` / `bounced` 是排查证据）：

`~bash
sqlite3 data/games.db "SELECT * FROM mail_outbox WHERE status IN ('failed','bounced')" > bounce-backup.txt
`~

## 5. 环境变量清单

Express 线从 `process.env` 读；Workers 线从 `env`（`wrangler.toml` 的 vars / `wrangler secret put`）读，名字完全一样。
除了下面最后两行是本轮新加的，其余是既有行为，**没有发明新变量**。

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `RESEND_API_KEY` | 走 Resend（`https://api.resend.com/emails`），作为 `Authorization: Bearer` 的值；优先级最高 | 无 |
| `MAIL_API_URL` | 自建 / 第三方 HTTP 发信接口地址，请求体 `{from,to,subject,text,html}` | `https://api.resend.com/emails` |
| `MAIL_API_KEY` | 配了 `MAIL_API_URL` 时用它作 `Authorization: Bearer` 的值 | 无 |
| `MAIL_FROM` | 发件人（`From` 头），例如 `趣玩小游戏 <noreply@send.example.com>` | `站点名 <noreply@example.com>` |
| `MAIL_RETRY_BASE_MS` | **本轮新增**：第一次失败后的等待基数（毫秒），退避按它翻倍 | `60000`（60 秒） |
| `MAIL_MAX_ATTEMPTS` | **本轮新增**：累计尝试次数上限，到了就落 `failed` | `6` |

`RESEND_API_KEY` 与 `MAIL_API_URL` 都不配时，邮件进「开发发件箱」，功能照常能测（不真发信）。
两个变量都配时，`transportName()` 会报 `resend`，实际请求还是发到 `MAIL_API_URL`（`sendMail` 优先用 `MAIL_API_URL`）。

## 6. 自测

`~bash
node tools/outbox-test.mjs          # 发件箱与重试：119 项断言，Express + Workers 两条线，零外网
node tools/mail-oauth-test.mjs      # 既有：邮箱验证 / 找回密码 / 邮件走假 HTTP 端点（42 项）
node tools/worker-mail-oauth-test.mjs
`~

发真信前的最后检查：`stats()` 里 `queued` 不该长期堆积；`failed` / `bounced` 要有人看；
`last_error` 若长期是 `mail_5xx`，先去第 1 节把 SPF/DKIM/DMARC 配齐再说。
