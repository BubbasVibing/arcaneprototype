import { resolve } from "node:path";
import { RunAcceptSchema, RunRequestSchema, type RunConsent } from "@arcane/shared";
import { readToken } from "../auth/token";
import { cloudHttpBase } from "../cloud";
import { loadIgnoreRules, makeIgnoreMatcher } from "../collector/ignore";
import { loadConfig } from "../config";
import { resolveRef } from "../git";
import { loadSession } from "../session";
import { promptConsent } from "./consent";
import { buildBaselineTree, buildCurrentTree } from "./manifest";
import { commandFingerprint, loadPermissions, resolveConsent, upsertGrant } from "./permissions";

// `arcane run [workload] --compare --baseline <ref> [--yes]` (Technical-Spec §19, A3). The THIN
// trigger on top of M3D-1's cloud-authoritative gate: it resolves the consent decision (prompt /
// stored grant / auto_grant / CI), builds the baseline + current file trees, and POSTs /run. It
// ships files + a workload NAME + a consent signal — NEVER a command, NEVER executing anything
// (§16.1). Every execution gate is the CLOUD's; the CLI surfaces the cloud's refusal verbatim rather
// than pre-empting it. M3D-2 stops at acknowledging the enqueue (202); the live run view is M3D-3.
//
// Exit codes: 0 = enqueued; 1 = the run was refused (by the cloud) or denied (at the prompt);
// 2 = a local precondition/usage error (not logged in/linked, no config, undeclared workload,
// unusable baseline, headless without consent, bad flags).

export interface RunOptions {
  workload?: string;
  compare: boolean;
  baseline?: string;
  yes: boolean;
  noColor: boolean;
}

function fail(code: 1 | 2, msg: string): never {
  console.error(`✗ ${msg}`);
  return process.exit(code);
}

export async function run(target: string, opts: RunOptions): Promise<void> {
  const root = resolve(target);

  const token = readToken();
  if (!token) fail(2, "not logged in — run `arcane login` first");

  // Linked project (projectId + the stable session the consent "session" scope is keyed to).
  let session: ReturnType<typeof loadSession>;
  try {
    session = loadSession(root);
  } catch (err) {
    return fail(2, (err as Error).message);
  }

  // Local arcane.toml — needed to resolve the workload's DECLARED command (→ fingerprint) and its
  // consent config. These are UX reads only; the cloud independently re-derives + re-gates everything.
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(root);
  } catch (err) {
    return fail(2, (err as Error).message);
  }
  if (!loaded) {
    return fail(2, "no arcane.toml — declare a [[workload]] and [execution] section to run");
  }
  const config = loaded.config;

  if (!opts.workload) {
    return fail(2, "specify a workload to run, e.g. `arcane run <workload> --compare`");
  }
  // The one local lookup the consent UX needs (command → fingerprint + auto_grant). It fails MORE
  // closed than the cloud (which also enforces Gate B), never more open — not a gate bypass.
  const workload = config.workload?.find((w) => w.name === opts.workload);
  if (!workload) {
    return fail(2, `workload "${opts.workload}" is not declared in arcane.toml`);
  }
  const fingerprint = commandFingerprint(workload.command);

  // M3D-2 supports the baseline-vs-current comparison only (the /run contract carries both trees).
  if (!opts.compare) {
    return fail(2, "arcane run currently supports --compare only — pass --compare");
  }
  const baselineRef = opts.baseline ?? config.baseline?.ref;
  if (!baselineRef) {
    return fail(2, "specify a baseline — `--baseline <ref>` (or set [baseline].ref in arcane.toml)");
  }
  const currentRef = "working";
  try {
    await resolveRef(root, baselineRef); // validate the ref now → a clear error, not an empty tree
  } catch (err) {
    return fail(2, (err as Error).message);
  }

  // --- The consent decision (§19.1 gate 3, CLI-UX side) ---
  const exec = config.execution;
  const decision = resolveConsent({
    workload: workload.name,
    fingerprint,
    sessionId: session.sessionId,
    perms: loadPermissions(root),
    autoGrant: workload.auto_grant === true,
    requirePermission: exec?.require_permission !== false, // default true
    allowInCi: exec?.allow_in_ci === true,
    isTty: Boolean(process.stdout.isTTY),
    yes: opts.yes,
  });

  let consent: RunConsent | null;
  let ci: boolean;
  if (decision.kind === "refuse") {
    return fail(2, decision.reason);
  } else if (decision.kind === "prompt") {
    const choice = await promptConsent({
      workload: workload.name,
      command: workload.command,
      baselineRef,
      currentRef,
      noColor: opts.noColor,
    });
    if (choice === "deny") {
      return fail(1, "run denied — nothing was sent");
    }
    ci = false; // a prompt only happens on a TTY
    if (choice === "once") {
      consent = "once"; // not persisted
    } else if (choice === "session") {
      upsertGrant(root, { workload: workload.name, fingerprint, scope: "session", sessionId: session.sessionId });
      consent = "session";
    } else {
      upsertGrant(root, { workload: workload.name, fingerprint, scope: "always" });
      consent = "always";
    }
  } else {
    consent = decision.consent;
    ci = decision.ci;
  }

  // --- Build the two trees (read-only) + the request. Validating with RunRequestSchema BEFORE the
  // POST catches our own mistakes and guarantees the body carries NO command field (.strict). ---
  let baselineFiles: Awaited<ReturnType<typeof buildBaselineTree>>;
  let currentFiles: Awaited<ReturnType<typeof buildCurrentTree>>;
  try {
    const rules = await loadIgnoreRules(root, config.project?.ignore);
    const ignore = makeIgnoreMatcher(rules);
    baselineFiles = await buildBaselineTree(root, baselineRef, ignore);
    currentFiles = await buildCurrentTree(root, ignore);
  } catch (err) {
    return fail(2, `failed to read the file trees: ${(err as Error).message}`);
  }

  const body = RunRequestSchema.parse({
    projectId: session.projectId,
    workloadName: workload.name,
    baselineRef,
    currentRef,
    baselineFiles,
    currentFiles,
    consent,
    ci,
  });

  // --- Trigger. The cloud is the authority: a 4xx is its gate refusal, surfaced verbatim. ---
  let res: Response;
  try {
    res = await fetch(`${cloudHttpBase()}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return fail(1, `cannot reach the cloud (${(err as Error).message}) — is it running? \`npm run cloud\``);
  }

  if (!res.ok) {
    // Surface the cloud's authoritative reason (e.g. "execution disabled — set [execution].enabled
    // = true"). The CLI never pre-empts a gate; it reports what the cloud decided.
    return fail(1, `run refused (${res.status}): ${(await res.text()).trim()}`);
  }

  const accept = RunAcceptSchema.parse(await res.json());
  console.log("✓ run enqueued");
  console.log(`  runId     ${accept.runId}`);
  console.log(`  session   ${accept.runSessionId}`);
  console.log(`  workload  ${workload.name}  (${baselineRef} → ${currentRef})`);
  console.log("  results stream to the dashboard; the live CLI run view lands in M3D-3");
  process.exit(0);
}
