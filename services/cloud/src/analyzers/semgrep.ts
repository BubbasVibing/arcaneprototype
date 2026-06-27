import type { Finding, Severity } from "@arcane/shared";
import { probe } from "./capabilities";
import { runTool, toRepoRelative } from "./spawn";
import { findingId, type ProjectAnalyzer, type ProjectAnalyzerInput } from "./types";

// semgrep wrapper (M2B, dimension `security`). External CLI baked into the engine image; runs over the
// materialized shadow tree, emits JSON, normalized to Findings. Multi-language for free (semgrep
// covers ~30 languages), which is most of E2's "per-language" coverage with no per-language code.

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra?: { message?: string; severity?: string };
}

// semgrep severities → our scale. ERROR is a real bug/security issue; WARNING a smell; INFO a note.
function severityOf(raw: string | undefined): Severity {
  switch ((raw ?? "WARNING").toUpperCase()) {
    case "ERROR":
      return "high";
    case "INFO":
      return "low";
    default:
      return "medium";
  }
}

export const semgrepAnalyzer: ProjectAnalyzer = {
  name: "semgrep",
  dimension: "security",
  isAvailable: async () => (await probe("semgrep")).available,
  async analyze({ rootDir, signal }: ProjectAnalyzerInput): Promise<Finding[]> {
    // `--config auto` uses semgrep's curated registry rules; `--quiet --json` → machine output only.
    const { stdout } = await runTool(
      ["semgrep", "scan", "--json", "--quiet", "--config", "auto", "."],
      { cwd: rootDir, signal },
    );
    if (!stdout.trim()) return [];
    let parsed: { results?: SemgrepResult[] };
    try {
      parsed = JSON.parse(stdout) as { results?: SemgrepResult[] };
    } catch {
      return []; // non-JSON (e.g. an error banner) → nothing rather than a crash
    }
    return (parsed.results ?? []).map((r) => {
      const file = toRepoRelative(rootDir, r.path);
      const range = {
        startLine: r.start.line,
        startCol: r.start.col,
        endLine: r.end.line,
        endCol: r.end.col,
      };
      const ruleId = `semgrep/${r.check_id}`;
      return {
        id: findingId(ruleId, file, range),
        dimension: "security",
        severity: severityOf(r.extra?.severity),
        ruleId,
        message: r.extra?.message ?? r.check_id,
        file,
        range,
        fixable: false,
      } satisfies Finding;
    });
  },
};
