import { describe, expect, it } from "vitest";
import type { RunReport } from "@arcane/shared";
import { attributionSummary, formatReportLines, metricSummary } from "../run/run-view";

// M3D-3 — the run view's pure line formatters (shared by the ink TTY view + the CI plain text). The
// load-bearing assertion: the n-plus-one advisory caveat is rendered (it must surface on the terminal,
// sourced from @arcane/shared's runtimeAdvisory — the same string the dashboard shows).

describe("metricSummary", () => {
  it("formats a metric with delta + percent", () => {
    expect(
      metricSummary({
        key: "latency_ms",
        unit: "ms",
        baseline: { median: 10, p95: 12, p99: 13, min: 9, max: 14, stdev: 1, n: 15 },
        current: { median: 18, p95: 22, p99: 24, min: 16, max: 26, stdev: 2, n: 15 },
        delta: 8,
        deltaPct: 80,
      }),
    ).toBe("latency_ms: 10 → 18 ms (Δ +8, +80%)");
  });

  it("omits percent when deltaPct is null", () => {
    expect(
      metricSummary({
        key: "queries",
        baseline: { median: 1, p95: 1, p99: 1, min: 1, max: 1, stdev: 0, n: 15 },
        current: { median: 11, p95: 11, p99: 11, min: 11, max: 11, stdev: 0, n: 15 },
        delta: 10,
        deltaPct: null,
      }),
    ).toBe("queries: 1 → 11 (Δ +10)");
  });
});

describe("attributionSummary", () => {
  it("includes rule, location, function, and evidence", () => {
    expect(
      attributionSummary({
        ruleId: "runtime/n-plus-one",
        file: "src/users.ts",
        functionName: "listUsers",
        range: { startLine: 42, startCol: 0, endLine: 50, endCol: 0 },
        confidence: "high",
        evidence: "queries 1 → 11 for the same workload",
      }),
    ).toBe("runtime/n-plus-one  src/users.ts · listUsers:42 — queries 1 → 11 for the same workload");
  });
});

describe("formatReportLines", () => {
  const nPlusOneReport: RunReport = {
    workload: "api-smoke",
    baselineRef: "main",
    currentRef: "working",
    confidence: "high",
    summary: "N+1 detected in listUsers.",
    status: "measured",
    metrics: [
      {
        key: "queries",
        baseline: { median: 1, p95: 1, p99: 1, min: 1, max: 1, stdev: 0, n: 15 },
        current: { median: 11, p95: 11, p99: 11, min: 11, max: 11, stdev: 0, n: 15 },
        delta: 10,
        deltaPct: null,
      },
    ],
    attribution: [
      {
        ruleId: "runtime/n-plus-one",
        file: "src/users.ts",
        functionName: "listUsers",
        confidence: "high",
        evidence: "queries 1 → 11",
      },
    ],
  };

  it("renders the n-plus-one advisory caveat (the integrity bound, surfaced on the terminal)", () => {
    const text = formatReportLines(nPlusOneReport).join("\n");
    expect(text).toContain("api-smoke");
    expect(text).toContain("confidence high");
    expect(text).toContain("queries: 1 → 11");
    expect(text).toContain("runtime/n-plus-one");
    expect(text).toMatch(/advisory:.*not tamper-proof/);
  });

  it("a no-data report says so honestly, with no metrics", () => {
    const lines = formatReportLines({
      workload: "w",
      baselineRef: "main",
      currentRef: "working",
      confidence: "low",
      summary: "No runtime data — no container runtime.",
      status: "no-data",
    });
    expect(lines[0]).toContain("NO DATA");
    expect(lines.join("\n")).toContain("No runtime data");
    expect(lines.join("\n")).not.toMatch(/advisory:/);
  });
});
