import { describe, expect, test } from "bun:test";
import { secretsAnalyzer } from "../analyzers/secrets";

function analyze(content: string, path = "config.ts") {
  return secretsAnalyzer.analyze({ path, content });
}

describe("secrets analyzer (dimension: secrets)", () => {
  test("flags an AWS access key id as critical", () => {
    const findings = analyze('const k = "AKIAIOSFODNN7EXAMPLE";\n');
    expect(findings.length).toBe(1);
    expect(findings[0]!.dimension).toBe("secrets");
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.ruleId).toBe("secrets/aws-access-key-id");
    // never echoes the secret value
    expect(findings[0]!.message).not.toContain("AKIA");
  });

  test("flags a generic hardcoded credential assignment", () => {
    const findings = analyze('const apiKey = "s3cr3t-value-123";\n');
    expect(findings.map((f) => f.ruleId)).toContain("secrets/generic-assignment");
    expect(findings[0]!.severity).toBe("high");
  });

  test("flags a private key block", () => {
    expect(analyze("-----BEGIN OPENSSH PRIVATE KEY-----\n").map((f) => f.ruleId)).toContain(
      "secrets/private-key",
    );
  });

  test("clean code produces no findings", () => {
    expect(analyze("export const greeting = 'hello world';\n")).toEqual([]);
  });

  test("records the line of the match", () => {
    const findings = analyze('const ok = 1;\nconst leak = "AKIAIOSFODNN7EXAMPLE";\n');
    expect(findings[0]!.range?.startLine).toBe(2);
  });

  test("skips binary assets", () => {
    expect(secretsAnalyzer.handles("logo.png")).toBe(false);
    expect(secretsAnalyzer.handles("src/config.ts")).toBe(true);
    expect(secretsAnalyzer.handles("README.md")).toBe(true);
  });
});
