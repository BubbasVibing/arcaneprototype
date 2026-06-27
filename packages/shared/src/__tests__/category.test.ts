import { describe, expect, it } from "vitest";
import {
  ArcaneConfigSchema,
  categoryOf,
  CategorySchema,
  DIMENSION_CATEGORY,
  DimensionSchema,
  dimensionsIn,
} from "../index";

describe("Dimension → Category bridge (M1C/D1)", () => {
  it("maps every Dimension to a Category (total function)", () => {
    for (const dim of DimensionSchema.options) {
      expect(CategorySchema.options).toContain(DIMENSION_CATEGORY[dim]);
      expect(categoryOf(dim)).toBe(DIMENSION_CATEGORY[dim]);
    }
  });

  it("places the M1C analyzer dimensions in the expected categories", () => {
    expect(categoryOf("complexity")).toBe("maintainability");
    expect(categoryOf("types")).toBe("maintainability"); // escape-hatch findings carry `types`
    expect(categoryOf("secrets")).toBe("security");
  });

  it("dimensionsIn is the inverse view of the forward map", () => {
    for (const cat of CategorySchema.options) {
      for (const dim of dimensionsIn(cat)) expect(categoryOf(dim)).toBe(cat);
    }
    // Every dimension belongs to exactly one category, so the partition covers all of them.
    const partitioned = CategorySchema.options.flatMap(dimensionsIn).sort();
    expect(partitioned).toEqual([...DimensionSchema.options].sort());
  });
});

describe("ArcaneConfig tightened to the Category vocabulary (M1C/D1)", () => {
  it("accepts the four coarse categories in weights/thresholds/gate_on", () => {
    const cfg = ArcaneConfigSchema.parse({
      score: { weights: { quality: 1.0, security: 1.5, performance: 1.0, maintainability: 1.0 } },
      analyzers: { thresholds: { quality: 70 } },
      gate: { gate_on: ["security", "performance"] },
    });
    expect(cfg.score?.weights?.security).toBe(1.5);
    expect(cfg.gate?.gate_on).toEqual(["security", "performance"]);
  });

  it("rejects a fine-grained Dimension where a Category is required", () => {
    expect(() => ArcaneConfigSchema.parse({ score: { weights: { complexity: 1.0 } } })).toThrow();
    expect(() => ArcaneConfigSchema.parse({ gate: { gate_on: ["complexity"] } })).toThrow();
  });
});
