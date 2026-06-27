# @arcane/cloud — running the DB-gated proofs

The full-stack proofs that spin the real Bun gateway against Postgres are **gated on `DATABASE_URL`**
(the cloud fails fast without a DB — see `src/db/client.ts`). When it's unset they **skip loudly**
(each prints a `⚠️ … SKIPPED — DATABASE_URL is unset …` banner naming the proof that did not run):

- `packages/cli/src/__tests__/roundtrip.test.ts` — ingest apply+ack round-trip (vitest)
- `packages/cli/src/__tests__/b2-resync.test.ts` — Gate 1/Gate 2 + the manifest-rehash **no-drift**
  proof, the most load-bearing correctness test in the project (vitest)
- `services/cloud/src/__tests__/repository.test.ts` — Postgres snapshot/score/finding round-trip (bun)
- `services/cloud/src/__tests__/realtime.test.ts` — **M1D** web fan-out: an ANON client subscribes to
  Realtime `project:{id}`, an edit is mirrored, and session-scoped hydration reconstructs it (bun).
  Needs `SUPABASE_URL` + `SUPABASE_ANON_KEY` (anon — never `service_role`) in `.env`, on top of
  `DATABASE_URL`, and migrations 0003/0004 applied.

## Run the full suite against the real DB

`services/cloud/.env` is already wired (copy `.env.example` if not).

**Migrations on the hosted Supabase project go through a privileged path, NOT `npm run migrate`.** The
app role (`arcane_cloud`, the pooled connection) has DML but **not DDL** on `public`, so the migrate
script gets `permission denied for schema public`. Apply `src/db/migrations/*.sql` via the Supabase
**SQL editor** or the management API (each migration is plain, idempotent SQL). The script + its
`_arcane_migrations` table are only usable against a Postgres where your connection role can do DDL
(e.g. a local DB). 0001–0004 are already applied to the hosted project.

Then, from the **repo root**, one command runs everything with the DB:

```sh
set -a && . services/cloud/.env && set +a && npm test
```

`set -a; . …; set +a` exports the wired `.env` so the cli **vitest** process sees `DATABASE_URL`
(Node doesn't auto-load `.env`) and so does the spawned cloud; `bun test` auto-loads it on its own.
With the DB present the banners are silent and the previously-skipped proofs RUN.

> Run the cli full-stack tests serially if your pooled Postgres connection limit is tight:
> `set -a && . services/cloud/.env && set +a && npx vitest run --no-file-parallelism` (in `packages/cli`).

### Note on timeouts (remote Postgres latency)

These full-stack tests were written in M1B against the in-memory gateway (fast acks). Since M1C every
applied event round-trips to Postgres, so against a remote Supabase a multi-event drain takes ~2–4.5 s
(measured) rather than milliseconds. The per-drain `waitFor` is therefore **20 s** and the per-test
backstop **90 s** (`DRAIN_TIMEOUT_MS` / `TEST_TIMEOUT_MS` in the test files) — real headroom over the
worst observed ~7.7 s test, so a slow-network run doesn't flake the load-bearing no-drift proof.
For the fastest runs, point `DATABASE_URL` at a **local** Postgres.

> Latency signal (not a test bug): every applied event is now remote-DB-bound in the proof's hot
> path. Fine for a test; worth a look when real-world ingest latency comes up later.

## CI (TODO)

There is no CI yet. When it lands, add a job that provisions an ephemeral Postgres (or a dedicated
Supabase test branch), runs `npm run migrate`, exports `DATABASE_URL`, and runs the command above —
so these proofs execute on every PR instead of silently skipping. Until then, run them locally before
shipping anything that touches ingest, the shadow worktree, or persistence.
