/**
 * 主题标签与精华 / 置顶验收测试（第八批）
 *   node tools/forum-tags-test.mjs
 *
 * 两条线各跑同一套断言：
 *   ① Express 线：src/data-forum.js（走 src/db.js 的真实建表流程）。
 *      先把 src/*.js 整包复制到临时沙箱，断言副本与仓库文件逐字节一致后再 import，
 *      于是 db.js 算出的 DATA_DIR 落在临时目录里，仓库的 data/games.db 一点都不碰。
 *   ② Workers 线：worker/data-forum.js + tools/d1-local.mjs 的 LocalD1（node:sqlite 冒充 D1）。
 * 建表走两条线各自的正式入口（src/db.js 的 migrate()、worker/schema.js 的 migrate()），
 * 再执行 migrations/0008_forum_tags.sql；列已存在（主理人把 featured 提前合进建表脚本）时自动跳过那条 ALTER。
 * 临时目录 .tmp-ver/forum-tags-test-<pid>/ 跑完整个删掉。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalD1 } from './d1-local.mjs';
import { migrate as migrateWorker } from '../worker/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP = join(ROOT, '.tmp-ver', 'forum-tags-test-' + process.pid);
const MIG_PATH = join(ROOT, 'migrations', '0008_forum_tags.sql');
// 整包复制（src/forum-guard.js 自己还 require 着 src/ratelimit.js 之类，点名复制迟早漏）
const SRC_FILES = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).sort();

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), '得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
}
function tagsOf(row) { return ((row && row.tags) || []).slice().sort().join(','); }

/* ---------- 迁移文件：先自检，再拿去建库 ---------- */
const MIG_SQL = readFileSync(MIG_PATH, 'utf8');
const MIG_STMTS = MIG_SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);

ok('迁移 0008 是 3 条语句（补列 / 建表 / 建索引）', MIG_STMTS.length === 3, MIG_STMTS.length + ' 条');
ok('迁移给 forum_threads 补 featured（INTEGER NOT NULL DEFAULT 0）',
  /ALTER TABLE forum_threads ADD COLUMN featured INTEGER NOT NULL DEFAULT 0/.test(MIG_SQL));
ok('迁移建 thread_tags（主键 thread_id+tag、外键级联、tag 索引）',
  /CREATE TABLE IF NOT EXISTS thread_tags/.test(MIG_SQL) && /PRIMARY KEY \(thread_id, tag\)/.test(MIG_SQL) &&
  /REFERENCES forum_threads\(id\) ON DELETE CASCADE/.test(MIG_SQL));
ok('迁移建索引 idx_thread_tags_tag', /CREATE INDEX IF NOT EXISTS idx_thread_tags_tag ON thread_tags\(tag\)/.test(MIG_SQL));

/** 逐条执行 0008；列已存在（主理人提前把 featured 合进建表脚本）不算失败 */
async function applyMigration(exec) {
  let skipped = 0;
  for (const sql of MIG_STMTS) {
    try { await exec(sql); }
    catch (e) {
      if (/duplicate column name/i.test(String((e && e.message) || e))) { skipped++; continue; }
      throw e;
    }
  }
  return skipped;
}

/* ---------- 行适配器：把两条线的调用差异（db 首参 + await）藏起来 ---------- */
function makeLine(kind, label, mod, db) {
  const w = kind === 'worker';
  const bind = (fn) => (...a) => (w ? fn(db, ...a) : fn(...a));
  return {
    label,
    exec: (sql) => (w ? db.prepare(sql).run() : db.exec(sql)),
    get: async (sql, ...p) => (w ? db.prepare(sql).bind(...p).first() : db.prepare(sql).get(...p)),
    all: async (sql, ...p) => (w ? ((await db.prepare(sql).bind(...p).all()).results || []) : db.prepare(sql).all(...p)),
    ensureForums: bind(mod.ensureForums),
    createThread: bind(mod.createThread),
    listThreads: bind(mod.listThreads),
    getThread: bind(mod.getThread),
    listPendingThreads: bind(mod.listPendingThreads),
    setThreadTags: bind(mod.setThreadTags),
    setThreadFlags: bind(mod.setThreadFlags),
    listTags: bind(mod.listTags),
    threadsByTag: bind(mod.threadsByTag),
    cleanTags: mod.cleanTags,
    isModerator: mod.isModerator
  };
}

