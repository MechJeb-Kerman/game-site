# 第三方登录（OAuth）配置手册

站点支持三种第三方登录：**GitHub**、**Google**、**微信（网站应用扫码）**，另有仅开发环境可用的**演示登录（dev）**。
登录页只显示「已经配好」的入口；后台 **集成自检** 表格（`/admin`）会把每个 Provider 的状态、该设哪些环境变量、回调地址一并列出来，配置时照它抄即可。

回调地址的形状是固定三段拼接，站点自己拼，不需要配：

    <站点地址>/auth/<provider>/callback
    例：https://game.example.com/auth/github/callback
        https://game.example.com/auth/wechat/callback

「站点地址」就是站点启动时的 `SITE_ORIGIN`（反代后面的对外地址）。它同时决定和第三方之间往返的 `redirect_uri`，
所以 **必须和用户在浏览器里看到的域名一致**，否则回调会落到别的域名上、state cookie 对不上。

---

## 1. GitHub

| 项目 | 值 |
| --- | --- |
| 环境变量 | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` |
| 申请位置 | GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App |
| 后台要填 | Application name、Homepage URL（站点地址）、**Authorization callback URL** = `<站点地址>/auth/github/callback` |
| 拿到的 scope | `read:user user:email` |
| 昵称 / 头像 | 有：GitHub 的 `login` 会作为用户名（`username`），`name` 为空时退回 `login` |

邮箱：GitHub 的 `/user` 常常不返回邮箱，站点会再调 `/user/emails` 挑「主邮箱且已验证」的那个；都没有就留空（登录照样成功，只是不会按邮箱和已有账号合并）。

## 2. Google

| 项目 | 值 |
| --- | --- |
| 环境变量 | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| 申请位置 | Google Cloud Console → API 和服务 → 凭据 → 创建凭据 → **OAuth 客户端 ID** → 类型「Web 应用」 |
| 后台要填 | 已获授权的重定向 URI = `<站点地址>/auth/google/callback` |
| 拿到的 scope | `openid email profile` |
| 昵称 / 头像 | 有显示名与头像；**没有平台用户名**，所以 `username` 为空，建号时用 `用户名 || 显示名 || google+uid前6位` 的规则自动生成 |

Google 的授权页固定带 `access_type=online` 与 `prompt=select_account`（每次都让用户挑账号，方便一台机器上多个账号）。

## 3. 微信（网站应用扫码登录）

| 项目 | 值 |
| --- | --- |
| 环境变量 | `WECHAT_APP_ID` / `WECHAT_APP_SECRET` |
| 申请位置 | 微信开放平台 → 管理中心 → **网站应用** → 创建网站应用 |
| 后台要填 | 「授权回调域」= **只填域名**（不带 `https://`、不带路径、不带端口），例如 `game.example.com` |
| 用到的接口 | 授权页 `open.weixin.qq.com/connect/qrconnect`（scope `snsapi_login`），换 token `/sns/oauth2/access_token`，取资料 `/sns/userinfo` |
| 身份标识 | 优先 `unionid`（同一开放平台账号下跨应用稳定），没有则用 `openid`，存成 `wechat:unionid` 或 `wechat:openid` |
| 昵称 / 头像 | 有昵称与头像；**没有用户名**，`username` 为空（同 Google），邮箱为空 |

**资质要求（这是微信最容易卡住的地方）**：微信开放平台的「网站应用」只对**企业/组织主体**开放，需要
① 企业主体注册微信开放平台账号，② 完成开发者资质认证（约 300 元/年），③ 提交网站应用并等审核通过（通常数个工作日）。
个人主体申请不到网站应用，也没有别的正规绕法。

**登录时用户看到什么**：点「微信」→ 跳到微信的二维码页（`qrconnect`）→ 手机微信扫码并在手机上确认 →
浏览器回到 `<站点地址>/auth/wechat/callback` → 建号/登录，账号页显示 `💬 微信` 与存下来的标识。

**没有资质怎么办**：
- 继续用手上的 GitHub / Google；
- 或者把微信这一跳交给**有资质、能出网的自建网关**（下一节）：站点这边只用 `OAUTH_GATEWAY_URL`，
  微信开放平台那边的应用注册在网关运营方名下。注意用户仍会看到二维码页上是「谁在申请登录」（应用的名称与图标），
  这不是技术问题而是资质归属问题，需自行确认合规。

