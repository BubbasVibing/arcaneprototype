import {
  ResultEventSchema,
  type ArcaneConfig,
  type ChangeEvent,
  type Finding,
  type Range,
  type ResultEvent,
} from "@arcane/shared";
import { coveredDimensions, runAnalyzers, runProjectAnalyzers, selectAnalyzers } from "./analyzers";
import { findingId } from "./analyzers/types";
import * as repo from "./db/repository";
import type { WsLike } from "./ingest";
import { scoreSnapshot, type ScoredFinding } from "./score-engine";
import type { SessionState } from "./session-store";
import { manifestHash, projectDir, readShadowFile } from "./shadow-worktree";

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

// Per-session trailing debounce + AbortController (M2B): whole-tree project analyzers (semgrep etc.)
// can't run on every keystroke, so coalesce a burst to the latest tree state (§3B.1/§3B.3). The ack
// already went out in handleIngest, so this added latency is post-ack. A newer event aborts the
// in-flight/pending analysis and reschedules.
interface ScheduledAnalysis {
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}
const scheduled = new Map<string, ScheduledAnalysis>();
const DEBOUNCE_MS = 120;

export function scheduleAnalysis(
  ws: WsLike,
  session: SessionState,
  ev: ChangeEvent,
  snapshotId: string,
): void {
  const existing = scheduled.get(ev.sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.controller.abort(); // supersede a pending or in-flight analysis for this session
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void analyzeAndEmit(ws, session, ev, snapshotId, controller.signal).finally(() => {
      if (scheduled.get(ev.sessionId)?.controller === controller) scheduled.delete(ev.sessionId);
    });
  }, DEBOUNCE_MS);
  scheduled.set(ev.sessionId, { timer, controller });
}

export async function analyzeAndEmit(
  ws: WsLike,
  session: SessionState,
  ev: ChangeEvent,
  snapshotId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  // Tee every ResultEvent to BOTH sinks (invariant 4): `send` → the CLI socket (immediate, unchanged)
  // AND a frame buffer flushed to `result_events` at frame end → WAL → Realtime → the web dashboard.
  // ONE emit point; the two surfaces can't drift. The buffer order IS the emit order (analyzing first).
  const frame: ResultEvent[] = [];
  const emit = (event: ResultEvent): void => {
    send(ws, event);
    frame.push(event);
  };

  emit({ kind: "state", sessionId: ev.sessionId, phase: "analyzing" });
  try {
    // Parent = the latest analyzed snapshot of this session, else the project baseline (D2a).
    const parentSnapshotId =
      (await repo.latestAnalyzedSnapshot(ev.sessionId)) ?? session.baseSnapshotId;
    const parentScores = await repo.getScores(parentSnapshotId);
    const parentStored = await repo.getFindings(parentSnapshotId);
    const parentKeys = new Set(parentStored.map(repo.keyOfStored));

    // Config-driven selection (M2B): which per-file + project analyzers, and which project tools are
    // actually available on this engine (capability-probed; an absent tool degrades to a clean skip).
    const { perFile, project } = selectAnalyzers(session.config);
    const availableProject = [];
    for (const a of project) {
      if (signal.aborted) return; // superseded mid-probe
      if (await a.isAvailable()) availableProject.push(a);
    }
    // Project (whole-tree) analyzers are AUTHORITATIVE for their dimensions this frame — those dims
    // are fully replaced (never carried, never doubled from a per-file analyzer like gitleaks↔secrets).
    const projectDims = new Set(availableProject.map((a) => a.dimension));

    // Blast radius (incremental, invariant §16.5): the file(s) this event touched. Per-file analyzers
    // run on the changed file; we carry forward the parent's per-file findings for every OTHER file so
    // the score reflects the whole snapshot, not just the diff.
    const changed = new Set<string>([ev.path]);
    if (ev.oldPath) changed.add(ev.oldPath);

    let perFileFresh: Finding[] = [];
    if (ev.op !== "delete") {
      const content = await readShadowFile(session.projectId, ev.path);
      if (content !== null) perFileFresh = runAnalyzers([{ path: ev.path, content }], perFile);
    }
    perFileFresh = perFileFresh.filter((f) => !projectDims.has(f.dimension));
    const carried = parentStored
      .filter((f) => !changed.has(f.file))
      .map(toFinding)
      .filter((f) => !projectDims.has(f.dimension)); // project dims come fresh whole-tree, not carried

    const projectFindings = await runProjectAnalyzers(availableProject, {
      rootDir: projectDir(session.projectId),
      files: [...session.manifest.keys()],
      changedPaths: [...changed],
      config: session.config ?? ({} as ArcaneConfig),
      signal,
    });
    if (signal.aborted) return; // a newer frame supersedes — don't persist/emit a stale one

    const current = [...carried, ...perFileFresh, ...projectFindings];
    const covered = coveredDimensions(perFile, availableProject);
    const { scores, findings } = scoreSnapshot(current, parentScores, parentKeys, covered);

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
      emit({ kind: "finding", finding, isNew });
    }
    for (const s of scores) emit({ kind: "score", ...s });
    emit({ kind: "state", sessionId: ev.sessionId, phase: "results" });
    console.log(
      `⚙ analyzed seq=${ev.seq} ${ev.path} → ${findings.length} finding(s), ` +
        `${scores.map((s) => `${s.dimension}=${s.value}(${s.delta >= 0 ? "+" : ""}${s.delta})`).join(" ")}`,
    );
  } catch (err) {
    // Failure isolation (D2a): the ack already stands (apply is durable); analysis failure never
    // corrupts the sync layer. Log and still close the frame so the TUI doesn't hang on "analyzing".
    console.error(`✗ analyze failed seq=${ev.seq} ${ev.path}:`, (err as Error).message);
  } finally {
    emit({ kind: "state", sessionId: ev.sessionId, phase: "done" });
    // Fan out the whole frame to the web in ONE batched INSERT (rows in emit order → the analyzing
    // row holds the frame-min `seq`). Best-effort: a failure never corrupts the sync layer or the ack
    // — scores are full-replace + findings full-set per frame, so the next frame self-heals. The only
    // unhealed case (a permanent failure on a session's LAST frame) is logged loudly here (M1D).
    try {
      await repo.insertResultEvents({
        projectId: session.projectId,
        sessionId: ev.sessionId,
        snapshotId,
        events: frame,
      });
    } catch (err) {
      console.error(`✗ result_events fan-out failed seq=${ev.seq}:`, (err as Error).message);
    }
  }
}
