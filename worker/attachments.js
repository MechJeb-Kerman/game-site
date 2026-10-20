/**
 * 论坛附件的 Worker 侧入口：把 src/attachments.js 的存储适配层用 d1 驱动包一层。
 *
 * 与 worker/ 下其它模块同一套约定：**db 作第一个参数、全程 await**（D1 没有同步 API），
 * 这里的每个函数都是「薄壳」——真正的规则、SQL、去重、回收逻辑都在 src/attachments.js，
 * 两条线共用一份，避免 Express 与 Workers 判定不一致。
 *
 * 主理人接线（本文件不碰 worker/app.js，只留接口）：
 *   1) ROUTES 里加一条（两段路径，与单段的 { m:'GET', p:'/ugc/:file' } 不冲突）：
 *        { m: 'GET', p: '/ugc/a/:id', fn: pageAttachment }
 *      并 import { pageAttachment } from './attachments.js';
 *   2) 发帖 / 编辑处把表单里的文件存下来（input 里是 { name, type, size, bytes }）：
 *        const saved = await saveAttachment(ctx.db, {
 *          ownerId: ctx.user.id, postId: post.id, threadId: thread.id,
 *          filename: file.name, mime: file.type, bytes: file.bytes
 *        });
 *      未随帖发布的附件可以先只给 ownerId（落成 pending），帖子建好后用 attachAttachment(db, id, {...}) 认领。
 *   3) 删帖 / 删附件：await removeAttachment(db, id, ownerId, { purge: true })。
 *      管理员入口传 { force: true } 可越过 owner 判定。
 *   4) 定期回收（可选）：await gcAttachments(db) —— 清掉超过 24h 没挂上帖子的 pending 行。
 *
 * 表结构由 ensureAttachments(db) 按 src/attachments.js 的 ATTACH_DDL 幂等补建（每句必须是单行，
 * D1 的 exec 按换行切语句）；worker/schema.js 与 migrations/0011_attachments.sql 是同一份的可读版。
 */
import {
  createStore,
  ATTACH_DDL,
  ATTACH_STATUS,
  ATTACH_STORAGE,
  attachmentUrl,
  validateAttachment,
  D1_BLOB_MAX,
  D1_BLOB_LABEL
} from '../src/attachments.js';

/** 一个 isolate 里同一份 D1 绑定只建一次 store（attachments.js 内部也记着「这张表建过了」） */
const STORES = new WeakMap();

function noStore() {
  return {
    error: 'storage_unavailable',
    hint: 'Worker 线要把 D1 绑定传进来（env.DB）；本地跑用 tools/d1-local.mjs 的 LocalD1(file) 顶替'
  };
}

/** db（D1 绑定）→ store；拿不到可用绑定就给 null，调用方返回 noStore() */
function storeOf(db) {
  if (!db || typeof db.prepare !== 'function') return null;
  let s = STORES.get(db);
  if (!s) {
    s = createStore({ driver: ATTACH_STORAGE.D1, db: db });
    STORES.set(db, s);
  }
  return s && s.error ? null : s;
}

/**
 * 幂等建表：attachments + attachments_blob 与 6 条索引。
 * 逐句 exec（D1 的 exec 按换行切语句，所以 DDL 必须单行），重复调用安全。
 */
export async function ensureAttachments(db) {
  if (!db || typeof db.exec !== 'function') return noStore();
  for (let i = 0; i < ATTACH_DDL.length; i++) await db.exec(ATTACH_DDL[i]);
  return { ok: true, statements: ATTACH_DDL.length };
}

/**
 * 存一份附件。
 * @param {object} db D1 绑定（env.DB）
 * @param {{ownerId:number,threadId?:number,postId?:number,filename:string,mime?:string,bytes:Uint8Array|ArrayBuffer|string}} input
 * @returns {Promise<{ok:true,id:number,url:string,key:string,sha256:string,bytes:number,status:string,driver:string}|{error:string,hint?:string}>}
 *          校验不过给中文 { error }；D1 装不下给 { error:'too_large_for_d1' }；没有 db 给 { error:'storage_unavailable' }
 */
