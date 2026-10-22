
const A = await import('file:///D:/CODE/game-site/src/attachments.js');
const { LocalD1 } = await import('file:///D:/CODE/game-site/tools/d1-local.mjs');
const fs = await import('node:fs');
const os = await import('node:os');
const out = [];
const say = (...a) => out.push(a.join(' '));

// 1) 官方向量
const sign = await A.signAwsV4({
  method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
  payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  region: 'us-east-1', service: 's3', accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
  headers: { range: 'bytes=0-9' }
});
say('vector sig', sign.signature);
say('vector signedHeaders', sign.signedHeaders);
say('expect match', sign.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');

// 2) local 对象存储
const dir = fs.mkdtempSync(os.tmpdir() + '/objstore-');
const loc = A.createObjectStore({ driver: 'local', dir, publicBase: 'https://cdn.example.com/u' });
const body = new Uint8Array([1, 2, 3, 250]);
const put = await loc.put('ugc/a/1.bin', body, { contentType: 'application/octet-stream' });
say('local put', JSON.stringify(put));
const got = await loc.get('ugc/a/1.bin');
say('local get', got.ok, got.size, Array.from(got.bytes).join(','));
say('local url', await loc.url('ugc/a/1.bin'));
say('local url no base', await A.createObjectStore({ driver: 'local', dir }).url('x/y'));
say('local escape', JSON.stringify(await loc.put('../evil', body)));
say('local del', JSON.stringify(await loc.delete('ugc/a/1.bin')));
say('local del again', JSON.stringify(await loc.delete('ugc/a/1.bin')));
say('local get missing', JSON.stringify((await loc.get('nope')).error));

// 3) 未配置回落
const warns = [];
const origWarn = console.warn; console.warn = (m) => warns.push(String(m));
const fb = A.createObjectStore({ driver: 's3', env: {}, dir });
const fb2 = A.createObjectStore({ driver: 'wat', env: {}, dir });
const fb3 = A.createObjectStore({ driver: 's3', env: { S3_BUCKET: 'b', S3_ACCESS_KEY: 'a' }, dir });
console.warn = origWarn;
say('fallback', fb.driver, fb.fallback, fb.fallbackReason, JSON.stringify(fb.fallbackLog));
say('fallback2', fb2.driver, fb2.fallback, fb2.fallbackReason);
say('fallback3', fb3.driver, fb3.fallback, fb3.fallbackReason);
say('warns', JSON.stringify(warns));

// 4) 自动规则分支
const PNG16 = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1,2,3,0x49,0x48,0x44,0x52]);
const pngReal = new Uint8Array(33); pngReal.set(PNG16, 0);
pngReal[16]=0; pngReal[17]=0; pngReal[18]=0x27; pngReal[19]=0x10; pngReal[20]=0; pngReal[21]=0; pngReal[22]=0; pngReal[23]=0x10;
say('size real png', JSON.stringify(A.readImageSize(pngReal)));
say('size 16B png', JSON.stringify(A.readImageSize(PNG16)));
const r1 = A.autoReviewAttachment({ filename: 'a.png', mime: 'image/png', bytes: PNG16.length }, PNG16);
say('auto 16B png', r1.status, JSON.stringify(r1.note), r1.reason);
const r2 = A.autoReviewAttachment({ filename: 'a.png', mime: 'image/png', bytes: pngReal.length }, pngReal);
say('auto real png', r2.status, r2.width, r2.height, JSON.stringify(r2.note));
const tall = new Uint8Array(33); tall.set(pngReal, 0); tall[18]=0x00; tall[19]=0x00; tall[22]=0x03; tall[23]=0x00; // 10000 x 768? 
say('auto tall', JSON.stringify(A.autoReviewAttachment({ filename: 'b.png', mime: 'image/png', bytes: tall.length }, tall)).slice(0, 160));
const r3 = A.autoReviewAttachment({ filename: 'a.exe', mime: '', bytes: 10 }, null);
say('auto ext', r3.status, r3.reason);
const r4 = A.autoReviewAttachment({ filename: 'a.txt', mime: 'text/plain', bytes: 10 }, new TextEncoder().encode('hello'));
say('auto txt ok', r4.status, JSON.stringify(r4.note));
const r5 = A.autoReviewAttachment({ filename: 'a.txt', mime: 'text/plain', bytes: PNG16.length }, PNG16);
say('auto txt png', r5.status, r5.reason);
const r6 = A.autoReviewAttachment({ filename: 'a.png', mime: 'image/png', bytes: 10 }, null);
say('auto noclip', r6.status, JSON.stringify(r6.note));
const r7 = A.autoReviewAttachment({ filename: 'a.png', mime: 'text/plain', bytes: 10 }, null);
say('auto mime', r7.status, r7.reason);
say('classifier', JSON.stringify(A.setClassifier(null)), A.getClassifier() === null);

// 5) 审核状态机（LocalD1 顶替 env.DB）
const db1 = new LocalD1(':memory:');
const d1 = A.createStore({ driver: 'd1', db: db1 });
const s1 = await d1.save({ ownerId: 7, filename: 'p.png', mime: 'image/png', bytes: PNG16 });
say('save1', JSON.stringify(s1));
const s2 = await d1.save({ ownerId: 7, filename: 't.txt', mime: 'text/plain', bytes: new TextEncoder().encode('hi') });
say('save2', s2.id, s2.status);
const q = await d1.listPending(10, 0);
say('pending total', q.total, q.items.map(i => i.id + ':' + i.review_status + ':' + i.status).join(','));
const m1 = await d1.moderate(s1.id, 'approve', { moderatorId: 42 });
say('approve', JSON.stringify(m1));
const m2 = await d1.moderate(s1.id, 'approve', { moderatorId: 42 });
say('approve again', JSON.stringify(m2));
const m3 = await d1.moderate(s1.id, 'reject', { moderatorId: 0 });
say('forbidden', JSON.stringify(m3));
const m4 = await d1.moderate(s1.id, 'reject', { moderatorId: 42 });
say('reason required', JSON.stringify(m4));
const m5 = await d1.moderate(s1.id, 'reject', { moderatorId: 42, reason: '不合规' });
say('reject', JSON.stringify(m5));
const st = await d1.moderationStats();
say('stats', JSON.stringify(st));
const rej = await d1.listRejected(10, 0);
say('rejected', rej.total, rej.items.map(i => i.id + ':' + i.status + ':' + i.review_reason).join(','));
const g1 = await d1.get(s1.id);
say('row after reject', g1.status, g1.review_status, g1.review_by, g1.review_source, g1.review_hidden, g1.review_at.length > 0);
const m6 = await d1.moderate(s1.id, 'approve', { moderatorId: 42, reason: '人工复核通过' });
say('re-approve', JSON.stringify(m6));
const g2 = await d1.get(s1.id);
say('row after approve', g2.status, g2.review_status, g2.review_hidden);
const m7 = await d1.moderate(9999, 'approve', { moderatorId: 1 });
say('not found', JSON.stringify(m7));
const m8 = await d1.moderate(s1.id, 'delete', { moderatorId: 1 });
say('bad action', JSON.stringify(m8));
const dd = await d1.ensureReview();
const dd2 = await d1.ensureReview();
say('ensureReview', JSON.stringify(dd), JSON.stringify(dd2));
db1.close();
console.log(out.join('\n'));