import { join } from "node:path";
import type { ArcaneConfig } from "@arcane/shared";
import { assertExecutionAllowed } from "../sandbox/gate";
import { ensureImage, selectSandboxRunner } from "../sandbox/runner";
import {
  DEFAULT_CPUS,
  DEFAULT_MEM_BYTES,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SCRATCH_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "../sandbox/spec";
import type { SandboxNetwork, SandboxResult, SandboxSpec } from "../sandbox/spec";
import { parseTrace, TRACE_SENTINEL } from "./trace";
import type { TraceSample } from "./trace";

// M3B — single-side measurement: run ONE declared workload ONCE in the M3A sandbox with the
// instrumentation probe attached, then lift its trace out of stdout. NO baseline-vs-current, NO stats,
// NO delta, NO findings — that is M3C. TEST-HARNESS-triggered only: no ChangeEvent / CLI / auto path
// reaches it (consent + the public `arcane run` door are M3D). The default-deny gate is still law.
//
// Reuses the PROVEN M3A runner (selectSandboxRunner/dockerRunner) — it does not define a new one. The
// probe is injected via the runner's optional probe fields (env + read-only probeMount) and the trace
// comes back on stdout (the probe writes a sentinel-prefixed line on exit; see trace.ts). This adds NO
// writable host mount — the M3A mount security surface is unchanged (SI-1). Any failure degrades to
// "no trace" (never throws into the static pipeline, never fabricates — honesty: trace presence is the
// only proof a measurement happened).

export const JS_RUNTIME_IMAGE = "node:22-alpine"; // pre-baked JS runtime for the probe (decided Q1)
const PROBE_HOST_PATH = join(import.meta.dir, "../sandbox/probe/preload.cjs");
const PROBE_CONTAINER_PATH = "/arcane/preload.cjs";

export interface MeasureOptions {
  config: ArcaneConfig | undefined; // gated: execution.enabled must be true (default-deny)
  command: string[]; // argv to run inside the sandbox, e.g. ["node", "/workspace/workload.js"]
  mountDir?: string; // project tree mounted READ-ONLY at /workspace
  network?: SandboxNetwork; // default: config.execution.network ?? "deny"
  timeoutMs?: number; // default: config.execution.timeout_ms ?? DEFAULT_TIMEOUT_MS
  image?: string; // default: JS_RUNTIME_IMAGE
  replayFixtures?: Record<string, { status?: number; body?: string }>; // for network:"replay" fetch
}

export interface MeasureResult {
  result: SandboxResult; // the raw sandbox outcome (stdout has the probe sentinel line stripped)
  trace: TraceSample | null; // the probe's trace, or null when it degraded
  reason?: string; // why trace is null (when it is): "no-trace"
}

export async function measureSingle(opts: MeasureOptions): Promise<MeasureResult> {
  // §19.1 gate 1 — the master switch is default-deny; refuse unless execution.enabled === true.
  assertExecutionAllowed(opts.config);

  const image = opts.image ?? JS_RUNTIME_IMAGE;
  const network: SandboxNetwork = opts.network ?? opts.config?.execution?.network ?? "deny";
  if (network === "allow") {
    // Mirror the runner's fail-closed posture at the harness boundary — egress is never silently allowed.
    throw new Error("measureSingle: network 'allow' is never honored — use 'deny' or 'replay'");
  }
  const timeoutMs = opts.timeoutMs ?? opts.config?.execution?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  await ensureImage(image); // run() uses --pull never; provision here (test/link-time path)

  const env: Record<string, string> = {
    NODE_OPTIONS: `--require ${PROBE_CONTAINER_PATH}`, // injects the probe before user code (allowlisted flag)
    ARCANE_NET: network,
  };
  if (opts.replayFixtures) env.ARCANE_REPLAY_FIXTURES = JSON.stringify(opts.replayFixtures);

  const spec: SandboxSpec = {
    command: opts.command,
    image,
    mountDir: opts.mountDir,
    timeoutMs,
    memBytes: DEFAULT_MEM_BYTES,
    cpus: DEFAULT_CPUS,
    pidsLimit: DEFAULT_PIDS_LIMIT,
    network, // "deny" or "replay"; the container runs --network none either way
    scratchBytes: DEFAULT_SCRATCH_BYTES,
    env,
    probeMount: { hostPath: PROBE_HOST_PATH, containerPath: PROBE_CONTAINER_PATH },
  };

  const runner = selectSandboxRunner(opts.config); // proven M3A runner (container backend)
  const result = await runner.run(spec);

  // Lift the trace out of stdout, then strip the sentinel line so callers see only the workload output.
  // parseTrace takes the LAST complete sample and rejects partials — see the MEASUREMENT-INTEGRITY
  // BOUNDARY note in trace.ts (the trace is forgeable by a HOSTILE workload; M3B assumes a
  // non-adversarial one; M3C needs a tamper-resistant channel before attribution rests on it).
  const trace = parseTrace(result.stdout);
  result.stdout = stripTraceLines(result.stdout);
  // Degrade to "no trace" on every failure path — never throw, never fabricate (honesty §16.15).
  return trace ? { result, trace } : { result, trace: null, reason: "no-trace" };
}

function stripTraceLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.includes(TRACE_SENTINEL))
    .join("\n");
}
