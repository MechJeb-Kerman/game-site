/**
 * Web Push 的存储与投递（Express 线，node:sqlite 同步驱动）。
 *
 * 这一层只做三件事：存订阅（push_subs 表）、投递（加密 + VAPID + POST endpoint）、
 * 失败计数与自愈（404/410 删订阅，连续失败 5 次置 disabled）。
 * 加密与通知文案都在 src/push-core.js 里（两线共用），本文件不重复实现。
 * 一一镜像：worker/push.js（D1 线，函数名/参数/返回值必须逐字对齐，区别只是首参多一个 db）。
 *
 * VAPID 三件套怎么生成（生成一次，写进 .env / wrangler secret，两线共用同一对键）：
 *   node -e "(async()=>{const{webcrypto:c}=require('node:crypto');const k=await c.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const pub=Buffer.from(await c.subtle.exportKey('raw',k.publicKey)).toString('base64url');const jwk=await c.subtle.exportKey('jwk',k.privateKey);console.log('VAPID_PUBLIC_KEY='+pub);console.log('VAPID_PRIVATE_KEY='+jwk.d);})()"
 *   VAPID_PUBLIC_KEY  65 字节未压缩点的 base64url（发给浏览器当 applicationServerKey 的就是它）
 *   VAPID_PRIVATE_KEY 32 字节 raw 标量的 base64url（只留在服务端，别进前端/仓库）
 *   VAPID_SUBJECT     mailto:you@example.com 或 https://example.com（不配就回退 mailto:admin@fishport.cn，返回值里会标注）
 *   三件套不齐时整条链路空转：pushConfigured().ok === false、notifyPush 立刻返回、deliver 返回零值，
 *   一个 SQL 都不会查（这样本地开发和没上推送的环境完全无感）。
 *
 * 推送体是 JSON：{ title, body, url, tag, kind }，给 Service Worker 用
 * （push 事件里 event.data.json() → showNotification(data.title, { body: data.body, tag: data.tag, data: { url: data.url } })）。
 */
import { db } from './db.js';
import { isValidSubscription, pushPayload, vapidHeader, encryptPayload, PUSH_KINDS, DEFAULT_VAPID_SUBJECT, fromB64u, b64u } from './push-core.js';

/** 建表语句（每条必须是单行字符串；worker/push.js 里有一份逐字相同的，测试会断言两线一致） */
export const PUSH_DDL = [
  'CREATE TABLE IF NOT EXISTS push_subs ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, ok_at TEXT DEFAULT \'\', fail_count INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0 )',
  'CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs (user_id, disabled)'
];

/** 连续失败多少次就置 disabled（等浏览器重订阅或下次登录再清） */
export const PUSH_FAIL_LIMIT = 5;

let readyFor = null;
let override = null;
function store() { return override || db; }

/** 测试钩子：换一个 SQLite 连接（照 src/outbox.js 的 useOutboxStore；传 null 恢复默认） */
export function usePushStore(handle) {
  const prev = override;
  override = handle || null;
  readyFor = null;
  return prev;
}

/** 幂等建表；返回实际用的连接 */
export function ensurePush() {
  const h = store();
  if (readyFor === h) return h;
  for (const sql of PUSH_DDL) h.exec(sql);
  readyFor = h;
  return h;
}

const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString();

/** 订阅对象拍平（同时接受 { endpoint, keys:{...} } 与 { endpoint, p256dh, auth }） */
function flatSub(sub) {
  const keys = sub && sub.keys && typeof sub.keys === 'object' ? sub.keys : (sub || {});
  return {
    endpoint: String((sub && sub.endpoint) || '').trim(),
    p256dh: String(keys.p256dh || '').trim(),
    auth: String(keys.auth || '').trim()
  };
}

/**
 * VAPID 配置体检（不查库、不抛异常）。
 * @returns {{ok:boolean, reason:string, publicKey:string, privateKey:string, subject:string, defaultSubject:boolean}}
 *          reason：'' = 配好了；'no_keys' = 一对键都没有；'bad_keys' = 只有一半或长度不对；'no_subject' = SUBJECT 不合法
 */
