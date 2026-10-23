/**
 * D1 建表 + 种子 + 管理员自举。
 * 对应 Express 版：server.js 启动时调用的 seed(false) + auth.ensureAdmin()；
 * 种子按 slug 幂等补齐，所以后续新增游戏只要 push，线上第一次请求就会自动补上。
 * Worker 没有"启动"概念，所以放在第一次请求前跑，并用模块级 Promise 只跑一次。
 */
import { CATEGORIES, GAMES } from './seed-data.js';
import { ensureAdmin } from './auth.js';
// 种子数据是直接 INSERT 的，不带拼音索引；启动时补一次，老库升级也能用拼音搜
import { reindexSearchIndex } from './data.js';
import { REWARD_LEDGER_DDL } from './rewards.js';
import { ATTACH_REVIEW_COLUMNS, ATTACH_REVIEW_DDL } from '../src/attachments.js';

/** 与 src/db.js migrate() 的 schema 逐字段一致（D1 是 SQLite，语法通用） */
export const DDL = [
  "CREATE TABLE IF NOT EXISTS categories (",
  "  id     INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  slug   TEXT UNIQUE NOT NULL,",
  "  name   TEXT NOT NULL,",
  "  icon   TEXT DEFAULT '🎮',",
  "  sort   INTEGER DEFAULT 0",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS games (",
  "  id           INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  slug         TEXT UNIQUE NOT NULL,",
  "  title        TEXT NOT NULL,",
  "  subtitle     TEXT,",
  "  description  TEXT,",
  "  category_id  INTEGER REFERENCES categories(id),",
  "  engine       TEXT DEFAULT 'html5',",
  "  game_url     TEXT NOT NULL,",
  "  width        INTEGER DEFAULT 800,",
  "  height       INTEGER DEFAULT 600,",
  "  orientation  TEXT DEFAULT 'landscape',",
  "  tags         TEXT DEFAULT '[]',",
  "  emoji        TEXT DEFAULT '🎮',",
  "  accent       TEXT DEFAULT '#6366f1',",
  "  accent2      TEXT DEFAULT '#8b5cf6',",
  "  plays        INTEGER DEFAULT 0,",
  "  rating       REAL DEFAULT 0,",
  "  rating_count INTEGER DEFAULT 0,",
  "  license      TEXT DEFAULT '自研',",
  "  status       INTEGER DEFAULT 1,",
  "  submitted_by INTEGER,",
  "  created_at   TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_games_cat   ON games(category_id);",
  "CREATE INDEX IF NOT EXISTS idx_games_plays ON games(plays DESC);",
  "",
  "CREATE TABLE IF NOT EXISTS play_logs (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id),",
  "  day        TEXT NOT NULL,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_logs_game ON play_logs(game_id);",
  "CREATE INDEX IF NOT EXISTS idx_logs_day  ON play_logs(day);",
  "",
  "CREATE TABLE IF NOT EXISTS ratings (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,",
  "  visitor    TEXT NOT NULL,",
  "  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),",
  "  updated_at TEXT DEFAULT (datetime('now','localtime')),",
  "  UNIQUE (game_id, visitor)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_ratings_game ON ratings(game_id);",
  "",
  "CREATE TABLE IF NOT EXISTS users (",
  "  id           INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  username     TEXT UNIQUE NOT NULL,",
  "  display_name TEXT NOT NULL,",
  "  pass_hash    TEXT NOT NULL,",
  "  pass_salt    TEXT NOT NULL,",
  "  role         TEXT DEFAULT 'user',",
  "  created_at   TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS sessions (",
  "  token      TEXT PRIMARY KEY,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  expires_at TEXT NOT NULL",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS favorites (",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  PRIMARY KEY (user_id, game_id)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS comments (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  // game_id 是通用目标 id（游戏 id 或公告帖 id），不是外键
  // —— 老库上的 games 外键见 migrations/0012_comments_no_game_fk.sql
  "  game_id    INTEGER NOT NULL,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  body       TEXT NOT NULL,",
  "  status     INTEGER DEFAULT 1,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_comments_game ON comments(game_id, status);",
  "",
  "CREATE TABLE IF NOT EXISTS comment_reports (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  reason     TEXT NOT NULL,",
  "  status     INTEGER DEFAULT 0,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  UNIQUE (comment_id, user_id)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_reports_status ON comment_reports(status, id DESC);",
  "",
  "CREATE TABLE IF NOT EXISTS audit_logs (",
  "  id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  actor_id   INTEGER,",
  "  actor_name TEXT,",
  "  action     TEXT NOT NULL,",
  "  target     TEXT,",
  "  detail     TEXT,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(id DESC);",
  "",
  "CREATE TABLE IF NOT EXISTS oauth_accounts (",
  "  provider     TEXT NOT NULL,",
  "  provider_uid TEXT NOT NULL,",
  "  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  created_at   TEXT DEFAULT (datetime('now','localtime')),",
  "  PRIMARY KEY (provider, provider_uid)",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);",
  "",
  "CREATE TABLE IF NOT EXISTS password_resets (",
  "  token      TEXT PRIMARY KEY,",
  "  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  created_at TEXT DEFAULT (datetime('now','localtime')),",
  "  expires_at TEXT NOT NULL,",
  "  used_at    TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id);",
  "CREATE TABLE IF NOT EXISTS game_files (",
  "  slug       TEXT PRIMARY KEY,",
  "  filename   TEXT,",
  "  size       INTEGER DEFAULT 0,",
  "  html       TEXT NOT NULL,",
  "  created_at TEXT DEFAULT (datetime('now','localtime'))",
  ");",
  "CREATE TABLE IF NOT EXISTS posts (",
  "  id           INTEGER PRIMARY KEY AUTOINCREMENT,",
  "  slug         TEXT NOT NULL UNIQUE,",
  "  title        TEXT NOT NULL,",
  "  body         TEXT NOT NULL,",
  "  pinned       INTEGER DEFAULT 0,",
  "  status       INTEGER DEFAULT 1,",
  "  author_id    INTEGER,",
  "  created_at   TEXT DEFAULT (datetime('now','localtime')),",
  "  updated_at   TEXT,",
  "  published_at TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, pinned DESC, id DESC);",
  "    -- 论坛（第四批）：板块 / 主题 / 楼层 / 编辑留痕 / 举报 / 内容黑名单 / 表单 nonce",
  "    CREATE TABLE IF NOT EXISTS forums (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      slug        TEXT UNIQUE NOT NULL,",
  "      name        TEXT NOT NULL,",
  "      description TEXT DEFAULT '',",
  "      icon        TEXT DEFAULT '💬',",
  "      sort        INTEGER DEFAULT 0,",
  "      status      INTEGER DEFAULT 1,",
  "      created_at  TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "",
  "    -- 主题：status 0 待审 / 1 已发布 / 2 已下架（软删，可恢复）",
  "    CREATE TABLE IF NOT EXISTS forum_threads (",
  "      id            INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      forum_id      INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,",
  "      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      title         TEXT NOT NULL,",
  "      status        INTEGER DEFAULT 0,",
  "      pinned        INTEGER DEFAULT 0,",
  "      locked        INTEGER DEFAULT 0,",
  "      reply_count   INTEGER DEFAULT 0,",
  "      view_count    INTEGER DEFAULT 0,",
  "      last_reply_at TEXT,",
  "      created_at    TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_threads_forum  ON forum_threads(forum_id, status, pinned DESC, id DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_threads_recent ON forum_threads(status, pinned DESC, id DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_threads_user   ON forum_threads(user_id, id DESC);",
  "",
  "    -- 楼层：status 0 待审 / 1 已发布 / 2 已隐藏（软删）；is_op=1 是该主题的首楼",
  "    CREATE TABLE IF NOT EXISTS forum_posts (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      thread_id  INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,",
  "      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      body       TEXT NOT NULL,",
  "      status     INTEGER DEFAULT 0,",
  "      is_op      INTEGER DEFAULT 0,",
  "      parent_id  INTEGER,",
  "      edited_at  TEXT,",
  "      edit_count INTEGER DEFAULT 0,",
  "      created_at TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_fposts_thread ON forum_posts(thread_id, status, id);",
  "    CREATE INDEX IF NOT EXISTS idx_fposts_user   ON forum_posts(user_id, id DESC);",
  "",
  "    -- 编辑留痕：改一次存一条 before/after，站长与楼主都能看到改了什么",
  "    CREATE TABLE IF NOT EXISTS forum_post_edits (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      post_id     INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,",
  "      editor_id   INTEGER NOT NULL REFERENCES users(id),",
  "      before_body TEXT NOT NULL,",
  "      after_body  TEXT NOT NULL,",
  "      created_at  TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_fedits_post ON forum_post_edits(post_id, id DESC);",
  "",
  "    -- 举报：同一用户对同一个目标只能报一次（UNIQUE 天然去重）",
  "    CREATE TABLE IF NOT EXISTS forum_reports (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      target_type TEXT NOT NULL,",
  "      target_id   INTEGER NOT NULL,",
  "      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      reason      TEXT NOT NULL,",
  "      detail      TEXT DEFAULT '',",
  "      status      INTEGER DEFAULT 0,",
  "      created_at  TEXT DEFAULT (datetime('now','localtime')),",
  "      UNIQUE (target_type, target_id, user_id)",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_freports_status ON forum_reports(status, id DESC);",
  "",
  "    -- 内容黑名单：word 子串 / regex 正则；action reject 直接拦，review 只让内容进待审",
  "    CREATE TABLE IF NOT EXISTS forum_blacklist (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      pattern    TEXT NOT NULL,",
  "      kind       TEXT DEFAULT 'word',",
  "      action     TEXT DEFAULT 'review',",
  "      note       TEXT DEFAULT '',",
  "      created_at TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "",
  "    -- 人机校验用的一次性 nonce（表单页发、提交时核销；没有引第三方验证码）",
  "    CREATE TABLE IF NOT EXISTS form_nonces (",
  "      token      TEXT PRIMARY KEY,",
  "      user_id    INTEGER,",
  "      kind       TEXT DEFAULT '',",
  "      used_at    TEXT,",
  "      created_at TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_nonces_created ON form_nonces(created_at);",
  "",
  "    -- 第五批：联机对战房间（五子棋 / 中国象棋 / 国际象棋等共用一套房间与走法中继）",
  "    -- 服务端只做轮流与中继：不校验走法合法性、不判胜负，规则在客户端",
  "    CREATE TABLE IF NOT EXISTS play_rooms (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      code        TEXT UNIQUE NOT NULL,",
  "      game        TEXT NOT NULL,",
  "      status      TEXT NOT NULL DEFAULT 'waiting',",
  "      host_name   TEXT NOT NULL DEFAULT '',",
  "      guest_name  TEXT NOT NULL DEFAULT '',",
  "      host_token  TEXT NOT NULL,",
  "      guest_token TEXT NOT NULL DEFAULT '',",
  "      turn        INTEGER NOT NULL DEFAULT 0,",
  "      move_count  INTEGER NOT NULL DEFAULT 0,",
  "      result      TEXT NOT NULL DEFAULT '',",
  "      rematch     INTEGER NOT NULL DEFAULT 0,",
  "      host_user_id INTEGER NOT NULL DEFAULT 0,",
  "      guest_user_id INTEGER NOT NULL DEFAULT 0,",
  "      created_at  INTEGER NOT NULL DEFAULT 0,",
  "      updated_at  INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_play_rooms_game ON play_rooms(game, status, id);",
  "",
  "    CREATE TABLE IF NOT EXISTS play_moves (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      room_id    INTEGER NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,",
  "      seq        INTEGER NOT NULL,",
  "      seat       INTEGER NOT NULL,",
  "      move       TEXT NOT NULL,",
  "      created_at INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_play_moves_room ON play_moves(room_id, seq);",
  "",
  "    -- 第六批：观战 / 棋谱回放 / 每日挑战（第六批的功能都只用服务端可验证的数据）",
  "    CREATE TABLE IF NOT EXISTS play_replays (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      game       TEXT NOT NULL,",
  "      room_code  TEXT NOT NULL DEFAULT '',",
  "      host_name  TEXT NOT NULL DEFAULT '',",
  "      guest_name TEXT NOT NULL DEFAULT '',",
  "      result     TEXT NOT NULL DEFAULT '',",
  "      move_count INTEGER NOT NULL DEFAULT 0,",
  "      moves      TEXT NOT NULL DEFAULT '[]',",
  "      plays      INTEGER NOT NULL DEFAULT 0,",
  "      host_user_id INTEGER NOT NULL DEFAULT 0,",
  "      guest_user_id INTEGER NOT NULL DEFAULT 0,",
  "      created_at INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_replays_game ON play_replays(game, id DESC);",
  "",
  "    -- 每日挑战：一天一人一条（UNIQUE 索引兜底，重复提交写不进去）",
  "    CREATE TABLE IF NOT EXISTS daily_results (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      day        TEXT NOT NULL,",
  "      user_id    INTEGER NOT NULL,",
  "      slug       TEXT NOT NULL,",
  "      created_at INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_user ON daily_results(day, user_id);",

  "    -- 第七批：社交图谱（关注 / 站内通知 / 私信）",
  "    -- 关注：互相关注即好友（不另建表）；UNIQUE 兜底让重复关注幂等",
  "    CREATE TABLE IF NOT EXISTS follows (",
  "      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      created_at  TEXT DEFAULT (datetime('now','localtime')),",
  "      UNIQUE (user_id, followee_id)",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_follows_user     ON follows(user_id);",
  "    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);",
  "",
  "    -- 站内通知：kind 取 reply / mention / follow / message / comment / system；actor_id 0 = 系统",
  "    -- target_type + target_id 指向站内对象（thread / game / user），body 是 ≤200 字符的短文本",
  "    CREATE TABLE IF NOT EXISTS notifications (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      kind        TEXT NOT NULL,",
  "      actor_id    INTEGER NOT NULL DEFAULT 0,",
  "      target_type TEXT NOT NULL DEFAULT '',",
  "      target_id   TEXT NOT NULL DEFAULT '',",
  "      body        TEXT NOT NULL DEFAULT '',",
  "      read_at     TEXT,",
  "      created_at  TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, id DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);",
  "",
  "    -- 私信：一对一会话，body ≤1000 字符；read_at 为空即未读",
  "    CREATE TABLE IF NOT EXISTS messages (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "      body       TEXT NOT NULL,",
  "      read_at    TEXT,",
  "      created_at TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id, id DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages(to_id, read_at);",

  "    -- 第八批：主题标签与精华（featured 的老库补列见 ADD_COLUMNS）",
  "    CREATE TABLE IF NOT EXISTS thread_tags (",
  "      thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,",
  "      tag       TEXT NOT NULL,",
  "      PRIMARY KEY (thread_id, tag)",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_thread_tags_tag ON thread_tags(tag);",
  "",
  "    -- 第九批：发件箱（外发邮件先落库，失败按指数退避重试，退信可查，见 docs/EMAIL.md）",
  "    CREATE TABLE IF NOT EXISTS mail_outbox (",
  "      id              INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      to_addr         TEXT NOT NULL,",
  "      subject         TEXT NOT NULL DEFAULT '',",
  "      body_text       TEXT NOT NULL DEFAULT '',",
  "      tag             TEXT NOT NULL DEFAULT '',",
  "      status          TEXT NOT NULL DEFAULT 'queued',",
  "      attempts        INTEGER NOT NULL DEFAULT 0,",
  "      last_error      TEXT NOT NULL DEFAULT '',",
  "      next_attempt_at TEXT,",
  "      created_at      TEXT DEFAULT (datetime('now','localtime')),",
  "      updated_at      TEXT DEFAULT (datetime('now','localtime'))",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox(status, next_attempt_at);",
  "",
  "    -- 第十批：联机棋类 Elo（只结算服务端裁判的四款棋类；赛季 = UTC 自然季度；身份键见 src/elo.js）",
  "    -- player_ratings 必须恰好这 10 列：少一列多一列都会让 upsert 静默失败",
  "    CREATE TABLE IF NOT EXISTS player_ratings (",
  "      user_id    TEXT NOT NULL,",
  "      game       TEXT NOT NULL,",
  "      season     TEXT NOT NULL,",
  "      rating     INTEGER NOT NULL DEFAULT 1200,",
  "      games      INTEGER NOT NULL DEFAULT 0,",
  "      wins       INTEGER NOT NULL DEFAULT 0,",
  "      losses     INTEGER NOT NULL DEFAULT 0,",
  "      draws      INTEGER NOT NULL DEFAULT 0,",
  "      peak       INTEGER NOT NULL DEFAULT 1200,",
  "      updated_at INTEGER NOT NULL DEFAULT 0,",
  "      PRIMARY KEY (user_id, game, season)",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_ratings_board ON player_ratings(game, season, rating DESC, games DESC, user_id);",
  "    -- elo_history 故意不加 REFERENCES play_rooms(id)：sweep 删房间时不能把'这房间结过没'的凭据一起抹掉",
  "    CREATE TABLE IF NOT EXISTS elo_history (",
  "      id          INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      room_id     INTEGER NOT NULL,",
  "      game        TEXT NOT NULL,",
  "      season      TEXT NOT NULL,",
  "      host_id     TEXT NOT NULL,",
  "      guest_id    TEXT NOT NULL,",
  "      host_delta  INTEGER NOT NULL DEFAULT 0,",
  "      guest_delta INTEGER NOT NULL DEFAULT 0,",
  "      host_after  INTEGER NOT NULL DEFAULT 0,",
  "      guest_after INTEGER NOT NULL DEFAULT 0,",
  "      result      TEXT NOT NULL DEFAULT '',",
  "      created_at  INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE UNIQUE INDEX IF NOT EXISTS idx_elo_history_room ON elo_history(room_id);",
  "    CREATE INDEX IF NOT EXISTS idx_elo_history_season ON elo_history(game, season, id DESC);",
  "",
  "    -- 第十一批：论坛附件（owner_id 故意不加 REFERENCES users：附件是软删 + 内容寻址共用实体）",
  "    CREATE TABLE IF NOT EXISTS attachments (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      owner_id   INTEGER NOT NULL,",
  "      thread_id  INTEGER NOT NULL DEFAULT 0,",
  "      post_id    INTEGER NOT NULL DEFAULT 0,",
  "      filename   TEXT    NOT NULL,",
  "      mime       TEXT    NOT NULL DEFAULT '',",
  "      bytes      INTEGER NOT NULL DEFAULT 0,",
  "      sha256     TEXT    NOT NULL DEFAULT '',",
  "      storage    TEXT    NOT NULL DEFAULT '',",
  "      \"key\"      TEXT    NOT NULL DEFAULT '',",
  "      created_at TEXT DEFAULT (datetime('now','localtime')),",
  "      status     TEXT NOT NULL DEFAULT 'pending'",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_attachments_post   ON attachments(post_id, status, id);",
  "    CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id, status, id);",
  "    CREATE INDEX IF NOT EXISTS idx_attachments_owner  ON attachments(owner_id, status, id DESC);",
  "    CREATE INDEX IF NOT EXISTS idx_attachments_sha    ON attachments(sha256, storage, status);",
  "    CREATE INDEX IF NOT EXISTS idx_attachments_gc     ON attachments(status, created_at);",
  "    CREATE TABLE IF NOT EXISTS attachments_blob (",
  "      id       INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      data_b64 TEXT NOT NULL",
  "    );",
  "    -- 第十一批：Web Push 订阅（VAPID）。与 src/db.js 的 push_subs 逐字一致，",
  "    -- 两边都建只是为了表结构有单一出处；src/push.js 与 worker/push.js 内部也会幂等自建。",
  "    CREATE TABLE IF NOT EXISTS push_subs (",
  "      id         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "      user_id    INTEGER NOT NULL,",
  "      endpoint   TEXT NOT NULL UNIQUE,",
  "      p256dh     TEXT NOT NULL,",
  "      auth       TEXT NOT NULL,",
  "      ua         TEXT NOT NULL DEFAULT '',",
  "      created_at TEXT NOT NULL,",
  "      ok_at      TEXT DEFAULT '',",
  "      fail_count INTEGER NOT NULL DEFAULT 0,",
  "      disabled   INTEGER NOT NULL DEFAULT 0",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user_id, disabled);",
  "    -- 第十六批：推送密钥自举（与 src/db.js 逐字一致）。PUSH_AUTO_KEYS 打开后第一次用到推送",
  "    -- 就在这里生成一对 VAPID 键，省掉控制台手填；src/push.js / worker/push.js 内部也幂等自建。",
  "    CREATE TABLE IF NOT EXISTS push_keys (",
  "      k          TEXT PRIMARY KEY,",
  "      v          TEXT NOT NULL,",
  "      changed_at TEXT NOT NULL DEFAULT ''",
  "    );",
  "    -- 第十三批：邮件抑制名单。与 src/db.js 的 migrate()、src/outbox.js 的 SUPPRESSION_DDL 逐字一致。",
  "    CREATE TABLE IF NOT EXISTS mail_suppression (",
  "      address    TEXT PRIMARY KEY,",
  "      reason     TEXT NOT NULL DEFAULT '',",
  "      source     TEXT NOT NULL DEFAULT '',",
  "      created_at INTEGER NOT NULL",
  "    );",
  "    CREATE INDEX IF NOT EXISTS idx_mail_suppression_created ON mail_suppression(created_at DESC);",
  // 第十四批：打卡奖励流水（与 src/db.js 的 migrate() 同源，直接摊平平铺 src/rewards.js 那份 DDL）。
  // 每条都是单行语句：下面 migrate() 按分号拆、D1 也按换行切，单行才两边都安全。
  // 摊平时必须补上分号：src/rewards.js 那 5 条**本身不带分号**（它那边是逐条 prepare 的），
  // 不补就会被 migrate() 的分号切分并成一条多语句 → 真机首请求报 near "CREATE": syntax error。
  ...REWARD_LEDGER_DDL.map((s) => s.trim().replace(/;?$/, ';'))
].join("\n");

