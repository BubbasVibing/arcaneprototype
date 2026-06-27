import type { Finding } from "@arcane/shared";
import { complexityAnalyzer } from "./complexity";
import { escapeHatchAnalyzer } from "./escape-hatch";
import { secretsAnalyzer } from "./secrets";
import type { Analyzer, AnalyzerInput, ProjectAnalyzer, ProjectAnalyzerInput } from "./types";

// Analyzer registry. The pure-JS per-file (Tier-0) set: complexity + escape-hatch + secrets. M2B adds
// async whole-tree (Tier-1) ProjectAnalyzers (semgrep/gitleaks/osv) selected by config — see
// ./select. `selectAnalyzers` is the config-driven entry point; ANALYZERS is the unconfigured default.
export const ANALYZERS: Analyzer[] = [complexityAnalyzer, escapeHatchAnalyzer, secretsAnalyzer];

// Run every applicable per-file analyzer over the changed files. A throwing analyzer is logged and
// skipped — one bad file never sinks the whole pass.
export function runAnalyzers(files: AnalyzerInput[], analyzers: Analyzer[] = ANALYZERS): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    for (const analyzer of analyzers) {
      if (!analyzer.handles(file.path)) continue;
      try {
        out.push(...analyzer.analyze(file));
      } catch (err) {
        console.error(`analyzer ${analyzer.name} failed on ${file.path}:`, (err as Error).message);
      }
    }
  }
  return out;
}

// Run the available project (Tier-1) analyzers over the whole shadow tree. Each is capability-probed;
// an unavailable tool is skipped (no findings) and a throwing wrapper is logged and skipped — same
// failure isolation as runAnalyzers, so one bad tool never sinks the pass.
export async function runProjectAnalyzers(
  analyzers: ProjectAnalyzer[],
  input: ProjectAnalyzerInput,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const a of analyzers) {
    try {
      if (!(await a.isAvailable())) continue;
      out.push(...(await a.analyze(input)));
    } catch (err) {
      console.error(`project analyzer ${a.name} failed:`, (err as Error).message);
    }
  }
  return out;
}

export { coveredDimensions, DEFAULT_ENABLED, selectAnalyzers } from "./select";
export type { SelectedAnalyzers } from "./select";
export type { Analyzer, AnalyzerInput, ProjectAnalyzer, ProjectAnalyzerInput } from "./types";
