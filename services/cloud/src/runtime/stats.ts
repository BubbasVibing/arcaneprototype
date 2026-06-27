// M3C — robust statistics + the noise-suppression gate. PURE JS, no stats dependency (RULE 7), so it
// unit-tests with zero Docker. Technical-Spec §19A.3: the headline is the p95 DELTA, never the mean;
// variance is reported and a regression is suppressed unless it clears BOTH a magnitude threshold AND a
// robust variance band. The MEAN is computed only for completeness — it is never the headline.
//
// Robust by construction: center = MEDIAN, spread = MAD (median absolute deviation). Pairing a robust
// center with a robust spread keeps the variance-band test internally consistent for the skewed,
// outlier-prone latency distributions a container produces (a non-robust stdev band would over/under-
// react to a single slow run).

import type { SideStats } from "@arcane/shared";

// ── suppression-gate constants (§3 of the M3C plan; tunable, surfaced for review) ──────────────────
// A runtime/regression Finding emits only if the p95 delta clears BOTH of these AND the band test.
export const REL_THRESHOLD = 0.1; // p95 must rise ≥ 10% of baseline …
export const ABS_FLOOR_MS = 15; // … and ≥ 15 ms absolute. 15 (not 5): container run-to-run jitter +
//                                  the probe's integer-ms rounding put 5 ms below the noise floor.
export const MAD_OUTLIER_K = 3; // drop samples more than 3·MAD from the median
export const MIN_SURVIVORS = 3; // …but never below this many samples (else keep the side untouched)

function sortedAsc(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty sample");
  const s = sortedAsc(values);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Linear-interpolation percentile (R-7). HONESTY: at small n a high percentile is just an upper-order
// statistic (p99 of 15 samples ≈ the max) — `n` is reported alongside so the reader weights it.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of empty sample");
  if (values.length === 1) return values[0]!;
  const s = sortedAsc(values);
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;
  return lo + 1 < s.length ? s[lo]! + frac * (s[lo + 1]! - s[lo]!) : s[lo]!;
}

export function min(values: number[]): number {
  return Math.min(...values);
}

export function max(values: number[]): number {
  return Math.max(...values);
}

// Computed for completeness only — NEVER the headline (§19A.3 "median/p95/p99 — never the mean").
export function mean(values: number[]): number {
  if (values.length === 0) throw new Error("mean of empty sample");
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Sample standard deviation (Bessel's n−1). Reported alongside; fed to the confidence CV, NOT to the
// suppression band (the band uses MAD — see the module note). 0 for n < 2.
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Median Absolute Deviation (raw, unscaled): median(|x − median(x)|). The robust spread used by the
// variance band and outlier removal. Unscaled so "3·MAD" and "median ± MAD" read literally as in §3.
export function mad(values: number[]): number {
  if (values.length === 0) throw new Error("mad of empty sample");
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

// Coefficient of variation (stdev/median) — the variance signal that DROPS confidence as it rises.
// Returns 0 when there is no spread, Infinity when the median is 0 but spread exists (un-trustable).
export function cv(values: number[]): number {
  if (values.length === 0) return Infinity;
  const m = median(values);
  const sd = stdev(values);
  if (m === 0) return sd === 0 ? 0 : Infinity;
  return sd / m;
}

export interface OutlierResult {
  kept: number[];
  removed: number;
}

// Drop samples more than MAD_OUTLIER_K·MAD from the median, but NEVER below MIN_SURVIVORS — if removal
// would leave too few, keep the side untouched (honest: don't manufacture a clean distribution by over-
// trimming). When MAD is 0 (≥ half the samples identical) the spread is un-estimable → remove nothing.
export function removeOutliers(values: number[]): OutlierResult {
  if (values.length <= MIN_SURVIVORS) return { kept: [...values], removed: 0 };
  const spread = mad(values);
  if (spread === 0) return { kept: [...values], removed: 0 };
  const m = median(values);
  const kept = values.filter((v) => Math.abs(v - m) <= MAD_OUTLIER_K * spread);
  if (kept.length < MIN_SURVIVORS) return { kept: [...values], removed: 0 };
  return { kept, removed: values.length - kept.length };
}

// The per-side robust summary (§19A.3). No mean — the headline is the p95 delta.
export function summarize(values: number[]): SideStats {
  return {
    median: median(values),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    min: min(values),
    max: max(values),
    stdev: stdev(values),
    n: values.length,
  };
}

export interface GateInput {
  baselineP95: number;
  currentP95: number;
  baselineMedian: number;
  currentMedian: number;
  baselineMad: number;
  currentMad: number;
}

export interface GateResult {
  emit: boolean;
  p95Delta: number; // current − baseline (positive = current slower)
  p95DeltaPct: number | null; // vs baseline p95; null when baseline p95 is 0
  threshold: number; // the magnitude bar that had to be cleared
  magnitudePass: boolean; // gate (a)
  bandNonOverlap: boolean; // gate (b)
  reasons: string[]; // human-readable why-emit / why-not (honesty + summary)
}

// The dual-gate (§3). A runtime/regression Finding emits ONLY if BOTH hold:
//   (a) magnitude:  p95_current − p95_baseline ≥ max(REL·p95_baseline, ABS_FLOOR_MS)
//   (b) band:       (median_current − MAD_current) > (median_baseline + MAD_baseline)   [robust, non-overlapping]
// Either fails → no finding. This is what suppresses jitter on a genuine-but-perf-neutral code change;
// a whitespace no-op never reaches here (the source short-circuit in delta-engine handles that — the
// PROVABLE no-op owner). Pure decision logic over precomputed stats so it tests with plain numbers.
export function suppressionGate(g: GateInput): GateResult {
  const p95Delta = g.currentP95 - g.baselineP95;
  const p95DeltaPct = g.baselineP95 === 0 ? null : (p95Delta / g.baselineP95) * 100;
  const threshold = Math.max(REL_THRESHOLD * g.baselineP95, ABS_FLOOR_MS);
  const magnitudePass = p95Delta >= threshold;
  const bandNonOverlap = g.currentMedian - g.currentMad > g.baselineMedian + g.baselineMad;

  const reasons: string[] = [];
  reasons.push(
    magnitudePass
      ? `p95 delta ${p95Delta.toFixed(1)}ms ≥ threshold ${threshold.toFixed(1)}ms`
      : `p95 delta ${p95Delta.toFixed(1)}ms < threshold ${threshold.toFixed(1)}ms (within noise floor)`,
  );
  reasons.push(
    bandNonOverlap
      ? `variance bands non-overlapping (current ${(g.currentMedian - g.currentMad).toFixed(1)} > baseline ${(g.baselineMedian + g.baselineMad).toFixed(1)})`
      : `variance bands overlap (current ${(g.currentMedian - g.currentMad).toFixed(1)} ≤ baseline ${(g.baselineMedian + g.baselineMad).toFixed(1)})`,
  );
  return {
    emit: magnitudePass && bandNonOverlap,
    p95Delta,
    p95DeltaPct,
    threshold,
    magnitudePass,
    bandNonOverlap,
    reasons,
  };
}
