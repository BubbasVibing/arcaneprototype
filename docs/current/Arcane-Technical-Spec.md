# Arcane — Technical Specification & Build Prompt

> Companion doc to `Arcane-Project-Map.md`. That doc is the *why/what*; this is the *how* — pinned stack, modules, data models, interfaces, and a paste-ready Claude Code build prompt.
>
> **Doc map (read the right one):** **`Arcane-Build-Guide.md`** is the entry point — agent rules, ownership lanes, and the ordered build phases; start there. **This file** is the deep implementation reference for the CLI engine (interfaces, schemas, algorithms, the Runtime Delta Engine §19A). **`Arcane-Product-Requirements.md`** holds peripheral context — landing-page & dashboard UI requirements, the full `arcane.toml` config + command reference, and marketing — so it doesn't crowd this file. Load only the section your current task needs.

---

## 1. Scope

Arcane is a **thin local collector + hosted cloud analysis engine** (the Claude Code model): a lightweight npm CLI watches the repo and streams **every change** to **Arcane Cloud**, which runs all analysis, security, AI review, and sandboxed runtime verification, then streams results back **simultaneously to the terminal and the web app**. The local machine never runs analyzers or user code, so Arcane runs on any computer regardless of its resources.

The **MVP (Milestone 1)** is the end-to-end *round-trip*: local edit → change streamed → cloud static analysis → results live in **both** the terminal and the web dashboard at once. Git context, delta-first suppression, the cloud sandbox + Runtime Delta Engine, AI, test-gen, auto-fix, and the team platform layer on top (§17). Hard invariants (§16) hold across all milestones.

---

## 2. Pinned tech stack

Two deployables, two runtimes. **The CLI is Node** (so `npm i -g` is painless and dependency-light); **the cloud engine is Bun** (for throughput). They share one typed protocol + schema package so the contract can't drift.

### 2.1 Local CLI — `@arcane/cli` (Node.js, thin client)
Deliberately near-pure-JS/WASM with **no native addons**, so it installs cleanly on any machine.

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node.js** (LTS ≥ 20) | standard npm package; `bin` runs `arcane` |
| Language | **TypeScript** (strict), ESM → JS | build with `tsc`/`tsup` |
| TUI | **Ink** + react | `jsx: react-jsx` in tsconfig |
| File watch | **chokidar** | accurate create / modify / delete / rename events |
| Hashing | **xxhash-wasm** | per-file content hashes (WASM, no native build) |
| Transport | **ws** (WebSocket over TLS) | stream changes up, receive results down |
| Git (read-only) | **simple-git** | branch / commit / baseline context only — shells to `git`, no native build |
| Config | **smol-toml** | reads `arcane.toml`, uploads it to the server |
| Validation | **zod** (via `@arcane/shared`) | validate protocol messages |
| Token store | **file** under `~/.arcane/` (chmod 600) | no native keychain dep; OS keychain optional later |
| Offline buffer | append-only journal file | queue changes offline; replay on reconnect |
| Tests | **vitest** | — |

> **The CLI never runs analyzers, never produces findings, never executes user code, and needs no database.** All of that is server-side. This is what keeps the install trivial and lets Arcane run on any computer.

### 2.2 Arcane Cloud — the analysis engine (Bun + TypeScript)
| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Bun** (latest) | `Bun.serve` (HTTP + WS), fast workers, `Bun.spawn` for analyzer/sandbox orchestration |
| Language | **TypeScript** (strict) | shares types with the CLI via `@arcane/shared` |
| Ingest / gateway | `Bun.serve` WebSocket + REST | authenticated; receives snapshot + change events |
| Project index | server-side **shadow worktree** per session/branch | apply patches → always-current tree to analyze |
| Object storage | S3-compatible / Supabase Storage | **encrypted** repo snapshots |
| Database | **Postgres** (Supabase) | projects, runs, findings, scores, members, ci_runs |
| Queue | Redis + **BullMQ** (or a Postgres queue) | debounce/coalesce per session; analyzer + run jobs |
| Parsing (AST) | **tree-sitter** (server) | multi-language; runs where the compute is |
| Analyzers | semgrep · gitleaks · knip · ts-prune · jscpd · osv-scanner + complexity / escape-hatch | subprocess workers |
| Sandbox (M3) | **microVM (Firecracker) / container (gVisor)** per run | isolated, no-network, CPU/mem/time-capped |
| AI | **@anthropic-ai/sdk** | `claude-opus-4-8` judge; `claude-haiku-4-5`/`sonnet` triage; caching + Batch |
| Realtime fan-out | **Supabase Realtime** (+ the CLI WS) | one result stream → terminal **and** web simultaneously |
| Validation | **zod** | every ingested message + AI output |

### 2.3 Shared — `@arcane/shared` (TypeScript)
zod schemas + types for the **wire protocol** (change events, result events) and the domain (`Finding`, `Metric`, `Score`, `RunReport`, `ArcaneConfig`). Imported by both the Node CLI and the Bun cloud.

### 2.4 Web — `@arcane/dashboard` + landing (Next.js on Vercel)
Subscribes to the same Realtime channels the cloud emits, so the dashboard updates **live, in lockstep with the terminal**.

---

## 2A. System architecture & data flow

```
┌───────────── LOCAL · any computer ─────────────┐         ┌──────────────── ARCANE CLOUD · Bun ────────────────┐
│ @arcane/cli (Node, thin)                        │  WSS    │ Ingest gateway (Bun.serve WS/REST, authenticated)   │
│  chokidar → CHANGE COLLECTOR                    │  (TLS)  │   → validate → enqueue                              │
│   (insert / delete / rename, seq# + hash) ──────┼────────▶│ Project index: SHADOW WORKTREE (apply patches)      │
│  arcane link → initial ENCRYPTED snapshot ──────┼────────▶│ Queue (BullMQ): debounce/coalesce per session       │
│  TUI renders streamed results ◀─────────────────┼──events─│ Analyzer workers (static) · Sandbox runners (M3)    │
└─────────────────────────────────────────────────┘         │ Score engine → findings / scores / deltas           │
                                                             │ FAN-OUT ──┬──▶ CLI WebSocket (terminal)             │
   ┌─────────── WEB · Next.js/Vercel ───────────┐            │           └──▶ Supabase Realtime ──▶ dashboard      │
   │ Dashboard subscribes to Realtime ◀──────────┼────────────┘ Postgres (durable) + Object storage (snapshots)   │
   │ updates live, in lockstep with the terminal │            └─────────────────────────────────────────────────┘
   └─────────────────────────────────────────────┘
```

**The round-trip (the heartbeat):** an edit lands → the collector emits an ordered change event `(path, op, contentHash, seq)` → streamed over WSS → the gateway applies it to the project's **shadow worktree** → changed files + dependents are queued → analyzer workers produce findings → the score engine computes deltas → **the same result event fans out to the originating CLI socket and the web Realtime channel at once**, so terminal and browser update together. Target: first partial result well under a second; the TUI surfaces pipeline states (`change detected → uploading → queued → analyzing → results`) so latency is legible.

**Source-access modes (privacy — pick per project):**
- **Cloud (default):** source uploaded, **encrypted in transit (TLS) and at rest**, scoped per project, deletable, with an *ephemeral analyze-and-discard* option (no persistence).
- **Metadata-only (limited):** analysis runs in your own CI / self-runner; only findings/scores are pushed; **no source reaches Arcane**. Fewer features (no cloud sandbox/AI on source).
- **Self-host (enterprise):** run the Bun engine in your own infra; the CLI points at your endpoint.

Full collector protocol → §3A. Cloud engine internals → §3B. Trust/isolation → §21A.

---

## 3. Module breakdown

### 3.1 `@arcane/cli` (Node, thin client)
```
cli/         command router (login, link, watch, status, run, gate…), flags, exit codes
collector/   chokidar → ordered change events (op, path, hash, seq); rename/delete tracking
snapshot/    initial repo snapshot (respects ignore rules); upload blobs over TLS (§3A.6)
transport/   authenticated WSS client: send changes, receive results; reconnect + resync
journal/     append-only offline buffer; replay unacked events safely on reconnect
git/         read-only branch/commit/baseline context (simple-git)
auth/        device-link login; token file store (~/.arcane, chmod 600)
config/      arcane.toml load + zod validate; upload to server
tui/         Ink dashboard: eval bars · timeline · findings · run view · pipeline states
```
> No `analyzers/`, no `score/`, no `sandbox/`, no database. Those are server-side by design — that's what keeps the npm install trivial.

### 3.2 Arcane Cloud (Bun)
```
gateway/     Bun.serve WS+REST ingest; auth; rate-limit; per-session channels
index/       shadow worktree per session/branch; apply change patches; blast-radius graph
queue/       BullMQ: debounce/coalesce per session; analyzer + run jobs
analyzers/   plugin registry + built-ins (complexity, escape-hatch, secrets, semgrep, knip, gitleaks, osv, types)
score/       findings+metrics → 0–100/dim + deltas + baseline (is_new) suppression
sandbox/     microVM/container runner: isolation, no-net, CPU/mem/time caps (M3)
instrument/  in-sandbox probe: patch fetch/http/db/fs; record-replay; telemetry (M3)
runtime/     Runtime Delta Engine: worktrees, alternating runs, stats, attribution (§19A)
ai/ testgen/ fixer/   M4–M6 server services
fanout/      publish result events → CLI socket + Supabase Realtime (web)
store/       Postgres (durable) + object storage (encrypted snapshots)
github/      App, Checks API, clone-baseline path
```

