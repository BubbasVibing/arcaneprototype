import type { Dimension, ManifestFile, ResultEvent, RunConsent, RunReport, Severity } from "@arcane/shared";
import { findingKey } from "../analyzers/types";
import type { ScoredFinding } from "../score-engine";
import { sql } from "./client";
import { DEV_ORG_ID, DEV_USER_ID } from "./constants";

// The results-persistence layer (plan M1C / D2a). A separate concern from the in-memory sync store
// (session-store.ts): it shares only IDs and is the durable authority for the analyzed-snapshot
// chain that delta/is_new read from. All writes are idempotent so a replayed event is harmless.

export interface SnapshotFile {
  path: string;
  contentHash: string;
}

export interface StoredFinding {
  dimension: Dimension;
  severity: Severity;
  ruleId: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  message: string;
  fixable: boolean;
}

export interface PersistInput {
  projectId: string;
  sessionId: string;
  snapshotId: string;
  parentSnapshotId: string;
  manifestHash: string;
  files: SnapshotFile[];
  scores: { dimension: Dimension; value: number; delta: number }[];
  findings: ScoredFinding[];
}

// `arcane link`: the minted project belongs to the seeded dev org (D2b).
export async function ensureProject(projectId: string, name: string): Promise<void> {
  await sql`INSERT INTO projects (id, org_id, name)
            VALUES (${projectId}, ${DEV_ORG_ID}, ${name})
            ON CONFLICT (id) DO NOTHING`;
}

// `arcane link`: persist the baseline snapshot + its manifest (session_id NULL — no watch session
// yet). This row is the first parent in the analyzed chain (D2a).
export async function insertBaselineSnapshot(
  projectId: string,
  snapshotId: string,
  manifestHashValue: string,
  files: SnapshotFile[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO source_snapshots (id, project_id, session_id, parent_snapshot_id, manifest_hash)
             VALUES (${snapshotId}, ${projectId}, NULL, NULL, ${manifestHashValue})
             ON CONFLICT (id) DO NOTHING`;
    for (const f of files) {
      await tx`INSERT INTO source_files (snapshot_id, path, content_hash)
               VALUES (${snapshotId}, ${f.path}, ${f.contentHash})
               ON CONFLICT (snapshot_id, path) DO NOTHING`;
    }
  });
}

// A lightweight §7 `analysis_jobs` record per analyze run (C2) — M1C analyzes synchronously (no
// BullMQ queue, M2), so the row lands already `done` rather than tracking a real lifecycle.
export async function insertAnalysisJob(
  projectId: string,
  sessionId: string,
  snapshotId: string,
): Promise<void> {
  await sql`INSERT INTO analysis_jobs (project_id, session_id, snapshot_id, status, started_at, finished_at)
            VALUES (${projectId}, ${sessionId}, ${snapshotId}, 'done', now(), now())`;
}

// First event of a watch session: create the §7 `sessions` row (FK anchor for source_snapshots).
// baseSnapshotId is nullable — an M3D run session has no base snapshot of its own.
export async function ensureSession(
  sessionId: string,
  projectId: string,
  baseSnapshotId: string | null,
): Promise<void> {
  await sql`INSERT INTO sessions (id, project_id, user_id, base_snapshot_id)
            VALUES (${sessionId}, ${projectId}, ${DEV_USER_ID}, ${baseSnapshotId})
            ON CONFLICT (id) DO NOTHING`;
}

// M3D Gate 0 (single-tenant guard): the org that owns a project. Used to refuse any run for a project
// outside the single dev tenant — the executable form of the M3C integrity precondition (fails closed
// the instant a second tenant could trigger a run). null when the project is unknown.
export async function getProjectOrgId(projectId: string): Promise<string | null> {
  const rows = await sql`SELECT org_id FROM projects WHERE id = ${projectId}`;
  return rows.length > 0 ? (rows[0].org_id as string) : null;
}

// ── M3D run-job queue (approved Q3) ────────────────────────────────────────────────────────────────

export interface RunJob {
  id: string;
  projectId: string;
  sessionId: string;
  workloadName: string;
  baselineRef: string;
  currentRef: string;
  consent: RunConsent | null;
  baselineFiles: ManifestFile[];
  currentFiles: ManifestFile[];
}

export interface EnqueueRunInput {
  projectId: string;
  sessionId: string;
  workloadName: string;
  baselineRef: string;
  currentRef: string;
  consent: RunConsent | null;
  baselineFiles: ManifestFile[];
  currentFiles: ManifestFile[];
}

// Enqueue a gated run (the cold path). Returns the run id. The two trees ride in `inputs` jsonb so the
// worker is self-contained (no dependency on an active watch session's shadow worktree).
export async function enqueueRun(input: EnqueueRunInput): Promise<string> {
  const inputs = { baselineFiles: input.baselineFiles, currentFiles: input.currentFiles };
  const rows = await sql`
    INSERT INTO run_jobs (project_id, session_id, status, workload_name, baseline_ref, current_ref, consent, inputs)
    VALUES (${input.projectId}, ${input.sessionId}, 'queued', ${input.workloadName},
            ${input.baselineRef}, ${input.currentRef}, ${input.consent}, ${inputs}::jsonb)
    RETURNING id`;
  return rows[0].id as string;
}

interface RunJobRow {
  id: string;
  project_id: string;
  session_id: string;
  workload_name: string;
  baseline_ref: string;
  current_ref: string;
  consent: string | null;
  inputs: { baselineFiles: ManifestFile[]; currentFiles: ManifestFile[] };
}

// Claim the oldest queued run in ONE transaction (FOR UPDATE SKIP LOCKED — safe on the pooled PgBouncer
// transaction-mode handle; concurrent workers never claim the same row). Marks it `running` inside the
// same txn, then the caller executes OUTSIDE the lock. null when the queue is empty.
export async function claimNextRun(): Promise<RunJob | null> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id, project_id, session_id, workload_name, baseline_ref, current_ref, consent, inputs
      FROM run_jobs
      WHERE status = 'queued'
      ORDER BY queued_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1`) as RunJobRow[];
    const row = rows[0];
    if (!row) return null;
    await tx`UPDATE run_jobs SET status = 'running', started_at = now() WHERE id = ${row.id}`;
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      workloadName: row.workload_name,
      baselineRef: row.baseline_ref,
      currentRef: row.current_ref,
      consent: (row.consent as RunConsent | null) ?? null,
      baselineFiles: row.inputs.baselineFiles,
      currentFiles: row.inputs.currentFiles,
    };
  });
}

