import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertExecutionAllowed, ExecutionDisabledError } from "../gate";
import { dockerRunner, ensureImage, selectSandboxRunner } from "../runner";
import type { SandboxSpec } from "../spec";

// M3A ISOLATION ESCAPE SUITE — the proof the milestone hinges on. Adversarial workloads try to break
// out (network egress, writing/reading the host FS, a runaway loop, a memory bomb, a fork storm); each
// MUST be contained by the container alone. The Done-when gate ("isolation holds") is met only when
// this runs GREEN on a real container runtime.
//
// SI-1: every test below runs with NO in-process probe (none exists in M3A). That IS the proof that
// containment does not depend on in-process patching. When M3B adds a probe, this suite MUST re-run
// with the probe disabled and still pass.
// SI-2: a silently-skipped isolation test is the most dangerous silent skip in the system. If no
// runtime is reachable we skip — but LOUDLY (below), and M3A is NOT "done" on a skipped suite.

const IMAGE = "alpine:3";
const SECRET = "ARCANE_HOST_SECRET_d3adb33f"; // sentinel that must never be readable from a sandbox

// Daemon reachability gates the escape tests (the gate + microVM-refusal tests are pure and always run).
const RUNTIME_OK = await dockerRunner.isAvailable();

if (!RUNTIME_OK) {
  console.error(
    "\n🔴🔴🔴  M3A ISOLATION ESCAPE SUITE DID NOT RUN  🔴🔴🔴\n" +
      "  No container runtime is reachable (docker daemon down / not installed).\n" +
      "  THIS IS THE MOST DANGEROUS SILENT SKIP IN THE SYSTEM — 'skipped' here must NEVER be read as\n" +
      "  'isolation proven'. M3A is NOT done until adversarial code tried to escape and could not.\n" +
      "  Fix: start Docker Desktop ( open -a Docker ), then:  cd services/cloud && bun test escape\n" +
      "🔴🔴🔴──────────────────────────────────────────────────────────🔴🔴🔴\n",
  );
}

let projectDir = ""; // a read-only project mount
let secretDir = ""; // a host dir that is NEVER mounted — must be invisible inside the sandbox
let secretPath = "";

function spec(partial: Partial<SandboxSpec> & Pick<SandboxSpec, "command">): SandboxSpec {
  return {
    image: IMAGE,
    timeoutMs: 5_000,
    memBytes: 128 * 1024 * 1024,
    cpus: 1,
    pidsLimit: 64,
    network: "deny",
    scratchBytes: 16 * 1024 * 1024,
    ...partial,
  };
}

// ── Gate (default-deny, §19.1 gate 1) — pure, ALWAYS runs ────────────────────────────────────────
describe("M3A execution gate — nothing runs without consent", () => {
  test("refuses when execution is disabled or absent", () => {
    expect(() => assertExecutionAllowed(undefined)).toThrow(ExecutionDisabledError);
    expect(() => assertExecutionAllowed({})).toThrow(ExecutionDisabledError);
    expect(() => assertExecutionAllowed({ execution: { enabled: false } })).toThrow(
      ExecutionDisabledError,
    );
  });

  test("allows only when explicitly enabled", () => {
    expect(() => assertExecutionAllowed({ execution: { enabled: true } })).not.toThrow();
  });
});

// ── SI-3: microVM is refused (asserted-by-interface, not proven here) — pure, ALWAYS runs ─────────
describe("M3A backend selection — microVM is not silently treated as safe", () => {
  test("container backend is selected by default and when requested", () => {
    expect(selectSandboxRunner(undefined).backend).toBe("container");
    expect(selectSandboxRunner({ execution: { enabled: true, isolation: "container" } }).backend).toBe(
      "container",
    );
  });

  test("microVM backend is refused until proven on a KVM host", () => {
    expect(() => selectSandboxRunner({ execution: { enabled: true, isolation: "microvm" } })).toThrow(
      /not proven/i,
    );
  });
});

