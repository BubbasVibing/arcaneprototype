import { z } from "zod";

// Technical-Spec §5 — the analyzer/finding dimensions (fine-grained).
export const DimensionSchema = z.enum([
  "complexity",
  "deadcode",
  "lint",
  "security",
  "secrets",
  "deps",
  "types",
  "performance",
  "concurrency",
  "tests",
]);

export type Dimension = z.infer<typeof DimensionSchema>;
