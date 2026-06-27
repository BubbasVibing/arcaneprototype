import type { ArcaneConfig } from "@arcane/shared";

// M3A — §19.1 gate 1: the MASTER SWITCH (default-deny). With `[execution].enabled !== true`, Tier-2
// execution does not exist: the sandbox refuses to run anything at all. This is the first and cheapest
// of the three consent gates; the per-run permission prompt + the declared-`[[workload]]` allowlist
// (§19.1 gates 2-3) are the CLI side, landing in M3D.
//
// It exists from the FIRST commit that can execute user code so that "nothing executes without consent"
// is true by construction: every orchestration path that reaches SandboxRunner.run() must clear this
// gate first. In M3A the runner is only invoked from tests, but the gate is already the law.

export class ExecutionDisabledError extends Error {
  constructor() {
    super(
      "execution disabled — set [execution].enabled = true in arcane.toml to allow sandboxed runs (§19.1)",
    );
    this.name = "ExecutionDisabledError";
  }
}

export function isExecutionEnabled(config: ArcaneConfig | undefined): boolean {
  // Strictly === true: absent config, an absent [execution] block, and enabled:false all DENY.
  return config?.execution?.enabled === true;
}

export function assertExecutionAllowed(config: ArcaneConfig | undefined): void {
  if (!isExecutionEnabled(config)) throw new ExecutionDisabledError();
}
