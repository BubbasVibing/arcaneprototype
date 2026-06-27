import { z } from "zod";
import { DimensionSchema } from "./dimension";

// Technical-Spec §5 / §3B.2 — Metric (numeric companion to findings; e.g. complexity max,
// queries/req). Part of the locked Lane D contract even though Session 0 emits none yet.
export const MetricSchema = z.object({
  dimension: DimensionSchema,
  key: z.string(),
  value: z.number(),
  unit: z.string().optional(),
});
export type Metric = z.infer<typeof MetricSchema>;
