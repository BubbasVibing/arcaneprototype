import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerRunner, ensureImage } from "../runner";
import type { SandboxSpec } from "../spec";

// M3B SI-1 RE-PROOF — containment must STILL HOLD with the instrumentation probe PRESENT.
//
// THE NON-NEGOTIABLE (SI-1): the container is the ONLY containment boundary. The probe runs in the
// SAME process as hostile code and is telemetry-only — it can be bypassed (a fresh require, a child
// with NODE_OPTIONS stripped, a native addon, raw syscalls). Its network record-replay is
// defense-in-depth ON TOP of `--network none`, NEVER a substitute. M3A's escape.test.ts already proved
// containment with the probe ABSENT. This suite proves the -e/-v/copyOut runner additions + the
// monkeypatching DID NOT widen the cage: every M3A adversary is re-run with the probe mounted +
// NODE_OPTIONS set + network="replay", and a NODE_OPTIONS-STRIPPED BYPASS CHILD (no probe at all)
// attempts raw egress — the container blocks it regardless. If introducing the probe makes ANY escape
// case newly pass, that is a STOP-and-flag, not a proceed.
//
// SI-2: a silently-skipped isolation proof is the most dangerous skip in the system — if no runtime is
// reachable we skip LOUDLY, and M3B is NOT "done" on a skipped suite.

const IMAGE = "node:22-alpine"; // the M3B JS-runtime image (the probe is a Node preload)
const PROBE_PATH = join(import.meta.dir, "../probe/preload.cjs");
const PROBE_CONTAINER = "/arcane/preload.cjs";
const SECRET = "ARCANE_HOST_SECRET_d3adb33f"; // sentinel that must never be readable from a sandbox

const RUNTIME_OK = await dockerRunner.isAvailable();

if (!RUNTIME_OK) {
  console.error(
    "\n🔴🔴🔴  M3B SI-1 RE-PROOF (probe-present containment) DID NOT RUN  🔴🔴🔴\n" +
      "  No container runtime is reachable (docker daemon down / not installed).\n" +
      "  'skipped' here must NEVER read as 'containment-with-the-probe proven'. The probe rides INSIDE\n" +
      "  the cage — until adversarial code tried to escape PROBE-PRESENT and could not, M3B is NOT done.\n" +
      "  Fix: start Docker Desktop ( open -a Docker ), then:  cd services/cloud && bun test probe-containment\n" +
      "🔴🔴🔴──────────────────────────────────────────────────────────🔴🔴🔴\n",
  );
}

let projectDir = ""; // a read-only project mount
let secretDir = ""; // a host dir that is NEVER mounted — must be invisible inside the sandbox
let secretPath = "";

// The SI-1 BYPASS ADVERSARY: a child process launched with NODE_OPTIONS stripped → NO probe in effect
// → only the container can stop its raw egress. Printing EGRESS-OK would mean the cage leaked.
const BYPASS_EGRESS_JS = `const cp = require("child_process");
const child = "const net=require('net');const s=net.connect(443,'1.1.1.1');s.setTimeout(3000);s.on('connect',function(){console.log('EGRESS-OK');process.exit(0)});s.on('error',function(){console.log('EGRESS-FAIL');process.exit(7)});s.on('timeout',function(){console.log('EGRESS-TIMEOUT');process.exit(8)});";
const r = cp.spawnSync("node", ["-e", child], { env: Object.assign({}, process.env, { NODE_OPTIONS: "" }), encoding: "utf8", timeout: 8000 });
console.log("CHILD:" + (r.stdout || "") + "|" + (r.stderr || "") + "|status=" + r.status);
`;

// Every spec here carries the probe (mounted + injected) and network="replay" — the widened path.
function probeSpec(partial: Partial<SandboxSpec> & Pick<SandboxSpec, "command">): SandboxSpec {
  return {
    image: IMAGE,
    timeoutMs: 5_000,
    memBytes: 128 * 1024 * 1024,
    cpus: 1,
    pidsLimit: 64,
    network: "replay", // exercise the M3B-widened mode; container still runs --network none
    scratchBytes: 16 * 1024 * 1024,
    env: {
      NODE_OPTIONS: `--require ${PROBE_CONTAINER}`,
      ARCANE_NET: "replay",
    },
    probeMount: { hostPath: PROBE_PATH, containerPath: PROBE_CONTAINER },
    ...partial,
  };
}