// ── Isolation escape suite — needs a real container runtime ───────────────────────────────────────
describe.skipIf(!RUNTIME_OK)("M3A sandbox isolation holds (real container runtime)", () => {
  beforeAll(async () => {
    await ensureImage(IMAGE);
    projectDir = await mkdtemp(join(tmpdir(), "arcane-sbx-proj-"));
    await writeFile(join(projectDir, "canary.txt"), "original\n");
    secretDir = await mkdtemp(join(tmpdir(), "arcane-sbx-secret-"));
    secretPath = join(secretDir, "secret.txt");
    await writeFile(secretPath, `${SECRET}\n`);
  }, 180_000); // first run may pull the image

  afterAll(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (secretDir) await rm(secretDir, { recursive: true, force: true });
  });

  test(
    "baseline: a benign workload runs and exits cleanly (no probe present — SI-1)",
    async () => {
      const r = await dockerRunner.run(spec({ command: ["sh", "-c", "echo hello-sandbox"] }));
      expect(r.exitCode).toBe(0);
      expect(r.killReason).toBeNull();
      expect(r.stdout).toContain("hello-sandbox");
    },
    30_000,
  );

  test(
    "network egress is blocked (--network none)",
    async () => {
      const r = await dockerRunner.run(
        spec({
          // busybox wget; with no network even DNS/route fails. It must NOT succeed.
          command: ["sh", "-c", "wget -T 3 -q -O - http://1.1.1.1/ 2>&1; echo EXIT=$?"],
          timeoutMs: 12_000,
        }),
      );
      expect(r.stdout).toContain("EXIT=");
      expect(r.stdout).not.toMatch(/EXIT=0\b/); // any zero exit = egress succeeded = ESCAPE
    },
    30_000,
  );

  test(
    "the project mount is read-only — writes are denied and the host file is untouched",
    async () => {
      const r = await dockerRunner.run(
        spec({
          mountDir: projectDir,
          command: ["sh", "-c", "echo pwned > /workspace/canary.txt 2>&1; echo EXIT=$?"],
        }),
      );
      expect(r.stdout).not.toMatch(/EXIT=0\b/); // write must fail
      expect(await readFile(join(projectDir, "canary.txt"), "utf8")).toBe("original\n"); // host intact
    },
    30_000,
  );

  test(
    "host filesystem outside the mount is invisible (no path traversal to host secrets)",
    async () => {
      const r = await dockerRunner.run(
        spec({
          mountDir: projectDir,
          // An absolute HOST path that was never mounted simply does not exist inside the container.
          command: ["sh", "-c", `cat ${secretPath} 2>&1; echo EXIT=$?`],
        }),
      );
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stdout).not.toMatch(/EXIT=0\b/);
    },
    30_000,
  );

  test(
    "an infinite loop is killed by the watchdog (SIGKILL on timeout)",
    async () => {
      const t0 = Date.now();
      const r = await dockerRunner.run(
        spec({ command: ["sh", "-c", "while true; do :; done"], timeoutMs: 2_000 }),
      );
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(20_000); // it did NOT hang the host
    },
    30_000,
  );

  test(
    "a memory bomb is contained by the cap (OOM-killed, host unharmed)",
    async () => {
      const r = await dockerRunner.run(
        spec({
          // Capture ~512 MiB into a shell var under a 128 MiB cap (no swap) → kernel OOM-kills it.
          command: ["sh", "-c", "X=$(yes | head -c 536870912); echo SURVIVED"],
          memBytes: 128 * 1024 * 1024,
          timeoutMs: 20_000,
        }),
      );
      expect(r.timedOut).toBe(false);
      // Contained: OOM-flagged or killed (137) — and it never reached SURVIVED.
      expect(r.killReason === "oom" || r.exitCode === 137).toBe(true);
      expect(r.stdout).not.toContain("SURVIVED");
    },
    40_000,
  );

  test(
    "a fork storm is contained by the pids limit (host stays responsive)",
    async () => {
      const r = await dockerRunner.run(
        spec({
          // Attempt far more background procs than the cap; pids-limit makes the excess fork()s fail.
          // Containment = the host survives and the run returns promptly (no self-replicating bomb).
          command: [
            "sh",
            "-c",
            "n=0; while [ $n -lt 400 ]; do (sleep 30 &) 2>/dev/null; n=$((n+1)); done; echo loop-done",
          ],
          pidsLimit: 32,
          timeoutMs: 10_000,
        }),
      );
      expect(r.timedOut).toBe(false); // returned on its own — host was never fork-starved
      expect(r.exitCode).not.toBeNull();
    },
    30_000,
  );
});
