import {
  AckEventSchema,
  ChangeEventSchema,
  RELINK_CLOSE_CODE,
  type AckEvent,
  type GitContext,
} from "@arcane/shared";
import { scheduleAnalysis } from "./pipeline";
import type { SessionStore } from "./session-store";
import { applyToShadow } from "./shadow-worktree";

// Server pipeline ingest (Technical-Spec §3B.1): validate · seq-check · apply patch to the shadow
// worktree · ack · analyze. After an in-order apply is acked, the analysis pipeline (pipeline.ts)
// runs the analyzers, scores, persists, and streams `finding`/`score`/`state` events. The ack goes
// out BEFORE analysis (the "well under a second" gate, §6 E1); analysis is then SCHEDULED (debounced
// per session, M2B) so a burst coalesces to the latest tree state — applies stay serialized on the
// per-connection chain, analysis rides behind the ack.

// A structural view of a Bun ServerWebSocket — keeps ingest decoupled + unit-testable.
export interface WsLike {
  send(data: string): number | void;
  readyState: number;
  close?(code?: number, reason?: string): void; // used only for the relink self-heal signal
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
  connGit?: GitContext, // git context from the /ingest connection query params (§3A.5)
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
    session = await store.getOrCreateSession(
      ev.sessionId,
      ev.projectId,
      ev.parentSnapshotId,
      connGit,
    );
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`✗ ${msg}`);
    // Unknown project (the server restarted and lost its in-memory baseline) → signal the CLI to
    // re-link via an application close code, NOT a new wire frame. The CLI auto-relinks + reconnects
    // (§3A.4 self-heal). Without this the CLI would replay its journal into a void forever.
    if (msg.includes("unknown project")) ws.close?.(RELINK_CLOSE_CODE, "relink");
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
    // Analyze the just-applied snapshot and stream real findings/scores (§3B.1). Debounced per
    // session (M2B) so a burst coalesces to the latest tree state before the whole-tree project
    // analyzers run; the ack above already went out, so the round-trip stays fast.
    scheduleAnalysis(ws, session, ev, snapshotId);
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
