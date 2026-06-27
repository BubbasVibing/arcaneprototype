import { z } from "zod";
import { DimensionSchema, type Dimension } from "./dimension";

// The config↔analysis vocabulary bridge (plan M1C/D1). `arcane.toml` speaks COARSE categories
// (Requirements §4.1: `[score].weights`, `[analyzers].thresholds`, `[gate].gate_on`) while
// Findings/Scores and the analyzers speak the FINE-GRAINED `Dimension` enum (§5). The score engine
// forces a bridge between the two.
//
// This file is the SINGLE authority for that mapping (memory: one-authority-per-concern). The
// canonical direction is forward — `Dimension → Category` — a total function, because the score
// engine emits per-Dimension scores and must look up each dimension's category to find its weight
// or threshold. `Category → Dimension[]` is derived from it (`dimensionsIn`).

export const CategorySchema = z.enum(["quality", "security", "performance", "maintainability"]);
export type Category = z.infer<typeof CategorySchema>;

// Canonical forward map. `Record<Dimension, Category>` makes this total at compile time: every
// Dimension the enum (§5) defines must appear, or this file fails to type-check.
export const DIMENSION_CATEGORY: Record<Dimension, Category> = {
  complexity: "maintainability",
  deadcode: "maintainability",
  types: "maintainability",
  lint: "quality",
  tests: "quality",
  secrets: "security",
  security: "security",
  deps: "security",
  performance: "performance",
  concurrency: "performance",
};

export function categoryOf(dimension: Dimension): Category {
  return DIMENSION_CATEGORY[dimension];
}

// Derived reverse view: the dimensions that roll up into a coarse category.
export function dimensionsIn(category: Category): Dimension[] {
  return DimensionSchema.options.filter((d) => DIMENSION_CATEGORY[d] === category);
}
