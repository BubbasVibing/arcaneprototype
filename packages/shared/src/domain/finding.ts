import { z } from "zod";
import { DimensionSchema } from "./dimension";

// Technical-Spec §5 — Finding (produced server-side; rendered in the terminal + web).

export const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const RangeSchema = z.object({
  startLine: z.number().int(),
  startCol: z.number().int(),
  endLine: z.number().int(),
  endCol: z.number().int(),
});
export type Range = z.infer<typeof RangeSchema>;

// fixable?: 'deterministic' | 'codemod' | 'llm' | false
export const FixableSchema = z.union([
  z.enum(["deterministic", "codemod", "llm"]),
  z.literal(false),
]);
export type Fixable = z.infer<typeof FixableSchema>;

export const FindingSchema = z.object({
  id: z.string(), // stable hash(ruleId + file + range)
  dimension: DimensionSchema,
  severity: SeveritySchema,
  ruleId: z.string(),
  message: z.string(),
  file: z.string(),
  range: RangeSchema.optional(),
  fixable: FixableSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
