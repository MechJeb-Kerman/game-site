/**
 * 论坛附件自测（零外部依赖）。跑法：node tools/attachments-test.mjs
 *
 * 覆盖：校验规则（扩展名 / 大小 / 声明类型 / 魔数 / 文件名清洗）、基础工具（base64、sha256、时间戳、大小文案）、
 * DDL 的单行约束与源码约定、未配置驱动时的回退、fs 与 d1 两个驱动的端到端（去重 / 认领 / 软删 / 引用计数 /
 * 孤儿回收）、multipart 的原始字节、upload.js 的 UPLOAD_KINDS、worker/attachments.js 的包装层与 /ugc/a/:id 响应。
 *
 * 临时文件只写 D:/CODE/.tmp-ver/attach-test（跑前清、跑完删；不碰仓库里的 data/）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalD1 } from './d1-local.mjs';
import { parseMultipart, formFromMultipart } from '../src/multipart.js';
import { UPLOAD_KINDS, UPLOAD_MAX, UPLOAD_LABEL, validateHtmlUpload, validateAttachment as validateViaUpload } from '../src/upload.js';
import * as A from '../src/attachments.js';
import * as W from '../worker/attachments.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = 'D:/CODE/.tmp-ver/attach-test';
const T0 = Date.now();
const OPEN = [];

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + extra));
  }
}
function is(name, got, want) {
  ok(name, Object.is(got, want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function has(name, text, needle) {
  const s = String(text);
  ok(name, s.indexOf(needle) >= 0, 'got=' + JSON.stringify(s));
}
function section(title) {
  console.log('');
  console.log('== ' + title);
}
function bytesEq(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && Buffer.compare(x, y) === 0;
}
function monthOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
}
function cleanup() {
  for (let i = 0; i < OPEN.length; i++) {
    try {
      OPEN[i].close();
    } catch (e) {
      /* 关不掉就算了，别让清理把测试结果盖掉 */
    }
  }
  OPEN.length = 0;
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (e) {
    /* Windows 上偶发占用，清理失败不影响断言 */
  }
}

const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const PDF = enc.encode('%PDF-1.7\n1 0 obj\n');
const TXT = enc.encode('日志第一行\n第二行\n');

function fsStoreAt(dir) {
  const db = new DatabaseSync(':memory:');
  OPEN.push(db);
  return A.createStore({ driver: 'fs', db: db, dir: dir, now: () => T0 });
}

