import { describe, expect, test } from "bun:test";
import { complexityAnalyzer, makeComplexityAnalyzer } from "../analyzers/complexity";

// 20 sequential `if` branches → cyclomatic ≈ 21 (> default 15).
function branchy(param: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  if (${param} === ${i}) return ${i};`).join(
    "\n",
  );
  return `${body}\n  return -1;`;
}

describe("complexity analyzer (dimension: complexity)", () => {
  test("a simple function produces no finding", () => {
    const findings = complexityAnalyzer.analyze({
      path: "a.ts",
      content: "export function add(a: number, b: number) { return a + b; }\n",
    });
    expect(findings).toEqual([]);
  });

  test("a deeply-branching function exceeds the default threshold", () => {
    const content = `export function pick(x: number) {\n${branchy("x", 20)}\n}\n`;
    const findings = complexityAnalyzer.analyze({ path: "pick.ts", content });
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.dimension).toBe("complexity");
    expect(f.ruleId).toBe("complexity/cyclomatic");
    expect(f.file).toBe("pick.ts");
    expect(f.range?.startLine).toBe(1);
    expect(Number(f.metadata?.cyclomatic)).toBeGreaterThan(15);
  });

  test("nested functions are scored independently (only the complex inner one flags)", () => {
    const inner = branchy("y", 20)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    const content = `export function outer() {\n  function inner(y: number) {\n${inner}\n  }\n  return inner;\n}\n`;
    const findings = complexityAnalyzer.analyze({ path: "n.ts", content });
    expect(findings.length).toBe(1);
    expect(findings[0]!.message).toContain("inner");
  });

  test("respects a custom max_cyclomatic", () => {
    const analyzer = makeComplexityAnalyzer(2);
    const content = "export function f(x: number) { if (x > 0) {} if (x < 0) {} return x; }\n";
    expect(analyzer.analyze({ path: "c.ts", content }).length).toBe(1); // complexity 3 > 2
  });

  test("handles only source files, not docs or declarations", () => {
    expect(complexityAnalyzer.handles("src/a.ts")).toBe(true);
    expect(complexityAnalyzer.handles("src/a.tsx")).toBe(true);
    expect(complexityAnalyzer.handles("README.md")).toBe(false);
    expect(complexityAnalyzer.handles("types.d.ts")).toBe(false);
  });
});
