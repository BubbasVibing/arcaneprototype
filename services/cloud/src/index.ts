import {
  ChangeEventSchema,
  ResultEventSchema,
  type ResultEvent,
  type ResultPhase,
} from "@arcane/shared";

// Arcane Cloud — M1A STILL-A-STUB gateway (Build Guide §6A). Receives ChangeEvents over a
// WebSocket and, per valid event, echoes an ordered sequence of `state` ResultEvents walking the
// pipeline so the TUI visibly advances. There is NO auth, shadow worktree, queue, analyzer, score
// engine, or persistence here — real ingestion is M1B and analysis is M1C (§3B.1). Run with Bun.

// STUB: the server-pipeline phases (§3B.1) replayed without doing any work. Session-scoped, since
// the `state` variant carries no changeId (Technical-Spec §3B.2 / M1A decision #2).
const PHASES: ResultPhase[] = ["detected", "uploading", "queued", "analyzing", "results", "done"];
const PHASE_DELAY_MS = 120; // visible pacing for the demo, not a real latency model

const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port,
  fetch(req, server) {
    // Upgrade every request to a WebSocket; the CLI streams change events over it.
    if (server.upgrade(req)) return undefined;
    return new Response("Arcane Cloud (stub). Connect over WebSocket.", { status: 426 });
  },
  websocket: {
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        console.error("✗ non-JSON message ignored");
        return;
      }

      // Validate the inbound ChangeEvent against the shared contract (§3A.2).
      const parsed = ChangeEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.error("✗ invalid ChangeEvent:", parsed.error.issues);
        const done: ResultEvent = { kind: "state", sessionId: "unknown", phase: "done" };
        ws.send(JSON.stringify(done));
        return;
      }

      const ev = parsed.data;
      // The idempotency fields round-trip even though nothing consumes them yet (§3A.3).
      console.log(
        `← ChangeEvent eventId=${ev.eventId} seq=${ev.seq} op=${ev.op} path=${ev.path} ` +
          `parentSnapshotId=${ev.parentSnapshotId}`,
      );

      // STUB: no ingestion/analysis. Echo the SESSION pipeline as ordered `state` events, paced so
      // the terminal visibly advances and a round-trip never reads as a hang (Rule 8, invariant §16.10).
      let first = true;
      for (const phase of PHASES) {
        if (!first) await Bun.sleep(PHASE_DELAY_MS);
        first = false;
        if (ws.readyState !== 1) return; // client (TUI) disconnected mid-walk — stop quietly
        const state: ResultEvent = { kind: "state", sessionId: ev.sessionId, phase };
        ResultEventSchema.parse(state); // self-check the contract before sending
        ws.send(JSON.stringify(state));
        console.log(`→ ResultEvent state phase=${phase} (seq=${ev.seq})`);
      }
    },
  },
});

console.log(`Arcane Cloud (stub) listening on ws://127.0.0.1:${server.port}`);
