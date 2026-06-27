import { describe, expect, it } from "vitest";
import type { ResultEvent } from "../index";
import { applyResultEvent, emptyResultView } from "../index";

// Pins the shared reducer used by BOTH the terminal and the web dashboard (M1D/M3D). The semantics must
// match tui/store.ts: `analyzing` clears findings (new frame), `score` upserts per dimension (never
// cleared), `finding` accumulates, `state` sets phase + sessionId, `run` stores the latest RunReport.

const SID = "00000000-0000-0000-0000-0000000000a1";

function finding(id: string, dimension: "complexity" | "types" | "secrets") {
  return {
    id,
    dimension,
    severity: "high" as const,
    ruleId: `${dimension}/rule`,
    message: "m",
    file: "a.ts",
  };
}

const reduce = (events: ResultEvent[]) => events.reduce(applyResultEvent, emptyResultView());

describe("applyResultEvent (shared TUI/web reducer)", () => {
  it("starts empty", () => {
    const v = emptyResultView();
    expect(v).toEqual({ phase: null, scores: [], findings: [], sessionId: null, run: null });
  });

  it("reduces one full frame: analyzing → findings → scores → results → done", () => {
    const v = reduce([
      { kind: "state", sessionId: SID, phase: "analyzing" },
      { kind: "finding", isNew: true, finding: finding("f1", "complexity") },
      { kind: "finding", isNew: false, finding: finding("f2", "types") },
      { kind: "score", dimension: "types", value: 80, delta: -20 },
      { kind: "score", dimension: "complexity", value: 90, delta: -10 },
      { kind: "state", sessionId: SID, phase: "results" },
      { kind: "state", sessionId: SID, phase: "done" },
    ]);
    expect(v.phase).toBe("done");
    expect(v.sessionId).toBe(SID);
    expect(v.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(v.findings[0]?.isNew).toBe(true);
    // scores sorted by dimension (complexity before types)
    expect(v.scores).toEqual([
      { dimension: "complexity", value: 90, delta: -10 },
      { dimension: "types", value: 80, delta: -20 },
    ]);
  });

  it("`analyzing` opens a fresh frame: clears findings, KEEPS scores", () => {
    const frame1: ResultEvent[] = [
      { kind: "state", sessionId: SID, phase: "analyzing" },
      { kind: "finding", isNew: true, finding: finding("f1", "complexity") },
      { kind: "score", dimension: "complexity", value: 70, delta: -30 },
      { kind: "state", sessionId: SID, phase: "done" },
    ];
    const afterFrame1 = reduce(frame1);
    expect(afterFrame1.findings).toHaveLength(1);

    // Frame 2: the new analyzing clears findings; the prior score persists until re-emitted.
    const afterAnalyzing2 = applyResultEvent(afterFrame1, {
      kind: "state",
      sessionId: SID,
      phase: "analyzing",
    });
    expect(afterAnalyzing2.findings).toEqual([]); // cleared
    expect(afterAnalyzing2.scores).toHaveLength(1); // kept

    // A new score for the same dimension replaces in place (upsert).
    const afterScore2 = applyResultEvent(afterAnalyzing2, {
      kind: "score",
      dimension: "complexity",
      value: 100,
      delta: 30,
    });
    expect(afterScore2.scores).toEqual([{ dimension: "complexity", value: 100, delta: 30 }]);
  });

  it("`run` stores the latest RunReport (M3D live run view)", () => {
    const before = reduce([{ kind: "state", sessionId: SID, phase: "done" }]);
    const report = {
      workload: "w",
      baselineRef: "origin/main",
      currentRef: "working-tree",
      confidence: "high" as const,
      summary: "s",
    };
    const after = applyResultEvent(before, { kind: "run", report, runId: "r1" });
    expect(after.run).toEqual(report);
    // other view fields are untouched
    expect(after.phase).toBe(before.phase);
    expect(after.findings).toEqual(before.findings);
  });

  it("does not mutate the input view (immutability)", () => {
    const before = emptyResultView();
    applyResultEvent(before, { kind: "finding", isNew: true, finding: finding("f1", "complexity") });
    expect(before.findings).toEqual([]);
  });
});
