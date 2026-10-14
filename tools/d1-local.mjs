/**
 * 本地 D1 假实现：用 Node 22 内置的 node:sqlite 模拟 Cloudflare D1 的接口
 * （prepare / bind / first / all / run / batch / exec），
 * 让 worker/ 下的代码在本机可以原样跑通，不需要 wrangler、不需要外网、不需要 Miniflare。
 *
 * 对齐 D1 的关键语义：
 *   - prepare() 出来的语句是不可变的，bind() 返回新的语句对象；
 *   - first() 没有行时返回 null（node:sqlite 返回 undefined，这里转换）；
 *   - run() 返回 { success, meta: { changes, last_row_id } }；
 *   - batch() 在一个事务里顺序执行。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

class Stmt {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind() {
    return new Stmt(this.db, this.sql, Array.prototype.slice.call(arguments));
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get.apply(this.db.prepare(this.sql), this.params);
    if (row === undefined || row === null) return null;
    return col ? row[col] : row;
  }
  async all() {
    const rows = this.db.prepare(this.sql).all.apply(this.db.prepare(this.sql), this.params);
    return { success: true, results: rows, meta: { duration: 0, changes: 0 } };
  }
  async run() {
    const info = this.db.prepare(this.sql).run.apply(this.db.prepare(this.sql), this.params);
    return {
      success: true,
      meta: { duration: 0, changes: info.changes, last_row_id: Number(info.lastInsertRowid || 0) }
    };
  }
}

export class LocalD1 {
  constructor(file) {
    if (file) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file || ':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
  }
  prepare(sql) { return new Stmt(this.db, sql, []); }
  async exec(sql) { this.db.exec(sql); return { count: 0, duration: 0 }; }
  async batch(stmts) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* 事务可能已自动回滚 */ }
      throw err;
    }
    return out;
  }
  close() { this.db.close(); }
}
