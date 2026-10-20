/**
 * Web Push 的存储与投递（Workers / D1 线）——src/push.js 的逐字镜像。
 *
 * 函数名、参数顺序、返回值形状与 src/push.js 完全一致，区别只有两点：
 *   1. 首参永远是 D1 绑定 db（src 线是模块内拿到 node:sqlite 的 db）；
 *   2. 全程 await（D1 的 API 是异步的）。
 * 加密与文案复用 ../src/push-core.js（那个文件不 import 任何东西，Workerd 里能直接跑）；
 * 注意不能 import ../src/push.js——它 import 了 node:sqlite。
 *
 * 幂等建表用逐条 prepare().run()，不能用 exec()：D1 的 exec() 按换行切语句，
 * 单行字符串才安全（见 worker/outbox.js 顶部的同一段教训）。
 *
 * VAPID 三件套在 Workers 侧走 wrangler secret / [vars]：VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY、VAPID_SUBJECT
 * （生成命令与说明见 src/push.js 文件头）。三件套不齐时整条链路空转：pushConfigured(env).ok === false，
 * notifyPush 立刻返回、deliver 返回零值，一个 D1 查询都不会发。
 *
 * 推送体是 JSON：{ title, body, url, tag, kind }，Service Worker 里 event.data.json() 直接用。
 */
import { isValidSubscription, pushPayload, vapidHeader, encryptPayload, PUSH_KINDS, DEFAULT_VAPID_SUBJECT, fromB64u, b64u } from '../src/push-core.js';

/** 与 src/push.js 的 PUSH_DDL 逐字相同（tools/push-test.mjs 会断言这一点） */
export const PUSH_DDL = [
  'CREATE TABLE IF NOT EXISTS push_subs ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, ok_at TEXT DEFAULT \'\', fail_count INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0 )',
  'CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs (user_id, disabled)',
  'CREATE TABLE IF NOT EXISTS push_keys ( k TEXT PRIMARY KEY, v TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT \'\' )'
];

/** 连续失败多少次就置 disabled（与 src/push.js 同值） */
export const PUSH_FAIL_LIMIT = 5;

const READY = new WeakSet();

/** 幂等建表；返回 db */
export async function ensurePush(db) {
  if (!db) throw new Error('no_d1_binding');
  if (READY.has(db)) return db;
  for (const sql of PUSH_DDL) await db.prepare(sql).run();
  READY.add(db);
  return db;
}

const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString();

function flatSub(sub) {
  const keys = sub && sub.keys && typeof sub.keys === 'object' ? sub.keys : (sub || {});
  return {
    endpoint: String((sub && sub.endpoint) || '').trim(),
    p256dh: String(keys.p256dh || '').trim(),
    auth: String(keys.auth || '').trim()
  };
}

