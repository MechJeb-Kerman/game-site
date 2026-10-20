/**
 * 黑名单正则缓存「跨实例共享」接线验收（第十四批）。
 *
 * 被验的接线：worker/data-forum.js 的 forumRules(db) —— 冷读时不再自己 compileRules，
 * 而是走 worker/ratelimit.js 的 createRuleCache（介质默认 caches.default）。
 *
 * 怎么把「真的共享了」验成可证伪的：
 *   1) 造假 Cache API（Map + match/put/delete，计数）；
 *   2) iso A 冷读 → 介质里出现键 forum-rules:1:fp1:… 的条目，正文里正则写成 { $re, $flags }；
 *   3) 把这条件目的正文改掉：往规则数组里塞一条库里根本没有的 pattern 'zzz-marker'（action=reject）；
 *   4) iso B（同一文件的另一次 import，模块局部状态是干净的）再读 → 若它命中介质，
 *      规则里就会带上那条 marker；若它绕过介质自己 compileRules(库里的行)，marker 不可能出现。
 *      → 命中 marker 才算共享成立，这条断言不可能因为「B 也编译了一遍」而假绿。
 *
 * 顺带锁住三件改造不许丢的行为：本地 10 秒 TTL 仍在最前面、改规则后指纹换键立刻生效、
 * 宿主没有 caches 时（node / 老运行时）退化成内存照样能用。
 *
 * 只碰内存库（LocalD1(':memory:')），不打开 data/games.db、不监听端口。
 */
import { LocalD1 } from './d1-local.mjs';
import { matchRules } from '../src/forum-guard.js';

const FILE = new URL('../worker/data-forum.js', import.meta.url).href;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail))); }
}

/* ---------- 假 Cache API ---------- */
const cacheMap = new Map();
const hits = { match: 0, put: 0, del: 0 };
function makeCaches() {
  return {
    default: {
      async match(url) {
        hits.match++;
        const e = cacheMap.get(String(url));
        if (!e) return null;
        if (e.expiresAt && e.expiresAt < Date.now()) { cacheMap.delete(String(url)); return null; }
        return new Response(e.body, { headers: { 'Cache-Control': 'max-age=' + e.secs } });
      },
      async put(url, res) {
        hits.put++;
        const cc = res.headers.get('Cache-Control') || '';
        const m = /max-age=(\d+)/.exec(cc);
        const secs = m ? Number(m[1]) : 60;
        cacheMap.set(String(url), { body: await res.text(), secs, expiresAt: Date.now() + secs * 1000 });
      },
      async delete(url) { hits.del++; return cacheMap.delete(String(url)); }
    }
  };
}
globalThis.caches = makeCaches();

/* ---------- 内存库 ---------- */
const db = new LocalD1(':memory:');
// 单行 SQL：LocalD1.exec 与真 D1 一样按换行切语句，多行 DDL 会被切坏
await db.exec("CREATE TABLE forum_blacklist (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, kind TEXT DEFAULT 'word', action TEXT DEFAULT 'review', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))");

const isoA = await import(FILE);
const isoB = await import(FILE + '?isolate=b');

/* ---------- 1. 冷读写入介质 ---------- */
await isoA.addBlacklist(db, { pattern: '干死你', kind: 'word', action: 'reject' });
await isoA.addBlacklist(db, { pattern: 'tr[a4]sh', kind: 'regex', action: 'review' });

const rulesA = await isoA.forumRules(db);
ok('A 冷读拿到 2 条规则', Array.isArray(rulesA) && rulesA.length === 2, rulesA && rulesA.length);
ok('A 的规则能正常匹配（word reject）', matchRules('我要干死你', rulesA).action === 'reject');
ok('A 的规则能正常匹配（regex review）', matchRules('tr4sh talk', rulesA).action === 'review');
ok('冷读把编译产物写进了共享介质', cacheMap.size === 1 && hits.put >= 1, { size: cacheMap.size, hits });

