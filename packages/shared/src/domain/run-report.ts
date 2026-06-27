import { z } from "zod";

// PLACEHOLDER — Technical-Spec §19A / engine milestone M3.
// The real Runtime Delta Engine report shape is defined when `arcane run --compare` lands (§19A.6
// is a textual sample, not a pinned schema). This minimal object exists only so ResultEvent's
// `run` kind (§3B.2) is part of the locked wire contract NOW. No invented detail fields;
// `.passthrough()` lets the richer M3 payload flow through without a breaking change.
export const RunReportSchema = z
  .object({
    workload: z.string(),
    baselineRef: z.string(),
    currentRef: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
    summary: z.string(),
  })
  .passthrough();
export type RunReport = z.infer<typeof RunReportSchema>;
