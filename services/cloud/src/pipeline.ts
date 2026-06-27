import {
  ResultEventSchema,
  type ChangeEvent,
  type Finding,
  type Range,
  type ResultEvent,
} from "@arcane/shared";
import { COVERED_DIMENSIONS, runAnalyzers } from "./analyzers";
import { findingId } from "./analyzers/types";
import * as repo from "./db/repository";
import type { WsLike } from "./ingest";
import { scoreSnapshot, type ScoredFinding } from "./score-engine";
import type { SessionState } from "./session-store";
import { manifestHash, readShadowFile } from "./shadow-worktree";

// The analysis pipeline (plan M1C / D2a). Runs AFTER the ack in handleIngest's in-order branch,
// serialized per connection. It owns the ordering and the parent-snapshot authority:
//   resolve parent (Postgres) → read changed file (shadow worktree) → analyze → incrementally merge
//   with the parent's findings → pure score engine → persist (one transaction) → emit.
// The acked snapshotId is threaded in and used as source_snapshots.id, so the snapshot the CLI was
// acked == the snapshot in Postgres == the snapshot the scores/findings attach to.

function send(ws: WsLike, event: ResultEvent): void {
  if (ws.readyState !== 1) return; // client disconnected — stop quietly
  ResultEventSchema.parse(event); // self-check the contract before it goes on the wire
  ws.send(JSON.stringify(event));
}

// Reconstruct a Finding from a persisted parent row so it can be carried forward (its columns lack
// range columns, so cols default to 1 — line-level identity is what is_new needs, D2a).
function toFinding(s: repo.StoredFinding): Finding {
  const range: Range | undefined =
    s.startLine === null
      ? undefined
      : { startLine: s.startLine, startCol: 1, endLine: s.endLine ?? s.startLine, endCol: 1 };
  return {
    id: findingId(s.ruleId, s.file, range),
    dimension: s.dimension,
    severity: s.severity,
    ruleId: s.ruleId,
    message: s.message,
    file: s.file,
    range,
    fixable: s.fixable ? "deterministic" : false,
  };
}

export async function analyzeAndEmit(
  ws: WsLike,
  session: SessionState,
  ev: ChangeEvent,
  snapshotId: string,
): Promise<void> {
  send(ws, { kind: "state", sessionId: ev.sessionId, phase: "analyzing" });
  try {
    // Parent = the latest analyzed snapshot of this session, else the project baseline (D2a).
    const parentSnapshotId =
      (await repo.latestAnalyzedSnapshot(ev.sessionId)) ?? session.baseSnapshotId;
    const parentScores = await repo.getScores(parentSnapshotId);
    const parentStored = await repo.getFindings(parentSnapshotId);
    const parentKeys = new Set(parentStored.map(repo.keyOfStored));

    // Blast radius (incremental, invariant §16.5): the file(s) this event touched. Carry forward the
    // parent's findings for every OTHER file so the score reflects the whole snapshot, not just the
    // diff. (Import-graph dependents are M2.)
    const changed = new Set<string>([ev.path]);
    if (ev.oldPath) changed.add(ev.oldPath);
    const carried = parentStored.filter((f) => !changed.has(f.file)).map(toFinding);

    let fresh: Finding[] = [];
    if (ev.op !== "delete") {
      const content = await readShadowFile(session.projectId, ev.path);
      if (content !== null) fresh = runAnalyzers([{ path: ev.path, content }]);
    }
    const current = [...carried, ...fresh];

    const { scores, findings } = scoreSnapshot(current, parentScores, parentKeys, COVERED_DIMENSIONS);

    // Persist (one transaction). ensureSession first so the source_snapshots FK resolves.
    await repo.ensureSession(ev.sessionId, session.projectId, session.baseSnapshotId);
    await repo.persistSnapshotResults({
      projectId: session.projectId,
      sessionId: ev.sessionId,
      snapshotId,
      parentSnapshotId,
      manifestHash: manifestHash(session.manifest),
      files: [...session.manifest].map(([path, contentHash]) => ({ path, contentHash })),
      scores,
      findings,
    });
    await repo.insertAnalysisJob(session.projectId, ev.sessionId, snapshotId); // §7 legibility (C2)

    // Emit the full current result set: findings first, then per-dimension scores. The CLI framed
    // this set with the `analyzing` phase above; `results`/`done` close it.
    for (const f of findings) {
      const { isNew, ...finding }: ScoredFinding = f;
      send(ws, { kind: "finding", finding, isNew });
    }
    for (const s of scores) send(ws, { kind: "score", ...s });
    send(ws, { kind: "state", sessionId: ev.sessionId, phase: "results" });
    console.log(
      `⚙ analyzed seq=${ev.seq} ${ev.path} → ${findings.length} finding(s), ` +
        `${scores.map((s) => `${s.dimension}=${s.value}(${s.delta >= 0 ? "+" : ""}${s.delta})`).join(" ")}`,
    );
  } catch (err) {
    // Failure isolation (D2a): the ack already stands (apply is durable); analysis failure never
    // corrupts the sync layer. Log and still close the frame so the TUI doesn't hang on "analyzing".
    console.error(`✗ analyze failed seq=${ev.seq} ${ev.path}:`, (err as Error).message);
  } finally {
    send(ws, { kind: "state", sessionId: ev.sessionId, phase: "done" });
  }
}