### 3.3 `@arcane/shared` (TS, imported by CLI + cloud)
```
protocol/    change-event + result-event wire schemas (zod) + types
domain/      Finding · Metric · Score · RunReport · ArcaneConfig (zod) + types
```

---

## 3A. Change Collector Protocol (the CLI's job — get this exactly right)

The collector is the **only** thing the local machine does for analysis, so it must be **accurate, ordered, and recoverable**. The server reconstructs the working tree solely from these events; a missed or mis-ordered event = wrong analysis.

### 3A.1 What it watches
chokidar over the repo root, honoring `.gitignore` + `arcane.toml` `ignore`. Events normalize to four ops: **add · change · delete · rename** (rename detected as a path-pair within a debounce window, else falls back to delete+add). Directory deletes expand to per-file deletes. Symlinks are not followed. Binary/oversized files (> configurable cap) are sent as hash + size, not content.

### 3A.2 Event shape (`@arcane/shared` protocol)
```ts
type ChangeEvent = {
  eventId: string;          // stable UUID — the unit of dedup (survives retries)
  sessionId: string;        // one watch session
  projectId: string;
  parentSnapshotId: string; // the shadow-worktree snapshot this event applies on top of
  seq: number;              // strictly monotonic per session — server detects gaps
  ts: number;
  op: 'add' | 'change' | 'delete' | 'rename';
  path: string;             // repo-relative, POSIX
  oldPath?: string;         // for rename
  contentHash?: string;     // xxhash of new content (omitted for delete)
  sizeBytes?: number;
  isBinary?: boolean;
  encoding?: 'utf8' | 'base64' | 'none';
  mode?: number;            // unix file-mode bits
  content?: string | { blobRef: string };  // inline if small; else an uploaded blob ref (§3A.6)
};

// Server → CLI acknowledgement. Drives the journal: the CLI keeps events until acked.
type AckEvent = {
  sessionId: string;
  ackSeq: number;           // highest CONTIGUOUS seq the server has durably applied
  acceptedEventIds: string[];
  serverSnapshotId: string; // resulting shadow-worktree snapshot
  resyncFrom?: number;      // present iff the server detected a gap and wants a resync
};
```

### 3A.3 Delivery guarantees (the headline feature — and an honest one)
The collector is **at-least-once with idempotent server handling** — the correct model for a networked client, *not* the fairy tale of "exactly-once." A crashed/reconnecting client will sometimes resend; the design absorbs that safely:
- **Stable `eventId` + server dedup:** the CLI may resend unacked events; the server deduplicates by `eventId`, so a duplicate is a no-op.
- **Monotonic `seq` + gap detection:** the server tracks the highest *contiguous* `seq`; a gap → it replies with `resyncFrom` and the CLI re-sends from there (or does a manifest resync, §3A.4).
- **Content hash on every add/change:** if the hash already matches the shadow copy, the server skips re-analysis (idempotent, dedup-safe).
- **Acks drive the journal:** the CLI keeps each event until an `AckEvent` covers it, then drops it; on reconnect it **replays unacked events safely** (duplicates absorbed by `eventId`).
- **Atomic-write handling:** write-temp-then-rename emits one logical change, not temp-file churn.
- **Debounce without loss:** coalesce a burst per file (last-write-wins within ~150 ms) but **never drop the final state**; **deletes are never coalesced away**.

### 3A.4 Snapshot + resync (self-healing, no silent drift)
- `arcane link` builds an initial manifest (path → hash), uploads changed blobs (over TLS; stored encrypted at rest, §3A.6), server materializes the shadow worktree → `baseSnapshotId`.
- **Resync** (on reconnect, seq-gap, or hash mismatch): server sends its manifest; the CLI diffs against disk and uploads only the deltas.
- **Offline:** changes accumulate in the journal with seq numbers; on reconnect the CLI **replays unacked events** then resyncs to confirm. TUI shows `offline · N changes queued`.

### 3A.5 Context the CLI also sends (so diffs are actually analyzable)
On link and when they change: `package.json`, lockfile, `tsconfig`, framework configs, schema files (`*.prisma`, `openapi.*`), `arcane.toml`, and the git baseline SHA + branch. (Governed by the source-access mode; **metadata-only mode sends none of this**.)

### 3A.6 Blob upload & encryption (be precise — no hand-waving)
File contents above the inline cap are uploaded as **blobs** referenced by `blobRef`. The encryption model for **M1** is deliberately simple and honest:

- **In transit:** everything streams over **TLS** (WSS/HTTPS). The CLI does **not** do client-side encryption in M1 — "uploads encrypted blobs" earlier meant *transport*, not client-held keys.
- **At rest:** blobs and snapshots are stored in object storage **encrypted at rest with per-project keys managed by Arcane (server-side, via KMS)**. Cloud analysis workers decrypt only inside the analysis environment.
- **Ephemeral mode:** blobs live in a short-TTL working area and are deleted after the run; only results persist.
- **Later (enterprise):** **customer-managed keys (CMK)** and/or **client-side envelope encryption** — the CLI encrypts with a project data key, workers decrypt only in-sandbox, keys held in the customer's KMS. Documented as a roadmap item, not an M1 claim.

> Rule for the docs and the marketing: say "TLS in transit + encrypted at rest (Arcane-managed keys)" for M1. Only say "client-side/envelope encryption" once §-this actually ships it.

---

## 3B. Cloud engine pipeline & realtime fan-out

### 3B.1 Server pipeline (per change event)
```
ingest (validate · auth · seq-check)
  → apply patch to shadow worktree (or request resync on a gap)
  → blast radius = changed files + import-graph dependents
  → enqueue analyze job (debounced/coalesced per session — only the latest tree state runs)
  → analyzer workers: Tier-0 fast (complexity, escape-hatch, secrets) → Tier-1 (semgrep, knip, types, osv)
  → normalize → Finding[] + Metric[]
  → score engine: per-dimension 0–100 + delta vs last snapshot; mark is_new vs baseline
  → persist run + findings to Postgres
  → FAN-OUT result event (§3B.2)
  Tier-2 sandboxed execution only on arcane run / gate / explicit request (§19A)
```
Tier-0 partials stream back in well under a second; Tier-1 streams in as it finishes. Bursts coalesce so a fast typist never queues 50 runs.

### 3B.2 Realtime fan-out — terminal and web update together
Each result event is published **once** to the per-project/session channel and delivered to both surfaces at the same time:
- **CLI** ← the same authenticated WebSocket it streams changes on (ordered, low-latency).
- **Web dashboard** ← Supabase Realtime channel `project:{id}` (+ durable Postgres rows for late joiners/refresh).

```ts
type ResultEvent =
  | { kind: 'state';   sessionId: string; phase: 'uploading'|'queued'|'analyzing'|'done' }
  | { kind: 'score';   dimension: Dimension; value: number; delta: number }
  | { kind: 'finding'; finding: Finding; isNew: boolean }
  | { kind: 'run';     report: RunReport };   // Runtime Delta Engine (§19A)
```
The developer's terminal and a teammate's browser render the **same data at the same time** — the live "watch everything run" view the product promises. Late-joining web tabs hydrate from Postgres, then continue live from Realtime.

### 3B.3 Latency & cost controls
Per-session debounce + coalesce, content-hash skip, prompt caching + Batch for AI (M4), and a free-tier quota on analysis minutes / sandbox runs / AI spend. The TUI always shows pipeline state so a round-trip never reads as a hang.

---

## 4. Core pipeline (client ↔ cloud)

The pipeline is split across the two deployables:

**Local (CLI):** `chokidar event → normalize to a ChangeEvent (op, path, hash, seq) → debounce/coalesce per file without losing the final state → stream over WSS (or journal if offline)`. That's it — no analysis locally.

**Cloud (Bun):** `apply patch to shadow worktree → blast radius → debounced analyze job → Tier-0 then Tier-1 analyzers → normalize → score + delta → persist → fan out to terminal + web`. Full detail in **§3B.1**; fan-out in **§3B.2**.

Timing: the CLI stays at idle CPU ≈ 0 (event-driven); Tier-0 partials return well under a second; new bursts supersede in-flight server work so only the latest tree state is analyzed.

---

## 5. Analyzer plugin interface

```ts
export type Tier = 0 | 1 | 2;            // 0 parse-only · 1 worker/subprocess · 2 sandboxed exec
export type Dimension =
  | 'complexity' | 'deadcode' | 'lint' | 'security' | 'secrets'
  | 'deps' | 'types' | 'performance' | 'concurrency' | 'tests';

export interface AnalyzerContext {
  filePath: string;
  contentHash: string;
  source: string;
  ast?: import('web-tree-sitter').Tree;
  changedRanges?: Range[];
  projectRoot: string;
  config: ArcaneConfig;
  signal: AbortSignal;                    // canceled when a newer burst arrives
}

export interface Finding {
  id: string;                             // stable hash(ruleId + file + range)
  dimension: Dimension;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  ruleId: string;
  message: string;
  file: string;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  fixable?: 'deterministic' | 'codemod' | 'llm' | false;
  metadata?: Record<string, unknown>;
}

export interface Metric { dimension: Dimension; key: string; value: number; unit?: string; }
export interface AnalyzerResult { findings: Finding[]; metrics: Metric[]; }

export interface Analyzer {
  name: string;
  tier: Tier;
  dimension: Dimension;
  languages: string[];                    // ['ts','tsx','js']
  analyze(ctx: AnalyzerContext): Promise<AnalyzerResult>;
}
```

Registry: `register(analyzer)`; orchestrator selects by language + tier + enabled-in-config. Adding an analyzer never edits core.

