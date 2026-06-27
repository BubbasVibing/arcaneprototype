import type { RunReport } from "./run-report";

// M3D-3 — cross-lane truths about a RunReport that BOTH the CLI run view and the web dashboard need.
// They live in @arcane/shared so there is ONE home for each (no normative string or predicate
// duplicated across the cloud, the CLI, and the dashboard — they would drift).

// The advisory caveat attached to a runtime finding (§19A integrity bound). Keyed by attribution
// `ruleId`. Today only the N+1 rule carries one: queryCount rides an in-process probe the workload
// could forge, so the signal is honest under the trusted-workload assumption but NOT tamper-proof
// (the out-of-process observer lands with multi-tenant auth — see services/cloud trace.ts). The key
// MUST match the cloud's RULE_N_PLUS_ONE ("runtime/n-plus-one"). The cloud's findingsFromReport and
// both run views call this, so the text has a single source.
const RUNTIME_ADVISORIES: Record<string, string> = {
  "runtime/n-plus-one":
    "queryCount is self-reported by the workload (in-process probe) under the trusted-workload assumption — not tamper-proof",
};

export function runtimeAdvisory(ruleId: string): string | undefined {
  return RUNTIME_ADVISORIES[ruleId];
}

// A run signals a regression when it was actually MEASURED and the engine attributed ≥1 runtime
// finding (runtime/regression | runtime/n-plus-one | runtime/non-termination). One definition shared
// by the CLI's regression exit code and the dashboard's pass/fail badge. A "no-data" run is NOT a
// regression — the absence of measurement is stated honestly (§16.15), never failed as if clean.
export function hasRuntimeRegression(report: RunReport): boolean {
  return report.status === "measured" && (report.attribution?.length ?? 0) > 0;
}