**没配时**：`WECHAT_APP_ID` 或 `WECHAT_APP_SECRET` 缺任意一个，微信入口就不会出现在登录页（`enabledProviders()` 不含 `wechat`），
直接访问 `/auth/wechat` 会得到 404「这个登录方式没有开启」；后台自检表格里会留一行「微信 · 未配置」，
并写明「去设 WECHAT_APP_ID / WECHAT_APP_SECRET」与回调地址。

## 4. 自建 OAuth 网关（`OAUTH_GATEWAY_URL`）

**什么时候需要**：站点部署在受限网络里（出不了外网、或第三方域名被墙/被拦），而另一台机器能出网；
或者想把第三方密钥集中在网关侧，站点只持有一把对称密钥。

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `OAUTH_GATEWAY_URL` | 是 | 网关根地址，例如 `https://gw.example.com`。**配了它才进入网关模式**，末尾斜杠会被自动去掉 |
| `OAUTH_GATEWAY_SECRET` | 强烈建议 | 与网关共用的签名密钥。**不配也能跑，但请求就没有 `x-oauth-signature` 头**，任何能访问网关的人都可以拿别人的 code 去换资料，只适合内网自测 |
| `OAUTH_GATEWAY_PROVIDERS` | 否 | 逗号分隔，指定哪些 Provider 走网关，默认全部（`github,google,wechat`）。写错的名字会被忽略；配了但一个合法名字都没有 = 没有任何 Provider 走网关 |

网关模式下：**站点不需要再配对应 Provider 的直连密钥**（密钥在网关侧），
列进 `OAUTH_GATEWAY_PROVIDERS` 的 Provider 会直接出现在登录页；没列进去的仍按直连规则（要有自己的密钥）。

### 4.1 一次登录的完整往返

    浏览器  → 站点 /auth/github                （站点种下 oauth_state cookie）
    站点    → 302  <网关>/authorize?provider=github&redirect_uri=<站点回调>&state=X
    网关    → 302  GitHub 授权页               （client_id 是网关的，redirect_uri 是**网关自己的回调**）
    用户同意 → GitHub → 302 <网关回调>?code=C&state=X
    网关    → 302  <站点回调>?code=C&state=X   （code 与 state 原样转交，网关不保存）
    站点    → POST <网关>/token（带签名）       → 网关用 C 去换 token、取资料，返回归一化 profile
    站点    → 建号/登录，302 回站点页面

所以网关要在第三方后台注册**自己的**回调地址（例如 `https://gw.example.com/callback/github`），
站点的 `<站点地址>/auth/<provider>/callback` 反而不用注册到第三方后台（它是站点与网关之间的地址）。

### 4.2 网关要实现的两个接口

**A. 授权跳转**

    GET <网关>/authorize?provider=github&redirect_uri=<站点回调>&state=X
    → 302 到第三方授权页（state 原样带上，第三方回调时再带回来）
    → 第三方回调到网关后，网关 302 到 redirect_uri?code=<授权码>&state=X

`redirect_uri` 是站点给的、站点自己的回调地址：**必须与站点配置一致才能转发**，
网关应当只允许自己服务的那几个站点（白名单），否则会变成开放重定向。

**B. 换取资料**

    POST <网关>/token
    Content-Type: application/json
    x-oauth-ts: <秒级 Unix 时间戳>
    x-oauth-nonce: <一次性随机串>
    x-oauth-signature: <HMAC-SHA256 十六进制小写>（配了 OAUTH_GATEWAY_SECRET 才有）
    {"provider":"github","code":"C","redirect_uri":"https://game.example.com/auth/github/callback","ts":"1760000000","nonce":"…"}

成功（HTTP 200）：

    {"provider":"github","profile":{"id":"12345","username":"octocat","displayName":"The Octocat","email":"a@b.c","avatar":"https://…"}}

失败（HTTP 4xx/5xx）：

    {"error":"exchange_failed"}

`profile.id` 必填（站点会存成 `<provider>:<id>`）；`username` / `displayName` / `email` / `avatar` 可缺，
缺了就是空串（`displayName` 也可写成 `name`，`id` 也可写成 `uid`）。

站点认得的 `error`：`provider_disabled`、`exchange_failed`、`no_profile`、`bad_signature`、`stale_ts`、`replayed`、`unsupported_provider`。
其它值一律按 `exchange_failed` 处理，用户看到的文案是「换取用户资料失败（<错误码>），稍后再试」。