---

## 6. Score model

- Each dimension starts at 100; findings subtract weighted by severity (`info 0 · low 2 · medium 6 · high 15 · critical 30`), clamped 0–100. Metrics can cap a score (e.g. complexity max > threshold caps the complexity bar).
- **Delta** = current − previous snapshot, per dimension → drives the timeline ("complexity −8").
- **Baseline suppression** (delta-first): findings present in `baseline` table are hidden from the live count; `is_new` flags only what this change introduced. `arcane baseline set` writes current finding ids to baseline.
- Deterministic (static) scores always shown; dynamic (run-based) scores shown with freshness + confidence band, never block on one noisy run.

---

## 7. M1 record model (cloud Postgres — the round-trip backbone)

> The durable store is **Arcane Cloud's Postgres** (full platform schema in §22) + object storage for blobs (§3A.6). The CLI keeps only a tiny **offline journal** of unacked change events (§3A.4) — *not* a database. Below is the **concrete M1 schema** an agent should actually create for Session 0 → M1D. Postgres types (`uuid`, `timestamptz`, `jsonb`), not SQLite.

```sql
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
```

Identity tables (`users`, `orgs`, `memberships`, `projects`, `cli_tokens`) and the later platform tables (branches, commits, runs, ci_runs, metrics, AI-call accounting, integrations) live in **§22**. RLS scopes every row by org/project membership.

---

## 8. TUI spec (Ink)

```
┌ EVAL BARS ────────┬ CHANGE TIMELINE ─────────────────┬ FINDINGS ────────────┐
│ Complexity  ▓▓▓░ 78│ 14:22 payments.ts  cx −8 · 1 sec │ ▸ high  N+1 in orders│
│ Dead code   ▓▓▓▓ 95│ 14:21 orders.ts    +2 dead exp   │   med   any in cart  │
│ Security    ▓▓░░ 61│ 14:20 cart.ts      types −4      │   ...                │
│ Types       ▓▓▓░ 80│                                  │ [enter] expand        │
│ Secrets     ▓▓▓▓100│                                  │ [e] explain (AI)      │
│ Deps        ▓▓▓▓ 92│                                  │ [f] verified fix      │
├ GIT TREE (toggle g)┴──────────────────────────────────┴───────────────────────┤
│ main ──●──●──● ▸ new-feature-1 ──●  (yassine)   $ spent today: $0.00          │
└──────────────────────────────────────────────────────────────────────────────┘
```

Keys: `j/k` nav · `enter` expand · `e` explain (AI) · `f` propose verified fix · `a` apply · `d` deep-scan · `g` git tree · `b` baseline · `r` re-run · `/` filter · `$` spend · `?` help · `q` quit. Re-render only on new snapshot events.

> **M1 keybinding scope (mirror the command-stub rule, §11):** only the keys for features that exist in M1 are active — `j/k` nav, `enter` expand, `d` per-dimension bars, `/` filter, `?` help, `q` quit, plus `L` sign-in (§27). Keys for not-yet-built features (`e` explain/AI → M4, `f`/`a` fix → M6, `d` deep-scan → M3, `g` git tree → M2, `b` baseline → M2, `r` re-run, `$` spend → M4) render the action but show **"not available in this milestone"** when pressed. (Note: in M1, `d` toggles dimension bars; the `d` deep-scan binding lands with M3 under a different surface.)

---

## 9. Sandbox / executor spec

> **Architecture note:** execution runs in **Arcane Cloud**, never on the user's machine (§21A is the authoritative isolation spec — microVM/container per run). The mechanics below (watchdog, limits, network policy, instrumentation probe) are how the **cloud** runner is built; the CLI is never involved in execution. `Bun.spawn` orchestrates runners server-side.

- **Process isolation:** user code runs in an isolated **microVM/container per run** (§21A), never in-process and never on the client.
- **Watchdog:** kill (`SIGKILL`) on `timeout_ms` overrun → emit finding `non-termination: <fn> exceeded budget`.
- **Limits:** CPU + memory ceilings (container limits / ulimit).
- **Network:** denied by default (`--network none`); `instrument/` preload patches `globalThis.fetch`, `node:http(s)`, DB drivers, `fs`, `child_process` → block or serve record-replay fixtures.
- **DB:** dynamic checks run against a snapshotted copy of the dev DB.
- **Telemetry:** the same preload, when riding along on `vitest run`/dev, records timings, query counts, memory, unhandled rejections.

---

## 10. AI layer spec

- Model: `claude-opus-4-8` (judge). Triage: `claude-haiku-4-5` / `claude-sonnet-4-6`.
- **Gate before spend:** AST semantic-diff must classify the change as logic-significant; triage model confirms "worth Opus." Else skip.
- **Prompt caching:** stable prefix (system rubric + repo context) marked `cache_control: ephemeral`; only the small diff is sent fresh.

```ts
const res = await anthropic.messages.create({
  model: cfg.ai.model,                                 // claude-opus-4-8
  max_tokens: 1024,
  system: [
    { type: 'text', text: REVIEW_RUBRIC,  cache_control: { type: 'ephemeral' } },
    { type: 'text', text: repoContext,    cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: diffOnly }],     // minimal fresh tokens
});
// force JSON verdict; parse with zod; record tokens+cost → ai_calls
```

- **Output:** strict JSON verdict (`{ severity, claim, lines[], suggestedFix? }`) — terse, capped `max_tokens` (output is 5× input cost).
- **Batch:** CI/bulk via Batch API (50% off); interactive `arcane review` standard mode.
- **Caches:** diff-hash local cache (never re-review identical diff); function-signature hash for testgen.
- **Budget:** `ai.daily_budget_usd`; on breach → degrade to static-only + surface in `$` meter. Opt-in per repo; `--no-ai` disables.

---

## 11. CLI spec

> **Authoritative command reference: Product-Requirements §4.2.** The table below is the internal superset across all milestones; PR §4.2 is the user-facing source of truth (keep them in sync there, not here). **For M1, only `login`, `link`, `arcane`/`watch`, `init`, `status` (and optionally `score`) are implemented — every other command is a stub that prints "not available in this milestone" (§17, §18).**

| Command | Flags | Exit |
|---|---|---|
| `arcane` / `arcane watch` | `--profile` | runs TUI |
| `arcane scan` | `--deep` `--json` `--fix` | 0/1/2 |
| `arcane score` | `--json` | 0 |
| `arcane diff [ref]` | `--since` `--json` | 0 |
| `arcane review` | `--range` `--staged` `--no-ai` | 0/1 |
| `arcane explain <id>` | | 0 |
| `arcane run [workload]` | `--compare` | 0/1 |
| `arcane report` | `--html` `--compare` | 0 |
| `arcane fix [id]` | `--all` `--safe` `--yes` | 0/1 |
| `arcane gate` | `--baseline` | 0/1 (CI) |
| `arcane baseline set` | | 0 |
| `arcane test gen <target>` | | 0 |
| `arcane init` / `doctor` / `login` / `sandbox` / `config` / `plugins` / `budget` | | 0/2 |

Global: `--cwd` `--config` `--json` `--quiet`/`--verbose` `--no-color`. Exit: `0` pass · `1` gate/finding fail · `2` tool error.

---

## 12. Config spec — `arcane.toml`

> **Single source of truth:** the authoritative, user-facing `arcane.toml` is **Product-Requirements §4.1**. Do not maintain a second config schema here — two schemas guarantee drift. This section only defines **how the cloud validates it.**

