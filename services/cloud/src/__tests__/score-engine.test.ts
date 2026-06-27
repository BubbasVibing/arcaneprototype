import { describe, expect, test } from "bun:test";
import type { Dimension, Finding } from "@arcane/shared";
import { liveFindingKey } from "../analyzers/types";
import { scoreSnapshot } from "../score-engine";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "x",
    dimension: "complexity",
    severity: "medium",
    ruleId: "complexity/cyclomatic",
    message: "m",
    file: "a.ts",
    range: { startLine: 1, startCol: 1, endLine: 2, endCol: 1 },
    fixable: false,
    ...over,
  };
}

const COVERED: Dimension[] = ["complexity"];

describe("score engine (Technical-Spec §6)", () => {
  test("a clean snapshot scores covered dimensions at 100 with delta 0", () => {
    const { scores, findings } = scoreSnapshot([], new Map(), new Set(), COVERED);
    expect(findings).toEqual([]);
    expect(scores).toEqual([{ dimension: "complexity", value: 100, delta: 0 }]);
  });

  test("subtracts the documented severity weights", () => {
    const fs = [
      finding({ severity: "critical" }),
      finding({ severity: "high", range: { startLine: 9, startCol: 1, endLine: 10, endCol: 1 } }),
    ];
    const { scores } = scoreSnapshot(fs, new Map(), new Set(), COVERED);
    expect(scores[0]!.value).toBe(55); // 100 - 30 - 15
  });

  test("clamps the score at 0", () => {
    const fs = [0, 20, 40, 60].map((startLine) =>
      finding({ severity: "critical", range: { startLine, startCol: 1, endLine: startLine + 1, endCol: 1 } }),
    );
    const { scores } = scoreSnapshot(fs, new Map(), new Set(), COVERED); // 100 - 120 → 0
    expect(scores[0]!.value).toBe(0);
  });

  test("delta is relative to the parent snapshot's score", () => {
    const { scores } = scoreSnapshot([finding()], new Map([["complexity", 100]]), new Set(), COVERED);
    expect(scores[0]!.delta).toBe(-6); // 94 - 100
  });

  test("is_new flags findings whose key was absent from the parent", () => {
    const f = finding();
    const fresh = scoreSnapshot([f], new Map(), new Set(), COVERED);
    expect(fresh.findings[0]!.isNew).toBe(true);

    const carried = scoreSnapshot([f], new Map(), new Set([liveFindingKey(f)]), COVERED);
    expect(carried.findings[0]!.isNew).toBe(false);
  });

  test("emits a bar for any dimension that has findings, even if not in `covered`", () => {
    const sec = finding({ dimension: "secrets", severity: "critical" });
    const { scores } = scoreSnapshot([sec], new Map(), new Set(), COVERED);
    const dims = scores.map((s) => s.dimension).sort();
    expect(dims).toEqual(["complexity", "secrets"]); // complexity@100 (covered) + secrets@70
    expect(scores.find((s) => s.dimension === "secrets")!.value).toBe(70);
  });
});
