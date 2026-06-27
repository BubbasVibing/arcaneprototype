import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ChangeEventSchema, ResultEventSchema, type ChangeEvent } from "@arcane/shared";
import { WebSocket } from "ws";
import { Collector } from "./collector";
import { makeSession } from "./session";
import { WsClient } from "./transport/ws-client";
import { mountTui } from "./tui/render";
import { Store } from "./tui/store";

// @arcane/cli — the thin client (Build Guide Lane A). It NEVER analyzes or runs user code
// (invariant §16.1): it watches a repo, normalizes ORDERED ChangeEvents (§3A), streams them over
// ws, and renders the cloud's pipeline `state` in an Ink TUI. M1A commands: `watch` (and bare
// `arcane`) + the Session-0 `sendtest`. Everything else is "not available in this milestone".

const CLOUD_URL = process.env.ARCANE_CLOUD_URL ?? "ws://127.0.0.1:8787";

// --- `arcane watch [path]` — the real collector → stub gateway → TUI loop (M1A) ---

async function watch(target: string, noColor: boolean): Promise<void> {
  const root = resolve(target);
  const session = makeSession();
  const store = new Store({
    root,
    sessionId: session.sessionId,
    events: [],
    phase: null,
    conn: "connecting",
  });

  const ws = new WsClient({
    url: CLOUD_URL,
    onResult: (ev) => {
      // M1A: the gateway only echoes session-scoped `state` events; drive the pipeline stepper.
      if (ev.kind === "state") store.setPhase(ev.phase);
    },
    onState: (s) => store.setConn(s),
  });

  const collector = new Collector({
    root,
    onChange: (change, seq) => {
      // Build the wire envelope (§3A.2) and stream it. Synchronous from the collector's seq to
      // the send → emission order == seq order (§3A.3). eventId/sessionId are real UUIDs.
      const ev: ChangeEvent = {
        eventId: randomUUID(),
        sessionId: session.sessionId,
        projectId: session.projectId,
        parentSnapshotId: session.parentSnapshotId,
        seq,
        ts: Date.now(),
        ...change,
      };
      store.addEvent(ev);
      store.setPhase("detected"); // optimistic local state until the cloud streams its walk
      ws.send(ev);
    },
  });

  ws.connect();

  let quit = false;
  const cleanup = (): void => {
    if (quit) return;
    quit = true;
    void collector.stop();
    ws.close();
  };

  const tui = mountTui(store, noColor, cleanup);
  try {
    await collector.start();
  } catch (err) {
    tui.unmount();
    console.error("✗ failed to start the watcher:", err);
    process.exit(1);
  }
  await tui.waitUntilExit();
  cleanup();
  process.exit(0);
}

// --- `arcane sendtest` — the Session-0 one-shot round-trip proof (kept; now sees a `state` reply) ---

function buildFakeChangeEvent(): ChangeEvent {
  // eventId + sessionId are real UUIDs now that the schema enforces .uuid() (M1A decision #1).
  return {
    eventId: randomUUID(),
    sessionId: randomUUID(),
    projectId: "project-0",
    parentSnapshotId: "snapshot-0",
    seq: 1,
    ts: Date.now(),
    op: "add",
    path: "src/example.ts",
    contentHash: "0000000000000000",
    encoding: "utf8",
    content: "export const hello = 'arcane';\n",
  };
}

function sendtest(): void {
  const event = ChangeEventSchema.parse(buildFakeChangeEvent()); // validate before sending
  const ws = new WebSocket(CLOUD_URL);

  const timeout = setTimeout(() => {
    console.error(`✗ timed out waiting for a ResultEvent from ${CLOUD_URL}`);
    ws.close();
    process.exit(1);
  }, 5_000);

  ws.on("open", () => {
    console.log(`→ connected to ${CLOUD_URL}`);
    console.log(
      `→ ChangeEvent eventId=${event.eventId} seq=${event.seq} op=${event.op} path=${event.path}`,
    );
    ws.send(JSON.stringify(event));
  });

  ws.on("message", (data) => {
    clearTimeout(timeout);
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      console.error("✗ received a non-JSON reply");
      ws.close();
      process.exit(1);
    }
    const parsed = ResultEventSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("✗ invalid ResultEvent:", parsed.error.issues);
      ws.close();
      process.exit(1);
    }
    // The gateway now streams a `state` phase walk; the first frame proves the round-trip.
    console.log("← ResultEvent:");
    console.log(JSON.stringify(parsed.data, null, 2));
    console.log("✓ round-trip OK");
    ws.close();
    process.exit(0);
  });

  ws.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`✗ socket error: ${err.message}`);
    console.error("  is the cloud stub running? start it with: npm run cloud");
    process.exit(1);
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const noColor = Boolean(process.env.NO_COLOR) || argv.includes("--no-color");
  const args = argv.filter((a) => a !== "--no-color");

  // Bare `arcane` → watch the cwd (Build-Guide §6A: `arcane`/`watch`).
  if (args.length === 0) {
    void watch(process.cwd(), noColor);
    return;
  }

  const cmd = args[0];
  switch (cmd) {
    case "watch":
      void watch(args[1] ?? process.cwd(), noColor);
      return;
    case "sendtest":
      sendtest();
      return;
    default:
      console.error(`"${cmd}": not available in this milestone (M1A). Try: arcane watch [path]`);
      process.exit(2);
  }
}

main();
