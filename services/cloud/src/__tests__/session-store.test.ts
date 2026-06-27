import { describe, expect, test } from "bun:test";
import type { GitContext } from "@arcane/shared";
import { InMemorySessionStore, type Manifest } from "../session-store";

// M2A: the in-memory store seeds + refreshes git context (§3A.5) and reaps idle projects (the shadow
// worktree leak fix). Unknown-project still throws (the restart self-heal turns that into relink).

const manifest = (): Manifest => new Map([["a.ts", "hash-a"]]);
const git = (branch: string): GitContext => ({ isRepo: true, branch, headSha: "deadbeef" });

describe("InMemorySessionStore", () => {
  test("throws on an unknown project (drives the relink self-heal)", async () => {
    const store = new InMemorySessionStore();
    await expect(store.getOrCreateSession("s1", "missing", "snap0")).rejects.toThrow(
      /unknown project/,
    );
  });

  test("seeds a session from the baseline, including link-time git", async () => {
    const store = new InMemorySessionStore();
    await store.registerBaseline("p1", { manifest: manifest(), baseSnapshotId: "base1", git: git("main") });
    const s = await store.getOrCreateSession("s1", "p1", "base1");
    expect(s.appliedSeq).toBe(0);
    expect(s.manifest.get("a.ts")).toBe("hash-a");
    expect(s.git?.branch).toBe("main");
  });

  test("refreshes git on reconnect (connection git wins)", async () => {
    const store = new InMemorySessionStore();
    await store.registerBaseline("p1", { manifest: manifest(), baseSnapshotId: "base1", git: git("main") });
    await store.getOrCreateSession("s1", "p1", "base1", git("main"));
    const s2 = await store.getOrCreateSession("s1", "p1", "base1", git("feature")); // same session, new branch
    expect(s2.git?.branch).toBe("feature");
  });

  test("reapIdle removes projects idle past the TTL and keeps fresh ones", async () => {
    const store = new InMemorySessionStore();
    await store.registerBaseline("p1", { manifest: manifest(), baseSnapshotId: "base1" });
    expect(await store.listProjectIds()).toEqual(["p1"]);

    // Fresh: nothing reaped.
    expect(await store.reapIdle(60_000)).toEqual([]);
    expect(await store.listProjectIds()).toEqual(["p1"]);

    // Idle 2 min vs a 1 min TTL (now pushed into the future): reaped.
    const reaped = await store.reapIdle(60_000, Date.now() + 120_000);
    expect(reaped).toEqual(["p1"]);
    expect(await store.listProjectIds()).toEqual([]);
  });

  test("recordApply keeps a watched project alive against reaping", async () => {
    const store = new InMemorySessionStore();
    await store.registerBaseline("p1", { manifest: manifest(), baseSnapshotId: "base1" });
    await store.getOrCreateSession("s1", "p1", "base1");
    await store.recordApply("s1", 1, "snap1");
    // An apply just bumped lastActiveAt, so a TTL larger than the (tiny) elapsed time spares it.
    expect(await store.reapIdle(60_000)).toEqual([]);
  });
});
