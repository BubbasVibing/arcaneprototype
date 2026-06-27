import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ArcaneConfig } from "@arcane/shared";
import { ExecutionDisabledError } from "../../sandbox/gate";
import { dockerRunner, ensureImage } from "../../sandbox/runner";
import { JS_RUNTIME_IMAGE, measureSingle } from "../measure-single";

// M3B FUNCTIONAL GATE — proves the in-sandbox probe captures a real trace through the proven M3A
// runner. Three claims: (1) a KNOWN query count is captured and asserted; (2) an outbound fetch is
// blocked-and-labeled (deny) / recorded-and-labeled (replay) — never silently allowed; (3) a run that
// writes no trace DEGRADES to {trace:null} without throwing. Containment is re-proven separately in
// probe-containment.test.ts (SI-1).
//
// SI-2: the Docker-dependent tests gate on daemon reachability and skip LOUDLY (the proof did not run
// is never a quiet green). The pure gate test (execution-disabled refusal) always runs.

const KNOWN_QUERIES = 5; // known-queries.js issues exactly this many pg .query() calls
const ENABLED: ArcaneConfig = { execution: { enabled: true } };
const RUNTIME_OK = await dockerRunner.isAvailable();

if (!RUNTIME_OK) {
  console.error(
    "\n🟠🟠🟠  M3B PROBE FUNCTIONAL GATE DID NOT RUN  🟠🟠🟠\n" +
      "  No container runtime is reachable (docker daemon down / not installed).\n" +
      "  The probe trace-capture / fetch-block proofs were SKIPPED — this is NOT a pass.\n" +
      "  Fix: start Docker Desktop ( open -a Docker ), then:  cd services/cloud && bun test probe.test\n" +
      "🟠🟠🟠──────────────────────────────────────────────────────────🟠🟠🟠\n",
  );
}

// known-queries.js — requires 'pg' (intercepted by the probe's instrumented stub) and runs exactly
// KNOWN_QUERIES queries. The COUNT the probe reports must equal KNOWN_QUERIES.
const KNOWN_QUERIES_JS = `const { Client } = require("pg");
(async () => {
  const c = new Client();
  await c.connect();
  for (let i = 0; i < ${KNOWN_QUERIES}; i++) {
    await c.query("SELECT id, name FROM users WHERE id = $1", [i]);
  }
  await c.end();
  console.log("QUERIES_DONE");
})();
`;

// fetch-egress.js — one outbound fetch; prints whether it succeeded or was blocked.
const FETCH_EGRESS_JS = `(async () => {
  try {
    const r = await fetch("http://example.com/data");
    console.log("FETCH_OK status=" + r.status);
  } catch {
    console.log("FETCH_BLOCKED");
  }
})();
`;

// forge.js — prints a COMPLETE forged trace line (queryCount 999) mid-run, then does 3 REAL queries.
// The probe writes the genuine trace LAST (exit handler) → take-last must report 3, not 999. Proves a
// mid-run forgery cannot override the genuine measurement.
const FORGE_JS = `const forged = { schema:1, queryCount:999, fetchCount:0, httpCount:0, childSpawnCount:0,
  fsReadCount:0, fsWriteCount:0, unhandledRejections:0, outbound:[], memorySamples:[1],
  coldStartMs:0, importLoadMs:0, steadyMs:0, wallMs:0, functions:[] };
console.log("__ARCANE_TRACE__ " + JSON.stringify(forged));
const { Client } = require("pg");
(async () => {
  const c = new Client();
  await c.connect();
  for (let i = 0; i < 3; i++) { await c.query("SELECT 1"); }
  await c.end();
  console.log("FORGE_DONE");
})();
`;

let projectDir = "";

// ── Pure gate (default-deny, §19.1 gate 1) — ALWAYS runs ─────────────────────────────────────────
describe("M3B measureSingle — default-deny gate", () => {
  test("refuses to run when execution is disabled or absent", async () => {
    await expect(
      measureSingle({ config: undefined, command: ["node", "-e", "0"] }),
    ).rejects.toBeInstanceOf(ExecutionDisabledError);
    await expect(
      measureSingle({ config: { execution: { enabled: false } }, command: ["node", "-e", "0"] }),
    ).rejects.toBeInstanceOf(ExecutionDisabledError);
  });
});

