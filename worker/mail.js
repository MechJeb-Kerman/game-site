/**
 * 邮件发送（Workers 版）：逻辑与 src/mail.js 完全一致，唯一区别是配置从 env 读。
 *
 * Express 版读 process.env，Workers 里没有 process.env——Worker 的密钥/vars 都在
 * 请求传入的 env 对象上，所以这里把 env 作为第一个参数透传。
 *
 * 配了 RESEND_API_KEY（或自定义 MAIL_API_URL）就走 HTTP API 真发；
 * 没配就落进「开发发件箱」——打到 Worker 日志并保留最近 50 封。
 * 内存里的「开发发件箱」（outbox()）仍只适合本地预览：Workers 的 isolate 会回收；
 * 真正持久的发件箱是 D1 里的 mail_outbox（worker/outbox.js），失败会退避重试、退信可查。
 */
import { SITE } from '../src/views.js';
import * as outboxStore from './outbox.js';

const OUTBOX = [];
const OUTBOX_MAX = 50;

export function mailConfigured(env) {
  const e = env || {};
  return !!(e.RESEND_API_KEY || e.MAIL_API_URL);
}

export function transportName(env) {
  const e = env || {};
  if (e.RESEND_API_KEY) return 'resend';
  if (e.MAIL_API_URL) return 'http';
  return 'outbox';
}

export function MAIL_FROM(env) {
  const e = env || {};
  return e.MAIL_FROM || (SITE.name + ' <noreply@example.com>');
}

/**
 * 发一封信：先写持久化发件箱（D1 的 mail_outbox，见 worker/outbox.js），再尝试投递，
 * 成功 markSent、失败 markFailed（指数退避重试）。
 * 真实发送失败不抛给调用方，只返回 { ok:false, id, queued, error }。
 * queued=true 表示已排进重试队列（重试循环用 outbox.dueList(env.DB) 捞它）。
 * 没配传输时维持原样：落「开发发件箱」（日志 + 内存 outbox()），返回 dev:true。
 */
export async function sendMail(env, { to, subject, text, html = '', tag = '' } = {}) {
  const e = env || {};
  const mail = {
    to: String(to || ''),
    subject: String(subject || ''),
    text: String(text || ''),
    html: String(html || ''),
    tag,
    at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };
  if (!mail.to) return { ok: false, id: 0, queued: false, error: 'no_recipient' };

  // 抑制名单：退信过 / 后台手动拉黑的地址不再真发（enqueue 里也有一道闸，这里挡的是 HTTP 直投那条路）
  if (await outboxStore.isSuppressed(e.DB, mail.to)) {
    console.log('[mail:suppressed] 跳过 ' + mail.to + ' | ' + mail.subject);
    return { ok: false, id: 0, queued: false, suppressed: true, error: 'suppressed' };
  }

  const id = await enqueue(e, mail);

  if (!mailConfigured(e)) {
    push(mail);
    console.log('[mail:outbox] → ' + mail.to + ' | ' + mail.subject);
    await markSent(e, id);
    return { ok: true, dev: true, id, queued: false, error: '', mail };
  }

  const d = await deliverNow(e, mail);
  if (!d.ok) {
    const r = await markFailed(e, id, d.error);
    return { ok: false, id, queued: !!(r && r.status === 'queued'), error: d.status ? 'mail_' + d.status : 'mail_network' };
  }
  push(mail);
  await markSent(e, id);
  return { ok: true, dev: false, id, queued: false, error: '', mail };
}

/**
 * 只投递、不动发件箱：把一封信 POST 给邮件服务商（Resend 兼容）。
 * 返回 { ok, status, error }；未配传输时 { ok:false, status:0, error:'not_configured' }。
 * worker/app.js 的补发循环用它重投 dueList() 捞出来的历史记录——走 sendMail 会再入队一条新记录。
 */