export async function markRunDone(runId: string, report: RunReport): Promise<void> {
  await sql`UPDATE run_jobs SET status = 'done', report = ${report}::jsonb, finished_at = now()
            WHERE id = ${runId}`;
}

export async function markRunError(runId: string, error: string): Promise<void> {
  await sql`UPDATE run_jobs SET status = 'error', error = ${error}, finished_at = now()
            WHERE id = ${runId}`;
}

// Best-effort retention: drop finished run rows (heavy two-tree `inputs` jsonb) older than the TTL.
export async function reapOldRuns(olderThanMs: number): Promise<number> {
  const cutoffSeconds = Math.floor(olderThanMs / 1000);
  const rows = await sql`DELETE FROM run_jobs
                         WHERE status IN ('done', 'error')
                           AND finished_at < now() - make_interval(secs => ${cutoffSeconds})
                         RETURNING id`;
  return rows.length;
}

// The parent for delta/is_new (D2a): the latest analyzed snapshot of this session, or null if this
// is the session's first analyzed event (caller falls back to the baseline snapshot).
export async function latestAnalyzedSnapshot(sessionId: string): Promise<string | null> {
  const rows = await sql`SELECT id FROM source_snapshots
                         WHERE session_id = ${sessionId}
                         ORDER BY created_at DESC, id DESC LIMIT 1`;
  return rows.length > 0 ? (rows[0].id as string) : null;
}

export async function getScores(snapshotId: string): Promise<Map<Dimension, number>> {
  const rows = await sql`SELECT dimension, score FROM scores WHERE snapshot_id = ${snapshotId}`;
  const map = new Map<Dimension, number>();
  for (const r of rows) map.set(r.dimension as Dimension, Number(r.score));
  return map;
}

interface FindingRow {
  dimension: string;
  severity: string;
  rule_id: string;
  file: string;
  start_line: number | null;
  end_line: number | null;
  message: string;
  fixable: boolean;
}