/** 与 src/push.js 的 pushConfigured 同形状；Workers 里没有 process.env，所以缺省是空对象 */
export function pushConfigured(env = {}) {
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

/** 留给前端的 applicationServerKey（没配就返回空串） */
export function vapidPublicKey(env = {}) {
  const cfg = pushConfigured(env);
  if (!cfg.ok) return '';
  try {
    return b64u(fromB64u(cfg.publicKey));
  } catch (err) {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * VAPID 密钥自举：PUSH_AUTO_KEYS 打开时，D1 里没有一对键就现生成一对落库
 * （与 src/push.js 同名同形，区别只是首参是 D1 绑定、全程 await）
 * ------------------------------------------------------------------ */

const AUTO_KEY_FLAG = ['1', 'on', 'true', 'yes'];
const KEY_NAMES = { pub: 'public', priv: 'private', sub: 'subject' };

/** PUSH_AUTO_KEYS 是否打开（默认关） */
export function pushAutoKeys(env = {}) {
  const e = env || {};
  const v = String(e.PUSH_AUTO_KEYS == null ? '' : e.PUSH_AUTO_KEYS).trim().toLowerCase();
  return AUTO_KEY_FLAG.includes(v);
}

/** 生成一对 VAPID 键：公钥 = 65 字节未压缩点（raw），私钥 = 32 字节标量（jwk.d） */
async function genVapidPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64u(point), privateKey: String(jwk.d || '') };
}

async function readKeyRows(db) {
  const out = {};
  const r = await db.prepare('SELECT k, v FROM push_keys').all();
  for (const row of (r && r.results) || []) out[String(row.k)] = String(row.v == null ? '' : row.v);
  return out;
}

/** 从 D1 里取一对键（缺了就生成一对落库再读回）；拿不到合法键时返回 null */
async function autoVapid(db, env) {
  const e = env || {};
  await ensurePush(db);
  let rows = await readKeyRows(db);
  if (!rows[KEY_NAMES.pub] || !rows[KEY_NAMES.priv]) {
    const pair = await genVapidPair();
    const at = iso(Date.now());
    const subject = String(e.VAPID_SUBJECT || '').trim() || DEFAULT_VAPID_SUBJECT;
    // INSERT OR IGNORE：并发的首个请求只有一条能写进去，其余读回同一对键
    const ins = 'INSERT OR IGNORE INTO push_keys (k, v, changed_at) VALUES (?, ?, ?)';
    await db.prepare(ins).bind(KEY_NAMES.pub, pair.publicKey, at).run();
    await db.prepare(ins).bind(KEY_NAMES.priv, pair.privateKey, at).run();
    await db.prepare(ins).bind(KEY_NAMES.sub, subject, at).run();
    rows = await readKeyRows(db);
  }
  const pub = String(rows[KEY_NAMES.pub] || '');
  const priv = String(rows[KEY_NAMES.priv] || '');
  try {
    if (fromB64u(pub).length !== 65 || fromB64u(priv).length !== 32) return null;
  } catch (err) {
    return null;
  }
  const envSubject = String(e.VAPID_SUBJECT || '').trim();
  const storedSubject = String(rows[KEY_NAMES.sub] || '').trim();
  const subject = envSubject || storedSubject || DEFAULT_VAPID_SUBJECT;
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null;
  return { ok: true, reason: '', publicKey: pub, privateKey: priv, subject: subject, defaultSubject: !(envSubject || storedSubject), source: 'db' };
}

/**
 * 实际生效的 VAPID 配置（src/push.js 的异步镜像）。
 * 环境变量配好就用 env；否则 PUSH_AUTO_KEYS 开着时用 D1 里的自举密钥；都不成立就空转。
 */
export async function resolveVapid(db, env = {}) {
  const base = pushConfigured(env);
  if (base.ok) return Object.assign({}, base, { source: 'env' });
  if (!pushAutoKeys(env) || !db) return Object.assign({}, base, { source: '' });
  try {
    const auto = await autoVapid(db, env);
    if (auto) return auto;
  } catch (err) {
    // D1 不可用 / 只读：当没配置降级
  }
  return Object.assign({}, base, { source: '' });
}

/** 给前端的 applicationServerKey（src/push.js 的异步镜像） */
export async function keyForClient(db, env = {}) {
  const cfg = await resolveVapid(db, env);
  if (!cfg.ok) return '';
  try {
    return b64u(fromB64u(cfg.publicKey));
  } catch (err) {
    return '';
  }
}

/**
 * 存订阅（同一 endpoint 幂等 upsert；重新订阅顺带清 disabled 与 fail_count）。
 * @returns {Promise<{ok:boolean, id:number, error:string}>}
 */
export async function subscribe(db, userId, sub, ua = '') {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, id: 0, error: 'bad_user' };
  if (!isValidSubscription(sub)) return { ok: false, id: 0, error: 'bad_subscription' };
  const f = flatSub(sub);
  const agent = String(ua || '').slice(0, 300);
  await ensurePush(db);
  await db.prepare(
    'INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua, created_at, ok_at, fail_count, disabled) VALUES (?, ?, ?, ?, ?, ?, \'\', 0, 0) ' +
    'ON CONFLICT(endpoint) DO UPDATE SET user_id = ?, p256dh = ?, auth = ?, ua = ?, ok_at = \'\', fail_count = 0, disabled = 0'
  ).bind(uid, f.endpoint, f.p256dh, f.auth, agent, iso(), uid, f.p256dh, f.auth, agent).run();
  const row = await db.prepare('SELECT id FROM push_subs WHERE endpoint = ?').bind(f.endpoint).first();
  return { ok: true, id: Number((row && row.id) || 0), error: '' };
}

