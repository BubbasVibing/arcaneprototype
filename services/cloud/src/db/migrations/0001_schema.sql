-- Arcane M1 schema (plan M1C). Identity tables (§22) FIRST so the §7 FKs resolve, then the §7
-- sync + results layer VERBATIM. Column sets are authoritative from §22 (identity) and §7
-- (sync+results); Postgres types follow §7's stated convention (uuid / timestamptz / jsonb).
-- Nothing here is invented — the only inferences are low-stakes identity column types (D2b).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ── §22 identity & access ──────────────────────────────────────────────────────────────────────
CREATE TABLE users (                         -- standalone in M1C; auth.users mirroring is M1D/§23
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  name       text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id  uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role    text NOT NULL,                      -- owner|admin|member|viewer
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id),
  name           text NOT NULL,
  repo_url       text,
  default_branch text,
  sync_enabled   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cli_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  name         text,
  token_hash   text NOT NULL,
  scopes       text[],
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- ── §7 M1 sync + results layer (verbatim) ───────────────────────────────────────────────────────
-- One `arcane watch` session.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  base_snapshot_id uuid,                      -- snapshot established at `arcane link`
  last_ack_seq    bigint NOT NULL DEFAULT 0,  -- highest CONTIGUOUS seq applied
  status          text NOT NULL DEFAULT 'active',  -- active|ended
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

-- A materialized shadow-worktree state (content-addressed).
CREATE TABLE source_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  session_id         uuid REFERENCES sessions(id),
  parent_snapshot_id uuid REFERENCES source_snapshots(id),
  manifest_hash      text NOT NULL,           -- hash of (path -> content_hash) map
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_files (
  snapshot_id  uuid NOT NULL REFERENCES source_snapshots(id),
  path         text NOT NULL,
  content_hash text NOT NULL,                 -- xxhash
  size_bytes   bigint,
  is_binary    boolean NOT NULL DEFAULT false,
  mode         integer,                       -- unix file-mode bits
  blob_key     text,                          -- object-storage key (NULL for deletes)
  PRIMARY KEY (snapshot_id, path)
);

-- The streamed change log. event_id UNIQUE = idempotent dedup (§3A.3).
CREATE TABLE change_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id),
  event_id     uuid NOT NULL,                 -- client-stable; dedup key
  seq          bigint NOT NULL,
  op           text NOT NULL,                 -- add|change|delete|rename
  path         text NOT NULL,
  old_path     text,
  content_hash text,
  blob_key     text,
  applied      boolean NOT NULL DEFAULT false,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_id),
  UNIQUE (session_id, seq)
);

-- Server -> CLI acks (drives the journal).
CREATE TABLE event_acks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES sessions(id),
  ack_seq           bigint NOT NULL,
  server_snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Analyze queue/worker state.
CREATE TABLE analysis_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  status      text NOT NULL DEFAULT 'queued', -- queued|running|done|error
  queued_at   timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- Per-snapshot results.
CREATE TABLE scores (
  snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  dimension   text NOT NULL,
  score       real NOT NULL,
  delta       real NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, dimension)
);

CREATE TABLE findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  snapshot_id uuid NOT NULL REFERENCES source_snapshots(id),
  dimension   text NOT NULL,
  severity    text NOT NULL,
  rule_id     text NOT NULL,
  file        text NOT NULL,
  start_line  integer,
  end_line    integer,
  message     text NOT NULL,
  fixable     boolean NOT NULL DEFAULT false,
  is_new      boolean NOT NULL DEFAULT true,
  status      text NOT NULL DEFAULT 'open',   -- open|fixed|suppressed
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Durable copy of the fan-out stream (so late-joining web tabs hydrate from history).
CREATE TABLE result_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  session_id  uuid NOT NULL REFERENCES sessions(id),
  snapshot_id uuid REFERENCES source_snapshots(id),
  kind        text NOT NULL,                  -- state|score|finding|run
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