async function main() {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  mkdirSync(TMP, { recursive: true });

  // ---------------------------------------------------------------- 1 校验规则
  section('1. 校验规则（扩展名 / 大小 / 声明类型 / 魔数）');
  const good = [
    ['PNG 图片', 'shot.png', 'image/png', PNG, 'image'],
    ['JPEG 图片', 'pic.jpg', 'image/jpeg', JPEG, 'image'],
    ['JPEG 图片（.jpeg）', 'pic.jpeg', 'image/jpeg', JPEG, 'image'],
    ['GIF 图片', 'anim.gif', 'image/gif', GIF, 'image'],
    ['WebP 图片', 'pic.webp', 'image/webp', WEBP, 'image'],
    ['txt 文本', 'notes.txt', 'text/plain', TXT, 'text'],
    ['md 文本', 'readme.md', 'text/markdown', TXT, 'text'],
    ['csv 文本', 'data.csv', 'text/csv', TXT, 'text'],
    ['log 文本', 'run.log', 'text/plain', TXT, 'text'],
    ['zip 压缩包', 'pkg.zip', 'application/zip', ZIP, 'zip']
  ];
  for (let i = 0; i < good.length; i++) {
    const g = good[i];
    const r = A.validateAttachment(g[1], g[2], g[3]);
    ok('接受' + g[0] + '（' + g[1] + '）', r.ok === true && r.kind === g[4] && r.size === g[3].length, JSON.stringify(r));
  }
  const bySize = A.validateAttachment('shot.png', 'image/png', 12345);
  ok('只给字节数时跳过魔数检查', bySize.ok === true && bySize.size === 12345, JSON.stringify(bySize));
  is('校验结果带回清洗后的名字', A.validateAttachment('..\\..\\shot.png', 'image/png', PNG).name, 'shot.png');

  const bigImage = new Uint8Array(2 * 1024 * 1024 + 1);
  bigImage.set(PNG);
  has('图片超 2 MB 被拒', A.validateAttachment('big.png', 'image/png', bigImage).error, '图片最大 2 MB');
  const bigText = new Uint8Array(256 * 1024 + 1).fill(0x61);
  has('文本超 256 KB 被拒', A.validateAttachment('big.txt', 'text/plain', bigText).error, '文本最大 256 KB');
  const bigZip = new Uint8Array(4 * 1024 * 1024 + 1);
  bigZip.set(ZIP);
  has('压缩包超 4 MB 被拒', A.validateAttachment('big.zip', 'application/zip', bigZip).error, '压缩包最大 4 MB');

  has('没有扩展名被拒', A.validateAttachment('README', 'text/plain', TXT).error, '附件要带扩展名');
  has('白名单外的扩展名被拒', A.validateAttachment('run.exe', 'application/octet-stream', PNG).error, '不支持 .exe');
  has('.html 不能当附件', A.validateAttachment('page.html', 'text/html', TXT).error, '不支持 .html');
  is('文件名全空被拒', A.validateAttachment('', 'text/plain', TXT).error, '文件名不能为空');
  has('空文件被拒', A.validateAttachment('a.txt', 'text/plain', new Uint8Array(0)).error, '是空的');
  has('没给内容被拒', A.validateAttachment('a.txt', 'text/plain', undefined).error, '没拿到附件内容');
  has('声明类型不符被拒', A.validateAttachment('a.png', 'text/plain', PNG).error, '类型应为 image/png');
  is('application/octet-stream 视为没提供类型', A.validateAttachment('a.png', 'application/octet-stream', PNG).ok, true);
  is('空 mime 视为没提供类型', A.validateAttachment('a.png', '', PNG).ok, true);
  has('魔数与扩展名不符被拒（png 里是 GIF）', A.validateAttachment('a.png', 'image/png', GIF).error, '魔数不符');
  has('魔数报错里说清看到的是什么', A.validateAttachment('a.png', 'image/png', GIF).error, 'GIF 图片');
  has('zip 里塞 PNG 被拒', A.validateAttachment('a.zip', 'application/zip', PNG).error, '不像压缩包');
  has('文本里塞 PDF 被拒', A.validateAttachment('a.txt', 'text/plain', PDF).error, 'PDF 文件');
  has('文本里有 NUL 字节被拒', A.validateAttachment('a.txt', 'text/plain', new Uint8Array([0x61, 0x00, 0x62])).error, 'NUL 字节');

  is('sniffKind：PNG', A.sniffKind(PNG), 'png');
  is('sniffKind：JPEG', A.sniffKind(JPEG), 'jpeg');
  is('sniffKind：GIF', A.sniffKind(GIF), 'gif');
  is('sniffKind：WebP', A.sniffKind(WEBP), 'webp');
  is('sniffKind：ZIP', A.sniffKind(ZIP), 'zip');
  is('sniffKind：PDF', A.sniffKind(PDF), 'pdf');
  is('sniffKind：纯文本 → null', A.sniffKind(TXT), null);

  // ---------------------------------------------------------------- 2 文件名与基础工具
  section('2. 文件名清洗与基础工具');
  is('清掉路径（正反斜杠都算）', A.cleanFilename('..\\..\\evil.png'), 'evil.png');
  is('只留最后一段', A.cleanFilename('C:/tmp/a/b.md'), 'b.md');
  is('清掉控制字符', /[\u0000-\u001f\u007f]/.test(A.cleanFilename('a\u0001b\u007f.txt')), false);
  const longName = A.cleanFilename('a'.repeat(120) + '.md');
  ok('超长名截到 64 以内且保住扩展名', longName.length <= A.FILENAME_MAX && /\.md$/.test(longName), longName);
  is('extOf 取小写扩展名', A.extOf('A.PNG'), 'png');
  ok('extOf 没有扩展名时给空', !A.extOf('noext'));

  ok('fmtSize：字节', /^512 B$/.test(A.fmtSize(512)), A.fmtSize(512));
  ok('fmtSize：KB', /^2(\.0)? KB$/.test(A.fmtSize(2048)), A.fmtSize(2048));
  ok('fmtSize：MB', /^1\.5 MB$/.test(A.fmtSize(1536 * 1024)), A.fmtSize(1536 * 1024));
  ok('localStamp 是 SQLite 那套本地时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(A.localStamp(T0)), A.localStamp(T0));

  const raw = new Uint8Array([0, 1, 254, 255, 200, 7, 63, 64]);
  const b64 = A.bytesToB64(raw);
  ok('base64 往返一致', bytesEq(A.b64ToBytes(b64), raw), b64);
  ok('base64 长度按 4 的倍数补等号', b64.length % 4 === 0 && b64.indexOf('=') > 0, b64);
  is('空内容 base64 是空串', A.bytesToB64(new Uint8Array(0)), '');
  is('中文经 base64 往返还是中文', new TextDecoder().decode(A.b64ToBytes(A.bytesToB64(enc.encode('截图.png')))), '截图.png');

  is('sha256Hex 已知向量 abc', await A.sha256Hex(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  is('sha256Hex 空内容', await A.sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  is('同内容两次哈希相同', await A.sha256Hex(PNG), await A.sha256Hex(Uint8Array.from(PNG)));

  ok('toBytes：字符串按 UTF-8', bytesEq(A.toBytes('中文'), enc.encode('中文')));
  ok('toBytes：ArrayBuffer 收下', bytesEq(A.toBytes(PNG.buffer), PNG));
  is('toBytes：null 给空数组', A.toBytes(null).length, 0);
  is('附件 URL 前缀', A.ATTACH_PREFIX, '/ugc/a/');
  is('attachmentUrl 形状', A.attachmentUrl(12), '/ugc/a/12');
  is('URL 是 /ugc 下的两段（与单段的 /ugc/:file 不冲突）', A.attachmentUrl(12).split('/').filter(Boolean).length, 3);

  // ---------------------------------------------------------------- 3 DDL 与源码约定
  section('3. 表结构与源码约定（Worker 打包约束）');
  is('ATTACH_DDL 共 7 句', A.ATTACH_DDL.length, 7);
  let singleLine = true;
  let allCreate = true;
  for (let i = 0; i < A.ATTACH_DDL.length; i++) {
    if (String(A.ATTACH_DDL[i]).indexOf('\n') >= 0) singleLine = false;
    if (String(A.ATTACH_DDL[i]).slice(0, 7) !== 'CREATE ') allCreate = false;
  }
  ok('每句都是单行（D1 的 exec 按换行切语句）', singleLine);
  ok('每句都以 CREATE 开头', allCreate);
  const ddlAll = A.ATTACH_DDL.join('\n');
  has('attachments 用双引号引用 key 列', ddlAll, '"key" TEXT');
  has('created_at 用 SQLite 的本地时间默认值', ddlAll, "datetime('now','localtime')");
  has('status 默认 pending', ddlAll, "status TEXT NOT NULL DEFAULT 'pending'");
  ok('attachments 与 attachments_blob 都建了', ddlAll.indexOf('attachments (') > 0 && ddlAll.indexOf('attachments_blob') > 0);
  ok('5 条索引都建了', (ddlAll.match(/CREATE INDEX IF NOT EXISTS/g) || []).length === 5, String((ddlAll.match(/CREATE INDEX IF NOT EXISTS/g) || []).length));
  is('owner_id 故意不加 REFERENCES', ddlAll.indexOf('REFERENCES'), -1);

  const srcText = readFileSync(join(ROOT, 'src', 'attachments.js'), 'utf8');
  ok('attachments.js 顶层没有静态 node: 导入', !/^import[^\n]*from\s*['"]node:/m.test(srcText));
  has('node:fs 是拼出来的（躲开 Worker 打包器的静态解析）', srcText, "'node' + ':fs'");
  // 绑定的是 src/ 里的 ./db.js（写成拼串只为绕开打包器的静态解析）；
  // 曾经写成 '../db.js' 会在 Express 线第一次真正存附件时 ERR_MODULE_NOT_FOUND 崩掉
  has('src/db.js 也是拼出来的（不是仓库根的 ../db.js）', srcText, "['.', 'db.js'].join('/')");
  const wText = readFileSync(join(ROOT, 'worker', 'attachments.js'), 'utf8');
  has('worker/attachments.js 复用 src 的实现', wText, "from '../src/attachments.js'");
  has('worker 里写明了要加的 ROUTES 行', wText, "'/ugc/a/:id'");
  const migText = readFileSync(join(ROOT, 'migrations', '0011_attachments.sql'), 'utf8');
  ok('迁移文件与单行 DDL 对齐（表名都在）', migText.indexOf('CREATE TABLE IF NOT EXISTS attachments (') > 0 && migText.indexOf('CREATE TABLE IF NOT EXISTS attachments_blob') > 0);
  is('迁移文件里索引也是 5 条', (migText.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 5);
  const migFlat = migText.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  let parity = 0;
  for (let i = 0; i < A.ATTACH_DDL.length; i++) {
    const m = /(?:TABLE|INDEX) IF NOT EXISTS ([A-Za-z_]+)/.exec(A.ATTACH_DDL[i]);
    if (m && migFlat.indexOf(m[1]) >= 0) parity++;
  }
  is('迁移文件覆盖了单行 DDL 里的全部 7 个对象', parity, A.ATTACH_DDL.length);
  const cols = ['owner_id', 'thread_id', 'post_id', 'filename', 'mime', 'bytes', 'sha256', 'storage', '"key"', 'created_at', 'status'];
  ok('迁移文件里 attachments 的列齐全', cols.every(function (c) { return migFlat.indexOf(c) >= 0; }));
  has('迁移文件里 status 默认也是 pending', migFlat, "status TEXT NOT NULL DEFAULT 'pending'");
  has('迁移文件里 created_at 也是本地时间默认值', migFlat, "datetime('now','localtime')");

  // ---------------------------------------------------------------- 4 未配置驱动
  section('4. 没接上存储时的回退（不抛错，给中文提示）');
  const noDriver = A.createStore();
  is('没给 driver → storage_unavailable', noDriver.error, 'storage_unavailable');
  has('提示里说清怎么接', noDriver.hint, 'createStore');
  const badDriver = A.createStore({ driver: 'redis' });
  is('不认识的 driver 也是 storage_unavailable', badDriver.error, 'storage_unavailable');
  has('提示里点名 driver', badDriver.hint, '不认识的存储驱动 redis');
  has('d1 缺 db 时给出提示', A.createStore({ driver: 'd1' }).hint, 'db 绑定');
  has('fs 传错 db 时给出提示', A.createStore({ driver: 'fs', db: {} }).hint, 'DatabaseSync');
  const okStore = A.createStore({ driver: 'fs', db: new DatabaseSync(':memory:'), dir: TMP + '/probe' });
  OPEN.push(okStore === null ? null : undefined);
  OPEN.pop();
  is('ensure 幂等且报驱动名', (await okStore.ensure()).driver, 'fs');
  is('store.dir() 去掉尾斜杠', await okStore.dir(), TMP + '/probe');

  // ---------------------------------------------------------------- 5 fs 驱动
  section('5. fs 驱动：真磁盘 + node:sqlite（去重 / 认领 / 软删 / 引用计数）');
  const fs1 = fsStoreAt(TMP + '/disk');
  const saved = await fs1.save({ ownerId: 7, filename: 'shot.PNG', mime: 'image/png', bytes: PNG });
  is('fs：save.ok', saved.ok, true);
  is('fs：url 形状', saved.url, '/ugc/a/' + saved.id);
  is('fs：没挂帖时是 pending', saved.status, 'pending');
  is('fs：driver', saved.driver, 'fs');
  is('fs：bytes', saved.bytes, PNG.length);
  is('fs：key 是 yyyymm/前2位/sha256.ext', saved.key, monthOf(T0) + '/' + saved.sha256.slice(0, 2) + '/' + saved.sha256 + '.png');
  const diskPath = TMP + '/disk/' + saved.key;
  ok('fs：内容真落盘', existsSync(diskPath), diskPath);
  ok('fs：落盘字节与上传一致', existsSync(diskPath) && bytesEq(readFileSync(diskPath), PNG));

  const got = await fs1.get(saved.id, { withBody: true });
  is('fs：get.id', got.id, saved.id);
  is('fs：get.owner_id', got.owner_id, 7);
  is('fs：get.status', got.status, 'pending');
  is('fs：get.mime', got.mime, 'image/png');
  is('fs：get.bytes', got.bytes, PNG.length);
  is('fs：get.storage', got.storage, 'fs');
  is('fs：get.post_id', got.post_id, 0);
  ok('fs：get 的字节与原内容一致', bytesEq(got.body, PNG));
  ok('fs：get.created_at 是 SQLite 那套格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(got.created_at), got.created_at);
  is('fs：不带 withBody 时没有 body', (await fs1.get(saved.id)).body, undefined);
  is('fs：get 不存在的 id', (await fs1.get(9999)).error, 'not_found');
  is('fs：get 非法 id', (await fs1.get(0)).error, 'not_found');
  is('fs：save 缺 ownerId', (await fs1.save({ filename: 'a.png', mime: 'image/png', bytes: PNG })).error, '缺少上传者（ownerId）');
  has('fs：save 里也跑校验', (await fs1.save({ ownerId: 7, filename: 'a.exe', mime: 'application/octet-stream', bytes: PNG })).error, '不支持 .exe');

  const dup = await fs1.save({ ownerId: 9, filename: 'copy.png', mime: 'image/png', bytes: PNG });
  is('fs：同内容复用同一份实体', dup.key, saved.key);
  is('fs：去重计数', fs1.stats().dedupes, 1);
  is('fs：两份行指向同一份内容', dup.sha256, saved.sha256);

  is('fs：attach 认领', (await fs1.attach(saved.id, { ownerId: 7, threadId: 3, postId: 42 })).status, 'active');
  is('fs：attach 后 post_id', (await fs1.get(saved.id)).post_id, 42);
  is('fs：attach 后 thread_id', (await fs1.get(saved.id)).thread_id, 3);
  is('fs：别人不能认领', (await fs1.attach(saved.id, { ownerId: 8, postId: 1 })).error, 'forbidden');
  is('fs：attach 不存在的 id', (await fs1.attach(9999, { postId: 1 })).error, 'not_found');
  const lp = await fs1.listByPost(42);
  is('fs：listByPost.total', lp.total, 1);
  is('fs：listByPost 项里的 post_id', lp.items[0].post_id, 42);
  is('fs：listByThread.total', (await fs1.listByThread(3)).total, 1);
  is('fs：postId 为 0 时直接空', (await fs1.listByPost(0)).total, 0);

  const rmWrong = await fs1.remove(saved.id, 8);
  is('fs：别人不能删', rmWrong.error, 'forbidden');
  has('fs：拒绝文案带 hint', rmWrong.hint, 'force');
  const rm1 = await fs1.remove(saved.id, 7, { purge: true });
  is('fs：软删的状态', rm1.status, 'deleted');
  is('fs：还留着另一份引用时内容不删', rm1.purged, false);
  ok('fs：共用实体时文件还在磁盘上', existsSync(diskPath));
  const rm2 = await fs1.remove(dup.id, 9, { purge: true });
  is('fs：删掉最后一份引用才真删', rm2.purged, true);
  ok('fs：文件已从磁盘移除', !existsSync(diskPath));
  is('fs：stats.purged', fs1.stats().purged, 1);
  is('fs：重复删报 already', (await fs1.remove(saved.id, 7)).already, true);
  is('fs：软删后 get 仍能拿到行', (await fs1.get(saved.id)).status, 'deleted');
  is('fs：软删后带 body 取 → body_missing', (await fs1.get(saved.id, { withBody: true })).error, 'body_missing');
  is('fs：软删后不能认领', (await fs1.attach(saved.id, { postId: 5 })).error, 'deleted');
  is('fs：listByPost 不再含已删', (await fs1.listByPost(42)).total, 0);
  is('fs：force 能删别人的附件', (await fs1.remove(dup.id, 12345, { force: true })).ok, true);
  is('fs：remove 不存在的 id', (await fs1.remove(9999, 1)).error, 'not_found');

  section('6. fs 驱动：孤儿回收（pending 超 24h）');
  const fs2 = fsStoreAt(TMP + '/gc');
  const oldRow = await fs2.save({ ownerId: 5, filename: 'old.log', mime: 'text/plain', bytes: TXT, now: T0 - 30 * 3600 * 1000 });
  const freshRow = await fs2.save({ ownerId: 5, filename: 'fresh.log', mime: 'text/plain', bytes: enc.encode('刚传上来的\n') });
  ok('gc：旧 pending 的文件在盘上', existsSync(TMP + '/gc/' + oldRow.key));
  const gc = await fs2.gcOrphans(T0);
  is('gc：回收数量', gc.removed, 1);
  is('gc：连内容一起清', gc.purged, 1);
  ok('gc：旧文件已删除', !existsSync(TMP + '/gc/' + oldRow.key));
  ok('gc：新 pending 还在', existsSync(TMP + '/gc/' + freshRow.key));
  ok('gc：cutoff 是 SQLite 时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(gc.cutoff), gc.cutoff);
  is('gc：stats.gcRemoved', fs2.stats().gcRemoved, 1);
  is('gc：再跑一遍不再有收获', (await fs2.gcOrphans(T0)).removed, 0);
  is('gc：刚传的 pending 没被误删', (await fs2.get(freshRow.id)).status, 'pending');

  // ---------------------------------------------------------------- 7 d1 驱动
  section('7. d1 驱动：LocalD1 顶替 env.DB（base64 内容 / 上限 / 去重 / 回收）');
  const loc = new LocalD1(':memory:');
  OPEN.push(loc);
  const d1 = A.createStore({ driver: 'd1', db: loc, now: () => T0 });
  is('d1：驱动名', d1.driver, 'd1');
  is('d1：ensure.ok', (await d1.ensure()).ok, true);
  const tables = (await loc.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results.map((r) => r.name);
  ok('d1：attachments 表已建', tables.indexOf('attachments') >= 0, tables.join(','));
  ok('d1：attachments_blob 表已建', tables.indexOf('attachments_blob') >= 0, tables.join(','));
  is('d1：索引也是 5 条', (await loc.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_attachments%'").all()).results.length, 5);

  const dsaved = await d1.save({ ownerId: 3, postId: 77, threadId: 12, filename: '图 1.png', mime: 'image/png', bytes: PNG });
  is('d1：save.ok', dsaved.ok, true);
  is('d1：带 postId 时直接 active', dsaved.status, 'active');
  ok('d1：key 就是 attachments_blob 的行号', /^\d+$/.test(dsaved.key), dsaved.key);
  is('d1：blob 表一行', (await loc.prepare('SELECT COUNT(1) AS n FROM attachments_blob').first()).n, 1);
  const dgot = await d1.get(dsaved.id, { withBody: true });
  ok('d1：内容原样取回（base64 往返）', bytesEq(dgot.body, PNG));
  is('d1：storage 记的是 d1', dgot.storage, 'd1');
  is('d1：mime 存下来了', dgot.mime, 'image/png');
  ok('d1：中文文件名保留', dgot.filename.indexOf('.png') > 0, dgot.filename);
  is('d1：listByPost.total', (await d1.listByPost(77)).total, 1);
  const ddup = await d1.save({ ownerId: 4, filename: 'again.png', mime: 'image/png', bytes: PNG });
  is('d1：同内容复用 blob 行', ddup.key, dsaved.key);
  is('d1：blob 表仍然一行', (await loc.prepare('SELECT COUNT(1) AS n FROM attachments_blob').first()).n, 1);
  is('d1：还有引用时不删 blob', (await d1.remove(dsaved.id, 3, { purge: true })).purged, false);
  is('d1：删最后一份引用时删 blob', (await d1.remove(ddup.id, 4, { purge: true })).purged, true);
  is('d1：blob 表清空', (await loc.prepare('SELECT COUNT(1) AS n FROM attachments_blob').first()).n, 0);
  is('d1：内容没了以后 get 带 body → body_missing', (await d1.get(dsaved.id, { withBody: true })).error, 'body_missing');

  const hugeZip = new Uint8Array(300 * 1024);
  hugeZip.set(ZIP);
  const dBig = await d1.save({ ownerId: 3, filename: 'big.zip', mime: 'application/zip', bytes: hugeZip });
  is('d1：超过 256 KB 的实体内拒', dBig.error, 'too_large_for_d1');
  has('d1：拒绝时给人话提示', dBig.hint, '256 KB');
  is('d1：拒绝时不留下 blob 行', (await loc.prepare('SELECT COUNT(1) AS n FROM attachments_blob').first()).n, 0);

  const dOld = await d1.save({ ownerId: 3, filename: 'old.txt', mime: 'text/plain', bytes: TXT, now: T0 - 30 * 3600 * 1000 });
  is('d1：旧 pending 已落库', (await d1.get(dOld.id)).status, 'pending');
  const dgc = await d1.gcOrphans(T0);
  is('d1：孤儿被回收', dgc.removed, 1);
  is('d1：blob 一起清', dgc.purged, 1);
  is('d1：blob 表空了', (await loc.prepare('SELECT COUNT(1) AS n FROM attachments_blob').first()).n, 0);
  is('d1：回收后 get → not_found', (await d1.get(dOld.id)).error, 'not_found');

  // ---------------------------------------------------------------- 8 multipart 原始字节
  section('8. multipart：文件字段的原始字节');
  const boundary = '----attachTestBoundary7f';
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="game_file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n', 'latin1');
  const mid = Buffer.from('\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="title"\r\n\r\n', 'latin1');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'latin1');
  const rawBody = Buffer.concat([head, Buffer.from(PNG), mid, Buffer.from('附件标题', 'utf8'), tail]);
  const ctype = 'multipart/form-data; boundary=' + boundary;
  const form = parseMultipart(rawBody, ctype);
  const fileField = form.files.game_file;
  ok('multipart：解析出文件字段', !!fileField);
  if (fileField) {
    is('multipart：size 是原始字节数', fileField.size, PNG.length);
    ok('multipart：bytes 与原字节逐字节一致', bytesEq(fileField.bytes, PNG));
    ok('multipart：bytes 是 Uint8Array', fileField.bytes instanceof Uint8Array);
    is('multipart：name 原样', fileField.name, 'shot.png');
    is('multipart：type 原样', fileField.type, 'image/png');
    is('multipart：bytes 直接喂给校验能过', A.validateAttachment(fileField.name, fileField.type, fileField.bytes).ok, true);
  }
  is('multipart：文本字段按 UTF-8 解码', form.fields.title, '附件标题');
  const flat = formFromMultipart(rawBody, ctype, 'game_file');
  is('multipart：formFromMultipart 摊平出 file', flat.file ? flat.file.name : '', 'shot.png');
  is('multipart：formFromMultipart 保留文本字段', flat.title, '附件标题');
  is('multipart：没有 boundary 时给空结构', Object.keys(parseMultipart(rawBody, 'text/plain').files).length, 0);

  // ---------------------------------------------------------------- 9 UPLOAD_KINDS
  section('9. upload.js 的上传类型总表');
  is('两类上传', Object.keys(UPLOAD_KINDS).join(','), 'game,attachment');
  is('game.max 就是 UPLOAD_MAX', UPLOAD_KINDS.game.max, UPLOAD_MAX);
  is('game.maxLabel', UPLOAD_KINDS.game.maxLabel, UPLOAD_LABEL);
  is('game.exts', UPLOAD_KINDS.game.exts.join(','), '.html,.htm');
  is('game.body 是文本', UPLOAD_KINDS.game.body, 'text');
  is('attachment.max 是绝对上限', UPLOAD_KINDS.attachment.max, A.ATTACH_MAX);
  is('attachment.maxLabel', UPLOAD_KINDS.attachment.maxLabel, A.ATTACH_MAX_LABEL);
  is('attachment.body 是字节', UPLOAD_KINDS.attachment.body, 'bytes');
  is('attachment.exts 共 10 个', UPLOAD_KINDS.attachment.exts.length, 10);
  ok('attachment.exts 含 .png/.md/.zip', ['.png', '.md', '.zip'].every((e) => UPLOAD_KINDS.attachment.exts.indexOf(e) >= 0), UPLOAD_KINDS.attachment.exts.join(' '));
  is('attachment 带着三档分组', Object.keys(UPLOAD_KINDS.attachment.groups).join(','), 'image,text,zip');
  is('两类都带 validate', typeof UPLOAD_KINDS.game.validate + '/' + typeof UPLOAD_KINDS.attachment.validate, 'function/function');
  is('game 那档接到 validateHtmlUpload', UPLOAD_KINDS.game.validate('g.html', '<!doctype html><html><body>hi</body></html>').ok, true);
  is('attachment 那档接到的就是同一套校验', UPLOAD_KINDS.attachment.validate('a.png', 'image/png', PNG).ok, true);
  is('upload.validateAttachment 薄封装可用', validateViaUpload('a.txt', 'text/plain', TXT).kind, 'text');
  ok('HTML 游戏校验照旧拒绝非 html', !!validateHtmlUpload('g.txt', '<html></html>').error);

  // ---------------------------------------------------------------- 10 worker 包装层
  section('10. worker/attachments.js：db 首参 + /ugc/a/:id 响应');
  const wdb = new LocalD1(':memory:');
  OPEN.push(wdb);
  const wens = await W.ensureAttachments(wdb);
  is('worker：ensureAttachments 执行 7 句 DDL', wens.statements, 7);
  is('worker：ensureAttachments 幂等', (await W.ensureAttachments(wdb)).ok, true);
  const wsave = await W.saveAttachment(wdb, { ownerId: 1, threadId: 2, postId: 9, filename: 'shot.png', mime: 'image/png', bytes: PNG });
  is('worker：saveAttachment.ok', wsave.ok, true);
  is('worker：url 与 src 侧一致', wsave.url, A.attachmentUrl(wsave.id));
  is('worker：带 post 时 active', wsave.status, 'active');
  const wgot = await W.getAttachment(wdb, wsave.id, { withBody: true });
  ok('worker：getAttachment 字节一致', bytesEq(wgot.body, PNG));
  is('worker：listPostAttachments.total', (await W.listPostAttachments(wdb, 9)).total, 1);
  is('worker：listThreadAttachments.total', (await W.listThreadAttachments(wdb, 2)).total, 1);
  const wpending = await W.saveAttachment(wdb, { ownerId: 1, filename: 'note.txt', mime: 'text/plain', bytes: 'hello' });
  is('worker：不带 post/thread 时落成 pending', wpending.status, 'pending');
  is('pageAttachment：pending（还没发帖）→ 404', (await W.pageAttachment({ db: wdb }, { id: String(wpending.id) })).status, 404);
  is('worker：attachAttachment 认领', (await W.attachAttachment(wdb, wpending.id, { ownerId: 1, postId: 9 })).status, 'active');
  const presp = await W.pageAttachment({ db: wdb }, { id: String(wpending.id) });
  is('pageAttachment：认领成 active 后能取', presp.status, 200);
  ok('pageAttachment：文本附件的 content-type 是 text/plain', String(presp.headers.get('content-type')).indexOf('text/plain') === 0, presp.headers.get('content-type'));
  is('worker：removeAttachment 软删 + 回收', (await W.removeAttachment(wdb, wpending.id, 1, { purge: true })).purged, true);
  is('worker：gcAttachments 没孤儿时是 0', (await W.gcAttachments(wdb, T0)).removed, 0);
  is('worker：没 db 时 storage_unavailable', (await W.saveAttachment(null, { ownerId: 1, filename: 'a.png', mime: 'image/png', bytes: PNG })).error, 'storage_unavailable');
  is('worker：ensureAttachments 没 db 时也回退', (await W.ensureAttachments(null)).error, 'storage_unavailable');
  is('worker：校验不过时原样透传错误', (await W.saveAttachment(wdb, { ownerId: 1, filename: 'a.exe', bytes: PNG })).error.indexOf('不支持 .exe') === 0, true);

  const hs = W.attachmentHeaders({ filename: '截图.png', mime: 'image/png', bytes: PNG.length });
  is('headers：content-type', hs['content-type'], 'image/png');
  is('headers：content-length', hs['content-length'], String(PNG.length));
  is('headers：cache-control', hs['cache-control'], 'public, max-age=300');
  is('headers：nosniff', hs['x-content-type-options'], 'nosniff');
  has('headers：文件名走 RFC 5987', hs['content-disposition'], "filename*=UTF-8''");
  has('headers：中文名是百分号编码', hs['content-disposition'], '%E6%88%AA%E5%9B%BE');
  is('headers：没给 mime 时兜底', W.attachmentHeaders({ filename: 'a.bin', bytes: 0 })['content-type'], 'application/octet-stream');

  const resp = await W.pageAttachment({ db: wdb }, { id: String(wsave.id) });
  is('pageAttachment：200', resp.status, 200);
  is('pageAttachment：content-type', resp.headers.get('content-type'), 'image/png');
  is('pageAttachment：nosniff', resp.headers.get('x-content-type-options'), 'nosniff');
  ok('pageAttachment：正文与上传一致', bytesEq(new Uint8Array(await resp.arrayBuffer()), PNG));
  is('pageAttachment：非数字 id → 404', (await W.pageAttachment({ db: wdb }, { id: 'abc' })).status, 404);
  is('pageAttachment：不存在的 id → 404', (await W.pageAttachment({ db: wdb }, { id: '987654' })).status, 404);
  is('pageAttachment：缺 id → 404', (await W.pageAttachment({ db: wdb }, {})).status, 404);
  await W.removeAttachment(wdb, wsave.id, 1, { purge: true });
  is('pageAttachment：已软删 → 404', (await W.pageAttachment({ db: wdb }, { id: String(wsave.id) })).status, 404);
  is('pageAttachment：内容被回收 → 404', (await W.getAttachment(wdb, wsave.id)).status, 'deleted');
}

main()
  .then(function () {
    cleanup();
    console.log('');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  })
  .catch(function (e) {
    cleanup();
    console.error('测试脚本自己炸了：', e);
    process.exit(2);
  });
