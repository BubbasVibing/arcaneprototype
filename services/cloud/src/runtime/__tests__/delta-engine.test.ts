import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ArcaneConfig, ManifestFile } from "@arcane/shared";
import { ExecutionDisabledError } from "../../sandbox/gate";
import { dockerRunner, ensureImage } from "../../sandbox/runner";
import { DEFAULT_MEASURED, DEFAULT_WARMUP, runDelta } from "../delta-engine";
import { JS_RUNTIME_IMAGE } from "../measure-single";

// M3C GATE — the Runtime Delta Engine end-to-end. Two halves of the Done-when:
//   (a) N+1 fixture → query-count delta detected, attributed to the changed function, high confidence;
//   (b) whitespace no-op → the source short-circuit fires, ZERO containers, status "no-data", no finding.
// Half (b) and the gate/constants run PURE (always). Half (a) needs a real container runtime and
// skips LOUDLY if absent (SI-2 — a skip is NEVER a pass).

const ENABLED: ArcaneConfig = { execution: { enabled: true } };
const RUNTIME_OK = await dockerRunner.isAvailable();

if (!RUNTIME_OK) {
  console.error(
    "\n🔴🔴🔴  M3C RUNTIME DELTA GATE (N+1 detection) DID NOT RUN  🔴🔴🔴\n" +
      "  No container runtime is reachable (docker daemon down / not installed).\n" +
      "  The N+1 detect + attribute + confidence proof was SKIPPED — this is NOT a pass. M3C is NOT done\n" +
      "  until a real N+1 was measured in the sandbox and attributed to the changed function.\n" +
      "  Fix: start Docker Desktop ( open -a Docker ), then:  cd services/cloud && bun test delta-engine\n" +
      "🔴🔴🔴──────────────────────────────────────────────────────────🔴🔴🔴\n",
  );
}

function file(path: string, content: string, contentHash: string): ManifestFile {
  return { path, content, contentHash };
}

// ── N+1 fixture: baseline issues 1 query; current adds a per-id loop (the canonical N+1) ───────────
const NPLUS_BASE = `const { Client } = require("pg");
async function loadUsers(ids) {
  const c = new Client();
  await c.connect();
  const all = await c.query("SELECT * FROM users");
  await c.end();
  return all;
}
loadUsers([1, 2, 3, 4, 5]).then(() => console.log("DONE"));
`;
const NPLUS_CUR = `const { Client } = require("pg");
async function loadUsers(ids) {
  const c = new Client();
  await c.connect();
  const out = [];
  for (const id of ids) {
    out.push(await c.query("SELECT * FROM users WHERE id = $1", [id]));
  }
  await c.end();
  return out;
}
loadUsers([1, 2, 3, 4, 5]).then(() => console.log("DONE"));
`;

// ── No-op fixture: SAME tokens, different whitespace + a comment → provably no behavioral change ───
const NOOP_BASE = `const { Client } = require("pg");
async function f() { const c = new Client(); await c.connect(); await c.query("SELECT 1"); await c.end(); }
f();
`;
const NOOP_CUR = `const { Client } = require("pg");
// a harmless comment added by a formatter
async function f() {
  const c = new Client();
  await c.connect();
  await c.query("SELECT 1");
  await c.end();
}
f();
`;

// ── PURE — always runs (no Docker): gate, pinned defaults, and the PROVABLE no-op ─────────────────
describe("M3C runDelta — gate + provable no-op (always runs)", () => {
  test("default-deny: refuses when execution is disabled or absent", async () => {
    await expect(
      runDelta({
        config: undefined,
        runId: "m3c-gate-1",
        workload: "w",
        command: ["node", "/workspace/workload.js"],
        baselineRef: "base",
        currentRef: "cur",
        baselineFiles: [file("workload.js", NPLUS_BASE, "hb")],
        currentFiles: [file("workload.js", NPLUS_CUR, "hc")],
      }),
    ).rejects.toBeInstanceOf(ExecutionDisabledError);
  });

  test("pinned defaults — warmup 2, measured 15 (honest p95)", () => {
    expect(DEFAULT_WARMUP).toBe(2);
    expect(DEFAULT_MEASURED).toBe(15);
  });

  test("whitespace/comment-only change → short-circuit, ZERO containers, no finding", async () => {
    // The short-circuit precedes any container runtime use, so this passes WITHOUT Docker — and the
    // reason "no behavioral change" is produced ONLY by the short-circuit path (which calls no
    // measureSingle), so reaching it proves zero containers ran.
    const res = await runDelta({
      config: ENABLED,
      runId: "m3c-noop-1",
      workload: "noop",
      command: ["node", "/workspace/workload.js"],
      baselineRef: "base",
      currentRef: "cur",
      baselineFiles: [file("workload.js", NOOP_BASE, "hb")],
      currentFiles: [file("workload.js", NOOP_CUR, "hc")],
    });
    expect(res.report.status).toBe("no-data");
    expect(res.report.skipped?.[0]).toBe("no behavioral change");
    expect(res.findings).toHaveLength(0);
  });
});

// ── DOCKER-GATED — the N+1 detection proof (real container runtime) ───────────────────────────────
describe.skipIf(!RUNTIME_OK)("M3C runDelta — N+1 detection (real container runtime)", () => {
  beforeAll(async () => {
    await ensureImage(JS_RUNTIME_IMAGE);
    // Warm the image/daemon so the first measured round isn't a cold-start outlier. Untimed.
    await dockerRunner.run({
      image: JS_RUNTIME_IMAGE,
      command: ["node", "-e", "0"],
      timeoutMs: 120_000,
      memBytes: 128 * 1024 * 1024,
      cpus: 1,
      pidsLimit: 64,
      network: "deny",
      scratchBytes: 16 * 1024 * 1024,
    });
  }, 300_000);

  test(
    "detects the N+1, attributes it to the changed function, high confidence",
    async () => {
      const res = await runDelta({
        config: ENABLED,
        runId: "m3c-nplus-1",
        workload: "loadUsers",
        command: ["node", "/workspace/workload.js"],
        baselineRef: "origin/main",
        currentRef: "working",
        baselineFiles: [file("workload.js", NPLUS_BASE, "hb")],
        currentFiles: [file("workload.js", NPLUS_CUR, "hc")],
        network: "deny",
        timeoutMs: 20_000,
        warmup: 2,
        measured: 8, // queryCount is deterministic — 8 measured proves detection/attribution/determinism
      });

      expect(res.report.status).toBe("measured");
      expect(res.report.confidence).toBe("high");

      // the query-count delta: baseline 1 query → current 5 (one per id) → Δ4
      const queries = res.report.metrics?.find((m) => m.key === "queries");
      expect(queries?.baseline.median).toBe(1);
      expect(queries?.current.median).toBe(5);
      expect(queries?.delta).toBe(4);

      // the N+1 finding, attributed to the changed function `loadUsers`, high confidence
      const nplus = res.findings.find((f) => f.ruleId === "runtime/n-plus-one");
      expect(nplus).toBeDefined();
      expect(nplus?.dimension).toBe("performance");
      expect(nplus?.file).toBe("workload.js");
      expect(nplus?.metadata?.functionName).toBe("loadUsers");
      expect(nplus?.metadata?.confidence).toBe("high");
      expect(nplus?.message).toContain("loadUsers");

      // the latency gate must NOT false-positive on the N+1 (the stub returns instantly)
      expect(res.findings.some((f) => f.ruleId === "runtime/regression")).toBe(false);
    },
    180_000,
  );
});
