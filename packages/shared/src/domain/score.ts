import { z } from "zod";
import { DimensionSchema } from "./dimension";

// Technical-Spec §6 — per-dimension score (0–100) + delta vs the previous snapshot.
export const ScoreSchema = z.object({
  dimension: DimensionSchema,
  value: z.number().min(0).max(100),
  delta: z.number(),
});
export type Score = z.infer<typeof ScoreSchema>;

// Aggregate health read-out (Build Guide D0 lists Score/HealthScore). Minimal for now;
// not emitted in Session 0.
export const HealthScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  dimensions: z.array(ScoreSchema),
});
export type HealthScore = z.infer<typeof HealthScoreSchema>;
