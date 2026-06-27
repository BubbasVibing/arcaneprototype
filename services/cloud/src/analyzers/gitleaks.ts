import type { Finding, Severity } from "@arcane/shared";
import { probe } from "./capabilities";
import { runTool, toRepoRelative } from "./spawn";
import { findingId, type ProjectAnalyzer, type ProjectAnalyzerInput } from "./types";

// gitleaks wrapper (M2B, dimension `secrets`). Runs over the materialized shadow directory (no git
// history needed). When gitleaks is UNAVAILABLE the pure-JS secrets analyzer stays the floor (wired in
// ./select) so secrets coverage never zeroes out; when gitleaks IS available the pipeline's
// project-dimension replace rule lets these findings supersede the JS ones (no double count).
//
// NEVER echo the matched secret value (mirrors the JS analyzer's "label only" rule).

interface GitleaksFinding {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine?: number;
  EndLine?: number;
  StartColumn?: number;
  EndColumn?: number;
}

// gitleaks gives no severity. Key material (private keys, cloud creds) is critical; the rest high.
function severityOf(ruleId: string): Severity {
  return /private[-_]?key|aws|gcp|azure|secret[-_]?key/i.test(ruleId) ? "critical" : "high";
}

export const gitleaksAnalyzer: ProjectAnalyzer = {
  name: "gitleaks",
  dimension: "secrets",
  isAvailable: async () => (await probe("gitleaks")).available,
  async analyze({ rootDir, signal }: ProjectAnalyzerInput): Promise<Finding[]> {
    // gitleaks exits non-zero when leaks are found — parse stdout regardless of the code.
    const { stdout } = await runTool(
      ["gitleaks", "detect", "--no-git", "--source", ".", "-f", "json", "-r", "/dev/stdout", "--no-banner"],
      { cwd: rootDir, signal },
    );
    if (!stdout.trim()) return [];
    let parsed: GitleaksFinding[];
    try {
      parsed = JSON.parse(stdout) as GitleaksFinding[];
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((g) => {
      const file = toRepoRelative(rootDir, g.File);
      const range = {
        startLine: g.StartLine ?? 1,
        startCol: g.StartColumn ?? 1,
        endLine: g.EndLine ?? g.StartLine ?? 1,
        endCol: g.EndColumn ?? 1,
      };
      const ruleId = `gitleaks/${g.RuleID}`;
      return {
        id: findingId(ruleId, file, range),
        dimension: "secrets",
        severity: severityOf(g.RuleID),
        ruleId,
        // Label only — never the secret value.
        message: g.Description?.trim() || `potential secret (${g.RuleID})`,
        file,
        range,
        fixable: false,
      } satisfies Finding;
    });
  },
};
