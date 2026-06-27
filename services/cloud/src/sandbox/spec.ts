// M3A — the contract for ONE sandboxed run. Cloud-internal (only RunReport, M3C, crosses to
// @arcane/shared). Threat model: `command` is UNTRUSTED, potentially-hostile user code. The runner's
// job is CONTAINMENT, not trust — see the load-bearing safety invariants (plan §3):
//   SI-1  the container is the ONLY containment boundary; any in-process probe (M3B+) is telemetry,
//         never load-bearing. Containment must hold with no probe at all — which is the M3A default.
//   SI-3  the microVM backend is asserted-by-interface, NOT proven here (Linux/KVM-only). Only the
//         container backend is escape-tested on this host.

// Network policy. M3A implements `deny` only; `replay`/`allow` arrive with the instrumentation probe
// (M3B+). The type mirrors ArcaneConfig.execution.network so M3B can widen behavior without a type
// change — but the runner FAILS CLOSED on anything other than `deny` today.
export type SandboxNetwork = "deny" | "replay" | "allow";

export interface SandboxSpec {
  command: string[]; // argv executed inside the sandbox (UNTRUSTED)
  image: string; // OCI image to run in (e.g. "alpine:3"); pre-baked — run() never pulls
  mountDir?: string; // host dir mounted READ-ONLY at /workspace (the project tree); omit = no mount
  timeoutMs: number; // wall-clock budget; the watchdog SIGKILLs the container on overrun
  memBytes: number; // hard memory ceiling (no swap) — OOM-kill on overrun
  cpus: number; // CPU cap (e.g. 1)
  pidsLimit: number; // max processes (fork-bomb containment)
  network: SandboxNetwork; // M3A: must be "deny". M3B widens to "replay" (probe record-replay); "allow" stays refused.
  scratchBytes?: number; // size of the per-run writable /scratch + /tmp tmpfs (default 16 MiB)

  // ── M3B probe-attach fields (all OPTIONAL — unset ⇒ M3A behavior byte-identical) ───────────────
  // These let the cloud inject the in-sandbox instrumentation probe WITHOUT redefining the proven
  // runner. They DO NOT relax containment: `--network none`, the read-only rootfs, caps, and the
  // watchdog are unchanged; the SI-1 re-proof re-runs the escape suite with these fields SET and must
  // stay green (probe-containment.test.ts). The probe is telemetry only — the container is the only
  // boundary (SI-1). The probe's trace leaves the sandbox on STDOUT (a sentinel line), so there is NO
  // writable host mount and NO copy-out channel — the M3A mount surface is untouched.
  env?: Record<string, string>; // EXPLICIT allowlist of env vars to set (e.g. NODE_OPTIONS, ARCANE_NET).
  //                                NOT host passthrough — process.env is never forwarded; secret-stripping holds.
  probeMount?: { hostPath: string; containerPath: string }; // a single host file mounted READ-ONLY (the preload).
}

// Why the run ended, if the platform (watchdog / kernel) ended it. `null` = the workload exited on
// its own (clean or with a non-zero code of its choosing).
export type KillReason = "timeout" | "oom" | null;

export interface SandboxResult {
  exitCode: number | null; // the workload's exit code; null when the platform killed it (timeout)
  killReason: KillReason;
  timedOut: boolean;
  stdout: string; // captured, tail-bounded (a workload can't flood cloud memory)
  stderr: string;
  wallMs: number; // measured wall-clock duration
  isolation: "container" | "microvm"; // provenance — which backend produced this result
}

// Conservative defaults for a single run. Concrete caps for a real workload come from ArcaneConfig
// (`[execution].timeout_ms`, isolation) at the M3D orchestration layer; these are the floor M3A tests
// and ad-hoc callers build on.
export const DEFAULT_TIMEOUT_MS = 30_000; // Product-Requirements §4.1 default
export const DEFAULT_MEM_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CPUS = 1;
export const DEFAULT_PIDS_LIMIT = 128;
export const DEFAULT_SCRATCH_BYTES = 16 * 1024 * 1024;
