import type { ChangeEvent, Finding } from "@arcane/shared";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../tui/store";

// Regression guard on the render-data path: the Store bridges (non-React) Collector + WsClient
// events into the Ink tree via useSyncExternalStore. The Ink rendering itself is verified by eye
// (hard to assert), but the event → snapshot flow that M1B/M1C touch is covered here.

function makeStore() {
  return new Store({
    root: "/tmp/x",
    sessionId: "00000000-0000-0000-0000-0000000000aa",
    events: [],
    phase: null,
    conn: "connecting",
    journalDepth: 0,
    resync: false,
    scores: [],
    findings: [],
    showScores: true,
  });
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    dimension: "complexity",
    severity: "medium",
    ruleId: "complexity/cyclomatic",
    message: "m",
    file: "a.ts",
    range: { startLine: 1, startCol: 1, endLine: 2, endCol: 1 },
    fixable: false,
    ...over,
  };
}

const sampleEvent: ChangeEvent = {
  eventId: "00000000-0000-0000-0000-0000000000bb",
  sessionId: "00000000-0000-0000-0000-0000000000aa",
  projectId: "00000000-0000-0000-0000-0000000000c0",
  parentSnapshotId: "00000000-0000-0000-0000-0000000000d2",
  seq: 1,
  ts: 1,
  op: "add",
  path: "a.ts",
};

describe("tui Store", () => {
  it("addEvent appends and produces a NEW snapshot (useSyncExternalStore needs reference change)", () => {
    const store = makeStore();
    const before = store.getSnapshot();
    store.addEvent(sampleEvent);
    const after = store.getSnapshot();
    expect(after).not.toBe(before); // new top-level reference
    expect(after.events).not.toBe(before.events); // new array reference
    expect(after.events).toHaveLength(1);
    expect(after.events[0]?.path).toBe("a.ts");
    expect(before.events).toHaveLength(0); // prior snapshot is immutable
  });

  it("setPhase and setConn update only their field", () => {
    const store = makeStore();
    store.setPhase("analyzing");
    expect(store.getSnapshot().phase).toBe("analyzing");
    store.setConn("open");
    expect(store.getSnapshot().conn).toBe("open");
    expect(store.getSnapshot().phase).toBe("analyzing"); // unaffected
  });

  it("setJournalDepth updates the badge and no-ops when unchanged", () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setJournalDepth(3);
    expect(store.getSnapshot().journalDepth).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setJournalDepth(3); // same value → no re-render
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.addEvent(sampleEvent);
    store.setPhase("done");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.setConn("closed");
    expect(listener).toHaveBeenCalledTimes(2); // no further calls
  });

  it("returns a stable snapshot reference between reads with no mutation", () => {
    const store = makeStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("upsertScore replaces a dimension in place and keeps scores sorted (M1C)", () => {
    const store = makeStore();
    store.upsertScore({ dimension: "secrets", value: 70, delta: -30 });
    store.upsertScore({ dimension: "complexity", value: 92, delta: -8 });
    store.upsertScore({ dimension: "complexity", value: 78, delta: -22 }); // replace, not append
    const { scores } = store.getSnapshot();
    expect(scores.map((s) => s.dimension)).toEqual(["complexity", "secrets"]); // sorted
    expect(scores.find((s) => s.dimension === "complexity")?.value).toBe(78);
  });

  it("beginFrame clears stale findings so a new analysis frame is a clean set (M1C)", () => {
    const store = makeStore();
    store.addFinding(finding(), true);
    store.addFinding(finding({ id: "f2" }), false);
    expect(store.getSnapshot().findings).toHaveLength(2);
    store.beginFrame();
    expect(store.getSnapshot().findings).toHaveLength(0);
  });

  it("addFinding records the is_new verdict for rendering the NEW tag (M1C)", () => {
    const store = makeStore();
    store.addFinding(finding(), true);
    const row = store.getSnapshot().findings[0];
    expect(row?.isNew).toBe(true);
    expect(row?.dimension).toBe("complexity");
  });

  it("toggleScores flips the score-panel visibility (the `d` key, M1C)", () => {
    const store = makeStore();
    expect(store.getSnapshot().showScores).toBe(true);
    store.toggleScores();
    expect(store.getSnapshot().showScores).toBe(false);
  });
});
