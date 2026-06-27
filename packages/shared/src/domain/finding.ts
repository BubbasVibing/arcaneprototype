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

// M4 (AI judgment) provenance. `source` distinguishes a finding an analyzer MEASURED from one the AI
// JUDGED — a load-bearing honesty boundary (Product-Requirements §5.6): an AI finding must be visibly
// distinct on every surface and must never move the measured 0–100 score (it's advisory). OPTIONAL and
// absent ⇒ "analyzer": every existing deterministic finding + persisted row stays valid with no change.
// The cloud score engine excludes `source: 'ai'` from scoring; the TUI + dashboard badge it distinctly.
export const FindingSourceSchema = z.enum(["analyzer", "ai"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const FindingSchema = z.object({
  id: z.string(), // stable hash(ruleId + file + range)
  dimension: DimensionSchema,
  severity: SeveritySchema,
  ruleId: z.string(),
  message: z.string(),
  file: z.string(),
  range: RangeSchema.optional(),
  fixable: FixableSchema.optional(),
  // M4: provenance. Absent ⇒ 'analyzer' (deterministic, measured). 'ai' ⇒ judged, advisory, score-exempt.
  source: FindingSourceSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