/** 老库补字段：D1 的 CREATE TABLE IF NOT EXISTS 不会给已存在的表加列（对应 src/db.js 的 addColumn） */
export const ADD_COLUMNS = [
  ['games', 'submitted_by', 'submitted_by INTEGER'],
  ['games', 'rating_count', 'rating_count INTEGER DEFAULT 0'],
  ['games', 'search_pinyin', "search_pinyin TEXT DEFAULT ''"],
  ['comments', 'parent_id', 'parent_id INTEGER'],
  ['users', 'email', 'email TEXT'],
  ['users', 'email_verified', 'email_verified INTEGER DEFAULT 0'],
  ['users', 'banned', 'banned INTEGER DEFAULT 0'],
  ['users', 'banned_reason', 'banned_reason TEXT'],
  ['users', 'verify_token', 'verify_token TEXT'],
  ['users', 'verify_expires', 'verify_expires TEXT'],
  // comments.target 是第三批加的：评论可以挂在游戏（game）或公告（post）上
  ['comments', 'target', "target TEXT NOT NULL DEFAULT 'game'"],
  // 第四批：论坛禁言（到点自动解除；封禁仍走 users.banned）
  ['users', 'muted_until', 'muted_until TEXT'],
  ['users', 'mute_reason', 'mute_reason TEXT'],
  // 第六批：观战凭证与棋谱 id（ALTER 必须由运行时补，见上方注释）
  ['play_rooms', 'watch_token', "watch_token TEXT NOT NULL DEFAULT ''"],
  ['play_rooms', 'replay_id', 'replay_id INTEGER DEFAULT 0'],
  // 第八批：论坛精华（置顶/锁定是既有的 pinned/locked；featured 是新增列）
  ['forum_threads', 'featured', 'featured INTEGER NOT NULL DEFAULT 0'],
  // 第十批：账号级「只看我的」——房间记住两位玩家的账号 id（0 = 未登录 / 匿名），
  // 棋谱落库时从房间行拷过去，检索才能按 id 匹配（对应 src/db.js 的同名 addColumn）
  ['play_rooms', 'host_user_id', 'host_user_id INTEGER NOT NULL DEFAULT 0'],
  ['play_rooms', 'guest_user_id', 'guest_user_id INTEGER NOT NULL DEFAULT 0'],
  ['play_replays', 'host_user_id', 'host_user_id INTEGER NOT NULL DEFAULT 0'],
  ['play_replays', 'guest_user_id', 'guest_user_id INTEGER NOT NULL DEFAULT 0']
];