### 4.3 签名算法

    base = ts + "\n" + nonce + "\n" + provider + "\n" + code + "\n" + redirect_uri
    sig  = HMAC-SHA256(OAUTH_GATEWAY_SECRET, base) 的十六进制小写（64 位）

两个实现与站点完全一致，可任选：

```js
// Node / 服务端
import { createHmac } from 'node:crypto';
const sig = createHmac('sha256', SECRET)
  .update([ts, nonce, provider, code, redirect_uri].join('\n'), 'utf8')
  .digest('hex');
```

```js
// Cloudflare Workers / 浏览器（与 worker/oauth.js 里的实现同源）
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const buf = await crypto.subtle.sign('HMAC', key, enc.encode([ts, nonce, provider, code, redirect_uri].join('\n')));
const sig = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
```

网关侧的校验顺序（缺一不可）：

1. **签名**：用同一套算法重算 `x-oauth-signature`，**用常量时间比较**（`crypto.timingSafeEqual`），不等 → `bad_signature`；
2. **时间戳**：`|now - ts| ≤ 300` 秒（站点发的是秒级；站点自己的 `oauth.gatewayTsFresh()` 同样接受毫秒，网关照秒处理最省事），超窗 → `stale_ts`；
3. **重放**：`nonce` 在窗口内只能用一次（内存 Map / KV / 表都行，TTL 5 分钟即可），重复 → `replayed`；
4. `provider` 不在本站支持的名单里 → `unsupported_provider`；
5. **注意**：签名覆盖 `code` 与 `redirect_uri`，所以「换一个 code 重放」「改 redirect_uri」都会让签名失效——这也是签名要带上这两项的原因。

### 4.4 最小网关示例（Node 22+，零依赖）

```js
// gateway.js —— 只做了 GitHub 的最小可用网关：其余 Provider 照抄 PROVIDERS 里的三项地址即可。
//   PORT=8787 OAUTH_GATEWAY_SECRET=… GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… node gateway.js
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

const GW = process.env.GATEWAY_ORIGIN || 'http://127.0.0.1:8787';  // 网关自己的对外地址
const SECRET = process.env.OAUTH_GATEWAY_SECRET || '';
const SITES = [process.env.SITE_ORIGIN || 'http://127.0.0.1:3000']; // 允许的站点（redirect_uri 白名单）
const PROVIDERS = {
  github: {
    id: process.env.GITHUB_CLIENT_ID || '',
    secret: process.env.GITHUB_CLIENT_SECRET || '',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    user: 'https://api.github.com/user',
    scope: 'read:user user:email'
  }
};

const seen = new Map(); // nonce → 首次见到的时间（秒）

function sign(ts, nonce, provider, code, redirectUri) {
  return createHmac('sha256', SECRET)
    .update([ts, nonce, provider, code, redirectUri].join('\n'), 'utf8')
    .digest('hex');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function allowed(redirectUri) {
  return SITES.some((s) => redirectUri.startsWith(s.replace(/\/+$/, '') + '/auth/'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, GW);

  // A. 跳第三方授权页
  if (req.method === 'GET' && url.pathname === '/authorize') {
    const provider = url.searchParams.get('provider') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const p = PROVIDERS[provider];
    if (!p || !p.id) return json(res, 404, { error: 'unsupported_provider' });
    if (!allowed(redirectUri)) return json(res, 400, { error: 'exchange_failed' });
    // 记下站点回调（真实实现应存在 state 或签名 cookie 里，别让客户端随便改）
    const back = GW + '/back?to=' + encodeURIComponent(redirectUri) + '&state=' + encodeURIComponent(state);
    const q = new URLSearchParams({
      client_id: p.id, redirect_uri: back, scope: p.scope, state, response_type: 'code'
    });
    res.writeHead(302, { Location: p.authorize + '?' + q.toString() });
    return res.end();
  }

  // 第三方回调：把 code 与 state 原样转交给站点
  if (req.method === 'GET' && url.pathname === '/back') {
    const to = url.searchParams.get('to') || '';
    const u = new URL(to);
    u.searchParams.set('code', url.searchParams.get('code') || '');
    u.searchParams.set('state', url.searchParams.get('state') || '');
    res.writeHead(302, { Location: u.toString() });
    return res.end();
  }

  // B. 换资料（签名 + 时间戳 + nonce 三重校验）
  if (req.method === 'POST' && url.pathname === '/token') {
    const raw = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
    let body = {};
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'exchange_failed' }); }
    const ts = String(req.headers['x-oauth-ts'] || '');
    const nonce = String(req.headers['x-oauth-nonce'] || '');
    const got = String(req.headers['x-oauth-signature'] || '');
    if (SECRET) {
      const want = sign(ts, nonce, body.provider, body.code, body.redirect_uri);
      const a = Buffer.from(got); const b = Buffer.from(want);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 401, { error: 'bad_signature' });
    }
    if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json(res, 401, { error: 'stale_ts' });
    const now = Math.floor(Date.now() / 1000);
    for (const [k, t] of seen) if (now - t > 300) seen.delete(k);
    if (seen.has(nonce)) return json(res, 401, { error: 'replayed' });
    seen.set(nonce, now);

    const p = PROVIDERS[body.provider];
    if (!p || !p.id) return json(res, 400, { error: 'unsupported_provider' });
    const form = new URLSearchParams({
      client_id: p.id, client_secret: p.secret, code: body.code,
      redirect_uri: GW + '/back', grant_type: 'authorization_code'   // 与授权时用的 redirect_uri 一致
    });
    const tok = await (await fetch(p.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString()
    })).json();
    if (!tok.access_token) return json(res, 502, { error: 'exchange_failed' });
    const u = await (await fetch(p.user, {
      headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': 'oauth-gateway', Accept: 'application/vnd.github+json' }
    })).json();
    if (!u.id) return json(res, 502, { error: 'no_profile' });
    return json(res, 200, {
      provider: body.provider,
      profile: { id: String(u.id), username: u.login, displayName: u.name || u.login, email: u.email || '', avatar: u.avatar_url || '' }
    });
  }

  json(res, 404, { error: 'exchange_failed' });
});

server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => {
  console.log('oauth gateway on ' + GW + '，已注册 Provider：' + Object.keys(PROVIDERS).join(', '));
});
```