export async function saveAttachment(db, input) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.save(input || {});
}

/**
 * 取附件元数据；opts.withBody 为真时多带 body:Uint8Array。
 * @returns {Promise<object|{error:string}>} 找不到给 { error:'not_found' }，内容被回收了给 { error:'body_missing' }
 */
export async function getAttachment(db, id, opts) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.get(id, opts || {});
}

/**
 * pending 认领：把已上传的附件挂到帖子 / 主题上并置 active。
 * @returns {Promise<{ok:true,id:number,threadId:number,postId:number,status:string}|{error:string,hint?:string}>}
 *          已软删给 { error:'deleted' }；ownerId 不符给 { error:'forbidden' }
 */
export async function attachAttachment(db, id, place) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.attach(id, place || {});
}

/**
 * 软删（行留着、状态改 deleted）。opts.purge 为真时顺手把没人再引用的内容真删掉；
 * opts.force 为真时跳过 owner 判定（管理员入口用）。
 * @returns {Promise<{ok:true,id:number,already:boolean,purged:boolean,status:string}|{error:string,hint?:string}>}
 */
export async function removeAttachment(db, id, ownerId, opts) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.remove(id, ownerId, opts || {});
}

/** 某个帖子下的附件（不含已删，按 id 升序） */
export async function listPostAttachments(db, postId) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.listByPost(postId);
}

/** 某个主题下的附件（不含已删，按 id 升序） */
export async function listThreadAttachments(db, threadId) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.listByThread(threadId);
}

/**
 * 回收孤儿：超过 24h 还没挂上帖子的 pending 行连内容一起清掉。
 * @param {number} [now] 当前毫秒时间戳（测试注入用，默认 Date.now）
 * @returns {Promise<{ok:true,removed:number,purged:number,cutoff:string}|{error:string}>}
 */
export async function gcAttachments(db, now) {
  const store = storeOf(db);
  if (!store) return noStore();
  return store.gcOrphans(now);
}

/**
 * 附件响应头：类型只用库里存的白名单 MIME，配 nosniff，避免浏览器猜成 HTML 去执行。
 * 文件名走 RFC 5987 的 filename*（中文名不能直接塞进头里）。
 */
export function attachmentHeaders(row) {
  const name = String((row && row.filename) || 'attachment');
  return {
    'content-type': String((row && row.mime) || 'application/octet-stream'),
    'content-length': String(Number((row && row.bytes) || 0)),
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(name)
  };
}

/**
 * GET /ugc/a/:id 的处理器（形状对齐 pageUgcFile(ctx, params)）。
 * 只有 active（随帖发布之后）才发；pending（传了却没发成帖）与已软删、查不到、内容被回收的一律 404
 * —— id 是自增整数，不能让人按顺序翻出别人还没发布的草稿附件。
 * 响应头自带 content-type / cache-control / nosniff，所以不依赖 makeHeaders；
 * 想跟站内其它响应统一风格（CSP 等），把 headers 换成 makeHeaders(ctx, { type: row.mime, cache: 'public, max-age=300' }) 即可。
 */
export async function pageAttachment(ctx, params) {
  const notFound = function () {
    return new Response('404 Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  };
  const id = String((params && params.id) || '');
  if (!/^[0-9]{1,18}$/.test(id)) return notFound();
  const row = await getAttachment(ctx.db, Number(id), { withBody: true });
  if (!row || row.error || !row.body || row.status !== ATTACH_STATUS.ACTIVE) return notFound();
  return new Response(row.body, { status: 200, headers: attachmentHeaders(row) });
}

export { attachmentUrl, validateAttachment, ATTACH_STATUS, ATTACH_DDL, D1_BLOB_MAX, D1_BLOB_LABEL };