/** 老库补索引（对应 src/db.js 的 addIndex） */
export const ADD_INDEXES = [
  ['idx_games_status', 'games(status, plays DESC)'],
  ['idx_comments_parent', 'comments(parent_id)'],
  ['idx_comments_target', 'comments(target, game_id, status, id DESC)']
];

/**
 * 建表。注意不能用 db.exec(DDL)：D1 的 exec() 是按换行切语句再执行的，
 * 我们这种跨多行的 CREATE TABLE 会被切坏，线上报
 *   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS categories (: incomplete input
 * （本地 tools/d1-local.mjs 用的是 node:sqlite 的 exec，能吃多行语句，所以之前测不出来）。
 * 这里自己按分号拆成单条，逐条 prepare().run()。
 */
export async function migrate(db) {
  const stmts = DDL.split(';').map((s) => s.trim()).filter(Boolean);
  for (const sql of stmts) await db.prepare(sql).run();
  await ensureColumns(db);
}

/** 幂等补列 / 补索引，给第二批功能上线前建好的老库用 */
export async function ensureColumns(db) {
  for (const [table, column, ddl] of ADD_COLUMNS) {
    const info = await db.prepare('PRAGMA table_info(' + table + ')').all();
    const cols = (info && info.results) || [];
    if (cols.some((c) => c.name === column)) continue;
    await db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl).run();
  }
  for (const [name, ddl] of ADD_INDEXES) {
    await db.prepare('CREATE INDEX IF NOT EXISTS ' + name + ' ON ' + ddl).run();
  }
  // 第十五批：附件人工复核的六列 + 两条审核索引（常量与 src/attachments.js / src/db.js 共用一份；
  // 这里是整条 ALTER / CREATE INDEX，不走 ADD_COLUMNS 的「表 + 列片段」形状，D1 直接 prepare().run()）。
  const attachInfo = await db.prepare('PRAGMA table_info(attachments)').all();
  const attachCols = (attachInfo && attachInfo.results) || [];
  for (const col of ATTACH_REVIEW_COLUMNS) {
    if (attachCols.some((c) => c.name === col.name)) continue;
    await db.prepare(col.ddl).run();
  }
  for (const sql of ATTACH_REVIEW_DDL) await db.prepare(sql).run();
}

