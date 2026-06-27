import type { Dimension, Severity } from "@arcane/shared";
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
export async function ensureSession(
  sessionId: string,
  projectId: string,
  baseSnapshotId: string,
): Promise<void> {
  await sql`INSERT INTO sessions (id, project_id, user_id, base_snapshot_id)
            VALUES (${sessionId}, ${projectId}, ${DEV_USER_ID}, ${baseSnapshotId})
            ON CONFLICT (id) DO NOTHING`;
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
