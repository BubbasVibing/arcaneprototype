import type { Finding } from "../domain/finding";
import type { RunReport } from "../domain/run-report";
import type { Score } from "../domain/score";
import type { ResultEvent, ResultPhase } from "../protocol/result-event";

// The canonical reduction of a ResultEvent stream into a renderable view — the SAME logic the TUI
// applies (cli.ts switch + tui/store.ts mutators), extracted here so the terminal and the web
// dashboard cannot drift (invariant 4: same data, same shapes on both surfaces). Pure + framework-
// free: `applyResultEvent(view, ev)` returns the next immutable view.
//
// Frame semantics (mirrors the cloud pipeline, §3B.1): the cloud's `analyzing` phase OPENS a frame —
// the `finding` events that follow are the COMPLETE current set for that snapshot, so findings are
// cleared on `analyzing`. Scores are NEVER cleared: each `score` event replaces its dimension in
// place (the engine re-emits every covered dimension each frame). `run` is not emitted in M1.

export interface ResultFinding extends Finding {
  isNew: boolean; // the cloud's is_new verdict for this snapshot
}

// The live single-branch git context of a watch session (the dashboard's "Working tree" card). Mirrors
// WorkTreeResultSchema minus the wire envelope (kind/sessionId).
export interface WorkTree {
  branch: string | null;
  headSha: string | null;
  baselineRef?: string;
  changeCount?: number;
}

export interface ResultView {
  phase: ResultPhase | null;
  scores: Score[]; // latest per dimension, sorted by dimension
  findings: ResultFinding[]; // findings of the current frame
  sessionId: string | null; // the session this view reflects (set from `state` events)
  run: RunReport | null; // M3D: the latest Runtime Delta Engine report (the live run view, §19A)
  workTree: WorkTree | null; // the live git context of the watch session (set from `worktree` events)
}

export function emptyResultView(): ResultView {
  return { phase: null, scores: [], findings: [], sessionId: null, run: null, workTree: null };
}

export function applyResultEvent(view: ResultView, ev: ResultEvent): ResultView {
  switch (ev.kind) {
    case "state": {
      const next: ResultView = { ...view, phase: ev.phase, sessionId: ev.sessionId };
      // `analyzing` opens a fresh frame: clear the prior frame's findings before the complete new set
      // arrives (mirrors the TUI's beginFrame). Scores are not cleared.
      if (ev.phase === "analyzing") next.findings = [];
      return next;
    }
    case "score": {
      const score: Score = { dimension: ev.dimension, value: ev.value, delta: ev.delta };
      const scores = [...view.scores.filter((s) => s.dimension !== score.dimension), score].sort((a, b) =>
        a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0,
      );
      return { ...view, scores };
    }
    case "finding":
      return { ...view, findings: [...view.findings, { ...ev.finding, isNew: ev.isNew }] };
    case "run":
      // M3D: store the latest RunReport so the terminal and the web dashboard render the same live
      // run view (invariant 4 — same data, same shapes on both surfaces).
      return { ...view, run: ev.report };
    case "worktree":
      // The live git context of the watch session — replace in place (the latest frame wins).
      return {
        ...view,
        workTree: {
          branch: ev.branch,
          headSha: ev.headSha,
          baselineRef: ev.baselineRef,
          changeCount: ev.changeCount,
        },
      };
  }
}