/**
 * 退订；endpoint 空串 = 退掉该用户全部订阅。
 * @returns {Promise<{ok:boolean, removed:number}>}
 */
export async function unsubscribe(db, userId, endpoint = '') {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, removed: 0 };
  await ensurePush(db);
  const ep = String(endpoint || '').trim();
  const info = ep
    ? await db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').bind(uid, ep).run()
    : await db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(uid).run();
  return { ok: true, removed: Number(((info && info.meta) || {}).changes || 0) };
}

/** 该用户的全部订阅（含 disabled 的） */
export async function listSubscriptions(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  try {
    await ensurePush(db);
    const r = await db.prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY id').bind(uid).all();
    return (r && r.results) || [];
  } catch (err) {
    return [];
  }
}

async function markOk(db, id, at) {
  await db.prepare('UPDATE push_subs SET ok_at = ?, fail_count = 0 WHERE id = ?').bind(at, id).run();
}

async function markFail(db, id) {
  await db.prepare('UPDATE push_subs SET fail_count = fail_count + 1, disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END WHERE id = ?').bind(PUSH_FAIL_LIMIT, id).run();
}

function topicOf(tag) {
  return String(tag || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
}

/**
 * 把一条通知投给某用户的所有订阅。绝不抛异常。
 * @param {object} db D1 绑定
 * @param {object} env Workers env（VAPID 三件套从这里取）
 * @param {number} userId
 * @param {{title?:string, body?:string, url?:string, tag?:string, kind?:string}|string} payload pushPayload() 的返回值
 * @returns {Promise<{sent:number, pruned:number, failed:number, skipped:number}>}
 */
export async function deliver(db, env, userId, payload, opts = {}) {
  const out = { sent: 0, pruned: 0, failed: 0, skipped: 0 };
  const uid = Number(userId) || 0;
  try {
    if (!uid || !db) return out;
    const cfg = opts.cfg || (await resolveVapid(db, env || opts.env || {}));
    if (!cfg.ok) return out;
    await ensurePush(db);
    const r = await db.prepare('SELECT * FROM push_subs WHERE user_id = ? AND disabled = 0 ORDER BY id').bind(uid).all();
    const rows = (r && r.results) || [];
    if (!rows.length) return out;
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
        await markOk(db, row.id, stamp);
      } else if (status === 404 || status === 410) {
        await db.prepare('DELETE FROM push_subs WHERE id = ?').bind(row.id).run();
        out.pruned++;
      } else {
        out.failed++;
        await markFail(db, row.id);
      }
    }
  } catch (err) {
    // 兜底：推送永远不许把 handler 带崩
  }
  return out;
}

/**
 * 通知 → 推送（同步返回 void，投递在后台跑；不用 await）。
 * 没配 VAPID 或 kind 不在白名单时立刻返回，连 D1 都不查。
 */
export function notifyPush(db, env, userId, notification, opts = {}) {
  try {
    if (!pushConfigured(env || opts.env || {}).ok && !pushAutoKeys(env || opts.env || {})) return;
    const n = notification || {};
    const kind = String(n.kind || '').trim();
    if (!PUSH_KINDS.includes(kind)) return;
    const uid = Number(userId) || 0;
    if (!uid || !db) return;
    if (Number(n.actorId) && Number(n.actorId) === uid) return;
    void deliver(db, env, uid, pushPayload(n), opts).catch(() => {});
  } catch (err) {
    // 空转
  }
}
