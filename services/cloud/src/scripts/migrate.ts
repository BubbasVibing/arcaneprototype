import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";

// Idempotent migration runner (plan M1C / D3). Runs the .sql files in src/db/migrations in order
// over the DIRECT Supabase connection (port 5432 — NOT the pooled 6543, which can't run DDL
// reliably). Applied files are recorded in `_arcane_migrations`, so re-running is a no-op. Run with:
//   cd services/cloud && bun run migrate
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DIRECT_URL (or DATABASE_URL) not set — see services/cloud/.env.example");
  process.exit(1);
}

const sql = new SQL(url);
const dir = join(import.meta.dir, "..", "db", "migrations");

// Split a .sql file into individual statements. Our migrations are plain DDL/INSERTs with no
// semicolons inside string literals, so a naive split on ';' is safe; chunks that are only
// comments/whitespace are dropped.
function statements(content: string): string[] {
  return content
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

await sql`CREATE TABLE IF NOT EXISTS _arcane_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const appliedRows = await sql`SELECT name FROM _arcane_migrations`;
const applied = new Set(appliedRows.map((r: { name: string }) => r.name));

const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
let ran = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`· ${file} (already applied)`);
    continue;
  }
  const content = await Bun.file(join(dir, file)).text();
  const stmts = statements(content);
  await sql.begin(async (tx) => {
    for (const stmt of stmts) await tx.unsafe(stmt);
    await tx`INSERT INTO _arcane_migrations (name) VALUES (${file})`;
  });
  console.log(`✓ ${file} (${stmts.length} statements)`);
  ran++;
}

await sql.end();
console.log(ran === 0 ? "migrations up to date" : `applied ${ran} migration(s)`);
