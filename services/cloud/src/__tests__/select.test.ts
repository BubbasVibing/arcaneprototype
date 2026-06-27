import { describe, expect, test } from "bun:test";
import type { ArcaneConfig } from "@arcane/shared";
import { coveredDimensions, selectAnalyzers } from "../analyzers";
import type { ProjectAnalyzer } from "../analyzers/types";

// M2B config-driven selection + dynamic covered. Unconditional (no external tool needed).

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe("selectAnalyzers", () => {
  test("default config (§4.1) selects the pure-JS floor + the three external project analyzers", () => {
    const { perFile, project } = selectAnalyzers(undefined);
    // secrets is the floor (default enables gitleaks, not secrets) so coverage never zeroes out.
    expect(names(perFile).sort()).toEqual(["complexity", "escape-hatch", "secrets"]);
    expect(names(project).sort()).toEqual(["gitleaks", "osv", "semgrep"]);
  });

  test("honors explicit enabled (only what's listed)", () => {
    const cfg = { analyzers: { enabled: ["complexity"] } } as ArcaneConfig;
    const { perFile, project } = selectAnalyzers(cfg);
    expect(names(perFile)).toEqual(["complexity"]);
    expect(project).toHaveLength(0);
  });

  test("honors disabled over the default set", () => {
    const cfg = { analyzers: { disabled: ["semgrep", "osv"] } } as ArcaneConfig;
    const { project } = selectAnalyzers(cfg);
    expect(names(project)).toEqual(["gitleaks"]);
  });
});

describe("coveredDimensions", () => {
  test("excludes a dimension whose only source is an unavailable project tool", () => {
    const { perFile } = selectAnalyzers(undefined);
    // No project analyzers available → only the per-file dimensions get a forced bar.
    expect(coveredDimensions(perFile, []).sort()).toEqual(["complexity", "secrets", "types"]);
  });

  test("includes an available project analyzer's dimension", () => {
    const { perFile, project } = selectAnalyzers(undefined);
    const semgrep = project.find((p) => p.name === "semgrep") as ProjectAnalyzer;
    expect(coveredDimensions(perFile, [semgrep]).sort()).toEqual([
      "complexity",
      "secrets",
      "security",
      "types",
    ]);
  });
});