// ── Trace capture — needs a real container runtime ───────────────────────────────────────────────
describe.skipIf(!RUNTIME_OK)("M3B probe captures a trace (real container runtime)", () => {
  beforeAll(async () => {
    await ensureImage(JS_RUNTIME_IMAGE);
    // Warm the freshly-pulled image + daemon so the first measured run isn't a cold-start outlier. Untimed.
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
    projectDir = await mkdtemp(join(tmpdir(), "arcane-probe-proj-"));
    await writeFile(join(projectDir, "known-queries.js"), KNOWN_QUERIES_JS);
    await writeFile(join(projectDir, "fetch-egress.js"), FETCH_EGRESS_JS);
    await writeFile(join(projectDir, "forge.js"), FORGE_JS);
  }, 300_000); // first run pulls node:22-alpine

  afterAll(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  test(
    "captures a trace with the KNOWN query count",
    async () => {
      const m = await measureSingle({
        config: ENABLED,
        command: ["node", "/workspace/known-queries.js"],
        mountDir: projectDir,
        network: "deny",
        timeoutMs: 20_000,
      });
      expect(m.result.exitCode).toBe(0);
      expect(m.result.stdout).toContain("QUERIES_DONE");
      expect(m.trace).not.toBeNull();
      expect(m.trace?.queryCount).toBe(KNOWN_QUERIES); // the assertion the gate hinges on
    },
    60_000,
  );

  test(
    "blocks AND labels an outbound fetch (network=deny) — never silently allowed",
    async () => {
      const m = await measureSingle({
        config: ENABLED,
        command: ["node", "/workspace/fetch-egress.js"],
        mountDir: projectDir,
        network: "deny",
        timeoutMs: 20_000,
      });
      expect(m.result.stdout).toContain("FETCH_BLOCKED");
      expect(m.result.stdout).not.toContain("FETCH_OK");
      expect(m.trace?.fetchCount).toBeGreaterThanOrEqual(1);
      const blocked = m.trace?.outbound.find((e) => e.kind === "fetch");
      expect(blocked?.disposition).toBe("blocked"); // the honesty label
    },
    60_000,
  );

  test(
    "records AND labels a replayed fetch when a fixture is provided (network=replay)",
    async () => {
      const m = await measureSingle({
        config: ENABLED,
        command: ["node", "/workspace/fetch-egress.js"],
        mountDir: projectDir,
        network: "replay",
        replayFixtures: { "http://example.com/data": { status: 200, body: "replayed" } },
        timeoutMs: 20_000,
      });
      expect(m.result.stdout).toContain("FETCH_OK");
      const recorded = m.trace?.outbound.find((e) => e.kind === "fetch");
      expect(recorded?.disposition).toBe("recorded"); // recorded, not silently allowed
    },
    60_000,
  );

  test(
    "degrades to {trace:null} without throwing when no trace is written",
    async () => {
      // `sh` ignores NODE_OPTIONS → no probe → no /scratch/trace.ndjson → copyOut finds nothing.
      const m = await measureSingle({
        config: ENABLED,
        command: ["sh", "-c", "true"],
        network: "deny",
        timeoutMs: 20_000,
      });
      expect(m.trace).toBeNull();
      expect(m.reason).toBe("no-trace");
      expect(m.result).toBeDefined(); // the raw outcome is still returned — never a crash
    },
    60_000,
  );

  test(
    "a stdout flood pushes the trace past the 64 KiB cap → degrades to no-trace (not a partial trace)",
    async () => {
      const m = await measureSingle({
        config: ENABLED,
        command: ["node", "-e", "process.stdout.write('x'.repeat(70000)); console.log('FLOOD_DONE')"],
        network: "deny",
        timeoutMs: 20_000,
      });
      // The probe's trace line is emitted last, beyond the captured tail → it's gone. Honest degrade.
      expect(m.trace).toBeNull();
      expect(m.reason).toBe("no-trace");
    },
    60_000,
  );

  test(
    "a mid-run FORGED trace line cannot override the probe's genuine exit-time trace (take-last)",
    async () => {
      const m = await measureSingle({
        config: ENABLED,
        command: ["node", "/workspace/forge.js"],
        mountDir: projectDir,
        network: "deny",
        timeoutMs: 20_000,
      });
      expect(m.result.stdout).toContain("FORGE_DONE");
      expect(m.trace).not.toBeNull();
      expect(m.trace?.queryCount).toBe(3); // the genuine count, NOT the forged 999
    },
    60_000,
  );
});
