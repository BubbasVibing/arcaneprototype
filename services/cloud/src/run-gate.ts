import type { ArcaneConfig, RunConsent } from "@arcane/shared";
import { DEV_ORG_ID } from "./db/constants";
import { isExecutionEnabled } from "./sandbox/gate";
import { deriveArgv } from "./workload";

// M3D — the §19.1 consent gates, CLOUD-AUTHORITATIVE and PURE (no DB/IO), so the safety logic is unit-
// testable with plain inputs. The cloud is the authority because it is what runs the code; the CLI
// prompt is UX only. Order: Gate 0 (single-tenant) → A (master switch) → B (declared + server-derived
// argv). Gate C (per-run consent) is a separate check (it is snapshotted at enqueue, NOT re-checked at
// claim). `authorizeExecution` is run at BOTH the /run endpoint AND the worker claim (re-assert) — so
// the gate lives at the point of EXECUTION, not just the HTTP door.

export interface GateRefusal {
  ok: false;
  status: number; // HTTP status for the /run response
  reason: string;
}
export interface ExecAuthorized {
  ok: true;
  argv: string[];
  autoGrant: boolean;
}

// Gates 0 + A + B. Returns the server-derived argv on success.
export function authorizeExecution(args: {
  projectOrgId: string | null; // owner org of the project (DB) — Gate 0
  config: ArcaneConfig | undefined; // cloud-held config — Gates A/B
  workloadName: string;
}): ExecAuthorized | GateRefusal {
  // Unknown project (never linked / reaped) → fail closed.
  if (args.projectOrgId === null) {
    return { ok: false, status: 404, reason: "unknown project — run `arcane link` first" };
  }
  // Gate 0 — single-tenant guard (the executable form of the M3C integrity precondition). Fails closed
  // the instant a project outside the single dev tenant could trigger a run. The out-of-process query
  // observer must land BEFORE this guard is relaxed for multiple tenants (M7/M8).
  if (args.projectOrgId !== DEV_ORG_ID) {
    return {
      ok: false,
      status: 403,
      reason:
        "execution refused: multi-tenant runs are not permitted until an out-of-process query observer lands (single-tenant guard)",
    };
  }
  // Gate A — master switch (default-deny). Authoritative from the config the cloud holds.
  if (!isExecutionEnabled(args.config)) {
    return { ok: false, status: 403, reason: "execution disabled — set [execution].enabled = true" };
  }
  // Gate B — declared allowlist + server-derived argv. The request never supplies the command.
  const derived = deriveArgv(args.config, args.workloadName);
  if (!derived.ok) return { ok: false, status: 403, reason: derived.reason };
  return { ok: true, argv: derived.argv, autoGrant: derived.autoGrant };
}

// Gate C — per-run consent. Accept ONLY on an explicit human signal, a per-workload pre-grant, or a CI
// opt-in. `require_permission` is intentionally NOT consulted here — it is a CLI-UX toggle for whether
// the prompt appears, never a cloud accept condition (it must never let the CLI fabricate consent).
export function checkConsent(args: {
  consent: RunConsent | null;
  autoGrant: boolean;
  ci: boolean;
  config: ArcaneConfig | undefined;
}): { ok: true } | GateRefusal {
  if (args.consent !== null) return { ok: true }; // explicit per-run grant (CLI prompted or stored)
  if (args.autoGrant) return { ok: true }; // [[workload]].auto_grant pre-grant
  if (args.ci && args.config?.execution?.allow_in_ci === true) return { ok: true }; // CI opt-in
  return {
    ok: false,
    status: 403,
    reason:
      "no consent for this run — grant it (prompt), set the workload's auto_grant, or use CI allow_in_ci + --yes",
  };
}
