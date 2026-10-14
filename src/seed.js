import { db, migrate } from './db.js';

export const CATEGORIES = [
  { slug: 'puzzle', name: '益智', icon: '🧩', sort: 1 },
  { slug: 'action', name: '动作', icon: '⚡', sort: 2 },
  { slug: 'casual', name: '休闲', icon: '🍀', sort: 3 },
  { slug: 'board',  name: '棋牌', icon: '♟️', sort: 4 }
];

/** 游戏元数据：game_url 指向 games/ 下自包含的 HTML5 游戏 */
export const GAMES = [
  {
    slug: '2048', title: '2048', subtitle: '合并数字，冲击 2048',
    description: '用方向键或滑动把相同数字合并，每合并一次数字翻倍。目标是凑出 2048，越往后棋盘越紧张，考验你的规划能力。',
    category: 'puzzle', game_url: '/games/2048/index.html',
    width: 600, height: 700, orientation: 'portrait',
    tags: ['数字', '合成', '经典', '单机'],
    emoji: '🔢', accent: '#f59e0b', accent2: '#ef4444',
    license: '自研'
  },
  {
    slug: 'snake', title: '贪吃蛇', subtitle: '越吃越长，别咬到自己',
    description: '经典诺基亚贪吃蛇。吃下果实身体变长、速度逐渐加快，撞墙或咬到自己即结束。支持方向键与触屏滑动。',
    category: 'action', game_url: '/games/snake/index.html',
    width: 640, height: 640, orientation: 'square',
    tags: ['经典', '反应', '怀旧', '单机'],
    emoji: '🐍', accent: '#22c55e', accent2: '#15803d',
    license: '自研'
  },
  {
    slug: 'memory', title: '记忆翻牌', subtitle: '找出所有相同的图案',
    description: '翻开卡片记住图案位置，用最少的步数配对全部卡片。可选难度，轻松又动脑。',
    category: 'puzzle', game_url: '/games/memory/index.html',
    width: 640, height: 700, orientation: 'square',
    tags: ['记忆', '益智', '休闲', '单机'],
    emoji: '🃏', accent: '#8b5cf6', accent2: '#6366f1',
    license: '自研'
  },
  {
    slug: 'whack', title: '打地鼠', subtitle: '30 秒极限手速挑战',
    description: '地鼠随机冒头，砸中得分，砸空扣时间。30 秒内比拼谁的反应更快，还会出现金色地鼠翻倍加分。',
    category: 'action', game_url: '/games/whack/index.html',
    width: 640, height: 640, orientation: 'square',
    tags: ['反应', '手速', '休闲', '单机'],
    emoji: '🔨', accent: '#f97316', accent2: '#dc2626',
    license: '自研'
  },
  {
    slug: 'tictactoe', title: '井字棋', subtitle: '挑战三种 AI 难度',
    description: '经典三连棋。可选简单、普通、无敌三档 AI，无敌档使用极小化极大算法，你最多只能逼平它。',
    category: 'board', game_url: '/games/tictactoe/index.html',
    width: 600, height: 700, orientation: 'portrait',
    tags: ['对战', 'AI', '经典', '单机'],
    emoji: '⭕', accent: '#06b6d4', accent2: '#0ea5e9',
    license: '自研'
  },
  {
    slug: 'tetris', title: '俄罗斯方块', subtitle: '消行不停，速度不停',
    description: '七种方块随机落下，填满整行即可消除。等级越高下落越快，带下一个方块预览与硬降功能。',
    category: 'casual', game_url: '/games/tetris/index.html',
    width: 480, height: 720, orientation: 'portrait',
    tags: ['经典', '消除', '怀旧', '单机'],
    emoji: '🧱', accent: '#ef4444', accent2: '#f59e0b',
    license: '自研'
  }
];

export function seed(force = false) {
  migrate();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM games').get();
  if (n > 0 && !force) return false;

  if (force) {
    db.exec('DELETE FROM ratings; DELETE FROM play_logs; DELETE FROM games; DELETE FROM categories;');
    try { db.exec('DELETE FROM sqlite_sequence;'); } catch { /* 表可能不存在 */ }
  }

  const insertCat = db.prepare(
    'INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)'
  );
  for (const c of CATEGORIES) insertCat.run(c.slug, c.name, c.icon, c.sort);

  const catId = new Map(
    db.prepare('SELECT id, slug FROM categories').all().map((r) => [r.slug, r.id])
  );

  const insertGame = db.prepare(`
    INSERT INTO games
      (slug, title, subtitle, description, category_id, engine, game_url,
       width, height, orientation, tags, emoji, accent, accent2, plays, rating, license)
    VALUES (?, ?, ?, ?, ?, 'html5', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const g of GAMES) {
    insertGame.run(
      g.slug, g.title, g.subtitle, g.description, catId.get(g.category), g.game_url,
      g.width, g.height, g.orientation, JSON.stringify(g.tags),
      // 新站从 0 开始：play_logs / ratings 会真实累加，不灌假数据
      g.emoji, g.accent, g.accent2, 0, 0, g.license
    );
  }
  return true;
}

// 直接执行： node src/seed.js --force
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const changed = seed(process.argv.includes('--force'));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM games').get();
  console.log(changed ? '✅ 种子数据已写入' : 'ℹ️ 数据库已有数据，跳过（用 --force 重建）');
  console.log('   游戏总数:', n);
}
