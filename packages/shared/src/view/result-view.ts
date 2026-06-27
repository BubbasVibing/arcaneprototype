import type { Finding } from "../domain/finding";
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

export interface ResultView {
  phase: ResultPhase | null;
  scores: Score[]; // latest per dimension, sorted by dimension
  findings: ResultFinding[]; // findings of the current frame
  sessionId: string | null; // the session this view reflects (set from `state` events)
}

export function emptyResultView(): ResultView {
  return { phase: null, scores: [], findings: [], sessionId: null };
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
      return view; // Runtime Delta Engine (§19A) — not emitted in M1
  }
}