`arcane.toml` is parsed by the CLI (smol-toml), validated against the **`ArcaneConfig` zod schema in `@arcane/shared`**, and **uploaded to the server** (it's project state, interpreted cloud-side — analyzers, execution/sandbox, AI, and gate all run in the cloud). The CLI does not act on `[execution]`/`[ai]` locally; it forwards config and renders results.

Key blocks (full reference + comments: Product-Requirements §4.1): `[project]`, `[ui]`, `[score]`, `[analyzers]`, `[baseline]`, `[execution]` (cloud sandbox: `isolation = microvm|container`, consent gates), `[[workload]]` (the user-declared allowlist — declaring ≠ permission to run), `[ai]`, `[gate]`, and `[cloud]` (`mode = cloud|metadata-only|self-host`, `endpoint`, `ephemeral`, `share_presence`).

Validation rules the cloud enforces: unknown keys are rejected (zod `.strict()`); `[execution].enabled=false` by default and a workload runs only with a matching grant; `[cloud].endpoint` is required iff `mode = "self-host"`; `gate_on` dimensions must exist. The same `ArcaneConfig` schema is the contract for the CLI, the cloud, and the dashboard's Settings UI.

---

## 13. GitHub plane spec

- **Two paths to source:** the **CLI/cloud path** (changes streamed to Arcane Cloud, §3A) is the default; the **GitHub App path** lets the cloud clone the repo baseline so the CLI only sends working-tree diffs — better for teams and for metadata-only setups. **Auth:** OAuth device flow (`arcane login`) → CLI token; GitHub App (fine-grained) for org/team; the CI Action uses the scoped `GITHUB_TOKEN`.
- **Checks API:** `arcane gate` in CI posts a Check run with per-dimension scores + line annotations on the PR diff; non-zero exit blocks merge per `github.gate_on`.
- **Action (`.github/workflows/arcane.yml`):**

```yaml
- uses: arcane-dev/arcane-action@v1
  with: { gate-on: "security,tests" }
  env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
```

---

## 14. Distribution spec

Arcane ships as a standard **npm package** (full detail in §29):
- **Build:** `tsc` (or `tsup`) compiles `src/**` → `dist/**`. ESM (`"type": "module"`).
- **npm:** `package.json` declares `"bin": { "arcane": "dist/cli.js" }` (shebang `#!/usr/bin/env node`), `"engines": { "node": ">=20" }`, `"files": ["dist", "*.wasm"]`. `npm publish --access public` under a scope (e.g. `@arcane/cli`).
- **Install:** `npm install -g @arcane/cli` → `arcane`; or `npx @arcane/cli`; or a project dev-dependency.
- **Optional later:** a Homebrew formula that depends on `node` and installs the npm package; a curl installer wrapping npm.

---

## 15. Repo structure (monorepo)

```
arcane/                              # npm/pnpm workspaces
├── packages/
│   ├── shared/                      # @arcane/shared — protocol + domain (zod) [build FIRST]
│   │   └── src/{protocol,domain}/
│   └── cli/                         # @arcane/cli — Node thin client (published to npm)
│       └── src/{cli,collector,snapshot,transport,journal,git,auth,config,tui}/
├── services/
│   └── cloud/                       # Arcane Cloud — Bun engine (deployed, NOT published)
│       └── src/{gateway,index,queue,analyzers,score,sandbox,instrument,runtime,ai,testgen,fixer,fanout,store,github}/
├── apps/
│   ├── dashboard/                   # Next.js web app (Supabase Realtime)
│   └── landing/                     # marketing site
├── arcane.example.toml
├── .github/workflows/arcane.yml
├── CLAUDE.md
└── README.md
```

> The CLI (`packages/cli`) and the engine (`services/cloud`) are **different runtimes** (Node vs Bun) sharing `@arcane/shared`. Keep their dependency sets separate.

---

## 16. Non-functional requirements & invariants

1. **The local CLI is a thin client.** It only watches, collects changes, streams them, authenticates, and renders results. It **never** runs analyzers, never produces findings, never executes user code, and needs no database. (This is what lets Arcane run on any computer and keeps the npm install painless.)
2. **Change collection is accurate, ordered, and recoverable.** Every add/change/delete/rename is captured, `seq`-numbered, and content-hashed; the server can deterministically reconstruct the working tree; gaps/reconnects trigger resync — never silent drift (§3A).
3. **All analysis runs in Arcane Cloud (Bun).** Static analyzers, AI, and sandboxed runtime all run server-side, against a shadow worktree built from the streamed changes.
4. **Results fan out to terminal AND web simultaneously.** One result event → CLI socket + Supabase Realtime, same data at the same time (§3B.2).
5. **Incremental on the server.** Hash-skip unchanged; analyze blast radius only; coalesce bursts so only the latest tree state runs.
6. **Source upload is explicit, encrypted, and deletable.** Consent at `arcane link`; TLS in transit, encrypted at rest (Arcane-managed per-project keys); per-project scope; deletable; ephemeral (analyze-and-discard) option. **Metadata-only and self-host are planned modes** for teams that can't upload source (§24, §21A).
7. **Cloud execution is sandboxed and isolated per tenant.** microVM/container per run, no default network, CPU/mem/time caps, no shared filesystem, secret stripping, outbound block/record. Opt-in + user-declared workloads only (§19, §21A).
8. **Delta-first.** Surface only what a change introduced; baseline the legacy backlog.
9. **Analyzers are plugins** behind a typed interface (server-side); never fork the engine to add one.
10. **Event-driven UI, idle CPU ≈ 0.** The CLI renders on streamed events and shows pipeline state so a round-trip never reads as a hang; no busy loops.
11. **Fixes are verified, scoped, reversible.** Verified in a cloud worktree (re-run analyzers/tests); streamed back as a diff the user applies; atomic.
12. **AI is opt-in, budgeted, cached.** Static analysis handles what it can; tokens only on frontier judgment; prompt caching + Batch.
13. **Approachable by default, deep on toggle.** One Health Score + plain-English findings up front; granularity on demand; no separate "simple mode."
14. **The TUI and web are first-class product surfaces** — cohesive, responsive, live, honor `NO_COLOR`; not debug dumps.
15. **Runtime is measured, never simulated** — baseline-vs-current in Arcane's isolated cloud environment, confidence-scored; the static layer says "performance risk increased," never "runtime is slower" (§19A).

---

## 17. Milestone plan (cloud-native)

The platform is foundational now — accounts, projects, storage, and realtime exist from M1. There is no separate "build local analyzers" phase.

| M | Scope |
|---|---|
| **M1 (MVP — the round-trip)** | Thin CLI (`login`, `link`→snapshot upload, `watch`→stream changes, TUI render) + Cloud (ingest gateway, shadow worktree, queue, **3 analyzers**: complexity, escape-hatch, secrets, score engine) + **realtime fan-out to terminal AND web**. Prove: local edit → cloud analysis → both surfaces update live. |
| M2 | Collector hardening (rename/delete/atomic-write, resync, offline journal) + git context + baseline/delta-first + more server analyzers (semgrep, knip, gitleaks, osv, tree-sitter AST, dep graph) |
| M3 | **Cloud sandbox** (microVM/container, isolation) + instrumentation probe + **Runtime Delta Engine** (§19A) + consent/declared workloads + live run graphs streamed to terminal + web |
| M4 | AI layer (server-side): judge/triage, caching, Batch, budget + `arcane review`/`explain` |
| M5 | Test-gen (server-side): characterization + property-based from contracts; labeled drafts |
| M6 | Auto-fix: verified in a cloud worktree; streamed back as diffs the user applies |
| M7 | GitHub App plane + CI/CD gate + **CLI npm publish** + self-host packaging of the engine |
| M8 | Web app full surface (Overview, Work-Tree, Findings, Insights) + account-aware terminal tabs |
| M9 | Teams/roles/invites, billing, integrations (GitHub/GitLab/Slack), Settings |
| M10 | Enterprise: self-host mode, metadata-only mode, hardened isolation/compliance, audit |

> Approachable defaults (§20) apply everywhere — no separate "simple mode."

---

## 18. Claude Code build prompt (Milestone 1)

> Paste into Claude Code in an empty `arcane/` monorepo, with all docs present. Build milestone by milestone — never the whole system at once.

```
I'm building Arcane: a THIN local CLI + a HOSTED cloud analysis engine (the Claude Code model).
A lightweight Node npm CLI watches the repo and streams every change to Arcane Cloud; the cloud
(Bun) runs ALL analysis, security, AI, and sandboxed runtime, and streams results back
SIMULTANEOUSLY to the terminal and a web dashboard. The local machine never analyzes or runs
user code, so Arcane runs on any computer. Architecture: Arcane-Technical-Spec.md (read §1, §2,
§2A, §3, §3A, §3B, §16 first) + Arcane-Build-Guide.md (lanes + rules). Build MILESTONE BY
MILESTONE — never all at once.

THIS SESSION = Milestone 1 ONLY: the end-to-end ROUND-TRIP.
  local edit → change streamed → cloud static analysis → results live in the terminal AND a
  minimal web view, at the same time.
Do NOT build the sandbox/runtime engine, AI, test-gen, auto-fix, git intelligence, GitHub, or
teams/billing yet.

HARD INVARIANTS — honor ALL every milestone (full list: spec §16):
1. The CLI is a THIN CLIENT: it only watches, collects changes, streams, authenticates, renders.
   It NEVER runs analyzers, never produces findings, never executes user code, needs no database.
2. Change collection is ACCURATE, ORDERED, RECOVERABLE: every add/change/delete/rename is
   seq-numbered + content-hashed; the server can rebuild the tree; gaps/reconnects trigger resync,
   never silent drift (§3A).
3. ALL analysis runs in Arcane Cloud (Bun) against a shadow worktree built from streamed changes.
4. Results FAN OUT to terminal AND web simultaneously — one event → CLI socket + Realtime (§3B.2).
5. Source upload is EXPLICIT (consent at `arcane link`), encrypted in transit + at rest, deletable.
6. Incremental on the server: hash-skip unchanged; analyze blast radius; coalesce bursts.
7. Event-driven UI, idle CPU ≈ 0; the TUI shows pipeline state so a round-trip never feels hung.
8. Delta-first; approachable by default (one Health Score + plain-English findings, details on `d`).

STACK (two runtimes — do NOT mix them up):
- CLI = `packages/cli` — Node.js (LTS ≥20), TypeScript strict, ESM. NO native addons (keep
  `npm i -g` painless). Deps: ink + react (jsx: react-jsx), chokidar, ws, xxhash-wasm, simple-git
  (read-only), smol-toml, zod (via @arcane/shared), chalk. Token in a ~/.arcane file (chmod 600).
- Cloud = `services/cloud` — Bun + TypeScript. Bun.serve (WS+REST gateway), BullMQ (queue),
  Postgres via Supabase, object storage for encrypted snapshots, zod. Analyzers run here.
- Shared = `packages/shared` — TypeScript: zod wire-protocol (ChangeEvent, ResultEvent) + domain
  (Finding, Metric, Score, ArcaneConfig). Imported by BOTH.
- Web = `apps/dashboard` — Next.js + Tailwind; subscribes to Supabase Realtime.
Ask before adding ANY dependency not listed.

DELIVERABLES (Milestone 1), in this order:
1. Monorepo (npm/pnpm workspaces): packages/shared, packages/cli, services/cloud, apps/dashboard.
2. @arcane/shared FIRST: zod schemas + types for ChangeEvent + AckEvent + ResultEvent (§3A.2, §3B.2; delivery is at-least-once + idempotent — dedup by eventId, never "exactly-once") and
   Finding/Metric/Score/ArcaneConfig (§5–§6). This is the contract both sides build against.
3. CLI:
   - `arcane login` (device-link stub is fine for M1: obtain a token, store in ~/.arcane).
   - `arcane link`: build an initial manifest (path→xxhash, respect .gitignore + arcane.toml
     ignore), upload changed blobs (encrypted) to the cloud; server materializes a shadow worktree.
   - `arcane` / `arcane watch`: chokidar → CHANGE COLLECTOR per §3A (add/change/delete/rename,
     monotonic seq, content hash, atomic-write coalescing, deletes never dropped) → stream over an
     authenticated WSS; journal unacked events; resync on reconnect/seq-gap.
   - Ink TUI: pipeline states (change detected → uploading → queued → analyzing → results), a single
     Health read-out + plain-English findings by default, per-dimension bars on `d`, a findings list.
4. Cloud (Bun):
   - Gateway: Bun.serve WS+REST, authenticated, per-session channel; validate every message (zod);
     check seq, request resync on gap.
   - Index: apply change patches to a per-session shadow worktree; compute blast radius.
   - Queue (BullMQ): debounce/coalesce per session — analyze only the latest tree state.
   - THREE analyzers (server-side): cyclomatic/cognitive complexity, escape-hatch counter
     (any/@ts-ignore/as), secret-regex. Normalize → Finding[]/Metric[].
   - Score engine: per-dimension 0–100 + delta vs last snapshot + is_new; persist run+findings to
     Postgres.
   - FAN-OUT: publish the ResultEvent to the CLI socket AND a Supabase Realtime channel project:{id}.
5. Web (apps/dashboard): one page that subscribes to Realtime for the linked project and renders the
   SAME live scores/findings/pipeline state as the terminal — to prove simultaneous update.

PROCESS:
- Build @arcane/shared first; then a STUB cloud that echoes a fixed ResultEvent so you can prove the
  CLI↔cloud↔web round-trip and fan-out BEFORE real analyzers exist. Then replace the stub with the
  3 analyzers + score engine.
- Tight loop: implement a piece → `vitest run` + `npx tsc --noEmit` in each package → green before moving on.
- Run it and show me: editing a file locally updates BOTH the terminal and the browser live.
- When the round-trip works end-to-end, STOP for review before Milestone 2.
```

### Follow-on milestone prompts (one per session)
- **M2:** "Harden the change collector (§3A): rename/delete/atomic-write correctness, monotonic-seq gap detection + resync, offline journal replays unacked events safely, ignore rules, binary/large-file caps. Add git context (branch/commit/baseline SHA) and baseline + delta-first suppression server-side (`is_new`). Add server analyzers: semgrep, knip, gitleaks, osv-scanner, tree-sitter AST + import/dependency graph. Invariants unchanged."
- **M3:** "Add the CLOUD SANDBOX + Runtime Delta Engine (§19A, §21A). Per-run isolation (microVM/container, no network, CPU/mem/time caps, no shared FS, secret stripping, outbound block/record). In-sandbox `--import` probe (intercept fetch/http/db/fs; record-replay; telemetry). CONSENT: execution OFF by default; only user-declared `[[workload]]`s; permission required (allow once/session/always/deny); CI opts in via `execution.allow_in_ci`/`--yes`. Implement the Runtime Delta Engine: two worktrees (baseline/current) on the SAME server class, alternating runs, median/p95/p99 (not average), warmup separation, representative inputs, hotness-weighted attribution, microbench buckets A/B/C, confidence on every result. `arcane run [workload] --compare`; stream a live run view (latency/throughput/leak-curve) to terminal AND web."
- **M4:** "Add the AI layer (server-side): @anthropic-ai/sdk, `claude-opus-4-8` judge + `claude-haiku-4-5` triage, prompt caching on the stable prefix, diff-hash cache, daily budget + `$` spend meter, Batch in CI, opt-in. `arcane review` + `arcane explain`. zod-validated verdicts."
- **M5:** "Add test-gen (server-side): characterization (snapshot) + property-based (fast-check) from CONTRACTS (types/schema/prompt, never the implementation), Opus example tests as labeled drafts. Run + mutation-test (Stryker) in the sandbox."
- **M6:** "Add auto-fix: deterministic (eslint/ruff --fix, dead-import removal) + codemods + verified LLM fix loop in a cloud worktree (re-run analyzers+tests; only surface if it clears the finding with no regressions). Stream the fix BACK to the CLI as a diff the user applies locally. Atomic."
- **M7:** "Add the GitHub App plane (octokit, Checks API, clone-baseline path) + CI/CD gate (`arcane gate --baseline <ref>`, delta-first, exit 0/1/2, `--json`/`--sarif`/`--junit`) + PUBLISH `@arcane/cli` to npm (Node, `bin`, shebang, `engines.node>=20`, no native deps → painless install) + package the Bun engine for self-host. Per §28–§29."
- **M8:** "Build the web app full surface: Overview (Health + plain-English, approachable default), Work-Tree (branch/commit DAG via Realtime), Findings (filterable), Insights (trends, hotspots, runtime-delta history with confidence). Add account-aware terminal tabs mirroring it (`arcane branches|contributors|ci|insights`)."
- **M9:** "Add teams/roles/invites, billing, integrations (GitHub/GitLab/Slack), Settings (CLI tokens, source-access mode per project)."
- **M10:** "Enterprise: self-host mode (run the Bun engine in the customer's infra; CLI points at their endpoint), metadata-only mode, hardened isolation/compliance, audit logs."

---

---

## 19. Execution consent model, real-time graphs & UI design

### 19.1 Execution consent (opt-in · user-declared · permission-gated)
Three independent gates must all pass before any user code runs — modeled on Claude Code's own allow-once/always/deny flow:

1. **Master switch.** `execution.enabled=false` by default. With it off, Tier 2 simply doesn't exist — `arcane run` returns "execution disabled; enable in arcane.toml."
2. **User-declared allowlist.** Arcane only ever runs a `[[workload]]` the user wrote into `arcane.toml`. It may *suggest* detected scripts during `arcane init`, but the user confirms and it's written to config. Arcane never invents or guesses an entrypoint. Declaring a workload is *not* permission to run it.
3. **Per-run permission prompt.** When a run is triggered (`arcane run`, `--deep`, a keypress), if no stored grant exists, prompt:

```
┌ Permission ─────────────────────────────────────────────┐
│ Arcane wants to run workload "api"                       │
│   cmd: npm start   ·   sandbox: network=deny, 2s cap │
│                                                          │
│ [o] Allow once   [s] Allow this session                 │
│ [a] Always allow this workload   [d] Deny                │
└──────────────────────────────────────────────────────────┘
```

- "Always" persists to `.arcane/permissions.json` (per workload, per repo). `auto_grant=true` on a workload pre-grants it.
- **Headless/CI has no prompt** → requires `execution.allow_in_ci=true` or `--yes`; otherwise Arcane refuses rather than assuming consent.
- Global overrides: `--no-exec` forces off; `arcane permissions list/revoke` manages grants.

This keeps the §16 invariant intact: nothing runs unless the user turned it on, named what may run, and approved the run.

### 19.2 Real-time graphs in the CLI
Event-driven, never a render loop. New metric samples push into Ink state; chart components re-render, throttled to ~15fps; at idle nothing re-renders (CPU ≈ 0).

- **Dashboard trend sparklines** (`asciichart` or braille `⠀⡀⣀…`): each eval bar carries a small score-over-last-N-snapshots line that moves as you edit.
- **Live run view** (during `arcane run`, streamed from the sandbox): animated latency line (p50/p95), throughput, query-count climb, and the **memory-over-iterations leak curve** — watch the heap rise in real time after forced GC.
- Rendering: braille for higher-res lines (2×4 dots/cell), block chars `▁▂▃▄▅▆▇█` for bars/gauges, color-coded against thresholds. High-frequency streams are sampled/decimated to the panel width so they never thrash.

### 19.3 TUI design system ("pretty nice")
Aim: looks intentional, reads instantly, pleasant for all-day use.

- **Palette:** one accent + semantic green/amber/red for health, dimmed grays for secondary text; truecolor where supported, graceful 256/16-color and `NO_COLOR` fallbacks.
- **Layout:** bordered panels (Ink `<Box borderStyle="round">`), consistent padding/gutters, responsive to terminal size (reflow/hide panels when narrow), a clean header with the Arcane mark + repo/branch + `$` spend.
- **Motion (subtle):** the changed dimension pulses briefly; smooth bar transitions; a tasteful spinner only while Tier-1 work is in flight; no gratuitous animation.
- **States:** intentional empty/loading/first-run states, not blank panels.
- **No flicker:** rely on Ink's diffing; throttle high-freq updates; never clear-and-redraw the whole screen.
- **Theming:** `[ui] theme = "auto|dark|light"`, configurable accent; respects `NO_COLOR` and `--no-color`.

---

## 19A. Runtime Delta Engine — vetted measurement methodology

> **Product-truth line (put this in front of any reviewer):** Arcane does **not** claim to predict production runtime from source code alone. Arcane measures *controlled runtime regressions* by running **user-declared workloads** inside **Arcane-managed isolated cloud environments**, comparing **baseline vs current** code under identical conditions, and attributing slowdowns to changed files/classes/functions using runtime traces and static analysis. It's a consistent **relative regression signal** (the cloud actually makes it *more* repeatable — both sides run on the same server class), **not** a prediction of your production runtime. **Class-level microbenchmarks are supporting diagnosis only, never the main truth source.**

This section is the defensible core behind `arcane run`. It exists because the naïve version ("copy every class, run it, average the runtimes") produces *real numbers that don't mean anything*: a class doesn't run in isolation (it depends on DI, DB clients, env, decorators, framework lifecycle, global state, real inputs), and an average hides bottlenecks (100 utils at 0.05 ms + 1 checkout at 400 ms "averages fine" while the app is on fire). What matters is **the slowest hot paths, p95/p99, regressions vs the last version, query-count growth, cold-start, and memory growth** — never the mean runtime of every class.

### 19A.1 Three layers (separate, never conflated)

**Layer 1 — Static performance risk (continuous, no execution).** Runs on the hot path (§4). Flags nested loops over growing data, `await`-in-loop, DB calls in loops, heavy imports, sync FS calls, large functions, repeated expensive work, new deps that grow cold-start. **Wording rule:** this layer says *"performance risk increased"* — **never** *"runtime is slower."* It hypothesizes; it does not measure.

**Layer 2 — Real workload measurement (the main truth source).** Runs declared workloads (opt-in, sandboxed, permission-gated per §19) and compares **baseline vs current**. This is the headline signal: `p95 delta vs baseline`, query-count delta, memory growth. Example: `checkout p95 184 ms → 271 ms (+47%)`, `confidence: high`.

**Layer 3 — Class/method-level diagnosis (supporting evidence only).** Attributes a *measured* Layer-2 regression to specific methods — never the headline. It says *"the measured slowdown appears connected to `CheckoutService.createOrder()` — touched in this change, present in the hot trace, self-time +82 ms, added `OrderRepository.findById()` inside the item loop,"* not *"average class runtime 3.4 ms."*

### 19A.2 Measurement pipeline (what `arcane run --compare` actually does)
1. Resolve baseline ref (default `origin/main` or `arcane baseline`) and current (working tree).
2. Materialize **two git worktrees** — `.arcane/runs/baseline/` and `.arcane/runs/current/` — so the comparison is same-machine, same-command, same-fixtures, same-env, not "today vs a stale stored number."
3. Run the **same** declared workload in both, in the **cloud sandbox** (§21A), with the in-sandbox instrumentation probe attached. Both worktrees run on the **same server class**, so the comparison is fairer than a typical laptop measurement.
4. Capture traces: per-function self-time, call counts, query counts, fetch counts, memory samples, errors.
5. Compute robust stats per side (below) and the **delta**.
6. Attribute deltas to changed files/classes/functions (Layer 3) using the trace + the git diff.
7. (Optional) generate isolated microbenchmarks for *safe* units only (bucket A below).
8. Emit a report with an explicit **confidence** level.

### 19A.3 Accuracy techniques (the reason the numbers hold up)
- **Worktrees for fair comparison** — never compare against a stale cached run; always measure both sides now, on this machine.
- **Alternate runs, don't batch them** — run `baseline current baseline current …`, **not** all-baseline-then-all-current. Machines heat up, caches warm, schedulers shift; alternating cancels drift bias.
- **Median / p95 / p99 — never the mean.** The headline metric is **p95 delta**, with median, p99, min/max, stdev, and a variance band reported alongside. High variance → confidence drops automatically.
- **Warmup separated from steady-state.** Discard warmup iterations (JIT, module load, cold caches). Report **cold-start**, **import/module-load**, and **warm steady-state** as *distinct* numbers — never mixed.
- **Representative inputs, not random fakes.** Inputs are sourced, in priority order, from: existing tests → fixtures → Zod schemas → OpenAPI specs → recorded local requests → user-declared sample payloads. Synthetic inputs are generated **only** when enough type/schema info exists, and the result is marked lower-confidence.
- **Hotness weighting (no equal averaging).** When ranking suspects, weight by
  `importance = touched_by_change × appears_in_trace × call_frequency × time_spent × severity`
  so a checkout/auth path outranks a setup-script util used once.

### 19A.4 Microbenchmark eligibility — three buckets
- **Bucket A — safe to microbenchmark directly:** pure/utility classes, calculators, formatters, parsers, validators, mappers, simple business-rule fns. Deterministic, CPU-bound, easy to instantiate.
- **Bucket B — only with fixtures/mocks:** services with repositories, controllers, API handlers, queue processors, auth-dependent modules. Need recorded deps; marked medium-confidence.
- **Bucket C — never microbenchmark; workload-only:** DB clients, network/payment clients, framework-lifecycle classes, anything needing global app state. These are measured **only** through Layer 2, and explicitly listed as "skipped (requires DB)" / "replay fixture used" in the report. This is what prevents fake precision.

### 19A.5 Confidence model (every runtime result carries one)
- **High:** real declared workload; baseline+current both measured; repeated alternating runs; stable variance; same fixtures/env; regression appears in the trace.
- **Medium:** workload measured but limited runs; some mocked deps; moderate variance; or a bucket-B microbenchmark.
- **Low:** isolated generated microbenchmark; synthetic inputs; missing baseline; high variance; real deps skipped. (Reported, but never the headline.)

### 19A.6 Report shape (`arcane run --compare`)
```
Arcane Runtime Delta Report
Workload: api-smoke   Baseline: origin/main   Current: working tree
Runs/side: 7 (2 warmup, alternating)   Outliers removed: yes   Confidence: High

Overall:
  p95 latency      184ms → 271ms   (+47%)
  median latency    96ms → 121ms   (+26%)
  DB queries/req     14  → 38       (+171%)
  memory @500 iter  +42MB

Likely cause (diagnosis, not headline):
  1. CheckoutService.createOrder()  — changed · in hot trace · self-time +82ms
       added OrderRepository.findById() inside the item loop
  2. PricingService.calculateTotals() — self-time +11ms · complexity 8 → 15

Skipped:
  EmailClient.sendReceipt()  — outbound network blocked
  PaymentGateway.charge()    — replay fixture used
```

### 19A.7 Roadmap placement (not the MVP)
Static perf risk (Layer 1) ships with the MVP. The measured engine is phased: **v0.3** `arcane run` + declared-workload baseline-vs-current delta report · **v0.4** instrumentation + trace attribution (Layer 3) · **v0.5** safe class-level microbenchmarks + generated fixtures + confidence scoring · **v0.6** record/replay, DB snapshotting, endpoint load tests. (Maps to engine milestones M3 → M5.)

---

## 20. Approachability — easy by default (no "simple mode")

There is **no separate simple mode**. The default experience is approachable for everyone; depth is configurable on top.

- **Default view leads with a health read-out:** an aggregate Health Score (weighted mean of dimension scores → one number + traffic light) and plain-English warnings. The granular per-dimension bars are revealed on demand (`d` / "show details") — not a separate mode, just progressive disclosure.
- **Plain-English layer (always on):** a `ruleId → friendly message` map (`src/i18n/plain.ts`) covers common rules at zero token cost; unmapped/critical findings get a one-line AI rewrite (cached by ruleId). Raw metrics are available but never the default surface.
- **Guided actions:** "Fix the N safe issues?" runs `arcane fix --all --safe` (deterministic + verified only).
- **Power is configurable, not modal:** thresholds, deep scans, custom analyzers, and raw-metric density live in `arcane.toml` (e.g. `[ui] density = "summary" | "full"` controls default detail level — a preference, not a beginner/pro split). Nothing advanced is required to get value on day one.

---

## 21. Web platform — architecture

```
   Arcane CLI ──(encrypted changes, streamed)──▶ Arcane Cloud (Bun) ─▶ Postgres (Supabase)
        ▲                                            │  analyze         │
   device-link token        result events ──┐        │  fan-out         RLS
        │                                   ▼        ▼                  │
   Terminal ◀── CLI WebSocket          Supabase Realtime ──▶ Next.js web app (Vercel) ──▶ Browser
```

**Stack:** the analysis engine is **Bun + TypeScript** (§2.2). The web app is Next.js (App Router) + React + Tailwind + shadcn/ui on **Vercel**; **Supabase** provides Postgres + Auth + Realtime + Row-Level Security + Storage. Git-graph viz via `react-flow`; trend charts via `recharts`. CI/CD via `@octokit` + a GitHub App. (Supabase + Vercel are connected MCP connectors — scaffoldable directly.)

**Principles:** the cloud **is** the product (the CLI depends on it for all analysis — there is no local analysis fallback); the web app and terminal are **twin live front-ends** over the same result stream; **source is uploaded under the project's source-access mode** (cloud / metadata-only / self-host, §24), always encrypted in transit + at rest; untrusted code runs only in isolated sandboxes (§21A).

---

## 21A. Trust, isolation & sandbox security

Running other people's code and holding their source is the core responsibility of this architecture. These are requirements, not nice-to-haves.

**Source handling.** TLS in transit; encrypted at rest (per-project keys) in object storage. Scoped per project by RLS. **Deletable** on request and on project delete. An **ephemeral mode** analyzes from an in-memory/short-TTL working copy and persists only results (no source retained). Secrets detected in uploads are flagged and never logged.

**Code execution isolation (M3+).** Every workload run gets a fresh **microVM (Firecracker) or hardened container (gVisor)** — never a shared process:
- **No network by default** (deny egress; the instrumentation probe record-replays fetch/http/DB so workloads can't call the internet, hit prod, or exfiltrate).
- **CPU / memory / wall-clock caps** with watchdog SIGKILL on overrun (infinite loops die and are reported as a finding).
- **No shared filesystem between tenants**; read-only project mount where possible; scratch is per-run and destroyed after.
- **Secret stripping** before a run; **outbound calls blocked or recorded**, never silently allowed.
- One tenant's run can never see another's code, data, or environment.

**Abuse & cost controls.** Per-account quotas (analysis minutes, sandbox runs, AI spend), rate limits at the gateway, and a free-tier ceiling so a runaway client can't rack up cost. Pipeline state is always streamed so the user sees exactly what's queued/running.

**Data-policy decisions to lock before GA (placeholders — answer each explicitly in the Trust/Security page):**
- **Source retention default:** how long uploaded source persists in Cloud mode (e.g. rolling N days vs until project delete).
- **Ephemeral retention window:** TTL of the ephemeral working copy before purge.
- **Secret redaction:** are detected secrets stripped/redacted *before* the blob is persisted?
- **Training use:** uploaded source is **not** used to train models — state this plainly, and confirm the same for the AI provider.
- **Deletion SLA:** time from a delete request to actual purge (incl. backups).
- **Audit logs:** who accessed a project's source/results, and when.
- **Customer data-access boundary:** which Arcane systems/staff can read source, under what controls.
- **Third-party analyzers:** confirm wrapped tools (semgrep, etc.) run inside Arcane's environment and don't transmit code externally.
- **AI provider data policy:** disclose the provider (Anthropic) and its retention/no-training terms for code sent for review.

---

---

## 22. Cloud data model (Supabase Postgres)

```sql
-- identity & access (RLS-scoped by org/project membership)
users(id, email, name, avatar_url, created_at)              -- mirrors auth.users
orgs(id, name, slug, created_at)
memberships(org_id, user_id, role)                          -- owner|admin|member|viewer
projects(id, org_id, name, repo_url, default_branch, sync_enabled, created_at)
cli_tokens(id, user_id, name, token_hash, scopes, last_used_at, created_at, revoked_at)

-- M1 SYNC + RESULTS LAYER — defined authoritatively in §7. Do NOT redefine here.
--   sessions · source_snapshots · source_files · change_events · event_acks
--   · analysis_jobs · scores · findings · result_events
-- (§7 is the single source of truth for these; this section adds only the platform tables below)

-- platform tables (land with their milestones, M2+)
metrics(snapshot_id, dimension, key, value, unit)              -- snapshot_id → source_snapshots(id); runtime/metric detail (M3)

-- git graph
branches(id, project_id, name, is_remote, head_sha, contributor_id, updated_at)
commits(project_id, sha, parent_shas, author, message, committed_at, branch)
contributors(id, project_id, name, email, avatar_url, last_active_at)

-- runs & CI
runs(id, project_id, workload, git_sha, metrics_json, created_at)
ci_runs(id, project_id, provider, run_id, pr_number, status, gate_result, dimensions_json, url, created_at)
integrations(id, org_id, type, config_json, created_at)        -- github_app|gitlab|slack
```

RLS policy: a row is visible only if the requester is a member of its `org`/`project`. CLI tokens authenticate as the issuing user with project-scoped insert rights.

**Object-storage convention:** source blobs live in object storage (not Postgres), keyed `projects/{projectId}/blobs/{contentHash}` (content-addressed → dedup across snapshots); snapshot manifests under `projects/{projectId}/snapshots/{snapshotId}.json`. Blobs are encrypted at rest with per-project keys (§3A.6); in ephemeral mode they use a short-TTL bucket and are purged after analysis. **The M1 round-trip only requires:** `users · orgs · memberships · projects · cli_tokens · sessions · source_snapshots · source_files · change_events · event_acks · analysis_jobs · result_events · scores · findings`. The git-graph / runs / CI tables below land with their milestones (M2+).

---

## 23. Auth & CLI device-link flow

Supabase Auth handles browser sign-up/sign-in (email + GitHub/Google OAuth). The CLI uses an **OAuth 2.0 device authorization grant** (same UX as `gh`/`vercel`):

```
arcane login
  1. CLI → POST /auth/device/code → { device_code, user_code, verification_uri, interval }
  2. CLI prints user_code, opens verification_uri in the browser
  3. CLI polls POST /auth/device/token (device_code) every `interval`s
  4. User signs in + approves in the browser
  5. server mints a CLI token (row in cli_tokens, only hash stored) → CLI
  6. CLI stores the token in `~/.arcane` (chmod 600)
arcane link        # associates the current repo with a project (or creates one)
arcane logout      # revokes token (deletes ~/.arcane)
```

`arcane whoami` shows the linked account/project. Tokens are revocable from web Settings.

> **Token storage (consistent across all docs):** **M1 stores the token in a `~/.arcane` file with `chmod 600`** — no native dependency, which is what keeps `npm i -g` painless. **OS-keychain storage is optional hardening for a later milestone**, behind a flag, and must not become a required native addon.

---

## 24. Source-access modes & data handling

> **Availability by milestone (set expectations honestly):** **M1 ships Cloud mode only** (with the **ephemeral** toggle if it's cheap to add). **Metadata-only** and **self-host** are **planned** modes (self-host is packaged at M7, hardened for enterprise at M10). Don't present them as shipping today in product copy — say "planned for teams that can't upload source."

The CLI streams changes to the cloud over the protocol in §3A. *What* it may send is governed by the project's **source-access mode**:

- **Cloud (default).** Full source streamed (encrypted): initial snapshot at `arcane link`, then incremental change events. Enables all features (static analysis, AI, cloud sandbox/runtime). Source is retained encrypted, scoped per project, **deletable**, with an **ephemeral** option (analyze-and-discard, results only).
- **Metadata-only (limited).** **No source leaves the machine.** Analysis runs in the customer's own CI or self-runner (the engine, or `arcane gate`), and only **results** (scores, deltas, findings *without* code, run metrics, branch/commit graph) are pushed to the platform. Fewer features: no cloud sandbox/AI-on-source. This is the mode for teams that can't upload source.
- **Self-host (enterprise).** The Bun engine runs inside the customer's infra; the CLI points at their endpoint (`[cloud] endpoint`). Source never leaves their network; the hosted web app is optional or also self-hosted.

```toml
[cloud]
mode     = "cloud"          # cloud | metadata-only | self-host
endpoint = ""               # self-host engine URL (mode = self-host)
ephemeral = false           # cloud mode: analyze-and-discard, persist results only
share_presence = false      # publish local branch names/status to teammates (opt-in; never code)
```

**Transport:** authenticated WSS/HTTPS to the gateway; CLI token in header; per-message zod validation. **Offline:** the journal queues changes and replays on reconnect (§3A.4) — but analysis only happens once online (documented expectation, since all compute is server-side).

---

## 25. Web app structure

```
/login  /signup
/[org]                         projects list
/[org]/[project]/overview      Health score + plain-English summary + trend  (approachable default)
/[org]/[project]/tree          git graph: branches (remote + local), contributors
/[org]/[project]/findings      filterable findings across the project
/[org]/[project]/insights      trends · hotspots · risk · AI executive summary
/[org]/[project]/cicd          pipelines · gate history · integrations
/[org]/[project]/team          members · roles · invites
/[org]/[project]/settings      project config · CLI tokens · integrations · billing
```

- **Work-tree visualization (`/tree`):** `react-flow` DAG; nodes = commits/branch heads colored by health and contributor; **local branches** (reported by the CLI, unpushed) rendered distinctly (dashed) so you see in-progress work; contributor avatars on branch heads; click a branch → its findings/score. Live via Realtime.
- **Insights (`/insights`):** per-dimension trend lines (`recharts`); **hotspots** = findings grouped by file, ranked; **risk** = open high/critical + vuln deps + coverage gaps; **contributors** = health of each person's changes (constructive framing); **AI executive summary** = weekly Opus digest (batched, cheap).
- **CI/CD (`/cicd`):** `ci_runs` list with gate pass/fail, configure `gate_on`, install the GitHub App/Action, integration cards (GitHub, GitLab, Slack alerts), and a "safe to go live" readiness signal (ties to the original vision).
- **Overview (`/overview`):** leads with the health read-out by default (§20); "show details" reveals full bars. No separate mode.

---

## 26. CI/CD integration spec

- **GitHub App** (fine-grained) installed per org → enables Checks API, PR annotations, and reading Actions status. The **Action** (`arcane-dev/arcane-action`) runs `arcane gate` in the user's pipeline and posts results to the platform (via CLI token secret) AND to the PR (Checks API).
- CI/CD tab reads `ci_runs`; gate config (`gate_on`) editable in web → written back to repo `arcane.toml` via a PR.
- Integrations are pluggable (`integrations.type`): GitHub (v1), GitLab CI, Slack/Discord notifications on gate failure or health drops.

---

## 27. Account-aware terminal (authenticated TUI views)

The CLI and web app are **twin front-ends over the same account and data**: once signed in, the terminal shows the same branches, contributors, CI/CD, and insights the web app does — live.

### Sign in from the terminal
- Header shows auth state: `◐ signed in as yassine · acme/arcane`, or `not signed in — press [L]`.
- `[L]` runs the device-link flow (§23) **inline**: prints the user code + verification URL, opens the browser, polls, and flips the header to signed-in on approval. **Credentials are entered in the browser** (OAuth/secure) — the terminal shows status, never collects a raw password. (Email/password is technically possible via Supabase but discouraged: scrollback risk, no OAuth/MFA.)
- `[O]` switches org/project; `arcane whoami` / `arcane logout`.
- **Graceful degradation (offline ≠ full analysis):** signed-out or offline, the CLI shows your **local git state** and the **last cached results**, and **queues changes in the journal** — but new analysis, scores, and findings require a connection to Arcane Cloud (or your self-host endpoint). The Dashboard tab renders the **cached** read-out (clearly marked stale), not a freshly computed one; team tabs show "sign in to see your team."

### Tabbed views (keys `1–5` / tab bar)
1. **Dashboard** — eval bars + timeline + findings, streamed live from the cloud (last-cached when offline, marked stale).
2. **Branches** — your **local** branches (from git, always) + **remote/team** branches (cloud) + teammates' **local/unpushed** branches (via presence). Each row: owner · health score · ahead/behind · last activity · open findings. Plus an ASCII/braille commit DAG colored by contributor/health. Terminal twin of web `/tree`.
3. **Contributors** — everyone on the codebase, activity, and the health of their changes (constructive framing).
4. **CI/CD** — recent pipeline runs, gate pass/fail, integration status (from `ci_runs`).
5. **Insights** — health trend sparklines, hotspot files, risk summary, AI executive summary.

### Data sourcing
- **Local git state** (your branches, working tree) → read by the CLI, shown instantly. Analysis and scores come from the cloud (cached so tabs aren't blank on cold start).
- **Cloud** (team branches, contributors, ci_runs, insights) → fetched when signed in; cached locally so tabs aren't blank on cold start.
- **Live** → the CLI uses the **Supabase JS client (runs on Node)** to subscribe to the same Realtime channels as the browser, so the terminal updates in real time when a teammate pushes a branch or a CI run completes.
- **Presence (teammates' local branches)** → opt-in `[cloud] share_presence`. A member's CLI publishes local branch names + ahead/behind + health (**never code**) to the project presence channel; others see them as dashed "local (unpushed)" branches attributed to that person. **Off by default** — branch names can be sensitive.

### Headless equivalents
`arcane branches` · `arcane contributors` · `arcane ci` · `arcane insights` — same data, printed, `--json` for tooling.

**Privacy stance:** authenticated terminal views are reads of the same cloud project data (§24). Seeing *your own* local branches needs no account (git is local); seeing *teammates'* local branches requires both sides signed in + presence opted in.

---

## 28. CI/CD pipeline integration (implementation)

Arcane drops into any pipeline as a **merge gate**. In CI it runs as one headless command — `arcane gate` — no daemon, no TUI; installed in seconds via `npm i -g @arcane/cli` (or `npx @arcane/cli`) on any Node-capable runner.

### Principles
- **Headless, one command.** `arcane gate` runs the static engine, compares against a baseline, prints a summary, exits with a meaningful code. Zero interactivity.
- **Delta-first (critical).** Compares PR head vs. the merge base / target branch and fails only on **newly introduced** regressions — never the pre-existing backlog. A gate that fails on legacy debt is unusable and gets disabled.
- **Deterministic by default.** Only static/parse analysis runs in CI; execution (Tier 2) stays OFF unless `execution.allow_in_ci=true`. Reproducible, fast, safe.
- **Scales with the diff.** Analyzes changed files + blast radius only → PR runs stay fast on big repos.

### Gate semantics & config
```
arcane gate --baseline origin/main
  → analyze changed files vs baseline → compute deltas + NEW findings
  → any configured dimension breaches its rule → exit 1 (block merge)
  → else exit 0      # exit: 0 pass · 1 gate failed · 2 tool error
```
```toml
[gate]
baseline       = "origin/main"
block_on       = ["security", "tests"]   # dimensions that can fail the build
fail_new       = ["high", "critical"]    # any NEW finding ≥ this severity → fail
max_score_drop = 5                        # fail if any dimension drops > 5 pts vs baseline
# perf_budget  = { p95_ms = 10 }          # optional, only if execution.allow_in_ci = true
```

### Output formats (light up native CI surfaces)
- **stdout** — human summary for the log.
- `--json` — machine-parseable (scores, deltas, findings, `total_cost_usd`).
- `--sarif` — SARIF 2.1.0 → upload to GitHub/GitLab code-scanning so findings appear in the **Security tab + inline PR annotations** for free.
- `--junit` — JUnit XML → findings render in any CI's test reporter.

### Auth / secrets
- `ANTHROPIC_API_KEY` — only if AI gating is enabled.
- `ARCANE_TOKEN` (a CLI token from web Settings) — to post results to the platform (populates the web **CI/CD tab** + "ready to go live" signal).
- `GITHUB_TOKEN` (auto-provided) — for Checks API annotations via the Action.

### AI in CI
**Off by default** (deterministic + cheap). If enabled, runs via the **Batch API (50% off)** since CI isn't latency-sensitive, respects the daily budget, and reports spend in `--json`.

### Caching
Cache `.arcane/` (baseline + analyzer cache) and the tool install between runs; content-hash skip keeps repeat runs fast.

### Where it runs
- **PR / MR check** → `arcane gate` blocks merge on new regressions.
- **Push to main** → record health to the platform (trend over time).
- **Nightly** → `arcane scan --deep` + AI review via Batch.
- **Local pre-commit/pre-push hook** → a fast subset before code even leaves the machine.

### Concrete configs

**GitHub Actions** — official action:
```yaml
name: Arcane
on: { pull_request: {} }
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }            # baseline diff needs history
      - uses: arcane-dev/arcane-action@v1
        with: { baseline: origin/main, block-on: "security,tests" }
        env:
          ARCANE_TOKEN: ${{ secrets.ARCANE_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # only if AI gating
```

**GitHub Actions** — raw + SARIF to the Security tab:
```yaml
      - run: npm i -g @arcane/cli
      - run: arcane gate --baseline "origin/${{ github.base_ref }}" --sarif arcane.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: arcane.sarif }
```

**GitLab CI** (`.gitlab-ci.yml`):
```yaml
arcane:
  image: node:20
  script:
    - npm i -g @arcane/cli
    - arcane gate --baseline "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --junit arcane.xml
  artifacts: { reports: { junit: arcane.xml } }
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]
```

**Any CI (CircleCI / Bitbucket / Jenkins / Azure DevOps)** — generic:
```bash
npm i -g @arcane/cli                         # or download the prebuilt binary
arcane gate --baseline origin/main --json > arcane.json
# non-zero exit blocks the build; arcane.json feeds your reporter
```

**Local pre-push hook** (husky / lefthook / raw `.git/hooks/pre-push`):
```bash
#!/usr/bin/env bash
arcane gate --baseline origin/main || { echo "Arcane gate failed"; exit 1; }
```

### Ties back to the rest of the system
- Posts a `ci_runs` row to the platform → the web **CI/CD tab** (§25) and the "safe to go live" readiness signal.
- It's the **exit gate for agent loops**: `vitest run && npx tsc --noEmit && arcane gate` is the stop condition that makes an unattended build loop safe — the same gate locally, in CI, and in the loop.

---

## 29. npm distribution (implementation)

Goal: `npm install -g @arcane/cli` → `arcane` works in the terminal. Standard Node CLI. The pivot to cloud analysis **removes the CLI's only native dependency** (the SQLite store moved server-side), so the install is now about as painless as it gets — pure JS + WASM, no compiler ever needed.

### Package shape
```jsonc
// packages/cli/package.json
{
  "name": "@arcane/cli",
  "version": "x.y.z",
  "type": "module",
  "bin": { "arcane": "dist/cli.js" },     // dist/cli.js starts with: #!/usr/bin/env node
  "engines": { "node": ">=20" },
  "files": ["dist"],                       // compiled JS only — no native binaries, no wasm grammars
  "publishConfig": { "access": "public" },
  "dependencies": {
    "ink": "...", "react": "...", "chokidar": "...", "ws": "...",
    "xxhash-wasm": "...", "simple-git": "...", "smol-toml": "...",
    "zod": "...", "chalk": "...", "@arcane/shared": "workspace:*"
  },
  "scripts": {
    "build": "tsup src/cli.ts --format esm --clean",
    "prepublishOnly": "npm run build && vitest run && tsc --noEmit"
  }
}
```
- **Entry:** `dist/cli.js` carries the `#!/usr/bin/env node` shebang (tsup preserves it) and is executable.
- **ESM** throughout (Ink v4+ is ESM-only).
- **Zero native addons.** `xxhash-wasm` is WASM; everything else is pure JS. `simple-git` shells out to the user's `git`. **No `better-sqlite3`, no `web-tree-sitter`, no node-gyp** in the CLI — those live in the Bun cloud engine, not the npm package. This is why it installs cleanly on any machine.

### Install (users)
```bash
npm install -g @arcane/cli      # global → `arcane` anywhere
arcane login                    # device-link to your account
arcane link                     # link this repo (uploads encrypted snapshot per your mode)
arcane                          # live TUI; streams changes → cloud → results in terminal + web
npx @arcane/cli                 # no install
```

### The cloud engine is deployed, not published to npm
`services/cloud` (Bun + TypeScript) is a **service**, not part of the npm package — deploy it (container image) to your infra (Fly.io / Railway / a Bun-capable host) alongside Supabase (Postgres/Auth/Realtime/Storage) and Redis (BullMQ). For **self-host (enterprise)**, ship this same image so customers run the engine in their own network and point the CLI at it via `[cloud] endpoint`.

### External analyzers (cloud-side, not bundled in the CLI)
semgrep, gitleaks, knip, osv-scanner run on the **cloud workers**, baked into the engine's image — so users never install them and the CLI stays tiny.

### Optional channels (later)
- **Homebrew:** a formula that `depends_on "node"` and runs `npm install -g @arcane/cli`. Not required.
- **curl installer:** thin wrapper around the npm global install.

### Naming
`arcane` is almost certainly taken on npm — publish under a scope you own (`@arcane/cli` or `@<you>/arcane`). Verify with `npm view arcane` (a 404 means free). The command stays `arcane` regardless.
