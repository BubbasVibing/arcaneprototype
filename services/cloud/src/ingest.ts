import {
  AckEventSchema,
  ChangeEventSchema,
  ResultEventSchema,
  type AckEvent,
  type ResultEvent,
  type ResultPhase,
} from "@arcane/shared";
import type { SessionStore } from "./session-store";
import { applyToShadow } from "./shadow-worktree";

// Server pipeline ingest (Technical-Spec §3B.1): validate · seq-check · apply patch to the shadow
// worktree · ack. M1B STOPS after apply — no blast radius, queue, analyzers, or score (M1C). The
// `state` phase walk is still emitted so the round-trip stays legible (invariant §16.10).
//
// B1 implements the IN-ORDER branch only (seq == appliedSeq + 1). The duplicate (seq <= appliedSeq)
// and gap (seq > appliedSeq + 1 → resyncFrom) branches are B2.

// A structural view of a Bun ServerWebSocket — keeps ingest decoupled + unit-testable.
export interface WsLike {
  send(data: string): number | void;
  readyState: number;
}

const PHASES: ResultPhase[] = ["detected", "uploading", "queued", "analyzing", "results", "done"];
const PHASE_DELAY_MS = 120; // visible pacing for the demo, not a real latency model

function sendAck(ws: WsLike, ack: AckEvent): void {
  AckEventSchema.parse(ack); // self-check the contract before it goes on the wire
  ws.send(JSON.stringify(ack));
}

// Fire-and-forget the cosmetic pipeline walk. NOT awaited by the ingest critical section, so it
// never delays the ack or the next event's apply (the "well under a second" gate, §6 E1).
async function emitStateWalk(ws: WsLike, sessionId: string): Promise<void> {
  let first = true;
  for (const phase of PHASES) {
    if (!first) await Bun.sleep(PHASE_DELAY_MS);
    first = false;
    if (ws.readyState !== 1) return; // client disconnected mid-walk — stop quietly
    const state: ResultEvent = { kind: "state", sessionId, phase };
    ResultEventSchema.parse(state); // self-check the contract before sending
    ws.send(JSON.stringify(state));
  }
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
  } else {
    // STUB: duplicate (seq<=appliedSeq → no-op re-ack) and gap (seq>appliedSeq+1 → resyncFrom) are B2.
    console.warn(
      `⚠ non-contiguous seq=${ev.seq} (appliedSeq=${session.appliedSeq}) — resync handling is B2`,
    );
  }

  void emitStateWalk(ws, ev.sessionId); // detached — legibility only, never blocks the ack
}
