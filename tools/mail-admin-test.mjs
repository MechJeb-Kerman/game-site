/**
 * 邮件后台与退信回调验收（Express + Worker 两线）：
 *   node tools/mail-admin-test.mjs        # 或 pnpm test:mail-admin
 *
 * 覆盖：
 *   · GET  /admin/mail             两线渲染（概览 / 按用途 / 失败原因 / 抑制名单 / 最近退信 / 服务商回调）
 *   · POST /admin/mail/suppress    手动拉黑、清掉排队的那封、坏地址、未登录
 *   · POST /admin/mail/unsuppress  解除、重复解除
 *   · POST /webhooks/mail-bounce   令牌、无收件人、非退信事件、退信、查询串、投诉
 *   · 抑制名单真的挡投递：sendMail / deliverNow / 重发验证邮件不再入队
 * Express 线自己 spawn server.js（独立端口、MAIL_TICK=0、假服务商永远 500，让信留在重试队列）；
 * Worker 线用 tools/serve-worker.mjs（独立数据库 data/worker-mail-admin-test.db）。
 * 跑完清理自建的发件箱行、抑制名单行与测试账号；不占 3000/4400。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3157);
const SECRET = 'probe-webhook-secret-' + Date.now().toString(36);
const STAMP = Date.now().toString(36);
const DB = join(ROOT, 'data', 'games.db');
const WDB = join(ROOT, 'data', 'worker-mail-admin-test.db');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows 上刚 close 掉的本地 D1 文件句柄可能还没释放：删不掉只等一会儿，不算测试失败 */
async function rmQuiet(file) {
  for (let i = 0; i < 10; i++) {
    try { await rm(file, { force: true }); return; }
    catch (e) { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; await sleep(150); }
  }
}

function jar() { return new Map(); }
function absorb(j, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) j.set(first.slice(0, i), first.slice(i + 1));
  }
}
function req(base, path, opt) {
  const o = opt || {};
  const headers = {};
  if (o.j && o.j.size) headers.cookie = [...o.j.entries()].map(([k, v]) => k + '=' + v).join('; ');
  let body;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  if (o.form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  if (o.headers) Object.assign(headers, o.headers);
  return fetch(base + path, { method: o.method || 'GET', headers, body, redirect: o.redirect || 'follow' }).then(async (res) => {
    if (o.j) absorb(o.j, res);
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { j = null; }
    return { status: res.status, text, json: j, location: res.headers.get('location') || '', type: res.headers.get('content-type') || '' };
  });
}
/** 只读查库：服务器正在写同一个文件，偶发 BUSY 就重试几次 */
function dbRows(sql, ...args) {
  for (let i = 0; i < 20; i++) {
    let d = null;
    try {
      d = new DatabaseSync(DB, { readOnly: true });
      const rows = d.prepare(sql).all(...args);
      d.close();
      return rows;
    } catch (e) {
      if (d) { try { d.close(); } catch {} }
      if (i === 19) throw e;
      const until = Date.now() + 100;
      while (Date.now() < until) { /* 短暂自旋，等服务器把手放开 */ }
    }
  }
  return [];
}
function dbRun(sql, ...args) {
  const d = new DatabaseSync(DB);
  try { d.prepare(sql).run(...args); } finally { d.close(); }
}

/* ---------- 假邮件服务商：永远 500，记下每次投递 ---------- */
const hits = [];
const provider = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => { b += c; });
  rq.on('end', () => {
    hits.push(b);
    rs.writeHead(500, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ message: 'boom from fake provider' }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerPort = provider.address().port;

const logs = [];
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: '1',
    PORT: String(PORT), MAIL_TICK: '0', MAIL_WEBHOOK_SECRET: SECRET,
    MAIL_API_URL: 'http://127.0.0.1:' + providerPort + '/emails',
    MAIL_RETRY_BASE_MS: '3600000', MAIL_MAX_ATTEMPTS: '9',
    RESEND_API_KEY: '', MAIL_API_KEY: ''
  }
});
srv.stdout.on('data', (c) => logs.push(String(c)));
srv.stderr.on('data', (c) => logs.push(String(c)));
function logsText() { return logs.join(''); }

