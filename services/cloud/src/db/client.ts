import { SQL } from "bun";

// The cloud's Postgres handle (plan M1C / D4 — Bun.sql, zero extra dependency). M1C is the first
// milestone that needs a real database, so the server FAILS FAST if DATABASE_URL is unset rather
// than silently skipping persistence. Use the POOLED Supabase connection (port 6543) here for the
// running server; migrations use the DIRECT connection (5432) via scripts/migrate.ts. The handle
// connects lazily on first query, so importing this module is cheap.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set — M1C requires Postgres. Copy services/cloud/.env.example to " +
      "services/cloud/.env and set the Supabase POOLED connection string (port 6543).",
  );
}

export const sql = new SQL(url);