describe.skipIf(!RUNTIME_OK)("M3B SI-1 — sandbox isolation holds WITH the probe present", () => {
  beforeAll(async () => {
    await ensureImage(IMAGE);
    // Warm the freshly-pulled image + daemon so the first TIMED test isn't a cold-start outlier
    // (a cold first container can materialize layers slowly and trip a short watchdog). Untimed here.
    await dockerRunner.run({
      image: IMAGE,
      command: ["node", "-e", "0"],
      timeoutMs: 120_000,
      memBytes: 128 * 1024 * 1024,
      cpus: 1,
      pidsLimit: 64,
      network: "deny",
      scratchBytes: 16 * 1024 * 1024,
    });
    projectDir = await mkdtemp(join(tmpdir(), "arcane-probe-cont-proj-"));
    await writeFile(join(projectDir, "canary.txt"), "original\n");
    await writeFile(join(projectDir, "bypass-egress.js"), BYPASS_EGRESS_JS);
    secretDir = await mkdtemp(join(tmpdir(), "arcane-probe-cont-secret-"));
    secretPath = join(secretDir, "secret.txt");
    await writeFile(secretPath, `${SECRET}\n`);
  }, 300_000); // first run pulls node:22-alpine

  afterAll(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (secretDir) await rm(secretDir, { recursive: true, force: true });
  });

  test(
    "positive control: the probe LOADS and a benign workload runs to completion",
    async () => {
      // If the probe mount / NODE_OPTIONS injection were broken, `node` would fail to load the preload
      // and never print this. Green here proves the -v/-e additions actually inject the probe.
      const r = await dockerRunner.run(probeSpec({ command: ["node", "-e", "console.log('hello-probe')"] }));
      expect(r.exitCode).toBe(0);
      expect(r.killReason).toBeNull();
      expect(r.stdout).toContain("hello-probe");
    },
    60_000,
  );

  test(
    "SI-1 BYPASS: a NODE_OPTIONS-stripped child (no probe) cannot egress — --network none blocks it",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          mountDir: projectDir,
          command: ["node", "/workspace/bypass-egress.js"],
          timeoutMs: 15_000,
        }),
      );
      expect(r.stdout).toContain("CHILD:"); // the bypass adversary actually ran (not a skip)
      expect(r.stdout).not.toContain("EGRESS-OK"); // egress did NOT succeed → the CONTAINER is the boundary
    },
    30_000,
  );

  test(
    "probe-present outbound fetch is blocked (replay w/o fixture fails closed)",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          command: [
            "node",
            "-e",
            "fetch('http://1.1.1.1/').then(()=>console.log('FETCH-OK')).catch(()=>console.log('FETCH-BLOCKED'))",
          ],
          timeoutMs: 12_000,
        }),
      );
      expect(r.stdout).not.toContain("FETCH-OK");
      expect(r.stdout).toContain("FETCH-BLOCKED");
    },
    30_000,
  );

  test(
    "the project mount is still read-only — writes denied, host file untouched",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          mountDir: projectDir,
          command: [
            "node",
            "-e",
            "try{require('fs').writeFileSync('/workspace/canary.txt','pwned');console.log('WROTE EXIT=0')}catch(e){console.log('WRITE-DENIED '+e.code)}",
          ],
        }),
      );
      expect(r.stdout).not.toContain("WROTE EXIT=0");
      expect(r.stdout).toContain("WRITE-DENIED");
      expect(await readFile(join(projectDir, "canary.txt"), "utf8")).toBe("original\n"); // host intact
    },
    30_000,
  );

  test(
    "host filesystem outside the mount is still invisible (no path traversal to host secrets)",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          mountDir: projectDir,
          command: [
            "node",
            "-e",
            `try{const d=require('fs').readFileSync(${JSON.stringify(secretPath)},'utf8');console.log('READ:'+d)}catch(e){console.log('READ-DENIED '+e.code)}`,
          ],
        }),
      );
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stdout).toContain("READ-DENIED");
    },
    30_000,
  );

  test(
    "an infinite loop is still killed by the watchdog (SIGKILL on timeout)",
    async () => {
      const t0 = Date.now();
      const r = await dockerRunner.run(
        probeSpec({ command: ["node", "-e", "while(true){}"], timeoutMs: 2_000 }),
      );
      expect(r.timedOut).toBe(true);
      expect(r.killReason).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(20_000); // it did NOT hang the host
    },
    30_000,
  );

  test(
    "a memory bomb is still contained by the cap (OOM-killed, host unharmed)",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          // commit pages with .fill so RSS grows off-heap until the 128 MiB cap (no swap) OOM-kills it.
          command: ["node", "-e", "const a=[];while(true){a.push(Buffer.alloc(10*1024*1024).fill(1))}"],
          memBytes: 128 * 1024 * 1024,
          timeoutMs: 20_000,
        }),
      );
      expect(r.timedOut).toBe(false);
      expect(r.killReason === "oom" || r.exitCode === 137).toBe(true);
    },
    40_000,
  );

  test(
    "a fork storm is still contained by the pids limit (host stays responsive)",
    async () => {
      const r = await dockerRunner.run(
        probeSpec({
          command: [
            "node",
            "-e",
            "for(let i=0;i<400;i++){try{require('child_process').spawn('sleep',['30'])}catch(e){}};console.log('loop-done')",
          ],
          pidsLimit: 32,
          timeoutMs: 12_000,
        }),
      );
      expect(r.timedOut).toBe(false); // returned on its own — host was never fork-starved
      expect(r.exitCode).not.toBeNull();
    },
    30_000,
  );
});
