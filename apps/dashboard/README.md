# @arcane/dashboard — the live web mirror (M1D)

A minimal Next.js app that mirrors the SAME `ResultEvent` stream the terminal gets, live, via Supabase
Realtime (invariant 4). It subscribes to `result_events` `postgres_changes` for a project, hydrates the
latest analyzed frame from Postgres, then live-updates — using the **identical** `@arcane/shared`
`applyResultEvent` reducer the TUI uses, so the two surfaces can't drift.

## Run it

```sh
cp apps/dashboard/.env.example apps/dashboard/.env.local   # then paste your ANON key
npm run dev -w @arcane/dashboard                           # http://localhost:3000
```

Open `http://localhost:3000/p/<projectId>` — the project id is printed by `arcane link` (and in
`.arcane/link.json`). Edit a watched file and the same score drop + findings appear here and in the
terminal within ~1s.

## Boundaries (M1D)

- The browser gets **only** the anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), RLS-enforced and
  public-safe. `service_role` never reaches the browser. It talks only to Supabase — never the engine.
- It renders **settled frames**: the `uploading→queued→analyzing→done` pipeline animation is
  terminal-only (the cloud flushes a frame's `result_events` rows atomically). Honest empty/connecting
  states; never mock data.
- Auth is deferred — the anon read policy on `result_events` is permissive for the single dev project
  (M8 tightens to org/project membership). M1D shows the latest watch session per project.
