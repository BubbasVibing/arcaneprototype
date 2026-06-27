import { createHash } from "node:crypto";
import type { ArcaneConfig } from "@arcane/shared";

// M3D Gate B — server-side argv derivation. THE deepest consent invariant: a run request can only NAME
// a workload; the cloud derives the executable argv from the user's declared `[[workload]].command` in
// the cloud-held config. The request never supplies the command, so "Arcane never runs a command the
// user didn't write into arcane.toml" holds BY CONSTRUCTION (no RCE-with-a-prompt). Declaring a workload
// is still not permission to run it — that is gates A/C.
//
// We run a DIRECT argv (no shell), so the declared command must be a plain `prog arg arg` line. Shell
// metacharacters are REFUSED rather than interpreted — there is no shell to interpret them, and allowing
// them would smuggle behavior past the "declared command" guarantee.

// Reject anything that implies shell interpretation / indirection (pipes, redirects, subshells,
// expansion, command separators, quotes, newlines, backslashes).
const SHELL_METACHARS = /[;&|`$(){}<>\n\r\\"']/;

export type DeriveResult =
  | { ok: true; argv: string[]; command: string; fingerprint: string; autoGrant: boolean }
  | { ok: false; reason: string };

// A stable fingerprint of the declared command — the CLI keys permission grants by (name + fingerprint)
// so a changed command invalidates a stored "always" grant (re-prompt). Cheap, deterministic.
export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

export function deriveArgv(config: ArcaneConfig | undefined, workloadName: string): DeriveResult {
  const workload = config?.workload?.find((w) => w.name === workloadName);
  if (!workload) {
    return { ok: false, reason: `workload "${workloadName}" is not declared in arcane.toml` };
  }
  const command = workload.command;
  if (SHELL_METACHARS.test(command)) {
    return {
      ok: false,
      reason: `workload "${workloadName}" command contains shell metacharacters; declare a direct argv (e.g. "node dist/server.js"), not a shell pipeline`,
    };
  }
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    return { ok: false, reason: `workload "${workloadName}" has an empty command` };
  }
  return {
    ok: true,
    argv,
    command,
    fingerprint: commandFingerprint(command),
    autoGrant: workload.auto_grant === true,
  };
}