export async function deliverNow(env, mail) {
  const e = env || {};
  const to = String((mail && mail.to) || '');
  if (!to) return { ok: false, status: 0, error: 'no_recipient' };
  if (await outboxStore.isSuppressed(e.DB, to)) return { ok: false, status: 0, error: 'suppressed' };
  if (!mailConfigured(e)) return { ok: false, status: 0, error: 'not_configured' };
  const api = e.MAIL_API_URL || 'https://api.resend.com/emails';
  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (e.RESEND_API_KEY || e.MAIL_API_KEY || '')
      },
      body: JSON.stringify({
        from: MAIL_FROM(e), to: [to],
        subject: String(mail.subject || ''), text: String(mail.text || ''),
        html: mail.html ? String(mail.html) : undefined
      })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[mail:error] ' + res.status + ' ' + detail.slice(0, 200));
      return { ok: false, status: res.status, error: 'mail_' + res.status + (detail ? ' ' + detail.trim().slice(0, 200) : '') };
    }
    return { ok: true, status: res.status, error: '' };
  } catch (err) {
    console.error('[mail:error]', err && err.message);
    return { ok: false, status: 0, error: 'mail_network' + (err && err.message ? ': ' + err.message : '') };
  }
}

/** 入队（发件箱写失败不能影响发信本身），返回记录 id；失败返回 0 */
async function enqueue(e, mail) {
  try {
    const r = await outboxStore.enqueue(e.DB, { to: mail.to, subject: mail.subject, text: mail.text, tag: mail.tag });
    return r && r.ok ? r.id : 0;
  } catch (err) {
    console.error('[mail:outbox-error]', err && err.message);
    return 0;
  }
}

/** 标记已投递（同上：发件箱出问题只记日志） */
async function markSent(e, id) {
  if (!id) return;
  try { await outboxStore.markSent(e.DB, id); } catch (err) { console.error('[mail:outbox-error]', err && err.message); }
}

/** 标记失败并安排重试；返回 outbox 的结果（含 status / delay_ms / attempts），出问题返回 null */
async function markFailed(e, id, error) {
  if (!id) return null;
  try { return await outboxStore.markFailed(e, e.DB, id, error); } catch (err) { console.error('[mail:outbox-error]', err && err.message); return null; }
}

function push(mail) {
  OUTBOX.unshift(mail);
  if (OUTBOX.length > OUTBOX_MAX) OUTBOX.length = OUTBOX_MAX;
}

export function outbox(limit = 20) {
  return OUTBOX.slice(0, Math.max(1, Number(limit) || 20));
}

export function clearOutbox() {
  OUTBOX.length = 0;
}

function wrap(title, body, note) {
  return '<div style="font:15px/1.7 system-ui,sans-serif;color:#222;max-width:560px">' +
    '<h2 style="font-size:18px">' + title + '</h2>' + body +
    '<p style="color:#888;font-size:13px;margin-top:24px">' + note + '</p></div>';
}

/** 验证邮箱的邮件 */
export function verifyMail(origin, user, token) {
  const link = origin + '/verify-email?token=' + token;
  return {
    to: user.email || '',
    tag: 'verify',
    link,
    subject: '验证邮箱 · ' + SITE.name,
    text: (user.name || user.username) + '，你好：\n\n请点击下面的链接验证邮箱（24 小时内有效）：\n' + link +
      '\n\n如果这不是你本人的操作，忽略这封邮件即可。',
    html: wrap('验证你的邮箱', '<p>' + (user.name || user.username) + '，你好：</p>' +
      '<p>请点击下面的按钮验证邮箱，链接 24 小时内有效。</p>' +
      '<p><a href="' + link + '" style="display:inline-block;padding:10px 20px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none">验证邮箱</a></p>' +
      '<p style="color:#666;font-size:13px;word-break:break-all">' + link + '</p>',
      '如果不是你本人的操作，忽略这封邮件即可。')
  };
}

/** 重置密码的邮件 */
export function resetMail(origin, user, token) {
  const link = origin + '/reset?token=' + token;
  return {
    to: user.email || '',
    tag: 'reset',
    link,
    subject: '重置密码 · ' + SITE.name,
    text: (user.name || user.username) + '，你好：\n\n我们收到了重置密码的请求，请点击下面的链接设置新密码（30 分钟内有效）：\n' + link +
      '\n\n如果不是你本人申请的，忽略这封邮件，你的密码不会改变。',
    html: wrap('重置密码', '<p>' + (user.name || user.username) + '，你好：</p>' +
      '<p>点击下面的按钮设置新密码，链接 30 分钟内有效。设置成功后所有设备都需要重新登录。</p>' +
      '<p><a href="' + link + '" style="display:inline-block;padding:10px 20px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none">设置新密码</a></p>' +
      '<p style="color:#666;font-size:13px;word-break:break-all">' + link + '</p>',
      '如果不是你本人申请，忽略这封邮件即可。')
  };
}
