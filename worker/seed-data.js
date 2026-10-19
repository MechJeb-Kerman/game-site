/** D1 版种子数据：由 src/seed.js 导出生成，两边内容必须保持一致。 */

export const CATEGORIES = [
  {
    "slug": "puzzle",
    "name": "益智",
    "icon": "🧩",
    "sort": 1
  },
  {
    "slug": "action",
    "name": "动作",
    "icon": "⚡",
    "sort": 2
  },
  {
    "slug": "casual",
    "name": "休闲",
    "icon": "🍀",
    "sort": 3
  },
  {
    "slug": "board",
    "name": "棋牌",
    "icon": "♟️",
    "sort": 4
  }
];

export const GAMES = [
  {
    "slug": "2048",
    "title": "2048",
    "subtitle": "合并数字，冲击 2048",
    "description": "用方向键或滑动把相同数字合并，每合并一次数字翻倍。目标是凑出 2048，越往后棋盘越紧张，考验你的规划能力。",
    "category": "puzzle",
    "game_url": "/games/2048/index.html",
    "width": 600,
    "height": 700,
    "orientation": "portrait",
    "tags": [
      "数字",
      "合成",
      "经典",
      "单机"
    ],
    "emoji": "🔢",
    "accent": "#f59e0b",
    "accent2": "#ef4444",
    "license": "自研"
  },
  {
    "slug": "snake",
    "title": "贪吃蛇",
    "subtitle": "越吃越长，别咬到自己",
    "description": "经典诺基亚贪吃蛇。吃下果实身体变长、速度逐渐加快，撞墙或咬到自己即结束。支持方向键与触屏滑动。",
    "category": "action",
    "game_url": "/games/snake/index.html",
    "width": 640,
    "height": 640,
    "orientation": "square",
    "tags": [
      "经典",
      "反应",
      "怀旧",
      "单机"
    ],
    "emoji": "🐍",
    "accent": "#22c55e",
    "accent2": "#15803d",
    "license": "自研"
  },
  {
    "slug": "memory",
    "title": "记忆翻牌",
    "subtitle": "找出所有相同的图案",
    "description": "翻开卡片记住图案位置，用最少的步数配对全部卡片。可选难度，轻松又动脑。",
    "category": "puzzle",
    "game_url": "/games/memory/index.html",
    "width": 640,
    "height": 700,
    "orientation": "square",
    "tags": [
      "记忆",
      "益智",
      "休闲",
      "单机"
    ],
    "emoji": "🃏",
    "accent": "#8b5cf6",
    "accent2": "#6366f1",
    "license": "自研"
  },
  {
    "slug": "whack",
    "title": "打地鼠",
    "subtitle": "30 秒极限手速挑战",
    "description": "地鼠随机冒头，砸中得分，砸空扣时间。30 秒内比拼谁的反应更快，还会出现金色地鼠翻倍加分。",
    "category": "action",
    "game_url": "/games/whack/index.html",
    "width": 640,
    "height": 640,
    "orientation": "square",
    "tags": [
      "反应",
      "手速",
      "休闲",
      "单机"
    ],
    "emoji": "🔨",
    "accent": "#f97316",
    "accent2": "#dc2626",
    "license": "自研"
  },
  {
    "slug": "tictactoe",
    "title": "井字棋",
    "subtitle": "挑战三种 AI 难度",
    "description": "经典三连棋。可选简单、普通、无敌三档 AI，无敌档使用极小化极大算法，你最多只能逼平它。",
    "category": "board",
    "game_url": "/games/tictactoe/index.html",
    "width": 600,
    "height": 700,
    "orientation": "portrait",
    "tags": [
      "对战",
      "AI",
      "经典",
      "单机"
    ],
    "emoji": "⭕",
    "accent": "#06b6d4",
    "accent2": "#0ea5e9",
    "license": "自研"
  },
  {
    "slug": "tetris",
    "title": "俄罗斯方块",
    "subtitle": "消行不停，速度不停",
    "description": "七种方块随机落下，填满整行即可消除。等级越高下落越快，带下一个方块预览与硬降功能。",
    "category": "casual",
    "game_url": "/games/tetris/index.html",
    "width": 480,
    "height": 720,
    "orientation": "portrait",
    "tags": [
      "经典",
      "消除",
      "怀旧",
      "单机"
    ],
    "emoji": "🧱",
    "accent": "#ef4444",
    "accent2": "#f59e0b",
    "license": "自研"
  },
  {
    "slug": "blackhole",
    "title": "黑洞吞噬",
    "subtitle": "吃掉一切，越长越大",
    "description": "操控一颗黑洞在宇宙里吞噬周围的天体，质量越大吸力越强、能吞下的东西越大，但更大的黑洞同样能吃掉你。带冲刺 / 无敌 / 引力爆发与进化分支，模式有「经典 · 无尽吞噬」，键盘、鼠标、触屏与手柄都能玩。",
    "category": "action",
    "game_url": "/games/blackhole/index.html",
    "width": 1080,
    "height": 720,
    "orientation": "landscape",
    "tags": [
      "吞噬",
      "物理",
      "成长",
      "单机"
    ],
    "emoji": "🕳️",
    "accent": "#8b5cf6",
    "accent2": "#06b6d4",
    "license": "自研"
  },
  {
    "slug": "gomoku",
    "title": "五子棋",
    "subtitle": "先连成五子者获胜",
    "description": "15×15 棋盘，黑白轮流落子，横竖斜任意方向先连成五子即胜。自带三档 AI，也可以开房间和好友联机对战。",
    "category": "board",
    "game_url": "/games/gomoku/index.html",
    "width": 640,
    "height": 720,
    "orientation": "portrait",
    "tags": [
      "对战",
      "AI",
      "联机",
      "棋类"
    ],
    "emoji": "⚫",
    "accent": "#38bdf8",
    "accent2": "#6366f1",
    "license": "自研"
  },
  {
    "slug": "xiangqi",
    "title": "中国象棋",
    "subtitle": "楚河汉界，将帅对垒",
    "description": "标准中国象棋规则：马走日、象飞田、炮打隔子，将帅不能照面。支持三档 AI 与联机对战，带走子记录与吃子提示。",
    "category": "board",
    "game_url": "/games/xiangqi/index.html",
    "width": 780,
    "height": 720,
    "orientation": "landscape",
    "tags": [
      "对战",
      "AI",
      "联机",
      "传统"
    ],
    "emoji": "🀄",
    "accent": "#f59e0b",
    "accent2": "#b45309",
    "license": "自研"
  },
  {
    "slug": "chess",
    "title": "国际象棋",
    "subtitle": "八八棋盘上的王者对决",
    "description": "完整国际象棋规则：兵升变、王车易位、吃过路兵，含将军与将杀判定。可选三档 AI，也能联机与好友对弈。",
    "category": "board",
    "game_url": "/games/chess/index.html",
    "width": 780,
    "height": 720,
    "orientation": "landscape",
    "tags": [
      "对战",
      "AI",
      "联机",
      "经典"
    ],
    "emoji": "♞",
    "accent": "#a78bfa",
    "accent2": "#4f46e5",
    "license": "自研"
  },
  {
    "slug": "minesweeper",
    "title": "扫雷",
    "subtitle": "数字提示下的排雷推理",
    "description": "经典扫雷：数字表示周围的地雷数，靠推理找出所有安全格并插旗标雷。支持三档难度、首次点击必安全、右键或长按插旗、计时与最佳成绩记录。",
    "category": "puzzle",
    "game_url": "/games/minesweeper/index.html",
    "width": 620,
    "height": 720,
    "orientation": "portrait",
    "tags": [
      "推理",
      "经典",
      "益智",
      "单机"
    ],
    "emoji": "💣",
    "accent": "#64748b",
    "accent2": "#0ea5e9",
    "license": "自研"
  },
  {
    "slug": "sudoku",
    "title": "数独",
    "subtitle": "每行每列每宫都填满 1-9",
    "description": "标准 9×9 数独：每行、每列、每个 3×3 宫内 1-9 各出现一次。可选难度，支持铅笔候选标记、冲突高亮、提示与撤销，通关后会记录用时。",
    "category": "puzzle",
    "game_url": "/games/sudoku/index.html",
    "width": 620,
    "height": 760,
    "orientation": "portrait",
    "tags": [
      "数字",
      "推理",
      "益智",
      "单机"
    ],
    "emoji": "🔢",
    "accent": "#2563eb",
    "accent2": "#7c3aed",
    "license": "自研"
  },
  {
    "slug": "sokoban",
    "title": "推箱子",
    "subtitle": "把箱子推到目标环上",
    "description": "经典推箱子：你只能推不能拉，一步推错就可能卡死。内置 35 关由易到难，支持撤销、重开与选关面板，全部推到位即过关。",
    "category": "puzzle",
    "game_url": "/games/sokoban/index.html",
    "width": 720,
    "height": 680,
    "orientation": "landscape",
    "tags": [
      "空间",
      "推理",
      "关卡",
      "单机"
    ],
    "emoji": "📦",
    "accent": "#0d9488",
    "accent2": "#f59e0b",
    "license": "自研"
  },
  {
    "slug": "linkup",
    "title": "连连看",
    "subtitle": "两个相同图案，连线转弯不超过两次",
    "description": "找出两个相同图案并用不超过两次转弯的路径连起来即可消除。带连线动画、提示、洗牌与计时模式，消完全部图案即通关。",
    "category": "casual",
    "game_url": "/games/linkup/index.html",
    "width": 720,
    "height": 700,
    "orientation": "landscape",
    "tags": [
      "消除",
      "反应",
      "休闲",
      "单机"
    ],
    "emoji": "🔗",
    "accent": "#f472b6",
    "accent2": "#8b5cf6",
    "license": "自研"
  },
  {
    "slug": "idiom",
    "title": "成语猜猜",
    "subtitle": "六次机会猜出四字成语",
    "description": "中文版猜词游戏：每次猜一个四字成语，逐字给出「位置正确 / 字在词中但位置不对 / 不含此字」的反馈，六次内猜中即胜。每天一题，也能随时随机开局。",
    "category": "puzzle",
    "game_url": "/games/idiom/index.html",
    "width": 620,
    "height": 760,
    "orientation": "portrait",
    "tags": [
      "中文",
      "猜词",
      "每日",
      "单机"
    ],
    "emoji": "🀄",
    "accent": "#dc2626",
    "accent2": "#f59e0b",
    "license": "自研"
  },
  {
    "slug": "connect4",
    "title": "四子棋",
    "subtitle": "重力落子，先连四子者胜",
    "description": "7 列 6 行竖式棋盘，棋子沿重力落下，横、竖、斜任意方向先连成四子即胜。可选三档 AI，也能开房间和好友联机对战。",
    "category": "board",
    "game_url": "/games/connect4/index.html",
    "width": 640,
    "height": 700,
    "orientation": "portrait",
    "tags": [
      "对战",
      "AI",
      "联机",
      "棋类"
    ],
    "emoji": "🔴",
    "accent": "#ef4444",
    "accent2": "#facc15",
    "license": "自研"
  },
  {
    "slug": "reversi",
    "title": "黑白棋",
    "subtitle": "夹住对手的棋子把它翻成自己的颜色",
    "description": "标准奥赛罗规则：8×8 棋盘，落子必须夹住对手的棋子并翻转，无棋可下自动跳过，双方都无棋可下时按子数多寡分胜负。支持三档 AI 与联机对战。",
    "category": "board",
    "game_url": "/games/reversi/index.html",
    "width": 660,
    "height": 720,
    "orientation": "portrait",
    "tags": [
      "对战",
      "AI",
      "联机",
      "棋类"
    ],
    "emoji": "⚪",
    "accent": "#0f766e",
    "accent2": "#38bdf8",
    "license": "自研"
  },
  {
    "slug": "draughts",
    "title": "国际跳棋",
    "subtitle": "强制吃子，连吃到底",
    "description": "8×8 国际跳棋（简化规则）：有吃子时必须吃，可以连吃一串；兵只向前走、到底线升王后可以后退吃子。支持三档 AI 与联机对战，页面内附规则说明。",
    "category": "board",
    "game_url": "/games/draughts/index.html",
    "width": 700,
    "height": 720,
    "orientation": "landscape",
    "tags": [
      "对战",
      "AI",
      "联机",
      "棋类"
    ],
    "emoji": "⚫",
    "accent": "#b45309",
    "accent2": "#f97316",
    "license": "自研"
  },
  {
    "slug": "match3",
    "title": "宝石三消",
    "subtitle": "交换相邻宝石，凑三连以上消除",
    "description": "经典三消玩法：交换相邻两颗宝石，让三颗以上同色连成一线即可消除，消得越多连击越高。带下落补位、连击倍率、无限与限时两种模式，最高分记在本机。",
    "category": "casual",
    "game_url": "/games/match3/index.html",
    "width": 660,
    "height": 780,
    "orientation": "portrait",
    "tags": [
      "消除",
      "休闲",
      "高分",
      "单机"
    ],
    "emoji": "💎",
    "accent": "#8b5cf6",
    "accent2": "#22d3ee",
    "license": "自研"
  },
  {
    "slug": "solitaire",
    "title": "纸牌接龙",
    "subtitle": "把 52 张牌按花色收进四个牌堆",
    "description": "经典克朗代克接龙：7 列牌堆里翻牌理牌，把 A 到 K 按花色收进四个收集区。支持抽 1 / 抽 3、拖拽与双击落位、撤销、挑战模式（抽 3 且禁撤销）与计时计分，可发固定种子的牌局。",
    "category": "casual",
    "game_url": "/games/solitaire/index.html",
    "width": 1040,
    "height": 720,
    "orientation": "landscape",
    "tags": [
      "纸牌",
      "经典",
      "休闲",
      "单机"
    ],
    "emoji": "🃏",
    "accent": "#16a34a",
    "accent2": "#0ea5e9",
    "license": "自研"
  }
];
