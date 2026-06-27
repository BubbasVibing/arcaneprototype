import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ArcaneConfig } from "@arcane/shared";
import { probe } from "../analyzers/capabilities";
import { gitleaksAnalyzer } from "../analyzers/gitleaks";
import { osvAnalyzer } from "../analyzers/osv";
import { semgrepAnalyzer } from "../analyzers/semgrep";
import type { ProjectAnalyzerInput } from "../analyzers/types";

// M2B external-analyzer proofs. The CLIs are baked into the engine IMAGE, not installed in a dev box,
// so these are GATED on a capability probe and skip-loud when the tool is absent (the same pattern as
// the DB-gated full-stack proofs). When present they run against a real defect in a temp shadow dir.

const HAS_SEMGREP = (await probe("semgrep")).available;
const HAS_GITLEAKS = (await probe("gitleaks")).available;
const HAS_OSV = (await probe("osv-scanner")).available;

if (!HAS_SEMGREP || !HAS_GITLEAKS || !HAS_OSV) {
  const missing = [
    !HAS_SEMGREP && "semgrep",
    !HAS_GITLEAKS && "gitleaks",
    !HAS_OSV && "osv-scanner",
  ].filter(Boolean);
  console.warn(
    `\n⚠️  external-analyzer proofs SKIPPED for: ${missing.join(", ")} (not installed on this box).\n` +
      "    This is the graceful-degrade path — the wrappers return [] and never crash. The capability\n" +
      "    + dispatch + dynamic-covered tests still run unconditionally. CI's engine image has the tools.\n",
  );
}

const mkInput = (rootDir: string, files: string[]): ProjectAnalyzerInput => ({
  rootDir,
  files,
  changedPaths: files,
  config: {} as ArcaneConfig,
  signal: new AbortController().signal,
});

describe("external analyzers (skip-loud when the tool is absent)", () => {
  test.skipIf(!HAS_GITLEAKS)("gitleaks flags a hardcoded secret WITHOUT echoing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcane-gitleaks-"));
    try {
      writeFileSync(join(dir, "config.js"), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
      const out = await gitleaksAnalyzer.analyze(mkInput(dir, ["config.js"]));
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((f) => f.dimension === "secrets")).toBe(true);
      expect(out.every((f) => f.ruleId.startsWith("gitleaks/"))).toBe(true);
      expect(out.every((f) => !f.message.includes("AKIAIOSFODNN7EXAMPLE"))).toBe(true); // never echo
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_SEMGREP)("semgrep returns well-formed security findings and never crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcane-semgrep-"));
    try {
      writeFileSync(join(dir, "app.js"), 'app.get("/x", (req, res) => { eval(req.query.cmd); });\n');
      const out = await semgrepAnalyzer.analyze(mkInput(dir, ["app.js"]));
      expect(Array.isArray(out)).toBe(true);
      for (const f of out) {
        expect(f.dimension).toBe("security");
        expect(f.ruleId.startsWith("semgrep/")).toBe(true);
        expect(f.range).toBeDefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_OSV)("osv-scanner returns well-formed deps findings and never crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcane-osv-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0", dependencies: { lodash: "4.17.0" } }),
      );
      writeFileSync(
        join(dir, "package-lock.json"),
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "x", version: "1.0.0", dependencies: { lodash: "4.17.0" } },
            "node_modules/lodash": { version: "4.17.0" },
          },
        }),
      );
      const out = await osvAnalyzer.analyze(mkInput(dir, ["package.json", "package-lock.json"]));
      expect(Array.isArray(out)).toBe(true);
      for (const f of out) {
        expect(f.dimension).toBe("deps");
        expect(f.ruleId.startsWith("osv/")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
