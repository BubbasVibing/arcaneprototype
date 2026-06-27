import type { Dimension, Finding } from "@arcane/shared";
import { complexityAnalyzer } from "./complexity";
import { escapeHatchAnalyzer } from "./escape-hatch";
import { secretsAnalyzer } from "./secrets";
import type { Analyzer, AnalyzerInput } from "./types";

// Analyzer registry (plan M1C). The full M1 set: complexity (C1) + escape-hatch + secrets (C2).
export const ANALYZERS: Analyzer[] = [complexityAnalyzer, escapeHatchAnalyzer, secretsAnalyzer];

// Dimensions the registered analyzers can produce. The score engine always emits a bar for these
// (even at 100), so a clean dimension still shows rather than vanishing.
export const COVERED_DIMENSIONS: Dimension[] = ["complexity", "types", "secrets"];

// Run every applicable analyzer over the given changed files. A throwing analyzer is logged and
// skipped — one bad file never sinks the whole analysis pass.
export function runAnalyzers(files: AnalyzerInput[]): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    for (const analyzer of ANALYZERS) {
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

export type { Analyzer, AnalyzerInput } from "./types";
