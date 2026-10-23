import { SITE, esc, fmtNum, gameCard, layout, makeupCheck, pushScript, rewardSummary, rewardsOf } from './core.js';
import { ftext, ftime } from './forum.js';

export function dateList(n = 28, end = '') {
  const base = end ? new Date(end + 'T12:00:00') : new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    const p = (x) => (x < 10 ? '0' + x : String(x));
    out.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
  }
  return out;
}

/**
 * 每日挑战页：每天按日期哈希从已上架游戏里轮换一题。
 * 完成判定由服务端做（当天那款游戏收到一次播放事件即算完成），页面只展示进度，不做客户端申报。
 */
/** ?notice= 文案：补做成功走绿色提示，过期 / 日期不对走橙色提示（与账号页同一套类名） */
export const DAILY_NOTICE_OK = { makeup: '✅ 补做成功，这一天已经记进你的打卡了。' };
export const DAILY_NOTICE_ERR = {
  too_late: '补做只开放最近两天，这一天的题目已经过期了。',
  bad_day: '补做的日期不对，请从下面日历里的「🔁 补做」按钮进来。',
  slug_mismatch: '这一天的题目对不上，没法补做。'
};

export function dailyPage({ origin, user = null, day = '', game = null, stats = null, ledger = null, board = null, notice = '' }) {
  const s = stats || { total: 0, streak: 0, doneToday: false, done: [], slug: '' };
  const done = new Set((s.done || []).map((d) => String(d).slice(0, 10)));
  const loginHref = '/login?next=' + encodeURIComponent('/daily');
  const boardRows = (board && board.rows) || [];
  const okMsg = DAILY_NOTICE_OK[notice] || '';
  const errMsg = DAILY_NOTICE_ERR[notice] || '';

  const todayBox = game
    ? '<div class="panel">' +
        '<div class="sec-head"><h2>🎯 今天的题目</h2><span class="pill">' + esc(day) + '</span></div>' +
        '<div class="grid grid-side">' + gameCard(game) + '</div>' +
        '<p class="dim" style="margin-top:14px">' + esc(game.description || '') + '</p>' +
        '<p style="margin:16px 0 4px">' +
          '<a class="btn btn-primary" href="/game/' + esc(game.slug) + '">开始今日挑战 ›</a>' +
          (s.doneToday ? ' <span class="pill">✅ 今天已打卡</span>' : '') +
        '</p>' +
        '<p class="dim">玩一次上面这款游戏就算完成今天的挑战（服务端按播放事件自动记录，不用手动提交成绩）。每天 0 点换题。</p>' +
      '</div>'
    : '<p class="empty">今天的题目还没准备好，过会儿再来看看</p>';

  const perfect = s.perfect || null;                       // {month,total,done,perfect}：当月全勤进度
  const perfectTxt = perfect ? (perfect.perfect ? '🏅 全勤' : perfect.done + ' / ' + perfect.total) : '—';
  const makeupUsed = Number(s.makeupUsed) || 0;
  const userBox = user
    ? '<div class="stats">' +
        '<div class="stat"><b>' + fmtNum(s.total) + '</b><span>累计打卡（天）</span></div>' +
        '<div class="stat"><b>' + fmtNum(s.streak) + '</b><span>连续打卡（天）</span></div>' +
        '<div class="stat"><b>' + (s.doneToday ? '已打' : '未打') + '</b><span>今日状态</span></div>' +
        '<div class="stat"><b>' + esc(perfectTxt) + '</b><span>本月全勤</span></div>' +
      '</div>' +
      '<p class="dim" style="margin:10px 0 0">漏掉的题最近两天还能补做：补做算进累计天数，但不算连续。' +
        (makeupUsed ? '你已经补做了 ' + fmtNum(makeupUsed) + ' 天。' : '你还没用过补做。') + '</p>'
    : '<p class="dim" style="margin:18px 0"><a href="' + loginHref + '">登录</a> 后才会记录你的打卡与连续天数。</p>';

  // 日历：优先用服务端 stats.calendar.cells（带补做标记），拿不到就按最近 28 天 + done 列表自己拼
  const cells = (s.calendar && Array.isArray(s.calendar.cells) && s.calendar.cells.length)
    ? s.calendar.cells
    : dateList(28, day).map((d) => ({ day: d, done: done.has(d), makeup: 0, today: d === day }));
  const cal = '<div class="chips">' + cells.map((c) => {
      const d = String((c && c.day) || '');
      if (!d) return '';
      const isDone = !!(c && c.done);
      const made = !!(c && c.makeup);
      const title = d + (c && c.today ? '（今天）' : '') + (isDone ? (made ? '（补做完成）' : '（已打卡）') : '（未打卡）');
      const chip = '<span class="chip"' + (isDone ? '' : ' style="opacity:.45"') + ' title="' + esc(title) + '">' +
        (isDone ? (made ? '🔁 ' : '✅ ') : '· ') + esc(d.slice(5)) + '</span>';
      // 只有「漏掉的、还在补做窗口内的」那一格才出按钮（今天直接玩就算打卡，不走补做）
      const canMakeup = user && !isDone && d !== day && makeupCheck(d) === null;
      if (!canMakeup) return chip;
      // data-offline：断网时由 /static/js/offline-wire.js 接管，先入队、联网后自动补传
      return chip + '<form class="chip-act" method="post" action="/daily/makeup" data-offline="这次补做打卡">' +
        '<input type="hidden" name="day" value="' + esc(d) + '">' +
        '<button class="chip chip-btn" type="submit" title="补做 ' + esc(d) + ' 的题目">🔁 补做</button>' +
        '<span class="dim" data-offline-note hidden></span></form>';
    }).join('') + '</div>';

  // 打卡奖励（src/rewards.js）：8 档，与徽章各算一套经验，这里只展示快照进度
  const rw = rewardSummary(s);
  const rewardChip = (r) => '<span class="chip" title="' + esc(r.desc) + '"' + (r.done ? '' : ' style="opacity:.45"') + '>' +
    (r.done ? r.icon : '🔒') + ' ' + esc(r.title) + ' <b>' +
    (r.done ? '已获得 +' + fmtNum(r.reward.xp) : fmtNum(r.now) + '/' + fmtNum(r.need)) + '</b></span>';
  const rewardBox = user
    ? '<div class="panel">' +
        '<div class="sec-head"><h2>🎁 打卡奖励</h2><span class="pill">' + rw.owned + ' / ' + rw.total + ' 档 · ' + fmtNum(rw.xp) + ' 经验</span></div>' +
        '<div class="chips">' + rewardsOf(s).map(rewardChip).join('') + '</div>' +
        '<p class="dim" style="margin:12px 0 0">' + (rw.next
          ? '下一个：' + rw.next.icon + ' ' + esc(rw.next.title) + '，还差 ' + fmtNum(rw.next.left) + '（' + Number(rw.next.percent || 0) + '%）'
          : '八档奖励全部拿满，接下来只剩超越自己 🏆') +
        '。奖励经验与徽章经验可叠加，会一起算进个人主页的等级。</p>' +
      '</div>'
    : '';

  // 奖励流水（第十四批，src/rewards.js 的 user_rewards）：与上面那栏快照不同，这一栏只增不减
  const led = ledger && Number(ledger.total) > 0 ? ledger : null;
  const defByKey = new Map(rewardsOf(s).map((r) => [r.key, r]));
  const ledRows = led ? (led.tiers || []).slice(-6).reverse() : [];
  const ledgerBox = user
    ? '<div class="panel">' +
        '<div class="sec-head"><h2>🏆 奖励流水</h2><span class="pill">' +
          (led ? fmtNum(led.owned) + ' 项 · ' + fmtNum(led.xp) + ' 经验' : '还没有记录') + '</span></div>' +
        (led && led.titles && led.titles.length
          ? '<div class="chips">' + led.titles.map((t) => '<span class="chip">🎖️ ' + esc(t) + '</span>').join('') + '</div>'
          : '<p class="dim" style="margin:0">第一次达成上面任一档时会自动记一笔。</p>') +
        (ledRows.length
          ? '<div class="table-wrap" style="margin-top:12px"><table class="tbl" style="min-width:340px"><thead><tr><th>奖励</th><th>次数</th><th>最近一次</th><th>经验</th></tr></thead><tbody>' +
            ledRows.map((row) => {
              const def = defByKey.get(String(row.tier)) || {};
              return '<tr><td>' + (def.icon || '🏅') + ' ' + esc(def.title || String(row.tier)) + '</td>' +
                '<td>' + fmtNum(row.count) + (String(row.kind) === 'perfect' ? ' 个月' : ' 次') + '</td>' +
                '<td>' + esc(String(row.last_day || '')) + '</td>' +
                '<td>+' + fmtNum(row.amount) + '</td></tr>';
            }).join('') +
            '</tbody></table></div>'
          : '') +
        (led && led.tiers && led.tiers.length > ledRows.length
          ? '<p class="dim" style="margin:8px 0 0">共 ' + fmtNum(led.tiers.length) + ' 档，这里只列最近 6 档。</p>'
          : '') +
        '<p class="dim" style="margin:12px 0 0">这一栏是「拿到就不掉」的发放记录——断签、进度回落都不会把它抹掉，所以它和上一栏会变的快照对不上是正常的。</p>' +
      '</div>'
    : '';

  const boardBox = '<div class="table-wrap"><table class="tbl" style="min-width:320px"><thead><tr><th>#</th><th>玩家</th></tr></thead><tbody>' +
    (boardRows.length
      ? boardRows.map((r, i) => '<tr><td>' + (i + 1) + '</td><td><a href="/u/' + encodeURIComponent(r.username) + '">' + esc(r.name || r.username) + '</a></td></tr>').join('')
      : '<tr><td colspan="2" class="dim">今天还没有人打卡，你可以做第一个</td></tr>') +
    '</tbody></table></div>';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>每日挑战</b></nav>
  <div class="page-head">
    <h1>📅 每日挑战</h1>
    <p class="page-sub">每天换一款游戏，玩一次就算打卡；漏掉的题最近两天还能补做，连续打卡天数会记在你的个人主页上。</p>
  </div>
  ${okMsg ? '<p class="auth-ok">' + esc(okMsg) + '</p>' : ''}${errMsg ? '<p class="auth-err">' + esc(errMsg) + '</p>' : ''}
  ${todayBox}
  ${userBox}
  <div class="panel">
    <div class="sec-head"><h2>🗓️ 最近 28 天</h2><a class="more" href="${user ? '/u/' + encodeURIComponent(user.username) : loginHref}">看我的徽章 ›</a></div>
    ${cal}
  </div>
  ${rewardBox}
  ${ledgerBox}
  <div class="panel">
    <div class="sec-head"><h2>🏅 今日打卡榜</h2><span class="pill">${boardRows.length} / ${(board && board.count) || boardRows.length} 人</span></div>
    ${boardBox}
  </div>
</div>`;
  return layout({
    origin, user, path: '/daily',
    ogImage: origin + '/daily/card.svg',
    title: '每日挑战',
    description: '每天一款游戏，玩一次即打卡；最近两天漏掉的题还能补做。累计与连续打卡天数、当月全勤、今日打卡榜都在这里。',
    content
  });
}

/* ---------- 分享（复制链接 + 卡片预览） ---------- */

/** 分享卡片地址：与 /play/:id/card.svg、/u/:name/card.svg 两条路由一一对应 */
export const replayCardUrl = (origin, id) => origin + '/play/' + encodeURIComponent(String(id ?? '')) + '/card.svg';
export const profileCardUrl = (origin, username) => origin + '/u/' + encodeURIComponent(String(username ?? '')) + '/card.svg';

/**
 * 分享条：复制链接按钮 + 剪贴板不可用时的兜底输入框（默认藏着，复制失败才亮出来让用户手动复制）。
 * 这里只出标记，行为统一由 shareScript() 在 document 级接线；url 必须是绝对地址（社交平台只认绝对 URL）。
 */
export function shareBar(url, label = '🔗 复制链接') {
  return '<div class="share">' +
      '<button class="btn share-btn" type="button" data-share-url="' + esc(url) + '">' + esc(label) + '</button>' +
      '<input class="share-url" type="text" readonly hidden value="' + esc(url) + '" aria-label="要分享的链接">' +
      '<span class="share-msg" role="status" aria-live="polite"></span>' +
    '</div>';
}

/** 分享卡片预览：点开就是那张 SVG 原图（可另存 / 发到聊天里）；图拿不到时由脚本整块藏掉，不留破图 */
export function shareCard(url, alt = '分享预览图') {
  return '<a class="share-card" data-share-card href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="打开或另存这张分享图">' +
      '<img src="' + esc(url) + '" alt="' + esc(alt) + '" loading="lazy" decoding="async">' +
    '</a>';
}

/**
 * 分享行为的内联脚本（全页一段，document 级接线，页面上有几个分享条都管）。
 * 复制顺序：navigator.clipboard（https / localhost 才有）→ execCommand('copy') 兜底 → 都失败就把链接亮出来让用户手动复制。
 * 与站内其它内联脚本同一套写法（IIFE + var + 内联，靠 CSP 的 'unsafe-inline'），不引任何外部脚本。
 */
export function shareScript() {
  return `<script>
(function () {
  function q(root, sel) { return root && root.querySelector ? root.querySelector(sel) : null; }
  function say(root, text, kind) {
    var m = q(root, '.share-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'share-msg' + (kind ? ' ' + kind : '');
  }
  function hideInput(root) { var i = q(root, '.share-url'); if (i) i.hidden = true; }
  function copied(root) { hideInput(root); say(root, '✅ 链接已复制，去粘贴给朋友吧', 'ok'); }
  function manual(root, url) {
    var i = q(root, '.share-url');
    if (i) {
      i.value = url;
      i.hidden = false;
      try { i.focus(); i.select(); } catch (e) {}
    }
    say(root, '浏览器没给剪贴板权限，请手动复制下面的链接', 'warn');
  }
  function legacyCopy(input, url) {
    try {
      input.value = url;
      input.hidden = false;
      input.focus();
      input.select();
      return !!(document.execCommand && document.execCommand('copy'));
    } catch (e) { return false; }
  }
  var btns = document.querySelectorAll('[data-share-url]');
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var root = btn.parentNode;
        var url = location.href || btn.getAttribute('data-share-url') || '';
        function fallback() {
          var input = q(root, '.share-url');
          if (input && legacyCopy(input, url)) copied(root); else manual(root, url);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            var p = navigator.clipboard.writeText(url);
            if (p && p.then) p.then(function () { copied(root); }, fallback); else fallback();
          } catch (e) { fallback(); }
        } else { fallback(); }
      });
    })(btns[i]);
  }
  /* 卡片预览：路由还没上线或图挂了，就把整块藏掉，别在页面上留个破图 */
  var cards = document.querySelectorAll('[data-share-card]');
  for (var j = 0; j < cards.length; j++) {
    (function (card) {
      var img = card.querySelector('img');
      if (!img) { card.hidden = true; return; }
      img.addEventListener('error', function () { card.hidden = true; });
      if (img.complete && img.naturalWidth === 0) card.hidden = true;
    })(cards[j]);
  }
})();
</script>`;
}

/* ---------- 棋谱回放 ---------- */

/** 棋谱回放页：棋谱存在服务端（对局结束那一刻落库），这里只做展示 + 打开播放器 */
export function replayPage({ origin, user = null, replay, game = null, more = [] }) {
  const r = replay || {};
  const title = (game && game.title) || r.game || '对局';
  const moves = Number(r.moveCount) || (r.moves ? r.moves.length : 0);
  const frame = '/games/' + encodeURIComponent(r.game) + '/index.html?replay=' + encodeURIComponent(String(r.id));
  const host = r.hostName || '房主';
  const guest = r.guestName || '挑战者';
  const resultText = r.result === 'draw' ? '🤝 和棋' : r.winner ? '🏆 ' + esc(r.winner) + ' 获胜' : '对局结束';

  const moreBox = more.length
    ? '<div class="panel"><div class="sec-head"><h2>🎬 同款游戏的其它棋谱</h2></div><div class="chips">' +
      more.map((x) => '<a class="chip" href="/replay/' + x.id + '">' + esc(x.hostName || '房主') + ' vs ' + esc(x.guestName || '挑战者') +
        ' <b>' + (x.result === 'draw' ? '和' : esc(x.winner || '')) + ' · ' + (Number(x.moveCount) || 0) + ' 手</b></a>').join('') +
      '</div></div>'
    : '';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span>${game ? '<a href="/game/' + esc(game.slug) + '">' + esc(game.title) + '</a><span>›</span>' : ''}<b>棋谱回放</b></nav>
  <div class="page-head">
    <h1>🎬 棋谱回放</h1>
    <p class="page-sub">${esc(host)} <b>vs</b> ${esc(guest)} · ${resultText} · 共 ${moves} 手${r.plays ? ' · 被看过 ' + fmtNum(r.plays) + ' 次' : ''}</p>
  </div>
  <div class="panel">
    <div class="player" style="--a:${esc((game && game.accent) || '#6366f1')}">
      <div class="player-bar">
        <button class="btn" data-act="fullscreen" type="button">⛶ 全屏</button>
        <a class="btn" href="${esc(frame)}" target="_blank" rel="noopener noreferrer">↗ 新窗口</a>
        ${game ? '<a class="btn" href="/game/' + esc(game.slug) + '">🎮 我也要玩</a>' : ''}
      </div>
      <div class="player-stage" style="--ar:${(game && game.width) || 640}/${(game && game.height) || 640}">
        <iframe id="gameFrame" src="${esc(frame)}" title="${esc(title)} 棋谱回放"
                sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock allow-popups"
                allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope"
                loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
    <p class="player-hint">▶ 播放器在棋盘下方：⏮ 上一手 / ▶ 播放 / ⏭ 下一手，还能调速、跳到最后和复制分享链接。</p>
    <p class="dim" style="margin-top:10px">回放链接：<code>${esc(origin + '/replay/' + r.id)}</code></p>
    ${shareBar(origin + '/replay/' + r.id, '🔗 复制这局棋谱的链接')}
    ${shareCard(replayCardUrl(origin, r.id), host + ' vs ' + guest + ' · ' + title + ' 的分享图')}
  </div>
  ${moreBox}
</div>
${shareScript()}`;
  return layout({
    origin, user, path: '/replay/' + r.id,
    ogImage: replayCardUrl(origin, r.id),
    title: title + ' 棋谱回放',
    description: host + ' 对 ' + guest + ' 的' + title + '对局回放，共 ' + moves + ' 手。',
    content
  });
}

