import type { ArcaneConfig, Dimension, Finding, Range, ResultEvent, WorkTree } from "@arcane/shared";
import { coveredDimensions, runAnalyzers, runProjectAnalyzers, selectAnalyzers } from "./analyzers";
import { findingId, type AnalyzerInput } from "./analyzers/types";
import * as repo from "./db/repository";
import { scoreSnapshot, type ScoredFinding } from "./score-engine";
import { manifestHash, readWorktreeFile } from "./shadow-worktree";

// The source-agnostic analysis core (S3a — extracted verbatim from pipeline.ts's analyzeAndEmit).
// Given a materialized worktree on disk + the changed paths + a project/session identity, it runs the
// SAME chain both sources rely on: resolve parent (Postgres) → per-file + whole-tree analyzers over the
// worktree → incremental merge with the parent → pure score engine → persist (one txn) → fan out to
// result_events (→ WAL → Realtime → dashboard). It owns NOTHING source-specific: no WebSocket, no
// ChangeEvent, no SessionState. The CLI path (pipeline.ts) and the GitHub path (github/analyze-push.ts)
// each build an AnalyzeContext and call this, so findings render identically wherever the code arrived
// from — the web half of invariant §16.4 (the CLI socket half is the optional `onEvent` sink below).

export interface AnalyzeContext {
  projectId: string;
  sessionId: string;
  snapshotId: string;
  rootDir: string; // absolute path to the materialized tree (shadow worktree, or a fetched commit)
  manifest: Array<{ path: string; contentHash: string }>; // every file in the current tree
  changedPaths: string[]; // blast radius — the files this frame touched
  baseSnapshotId: string | null; // fallback parent when the session has no analyzed snapshot yet
  config: ArcaneConfig | undefined;
  label: string; // for logs, e.g. "seq=7 src/a.ts" (CLI) or "push a1b2c3d (3 files)" (GitHub)
  signal?: AbortSignal; // abort when a newer frame supersedes (CLI debounce); a one-shot source omits it
  onEvent?: (event: ResultEvent) => void; // live sink (CLI socket); the web fan-out always happens
  workTree?: WorkTree; // live git context (CLI watch only) → a `worktree` event opens the frame
}

// Reconstruct a Finding from a persisted parent row so it can be carried forward (parent rows lack
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

