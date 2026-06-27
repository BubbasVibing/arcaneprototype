import { describe, expect, test } from "bun:test";
import { escapeHatchAnalyzer } from "../analyzers/escape-hatch";

function rules(content: string): string[] {
  return escapeHatchAnalyzer.analyze({ path: "a.ts", content }).map((f) => f.ruleId);
}

describe("escape-hatch analyzer (dimension: types)", () => {
  test("flags the `any` type", () => {
    const findings = escapeHatchAnalyzer.analyze({ path: "a.ts", content: "const x: any = 1;\n" });
    expect(findings.length).toBe(1);
    expect(findings[0]!.dimension).toBe("types");
    expect(findings[0]!.ruleId).toBe("escape-hatch/no-any");
  });

  test("flags an `as` assertion but not `as const`", () => {
    expect(rules('const y = z as Foo;\n')).toContain("escape-hatch/no-as");
    expect(rules('const y = [1, 2] as const;\n')).not.toContain("escape-hatch/no-as");
  });

  test("flags @ts-ignore / @ts-expect-error / @ts-nocheck directives", () => {
    expect(rules("// @ts-ignore\nconst a = b;\n")).toContain("escape-hatch/ts-ignore");
    expect(rules("// @ts-expect-error\nconst a = b;\n")).toContain("escape-hatch/ts-expect-error");
    expect(rules("// @ts-nocheck\n")).toContain("escape-hatch/ts-nocheck");
  });

  test("clean typed code produces no findings", () => {
    expect(rules("export const add = (a: number, b: number): number => a + b;\n")).toEqual([]);
  });

  test("handles TS files only", () => {
    expect(escapeHatchAnalyzer.handles("a.ts")).toBe(true);
    expect(escapeHatchAnalyzer.handles("a.tsx")).toBe(true);
    expect(escapeHatchAnalyzer.handles("a.md")).toBe(false);
    expect(escapeHatchAnalyzer.handles("a.d.ts")).toBe(false);
  });
});