/* ---------- 个人主页 ---------- */

/** 个人主页：只展示公开信息（昵称、等级、徽章、公开计数），邮箱之类一概不出现在这里 */
export function profilePage({ origin, user = null, profile, isSelf = false, counts = null, following = false, notice = '', ratings = [] }) {
  const p = profile || {};
  const c = counts || { followers: 0, following: 0, friends: 0 };
  const uname = encodeURIComponent(p.username || '');
  // 联机天梯（第二轮）：ratings 为空时整段不渲染，旧调用的输出逐字节不变
  const ratingsPanel = Array.isArray(ratings) && ratings.length
    ? '<div class="panel">' +
      '<div class="sec-head"><h2>🏆 联机天梯</h2><a class="more" href="/ladder">看总榜 ›</a></div>' +
      '<div class="table-wrap"><table class="tbl" style="min-width:520px"><thead><tr><th>棋类</th><th>分数</th><th>局数</th><th>胜-负-和</th><th>最高分</th><th>排名</th></tr></thead><tbody>' +
      ratings.map((r) => '<tr>' +
        '<td>' + esc(r.title || r.game || '') + '</td>' +
        '<td><b>' + (Number(r.rating) || 0) + '</b></td>' +
        '<td>' + fmtNum(r.games) + '</td>' +
        '<td>' + fmtNum(r.wins) + '-' + fmtNum(r.losses) + '-' + fmtNum(r.draws) + '</td>' +
        '<td>' + (Number(r.peak) || 0) + '</td>' +
        '<td>#' + (Number(r.rank) || 0) + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>' +
      '</div>'
    : '';
  // 关注是表单 POST（无 JS 也能用）；已关注时按钮变成「取消关注」，样式走 ghost 区分
  const actions = isSelf
    ? '<a class="btn" href="/account">账号设置</a>'
    : user
      ? '<form class="inline" action="/u/' + uname + '/follow" method="post">' +
          '<input type="hidden" name="next" value="' + esc('/u/' + uname) + '">' +
          '<button class="btn' + (following ? ' ghost' : '') + '" type="submit">' +
          (following ? '已关注（点击取消）' : '＋ 关注') + '</button></form>' +
        '<a class="btn ghost" href="/messages/' + uname + '">私信</a>'
      : '<a class="btn" href="/login?next=' + encodeURIComponent('/u/' + uname) + '">登录后可关注</a>';
  const initial = String(p.name || p.username || '?').slice(0, 1);
  const badges = p.badges || [];
  const owned = badges.filter((b) => b.done);
  const locked = badges.filter((b) => !b.done);
  const span = Math.max(1, p.xpNext - p.xpFloor);
  const pct = p.xpNeed ? Math.max(4, Math.round((p.xp - p.xpFloor) / span * 100)) : 100;

  const badgeChip = (b) => '<span class="chip" title="' + esc(b.desc) + (b.done ? '' : '（进度 ' + b.now + '/' + b.need + '）') + '"' +
    (b.done ? '' : ' style="opacity:.45"') + '>' + b.icon + ' ' + esc(b.name) +
    (b.done ? '' : ' <b>' + b.now + '/' + b.need + '</b>') + '</span>';

  // 打卡奖励（src/rewards.js）：与徽章同一套进度来源，经验另算、叠加进等级
  const rw = rewardSummary(p);
  const rewardChip = (r) => '<span class="chip" title="' + esc(r.desc) + '"' + (r.done ? '' : ' style="opacity:.45"') + '>' +
    (r.done ? r.icon : '🔒') + ' ' + esc(r.title) + ' <b>' +
    (r.done ? '已获得 +' + fmtNum(r.reward.xp) : fmtNum(r.now) + '/' + fmtNum(r.need)) + '</b></span>';
  const rewardsPanel = '<div class="panel">' +
    '<div class="sec-head"><h2>🎁 打卡奖励</h2><span class="pill">' + rw.owned + ' / ' + rw.total + ' 档 · ' + fmtNum(rw.xp) + ' 经验</span></div>' +
    '<div class="chips">' + rewardsOf(p).map(rewardChip).join('') + '</div>' +
    (rw.next
      ? '<p class="dim" style="margin:12px 0 0">下一个：' + rw.next.icon + ' ' + esc(rw.next.title) + '，还差 ' + fmtNum(rw.next.left) + '（' + Number(rw.next.percent || 0) + '%）</p>'
      : '<p class="dim" style="margin:12px 0 0">八档奖励全部拿满，接下来只剩超越自己 🏆</p>') +
    '</div>';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>个人主页</b></nav>

  <div class="panel">
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <span style="width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-size:28px;font-weight:800;background:linear-gradient(135deg,#6366f1,#22d3ee);color:#fff">${esc(initial)}</span>
      <div style="flex:1;min-width:200px">
        <h1 style="margin:0 0 6px">${esc(p.name || p.username)} <span class="pill">${esc(p.title || '新面孔')}</span></h1>
        <p class="dim" style="margin:0">Lv.${p.level} · ${fmtNum(p.xp)} 经验${p.xpBonus ? '（含打卡奖励 ' + fmtNum(p.xpBonus) + '）' : ''}${p.xpNeed ? ' · 距下一级还差 ' + fmtNum(Math.max(0, p.xpNext - p.xp)) : ' · 已满级'} · ${esc(String(p.joinedAt || '').slice(0, 10))} 加入</p>
        <div style="height:10px;background:rgba(255,255,255,.1);border-radius:999px;overflow:hidden;margin-top:10px">
          <i style="display:block;height:100%;width:${pct}%;background:linear-gradient(135deg,#6366f1,#22d3ee)"></i>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div>
    </div>
    ${shareBar(origin + '/u/' + uname, isSelf ? '🔗 复制我的主页链接' : '🔗 复制这个主页的链接')}
    ${shareCard(profileCardUrl(origin, p.username), (p.name || p.username || '玩家') + ' 的主页分享图')}
  </div>

  ${notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : ''}

  <div class="stats">
    <a class="stat" href="/u/${uname}/followers"><b>${fmtNum(c.followers)}</b><span>粉丝</span></a>
    <a class="stat" href="/u/${uname}/following"><b>${fmtNum(c.following)}</b><span>关注</span></a>
    <a class="stat" href="/u/${uname}/friends"><b>${fmtNum(c.friends)}</b><span>好友（互关）</span></a>
    <div class="stat"><b>${fmtNum(p.comments)}</b><span>评论</span></div>
    <div class="stat"><b>${fmtNum(p.favorites)}</b><span>收藏</span></div>
    <div class="stat"><b>${fmtNum(p.ratings)}</b><span>评分</span></div>
    <div class="stat"><b>${fmtNum(p.threads)}</b><span>论坛主题</span></div>
    <div class="stat"><b>${fmtNum(p.replies)}</b><span>论坛回复</span></div>
    <div class="stat"><b>${fmtNum(p.daily)}</b><span>每日打卡</span></div>
    <div class="stat"><b>${fmtNum(p.streak)}</b><span>连续天数</span></div>
    <div class="stat"><b>${fmtNum(p.days)}</b><span>加入天数</span></div>
  </div>

  <div class="panel">
    <div class="sec-head"><h2>🏅 成就徽章</h2><span class="pill">${owned.length} / ${badges.length}</span></div>
    <div class="chips">${owned.map(badgeChip).join('') || '<span class="dim">还没有解锁任何徽章</span>'}</div>
    ${locked.length ? '<h3 class="sub" style="margin-top:18px">未解锁</h3><div class="chips">' + locked.map(badgeChip).join('') + '</div>' : ''}
  </div>
  ${rewardsPanel}
${ratingsPanel}
  ${isSelf ? '' : '<p class="dim">只展示公开数据：评论、收藏、评分、论坛发帖与每日打卡。邮箱、登录记录等隐私信息不会出现在这里。</p>'}
  <p class="dim">想有自己的主页？<a href="/register">注册</a> 或 <a href="/login">登录</a> 后就有了，顺手去 <a href="/daily">每日挑战</a> 打卡。</p>
</div>
${shareScript()}`;
  return layout({
    origin, user, path: '/u/' + encodeURIComponent(p.username || ''),
    ogImage: profileCardUrl(origin, p.username),
    title: (p.name || p.username || '玩家') + ' 的主页',
    description: (p.name || p.username) + ' 在' + SITE.name + '的公开主页：等级、徽章与公开数据统计。',
    content
  });
}

/* ---------- 通知中心 / 私信 / 关注列表（第七批：社交） ---------- */

/** 通知与私信存的是毫秒时间戳；论坛那套 ftime 只吃 datetime 字符串，这里另写一个 */
export function sinceTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export const NOTICE_ICON = { reply: '💬', mention: '📣', follow: '➕', message: '✉️', comment: '🗨️', system: '🔔' };
export const NOTICE_TAG = { reply: '回复', mention: '提到你', follow: '关注', message: '私信', comment: '评论', system: '系统' };

/** 通知指向哪里：只认站内类型，认不出来就不给按钮 */
export function noticeHref(type, id) {
  const t = String(type || '').toLowerCase();
  const v = String(id || '');
  if (!v) return '';
  if (t === 'thread') return '/forum/t/' + encodeURIComponent(v);
  if (t === 'game') return '/game/' + encodeURIComponent(v);
  if (t === 'user') return '/u/' + encodeURIComponent(v);
  if (t === 'replay') return '/replay/' + encodeURIComponent(v);
  if (t === 'daily') return '/daily';
  return '';
}

/** 列表分页：与论坛共用同一套 .pager 标记，两种页面长得一样 */
export function listPager(base, page, pages) {
  if (pages <= 1) return '';
  const href = (p) => base + (base.indexOf('?') < 0 ? '?' : '&') + 'page=' + p;
  return '<nav class="pager" aria-label="分页">' +
    (page > 1 ? '<a class="pg" href="' + esc(href(page - 1)) + '" rel="prev">‹ 上一页</a>' : '<span class="pg off">‹ 上一页</span>') +
    '<span class="pg-info">' + page + ' / ' + pages + ' 页</span>' +
    (page < pages ? '<a class="pg" href="' + esc(href(page + 1)) + '" rel="next">下一页 ›</a>' : '<span class="pg off">下一页 ›</span>') +
  '</nav>';
}

/** 通知中心：谁、做了什么、指向哪里一眼看完；未读带竖线与底色 */
export function notificationsPage({ origin, user, list = null, page = 1, notice = '' }) {
  const l = list || { total: 0, unread: 0, items: [] };
  const items = l.items || [];
  const pages = Math.max(1, Math.ceil(Number(l.total || 0) / 20));
  const rows = items.map((n) => {
    const href = noticeHref(n.targetType, n.targetId);
    const who = n.actorName
      ? '<a href="/u/' + encodeURIComponent(n.actorName) + '">' + esc(n.actorName) + '</a>'
      : '系统';
    return '<li class="note-item' + (n.read ? '' : ' unread') + '">' +
      '<span class="note-ico" aria-hidden="true">' + (NOTICE_ICON[n.kind] || '🔔') + '</span>' +
      '<div class="note-main">' +
        '<p class="note-head">' + who + '<span class="pill">' + esc(NOTICE_TAG[n.kind] || '通知') + '</span>' +
        '<span class="dim">' + esc(sinceTime(n.createdAt)) + '</span></p>' +
        '<p class="note-body">' + ftext(n.body || '') + '</p>' +
      '</div>' +
      (href ? '<a class="btn btn-sm ghost" href="' + esc(href) + '">去看看</a>' : '') +
    '</li>';
  }).join('');

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>通知</b></nav>
  <div class="sec-head">
    <h2>🔔 通知</h2>
    <span class="pill">${Number(l.unread) ? fmtNum(l.unread) + ' 条未读 · ' : ''}共 ${fmtNum(l.total)} 条</span>
  </div>
  ${notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : ''}
  ${Number(l.unread) ? '<form class="inline" method="post" action="/notifications/read"><input type="hidden" name="next" value="/notifications"><button class="btn btn-sm ghost" type="submit">全部标为已读</button></form>' : ''}
  ${items.length
    ? '<ul class="note-list">' + rows + '</ul>' + listPager('/notifications', page, pages)
    : '<div class="panel"><p class="dim">还没有通知。别人回复你的帖子、在帖子里 @你、关注你或给你发私信时，这里会有记录。</p></div>'}
  <div class="panel" id="pushBox" hidden>
    <h3>🔔 浏览器推送</h3>
    <p class="dim" id="pushHint">正在检查推送配置…</p>
    <button class="btn" type="button" id="pushToggle" hidden>开启浏览器推送</button>
  </div>
  ${pushScript()}
  <p class="dim">通知只按站内动作生成，同一件事 10 分钟内只提醒一次。</p>
</div>`;
  return layout({
    origin, user, path: '/notifications', title: '通知', noindex: true,
    description: '站内通知：回复、提到、关注与私信。', content
  });
}

/** 动态的图标与动作标签：一眼看出这条是玩 / 评论 / 发帖 / 打卡 */
export const FEED_META = {
  play: { icon: '🎮', tag: '在玩' },
  comment: { icon: '💬', tag: '评论' },
  thread: { icon: '📣', tag: '发帖' },
  daily: { icon: '🎯', tag: '每日挑战' }
};

/** 动态指向哪里：评论 / 在玩去游戏页、主题去帖子里、打卡去每日挑战；认不出来就不给按钮 */
export function feedHref(it) {
  if (it.kind === 'thread' && it.threadId) return '/forum/t/' + encodeURIComponent(it.threadId);
  if (it.kind === 'daily') return '/daily';
  if (it.gameSlug) return '/game/' + encodeURIComponent(it.gameSlug);
  return '';
}

/**
 * 好友动态流：我关注的人最近在玩什么、说了什么（数据来自 social.friendFeed）。
 * 列表复用通知中心的 .note-* 卡片标记，两种页面长得一样；翻页与论坛共用 listPager。
 * 没登录时也给一页（路由那边本来就拦住了，这里只是别把空 user 渲染成坏页面）。
 */
export function feedPage({ origin, user, list = null, page = 1, notice = '' }) {
  if (!user) {
    const gate = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>好友动态</b></nav>
  <div class="sec-head"><h2>👥 好友动态</h2></div>
  <div class="panel"><p class="dim">登录之后就能看到你关注的人最近在玩什么、说了什么。<a href="/login?next=%2Ffeed">登录</a> · <a href="/register?next=%2Ffeed">注册</a></p></div>
</div>`;
    return layout({
      origin, user: null, path: '/feed', title: '好友动态', noindex: true,
      description: '关注的人最近在玩什么、说了什么。', content: gate
    });
  }

  const l = list || { total: 0, items: [] };
  const items = l.items || [];
  const pages = Math.max(1, Math.ceil(Number(l.total || 0) / 20));
  const rows = items.map((it) => {
    const kind = String(it.kind || '');
    const meta = FEED_META[kind] || { icon: '🔔', tag: '动态' };
    const uname = String(it.username || '');
    const who = esc(it.displayName || uname || '有人');
    // 评论 / 发帖带上游戏名，免得「好玩」两个字不知道在说哪一款
    const game = it.gameTitle ? '《' + esc(it.gameTitle) + '》' : '';
    const body = kind === 'play'
      ? '在玩 ' + (game || esc(it.gameSlug || ''))
      : kind === 'thread'
      ? esc(it.text || '')
      : esc(it.text || '') + (game ? ' · ' + game : '');
    const href = feedHref(it);
    return '<li class="note-item">' +
      '<span class="note-ico" aria-hidden="true">' + meta.icon + '</span>' +
      '<div class="note-main">' +
        '<p class="note-head">' +
          (uname ? '<a href="/u/' + encodeURIComponent(uname) + '">' + who + '</a>' : who) +
          '<span class="pill">' + esc(meta.tag) + '</span>' +
          '<span class="dim">' + esc(sinceTime(it.at)) + '</span>' +
        '</p>' +
        '<p class="note-body">' + body + '</p>' +
      '</div>' +
      (href ? '<a class="btn btn-sm ghost" href="' + esc(href) + '">去看看</a>' : '') +
    '</li>';
  }).join('');

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>好友动态</b></nav>
  <div class="sec-head">
    <h2>👥 好友动态</h2>
    <span class="pill">共 ${fmtNum(l.total)} 条</span>
  </div>
  ${notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : ''}
  ${items.length
    ? '<ul class="note-list">' + rows + '</ul>' + listPager('/feed', page, pages)
    : '<div class="panel"><p class="dim">还没有动态。先关注几个人（在别人主页点一下「关注」），他们玩过的游戏、发过的帖子、打卡记录就会出现在这里。</p></div>'}
  <p class="dim">只显示你关注的人的公开动态：玩过 / 收藏过的游戏、已发布的评论与帖子、每日挑战打卡。同一个人同一款游戏只留最近一条。</p>
</div>`;
  return layout({
    origin, user, path: '/feed', title: '好友动态', noindex: true,
    description: '关注的人最近在玩什么、说了什么。', content
  });
}

/** 私信：会话列表与单条会话共用一个页面，登录后才能进 */
export function messagesPage({ origin, user, threads = null, thread = null, peer = null, notice = '', error = '' }) {
  const okMsg = notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : '';
  const errMsg = error ? '<p class="auth-err">' + esc(error) + '</p>' : '';

  if (peer) {
    const t = thread || { total: 0, items: [] };
    const items = t.items || [];
    const uname = encodeURIComponent(peer.username || '');
    const pname = peer.name || peer.username || '对方';
    const rows = items.map((m) => '<li class="msg' + (m.mine ? ' mine' : '') + '">' +
      '<p class="msg-body">' + ftext(m.body || '') + '</p>' +
      '<p class="msg-time dim">' + esc(sinceTime(m.createdAt)) + (m.mine ? ' · 我' : '') + '</p></li>').join('');
    const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><a href="/messages">私信</a><span>›</span><b>${esc(pname)}</b></nav>
  <div class="sec-head">
    <h2>✉️ 与 ${esc(pname)} 的私信</h2>
    <a class="btn btn-sm ghost" href="/u/${uname}">看主页</a>
  </div>
  ${okMsg}${errMsg}
  ${Number(t.total || 0) > items.length ? '<p class="dim">只显示最近 ' + items.length + ' 条（共 ' + fmtNum(t.total) + ' 条）</p>' : ''}
  ${items.length ? '<ul class="msg-list">' + rows + '</ul>' : '<div class="panel"><p class="dim">还没有消息，打个招呼吧。</p></div>'}
  <form class="panel cmt-form" method="post" action="/messages/${uname}">
    <input type="hidden" name="next" value="/messages/${uname}">
    <label for="msgBody" style="display:block;margin-bottom:6px;color:var(--dim)">发消息</label>
    <textarea id="msgBody" name="body" rows="3" maxlength="1000" required placeholder="最多 1000 字，回车换行"></textarea>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
      <button class="btn" type="submit">发送</button>
      <span class="dim">对方会收到站内通知；不想收可以忽略这条消息。</span>
    </div>
  </form>
</div>`;
    return layout({
      origin, user, path: '/messages/' + uname, title: '与 ' + pname + ' 的私信', noindex: true,
      description: '站内私信', content
    });
  }

  const list = threads || { total: 0, items: [] };
  const items = list.items || [];
  const rows = items.map((th) => {
    const uname = encodeURIComponent(th.peerName || '');
    return '<li class="note-item' + (Number(th.unread) ? ' unread' : '') + '">' +
      '<span class="note-ico" aria-hidden="true">✉️</span>' +
      '<div class="note-main">' +
        '<p class="note-head"><a href="/u/' + uname + '">' + esc(th.peerName || '') + '</a>' +
        (Number(th.unread) ? '<span class="pill">' + fmtNum(th.unread) + ' 条未读</span>' : '') +
        '<span class="dim">' + esc(sinceTime(th.lastAt)) + '</span></p>' +
        '<p class="note-body">' + (th.outgoing ? '我：' : '') + ftext(th.lastBody || '') + '</p>' +
      '</div>' +
      '<a class="btn btn-sm ghost" href="/messages/' + uname + '">打开</a>' +
    '</li>';
  }).join('');

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>私信</b></nav>
  <div class="sec-head">
    <h2>✉️ 私信</h2>
    <span class="pill">共 ${fmtNum(list.total)} 个会话</span>
  </div>
  ${okMsg}${errMsg}
  ${items.length
    ? '<ul class="note-list">' + rows + '</ul>'
    : '<div class="panel"><p class="dim">还没有私信。去 <a href="/u/' + encodeURIComponent((user && user.username) || '') + '">自己的主页</a>看看，或在别人的主页上点「私信」。</p></div>'}
  <p class="dim">私信只在本站内，收件人可以在通知里看到；骚扰会被记录并可能封号。</p>
</div>`;
  return layout({
    origin, user, path: '/messages', title: '私信', noindex: true,
    description: '站内私信会话列表', content
  });
}

/** 关注列表：粉丝 / 关注 / 好友（互关）三种视图共用一个页面 */
export function peoplePage({ origin, user, owner, kind = 'followers', list = null, page = 1 }) {
  const KINDS = { followers: '粉丝', following: '关注', friends: '好友' };
  const k = KINDS[kind] ? kind : 'followers';
  const uname = encodeURIComponent((owner && owner.username) || '');
  const oname = (owner && (owner.name || owner.username)) || '玩家';
  const items = (list && list.items) || [];
  const pages = Math.max(1, Math.ceil(Number((list && list.total) || 0) / 24));
  const rows = items.map((u) => '<li class="people-item">' +
    '<a class="note-ico" href="/u/' + encodeURIComponent(u.username || '') + '" aria-hidden="true">🐟</a>' +
    '<div class="note-main">' +
      '<b><a href="/u/' + encodeURIComponent(u.username || '') + '">' + esc(u.displayName || u.username || '') + '</a></b>' +
      '<span class="dim">@' + esc(u.username || '') + (u.since ? ' · ' + esc(sinceTime(u.since)) + ' 起' : '') + '</span>' +
    '</div>' +
    (u.mutual && k !== 'friends' ? '<span class="pill">互关</span>' : '') +
  '</li>').join('');
  const tab = (id, label) => '<a class="chip" href="/u/' + uname + '/' + id + '"' + (id === k ? ' style="border-color:var(--brand)"' : '') + '>' + label + '</a>';

  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><a href="/u/${uname}">${esc(oname)}</a><span>›</span><b>${KINDS[k]}</b></nav>
  <div class="sec-head">
    <h2>${KINDS[k]} · ${esc(oname)}</h2>
    <span class="pill">共 ${fmtNum((list && list.total) || 0)} 人</span>
  </div>
  <div class="chips">${tab('followers', '粉丝')}${tab('following', '关注')}${tab('friends', '好友')}</div>
  ${items.length
    ? '<ul class="people-list" style="margin-top:16px">' + rows + '</ul>' + listPager('/u/' + uname + '/' + k, page, pages)
    : '<div class="panel" style="margin-top:16px"><p class="dim">' + (k === 'followers' ? '还没有人关注 TA' : k === 'following' ? 'TA 还没有关注任何人' : '还没有好友（互相关注后自动成为好友）') + '。</p></div>'}
</div>`;
  return layout({
    origin, user, path: '/u/' + uname + '/' + k, title: KINDS[k] + ' · ' + oname, noindex: true,
    description: oname + ' 的' + KINDS[k] + '列表', content
  });
}

/* ---------- 联机天梯 / 棋谱回放（第二轮：服务端裁判棋类） ---------- */

/** 联机天梯：只统计服务端裁判的四款棋类，按当前赛季（UTC 自然季度）计分 */
export function ladderPage({ origin, user = null, game = '', games = [], board = null, season = '', notice = '' }) {
  const slug = String(game || '');
  const tabs = '<div class="chips ladder-tabs">' + (games || []).map((g) => {
    const on = String(g.slug) === slug;
    return '<a class="chip' + (on ? ' on' : '') + '" href="/ladder?game=' + encodeURIComponent(g.slug) + '"' +
      (on ? ' aria-current="page"' : '') + '>' + esc(g.icon || '🎮') + ' ' + esc(g.title || g.slug) + '</a>';
  }).join('') + '</div>';
  const items = board && Array.isArray(board.items) ? board.items : [];
  const box = items.length
    ? '<div class="table-wrap"><table class="tbl" style="min-width:520px"><thead><tr>' +
      '<th>排名</th><th>玩家</th><th>分数</th><th>局数</th><th>胜-负-和</th><th>最高分</th></tr></thead><tbody>' +
      items.map((r) => '<tr>' +
        '<td>#' + (Number(r.rank) || 0) + '</td>' +
        '<td><a href="/u/' + encodeURIComponent(r.username) + '">' + esc(r.username || '玩家') + '</a></td>' +
        '<td><b>' + (Number(r.rating) || 0) + '</b></td>' +
        '<td>' + fmtNum(r.games) + '</td>' +
        '<td>' + fmtNum(r.wins) + '-' + fmtNum(r.losses) + '-' + fmtNum(r.draws) + '</td>' +
        '<td>' + (Number(r.peak) || 0) + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>'
    : '<p class="empty">这个棋类还没有人下过，去联机开一局试试</p>';
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>联机天梯</b></nav>
  <div class="page-head">
    <h1>🏆 联机天梯</h1>
    <p class="page-sub">只统计服务端裁判的四款棋类；默认按当前赛季（UTC 自然季度）计分，起始 1200 分</p>
  </div>
  ${notice ? '<p class="auth-ok">' + esc(notice) + '</p>' : ''}
  <p class="dim">赛季 <span class="pill">${esc(season)}</span></p>
  ${tabs}
  <div class="panel">
    <div class="sec-head"><h2>🏆 天梯榜</h2><span class="more">共 ${fmtNum(items.length)} 位玩家</span></div>
    ${box}
  </div>
  <p class="dim">分数只由服务端裁判的对局结算；未结束、和棋、认输都按规则计入。赛季切换后从 1200 重新起算。</p>
</div>`;
  return layout({ origin, user, title: '联机天梯', description: '四款棋类的 Elo 天梯榜，按赛季计分。', path: '/ladder', ogImage: '', content });
}

/** 棋谱回放列表：联机对局存档，可按游戏 / 玩家 / 结果 / 日期筛选并分页，也能导出 JSON */
export function replaysPage({ origin, user = null, items = [], total = 0, game = '', games = [], page = 1, pages = 1, filters = {} }) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const slug = String(game || f.game || '');
  const player = String(f.player || '');
  const result = String(f.result || '');
  const fromDay = String(f.fromDay || '');
  const toDay = String(f.toDay || '');
  const mine = f.mine === true && !!user;   // 未登录一律不认「只看我的」（路由与视图两层都这么判）
  /** 当前筛选拼成查询串：chips / 翻页 / 导出按钮共用，翻页不会丢条件；extra 覆盖对应键（空值 = 去掉该条件） */
  const query = (extra) => {
    const e = extra && typeof extra === 'object' ? extra : {};
    const parts = [];
    const put = (k, v) => { if (v) parts.push(k + '=' + encodeURIComponent(v)); };
    put('game', 'game' in e ? e.game : slug);
    put('player', player);
    put('result', result);
    put('from', f.from);
    put('to', f.to);
    if (mine) parts.push('mine=1');
    put('page', e.page);
    return parts.length ? '?' + parts.join('&') : '';
  };
  const tabs = '<div class="chips ladder-tabs">' +
    '<a class="chip' + (slug ? '' : ' on') + '" href="/replays' + query({ game: '' }) + '"' + (slug ? '' : ' aria-current="page"') + '>全部</a>' +
    (games || []).map((g) => {
      const on = String(g.slug) === slug;
      return '<a class="chip' + (on ? ' on' : '') + '" href="/replays' + query({ game: String(g.slug) }) + '"' +
        (on ? ' aria-current="page"' : '') + '>' + esc(g.icon || '🎮') + ' ' + esc(g.title || g.slug) + '</a>';
    }).join('') + '</div>';
  const gameOpts = '<option value="">全部棋类</option>' + (games || []).map((g) =>
    '<option value="' + esc(g.slug) + '"' + (String(g.slug) === slug ? ' selected' : '') + '>' +
      esc(g.icon || '🎮') + ' ' + esc(g.title || g.slug) + '</option>').join('');
  const resultOpts = [['', '全部结果'], ['host', '房主胜'], ['guest', '访客胜'], ['draw', '和棋']].map(([v, t]) =>
    '<option value="' + v + '"' + (v === result ? ' selected' : '') + '>' + t + '</option>').join('');
  const anyFilter = !!(slug || player || result || f.from || f.to || mine);
  const mineBox = user
    ? '<label class="check"><input type="checkbox" name="mine" value="1"' + (mine ? ' checked' : '') + '> 只看我的</label>' +
      '<span class="hint">登录用户的对局按账号匹配；更早的棋谱没有账号字段（只记建房时填的昵称），按昵称回退匹配</span>'
    : '<span class="hint"><a href="/login?next=%2Freplays">登录</a>后可用「只看我的」（按你的账号匹配棋谱，更早的对局回退昵称）</span>';
  const form = '<form class="filters" method="get" action="/replays">' +
    '<select name="game" aria-label="棋类">' + gameOpts + '</select>' +
    '<input name="player" value="' + esc(player) + '" placeholder="玩家名（房主或访客）" maxlength="32" aria-label="玩家名">' +
    '<select name="result" aria-label="结果">' + resultOpts + '</select>' +
    '<label class="check">起始日 <input type="date" name="from" value="' + esc(fromDay) + '"></label>' +
    '<label class="check">结束日 <input type="date" name="to" value="' + esc(toDay) + '"></label>' +
    mineBox +
    '<button class="btn btn-sm" type="submit">筛选</button>' +
    (anyFilter ? '<a class="btn btn-sm" href="/replays">重置</a>' : '') +
    '<a class="btn btn-sm" href="/replays/export.json' + query({}) + '">⬇ 导出 JSON</a>' +
    // 专用格式（第十五批）：SGF 给五子棋/四子棋/黑白棋/跳棋/中国象棋，PGN 给国际象棋，
    // 打包是把每局拆成一个文件的 tar.gz；筛选条件与 JSON 导出共用同一查询串
    '<a class="btn btn-sm" href="/replays/export.sgf' + query({}) + '">⬇ SGF</a>' +
    '<a class="btn btn-sm" href="/replays/export.pgn' + query({}) + '">⬇ PGN</a>' +
    '<a class="btn btn-sm" href="/replays/export.tar.gz' + query({}) + '">⬇ 打包</a>' +
    '</form>';
  const rows = (Array.isArray(items) ? items : []).map((it) => {
    const id = encodeURIComponent(String(it.id == null ? '' : it.id));
    const gslug = encodeURIComponent(String(it.game || slug || ''));
    const res = String(it.result || '');
    const winner = Number(it.winner) || 0;
    const text = res === 'host' ? '房主胜' : res === 'guest' ? '访客胜' : res === 'draw' ? '和棋'
      : winner === 1 ? '房主胜' : winner === 2 ? '访客胜' : '进行中/未结束';
    return '<li class="note-item">' +
      '<span class="note-ico" aria-hidden="true">🎬</span>' +
      '<div class="note-main">' +
        '<p class="note-head"><b>' + esc(it.hostName || '房主') + ' vs ' + esc(it.guestName || '挑战者') + '</b><span class="pill">' + text + '</span></p>' +
        '<p class="note-body">共 ' + (Number(it.moveCount) || 0) + ' 手 · 播放 ' + fmtNum(it.plays) + ' 次 · ' + ftime(it.createdAt) + '</p>' +
      '</div>' +
      '<a class="btn btn-sm" href="/replay/' + id + '">看回放</a>' +
      '<a class="btn btn-sm" href="/game/' + gslug + '">下同款</a>' +
      '</li>';
  }).join('');
  const pn = Number(page) || 1;
  const pt = Number(pages) || 1;
  const href = (n) => '/replays' + query({ page: n });
  const pager = pt > 1
    ? '<nav class="pager" aria-label="分页">' +
      (pn > 1 ? '<a class="pg" href="' + href(pn - 1) + '" rel="prev">‹ 上一页</a>' : '<span class="pg off">‹ 上一页</span>') +
      '<span class="pg-info">第 ' + pn + ' / ' + pt + ' 页</span>' +
      (pn < pt ? '<a class="pg" href="' + href(pn + 1) + '" rel="next">下一页 ›</a>' : '<span class="pg off">下一页 ›</span>') +
      '</nav>'
    : '';
  const empty = anyFilter
    ? '<p class="empty">没有符合条件的棋谱。换个关键词或日期再试，也可以 <a href="/replays">看全部棋谱</a>。</p>'
    : '<p class="empty">还没有棋谱。联机把一局下完（或认输）就会自动存档，这里能看回放。</p>';
  const content = `<div class="wrap page">
  <nav class="crumb"><a href="/">首页</a><span>›</span><b>棋谱回放</b></nav>
  <div class="page-head">
    <h1>🎬 棋谱回放</h1>
    <p class="page-sub">联机棋类的历史对局与回放：点「看回放」进播放器，能逐步复盘每一手。</p>
  </div>
  ${tabs}
  <div class="panel">
    <div class="sec-head"><h2>棋谱</h2><span class="more">共 ${fmtNum(total)} 条</span></div>
    ${form}
    ${rows ? '<ul class="note-list">' + rows + '</ul>' : empty}
    ${pager}
  </div>
</div>`;
  return layout({ origin, user, title: '棋谱回放', description: '联机棋类的历史对局与回放。', path: '/replays', content });
}