export async function analyzeWorktree(ctx: AnalyzeContext): Promise<void> {
  const signal = ctx.signal ?? new AbortController().signal;
  // Tee every ResultEvent to BOTH sinks (invariant §16.4): the optional live sink (the CLI socket) AND
  // a frame buffer flushed to result_events at frame end → WAL → Realtime → the web dashboard. ONE emit
  // point; the surfaces can't drift. Buffer order IS emit order (analyzing first).
  const frame: ResultEvent[] = [];
  const emit = (event: ResultEvent): void => {
    ctx.onEvent?.(event);
    frame.push(event);
  };

  emit({ kind: "state", sessionId: ctx.sessionId, phase: "analyzing" });
  // CLI watch sessions carry live git context — open the frame with a `worktree` event so the
  // dashboard's Working-tree card updates in lockstep with the scores/findings (its in-frame seq is
  // ≥ the `analyzing` boundary, so it also replays correctly on a cold dashboard load).
  if (ctx.workTree) emit({ kind: "worktree", sessionId: ctx.sessionId, ...ctx.workTree });
  try {
    // Parent = the latest analyzed snapshot of this session, else the baseline (D2a). null ⇒ the
    // session's first analyzed snapshot (a GitHub source's first push) → empty parent → everything
    // is_new, scores vs 100.
    const parentSnapshotId = (await repo.latestAnalyzedSnapshot(ctx.sessionId)) ?? ctx.baseSnapshotId;
    const parentScores = parentSnapshotId
      ? await repo.getScores(parentSnapshotId)
      : new Map<Dimension, number>();
    const parentStored = parentSnapshotId ? await repo.getFindings(parentSnapshotId) : [];
    const parentKeys = new Set(parentStored.map(repo.keyOfStored));

    // Config-driven selection (M2B): which per-file + project analyzers, and which project tools are
    // actually available on this engine (capability-probed; an absent tool degrades to a clean skip).
    const { perFile, project } = selectAnalyzers(ctx.config);
    const availableProject = [];
    for (const a of project) {
      if (signal.aborted) return; // superseded mid-probe
      if (await a.isAvailable()) availableProject.push(a);
    }
    // Project (whole-tree) analyzers are AUTHORITATIVE for their dimensions this frame — those dims are
    // fully replaced (never carried, never doubled from a per-file analyzer like gitleaks↔secrets).
    const projectDims = new Set(availableProject.map((a) => a.dimension));

    // Blast radius (incremental, §16.5): per-file analyzers run on the changed file(s); we carry the
    // parent's per-file findings for every OTHER file so the score reflects the whole snapshot, not the
    // diff. A path that was deleted / renamed away / is binary reads null below and is simply skipped.
    const changed = new Set(ctx.changedPaths);
    const freshInputs: AnalyzerInput[] = [];
    for (const p of ctx.changedPaths) {
      const content = await readWorktreeFile(ctx.rootDir, p);
      if (content !== null) freshInputs.push({ path: p, content });
    }
    const perFileFresh = runAnalyzers(freshInputs, perFile).filter((f) => !projectDims.has(f.dimension));
    const carried = parentStored
      .filter((f) => !changed.has(f.file))
      .map(toFinding)
      .filter((f) => !projectDims.has(f.dimension)); // project dims come fresh whole-tree, not carried

    const projectFindings = await runProjectAnalyzers(availableProject, {
      rootDir: ctx.rootDir,
      files: ctx.manifest.map((f) => f.path),
      changedPaths: [...changed],
      config: ctx.config ?? ({} as ArcaneConfig),
      signal,
    });
    if (signal.aborted) return; // a newer frame supersedes — don't persist/emit a stale one

    const current = [...carried, ...perFileFresh, ...projectFindings];
    const covered = coveredDimensions(perFile, availableProject);
    const { scores, findings } = scoreSnapshot(current, parentScores, parentKeys, covered);

    // Persist (one transaction). ensureSession first so the source_snapshots FK resolves.
    await repo.ensureSession(ctx.sessionId, ctx.projectId, ctx.baseSnapshotId);
    await repo.persistSnapshotResults({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      snapshotId: ctx.snapshotId,
      parentSnapshotId,
      manifestHash: manifestHash(new Map(ctx.manifest.map((f) => [f.path, f.contentHash]))),
      files: ctx.manifest,
      scores,
      findings,
    });
    await repo.insertAnalysisJob(ctx.projectId, ctx.sessionId, ctx.snapshotId); // §7 legibility (C2)

    // Emit the full current result set: findings first, then per-dimension scores. `analyzing` framed
    // it above; `results`/`done` close it.
    for (const f of findings) {
      const { isNew, ...finding }: ScoredFinding = f;
      emit({ kind: "finding", finding, isNew });
    }
    for (const s of scores) emit({ kind: "score", ...s });
    emit({ kind: "state", sessionId: ctx.sessionId, phase: "results" });
    console.log(
      `⚙ analyzed ${ctx.label} → ${findings.length} finding(s), ` +
        `${scores.map((s) => `${s.dimension}=${s.value}(${s.delta >= 0 ? "+" : ""}${s.delta})`).join(" ")}`,
    );
  } catch (err) {
    // Failure isolation (D2a): analysis failure never corrupts the sync layer (the CLI ack is already
    // durable). Log and still close the frame so the TUI doesn't hang on "analyzing".
    console.error(`✗ analyze failed ${ctx.label}:`, (err as Error).message);
  } finally {
    emit({ kind: "state", sessionId: ctx.sessionId, phase: "done" });
    // Fan out the whole frame to the web in ONE batched INSERT (rows in emit order → the analyzing row
    // holds the frame-min `seq`). Best-effort: a failure never corrupts the sync layer or the ack —
    // scores are full-replace + findings full-set per frame, so the next frame self-heals.
    try {
      await repo.insertResultEvents({
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        snapshotId: ctx.snapshotId,
        events: frame,
      });
    } catch (err) {
      console.error(`✗ result_events fan-out failed ${ctx.label}:`, (err as Error).message);
    }
  }
}
