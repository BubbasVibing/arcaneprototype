import { describe, expect, test } from "bun:test";
import type { ArcaneConfig, Finding } from "@arcane/shared";
import { runProjectAnalyzers } from "../analyzers";
import { probe, resetCapabilities } from "../analyzers/capabilities";
import type { ProjectAnalyzer, ProjectAnalyzerInput } from "../analyzers/types";

// M2B graceful-degrade proof — runs WITHOUT any external tool installed. Covers the capability probe
// (absent bin → unavailable, never throws) and the project-analyzer dispatch (unavailable skipped,
// throwing isolated, available contributes).

const input = (): ProjectAnalyzerInput => ({
  rootDir: "/tmp/nope",
  files: [],
  changedPaths: [],
  config: {} as ArcaneConfig,
  signal: new AbortController().signal,
});

const finding = (dimension: Finding["dimension"], ruleId: string): Finding => ({
  id: ruleId,
  dimension,
  severity: "medium",
  ruleId,
  message: "m",
  file: "a",
});

function fake(
  name: string,
  dimension: Finding["dimension"],
  opts: { available: boolean; throws?: boolean; findings?: Finding[] },
): ProjectAnalyzer {
  return {
    name,
    dimension,
    isAvailable: async () => opts.available,
    analyze: async () => {
      if (opts.throws) throw new Error("boom");
      return opts.findings ?? [];
    },
  };
}

describe("capability probe", () => {
  test("an absent binary probes as unavailable and never throws", async () => {
    resetCapabilities();
    const cap = await probe("arcane-definitely-not-a-real-tool-xyz");
    expect(cap.available).toBe(false);
    expect(cap.version).toBeUndefined();
  });
});

describe("runProjectAnalyzers dispatch", () => {
  test("skips unavailable, isolates throwers, returns available findings", async () => {
    const f = finding("security", "semgrep/x");
    const analyzers = [
      fake("available", "security", { available: true, findings: [f] }),
      fake("unavailable", "deps", { available: false, findings: [finding("deps", "osv/y")] }),
      fake("thrower", "secrets", { available: true, throws: true }),
    ];
    const out = await runProjectAnalyzers(analyzers, input());
    expect(out).toEqual([f]); // only the available, non-throwing analyzer contributed
  });

  test("an unavailable tool contributes nothing rather than crashing the pass", async () => {
    const out = await runProjectAnalyzers(
      [fake("semgrep", "security", { available: false })],
      input(),
    );
    expect(out).toEqual([]);
  });
});