export async function getFindings(snapshotId: string): Promise<StoredFinding[]> {
  const rows = (await sql`SELECT dimension, severity, rule_id, file, start_line, end_line, message, fixable
                          FROM findings WHERE snapshot_id = ${snapshotId}`) as FindingRow[];
  return rows.map((r) => ({
    dimension: r.dimension as Dimension,
    severity: r.severity as Severity,
    ruleId: r.rule_id,
    file: r.file,
    startLine: r.start_line === null ? null : Number(r.start_line),
    endLine: r.end_line === null ? null : Number(r.end_line),
    message: r.message,
    fixable: Boolean(r.fixable),
  }));
}

export function keyOfStored(f: StoredFinding): string {
  return findingKey(f.ruleId, f.file, f.startLine, f.endLine);
}

// Fan-out persistence (M1D): write one analyzed frame's ResultEvents to `result_events` as ONE
// batched INSERT — the durable copy AND, via WAL→Realtime postgres_changes, the live push to the web
// dashboard. Rows are inserted in the given (emit) order (analyzing first) so the identity `seq` is
// assigned in that order and each frame's `analyzing` row holds the frame-minimum seq — the ordering
// the browser's hydration relies on. `state` events are session-scoped (snapshot_id NULL);
// `score`/`finding` attach to the analyzed snapshot. The caller treats this as best-effort (logs +
// swallows) so a fan-out failure never corrupts the sync layer or the ack; the next frame self-heals.
export async function insertResultEvents(input: {
  projectId: string;
  sessionId: string;
  snapshotId: string | null; // null for M3D run events (state/run are session-scoped, snapshot_id NULL)
  events: ResultEvent[];
}): Promise<void> {
  if (input.events.length === 0) return;
  // Pass ONE jsonb array of {snapshot_id, kind, payload} rows (Bun.sql serializes the JS array to
  // jsonb) and unnest it WITH ORDINALITY so rows are inserted in array (emit) order → the identity
  // `seq` follows emit order (analyzing first → frame-minimum). state events are session-scoped
  // (snapshot_id null); score/finding attach to the analyzed snapshot.
  const rows = input.events.map((ev) => ({
    snapshot_id: ev.kind === "score" || ev.kind === "finding" ? input.snapshotId : null,
    kind: ev.kind,
    payload: ev,
  }));
  await sql`
    INSERT INTO result_events (project_id, session_id, snapshot_id, kind, payload)
    SELECT ${input.projectId}::uuid, ${input.sessionId}::uuid,
           (r.value->>'snapshot_id')::uuid, r.value->>'kind', r.value->'payload'
    FROM jsonb_array_elements(${rows}::jsonb) WITH ORDINALITY AS r(value, ord)
    ORDER BY r.ord`;
}

// Persist one analyzed snapshot + its files, scores, and findings in a SINGLE transaction (D2a):
// either the whole result lands or none of it does — no partial rows after a mid-write failure.
export async function persistSnapshotResults(input: PersistInput): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO source_snapshots (id, project_id, session_id, parent_snapshot_id, manifest_hash)
             VALUES (${input.snapshotId}, ${input.projectId}, ${input.sessionId}, ${input.parentSnapshotId}, ${input.manifestHash})
             ON CONFLICT (id) DO NOTHING`;
    for (const f of input.files) {
      await tx`INSERT INTO source_files (snapshot_id, path, content_hash)
               VALUES (${input.snapshotId}, ${f.path}, ${f.contentHash})
               ON CONFLICT (snapshot_id, path) DO NOTHING`;
    }
    for (const s of input.scores) {
      await tx`INSERT INTO scores (snapshot_id, dimension, score, delta)
               VALUES (${input.snapshotId}, ${s.dimension}, ${s.value}, ${s.delta})
               ON CONFLICT (snapshot_id, dimension)
               DO UPDATE SET score = excluded.score, delta = excluded.delta`;
    }
    for (const f of input.findings) {
      await tx`INSERT INTO findings
                 (project_id, snapshot_id, dimension, severity, rule_id, file, start_line, end_line, message, fixable, is_new)
               VALUES (${input.projectId}, ${input.snapshotId}, ${f.dimension}, ${f.severity}, ${f.ruleId},
                       ${f.file}, ${f.range?.startLine ?? null}, ${f.range?.endLine ?? null}, ${f.message},
                       ${Boolean(f.fixable)}, ${f.isNew})`;
    }
  });
}
