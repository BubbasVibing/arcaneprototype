import { describe, expect, it } from "vitest";
import {
  AckEventSchema,
  ChangeEventSchema,
  ResultEventSchema,
  type ChangeEvent,
  type ResultEvent,
} from "../index";

function validChangeBase() {
  return {
    eventId: "00000000-0000-0000-0000-000000000001",
    sessionId: "00000000-0000-0000-0000-0000000000a1",
    // projectId + parentSnapshotId are .uuid() now too (M1B — real link + server snapshots).
    projectId: "00000000-0000-0000-0000-0000000000b1",
    parentSnapshotId: "00000000-0000-0000-0000-0000000000c0",
    seq: 1,
    ts: 1_700_000_000_000,
    op: "add",
    path: "src/example.ts",
  };
}

describe("wire protocol round-trips through @arcane/shared", () => {
  it("parses a valid ChangeEvent (with inline content + idempotency fields)", () => {
    const event: ChangeEvent = {
      ...validChangeBase(),
      op: "add",
      contentHash: "deadbeef",
      encoding: "utf8",
      content: "export const x = 1;\n",
    };
    const parsed = ChangeEventSchema.parse(event);
    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.seq).toBe(1);
    expect(parsed.parentSnapshotId).toBe("00000000-0000-0000-0000-0000000000c0");
  });

  it("rejects an unknown op", () => {
    expect(() => ChangeEventSchema.parse({ ...validChangeBase(), op: "frobnicate" })).toThrow();
  });

  it("parses every ResultEvent kind", () => {
    const kinds: ResultEvent[] = [
      { kind: "state", sessionId: "s", phase: "analyzing" },
      { kind: "score", dimension: "complexity", value: 92, delta: -8 },
      {
        kind: "finding",
        isNew: true,
        finding: {
          id: "f1",
          dimension: "security",
          severity: "high",
          ruleId: "stub",
          message: "STUB",
          file: "src/example.ts",
        },
      },
      {
        kind: "run",
        report: {
          workload: "api-smoke",
          baselineRef: "origin/main",
          currentRef: "working-tree",
          confidence: "high",
          summary: "placeholder",
        },
      },
    ];
    for (const ev of kinds) {
      expect(ResultEventSchema.parse(ev).kind).toBe(ev.kind);
    }
  });

  it("round-trips a ResultEvent through JSON (the wire)", () => {
    const finding: ResultEvent = {
      kind: "finding",
      isNew: true,
      finding: {
        id: "f1",
        dimension: "security",
        severity: "high",
        ruleId: "r",
        message: "m",
        file: "a.ts",
      },
    };
    const parsed = ResultEventSchema.parse(JSON.parse(JSON.stringify(finding)));
    expect(parsed).toEqual(finding);
  });

  it("covers the full pipeline-state phase enum (superset, plan §6)", () => {
    for (const phase of ["detected", "uploading", "queued", "analyzing", "results", "done"]) {
      expect(ResultEventSchema.parse({ kind: "state", sessionId: "s", phase }).kind).toBe("state");
    }
  });

  it("parses an AckEvent (drives the journal)", () => {
    const ack = AckEventSchema.parse({
      sessionId: "00000000-0000-0000-0000-0000000000a1",
      ackSeq: 1,
      acceptedEventIds: ["00000000-0000-0000-0000-000000000001"],
      serverSnapshotId: "00000000-0000-0000-0000-0000000000c1",
    });
    expect(ack.ackSeq).toBe(1);
  });
});