const BASE = 'http://127.0.0.1:' + PORT;
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/'); if (r.status === 200) { up = true; break; } } catch {}
  await sleep(250);
}
if (!up) { console.error('server.js 没起来，日志：' + logsText().slice(-2000)); process.exit(2); }

const addrOf = (n) => 'probe' + n + STAMP + '@example.com';
const cleanups = [];
const users = [];

console.log('');
console.log('=== 一、Express 线：GET /admin/mail ===');
const admin = jar();
let r = await req(BASE, '/login', { method: 'POST', j: admin, form: { username: 'admin', password: 'admin123' }, redirect: 'manual' });
ok('站长登录 302', r.status === 302, r.status + ' ' + r.location);

const ck = jar();
const uname = 'mp' + STAMP; // 用户名上限 16 位（src/auth.js:63），别用长前缀
users.push(uname);
r = await req(BASE, '/register', { method: 'POST', j: ck, form: { username: uname, password: 'Probe12345', display_name: '邮件探针', agree: '1' }, redirect: 'manual' });
ok('注册测试账号 302', r.status === 302, r.status + ' ' + r.location);

const addr = addrOf('a');
cleanups.push(addr);
r = await req(BASE, '/account/email', { method: 'POST', j: ck, form: { email: addr }, redirect: 'manual' });
ok('绑定邮箱 302', r.status === 302 && r.location.indexOf('/account?ok=email') === 0, r.status + ' ' + r.location);
let row = dbRows('SELECT * FROM mail_outbox WHERE to_addr = ? ORDER BY id DESC', addr)[0];
ok('发件箱落了一封给它的信', !!row, JSON.stringify(row));
ok('没发出去 → 留在重试队列', row && row.status === 'queued', row && row.status);
ok('失败原因记的是服务商 5xx', !!row && String(row.last_error || '').indexOf('mail_500') === 0, row && row.last_error);
ok('假服务商确实被打了', hits.length >= 1, String(hits.length));

r = await req(BASE, '/admin/mail', { j: admin });
ok('后台邮件页 200', r.status === 200, r.status);
ok('标题是「邮件送达」', r.text.indexOf('📮 邮件送达') >= 0);
ok('有概览与送达率', r.text.indexOf('📊 概览') >= 0 && r.text.indexOf('送达率') >= 0);
ok('有抑制名单区', r.text.indexOf('🚫 抑制名单') >= 0);
ok('有最近退信区', r.text.indexOf('↩️ 最近退信') >= 0);
ok('有服务商回调区', r.text.indexOf('🔗 服务商回调') >= 0);
ok('回调已启用（配了密钥）', r.text.indexOf('回调地址') >= 0 && r.text.indexOf('MAIL_WEBHOOK_SECRET') >= 0);
ok('页面带上了抑制表单动作', r.text.indexOf('action="/admin/mail/suppress"') >= 0);

console.log('');
console.log('=== 二、Express 线：权限与抑制/解除 ===');
r = await req(BASE, '/admin/mail', { redirect: 'manual' });
ok('未登录 GET /admin/mail 跳登录', r.status === 302 && r.location.indexOf('/login?next=%2Fadmin%2Fmail') === 0, r.status + ' ' + r.location);
r = await req(BASE, '/admin/mail/suppress', { method: 'POST', form: { address: addr }, redirect: 'manual' });
ok('未登录 POST /admin/mail/suppress 403', r.status === 403, r.status + ' ' + r.text.slice(0, 80));

r = await req(BASE, '/admin/mail/suppress', { method: 'POST', j: admin, form: { address: 'not-an-email' }, redirect: 'manual' });
ok('坏地址 → 302 ?ok=bad', r.status === 302 && r.location === '/admin/mail?ok=bad', r.status + ' ' + r.location);

r = await req(BASE, '/admin/mail/suppress', { method: 'POST', j: admin, form: { address: addr, reason: '探针手动拉黑' }, redirect: 'manual' });
ok('拉黑成功 → 302 ?ok=suppress', r.status === 302 && r.location === '/admin/mail?ok=suppress', r.status + ' ' + r.location);
row = dbRows('SELECT * FROM mail_suppression WHERE address = ? COLLATE NOCASE', addr)[0];
ok('抑制名单里有它', !!row, JSON.stringify(row));
ok('来源记 manual、原因记原话', row && row.source === 'manual' && row.reason === '探针手动拉黑', row && row.source + '/' + row.reason);
let outRow = dbRows('SELECT * FROM mail_outbox WHERE to_addr = ? ORDER BY id DESC', addr)[0];
ok('排队的那封就地判失败', outRow && outRow.status === 'failed', outRow && outRow.status);
ok('失败原因写成 suppressed', outRow && String(outRow.last_error || '').indexOf('suppressed:') === 0, outRow && outRow.last_error);
ok('不再有重试时间', outRow && !outRow.next_attempt_at, outRow && String(outRow.next_attempt_at));