export function pushConfigured(env = process.env) {
  const e = env || {};
  const pub = String(e.VAPID_PUBLIC_KEY == null ? '' : e.VAPID_PUBLIC_KEY).trim();
  const priv = String(e.VAPID_PRIVATE_KEY == null ? '' : e.VAPID_PRIVATE_KEY).trim();
  const rawSubject = String(e.VAPID_SUBJECT == null ? '' : e.VAPID_SUBJECT).trim();
  const subject = rawSubject || DEFAULT_VAPID_SUBJECT;
  const bad = { ok: false, publicKey: '', privateKey: '', subject: subject, defaultSubject: !rawSubject };
  if (!pub && !priv) return Object.assign({ reason: 'no_keys' }, bad);
  if (!pub || !priv) return Object.assign({ reason: 'bad_keys' }, bad);
  try {
    if (fromB64u(pub).length !== 65 || fromB64u(priv).length !== 32) return Object.assign({ reason: 'bad_keys' }, bad);
  } catch (err) {
    return Object.assign({ reason: 'bad_keys' }, bad);
  }
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return Object.assign({ reason: 'no_subject' }, bad);
  return { ok: true, reason: '', publicKey: pub, privateKey: priv, subject: subject, defaultSubject: !rawSubject };
}

/** 留给前端的 applicationServerKey（没配就返回空串）；返回归一化后的 base64url，无填充 */
export function vapidPublicKey(env = process.env) {
  const cfg = pushConfigured(env);
  if (!cfg.ok) return '';
  try {
    return b64u(fromB64u(cfg.publicKey));
  } catch (err) {
    return '';
  }
}

/**
 * 存订阅（同一 endpoint 幂等 upsert；重新订阅顺带清 disabled 与 fail_count）。
 * @returns {{ok:boolean, id:number, error:string}} error：'bad_user' / 'bad_subscription' / ''
 */
export function subscribe(userId, sub, ua = '') {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, id: 0, error: 'bad_user' };
  if (!isValidSubscription(sub)) return { ok: false, id: 0, error: 'bad_subscription' };
  const f = flatSub(sub);
  const agent = String(ua || '').slice(0, 300);
  const h = ensurePush();
  h.prepare(
    'INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua, created_at, ok_at, fail_count, disabled) VALUES (?, ?, ?, ?, ?, ?, \'\', 0, 0) ' +
    'ON CONFLICT(endpoint) DO UPDATE SET user_id = ?, p256dh = ?, auth = ?, ua = ?, ok_at = \'\', fail_count = 0, disabled = 0'
  ).run(uid, f.endpoint, f.p256dh, f.auth, agent, iso(), uid, f.p256dh, f.auth, agent);
  const row = h.prepare('SELECT id FROM push_subs WHERE endpoint = ?').get(f.endpoint);
  return { ok: true, id: Number((row && row.id) || 0), error: '' };
}

/**
 * 退订。endpoint 传空串 = 退掉该用户全部订阅（换设备/关推送）。
 * @returns {{ok:boolean, removed:number}}
 */
export function unsubscribe(userId, endpoint = '') {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, removed: 0 };
  const h = ensurePush();
  const ep = String(endpoint || '').trim();
  const info = ep
    ? h.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(uid, ep)
    : h.prepare('DELETE FROM push_subs WHERE user_id = ?').run(uid);
  return { ok: true, removed: Number((info && info.changes) || 0) };
}

/** 该用户的全部订阅（含 disabled 的，方便排查/清理；投递只取 disabled = 0 的） */
export function listSubscriptions(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  try {
    return ensurePush().prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY id').all(uid);
  } catch (err) {
    return [];
  }
}

function markOk(h, id, at) {
  h.prepare('UPDATE push_subs SET ok_at = ?, fail_count = 0 WHERE id = ?').run(at, id);
}

function markFail(h, id) {
  h.prepare('UPDATE push_subs SET fail_count = fail_count + 1, disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END WHERE id = ?').run(PUSH_FAIL_LIMIT, id);
}