async function addUser(line, username, name, role) {
  await line.exec("INSERT INTO users (username, display_name, pass_hash, pass_salt, role, email_verified) VALUES ('" +
    username + "', '" + name + "', 'x', 'x', '" + role + "', 1)");
  const row = await line.get('SELECT id FROM users WHERE username = ?', username);
  return Number(row.id);
}

/** 排序断言要确定性：把 last_reply_at 固定成写死的时间戳，不依赖真实时钟 */
async function setReplyTime(line, id, ts) {
  await line.exec("UPDATE forum_threads SET last_reply_at = '" + ts + "' WHERE id = " + Number(id));
}

/* ---------- 同一套断言，两条线各跑一遍 ---------- */
async function suite(line) {
  const tag = '[' + line.label + '] ';

  /* ① 建表 */
  const cols = (await line.all('PRAGMA table_info(forum_threads)')).map((c) => c.name);
  ok(tag + '迁移后 forum_threads 有 featured 列', cols.indexOf('featured') >= 0, cols.join(','));
  const names = (await line.all("SELECT name FROM sqlite_master WHERE name IN ('thread_tags','idx_thread_tags_tag')")).map((r) => r.name);
  ok(tag + '迁移后 thread_tags 表在', names.indexOf('thread_tags') >= 0, names.join(','));
  ok(tag + '迁移后 idx_thread_tags_tag 索引在', names.indexOf('idx_thread_tags_tag') >= 0, names.join(','));

  /* ② 人 + 发主题 */
  await line.ensureForums();
  const forum = await line.get("SELECT id FROM forums WHERE slug = 'general'");
  ok(tag + '板块种子数据齐了（general 在）', !!forum && forum.id > 0);
  const admin = { id: await addUser(line, 'tags_adm', '站长甲', 'admin'), role: 'admin' };
  const mod = { id: await addUser(line, 'tags_mod', '版主乙', 'mod'), role: 'mod' };
  const plain = { id: await addUser(line, 'tags_usr', '路人丙', 'user'), role: 'user' };

  const t1 = await line.createThread({ forumId: forum.id, user: admin, title: '标签主题一', body: '正文一' });
  const t2 = await line.createThread({ forumId: forum.id, user: admin, title: '标签主题二', body: '正文二' });
  const t3 = await line.createThread({ forumId: forum.id, user: admin, title: '标签主题三', body: '正文三' });
  const t4 = await line.createThread({ forumId: forum.id, user: admin, title: '待审主题四', body: '正文四' });
  ok(tag + '发主题成功（拿到 id）', !!t1 && t1.id > 0 && t2.id > 0 && t3.id > 0 && t4.id > 0, JSON.stringify(t1));
  ok(tag + '发主题顺手建了首楼（is_op=1）', !!(await line.get('SELECT id FROM forum_posts WHERE thread_id = ? AND is_op = 1', t1.id)));
  // 后面的标签/排序断言都要求这三条是「已发布」：审核策略将来若改成站长也要过审，这里兜一下
  await line.exec('UPDATE forum_threads SET status = 1 WHERE id IN (' + [t1.id, t2.id, t3.id].join(',') + ')');
  await line.exec('UPDATE forum_threads SET status = 0 WHERE id = ' + Number(t4.id)); // 模拟待审
  await setReplyTime(line, t1.id, '2026-01-01 10:00:00');
  await setReplyTime(line, t2.id, '2026-01-01 11:00:00');
  await setReplyTime(line, t3.id, '2026-01-01 12:00:00');
  await setReplyTime(line, t4.id, '2026-01-01 13:00:00');

  /* ③ 新主题的默认值 + 返回结构 */
  const g1 = await line.getThread(t1.id, admin);
  eq(tag + '新主题默认 featured=0 / pinned=0 / tags=[]', [g1.thread.featured, g1.thread.pinned, tagsOf(g1.thread)], [0, 0, '']);
  eq(tag + 'getThread 返回结构没变', Object.keys(g1).sort().join(','), 'canView,isAdmin,isOwner,thread');
  const row1 = (await line.listThreads({})).items.filter((i) => i.id === t1.id)[0];
  ok(tag + 'listThreads 每条主题都带 tags(数组) / featured / pinned',
    !!row1 && Array.isArray(row1.tags) && row1.featured === 0 && row1.pinned === 0);
  ok(tag + 'listThreads 既有字段一个没少',
    !!row1 && ['title', 'status', 'locked', 'reply_count', 'view_count', 'created_at', 'last_reply_at', 'user_id', 'name',
      'username', 'forum_id', 'forum_slug', 'forum_name', 'forum_icon'].every((k) => k in row1));

  /* ④ 标签清洗 + 角色判定（纯函数） */
  eq(tag + 'cleanTags：去空白 / 剔非法字符 / 去重 / 最多 3 个',
    line.cleanTags([' 攻略 ', 'a b', '中文!', '攻略', '第四个', '第五个']), ['攻略', 'ab', '中文']);
  eq(tag + 'cleanTags：超长标签截到 16 字符', line.cleanTags(['x'.repeat(30)]), ['x'.repeat(16)]);
  eq(tag + 'cleanTags：逗号 / 空格分隔的字符串也收', line.cleanTags('攻略,心得 攻略'), ['攻略', '心得']);
  eq(tag + 'cleanTags：全非法 / undefined / 空数组都得到 []',
    [line.cleanTags(['!!!', '🏆', '  ']).length, line.cleanTags(undefined).length, line.cleanTags([]).length], [0, 0, 0]);
  eq(tag + 'isModerator：admin / mod 放行，user、游客、user 对象都对',
    [line.isModerator('admin'), line.isModerator('mod'), line.isModerator('user'), line.isModerator(null),
      line.isModerator({ role: 'mod' }), line.isModerator({ role: 'user' })],
    [true, true, false, false, true, false]);

  /* ⑤ 打标签 + 权限拒绝 */
  eq(tag + '普通用户打标签 → forbidden', (await line.setThreadTags(t1.id, ['攻略'], 'user')).error, 'forbidden');
  eq(tag + '不传角色打标签 → forbidden（新接口没有老调用路径）', (await line.setThreadTags(t1.id, ['攻略'])).error, 'forbidden');
  eq(tag + '给不存在的主题打标签 → no_thread', (await line.setThreadTags(999999, ['x'], 'admin')).error, 'no_thread');
  const set1 = await line.setThreadTags(t1.id, [' 攻略 ', '心得', '攻略', '非法!@#', '溢出'], 'admin');
  eq(tag + 'setThreadTags：去空白 / 去重 / 剔非法字符 / 上限 3 个（第 4 个有效标签被截掉）',
    [set1.ok === true, (set1.tags || []).join(',')], [true, '攻略,心得,非法']);
  eq(tag + '读回来 tags 是数组且内容一致', tagsOf((await line.getThread(t1.id, admin)).thread), '心得,攻略,非法');
  const modSet = await line.setThreadTags(t1.id, ['心得'], 'mod');
  eq(tag + 'mod 也允许改标签，且是覆盖不是追加', [modSet.ok === true, tagsOf((await line.getThread(t1.id, admin)).thread)], [true, '心得']);
  await line.setThreadTags(t1.id, [], 'admin');
  eq(tag + '传空数组 = 清空标签', tagsOf((await line.getThread(t1.id, admin)).thread), '');

  /* ⑥ 标签云 + 按标签翻页（复用 listThreads 的分页形状） */
  await line.setThreadTags(t1.id, ['攻略', '心得'], 'admin');
  await line.setThreadTags(t2.id, ['攻略'], 'admin');
  await line.setThreadTags(t3.id, ['攻略', '心得'], 'admin');
  await line.setThreadTags(t4.id, ['秘密'], 'admin');
  eq(tag + 'listTags 按数量倒序，且只数已发布主题（待审主题的「秘密」不算）',
    (await line.listTags(10)).map((c) => c.tag + ':' + c.count), ['攻略:3', '心得:2']);
  eq(tag + 'listTags(1) 的 limit 生效', (await line.listTags(1)).map((c) => c.tag), ['攻略']);
  const p1 = await line.threadsByTag('心得', { page: 1, pageSize: 1 });
  eq(tag + 'threadsByTag 分页形状与 listThreads 一致', Object.keys(p1).sort().join(','), 'items,page,pageSize,pages,total');
  eq(tag + 'threadsByTag 第一页（按最新回复）',
    [p1.total, p1.pages, p1.page, p1.pageSize, p1.items.map((i) => i.id).join(',')], [2, 2, 1, 1, String(t3.id)]);
  eq(tag + 'threadsByTag 第二页', (await line.threadsByTag('心得', { page: 2, pageSize: 1 })).items.map((i) => i.id), [t1.id]);
  const allG = await line.threadsByTag('攻略');
  eq(tag + 'threadsByTag 只出带这个标签的主题，顺序仍按最新回复',
    [allG.total, allG.items.map((i) => i.id).join(',')], [3, [t3.id, t2.id, t1.id].join(',')]);
  ok(tag + 'threadsByTag 返回的每条都确实带这个标签', allG.items.every((i) => i.tags.indexOf('攻略') >= 0));
  eq(tag + '待审主题上的标签：游客翻不到', (await line.threadsByTag('秘密')).total, 0);
  eq(tag + '待审主题上的标签：作者本人（viewerId）翻得到', (await line.threadsByTag('秘密', { viewerId: admin.id })).total, 1);

  /* ⑦ 精华 / 置顶 + 权限 */
  const legacy = await line.setThreadFlags(t1.id, { pinned: 1, locked: 1 });
  eq(tag + '老调用 setThreadFlags(id, {pinned,locked}) 的返回值逐字没变', JSON.stringify(legacy), '{"ok":true}');
  const lt1 = await line.getThread(t1.id, admin);
  eq(tag + '老调用照样把 pinned / locked 落库', [lt1.thread.pinned, lt1.thread.locked], [1, 1]);
  eq(tag + '带普通用户角色改置顶 → forbidden', (await line.setThreadFlags(t2.id, { pinned: 1 }, plain)).error, 'forbidden');
  eq(tag + '带普通用户角色改精华 → forbidden', (await line.setThreadFlags(t2.id, { featured: 1 }, 'user')).error, 'forbidden');
  eq(tag + '不带角色设精华 → forbidden（新能力必须显式带 admin/mod）',
    (await line.setThreadFlags(t2.id, { featured: 1 })).error, 'forbidden');
  const feat = await line.setThreadFlags(t2.id, { featured: 1 }, admin);
  eq(tag + '站长设精华成功', [feat.ok === true, (await line.getThread(t2.id, admin)).thread.featured], [true, 1]);
  const onlyFeat = await line.listThreads({ featuredOnly: true });
  eq(tag + 'listThreads({featuredOnly:true}) 只出精华主题',
    [onlyFeat.total, onlyFeat.items.map((i) => i.id).join(',')], [1, String(t2.id)]);
  eq(tag + 'featuredOnly 没动分页字段', [onlyFeat.page, onlyFeat.pages, onlyFeat.pageSize], [1, 1, 20]);
  await line.setThreadFlags(t2.id, { featured: 0 }, 'mod');
  eq(tag + '取消精华（mod 也允许）', (await line.getThread(t2.id, admin)).thread.featured, 0);

  /* ⑧ 排序：默认顺序不变，pinnedFirst 等价且置顶内部按最新回复 */
  const def = await line.listThreads({});
  eq(tag + '默认顺序：置顶最前，其余按最新回复', def.items.map((i) => i.id), [t1.id, t3.id, t2.id]);
  const pinFirst = await line.listThreads({ pinnedFirst: true });
  eq(tag + 'pinnedFirst 与默认顺序一致（置顶内部同样按最新回复）', pinFirst.items.map((i) => i.id), def.items.map((i) => i.id));
  await line.setThreadFlags(t3.id, { pinned: 1 }, 'mod');
  eq(tag + '两个置顶之间按最新回复（新的在前）', (await line.listThreads({})).items.map((i) => i.id), [t3.id, t1.id, t2.id]);
  eq(tag + 'pinnedFirst 下两个置顶同样按最新回复',
    (await line.listThreads({ pinnedFirst: true })).items.map((i) => i.id), [t3.id, t1.id, t2.id]);

  /* ⑨ 既有调用形状回归 */
  const shape = await line.listThreads({ q: '标签主题', page: 2, pageSize: 2, viewerId: null });
  eq(tag + 'listThreads 返回形状不变', Object.keys(shape).sort().join(','), 'items,page,pageSize,pages,total');
  eq(tag + 'q 搜索 + 分页照旧工作', [shape.total, shape.pages, shape.page, shape.pageSize, shape.items.length], [3, 2, 2, 2, 1]);
  eq(tag + 'forum 过滤照旧', (await line.listThreads({ forum: 'general' })).total, 3);
  eq(tag + 'pageSize 上限仍钳到 50', (await line.listThreads({ pageSize: 999 })).pageSize, 50);
  eq(tag + '游客看不见待审主题', (await line.listThreads({})).items.filter((i) => i.id === t4.id).length, 0);
  eq(tag + '作者本人（viewerId）看得见自己的待审主题',
    (await line.listThreads({ viewerId: admin.id })).items.filter((i) => i.id === t4.id).length, 1);
  eq(tag + 'getThread 看待审主题：游客 canView=false', (await line.getThread(t4.id, null)).canView, false);

  /* ⑩ 第三处消费点：待审列表也要带新字段 */
  const p4 = (await line.listPendingThreads(10)).filter((r) => r.id === t4.id)[0];
  ok(tag + 'listPendingThreads 里的主题也带 tags(数组) / featured / pinned',
    !!p4 && Array.isArray(p4.tags) && p4.tags.join(',') === '秘密' && p4.featured === 0 && p4.pinned === 0);
}