r = await req(BASE, '/admin/mail', { j: admin });
ok('后台页列出该地址与来源', r.text.indexOf(addr) >= 0 && r.text.indexOf('探针手动拉黑') >= 0);

console.log('');
console.log('=== 三、Express 线：名单真的挡住投递 ===');
const before = dbRows('SELECT COUNT(*) AS c FROM mail_outbox WHERE to_addr = ?', addr)[0].c;
const hitsBefore = hits.length;
r = await req(BASE, '/account/resend', { method: 'POST', j: ck, redirect: 'manual' });
ok('重发验证邮件仍回 302', r.status === 302, r.status + ' ' + r.location);
ok('没有因此再入队一封', dbRows('SELECT COUNT(*) AS c FROM mail_outbox WHERE to_addr = ?', addr)[0].c === before, String(before));
ok('假服务商没收到新投递', hits.length === hitsBefore, hits.length + '/' + hitsBefore);
ok('服务端日志打了 [mail:suppressed]', logsText().indexOf('[mail:suppressed]') >= 0);

r = await req(BASE, '/admin/mail/unsuppress', { method: 'POST', j: admin, form: { address: addr }, redirect: 'manual' });
ok('解除成功 → 302 ?ok=unsuppress', r.status === 302 && r.location === '/admin/mail?ok=unsuppress', r.status + ' ' + r.location);
ok('名单里没有了', dbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addr)[0].c === 0);
ok('历史那封仍是失败（不追回）', dbRows('SELECT status FROM mail_outbox WHERE to_addr = ? ORDER BY id DESC', addr)[0].status === 'failed');
r = await req(BASE, '/admin/mail/unsuppress', { method: 'POST', j: admin, form: { address: addr }, redirect: 'manual' });
ok('重复解除 → 302 ?ok=missing', r.status === 302 && r.location === '/admin/mail?ok=missing', r.status + ' ' + r.location);

console.log('');
console.log('=== 四、Express 线：退信回调全分支 ===');
const hook = (body, token, qs) => req(BASE, '/webhooks/mail-bounce' + (qs || ''), {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  json: body, redirect: 'manual'
});
r = await hook({ type: 'email.bounced', data: { to: [addrOf('b')] } }, 'wrong-token');
ok('令牌不对 → 403 forbidden', r.status === 403 && r.json && r.json.error === 'forbidden', r.status + ' ' + r.text.slice(0, 80));
r = await hook({ type: 'email.bounced', data: { to: [addrOf('b')] } }, '');
ok('没带令牌 → 403', r.status === 403, r.status + ' ' + r.text.slice(0, 80));

const addrB = addrOf('b');
cleanups.push(addrB);
r = await hook({ type: 'email.bounced' }, SECRET);
ok('没有收件人 → 400 no_recipient', r.status === 400 && r.json && r.json.error === 'no_recipient', r.status + ' ' + r.text.slice(0, 80));
r = await hook({ type: 'email.delivered', data: { to: [addrB] } }, SECRET);
ok('送达事件只回 200 不入名单', r.status === 200 && r.json && r.json.ignored === 'email.delivered' && r.json.suppressed === 0, r.status + ' ' + r.text.slice(0, 120));
ok('送达事件确实没进名单', dbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrB)[0].c === 0);

r = await hook({ type: 'email.bounced', data: { to: [addrB], bounce: { message: 'mailbox not found' } } }, SECRET);
ok('退信事件 → 200 抑制 1 个', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 160));
row = dbRows('SELECT * FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrB)[0];
ok('进了名单且来源是 bounce', !!row && row.source === 'bounce', JSON.stringify(row));
ok('原因带上服务商原话', !!row && String(row.reason).indexOf('provider:') === 0 && String(row.reason).indexOf('mailbox not found') >= 0, row && row.reason);
ok('审计里留了 mail.bounce', dbRows("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'mail.bounce'")[0].c >= 1);
r = await hook({ type: 'email.bounced', data: { to: [addrB] } }, SECRET);
ok('同一地址再来一次仍 200（幂等）', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 120));

