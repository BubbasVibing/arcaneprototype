import { describe, expect, it } from "vitest";
import { FindingSchema, type Finding } from "../index";

// M4 provenance contract (Product-Requirements §5.6 honesty boundary): `source` distinguishes a
// MEASURED analyzer finding from a JUDGED AI finding. Optional + absent ⇒ analyzer, so all existing
// deterministic findings stay valid unchanged.
describe("Finding.source (M4 provenance)", () => {
  const base = {
    id: "f1",
    dimension: "security",
    severity: "high",
    ruleId: "r",
    message: "m",
    file: "a.ts",
  } as const;

  it("absent source is valid (⇒ analyzer/deterministic)", () => {
    const parsed = FindingSchema.parse({ ...base });
    expect(parsed.source).toBeUndefined();
  });

  it("accepts and round-trips source: 'ai'", () => {
    const f: Finding = { ...base, source: "ai" };
    expect(FindingSchema.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("accepts source: 'analyzer'", () => {
    expect(FindingSchema.parse({ ...base, source: "analyzer" }).source).toBe("analyzer");
  });

  it("rejects an unknown source", () => {
    expect(() => FindingSchema.parse({ ...base, source: "human" })).toThrow();
  });
});
