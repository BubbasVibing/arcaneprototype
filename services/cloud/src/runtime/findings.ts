// M3C — translate a measured RunReport into wire Findings (§5) on the `performance` dimension. Each
// emitted finding corresponds to one attribution entry the engine recorded (an N+1, a latency
// regression, or a non-termination); the measured numbers live in report.metrics. A no-data report
// yields ZERO findings (honesty: no measurement → no finding, never a fabricated "clean" result).

import type { Finding, RunMetric, RunReport, Severity } from "@arcane/shared";
import { findingId } from "../analyzers/types";
import { RULE_N_PLUS_ONE } from "./attribute";
import { METRIC_LATENCY, METRIC_QUERIES } from "./report";

export const RULE_REGRESSION = "runtime/regression";
export const RULE_NON_TERMINATION = "runtime/non-termination";

export function findingsFromReport(report: RunReport): Finding[] {
  if (report.status !== "measured") return []; // no-data / skipped → no findings
  const metrics = report.metrics ?? [];
  const out: Finding[] = [];
  for (const a of report.attribution ?? []) {
    out.push({
      id: findingId(a.ruleId, a.file, a.range),
      dimension: "performance",
      severity: severityFor(a.ruleId, metrics),
      ruleId: a.ruleId,
      message: messageFor(a.ruleId, a.functionName ?? a.file, metrics),
      file: a.file,
      range: a.range,
      metadata: {
        confidence: a.confidence,
        evidence: a.evidence,
        functionName: a.functionName,
        // M3D integrity bound: queryCount rides an in-process probe the workload could forge, so the N+1
        // finding is ADVISORY — honest under the trusted-workload assumption, NOT a tamper-proof claim.
        // The tamper-resistant out-of-process observer lands with multi-tenant auth (see trace.ts).
        ...(a.ruleId === RULE_N_PLUS_ONE
          ? {
              advisory:
                "queryCount is self-reported by the workload (in-process probe) under the trusted-workload assumption — not tamper-proof",
            }
          : {}),
      },
    });
  }
  return out;
}

function metricByKey(metrics: RunMetric[], key: string): RunMetric | undefined {
  return metrics.find((m) => m.key === key);
}

// Severity = how BAD (impact magnitude), kept distinct from confidence = how SURE (carried in metadata).
function severityFor(ruleId: string, metrics: RunMetric[]): Severity {
  if (ruleId === RULE_NON_TERMINATION) return "high"; // it didn't finish — always serious
  if (ruleId === RULE_N_PLUS_ONE) {
    const d = metricByKey(metrics, METRIC_QUERIES)?.delta ?? 0;
    return d >= 10 ? "high" : d >= 3 ? "medium" : "low";
  }
  if (ruleId === RULE_REGRESSION) {
    const pct = metricByKey(metrics, METRIC_LATENCY)?.deltaPct ?? 0;
    return pct >= 50 ? "high" : pct >= 20 ? "medium" : "low";
  }
  return "low";
}

function messageFor(ruleId: string, where: string, metrics: RunMetric[]): string {
  if (ruleId === RULE_N_PLUS_ONE) {
    const q = metricByKey(metrics, METRIC_QUERIES);
    return `N+1 query pattern in ${where}: queries ${fmt(q?.baseline.median)} → ${fmt(q?.current.median)} (Δ${fmt(q?.delta)}) for the same workload`;
  }
  if (ruleId === RULE_REGRESSION) {
    const l = metricByKey(metrics, METRIC_LATENCY);
    const pct = l?.deltaPct;
    return `Measured p95 rose ${pct != null ? `${pct.toFixed(0)}%` : "?"} in ${where} (${fmt(l?.baseline.p95)}ms → ${fmt(l?.current.p95)}ms)`;
  }
  if (ruleId === RULE_NON_TERMINATION) {
    return `Non-termination: ${where} exceeded the time budget on current but not baseline`;
  }
  return `Runtime finding in ${where}`;
}

function fmt(n: number | undefined): string {
  return n === undefined ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(1);
}