/** Topic 头：RFC 8030 要求 base64url 字符集、≤32 字符 */
function topicOf(tag) {
  return String(tag || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
}

/**
 * 把一条通知投给某用户的所有订阅。绝不抛异常。
 * @param {number} userId
 * @param {{title?:string, body?:string, url?:string, tag?:string, kind?:string}|string} payload pushPayload() 的返回值
 * @param {{env?:object, fetchImpl?:Function, now?:number, ttl?:number, urgency?:string, concurrency?:number}} [opts]
 * @returns {Promise<{sent:number, pruned:number, failed:number, skipped:number}>}
 *          sent 成功（200/201/202）；pruned 端点已失效被删（404/410）；failed 其它错误；skipped 没发（没配置/没订阅/订阅不合法）
 */
export async function deliver(userId, payload, opts = {}) {
  const out = { sent: 0, pruned: 0, failed: 0, skipped: 0 };
  const uid = Number(userId) || 0;
  try {
    if (!uid) return out;
    const cfg = pushConfigured(opts.env || process.env);
    if (!cfg.ok) return out;                                    // 没配 VAPID：零值返回，一个 SQL 都不查
    const h = ensurePush();
    const rows = h.prepare('SELECT * FROM push_subs WHERE user_id = ? AND disabled = 0 ORDER BY id').all(uid);
    if (!rows || !rows.length) return out;                       // 没订阅：同样零值
    const p = (payload && typeof payload === 'object') ? payload : { title: String(payload == null ? '' : payload) };
    const text = JSON.stringify({
      title: String(p.title || ''),
      body: String(p.body || ''),
      url: String(p.url || '/notifications'),
      tag: String(p.tag || ''),
      kind: String(p.kind || '')
    });
    const now = Number(opts.now) || Date.now();
    const stamp = iso(now);
    const ttl = Math.max(0, Math.min(Math.floor(Number(opts.ttl == null ? 24 * 3600 : opts.ttl)) || 0, 2419200));
    const urgency = ['very-low', 'low', 'normal', 'high'].includes(String(opts.urgency || '')) ? String(opts.urgency) : 'normal';
    const topic = topicOf(p.tag);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    for (const row of rows) {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      if (!isValidSubscription(sub) || typeof fetchImpl !== 'function') { out.skipped++; continue; }
      let enc;
      let auth;
      try {
        enc = await encryptPayload(sub, text);
        auth = await vapidHeader(row.endpoint, { publicKey: cfg.publicKey, privateKey: cfg.privateKey, subject: cfg.subject, now: now });
      } catch (err) {
        out.skipped++;
        continue;
      }
      const headers = Object.assign({}, enc.headers, {
        Authorization: auth,
        TTL: String(ttl),
        Urgency: urgency
      });
      if (topic) headers.Topic = topic;
      let status = 0;
      try {
        const res = await fetchImpl(row.endpoint, { method: 'POST', headers: headers, body: enc.body });
        status = Number((res && res.status) || 0);
      } catch (err) {
        status = -1;
      }
      if (status === 200 || status === 201 || status === 202) {
        out.sent++;
        markOk(h, row.id, stamp);
      } else if (status === 404 || status === 410) {
        h.prepare('DELETE FROM push_subs WHERE id = ?').run(row.id);
        out.pruned++;
      } else {
        out.failed++;
        markFail(h, row.id);
      }
    }
  } catch (err) {
    // 兜底：推送永远不许把调用方带崩（少推一条远比 500 好）
  }
  return out;
}

/**
 * 通知 → 推送（同步返回 void，投递在后台跑；调用方不用 await，也不会被拖慢）。
 * 没配 VAPID 或 kind 不在 PUSH_KINDS 白名单里时立刻返回，连 SQL 都不查。
 * notification 的形状与 src/social.js 的 notify() 入参一致：{ kind, actorId, actorName, targetType, targetId, body }
 */
export function notifyPush(userId, notification, opts = {}) {
  try {
    if (!pushConfigured(opts.env || process.env).ok) return;
    const n = notification || {};
    const kind = String(n.kind || '').trim();
    if (!PUSH_KINDS.includes(kind)) return;
    const uid = Number(userId) || 0;
    if (!uid) return;
    if (Number(n.actorId) && Number(n.actorId) === uid) return;    // 自己的动作不推给自己（与 social.notify 的 self 跳过一致）
    void deliver(uid, pushPayload(n), opts).catch(() => {});
  } catch (err) {
    // 空转
  }
}
