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
  /**
   * 对齐真实 D1（这一点很坑，但必须照抄）：exec() 是按换行切语句后逐条执行的。
   * 所以跨多行的 CREATE TABLE 会被切坏，真机上报
   *   D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS categories (: incomplete input
   * 用 node:sqlite 的 exec 一把梭能吃多行语句，本地过、线上 500 —— 这里改成同样的行为。
   */
  async exec(sql) {
    const lines = String(sql).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        this.db.exec(line);
      } catch (err) {
        throw new Error('Error in line ' + (i + 1) + ': ' + line + ': ' + ((err && err.message) ? err.message : String(err)));
      }
    }
    return { count: lines.length, duration: 0 };
  }
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
