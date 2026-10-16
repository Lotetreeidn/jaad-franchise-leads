import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal D1 stand-in over node:sqlite that applies the real migrations. */

type Value = string | number | null | bigint | Uint8Array;

function toSql(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  return String(v);
}

class Stmt {
  db: DatabaseSync;
  sql: string;
  params: Value[];
  constructor(db: DatabaseSync, sql: string, params: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map(toSql));
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row ? { ...row } : null) as T | null;
  }
  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.params).map(r => ({ ...r }));
    return { results: rows as T[], success: true, meta: {} };
  }
  async run() {
    const res = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  rawAll() {
    const st = this.db.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql) || /returning/i.test(this.sql)) return { results: st.all(...this.params).map(r => ({ ...r })), success: true, meta: { changes: 0 } };
    const res = st.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(res.changes) } };
  }
}

export function createD1(applyMigrations = true) {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "..", "migrations");
  if (applyMigrations) for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map(s => s.rawAll());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}
