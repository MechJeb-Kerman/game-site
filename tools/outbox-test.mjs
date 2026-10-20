/**
 * 发件箱与失败重试自测：入队 → dueList 挑拣 → 失败指数退避 → 达到上限落 failed → markSent / 退信
 * → stats 计数 → sendMail 集成（注入假 fetch，全程零外网、零真实发信）。
 * Express（node:sqlite）与 Workers（D1 镜像）两条线都跑一遍。
 *
 * 用法：node tools/outbox-test.mjs
 * 数据落在临时目录的 SQLite 文件里：Express 线用 src/outbox.js 的测试钩子 useOutboxStore() 换连接，
 * Worker 线用 tools/d1-local.mjs 的假 D1；不碰 data/games.db，也不占任何端口。
 * 全过打印「通过 N / 失败 M」并 exit 0，有失败 exit 1。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { LocalD1 } from './d1-local.mjs';
import * as exOutbox from '../src/outbox.js';
import * as exMail from '../src/mail.js';
import * as wkOutbox from '../worker/outbox.js';
import * as wkMail from '../worker/mail.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra));
  }
}
export function summary() {
  return { pass, fail };
}

/** 和 src/outbox.js 内部同款的本地时间文本，用来手改 next_attempt_at 造「未到期 / 已到期」 */
function stamp(when) {
  const d = when instanceof Date ? when : new Date(when === undefined ? Date.now() : when);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 假 fetch：按 steps 顺序回（用完重复最后一步）；step.net 表示抛网络异常，step.status>=400 表示失败响应 */
function makeFetch(steps) {
  const list = Array.isArray(steps) ? steps : [steps || {}];
  const calls = [];
  const fn = async (url, opts) => {
    const step = list[Math.min(calls.length, list.length - 1)] || {};
    calls.push({ url: url, opts: opts || {}, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (step.net) throw new Error(step.net);
    return {
      ok: step.status === undefined || step.status < 400,
      status: step.status === undefined ? 200 : step.status,
      text: async () => step.body || ''
    };
  };
  fn.calls = calls;
  return fn;
}

const realFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), 'game-site-outbox-'));
const exDb = new DatabaseSync(join(dir, 'express.db'));
const prevStore = exOutbox.useOutboxStore(exDb);
const wkDb = new LocalD1(join(dir, 'worker.db'));
const wkEnv = {
  DB: wkDb,
  MAIL_API_URL: 'https://mail.test/send',
  MAIL_API_KEY: 'test-key',
  MAIL_FROM: '趣玩小游戏 <noreply@test.local>',
  MAIL_RETRY_BASE_MS: '1000'
};

function exRow(id) {
  return exDb.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id);
}
function wkRow(id) {
  return wkDb.prepare('SELECT * FROM mail_outbox WHERE id = ?').bind(id).first();
}
function setExpressMailEnv(over) {
  delete process.env.RESEND_API_KEY;
  process.env.MAIL_API_URL = 'https://mail.test/send';
  process.env.MAIL_API_KEY = 'test-key';
  process.env.MAIL_FROM = '趣玩小游戏 <noreply@test.local>';
  const o = over || {};
  for (const k of Object.keys(o)) {
    if (o[k] === null) delete process.env[k];
    else process.env[k] = String(o[k]);
  }
}

