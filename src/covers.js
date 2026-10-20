/**
 * 23 款游戏的封面图数据表 —— public/covers/*.svg 这套静态封面的唯一事实来源。
 *
 * 谁在用：tools/gen-covers.mjs 按它生图（slug / alt / palette 不另存第二份），
 * Express 线（server.js）与 Cloudflare Workers 线（worker/app.js）都 import 同一份 —— 零依赖、
 * 纯数据、无副作用，Workerd 里直接可用（目标就是「两线一份逻辑」，见 src/sites.js 的先例）。
 *
 * 为什么 SVG 里一个文字都没有：图里写字就得带字体，中文字形在不同系统 / 无头环境里不保证存在
 * （tools/gen-icons.mjs:16-18 为同一理由选了纯几何），而且同一张图没法复用给别的语言。
 * 文字交给页面渲染（卡片标题、<img alt>、aria-label），alt 字段就是为此准备的。
 *
 * 字段口径：
 *   src      站内绝对路径（前导 /），跟着 public/covers/<slug>.svg 走；
 *   alt      一句话中文描述，给读屏与图片加载失败兜底，不写进 SVG；
 *   palette  [主色, 次色, 点缀色]，**主色 = palette[0]**（manifest 的 primary 就是它）。
 *            23 款主色两两 CIE76 ΔE ≥ 20（tools/cover-test.mjs 里断言，工具在那边），
 *            所以别照抄 src/seed.js 的 accent —— 那边有重复值（两处 #8b5cf6、两处 #f59e0b、
 *            两处 #ef4444），直接抄会出「两张封面看着一个色」的问题。
 *
 * 冻结：两个数组都在 import 期 Object.freeze（含 palette），避免某个路由顺手改掉共享表。
 */
export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 675;

function cover(slug, alt, palette) {
  return Object.freeze({ src: '/covers/' + slug + '.svg', alt: alt, palette: Object.freeze(palette) });
}

/** slug → { src, alt, palette } */
export const COVERS = Object.freeze({
  '2048': cover('2048', '2048：合并数字方块', ['#f59e0b', '#ef4444', '#fde68a']),
  blackhole: cover('blackhole', '黑洞吞噬：被引力卷住的星体', ['#6d28d9', '#22d3ee', '#c4b5fd']),
  breakout: cover('breakout', '打砖块：挡板、弹球与成排砖块', ['#a21caf', '#facc15', '#f0abfc']),
  chess: cover('chess', '国际象棋：棋盘与棋子', ['#818cf8', '#e2e8f0', '#c7d2fe']),
  connect4: cover('connect4', '四子棋：重力落子连成四', ['#facc15', '#ef4444', '#fde68a']),
  draughts: cover('draughts', '国际跳棋：棋盘与王棋', ['#4d7c0f', '#ecfccb', '#bef264']),
  gomoku: cover('gomoku', '五子棋：棋盘上的黑白连珠', ['#0ea5e9', '#e2e8f0', '#7dd3fc']),
  idiom: cover('idiom', '成语猜猜：四字猜词的反馈方格', ['#be123c', '#f59e0b', '#fda4af']),
  jump: cover('jump', '跳一跳：蓄力起跳的小方块与平台', ['#84cc16', '#0ea5e9', '#d9f99d']),
  linkup: cover('linkup', '连连看：两次转弯的连线消除', ['#ec4899', '#a78bfa', '#fbcfe8']),
  match3: cover('match3', '宝石三消：成排发光的宝石', ['#d946ef', '#22d3ee', '#f5d0fe']),
  memory: cover('memory', '记忆翻牌：配对翻开的卡牌', ['#c4b5fd', '#34d399', '#ede9fe']),
  minesweeper: cover('minesweeper', '扫雷：数字与地雷方格', ['#94a3b8', '#0ea5e9', '#e2e8f0']),
  plane: cover('plane', '飞机大战：穿梭弹幕的战机', ['#0369a1', '#f97316', '#7dd3fc']),
  reversi: cover('reversi', '黑白棋：棋盘上翻转的双色棋子', ['#134e4a', '#f8fafc', '#5eead4']),
  snake: cover('snake', '贪吃蛇：蜿蜒的蛇身与果实', ['#22c55e', '#facc15', '#bbf7d0']),
  sokoban: cover('sokoban', '推箱子：木箱与目标点', ['#b45309', '#0d9488', '#fcd34d']),
  solitaire: cover('solitaire', '纸牌接龙：摊开的牌列', ['#10b981', '#f8fafc', '#a7f3d0']),
  sudoku: cover('sudoku', '数独：九宫格与点阵数字', ['#2563eb', '#a78bfa', '#93c5fd']),
  tetris: cover('tetris', '俄罗斯方块：下落的方块与消行', ['#dc2626', '#22d3ee', '#fca5a5']),
  tictactoe: cover('tictactoe', '井字棋：三连的圈叉格', ['#22d3ee', '#f472b6', '#a5f3fc']),
  whack: cover('whack', '打地鼠：地洞与挥下的锤子', ['#f97316', '#dc2626', '#fdba74']),
  xiangqi: cover('xiangqi', '中国象棋：楚河汉界与棋子', ['#7c2d12', '#facc15', '#fdba74'])
});

/** 20 个 slug，顺序与 COVERS 的书写顺序一致 */
export const COVER_SLUGS = Object.freeze(Object.keys(COVERS));

/**
 * slug → 封面数据；未知 slug 回 null，不抛。
 * 用 Object.hasOwn 而不是 COVERS[slug] 直取：后者会把 'constructor' / '__proto__' / 'toString'
 * 这类原型链上的名字当成命中（返回一个函数，页面再 .src 就是 undefined），路由带 ?slug= 传进来时
 * 这种输入是可达的。非字符串（undefined / null / 数字 / 对象）同样回 null。
 */
export function coverFor(slug) {
  if (typeof slug !== 'string') return null;
  return Object.hasOwn(COVERS, slug) ? COVERS[slug] : null;
}
