/**
 * fishport.cn 的站点清单 —— 导航页（/nav，以及 fishport.cn / www.fishport.cn 的首页）唯一的数据源。
 *
 * 这里写的是「人能打开的站点」，不是 DNS 记录：邮件（send / rsend / resend._domainkey）、
 * Minecraft 的 SRV 之类的解析记录不导航，因此不在这里（2026-10-18 用户明确：mc 与 send、rsend 不导航）。
 * Express（server.js）、Workers+D1（worker/app.js）与静态导出（tools/build-pages.mjs）三条线共用这一份，
 * 加一个子域只改这个文件。
 *
 * 字段：host 必须与 DNS 里真实存在、真能打开的地址一致；url 省略时按 https://<host>/ 拼；
 * group 决定卡片分组；desc 一句话说清是什么（宁可朴素，也别编）。
 */

/** 门户主机：这些主机名的根路径直接是导航页（其余主机要访问 /nav） */
export const PORTAL_HOSTS = /^(www\.|nav\.)?fishport\.cn$/;

export const SITES = [
  {
    group: '主站',
    host: 'game-site.fishport.cn',
    name: '趣玩小游戏',
    emoji: '🎮',
    accent: '#6366f1',
    accent2: '#8b5cf6',
    desc: '在线小游戏合集：即点即玩，能评分、评论、收藏与投稿'
  },
  {
    group: '主站',
    host: 'forum.fishport.cn',
    name: '趣玩论坛',
    emoji: '💬',
    accent: '#0ea5e9',
    accent2: '#6366f1',
    desc: '社区板块与主题讨论，带审核队列、限流与举报处理'
  },
  {
    group: '自建服务',
    host: 'dsh.fishport.cn',
    name: 'DeepSeek Harness',
    emoji: '🤖',
    accent: '#22c55e',
    accent2: '#0ea5e9',
    desc: '自建的 DSH 网页版：在浏览器里跑 agent（有访问密钥）'
  },
  {
    group: '自建服务',
    host: 'gov.fishport.cn',
    name: '政务平台',
    emoji: '🏛️',
    accent: '#f59e0b',
    accent2: '#ef4444',
    desc: 'dsh-gov-portal 政务门户：把 DSH 的表单与任务搬到网页上（有访问密钥）'
  },
  {
    group: '应用',
    host: 'sm.fishport.cn',
    name: 'StudyMate',
    emoji: '📚',
    accent: '#14b8a6',
    accent2: '#22c55e',
    desc: '我的课程：课件与学习助手（Cloudflare Pages）'
  },
  {
    group: '应用',
    host: 'xs99.fishport.cn',
    name: '奚宋99',
    emoji: '🪧',
    accent: '#f97316',
    accent2: '#ec4899',
    desc: '个人主页（Cloudflare Pages）'
  },
  {
    group: '自建主机',
    host: 'dx.fishport.cn',
    name: 'dx 主机',
    emoji: '🔧',
    accent: '#64748b',
    accent2: '#94a3b8',
    desc: '自建主机上的服务（nginx，具体路径按服务约定）'
  },
  {
    group: '自建主机',
    host: 'lt.fishport.cn',
    name: 'lt 主机',
    emoji: '🔧',
    accent: '#64748b',
    accent2: '#94a3b8',
    desc: '自建主机上的服务'
  },
  {
    group: '自建主机',
    host: 'yd.fishport.cn',
    name: 'yd 主机',
    emoji: '🔧',
    accent: '#64748b',
    accent2: '#94a3b8',
    desc: '自建主机上的服务（nginx）'
  }
];

/** 卡片分组顺序；不在表里的分组排到最后 */
export const GROUP_ORDER = ['主站', '自建服务', '应用', '自建主机'];

export function siteUrl(s) {
  return s.url || ('https://' + s.host + '/');
}

/** 按 group 分组，保持 GROUP_ORDER 的顺序（三条线共用，别在视图里各写一遍） */
export function groupedSites(list = SITES) {
  const byGroup = new Map();
  for (const s of list) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }
  return [...byGroup.keys()]
    .sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map((group) => ({ group, items: byGroup.get(group) }));
}
