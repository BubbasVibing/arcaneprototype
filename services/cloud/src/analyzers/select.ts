import type { ArcaneConfig, Dimension } from "@arcane/shared";
import { makeComplexityAnalyzer } from "./complexity";
import { escapeHatchAnalyzer } from "./escape-hatch";
import { gitleaksAnalyzer } from "./gitleaks";
import { osvAnalyzer } from "./osv";
import { secretsAnalyzer } from "./secrets";
import { semgrepAnalyzer } from "./semgrep";
import type { Analyzer, ProjectAnalyzer } from "./types";

// Config-driven analyzer selection (M2B). Honors `[analyzers].enabled/disabled` + per-analyzer config
// from the uploaded arcane.toml. With no config, the Product-Requirements §4.1 default set applies.

export const DEFAULT_ENABLED = ["complexity", "escape-hatch", "semgrep", "knip", "gitleaks", "osv"];

// Per-file analyzers don't carry a `dimension` on their interface; map by name for `coveredDimensions`.
const PERFILE_DIMENSION: Record<string, Dimension> = {
  complexity: "complexity",
  "escape-hatch": "types",
  secrets: "secrets",
};

export interface SelectedAnalyzers {
  perFile: Analyzer[];
  project: ProjectAnalyzer[];
}

export function selectAnalyzers(config?: ArcaneConfig): SelectedAnalyzers {
  const enabled = new Set(config?.analyzers?.enabled ?? DEFAULT_ENABLED);
  const disabled = new Set(config?.analyzers?.disabled ?? []);
  const on = (name: string): boolean => enabled.has(name) && !disabled.has(name);

  const perFile: Analyzer[] = [];
  if (on("complexity")) perFile.push(makeComplexityAnalyzer(config?.analyzers?.complexity?.max_cyclomatic));
  if (on("escape-hatch")) perFile.push(escapeHatchAnalyzer);
  // The pure-JS secrets analyzer is the FLOOR for the `secrets` dimension — included whenever secrets
  // coverage is desired, directly or via gitleaks. When gitleaks is available the pipeline's
  // project-dimension replace rule supersedes these; when it's absent these stand (graceful fallback,
  // so secrets coverage never zeroes out — the §4.1 default enables gitleaks, not secrets).
  if (on("secrets") || on("gitleaks")) perFile.push(secretsAnalyzer);

  const project: ProjectAnalyzer[] = [];
  if (on("semgrep")) project.push(semgrepAnalyzer);
  if (on("gitleaks")) project.push(gitleaksAnalyzer);
  if (on("osv")) project.push(osvAnalyzer);
  // `knip` is in the §4.1 default but deferred (it needs an installed node_modules the shadow tree
  // lacks) — silently skipped here until it's wired.

  return { perFile, project };
}

// The dimensions to force a score bar for (even at 100), computed PER FRAME from the selected per-file
// analyzers + the AVAILABLE project analyzers. A dimension whose only source is an unavailable tool is
// excluded, so we never show a false "100" for something we couldn't analyze (invariant 8).
export function coveredDimensions(
  perFile: Analyzer[],
  availableProject: ProjectAnalyzer[],
): Dimension[] {
  const dims = new Set<Dimension>();
  for (const a of perFile) {
    const d = PERFILE_DIMENSION[a.name];
    if (d) dims.add(d);
  }
  for (const a of availableProject) dims.add(a.dimension);
  return [...dims];
}
