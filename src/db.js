import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 项目根目录 / 静态资源目录 / 游戏包目录 */
export const ROOT = join(here, '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const GAMES_DIR = join(ROOT, 'games');
const DATA_DIR = join(ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

/** 使用 Node 22.5+ 内置的 node:sqlite，零原生依赖 */
export const db = new DatabaseSync(join(DATA_DIR, 'games.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      slug   TEXT UNIQUE NOT NULL,
      name   TEXT NOT NULL,
      icon   TEXT DEFAULT '🎮',
      sort   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS games (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      subtitle    TEXT,
      description TEXT,
      category_id INTEGER REFERENCES categories(id),
      engine      TEXT DEFAULT 'html5',
      game_url    TEXT NOT NULL,
      width       INTEGER DEFAULT 800,
      height      INTEGER DEFAULT 600,
      orientation TEXT DEFAULT 'landscape',
      tags        TEXT DEFAULT '[]',
      emoji       TEXT DEFAULT '🎮',
      accent      TEXT DEFAULT '#6366f1',
      accent2     TEXT DEFAULT '#8b5cf6',
      plays        INTEGER DEFAULT 0,
      rating       REAL DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      license      TEXT DEFAULT '自研',
      status      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_games_cat   ON games(category_id);
    CREATE INDEX IF NOT EXISTS idx_games_plays ON games(plays DESC);

    CREATE TABLE IF NOT EXISTS play_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id),
      day        TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_game ON play_logs(game_id);
    CREATE INDEX IF NOT EXISTS idx_logs_day  ON play_logs(day);

    -- 评分：visitor 存投票者标识（接入用户系统后就是登录用户 id），一人一票、可改票
    CREATE TABLE IF NOT EXISTS ratings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      visitor    TEXT NOT NULL,
      stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (game_id, visitor)
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings(game_id);
  `);

  // 用户 / 会话 / 收藏 / 评论：纯 SQLite + node:crypto，不引第三方依赖
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      pass_hash    TEXT NOT NULL,
      pass_salt    TEXT NOT NULL,
      role         TEXT DEFAULT 'user',
      created_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 会话：token 存库，退出即删，过期自然失效（不用 JWT，省得算签名密钥）
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- 收藏：复合主键天然去重，一人一游戏一条
    CREATE TABLE IF NOT EXISTS favorites (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (user_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);

    -- 评论：status 1 可见 / 0 被管理员隐藏（软删除，可恢复）
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      status     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);
  `);

  // 第二批：评论楼中楼 / 举报、后台审计日志、账号增强（邮箱、封禁、OAuth、改密）、搜索拼音索引
  db.exec(`
    -- 举报：同一用户对同一条评论只能报一次（UNIQUE 天然去重）
    CREATE TABLE IF NOT EXISTS comment_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason     TEXT NOT NULL,
      status     INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (comment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON comment_reports(status, id DESC);

    -- 后台操作日志：谁在什么时候把什么改成了什么
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id   INTEGER,
      actor_name TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(id DESC);

    -- 第三方登录：一个本地账号可以绑多个 provider
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider     TEXT NOT NULL,
      provider_uid TEXT NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (provider, provider_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);

    -- 找回密码：一次性 token，用掉即 used_at 落时间
    CREATE TABLE IF NOT EXISTS password_resets (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id);

    -- 投稿上传的单文件 HTML 游戏：正文直接存库（D1 单个值上限约 1MB，投稿限制 512KB）
    CREATE TABLE IF NOT EXISTS game_files (
      slug       TEXT PRIMARY KEY,
      filename   TEXT,
      size       INTEGER DEFAULT 0,
      html       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 公告：站长随时发布/修改/撤回（status 1 已发布 / 0 已撤回，软撤回，评论保留）
    CREATE TABLE IF NOT EXISTS posts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL,
      pinned       INTEGER DEFAULT 0,
      status       INTEGER DEFAULT 1,
      author_id    INTEGER,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      updated_at   TEXT,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, pinned DESC, id DESC);
  `);

  // 第四批：论坛（板块 / 主题 / 楼层 / 编辑留痕 / 举报 / 内容黑名单 / 表单 nonce）
  db.exec(`
    -- 论坛（第四批）：板块 / 主题 / 楼层 / 编辑留痕 / 举报 / 内容黑名单 / 表单 nonce
    CREATE TABLE IF NOT EXISTS forums (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon        TEXT DEFAULT '💬',
      sort        INTEGER DEFAULT 0,
      status      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 主题：status 0 待审 / 1 已发布 / 2 已下架（软删，可恢复）
    CREATE TABLE IF NOT EXISTS forum_threads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      forum_id      INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      status        INTEGER DEFAULT 0,
      pinned        INTEGER DEFAULT 0,
      locked        INTEGER DEFAULT 0,
      reply_count   INTEGER DEFAULT 0,
      view_count    INTEGER DEFAULT 0,
      last_reply_at TEXT,
      created_at    TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_forum  ON forum_threads(forum_id, status, pinned DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_recent ON forum_threads(status, pinned DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_user   ON forum_threads(user_id, id DESC);

    -- 楼层：status 0 待审 / 1 已发布 / 2 已隐藏（软删）；is_op=1 是该主题的首楼
    CREATE TABLE IF NOT EXISTS forum_posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      status     INTEGER DEFAULT 0,
      is_op      INTEGER DEFAULT 0,
      parent_id  INTEGER,
      edited_at  TEXT,
      edit_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_fposts_thread ON forum_posts(thread_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_fposts_user   ON forum_posts(user_id, id DESC);

    -- 编辑留痕：改一次存一条 before/after，站长与楼主都能看到改了什么
    CREATE TABLE IF NOT EXISTS forum_post_edits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
      editor_id   INTEGER NOT NULL REFERENCES users(id),
      before_body TEXT NOT NULL,
      after_body  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_fedits_post ON forum_post_edits(post_id, id DESC);

    -- 举报：同一用户对同一个目标只能报一次（UNIQUE 天然去重）
    CREATE TABLE IF NOT EXISTS forum_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id   INTEGER NOT NULL,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason      TEXT NOT NULL,
      detail      TEXT DEFAULT '',
      status      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (target_type, target_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_freports_status ON forum_reports(status, id DESC);

    -- 内容黑名单：word 子串 / regex 正则；action reject 直接拦，review 只让内容进待审
    CREATE TABLE IF NOT EXISTS forum_blacklist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern    TEXT NOT NULL,
      kind       TEXT DEFAULT 'word',
      action     TEXT DEFAULT 'review',
      note       TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 人机校验用的一次性 nonce（表单页发、提交时核销；没有引第三方验证码）
    CREATE TABLE IF NOT EXISTS form_nonces (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER,
      kind       TEXT DEFAULT '',
      used_at    TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_nonces_created ON form_nonces(created_at);

    -- 第五批：联机对战房间（五子棋 / 中国象棋 / 国际象棋等共用一套房间与走法中继）
    -- 服务端只做轮流与中继：不校验走法合法性、不判胜负，规则在客户端
    CREATE TABLE IF NOT EXISTS play_rooms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE NOT NULL,
      game        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'waiting',
      host_name   TEXT NOT NULL DEFAULT '',
      guest_name  TEXT NOT NULL DEFAULT '',
      host_token  TEXT NOT NULL,
      guest_token TEXT NOT NULL DEFAULT '',
      turn        INTEGER NOT NULL DEFAULT 0,
      move_count  INTEGER NOT NULL DEFAULT 0,
      result      TEXT NOT NULL DEFAULT '',
      rematch     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_play_rooms_game ON play_rooms(game, status, id);

    CREATE TABLE IF NOT EXISTS play_moves (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      seat       INTEGER NOT NULL,
      move       TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_play_moves_room ON play_moves(room_id, seq);

    -- 第六批：观战 / 棋谱回放 / 每日挑战（第六批的功能都只用服务端可验证的数据）
    CREATE TABLE IF NOT EXISTS play_replays (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      game       TEXT NOT NULL,
      room_code  TEXT NOT NULL DEFAULT '',
      host_name  TEXT NOT NULL DEFAULT '',
      guest_name TEXT NOT NULL DEFAULT '',
      result     TEXT NOT NULL DEFAULT '',
      move_count INTEGER NOT NULL DEFAULT 0,
      moves      TEXT NOT NULL DEFAULT '[]',
      plays      INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_replays_game ON play_replays(game, id DESC);

    -- 每日挑战：一天一人一条（UNIQUE 索引兜底，重复提交写不进去）
    CREATE TABLE IF NOT EXISTS daily_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      day        TEXT NOT NULL,
      user_id    INTEGER NOT NULL,
      slug       TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_user ON daily_results(day, user_id);
  `);

  // games.status 语义：1 已上架 / 0 已下架 / 2 待审核
  addColumn('games', 'submitted_by', 'submitted_by INTEGER');

  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补字段，老库要手动 ALTER
  addColumn('games', 'rating_count', 'rating_count INTEGER DEFAULT 0');
  // 搜索用拼音索引：存"标题+副标题+标签"的全拼与首字母，写入时生成，查询时直接 LIKE
  addColumn('games', 'search_pinyin', "search_pinyin TEXT DEFAULT ''");
  addIndex('idx_games_status', 'games(status, plays DESC)');

  // 评论楼中楼：parent_id 为空 = 顶层评论
  addColumn('comments', 'parent_id', 'parent_id INTEGER');
  addIndex('idx_comments_parent', 'comments(parent_id)');

  // 评论可以挂在游戏（target='game'）或公告（target='post'）上；game_id 是通用目标 id
  addColumn('comments', 'target', "target TEXT NOT NULL DEFAULT 'game'");
  addIndex('idx_comments_target', 'comments(target, game_id, status, id DESC)');

  // 账号：邮箱验证 / 封禁
  addColumn('users', 'email', 'email TEXT');
  addColumn('users', 'email_verified', 'email_verified INTEGER DEFAULT 0');
  addColumn('users', 'banned', 'banned INTEGER DEFAULT 0');
  addColumn('users', 'banned_reason', 'banned_reason TEXT');
  addColumn('users', 'verify_token', 'verify_token TEXT');
  addColumn('users', 'verify_expires', 'verify_expires TEXT');

  // 论坛禁言：到点自动解除，是否禁言由 muted_until > now 判断（封禁仍走 users.banned）
  addColumn('users', 'muted_until', 'muted_until TEXT');
  addColumn('users', 'mute_reason', 'mute_reason TEXT');

  // 第六批：观战凭证（房间内玩家可分享的只读钥匙）与已存档的棋谱 id
  addColumn('play_rooms', 'watch_token', "watch_token TEXT NOT NULL DEFAULT ''");
  addColumn('play_rooms', 'replay_id', 'replay_id INTEGER DEFAULT 0');
}

/** 幂等补索引 */
function addIndex(name, ddl) {
  db.exec('CREATE INDEX IF NOT EXISTS ' + name + ' ON ' + ddl);
}

/** 幂等补列 */
function addColumn(table, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (cols.some((c) => c.name === column)) return;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
}
