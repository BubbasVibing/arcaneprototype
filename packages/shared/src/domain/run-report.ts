import { z } from "zod";
import { RangeSchema } from "./finding";

// Technical-Spec §19A — the Runtime Delta Engine report (the `run` kind of ResultEvent, §3B.2).
// The five base fields below are the locked wire contract; M3C enriches the report ADDITIVELY (every
// new field is OPTIONAL, and `.passthrough()` already tolerated extras) so older consumers keep working
// and a richer payload flows through without a breaking change. The raw single-side telemetry
// (`TraceSample`) stays cloud-internal — only this assembled, confidence-scored report crosses the wire.

// Confidence rides on EVERY result (§19A.5). It DROPS automatically as variance rises; it is never a
// false-precise certainty (§16.15 honesty rule). Shared by the report headline and each attribution.
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Robust per-side summary (§19A.3): median/p95/p99/min/max/stdev over the kept samples. The MEAN is
// deliberately absent — the headline is the p95 delta, never the mean. `n` = samples kept after warmup
// discard + outlier removal, so a reader can judge how much to trust a percentile at small n.
export const SideStatsSchema = z.object({
  median: z.number(),
  p95: z.number(),
  p99: z.number(),
  min: z.number(),
  max: z.number(),
  stdev: z.number(),
  n: z.number().int(),
});
export type SideStats = z.infer<typeof SideStatsSchema>;

// One measured metric, both sides + the delta. `headline` marks the metric whose delta is THE headline
// (latency p95). `deltaPct` is null when a percentage is meaningless (e.g. a zero baseline).
export const RunMetricSchema = z.object({
  key: z.string(), // e.g. "latency_ms" | "queries"
  unit: z.string().optional(),
  baseline: SideStatsSchema,
  current: SideStatsSchema,
  delta: z.number(),
  deltaPct: z.number().nullable(),
  headline: z.boolean().optional(),
});
export type RunMetric = z.infer<typeof RunMetricSchema>;

// Layer-3 attribution (§19A.1) — supporting evidence only, never the headline. Names the changed
// file/function a delta is attributed to, with its own confidence and a one-line evidence string.
export const RunAttributionSchema = z.object({
  ruleId: z.string(), // runtime/n-plus-one | runtime/regression | runtime/non-termination
  file: z.string(),
  functionName: z.string().optional(),
  range: RangeSchema.optional(),
  confidence: ConfidenceSchema,
  evidence: z.string(),
});
export type RunAttribution = z.infer<typeof RunAttributionSchema>;

export const RunReportSchema = z
  .object({
    // ── locked base contract (Session 0) ──────────────────────────────────────────────────────────
    workload: z.string(),
    baselineRef: z.string(),
    currentRef: z.string(),
    confidence: ConfidenceSchema,
    summary: z.string(),

    // ── M3C additive enrichment (all OPTIONAL; passthrough already tolerated extras) ───────────────
    // Honesty (§16.15): "no-data" is reported as itself, NEVER as "0 / clean". A run that could not be
    // measured (a side unmeasurable, determinism failed, no container runtime) is status:"no-data" and
    // carries NO findings — the absence of a number is stated, not faked.
    status: z.enum(["measured", "no-data"]).optional(),
    runsPerSide: z.number().int().optional(), // measured samples KEPT per side
    warmupPerSide: z.number().int().optional(), // warmup samples discarded per side
    outliersRemoved: z.number().int().optional(),
    schedule: z.literal("alternating-counterbalanced").optional(),
    metrics: z.array(RunMetricSchema).optional(),
    attribution: z.array(RunAttributionSchema).optional(),
    skipped: z.array(z.string()).optional(), // honest list of what could not be measured + why
  })
  .passthrough();
export type RunReport = z.infer<typeof RunReportSchema>;