上线前请自行补齐：HTTPS、`nonce` 存储换成 KV/Redis（示例是单进程内存）、微信/Google 的授权与资料接口、
以及日志里不要打印 `code` / `access_token` / `client_secret`。

## 5. 未配置时会发生什么（回退行为）

| 配置状态 | 行为 |
| --- | --- |
| 什么都不配 | 登录页不出现任何第三方按钮（开发环境会出现「演示登录」）；后台自检表格仍列出 GitHub / Google / 微信 三行，各写「未配置」与要设的变量、回调地址 |
| 只配某个 Provider 的直连密钥 | 只有配齐 ID+Secret 的那个出现；**其它行为与加网关功能之前完全一致**（授权地址逐字节相同） |
| 配了 `OAUTH_GATEWAY_URL` | 列进 `OAUTH_GATEWAY_PROVIDERS`（默认三个全部）的 Provider 改走网关，站点不需要它们的密钥；没列进去的仍走直连 |
| 网关地址写错 / 网关挂了 | 授权跳转 302 到网关后失败，或回调时报「换取用户资料失败（exchange_failed），稍后再试」。后台自检表格里 client_id / secret 两列指的是**直连密钥**，网关模式下显示 ❌ 是正常的，以「已开启」为准；要显示网关信息可用 `oauth.gatewayInfo()` |

## 6. 常见问题

- **回调地址 404 / 第三方报 redirect_uri_mismatch**：多半是 `SITE_ORIGIN` 与实际访问域名不一致（http/https、带不带 www、端口），
  或者后台里回调地址没填全 `/auth/<provider>/callback` 这一段。
- **「登录状态校验失败，请重新发起一次（浏览器可能拦了临时 cookie）」**：`oauth_state` cookie 没带上——
  跨站 cookie 被浏览器拦了、或者用户是先打开授权页、十分钟后才回来（cookie 只有 600 秒）。
- **微信返回 `errcode 40029/40163`**：code 被用过或过期（微信的 code 只能用一次，且站点与网关之间不能重复消费）。
- **微信扫码页报「redirect_uri 参数错误」**：后台「授权回调域」填成了带路径的值，或者当前域名不在该域名下。
- **换了域名后 GitHub/Google 登录失败**：两边后台的回调地址都要改成新域名，`SITE_ORIGIN` 也要跟着改。

## 7. 自测

    node tools/oauth-gateway-test.mjs     # 端到端：假微信 / 假网关 + 真 Express 站点，不发外网请求
    pnpm test:mail                        # 既有回归（含后台「集成自检」表格）
