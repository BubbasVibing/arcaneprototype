import { describe, expect, test } from "bun:test";
import type { ResultEvent } from "@arcane/shared";
import {
  deregisterRunStream,
  pushToRunStream,
  registerRunStream,
  runStreamSubscriberCount,
} from "../run-stream";

// M3D-3 PURE run-stream registry logic — no DB, no Docker. Proves the read-only results channel is
// SCOPED: a terminal only ever receives events for the runSessionId it registered, never another
// session's (the cross-session/cross-project leakage guard), and that sockets are cleaned up.

function fakeSocket() {
  const sent: ResultEvent[] = [];
  return { sent, send: (s: string) => sent.push(JSON.parse(s) as ResultEvent) };
}

const state = (sessionId: string, phase: "running" | "done"): ResultEvent => ({
  kind: "state",
  sessionId,
  phase,
  runId: "run-1",
});

describe("run-stream registry", () => {
  test("delivers a run's events only to sockets registered for that runSessionId", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    registerRunStream("sess-A", a);
    registerRunStream("sess-B", b);

    pushToRunStream("sess-A", [state("sess-A", "running"), state("sess-A", "done")]);

    expect(a.sent.map((e) => e.kind === "state" && e.phase)).toEqual(["running", "done"]);
    expect(b.sent).toHaveLength(0); // B's run never bleeds onto A's socket and vice-versa

    deregisterRunStream("sess-A", a);
    deregisterRunStream("sess-B", b);
  });

  test("fans one run to multiple terminals watching the same runSessionId", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    registerRunStream("sess-X", a);
    registerRunStream("sess-X", b);
    expect(runStreamSubscriberCount("sess-X")).toBe(2);

    pushToRunStream("sess-X", [state("sess-X", "running")]);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);

    deregisterRunStream("sess-X", a);
    deregisterRunStream("sess-X", b);
    expect(runStreamSubscriberCount("sess-X")).toBe(0);
  });

  test("push to an unknown / unsubscribed runSessionId is a harmless no-op", () => {
    expect(() => pushToRunStream("nobody-here", [state("nobody-here", "done")])).not.toThrow();
    expect(runStreamSubscriberCount("nobody-here")).toBe(0);
  });

  test("a broken socket is dropped, not allowed to throw out of the push", () => {
    const good = fakeSocket();
    const broken = {
      send: () => {
        throw new Error("socket closed");
      },
    };
    registerRunStream("sess-Y", broken);
    registerRunStream("sess-Y", good);

    expect(() => pushToRunStream("sess-Y", [state("sess-Y", "running")])).not.toThrow();
    expect(good.sent).toHaveLength(1); // the good socket still got it
    expect(runStreamSubscriberCount("sess-Y")).toBe(1); // the broken one was dropped

    deregisterRunStream("sess-Y", good);
  });
});