/** 种子数据：分类与游戏都按 slug 幂等补齐（只插缺的，不动已有游戏的游玩次数 / 评分 / 评论） */
export async function seedMissing(db) {
  const catStmts = CATEGORIES.map((c) => db.prepare(
    'INSERT OR IGNORE INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)'
  ).bind(c.slug, c.name, c.icon, c.sort));
  if (catStmts.length) await db.batch(catStmts);

  const catRows = await db.prepare('SELECT id, slug FROM categories').all();
  const catId = new Map(catRows.results.map((r) => [r.slug, r.id]));

  const haveRows = await db.prepare('SELECT slug FROM games').all();
  const have = new Set(haveRows.results.map((r) => r.slug));
  const missing = GAMES.filter((g) => !have.has(g.slug));
  if (!missing.length) return { seeded: false, added: [] };

  await db.batch(missing.map((g) => db.prepare(
    'INSERT INTO games (slug, title, subtitle, description, category_id, engine, game_url,' +
    ' width, height, orientation, tags, emoji, accent, accent2, plays, rating, license)' +
    " VALUES (?, ?, ?, ?, ?, 'html5', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)"
  ).bind(
    g.slug, g.title, g.subtitle, g.description, catId.get(g.category), g.game_url,
    g.width, g.height, g.orientation, JSON.stringify(g.tags),
    g.emoji, g.accent, g.accent2, g.license
  )));
  return { seeded: true, added: missing.map((g) => g.slug) };
}

