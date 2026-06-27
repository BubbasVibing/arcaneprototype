// M3C — assemble the wire-bound RunReport (Technical-Spec §19A.6) from the engine's measured samples.
// Honesty rule (§16.15): the report states a MEASURED delta WITH confidence — never a false-precise
// "runtime is slower", never a fabricated number. A run that could not be measured is status:"no-data"
// with NO metrics and NO findings — the absence of data is reported as itself, never as "0 / clean".

import type { Confidence, RunAttribution, RunMetric, RunReport } from "@arcane/shared";
import { cv, summarize } from "./stats";

export const METRIC_LATENCY = "latency_ms";
export const METRIC_QUERIES = "queries";

// One metric, both sides + delta. The headline delta is on p95 (never the mean). For the deterministic
// `queries` metric every sample is equal, so its p95/median collapse to the constant count — the delta
// is then exactly currentQ − baselineQ.
export function buildMetric(
  key: string,
  unit: string | undefined,
  baseline: number[],
  current: number[],
  headline = false,
): RunMetric {
  const b = summarize(baseline);
  const c = summarize(current);
  const delta = c.p95 - b.p95;
  const deltaPct = b.p95 === 0 ? null : (delta / b.p95) * 100;
  return { key, unit, baseline: b, current: c, delta, deltaPct, headline: headline || undefined };
}

export interface ConfidenceInputs {
  measuredBothSides: boolean; // false ⇒ a side fully degraded (no usable samples)
  baselineLatency: number[];
  currentLatency: number[];
  latencyFallback: boolean; // used wallMs instead of steadyMs (cold/import noise included)
}

// Confidence in the LATENCY measurement, dropping automatically as variance rises (§19A.5). N+1
// (deterministic queryCount) carries its OWN confidence from attribution — this is only the latency
// half. High requires both sides cleanly measured at low variance; it falls to low on high CV, a
// fallback timing, too few samples, or a degraded side.
export function latencyConfidence(i: ConfidenceInputs): Confidence {
  if (!i.measuredBothSides) return "low";
  const minN = Math.min(i.baselineLatency.length, i.currentLatency.length);
  if (minN < 3) return "low";
  if (i.latencyFallback) return "low";
  const worstCv = Math.max(cv(i.baselineLatency), cv(i.currentLatency));
  if (worstCv > 0.35) return "low";
  if (worstCv <= 0.15) return "high";
  return "medium";
}

export interface AssembleParams {
  workload: string;
  baselineRef: string;
  currentRef: string;
  status: "measured" | "no-data";
  confidence: Confidence;
  warmupPerSide?: number;
  runsPerSide?: number;
  outliersRemoved?: number;
  metrics?: RunMetric[];
  attribution?: RunAttribution[];
  skipped?: string[];
  summary?: string;
}

export function assembleRunReport(p: AssembleParams): RunReport {
  return {
    workload: p.workload,
    baselineRef: p.baselineRef,
    currentRef: p.currentRef,
    confidence: p.confidence,
    summary: p.summary ?? defaultSummary(p),
    status: p.status,
    schedule: p.status === "measured" ? "alternating-counterbalanced" : undefined,
    warmupPerSide: p.warmupPerSide,
    runsPerSide: p.runsPerSide,
    outliersRemoved: p.outliersRemoved,
    metrics: p.metrics,
    attribution: p.attribution,
    skipped: p.skipped,
  };
}

function defaultSummary(p: AssembleParams): string {
  if (p.status === "no-data") {
    return `No runtime data${p.skipped?.length ? ` — ${p.skipped[0]}` : ""}.`;
  }
  const headline = p.metrics?.find((m) => m.headline) ?? p.metrics?.[0];
  const ruleIds = [...new Set((p.attribution ?? []).map((a) => a.ruleId))].join(", ");
  if (p.attribution && p.attribution.length > 0) {
    const h = headline
      ? ` Headline p95 ${headline.baseline.p95.toFixed(1)}→${headline.current.p95.toFixed(1)}ms` +
        `${headline.deltaPct != null ? ` (${headline.deltaPct.toFixed(0)}%)` : ""}.`
      : "";
    return `${p.attribution.length} performance finding(s) [${ruleIds}], confidence ${p.confidence}.${h}`;
  }
  return `Measured ${p.runsPerSide ?? "?"}×2 alternating runs; p95 delta within the noise band — no regression. Confidence ${p.confidence}.`;
}