const entryUrl = [...cacheMap.keys()][0] || '';
ok('介质键带前缀与规则指纹', /forum-rules:1:fp1:[0-9a-f]{8}:2$/.test(decodeURIComponent(entryUrl)), decodeURIComponent(entryUrl));
const entryBody = [...cacheMap.values()][0] ? [...cacheMap.values()][0].body : '';
ok('介质正文把 RegExp 编码成 { $re, $flags }', entryBody.includes('"$re"') && entryBody.includes('"$flags"'), entryBody.slice(0, 90));

/* ---------- 2. 篡改介质：塞一条库里没有的规则 ---------- */
function findRulesArray(v) {
  if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && typeof x.pattern === 'string')) return v;
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { const r = findRulesArray(v[k]); if (r) return r; }
  return null;
}
const entry = [...cacheMap.values()][0];
const parsedEntry = JSON.parse(entry.body);
const arr = findRulesArray(parsedEntry);
ok('能在介质条目里定位到规则数组（篡改前提）', !!arr, Object.keys(parsedEntry));
arr.push({ kind: 'regex', action: 'reject', pattern: 'zzz-marker', re: { $re: 'zzz-marker', $flags: 'i' } });
entry.body = JSON.stringify(parsedEntry);

/* ---------- 3. B 实例必须命中这条被篡改的介质 ---------- */
const before = hits.match;
const rulesB = await isoB.forumRules(db);
ok('B 冷读先查了介质', hits.match > before, { before, after: hits.match });
const hitB = matchRules('这句里有 zzz-marker 这个词', rulesB);
ok('B 用的是介质里的产物（篡改的 marker 命中）', hitB.action === 'reject' && hitB.hits.includes('zzz-marker'), hitB);
ok('B 拿到的规则仍是可用的 RegExp（$re 被重建）', matchRules('tr4sh', rulesB).action === 'review');
ok('B 没有把介质覆盖成自己编译的版本', JSON.parse([...cacheMap.values()][0].body).value
  ? findRulesArray(JSON.parse([...cacheMap.values()][0].body)).length === 3
  : true, findRulesArray(JSON.parse([...cacheMap.values()][0].body)).length);

/* ---------- 4. 本地 10 秒 TTL 仍在最前面 ---------- */
const matchBefore = hits.match;
const again = await isoB.forumRules(db);
ok('10 秒内重复读不再碰介质', hits.match === matchBefore, { before: matchBefore, after: hits.match });
ok('重复读回的是同一份本地副本', again === rulesB);

/* ---------- 5. 改规则：指纹换键，新规则立刻生效 ---------- */
await isoB.addBlacklist(db, { pattern: '新词条', kind: 'word', action: 'reject' });
const rulesB2 = await isoB.forumRules(db);
ok('改规则后本地副本立刻失效并重新取', rulesB2 !== rulesB && rulesB2.length === 3);
ok('新规则立刻能匹配', matchRules('这里有新词条', rulesB2).action === 'reject');
ok('指纹变化生成新的介质键（旧条目留着等 TTL）', cacheMap.size === 2, cacheMap.size);

/* ---------- 6. 宿主没有 caches（node / 老运行时）也能用 ---------- */
delete globalThis.caches;
const hitsBeforeC = { ...hits };
const isoC = await import(FILE + '?isolate=c');
const rulesC = await isoC.forumRules(db);
ok('无 caches 宿主退化成内存仍然可用', Array.isArray(rulesC) && rulesC.length === 3, rulesC && rulesC.length);
ok('无 caches 宿主照旧能匹配', matchRules('这里有新词条', rulesC).action === 'reject');
ok('退化路径一次介质往返都没有', hits.match === hitsBeforeC.match && hits.put === hitsBeforeC.put,
  { before: hitsBeforeC, after: hits });

console.log('\n通过 ' + pass + ' / 失败 ' + fail + '（共 ' + (pass + fail) + ' 条用例）');
process.exit(fail ? 1 : 0);
