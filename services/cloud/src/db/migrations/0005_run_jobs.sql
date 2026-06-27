-- M3D — the run-job queue (Technical-Spec §2.2 "or a Postgres queue", approved Q3). This decouples the
-- COLD path (an `arcane run`: up to ~40 sandbox spawns) from the HOT static fan-out, so a slow run never
-- blocks live analysis. It MIRRORS analysis_jobs (0001): created by the migration (owned by arcane_cloud),
-- NO RLS — the worker reads/writes it directly via a single transaction (FOR UPDATE SKIP LOCKED). Run
-- RESULTS reach the CLI + dashboard through result_events (already Realtime-published, 0003/0004), NOT
-- through this table, so no anon GRANT / RLS policy is needed here.

CREATE TABLE run_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  session_id    uuid NOT NULL REFERENCES sessions(id),  -- the run's own session (fan-out anchor)
  status        text NOT NULL DEFAULT 'queued',         -- queued|running|done|error
  workload_name text NOT NULL,                          -- names a declared [[workload]] (argv derived server-side)
  baseline_ref  text NOT NULL,
  current_ref   text NOT NULL,
  consent       text,                                    -- once|session|always, or NULL (auto_grant / CI)
  inputs        jsonb NOT NULL,                          -- { baselineFiles, currentFiles } — heavy; reaped on a TTL
  report        jsonb,                                   -- the final RunReport (status measured|no-data)
  error         text,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- The claim picks the oldest queued job; index the predicate + order.
CREATE INDEX run_jobs_claim_idx ON run_jobs (status, queued_at);

-- The running server connects as `arcane_cloud` (not the owner). Grant it the DML the worker needs
-- (claim/update + retention DELETE). Explicit so access does not depend on default-privilege inheritance.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.run_jobs TO arcane_cloud;
