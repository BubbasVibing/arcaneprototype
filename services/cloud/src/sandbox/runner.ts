import { randomUUID } from "node:crypto";
import type { ArcaneConfig } from "@arcane/shared";
import type { KillReason, SandboxResult, SandboxSpec } from "./spec";

// M3A — the sandbox runner. Runs UNTRUSTED argv under hard OS-level isolation + resource caps and
// reports what happened. The container is the ONLY containment boundary (SI-1): there is no
// in-process probe in M3A, and when M3B adds one it stays telemetry-only — the escape suite must keep
// passing with it disabled. Backends sit behind one interface so production can swap the proven-on-host
// container backend for a microVM on a Linux/KVM host WITHOUT touching the Runtime Delta layers above.

export interface SandboxRunner {
  readonly backend: "container" | "microvm";
  // Usable RIGHT NOW. NOT "is the CLI installed" — `docker` exits 0 with the daemon down, so this must
  // probe daemon reachability. A false here degrades runtime to "no runtime data", never a crash.
  isAvailable(): Promise<boolean>;
  // Never throws on workload misbehavior — a hostile/runaway workload is reported via SandboxResult
  // (killReason/exitCode/timedOut), not an exception. Throws only on caller misuse (bad network mode).
  run(spec: SandboxSpec): Promise<SandboxResult>;
}

const STDIO_CAP = 64 * 1024; // bytes of stdout/stderr retained — a chatty workload can't flood the cloud

function capStdio(s: string): string {
  return s.length > STDIO_CAP ? `${s.slice(0, STDIO_CAP)}\n…[truncated]` : s;
}

async function dockerDaemonUp(): Promise<boolean> {
  // `docker info` fails iff the daemon is unreachable — exactly the signal we need (unlike --version).
  try {
    const p = Bun.spawn(["docker", "info", "--format", "{{.OSType}}"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await p.exited) === 0;
  } catch {
    return false; // docker CLI not on PATH
  }
}

// Precise OOM signal from the kernel, read before the container is reaped. We deliberately DON'T use
// `--rm` so this inspect can run; cleanup is explicit in run()'s finally.
async function inspectOomKilled(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["docker", "inspect", "-f", "{{.State.OOMKilled}}", name], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return out === "true";
  } catch {
    return false;
  }
}

// The hardened `docker run` argv. Every flag here is a containment control — read this as the security
// surface, not config plumbing.
function buildRunArgs(name: string, spec: SandboxSpec): string[] {
  const scratch = spec.scratchBytes ?? 16 * 1024 * 1024;
  const args = [
    "run",
    "--name",
    name,
    "--network",
    "none", // no egress — the boundary that stops calling the internet / hitting prod / exfiltrating
    "--memory",
    String(spec.memBytes),
    "--memory-swap",
    String(spec.memBytes), // == memory ⇒ no swap escape; the cap is real, OOM-kill on overrun
    "--cpus",
    String(spec.cpus),
    "--pids-limit",
    String(spec.pidsLimit), // fork-bomb containment
    "--read-only", // immutable root filesystem
    "--tmpfs",
    `/scratch:rw,nosuid,nodev,noexec,size=${scratch}`, // per-run writable scratch, destroyed with the container
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${scratch}`,
    "--cap-drop",
    "ALL", // drop every Linux capability
    "--security-opt",
    "no-new-privileges", // setuid binaries can't escalate
    "--user",
    "65534:65534", // nobody:nogroup — never root inside the container
    "--pull",
    "never", // run() NEVER pulls — images are pre-baked; no surprise host network on the run path
  ];
  if (spec.mountDir) {
    // Read-only project mount. No shared FS between tenants: a run only ever sees its own mount.
    args.push("-v", `${spec.mountDir}:/workspace:ro`, "-w", "/workspace");
  } else {
    args.push("-w", "/scratch");
  }
  // NOTE: no host environment is forwarded — secrets are stripped by construction (default-deny env).
  args.push(spec.image, ...spec.command);
  return args;
}

export const dockerRunner: SandboxRunner = {
  backend: "container",
  isAvailable: dockerDaemonUp,

  async run(spec: SandboxSpec): Promise<SandboxResult> {
    if (spec.network !== "deny") {
      // M3A is deny-only. `replay`/`allow` arrive with the probe (M3B+). FAIL CLOSED — never silently
      // honor a non-deny network mode.
      throw new Error(`sandbox network mode '${spec.network}' is not implemented — M3A is deny-only`);
    }

    const name = `arcane-sbx-${randomUUID()}`;
    const t0 = Date.now();
    let timedOut = false;

    // Watchdog: on wall-clock overrun, SIGKILL the container (docker kill defaults to SIGKILL). The
    // `docker run` process then exits and we read the outcome below.
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
      } catch {
        /* container may not exist yet / already gone — harmless */
      }
    }, spec.timeoutMs);

    try {
      const proc = Bun.spawn(["docker", ...buildRunArgs(name, spec)], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(killTimer);

      const oomKilled = !timedOut && (await inspectOomKilled(name));
      let killReason: KillReason = null;
      if (timedOut) killReason = "timeout";
      else if (oomKilled) killReason = "oom";

      return {
        exitCode: timedOut ? null : exitCode,
        killReason,
        timedOut,
        stdout: capStdio(stdout),
        stderr: capStdio(stderr),
        wallMs: Date.now() - t0,
        isolation: "container",
      };
    } finally {
      clearTimeout(killTimer);
      // Always destroy the container + its scratch tmpfs — no state survives a run (per-tenant isolation).
      try {
        Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
      } catch {
        /* best-effort cleanup */
      }
    }
  },
};

// Pick the runner for a config. Container is the only backend PROVEN on this host.
export function selectSandboxRunner(config: ArcaneConfig | undefined): SandboxRunner {
  const isolation = config?.execution?.isolation ?? "container";
  if (isolation === "container") return dockerRunner;
  // SI-3: the microVM (Firecracker) backend is asserted-by-interface, NOT proven here. It is
  // Linux/KVM-only and is NOT escape-tested on this host. REFUSE rather than silently treat it as
  // safe — "unproven" must never read as "safe".
  throw new Error(
    "isolation = 'microvm' is not proven on this host — the Firecracker backend is Linux/KVM-only and " +
      "has not been escape-tested. Use isolation = 'container', or run the escape suite on a KVM host first.",
  );
}

// Ensure an image is present locally (run() uses --pull never). Used by tests / link-time provisioning;
// NOT called on the run hot path. Throws if the pull fails.
export async function ensureImage(image: string): Promise<void> {
  const inspect = Bun.spawn(["docker", "image", "inspect", image], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await inspect.exited) === 0) return;
  const pull = Bun.spawn(["docker", "pull", image], { stdout: "inherit", stderr: "inherit" });
  if ((await pull.exited) !== 0) throw new Error(`failed to pull sandbox image '${image}'`);
}