/**
 * 幂等自举：建表 → 按 slug 补齐缺失的种子 → 保证有管理员。
 *
 * 按 D1 绑定分别记忆：一个 isolate 里可能有多个 env（测试里每段落都新建
 * LocalD1，甚至把文件删掉重建）。之前用单个模块级 Promise，第二次自举会
 * 直接复用第一次的结果 —— 在 Linux 上删文件是真删，新库就一张表都没有，
 * 首页一路 500（Windows 上删不掉旧文件，反而掩盖了这个 bug）。
 */
const readyByDb = new WeakMap();
let readySingle = null;

function bootstrap(env) {
  return (async () => {
    await migrate(env.DB);
    await seedMissing(env.DB);
    await ensureAdmin(env.DB, env);
    await reindexSearchIndex(env.DB);
    return true;
  })();
}

export function ensureReady(env) {
  const db = env && env.DB;
  if (!db || typeof db !== 'object') {
    // 没有 D1 绑定（离线构建 / 纯函数调用）：退回单一记忆
    if (!readySingle) {
      readySingle = bootstrap(env).catch((err) => {
        readySingle = null;
        throw err;
      });
    }
    return readySingle;
  }
  let p = readyByDb.get(db);
  if (!p) {
    p = bootstrap(env).catch((err) => {
      // 失败就清掉，让下一个请求重试（和原来「失败重置」的语义一致）
      if (readyByDb.get(db) === p) readyByDb.delete(db);
      throw err;
    });
    readyByDb.set(db, p);
  }
  return p;
}
