import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunConsent } from "@arcane/shared";

// M3D-2 — the CLI's per-run consent decision + the `.arcane/permissions.json` grant store. The CLOUD
// is the authoritative execution gate (§19.1 gates A/B/C are enforced server-side at /run and re-
// asserted at claim); this module is the CLI's UX side: it decides whether a real human (or a stored
// human grant, or a workload pre-grant, or CI opt-in) authorizes the run, and only then sends a
// `consent` signal. It must NEVER fabricate a consent the human did not give — `require_permission`
// only suppresses the PROMPT, it never manufactures a grant (per Technical-Spec §19.1 / §4.2).

// THE ONE CORRECTNESS PROPERTY (the prompt's load-bearing invariant): a stored grant is keyed by
// (workload name + a fingerprint of the DECLARED command). Edit the command in arcane.toml and the
// fingerprint changes, the old grant no longer matches, and the CLI RE-PROMPTS — so "I approved
// `npm test` once" can never silently auto-run a command that was later changed to something else.
//
// This formula is kept byte-identical to the cloud's canonical definition
// (services/cloud/src/workload.ts:commandFingerprint). The cloud is the canonical DEFINER; it does
// NOT transmit or compare the fingerprint (run-gate.ts ignores it), so this is a CLI-LOCAL key — the
// re-prompt-on-change property holds entirely here. We mirror the formula deliberately (Lane A cannot
// import from services/cloud) so the two notions of "fingerprint" agree. Cheap, deterministic.
export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

// A persisted grant. `once`/`deny` are never stored (once = this run only; deny = abort + re-prompt).
// `always` survives CLI restarts + re-link (until the command changes → fingerprint mismatch).
// `session` additionally carries the link.json sessionId and is honored ONLY while it matches the
// current session — a re-link mints a fresh sessionId, so session grants go stale and re-prompt.
export type GrantScope = Extract<RunConsent, "session" | "always">;

export interface Grant {
  workload: string;
  fingerprint: string;
  scope: GrantScope;
  sessionId?: string; // present iff scope === "session"
}

export interface PermissionsFile {
  version: 1;
  grants: Grant[];
}

export function permissionsPath(root: string): string {
  return join(root, ".arcane", "permissions.json");
}

// Load the grant store, tolerating a missing/corrupt file by treating it as "no saved grants" — a
// corrupt permissions file must fail CLOSED (re-prompt), never silently grant. Mirrors session.ts.
export function loadPermissions(root: string): PermissionsFile {
  const path = permissionsPath(root);
  if (!existsSync(path)) return { version: 1, grants: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PermissionsFile>;
    if (!Array.isArray(parsed.grants)) return { version: 1, grants: [] };
    // Keep only well-formed grants; a malformed entry is dropped (fail closed → re-prompt for it).
    const grants = parsed.grants.filter(isValidGrant);
    return { version: 1, grants };
  } catch {
    return { version: 1, grants: [] };
  }
}

export function savePermissions(root: string, perms: PermissionsFile): void {
  const path = permissionsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(perms, null, 2)}\n`);
}

// Persist (or replace) a grant for (workload + fingerprint). Replacing on the same key keeps the file
// from accumulating stale rows when a user re-grants the same workload at a new scope/command.
export function upsertGrant(root: string, grant: Grant): void {
  const perms = loadPermissions(root);
  const grants = perms.grants.filter(
    (g) => !(g.workload === grant.workload && g.fingerprint === grant.fingerprint),
  );
  grants.push(grant);
  savePermissions(root, { version: 1, grants });
}

// Does a stored grant authorize this (workload + current command fingerprint) in this session?
export function findGrant(
  perms: PermissionsFile,
  workload: string,
  fingerprint: string,
  sessionId: string,
): Grant | undefined {
  return perms.grants.find(
    (g) =>
      g.workload === workload &&
      g.fingerprint === fingerprint &&
      (g.scope === "always" || (g.scope === "session" && g.sessionId === sessionId)),
  );
}

// The CLI's pure consent decision. NO IO, NO Docker — fully unit-testable. Returns either the
// `consent` signal to send to the cloud (+ whether a prompt is still required), or a local refusal
// (the CLI declines BEFORE POSTing — used only where there is genuinely no way to obtain consent,
// never to pre-empt one of the cloud's own gates).
export interface ConsentInputs {
  workload: string;
  fingerprint: string;
  sessionId: string;
  perms: PermissionsFile;
  autoGrant: boolean; // local [[workload]].auto_grant — the cloud independently re-checks its own
  requirePermission: boolean; // local [execution].require_permission (default true) — UX toggle ONLY
  allowInCi: boolean; // local [execution].allow_in_ci — the cloud independently re-checks its own
  isTty: boolean; // a real interactive terminal is attached (can show a prompt)
  yes: boolean; // --yes passed
}

export type ConsentDecision =
  // Send this run with `consent` (null ⇒ rely on the cloud's auto_grant / allow_in_ci path). When
  // `prompt` is set, the caller must show the interactive prompt and use ITS result instead.
  | { kind: "send"; consent: RunConsent | null; ci: boolean }
  | { kind: "prompt" } // interactive prompt required (TTY) — caller prompts, then persists + sends
  | { kind: "refuse"; reason: string }; // CLI declines locally (no consent obtainable), no POST

export function resolveConsent(input: ConsentInputs): ConsentDecision {
  const ci = !input.isTty;

  // 1. A stored human grant for this exact command → send it, no prompt.
  const grant = findGrant(input.perms, input.workload, input.fingerprint, input.sessionId);
  if (grant) return { kind: "send", consent: grant.scope, ci };

  // 2. Workload pre-grant: auto_grant skips the prompt. Send consent=null and let the cloud accept
  //    via its OWN auto_grant check — the CLI never fabricates a human signal it didn't receive.
  if (input.autoGrant) return { kind: "send", consent: null, ci };

  // 3. Headless / CI (no TTY): no prompt is possible.
  if (ci) {
    // The cloud accepts a CI run via `ci && allow_in_ci`. --yes is the CLI's guard against an
    // ACCIDENTAL CI run (the cloud does not see --yes); allow_in_ci is the real boundary.
    if (input.allowInCi && input.yes) return { kind: "send", consent: null, ci };
    return {
      kind: "refuse",
      reason:
        "headless run needs the workload's auto_grant, or [execution].allow_in_ci = true plus --yes",
    };
  }

  // 4. Interactive: prompt unless require_permission is explicitly false.
  if (input.requirePermission) return { kind: "prompt" };

  // 5. require_permission = false but no stored grant and no auto_grant. The prompt is suppressed and
  //    there is no human signal to send — and require_permission must NEVER manufacture one. Refuse
  //    locally with guidance rather than POST a request the cloud will reject for lack of consent.
  return {
    kind: "refuse",
    reason: `workload "${input.workload}" has no grant and [execution].require_permission = false suppresses the prompt — add auto_grant = true to the workload, or set require_permission = true to be prompted`,
  };
}

function isValidGrant(g: unknown): g is Grant {
  if (typeof g !== "object" || g === null) return false;
  const o = g as Record<string, unknown>;
  if (typeof o.workload !== "string" || typeof o.fingerprint !== "string") return false;
  if (o.scope === "always") return true;
  if (o.scope === "session") return typeof o.sessionId === "string";
  return false;
}
