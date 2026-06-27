import { describe, expect, it } from "vitest";
import { hasRuntimeRegression, runtimeAdvisory, type RunReport } from "../index";

// M3D-3 — the shared run-report truths the CLI run view + the dashboard both render. Pinning the
// caveat text and the regression predicate here keeps them from drifting between lanes.

describe("runtimeAdvisory", () => {
  it("returns the N+1 caveat (verbatim, matches the cloud's prior literal)", () => {
    expect(runtimeAdvisory("runtime/n-plus-one")).toBe(
      "queryCount is self-reported by the workload (in-process probe) under the trusted-workload assumption — not tamper-proof",
    );
  });

  it("returns undefined for rules without an advisory", () => {
    expect(runtimeAdvisory("runtime/regression")).toBeUndefined();
    expect(runtimeAdvisory("runtime/non-termination")).toBeUndefined();
    expect(runtimeAdvisory("anything-else")).toBeUndefined();
  });
});

describe("hasRuntimeRegression", () => {
  const base: RunReport = {
    workload: "w",
    baselineRef: "main",
    currentRef: "working",
    confidence: "medium",
    summary: "s",
  };

  it("is true for a measured run with ≥1 attribution", () => {
    expect(
      hasRuntimeRegression({
        ...base,
        status: "measured",
        attribution: [
          { ruleId: "runtime/n-plus-one", file: "a.ts", confidence: "high", evidence: "e" },
        ],
      }),
    ).toBe(true);
  });

  it("is false for a measured run with no attribution (clean)", () => {
    expect(hasRuntimeRegression({ ...base, status: "measured", attribution: [] })).toBe(false);
    expect(hasRuntimeRegression({ ...base, status: "measured" })).toBe(false);
  });

  it("is false for a no-data run even if attribution somehow present (honesty: not a regression)", () => {
    expect(
      hasRuntimeRegression({
        ...base,
        status: "no-data",
        attribution: [{ ruleId: "runtime/regression", file: "a.ts", confidence: "low", evidence: "e" }],
      }),
    ).toBe(false);
  });

  it("is false when status is absent (no measurement claimed)", () => {
    expect(hasRuntimeRegression(base)).toBe(false);
  });
});
