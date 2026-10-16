import { MIGRATIONS } from "./schema.gen.ts";

/**
 * Applies the embedded migrations once per database, so a deploy made only from the Cloudflare dashboard
 * (no wrangler) still gets its tables. Every migration is idempotent (IF NOT EXISTS) and recorded in
 * schema_migrations; migrations stay append-only.
 */

const ready = new WeakSet<object>();

export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(Boolean);
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  const { results } = await db.prepare("SELECT name FROM schema_migrations").all<{ name: string }>();
  const applied = new Set((results ?? []).map(r => r.name));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const statements = splitStatements(migration.sql).map(s => db.prepare(s));
    statements.push(db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").bind(migration.name, new Date().toISOString()));
    await db.batch(statements);
  }
  ready.add(db);
}