/* ---------- 驱动 ---------- */
(async () => {
  const closers = [];
  try {
    /* ① Express 线 */
    const sbDir = join(TMP, 'src-sandbox');
    mkdirSync(sbDir, { recursive: true });
    for (const f of SRC_FILES) copyFileSync(join(ROOT, 'src', f), join(sbDir, f));
    ok('沙箱副本与仓库源码逐字节一致（src/*.js 整包，保证测的是真代码）',
      SRC_FILES.every((f) => readFileSync(join(sbDir, f)).equals(readFileSync(join(ROOT, 'src', f)))));
    const dbMod = await import(pathToFileURL(join(sbDir, 'db.js')).href);
    // 拿到句柄就先登记收尾：中途抛异常也要把库关掉，否则 Windows 上临时目录删不掉
    closers.push(() => dbMod.db.close());
    const forumMod = await import(pathToFileURL(join(sbDir, 'data-forum.js')).href);
    dbMod.migrate();
    ok('Express 线：临时库落在沙箱目录下，不碰仓库 data/games.db', existsSync(join(TMP, 'data', 'games.db')));
    const skippedSrc = await applyMigration((sql) => dbMod.db.exec(sql));
    if (skippedSrc) console.log('  （Express 线：0008 有 ' + skippedSrc + ' 条因列已存在跳过）');
    await suite(makeLine('src', 'Express', forumMod, dbMod.db));

    /* ② Workers 线 */
    const d1 = new LocalD1(join(TMP, 'worker-tags.db'));
    closers.push(() => d1.close());
    await migrateWorker(d1);
    const skippedW = await applyMigration((sql) => d1.prepare(sql).run());
    if (skippedW) console.log('  （Workers 线：0008 有 ' + skippedW + ' 条因列已存在跳过）');
    await suite(makeLine('worker', 'Workers+D1', await import('../worker/data-forum.js'), d1));
  } catch (e) {
    fail++;
    console.error('  FAIL 脚本中断 :: ' + ((e && e.stack) || e));
  } finally {
    for (const close of closers.reverse()) { try { close(); } catch (e) { /* 关不掉不影响结论 */ } }
    try { rmSync(TMP, { recursive: true, force: true }); }
    catch (e) { console.error('临时目录没能删掉，请手工清理：' + TMP); }
    console.log('\n通过 ' + pass + ' / 失败 ' + fail);
    process.exitCode = fail ? 1 : 0;
  }
})();