async function run() {
  console.log('# 一、入队与 dueList（Express 线）');
  setExpressMailEnv();
  delete process.env.MAIL_MAX_ATTEMPTS;
  delete process.env.MAIL_RETRY_BASE_MS;

  const enq = exOutbox.enqueue({ to: 'user@example.com', subject: '验证邮箱', text: '点这里 https://x.test/verify-email?token=abc', tag: 'verify' });
  ok('enqueue 返回 ok + 自增 id', enq.ok === true && enq.id > 0, JSON.stringify(enq));
  ok('enqueue 初始状态是 queued 且立刻可投', enq.status === 'queued' && !!enq.next_attempt_at);
  ok('enqueue 缺收件人 → no_recipient 且不落库', (function () {
    const r = exOutbox.enqueue({ subject: 'x' });
    return r.ok === false && r.error === 'no_recipient' && r.id === 0;
  })());
  ok('空收件人没有写进表里', exDb.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_addr = ''").get().n === 0);

  const due = exOutbox.dueList(new Date(), 50);
  const row = due.find((r) => r.id === enq.id);
  ok('dueList 挑到刚入队的信', !!row);
  ok('dueList 字段原样带出（to_addr/subject/tag）', !!row && row.to_addr === 'user@example.com' && row.subject === '验证邮箱' && row.tag === 'verify');
  ok('dueList 带出正文 body_text', !!row && row.body_text.indexOf('token=abc') > 0);
  ok('dueList 里没有 html 列（持久发件箱只存纯文本）', !!row && row.html === undefined);
  ok('dueList 的 attempts 从 0 起', !!row && row.attempts === 0 && row.last_error === '');

  const later = exOutbox.enqueue({ to: 'later@example.com', subject: '晚点发', text: 'x', tag: '' });
  exDb.prepare('UPDATE mail_outbox SET next_attempt_at = ? WHERE id = ?').run(stamp(Date.now() + 60 * 60 * 1000), later.id);
  ok('未到期的信不被 dueList 挑走', !exOutbox.dueList(new Date(), 100).some((r) => r.id === later.id));
  ok('到点后被 dueList 挑出来', exOutbox.dueList(Date.now() + 2 * 60 * 60 * 1000, 100).some((r) => r.id === later.id));

  const ma = exOutbox.enqueue({ to: 'a@example.com', subject: 'A', text: '', tag: '' });
  const mb = exOutbox.enqueue({ to: 'b@example.com', subject: 'B', text: '', tag: '' });
  exDb.prepare('UPDATE mail_outbox SET next_attempt_at = ? WHERE id = ?').run(stamp(Date.now() - 2000), mb.id);
  exDb.prepare('UPDATE mail_outbox SET next_attempt_at = ? WHERE id = ?').run(stamp(Date.now() - 1000), ma.id);
  const ordered = exOutbox.dueList(new Date(), 100).filter((r) => r.id === ma.id || r.id === mb.id);
  ok('dueList 按 next_attempt_at 升序（早到期的先发）', ordered.length === 2 && ordered[0].id === mb.id && ordered[1].id === ma.id);
  ok('dueList 的 limit 生效', exOutbox.dueList(new Date(), 2).length === 2);
  ok('dueList 非法 limit 回退默认值', exOutbox.dueList(new Date(), 0).length > 0 && exOutbox.dueList(new Date(), 'x').length > 0);

  console.log('# 二、退避参数（默认值 + 环境变量）');
  ok('未配 MAIL_RETRY_BASE_MS 时默认 60 秒', exOutbox.retryBaseMs() === 60000);
  ok('未配 MAIL_MAX_ATTEMPTS 时默认 6 次', exOutbox.maxAttempts() === 6);
  ok('退避上限是 6 小时', exOutbox.RETRY_MAX_MS === 6 * 60 * 60 * 1000);
  ok('backoffMs(1) = 60 秒', exOutbox.backoffMs(1) === 60000);
  ok('backoffMs(2) = 120 秒', exOutbox.backoffMs(2) === 120000);
  ok('backoffMs(3) = 240 秒', exOutbox.backoffMs(3) === 240000);
  const seq = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => exOutbox.backoffMs(n));
  ok('backoffMs 随失败次数严格递增', seq.every((v, i) => i === 0 || v > seq[i - 1]), seq.join(','));
  ok('backoffMs 封顶 6 小时（第 40 次）', exOutbox.backoffMs(40) === 21600000);
  process.env.MAIL_RETRY_BASE_MS = '1000';
  ok('MAIL_RETRY_BASE_MS 覆盖基数（1000ms → 第 1 次 1s）', exOutbox.backoffMs(1) === 1000 && exOutbox.backoffMs(2) === 2000);
  ok('MAIL_MAX_ATTEMPTS 覆盖重试上限', (function () {
    process.env.MAIL_MAX_ATTEMPTS = '2';
    const v = exOutbox.maxAttempts() === 2;
    process.env.MAIL_MAX_ATTEMPTS = 'abc';
    const bad = exOutbox.maxAttempts() === 6;
    delete process.env.MAIL_MAX_ATTEMPTS;
    return v && bad;
  })());

  console.log('# 三、失败退避与落 failed（Express 线）');
  const f1 = exOutbox.enqueue({ to: 'retry@example.com', subject: '重试中的信', text: '正文', tag: 'verify' });
  const r1 = exOutbox.markFailed(f1.id, 'mail_500 boom');
  ok('markFailed 第 1 次仍留在 queued', r1.ok === true && r1.status === 'queued');
  ok('markFailed 第 1 次 attempts=1', r1.attempts === 1);
  ok('markFailed 第 1 次退避 1000ms（base*2^0）', r1.delay_ms === 1000);
  ok('失败原因记进 last_error', exRow(f1.id).last_error === 'mail_500 boom');
  ok('排好了下一次投递时间', !!r1.next_attempt_at && exRow(f1.id).next_attempt_at === r1.next_attempt_at);
  ok('退避期内的信不会被立刻重发', !exOutbox.dueList(new Date(), 100).some((r) => r.id === f1.id));
  ok('退避到点后又被挑出来重发', exOutbox.dueList(Date.now() + 1100, 100).some((r) => r.id === f1.id));
  const r2 = exOutbox.markFailed(f1.id, 'mail_network');
  ok('第 2 次失败退避翻倍到 2000ms', r2.attempts === 2 && r2.delay_ms === 2000);
  const r3 = exOutbox.markFailed(f1.id, 'mail_network');
  ok('第 3 次失败退避到 4000ms（指数退避）', r3.attempts === 3 && r3.delay_ms === 4000);
  ok('退避时间与库里的 attempts 对得上', exRow(f1.id).attempts === 3 && exRow(f1.id).status === 'queued');
  const rMiss = exOutbox.markFailed(999999, 'x');
  ok('未知 id 的 markFailed → not_found', rMiss.ok === false && rMiss.error === 'not_found');

  const f2 = exOutbox.enqueue({ to: 'noretry@example.com', subject: '不重试', text: '', tag: '' });
  const rf = exOutbox.markFailed(f2.id, 'mail_400 bad address', { retry: false });
  ok('retry=false 直接落 failed', rf.status === 'failed' && rf.delay_ms === 0 && rf.next_attempt_at === null);
  ok('failed 再也不会被 dueList 挑', !exOutbox.dueList(Date.now() + 10 * 60 * 60 * 1000, 100).some((r) => r.id === f2.id));

  process.env.MAIL_MAX_ATTEMPTS = '3';
  const f3 = exOutbox.enqueue({ to: 'cap@example.com', subject: '到顶了', text: '', tag: '' });
  exOutbox.markFailed(f3.id, 'e1');
  exOutbox.markFailed(f3.id, 'e2');
  const rCap = exOutbox.markFailed(f3.id, 'e3 最后一搏');
  ok('达到 MAIL_MAX_ATTEMPTS 落 failed', rCap.status === 'failed' && rCap.attempts === 3);
  ok('落 failed 后清空 next_attempt_at（不再重试）', rCap.next_attempt_at === null && exRow(f3.id).next_attempt_at === null);
  ok('落 failed 保留最后的 last_error 供排查', exRow(f3.id).last_error === 'e3 最后一搏');
  delete process.env.MAIL_MAX_ATTEMPTS;

  console.log('# 四、markSent 与 stats');
  const s1 = exOutbox.enqueue({ to: 'sent@example.com', subject: '已投递', text: '', tag: '' });
  const ms = exOutbox.markSent(s1.id);
  ok('markSent → sent 且 changed=1', ms.ok === true && ms.status === 'sent' && ms.changed === 1);
  ok('markSent 后 attempts 记一次', exRow(s1.id).attempts === 1);
  ok('markSent 后不再被 dueList 挑', !exOutbox.dueList(new Date(), 100).some((r) => r.id === s1.id));
  ok('markSent 清空 last_error 与 next_attempt_at', exRow(s1.id).last_error === '' && exRow(s1.id).next_attempt_at === null);
  const msMiss = exOutbox.markSent(999999);
  ok('未知 id 的 markSent → ok:false', msMiss.ok === false && msMiss.changed === 0);
  const st = exOutbox.stats();
  const grouped = exDb.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status').all();
  ok('stats 各状态计数与库里一致', ['queued', 'sent', 'failed', 'bounced'].every((k) => {
    const hit = grouped.find((g) => g.status === k);
    return st[k] === (hit ? hit.n : 0);
  }), JSON.stringify(st));
  ok('stats.total = 各状态之和', st.total === st.queued + st.sent + st.failed + st.bounced && st.total > 0);

  console.log('# 五、退信 markBounced / bounceSummary');
  const b1 = exOutbox.enqueue({ to: 'bounce@example.com', subject: 'B1', text: '', tag: 'verify' });
  const b2 = exOutbox.enqueue({ to: 'Bounce@Example.com', subject: 'B2', text: '', tag: 'reset' });
  const b3 = exOutbox.enqueue({ to: 'bounce@example.com', subject: 'B3', text: '', tag: '' });
  exOutbox.markSent(b3.id);
  const bd = exOutbox.markBounced('bounce@example.com', '550 5.1.1 user unknown');
  ok('markBounced 把该地址排队中的信标 bounced', bd.ok === true && bd.changed === 2, JSON.stringify(bd));
  ok('退信原因写进 last_error', exRow(b1.id).last_error.indexOf('550') === 0);
  ok('已投递(sent)的记录不受退信影响', exRow(b3.id).status === 'sent');
  ok('地址比较忽略大小写', exRow(b2.id).status === 'bounced');
  ok('重复退信幂等（第二次 changed=0）', exOutbox.markBounced('BOUNCE@example.com', 'again').changed === 0);
  const bdNo = exOutbox.markBounced('', 'x');
  ok('markBounced 空地址 → no_recipient', bdNo.ok === false && bdNo.error === 'no_recipient');
  ok('bounced 不再被 dueList 挑', !exOutbox.dueList(Date.now() + 10 * 60 * 60 * 1000, 100).some((r) => r.id === b1.id));
  const bs = exOutbox.bounceSummary(1);
  ok('bounceSummary.count 是退信总数', bs.count === 2);
  ok('bounceSummary 的 limit 生效', bs.rows.length === 1);
  ok('bounceSummary 行里带地址与原因', !!bs.rows[0] && bs.rows[0].to_addr.length > 0 && bs.rows[0].last_error.length > 0);
  const bsAll = exOutbox.bounceSummary();
  ok('bounceSummary 默认返回全部退信', bsAll.rows.length === 2);

  console.log('# 六、sendMail 集成（Express + 假 fetch，不发真网络）');
  ok('clearOutbox() 观测口仍在', (exMail.clearOutbox(), exMail.outbox(5).length === 0));
  setExpressMailEnv();
  const okFetch = makeFetch([{ status: 200 }]);
  globalThis.fetch = okFetch;
  const sentMail = await exMail.sendMail({ to: 'ok@example.com', subject: '验证邮箱 · 测试', text: '正文 https://x.test/verify-email?token=t1', tag: 'verify' });
  ok('sendMail 成功 → ok:true 且非 dev', sentMail.ok === true && sentMail.dev === false);
  ok('sendMail 成功 → 带发件箱 id、queued=false、error 空', sentMail.id > 0 && sentMail.queued === false && sentMail.error === '');
  ok('成功投递在发件箱里落成 sent', exRow(sentMail.id).status === 'sent');
  ok('成功投递清空 last_error', exRow(sentMail.id).last_error === '');
  ok('内存开发发件箱仍能观测到（既有测试的观测口）', exMail.outbox(5).some((m) => m.to === 'ok@example.com'));
  ok('真实走 HTTP：地址用 MAIL_API_URL', okFetch.calls.length === 1 && okFetch.calls[0].url === 'https://mail.test/send');
  ok('MAIL_API_KEY 作为 Bearer 发出', okFetch.calls[0].opts.headers.Authorization === 'Bearer test-key');
  ok('MAIL_FROM 作为 from 发出', okFetch.calls[0].body.from.indexOf('noreply@test.local') > 0);
  ok('收件人与主题过了 HTTP 接口', okFetch.calls[0].body.to[0] === 'ok@example.com' && okFetch.calls[0].body.subject.indexOf('验证邮箱') >= 0);

  const errFetch = makeFetch([{ status: 500, body: 'boom: rate limited' }]);
  globalThis.fetch = errFetch;
  const badMail = await exMail.sendMail({ to: 'bad@example.com', subject: 'B', text: 'x', tag: 'verify' });
  ok('sendMail 失败 → ok:false + mail_500', badMail.ok === false && badMail.error === 'mail_500');
  ok('失败也返回发件箱 id（不是凭空的失败）', badMail.id > 0);
  ok('失败已排进重试队列 → queued=true', badMail.queued === true);
  ok('失败落成 queued + attempts=1', exRow(badMail.id).status === 'queued' && exRow(badMail.id).attempts === 1);
  ok('失败原因带上了服务端原文', exRow(badMail.id).last_error.indexOf('mail_500') === 0 && exRow(badMail.id).last_error.indexOf('rate limited') > 0);
  ok('失败后退避时间已排好', !!exRow(badMail.id).next_attempt_at);

  globalThis.fetch = makeFetch([{ net: 'ECONNREFUSED' }]);
  const netMail = await exMail.sendMail({ to: 'net@example.com', subject: 'N', text: 'x', tag: 'reset' });
  ok('网络异常 → error mail_network + queued=true', netMail.ok === false && netMail.error === 'mail_network' && netMail.queued === true);
  ok('网络异常也算一次 attempts', exRow(netMail.id).attempts === 1);
  ok('网络异常记下原因', exRow(netMail.id).last_error.indexOf('mail_network') === 0);

  const dueRow = exOutbox.dueList(Date.now() + 60 * 1000, 100).find((r) => r.id === netMail.id);
  ok('退避到点后能被 dueList 捞出来重发', !!dueRow);
  exOutbox.markSent(dueRow.id);
  ok('重发成功 → sent 且 attempts 累加到 2', exRow(dueRow.id).status === 'sent' && exRow(dueRow.id).attempts === 2);

  setExpressMailEnv({ MAIL_API_URL: null, MAIL_API_KEY: null, RESEND_API_KEY: null });
  const devFetch = makeFetch([{ status: 200 }]);
  globalThis.fetch = devFetch;
  exMail.clearOutbox();
  const devMail = await exMail.sendMail({ to: 'dev@example.com', subject: '验证邮箱 · dev', text: 'x', tag: 'verify' });
  ok('没配传输仍然 dev:true（既有行为不变）', devMail.ok === true && devMail.dev === true);
  ok('没配传输不发网络请求', devFetch.calls.length === 0);
  ok('没配传输仍落内存发件箱（后台页可见）', exMail.outbox(5).some((m) => m.to === 'dev@example.com'));
  ok('没配传输也写持久发件箱并标 sent', devMail.id > 0 && exRow(devMail.id).status === 'sent');
  const noRcpt = await exMail.sendMail({ to: '', subject: 'x', text: 'x' });
  ok('sendMail 空收件人 → no_recipient 且不入队', noRcpt.ok === false && noRcpt.error === 'no_recipient' && noRcpt.id === 0 && noRcpt.queued === false);

  console.log('# 七、既有导出没被动过（兼容既有测试）');
  setExpressMailEnv();
  ok('MAIL_FROM() 仍读 MAIL_FROM', exMail.MAIL_FROM().indexOf('noreply@test.local') > 0);
  process.env.RESEND_API_KEY = 'resend-key';
  ok('transportName() 仍是 resend / http / outbox 三态', exMail.transportName() === 'resend' && (delete process.env.RESEND_API_KEY, exMail.transportName() === 'http'));
  ok('mailConfigured() 语义不变', exMail.mailConfigured() === true);
  const vm = exMail.verifyMail('https://site.test', { email: 'v@example.com', name: '小玩' }, 'tok123');
  ok('verifyMail 仍返回验证链接与文案', vm.to === 'v@example.com' && vm.tag === 'verify' && vm.subject.indexOf('验证') >= 0 && /verify-email\?token=tok123/.test(vm.text) && vm.html.indexOf('token=tok123') > 0);
  const rmv = exMail.resetMail('https://site.test', { email: 'r@example.com', name: '小玩' }, 'tok456');
  ok('resetMail 仍返回重置链接与文案', rmv.tag === 'reset' && rmv.subject.indexOf('重置') >= 0 && rmv.text.indexOf('/reset?token=tok456') > 0);
  const wvm = wkMail.verifyMail('https://site.test', { email: 'v@example.com', name: '小玩' }, 'tok123');
  ok('worker verifyMail 与 Express 同构', wvm.tag === 'verify' && wvm.text.indexOf('/verify-email?token=tok123') > 0);

  console.log('# 八、Worker + D1 镜像线');
  ok('worker DDL 每条都是单行（D1 的 exec 会按换行切语句）', wkOutbox.OUTBOX_DDL.every((s) => s.indexOf('\n') < 0 && s.indexOf('\r') < 0));
  ok('worker DDL 全为 IF NOT EXISTS（重复执行安全）', wkOutbox.OUTBOX_DDL.every((s) => s.indexOf('IF NOT EXISTS') > 0));
  ok('worker ensureOutbox 幂等', (await wkOutbox.ensureOutbox(wkDb)) === wkDb);
  ok('worker ensureOutbox 缺绑定 → 报错', await wkOutbox.ensureOutbox(null).then(() => false, () => true));
  ok('worker 默认退避基数 60 秒', wkOutbox.backoffMs({}, 1) === 60000 && wkOutbox.backoffMs({ MAIL_RETRY_BASE_MS: '500' }, 2) === 1000);
  ok('worker 退避同样封顶 6 小时', wkOutbox.backoffMs({}, 40) === 21600000);
  ok('worker 默认重试上限 6', wkOutbox.maxAttempts({}) === 6 && wkOutbox.maxAttempts({ MAIL_MAX_ATTEMPTS: '2' }) === 2);

  const fresh = new LocalD1(join(dir, 'fresh.db'));
  const zero = await wkOutbox.stats(fresh);
  ok('空库 stats 全 0', zero.queued === 0 && zero.sent === 0 && zero.failed === 0 && zero.bounced === 0 && zero.total === 0);
  fresh.close();

  const wEnq = await wkOutbox.enqueue(wkDb, { to: 'worker@example.com', subject: 'W1', text: 'body-w', tag: 'verify' });
  ok('worker enqueue → queued + id', wEnq.ok === true && wEnq.id > 0 && wEnq.status === 'queued');
  ok('worker enqueue 缺收件人 → no_recipient', (await wkOutbox.enqueue(wkDb, {})).error === 'no_recipient');
  const wDue = await wkOutbox.dueList(wkDb, new Date(), 50);
  ok('worker dueList 挑到刚入队的信（单行 DDL 能在 D1 建表）', wDue.some((r) => r.id === wEnq.id));
  ok('worker dueList 字段原样', wDue.find((r) => r.id === wEnq.id).to_addr === 'worker@example.com' && wDue.find((r) => r.id === wEnq.id).body_text === 'body-w');
  const wFail = await wkOutbox.markFailed(wkEnv, wkDb, wEnq.id, 'mail_500 w');
  ok('worker markFailed 退避 1000ms', wFail.status === 'queued' && wFail.attempts === 1 && wFail.delay_ms === 1000);
  ok('worker 退避期内不重发', !(await wkOutbox.dueList(wkDb, new Date(), 50)).some((r) => r.id === wEnq.id));
  ok('worker 退避到点后能重发', (await wkOutbox.dueList(wkDb, Date.now() + 1100, 50)).some((r) => r.id === wEnq.id));
  ok('worker markFailed 未知 id → not_found', (await wkOutbox.markFailed(wkEnv, wkDb, 999999, 'x')).error === 'not_found');
  const wSent = await wkOutbox.markSent(wkDb, wEnq.id);
  ok('worker markSent → sent 且 attempts 累加（1 次失败 + 1 次成功 = 2）', wSent.ok === true && wSent.status === 'sent' && (await wkRow(wEnq.id)).attempts === 2);
  await wkOutbox.enqueue(wkDb, { to: 'wb@example.com', subject: 'WB', text: '', tag: '' });
  const wBd = await wkOutbox.markBounced(wkDb, 'WB@Example.com', '550 unknown');
  ok('worker markBounced 忽略大小写', wBd.ok === true && wBd.changed === 1);
  ok('worker 重复退信幂等', (await wkOutbox.markBounced(wkDb, 'wb@example.com', 'x')).changed === 0);
  const wBs = await wkOutbox.bounceSummary(wkDb, 5);
  ok('worker bounceSummary 计数与行', wBs.count === 1 && wBs.rows.length === 1 && wBs.rows[0].last_error.indexOf('550') === 0);
  const wStats = await wkOutbox.stats(wkDb);
  ok('worker stats 各状态一致', wStats.sent === 1 && wStats.bounced === 1 && wStats.total === wStats.queued + wStats.sent + wStats.failed + wStats.bounced);

  globalThis.fetch = makeFetch([{ status: 200 }]);
  const wMailOk = await wkMail.sendMail(wkEnv, { to: 'wok@example.com', subject: '验证邮箱 · worker', text: 'x', tag: 'verify' });
  ok('worker sendMail 成功 → ok:true + id + 非 dev', wMailOk.ok === true && wMailOk.id > 0 && wMailOk.dev === false && wMailOk.queued === false);
  ok('worker 成功投递落 sent', (await wkRow(wMailOk.id)).status === 'sent');
  globalThis.fetch = makeFetch([{ status: 503, body: 'busy' }]);
  const wMailBad = await wkMail.sendMail(wkEnv, { to: 'wbad@example.com', subject: 'W', text: 'x', tag: '' });
  ok('worker sendMail 失败 → mail_503 + queued=true', wMailBad.ok === false && wMailBad.error === 'mail_503' && wMailBad.queued === true);
  ok('worker 失败落 queued + attempts=1 + 原因', (await wkRow(wMailBad.id)).status === 'queued' && (await wkRow(wMailBad.id)).attempts === 1 && (await wkRow(wMailBad.id)).last_error.indexOf('mail_503') === 0);
  const wDevFetch = makeFetch([{ status: 200 }]);
  globalThis.fetch = wDevFetch;
  wkMail.clearOutbox();
  const wDev = await wkMail.sendMail({ DB: wkDb }, { to: 'wdev@example.com', subject: '验证邮箱 · dev', text: 'x', tag: 'verify' });
  ok('worker 没配传输 → dev:true 且不发网络', wDev.ok === true && wDev.dev === true && wDevFetch.calls.length === 0);
  ok('worker 内存发件箱仍可观测', wkMail.outbox(5).some((m) => m.to === 'wdev@example.com'));
  ok('worker dev 路径也写持久发件箱并标 sent', (await wkRow(wDev.id)).status === 'sent');
  ok('worker transportName/mailConfigured 语义不变', wkMail.transportName(wkEnv) === 'http' && wkMail.transportName({}) === 'outbox' && wkMail.mailConfigured(wkEnv) === true);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await run();
  } catch (err) {
    console.error('[outbox-test] 意外异常：', err);
    process.exit(2);
  } finally {
    globalThis.fetch = realFetch;
    try { exOutbox.useOutboxStore(prevStore); } catch (e) { /* 清理失败不影响结论 */ }
    try { exDb.close(); } catch (e) { /* 已关 */ }
    try { wkDb.close(); } catch (e) { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录留就留了 */ }
  }
  const s = summary();
  console.log('通过 ' + s.pass + ' / 失败 ' + s.fail);
  process.exit(s.fail ? 1 : 0);
}
