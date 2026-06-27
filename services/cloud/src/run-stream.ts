import type { ResultEvent } from "@arcane/shared";

// M3D-3 — the CLI run-stream registry: the in-memory sink the M1D fan-out anticipated (run-queue.ts:24
// "durable result_events rows → Supabase Realtime (web) and (M3D-3) the CLI run-stream socket"). It
// holds the `/run/stream` sockets a terminal opened to watch ONE run, keyed by runSessionId. `fanOutRun`
// writes the durable result_events rows (→ WAL → Realtime → web) AND calls pushToRunStream with the
// SAME events (→ the terminal) — one event, both surfaces, in lockstep (Invariant 4).
//
// READ-ONLY results channel: this module only PUSHES server→client. The /run/stream socket has no
// inbound handling (index.ts ignores client frames), so it can neither trigger nor authorize a run —
// it streams an already-accepted run's events, nothing more. Scoping: a socket only ever receives the
// events pushed for the runSessionId it subscribed to (no cross-session/cross-project firehose).

// The minimum we need from a Bun ServerWebSocket — avoids coupling to index.ts's connection-data union.
interface PushSocket {
  send(data: string): unknown;
}

const sockets = new Map<string, Set<PushSocket>>();

export function registerRunStream(runSessionId: string, ws: PushSocket): void {
  let set = sockets.get(runSessionId);
  if (!set) {
    set = new Set();
    sockets.set(runSessionId, set);
  }
  set.add(ws);
}

export function deregisterRunStream(runSessionId: string, ws: PushSocket): void {
  const set = sockets.get(runSessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sockets.delete(runSessionId);
}

// Push a run's events to every terminal subscribed to that runSessionId — the SAME events fanOutRun
// just persisted for the web. ONE frame per ResultEvent (the CLI parses one event per message, like
// the /ingest result stream). Best-effort: a dead socket is dropped, never throws (a fan-out failure
// must never derail the worker).
export function pushToRunStream(runSessionId: string, events: ResultEvent[]): void {
  const set = sockets.get(runSessionId);
  if (!set || set.size === 0) return;
  for (const ev of events) {
    const frame = JSON.stringify(ev);
    for (const ws of set) {
      try {
        ws.send(frame);
      } catch {
        set.delete(ws); // a closed/broken socket — drop it
      }
    }
  }
}

// Test/diagnostic hook: how many terminals are watching a runSessionId (0 if none).
export function runStreamSubscriberCount(runSessionId: string): number {
  return sockets.get(runSessionId)?.size ?? 0;
}