const addrC = addrOf('c');
cleanups.push(addrC);
r = await req(BASE, '/webhooks/mail-bounce?token=' + encodeURIComponent(SECRET) + '&to=' + encodeURIComponent(addrC) + '&type=hard_bounce', { method: 'POST', json: {}, redirect: 'manual' });
ok('查询串写法也能抑制', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 120));
ok('查询串那个地址进了名单', dbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrC)[0].c === 1);

const addrD = addrOf('d');
cleanups.push(addrD);
r = await hook({ to: addrD, type: 'email.complained', reason: '用户点了投诉' }, SECRET);
ok('投诉（complained）也进名单', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 160));

console.log('');
console.log('=== 五、进程内：sendMail / deliverNow 的闸门 ===');
process.env.MAIL_API_URL = 'http://127.0.0.1:' + providerPort + '/emails';
process.env.RESEND_API_KEY = '';
const mail = await import('../src/mail.js');
const outbox = await import('../src/outbox.js');
const addrE = addrOf('e');
cleanups.push(addrE);
outbox.suppress(addrE, '进程内探针', 'manual');
const send = await mail.sendMail({ to: addrE, subject: '探针', text: '不该发出去' });
ok('sendMail 对名单里的地址直接拒发', send.ok === false && send.suppressed === true && send.error === 'suppressed', JSON.stringify(send));
const hitsBefore5 = hits.length;
const del = await mail.deliverNow({ to: addrE, subject: '探针', text: '不该发出去' });
ok('deliverNow 同样不投递', del.ok === false && del.error === 'suppressed', JSON.stringify(del));
ok('假服务商一次都没收到', hits.length === hitsBefore5, hits.length + '/' + hitsBefore5);
ok('没给名单地址落新行', dbRows('SELECT COUNT(*) AS c FROM mail_outbox WHERE to_addr = ?', addrE)[0].c === 0);

console.log('');
console.log('=== 六、Worker 线（serve-worker + 本地 D1） ===');
const { createWorkerServer } = await import('./serve-worker.mjs');
for (const f of [WDB, WDB + '-wal', WDB + '-shm']) await rmQuiet(f);
const ws = await createWorkerServer({ port: 0, db: WDB, adminUser: 'admin', adminPass: 'admin123', env: { MAIL_WEBHOOK_SECRET: SECRET, MAIL_TICK: '0' } });
await ws.warmup();
const WBASE = 'http://127.0.0.1:' + ws.port;
const wdbRows = (sql, ...args) => {
  const d = new DatabaseSync(WDB, { readOnly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};

r = await req(WBASE, '/admin/mail', { redirect: 'manual' });
ok('[worker] 未登录跳登录页', r.status === 302 && r.location.indexOf('/login?next=%2Fadmin%2Fmail') === 0, r.status + ' ' + r.location);
r = await req(WBASE, '/admin/mail/suppress', { method: 'POST', form: { address: 'x@example.com' }, redirect: 'manual' });
ok('[worker] 未登录 POST → 403', r.status === 403, r.status + ' ' + r.text.slice(0, 80));

const wadmin = jar();
r = await req(WBASE, '/login', { method: 'POST', j: wadmin, form: { username: 'admin', password: 'admin123' }, redirect: 'manual' });
ok('[worker] 站长登录 302', r.status === 302, r.status + ' ' + r.location);
r = await req(WBASE, '/admin/mail', { j: wadmin });
ok('[worker] 后台邮件页 200', r.status === 200, r.status);
ok('[worker] 页面同样的区块', r.text.indexOf('📮 邮件送达') >= 0 && r.text.indexOf('🚫 抑制名单') >= 0 && r.text.indexOf('🔗 服务商回调') >= 0);

const addrW = addrOf('w');
r = await req(WBASE, '/admin/mail/suppress', { method: 'POST', j: wadmin, form: { address: addrW, reason: 'worker 探针' }, redirect: 'manual' });
ok('[worker] 手动拉黑 302 ?ok=suppress', r.status === 302 && r.location === '/admin/mail?ok=suppress', r.status + ' ' + r.location);
ok('[worker] 名单里查得到', wdbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrW)[0].c === 1);
r = await req(WBASE, '/admin/mail/unsuppress', { method: 'POST', j: wadmin, form: { address: addrW }, redirect: 'manual' });
ok('[worker] 解除 302 ?ok=unsuppress', r.status === 302 && r.location === '/admin/mail?ok=unsuppress', r.status + ' ' + r.location);
ok('[worker] 名单已清空', wdbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrW)[0].c === 0);

