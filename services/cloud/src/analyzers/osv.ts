import type { Finding, Severity } from "@arcane/shared";
import { probe } from "./capabilities";
import { runTool, toRepoRelative } from "./spawn";
import { findingId, type ProjectAnalyzer, type ProjectAnalyzerInput } from "./types";

// osv-scanner wrapper (M2B, dimension `deps`). Scans materialized lockfiles in the shadow tree for
// known-vulnerable dependencies. A lockfile that exceeded the inline cap (recorded by hash only, not
// written to disk) simply isn't found → no findings (guarded by "did any lockfile materialize?").

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "requirements.txt",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

interface OsvVuln {
  id: string;
  summary?: string;
  database_specific?: { severity?: string };
}
interface OsvPackage {
  package: { name: string; version: string; ecosystem?: string };
  vulnerabilities?: OsvVuln[];
}
interface OsvSource {
  source: { path: string };
  packages?: OsvPackage[];
}

function severityOf(raw: string | undefined): Severity {
  switch ((raw ?? "").toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "high"; // a vulnerable dependency with unknown severity is still serious
  }
}

export const osvAnalyzer: ProjectAnalyzer = {
  name: "osv",
  dimension: "deps",
  isAvailable: async () => (await probe("osv-scanner", ["--version"])).available,
  async analyze({ rootDir, files, signal }: ProjectAnalyzerInput): Promise<Finding[]> {
    // Guard: nothing to scan unless a recognized lockfile actually materialized in the shadow tree.
    const hasLockfile = files.some((p) => LOCKFILES.has(p.split("/").pop() ?? ""));
    if (!hasLockfile) return [];

    // osv-scanner exits non-zero when vulnerabilities are found — parse stdout regardless.
    const { stdout } = await runTool(["osv-scanner", "--format", "json", "-r", "."], {
      cwd: rootDir,
      signal,
    });
    if (!stdout.trim()) return [];
    let parsed: { results?: OsvSource[] };
    try {
      parsed = JSON.parse(stdout) as { results?: OsvSource[] };
    } catch {
      return [];
    }

    const out: Finding[] = [];
    for (const result of parsed.results ?? []) {
      const file = toRepoRelative(rootDir, result.source.path);
      for (const pkg of result.packages ?? []) {
        for (const vuln of pkg.vulnerabilities ?? []) {
          const ruleId = `osv/${vuln.id}`;
          out.push({
            id: findingId(ruleId, file),
            dimension: "deps",
            severity: severityOf(vuln.database_specific?.severity),
            ruleId,
            message:
              vuln.summary?.trim() ||
              `${pkg.package.name}@${pkg.package.version} is affected by ${vuln.id}`,
            file,
            fixable: false,
            metadata: {
              package: pkg.package.name,
              version: pkg.package.version,
              ecosystem: pkg.package.ecosystem,
            },
          });
        }
      }
    }
    return out;
  },
};
