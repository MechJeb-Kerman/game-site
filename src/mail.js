/**
 * 邮件发送：零 npm 依赖。
 * 配了 RESEND_API_KEY（或自定义 MAIL_API_URL）就走 HTTP API 真发；
 * 没配就落进「开发发件箱」——打印到控制台并保留最近 50 封，方便本地把流程走完。
 */
import { SITE } from './views.js';

const OUTBOX = [];
const OUTBOX_MAX = 50;

export function mailConfigured() {
  return !!(process.env.RESEND_API_KEY || process.env.MAIL_API_URL);
}

export function transportName() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.MAIL_API_URL) return 'http';
  return 'outbox';
}

export const MAIL_FROM = () => process.env.MAIL_FROM || (SITE.name + ' <noreply@example.com>');

/**
 * 发一封信。真实发送失败不会抛给调用方，只返回 { ok:false, error }，
 * 因为「发不出邮件」不该把注册/找回密码整个流程搞挂。
 */
export async function sendMail({ to, subject, text, html = '', tag = '' }) {
  const mail = {
    to: String(to || ''),
    subject: String(subject || ''),
    text: String(text || ''),
    html: String(html || ''),
    tag,
    at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };
  if (!mail.to) return { ok: false, error: 'no_recipient' };

  if (!mailConfigured()) {
    push(mail);
    console.log('[mail:outbox] → ' + mail.to + ' | ' + mail.subject);
    return { ok: true, dev: true, mail };
  }

  const api = process.env.MAIL_API_URL || 'https://api.resend.com/emails';
  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (process.env.RESEND_API_KEY || process.env.MAIL_API_KEY || '')
      },
      body: JSON.stringify({ from: MAIL_FROM(), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html || undefined })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[mail:error] ' + res.status + ' ' + detail.slice(0, 200));
      return { ok: false, error: 'mail_' + res.status };
    }
    push(mail);
    return { ok: true, dev: false, mail };
  } catch (err) {
    console.error('[mail:error]', err && err.message);
    return { ok: false, error: 'mail_network' };
  }
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
