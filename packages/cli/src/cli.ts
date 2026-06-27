import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ChangeEventSchema, type ChangeEvent } from "@arcane/shared";
import { WebSocket } from "ws";
import { login, readToken } from "./auth/token";
import { cloudHttpBase, cloudWsIngest } from "./cloud";
import { Collector } from "./collector";
import { hashBuffer, initHasher } from "./collector/hash";
import { Journal } from "./journal";
import { link } from "./link";
import { loadSession, type LinkInfo } from "./session";
import { WsClient } from "./transport/ws-client";
import { mountTui } from "./tui/render";
import { Store } from "./tui/store";

// @arcane/cli — the thin client (Build Guide Lane A). It NEVER analyzes or runs user code
// (invariant §16.1): it watches a repo, normalizes ORDERED ChangeEvents (§3A), streams them over a
// token-gated WS to the cloud, journals them until acked (§3A.3), and renders the cloud's pipeline
// `state` in an Ink TUI. M1B commands: `login`, `link`, `watch` (bare `arcane` = watch the cwd), and
// the `sendtest` one-shot. Everything else is "not available in this milestone".

// --- `arcane login` — STUB auth: fetch the dev token, store in ~/.arcane (§18) ---

async function loginCmd(): Promise<void> {
  try {
    await login(cloudHttpBase());
    console.log("✓ logged in (token saved to ~/.arcane)");
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    console.error("  is the cloud running? start it with: npm run cloud");
    process.exit(1);
  }
}

// --- `arcane link [path]` — establish a project + baseSnapshot for the shadow worktree (§3A.4) ---

async function linkCmd(target: string): Promise<void> {
  const root = resolve(target);
  const token = readToken();
  if (!token) {
    console.error("✗ not logged in — run `arcane login` first");
    process.exit(1);
  }
  try {
    const info = await link(root, cloudHttpBase(), token);
    console.log(`✓ linked ${root}`);
    console.log(`  project       ${info.projectId}`);
    console.log(`  baseSnapshot  ${info.baseSnapshotId}`);
    console.log("  run `arcane watch` to start streaming changes");
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}

// --- `arcane watch [path]` — collector → token-gated gateway → TUI, with the journal (M1B) ---

function loadLinkOrExit(root: string): LinkInfo {
  try {
    return loadSession(root);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return process.exit(1);
  }
}

async function watch(target: string, noColor: boolean): Promise<void> {
  const root = resolve(target);
  const token = readToken();
  if (!token) {
    console.error("✗ not logged in — run `arcane login` first");
    process.exit(1);
  }
  const session = loadLinkOrExit(root);
  const journal = new Journal(root, session.sessionId, session.baseSnapshotId);

  const store = new Store({
    root,
    sessionId: session.sessionId,
    events: [],
    phase: null,
    conn: "connecting",
    journalDepth: journal.depth(),
  });

  const ws = new WsClient({
    url: cloudWsIngest(token),
    onResult: (ev) => {
      // M1B: the gateway echoes session-scoped `state` events; drive the pipeline stepper.
      if (ev.kind === "state") store.setPhase(ev.phase);
    },
    onAck: (ack) => {
      // Acks drive the journal: drop covered events, advance the parent snapshot (§3A.3).
      journal.onAck(ack);
      store.setJournalDepth(journal.depth());
    },
    onState: (s) => store.setConn(s),
  });

  const collector = new Collector({
    root,
    onChange: (change, seq) => {
      // Build the wire envelope (§3A.2) onto the journal's current parent snapshot, journal it, then
      // stream it. The journal keeps it until an ack covers its seq.
      const ev: ChangeEvent = {
        eventId: randomUUID(),
        sessionId: session.sessionId,
        projectId: session.projectId,
        parentSnapshotId: journal.parentSnapshot,
        seq,
        ts: Date.now(),
        ...change,
      };
      journal.append(ev);
      store.addEvent(ev);
      store.setJournalDepth(journal.depth());
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

// --- `arcane sendtest [path]` — a real one-shot M1B round-trip (login → link → one event → ack) ---

async function sendtest(target: string): Promise<void> {
  const root = resolve(target);
  const httpBase = cloudHttpBase();
  try {
    await login(httpBase);
  } catch (err) {
    console.error(`✗ login failed: ${(err as Error).message}`);
    console.error("  is the cloud running? start it with: npm run cloud");
    process.exit(1);
  }
  const token = readToken();
  if (!token) {
    console.error("✗ login did not yield a token");
    process.exit(1);
  }

  const info = await link(root, httpBase, token);
  console.log(
    `→ linked project ${info.projectId.slice(0, 8)} (baseSnapshot ${info.baseSnapshotId.slice(0, 8)})`,
  );

  await initHasher();
  const content = "export const hello = 'arcane';\n";
  const bytes = Buffer.from(content, "utf8");
  const event: ChangeEvent = ChangeEventSchema.parse({
    eventId: randomUUID(),
    sessionId: info.sessionId,
    projectId: info.projectId,
    parentSnapshotId: info.baseSnapshotId,
    seq: 1,
    ts: Date.now(),
    op: "add",
    path: "arcane-sendtest.txt",
    contentHash: hashBuffer(bytes),
    sizeBytes: bytes.length,
    encoding: "utf8",
    content,
  });

  const ws = new WebSocket(cloudWsIngest(token));
  const timeout = setTimeout(() => {
    console.error("✗ timed out waiting for an Ack");
    ws.close();
    process.exit(1);
  }, 5_000);

  ws.on("open", () => {
    console.log(
      `→ ChangeEvent eventId=${event.eventId} seq=${event.seq} op=${event.op} path=${event.path}`,
    );
    ws.send(JSON.stringify(event));
  });

  ws.on("message", (data) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    // The Ack proves the event was applied to the shadow worktree (the state walk is cosmetic).
    if (payload && typeof payload === "object" && "ackSeq" in payload) {
      clearTimeout(timeout);
      console.log("← AckEvent:");
      console.log(JSON.stringify(payload, null, 2));
      console.log("✓ round-trip OK (event applied + acked)");
      ws.close();
      process.exit(0);
    }
  });

  ws.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`✗ socket error: ${err.message}`);
    console.error("  is the cloud running? start it with: npm run cloud");
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
    case "login":
      void loginCmd();
      return;
    case "link":
      void linkCmd(args[1] ?? process.cwd());
      return;
    case "sendtest":
      void sendtest(args[1] ?? process.cwd());
      return;
    default:
      console.error(
        `"${cmd}": not available in this milestone (M1B). Try: arcane login | link | watch [path]`,
      );
      process.exit(2);
  }
}

main();