const whook = (body, token, qs) => req(WBASE, '/webhooks/mail-bounce' + (qs || ''), {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  json: body, redirect: 'manual'
});
const addrW2 = addrOf('x');
r = await whook({ type: 'email.bounced', data: { to: [addrW2] } }, 'nope');
ok('[worker] 令牌不对 → 403', r.status === 403 && r.json && r.json.error === 'forbidden', r.status + ' ' + r.text.slice(0, 80));
r = await whook({ type: 'email.bounced' }, SECRET);
ok('[worker] 无收件人 → 400', r.status === 400 && r.json && r.json.error === 'no_recipient', r.status + ' ' + r.text.slice(0, 80));
r = await whook({ type: 'email.delivered', data: { to: [addrW2] } }, SECRET);
ok('[worker] 送达事件被忽略', r.status === 200 && r.json && r.json.ignored === 'email.delivered', r.status + ' ' + r.text.slice(0, 120));
r = await whook({ type: 'email.bounced', data: { to: [addrW2], bounce: { message: 'user unknown' } } }, SECRET);
ok('[worker] 退信 → 抑制 1 个', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 160));
ok('[worker] 进了本地 D1 名单', wdbRows('SELECT COUNT(*) AS c FROM mail_suppression WHERE address = ? COLLATE NOCASE', addrW2)[0].c === 1);
ok('[worker] 审计也记了', wdbRows("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'mail.bounce'")[0].c >= 1);
r = await req(WBASE, '/webhooks/mail-bounce?token=' + encodeURIComponent(SECRET) + '&to=' + encodeURIComponent(addrOf('y')) + '&type=hard_bounce', { method: 'POST', json: {}, redirect: 'manual' });
ok('[worker] 查询串写法同样抑制', r.status === 200 && r.json && r.json.suppressed === 1, r.status + ' ' + r.text.slice(0, 120));
await ws.close();

for (const f of [WDB, WDB + '-wal', WDB + '-shm']) await rmQuiet(f);
const ws2 = await createWorkerServer({ port: 0, db: WDB, env: { MAIL_TICK: '0' } });
await ws2.warmup();
r = await whook2('http://127.0.0.1:' + ws2.port, { type: 'email.bounced', data: { to: [addrOf('z')] } }, SECRET);
ok('[worker] 没配密钥 → 403 not_configured', r.status === 403 && r.json && r.json.error === 'not_configured', r.status + ' ' + r.text.slice(0, 120));
async function whook2(base, body, token) {
  return req(base, '/webhooks/mail-bounce', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, json: body, redirect: 'manual' });
}
await ws2.close();
for (const f of [WDB, WDB + '-wal', WDB + '-shm']) await rmQuiet(f);

/* ---------- 收尾 ---------- */
srv.kill();
provider.close();
await sleep(300);
try {
  for (const a of cleanups.concat([addr])) dbRun('DELETE FROM mail_outbox WHERE to_addr = ?', a);
  for (const a of cleanups.concat([addr])) dbRun('DELETE FROM mail_suppression WHERE address = ? COLLATE NOCASE', a);
  for (const u of users) {
    const urow = dbRows('SELECT id FROM users WHERE username = ?', u)[0];
    if (urow) {
      dbRun('DELETE FROM sessions WHERE user_id = ?', urow.id);
      dbRun('DELETE FROM users WHERE id = ?', urow.id);
    }
  }
} catch (e) { console.log('  （清理时报错，不影响结论：' + e.message + '）'); }
ok('清理后测试账号已删除', users.every((u) => dbRows('SELECT COUNT(*) AS c FROM users WHERE username = ?', u)[0].c === 0));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
