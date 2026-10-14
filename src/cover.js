/** 动态生成游戏封面 SVG：渐变 + 装饰 + emoji + 标题，全站零图片文件 */

function xml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

export function coverSvg(game, { w = 640, h = 400 } = {}) {
  const a = game.accent || '#6366f1';
  const b = game.accent2 || '#8b5cf6';
  const title = xml(game.title);
  const emoji = xml(game.emoji || '🎮');
  const cat = xml(game.category ? game.category.name : '小游戏');

  const dots = [];
  for (let y = 40; y < h; y += 40) {
    for (let x = 40; x < w; x += 40) {
      dots.push('<circle cx="' + x + '" cy="' + y + '" r="2" fill="#fff" fill-opacity=".13"/>');
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
</linearGradient>
<radialGradient id="shine" cx="50%" cy="30%" r="75%">
<stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="url(#bg)"/>
${dots.join('')}
<rect width="${w}" height="${h}" fill="url(#shine)"/>
<circle cx="${w / 2}" cy="${h * 0.40}" r="${h * 0.24}" fill="#fff" fill-opacity=".14"/>
<circle cx="${w / 2}" cy="${h * 0.40}" r="${h * 0.30}" fill="none" stroke="#fff" stroke-opacity=".20" stroke-width="3" stroke-dasharray="10 14"/>
<text x="${w / 2}" y="${h * 0.47}" font-size="${h * 0.26}" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
<text x="${w / 2}" y="${h * 0.79}" font-size="${h * 0.125}" font-weight="700" fill="#fff"
      text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',system-ui,sans-serif"
      letter-spacing="1">${title}</text>
<text x="${w / 2}" y="${h * 0.90}" font-size="${h * 0.062}" fill="#fff" fill-opacity=".82"
      text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',system-ui,sans-serif">${cat}</text>
</svg>`;
}

export function ogSvg() {
  return coverSvg(
    { title: '趣玩小游戏', emoji: '🎮', accent: '#6366f1', accent2: '#ec4899', category: { name: '免费在线玩' } },
    { w: 1200, h: 630 }
  );
}
