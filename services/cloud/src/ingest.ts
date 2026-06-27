import { AckEventSchema, ChangeEventSchema, type AckEvent } from "@arcane/shared";
import { analyzeAndEmit } from "./pipeline";
import type { SessionStore } from "./session-store";
import { applyToShadow } from "./shadow-worktree";

// Server pipeline ingest (Technical-Spec §3B.1): validate · seq-check · apply patch to the shadow
// worktree · ack · analyze. M1C completes the pipe: after an in-order apply is acked, the real
// analysis pipeline (pipeline.ts) runs the analyzers, scores, persists, and streams `finding`/
// `score`/`state` events. The ack still goes out BEFORE analysis (the "well under a second" gate,
// §6 E1); analysis is awaited in the per-connection chain so applies/analyses can't race.

// A structural view of a Bun ServerWebSocket — keeps ingest decoupled + unit-testable.
export interface WsLike {
  send(data: string): number | void;
  readyState: number;
}

function sendAck(ws: WsLike, ack: AckEvent): void {
  AckEventSchema.parse(ack); // self-check the contract before it goes on the wire
  ws.send(JSON.stringify(ack));
}

// Handle ONE inbound frame. Call this serialized per connection (see index.ts) so concurrent frames
// can't race the seq-check into a false gap. Returns after the ack; the state walk runs detached.
export async function handleIngest(
  ws: WsLike,
  raw: string,
  store: SessionStore,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error("✗ non-JSON message ignored");
    return;
  }

  const parsed = ChangeEventSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("✗ invalid ChangeEvent:", parsed.error.issues);
    return;
  }
  const ev = parsed.data;

  let session;
  try {
    session = await store.getOrCreateSession(ev.sessionId, ev.projectId, ev.parentSnapshotId);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return;
  }

  if (ev.seq === session.appliedSeq + 1) {
    // In-order: apply the patch, advance the cursor, ack the contiguous seq.
    let snapshotId: string;
    try {
      snapshotId = await applyToShadow(session, ev);
    } catch (err) {
      console.error(`✗ apply failed seq=${ev.seq} ${ev.op} ${ev.path}:`, (err as Error).message);
      return;
    }
    await store.recordApply(ev.sessionId, ev.seq, snapshotId);
    sendAck(ws, {
      sessionId: ev.sessionId,
      ackSeq: ev.seq,
      acceptedEventIds: [ev.eventId],
      serverSnapshotId: snapshotId,
    });
    console.log(
      `← seq=${ev.seq} ${ev.op} ${ev.path} → applied · ack ackSeq=${ev.seq} snapshot=${snapshotId.slice(0, 8)}`,
    );
    // Analyze the just-applied snapshot and stream real findings/scores (§3B.1). Awaited in the
    // per-connection chain (index.ts) so the next event can't race this snapshot's analysis; the
    // ack above already went out, so the round-trip stays fast.
    await analyzeAndEmit(ws, session, ev, snapshotId);
  } else if (ev.seq <= session.appliedSeq) {
    // Duplicate / retry (§3A.3): a resent event the server already applied. No-op, but re-ack so the
    // CLI drops it from the journal. Dedup is by contiguous seq — durable client seq makes a NEW
    // eventId at an old seq a true divergence, which a manifest resync (§3A.4) would heal in M1C.
    sendAck(ws, {
      sessionId: ev.sessionId,
      ackSeq: session.appliedSeq,
      acceptedEventIds: [ev.eventId],
      serverSnapshotId: session.currentSnapshotId,
    });
    console.log(`↺ duplicate seq=${ev.seq} (appliedSeq=${session.appliedSeq}) — re-acked`);
  } else {
    // Gap: seq > appliedSeq + 1 — a hole in the stream. Do NOT apply and do NOT buffer (the CLI
    // journal holds the missing events and replays them contiguously). Ask for a resync from the
    // first missing seq (§3A.3 / §3A.4).
    sendAck(ws, {
      sessionId: ev.sessionId,
      ackSeq: session.appliedSeq,
      acceptedEventIds: [],
      serverSnapshotId: session.currentSnapshotId,
      resyncFrom: session.appliedSeq + 1,
    });
    console.warn(
      `⋯ gap seq=${ev.seq} (expected ${session.appliedSeq + 1}) — resyncFrom=${session.appliedSeq + 1}`,
    );
  }
  // Duplicate/gap branches do not analyze: a duplicate re-acks an already-analyzed snapshot, and a
  // gap is healed by a resync (no new snapshot). Only the in-order branch runs analyzeAndEmit.
}
