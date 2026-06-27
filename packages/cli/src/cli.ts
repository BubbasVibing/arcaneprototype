import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ChangeEventSchema, type ChangeEvent } from "@arcane/shared";
import { WebSocket } from "ws";
import { login, readToken } from "./auth/token";
import { cloudHttpBase, cloudWsIngest, dashboardProjectUrl } from "./cloud";
import { buildBaselineSeed, Collector, type LogicalChange } from "./collector";
import { hashBuffer, initHasher } from "./collector/hash";
import { loadIgnoreRules, makeIgnoreMatcher } from "./collector/ignore";
import { loadConfig, type LoadedConfig } from "./config";
import { readGitContext } from "./git";
import { Journal } from "./journal";
import { link } from "./link";
import { manifestResync } from "./resync";
import { run, type RunOptions } from "./run";
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
    const loaded = await loadConfigOrExit(root);
    const metadataOnly = loaded?.config.cloud?.mode === "metadata-only";
    const info = await link(root, cloudHttpBase(), token, {
      projectIgnore: loaded?.config.project?.ignore,
      git: metadataOnly ? undefined : await readGitContext(root, loaded?.config.baseline?.ref),
      config: loaded?.config,
    });
    console.log(`✓ linked ${root}`);
    console.log(`  project       ${info.projectId}`);
    console.log(`  baseSnapshot  ${info.baseSnapshotId}`);
    console.log(`  dashboard     ${dashboardProjectUrl(info.projectId)}`);
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

// Load arcane.toml, exiting 2 on a config error (§4.2). Returns undefined when there is no file.
async function loadConfigOrExit(root: string): Promise<LoadedConfig | undefined> {
  try {
    return await loadConfig(root);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return process.exit(2);
  }
}

async function watch(target: string, noColor: boolean): Promise<void> {
  const root = resolve(target);
  const token = readToken();
  if (!token) {
    console.error("✗ not logged in — run `arcane login` first");
    process.exit(1);
  }
  // `let` because the restart self-heal re-links and swaps both (§3A.4): the collector/ws closures
  // close over these bindings, so reassigning here redirects them to the fresh session + journal.
  let session = loadLinkOrExit(root);
  let journal = new Journal(root, session.sessionId, session.baseSnapshotId);
  const httpBase = cloudHttpBase();

  // arcane.toml drives the ignore set and the git baseline ref.
  const loaded = await loadConfigOrExit(root);
  // One ignore rule set, built once and threaded to the collector AND the manifest-resync disk-diff
  // so all paths observe the identical file set (no drift — the byte-identical proof depends on it).
  const rules = await loadIgnoreRules(root, loaded?.config.project?.ignore);
  const ignore = makeIgnoreMatcher(rules);
  // Git context (§3A.5): re-read on each (re)connect and carried as /ingest query params (not a wire
  // frame). metadata-only mode sends none of it.
  const baselineRef = loaded?.config.baseline?.ref;
  const metadataOnly = loaded?.config.cloud?.mode === "metadata-only";
  // Seed the normalizer with the current baseline fingerprints so a rename/delete of a pre-existing
  // (never-edited-this-session) file is still streamed — otherwise the server's shadow keeps a stale
  // file (drift). Same ignore matcher → identical file set as link/watch/resync.
  const seed = await buildBaselineSeed(root, ignore);

  const store = new Store({
    root,
    sessionId: session.sessionId,
    dashboardUrl: dashboardProjectUrl(session.projectId),
    events: [],
    phase: null,
    conn: "connecting",
    journalDepth: journal.depth(),
    resync: false,
    scores: [],
    findings: [],
    showScores: true,
  });

  // Resync race guard (§3A.4): a manifest resync rewinds the journal's seq counter; collector edits
  // arriving DURING the resync are buffered (raw, no seq allocated) and replayed with fresh
  // contiguous seqs after, so the rewind can never collide with a concurrently-allocated seq.
  let resyncInProgress = false;
  const pendingDuringResync: LogicalChange[] = [];

  const ws = new WsClient({
    url: async () =>
      cloudWsIngest(token, metadataOnly ? undefined : await readGitContext(root, baselineRef)),
    onResult: (ev) => {
      // M1C: the gateway streams `state` (pipeline stepper), plus real `score` + `finding` events.
      if (ev.kind === "state") {
        if (ev.phase === "analyzing") store.beginFrame(); // open a fresh result frame
        store.setPhase(ev.phase);
      } else if (ev.kind === "score") {
        store.upsertScore({ dimension: ev.dimension, value: ev.value, delta: ev.delta });
      } else if (ev.kind === "finding") {
        store.addFinding(ev.finding, ev.isNew);
      }
    },
    onOpen: () => {
      // (Re)connected: replay the unacked tail so the server catches up (dups absorbed, §3A.3).
      const tail = journal.replayUnacked();
      store.setResync(tail.length > 0);
      for (const ev of tail) ws.send(ev);
    },
    onAck: (ack) => {
      // Acks drive the journal: drop covered events, advance the parent snapshot (§3A.3).
      journal.onAck(ack);
      store.setJournalDepth(journal.depth());
      if (ack.resyncFrom !== undefined) {
        // The server detected a gap. Replay from there if the journal still has it; otherwise fall
        // back to a manifest resync (§3A.4).
        store.setResync(true);
        if (journal.has(ack.resyncFrom)) {
          for (const ev of journal.replayUnacked(ack.resyncFrom)) ws.send(ev);
        } else if (!resyncInProgress) {
          resyncInProgress = true; // gate the collector: edits buffer until finishResync()
          void manifestResync(root, httpBase, token, session, journal, (ev) => ws.send(ev), rules)
            .then(finishResync)
            .catch((err: unknown) => {
              console.error("manifest resync failed:", err);
              finishResync(); // still replay buffered edits (a later ack re-resyncs if they gapped)
            });
        }
      } else if (journal.depth() === 0) {
        store.setResync(false); // fully caught up
      }
    },
    onState: (s) => store.setConn(s),
    onRelinkRequired: () => void relink(),
  });

  // Self-heal (§3A.4): the cloud restarted and no longer knows this project (it sent the relink close
  // code). Re-link to mint a fresh project/baseSnapshot/session from current disk, swap in a new
  // journal, and reconnect. The old project's unacked events are abandoned (the fresh link already
  // recaptured the working tree); edits during the brief relink window are likewise covered by that
  // fresh baseline. Full sync-layer durability (baselines surviving restart) stays deferred.
  let relinking = false;
  const relink = async (): Promise<void> => {
    if (relinking) return;
    relinking = true;
    store.setResync(true);
    try {
      session = await link(root, httpBase, token, {
        rules,
        git: metadataOnly ? undefined : await readGitContext(root, baselineRef),
        config: loaded?.config,
      });
      journal = new Journal(root, session.sessionId, session.baseSnapshotId);
      store.setJournalDepth(journal.depth());
      console.error("↻ re-linked after cloud restart — resuming watch");
    } catch (err) {
      console.error("✗ relink failed:", (err as Error).message);
    } finally {
      relinking = false;
    }
    ws.connect(); // reconnect with the new session; onOpen replays the (now-empty) journal
  };

  // Single send funnel for a collector edit: build the wire envelope (§3A.2) onto the journal's
  // current parent snapshot, journal it (kept until acked), then stream it.
  const emitChange = (change: LogicalChange, seq: number): void => {
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
  };

  // Drain edits buffered during a resync with fresh, contiguous seqs, then reopen the gate. Runs
  // synchronously in the resync's .then/.catch (no collector timer can interleave before the flag
  // flips back), so the buffered edits land right after the resync deltas without a gap.
  const finishResync = (): void => {
    for (const change of pendingDuringResync.splice(0)) emitChange(change, journal.allocSeq());
    resyncInProgress = false;
    store.setJournalDepth(journal.depth());
  };

  const collector = new Collector({
    root,
    ignore,
    seed, // baseline fingerprints → pre-existing deletes/renames stream correctly (no drift)
    // The journal is the single, durable seq authority (§3A.3) — but NOT while a resync is rewinding
    // its counter. During a resync we hand out no journal seq; the edit is buffered and replayed
    // (with a fresh seq) by finishResync().
    nextSeq: () => (resyncInProgress ? -1 : journal.allocSeq()),
    onChange: (change, seq) => {
      if (resyncInProgress) {
        pendingDuringResync.push(change);
        return;
      }
      emitChange(change, seq);
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

  const loaded = await loadConfigOrExit(root);
  const metadataOnly = loaded?.config.cloud?.mode === "metadata-only";
  const info = await link(root, httpBase, token, {
    projectIgnore: loaded?.config.project?.ignore,
    git: metadataOnly ? undefined : await readGitContext(root, loaded?.config.baseline?.ref),
    config: loaded?.config,
  });
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

// Parse `run [workload] --compare --baseline <ref> --yes`. A bad flag/extra arg exits 2 (usage).
function parseRunArgs(rest: string[], noColor: boolean): RunOptions {
  const opts: RunOptions = { compare: false, yes: false, noColor };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--compare") opts.compare = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--baseline") {
      const ref = rest[++i];
      if (!ref) {
        console.error("✗ --baseline needs a ref, e.g. `--baseline origin/main`");
        process.exit(2);
      }
      opts.baseline = ref;
    } else if (a.startsWith("--baseline=")) {
      opts.baseline = a.slice("--baseline=".length);
    } else if (a.startsWith("-")) {
      console.error(`✗ unknown flag: ${a}`);
      process.exit(2);
    } else if (opts.workload === undefined) {
      opts.workload = a;
    } else {
      console.error(`✗ unexpected argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
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
    case "run":
      void run(process.cwd(), parseRunArgs(args.slice(1), noColor));
      return;
    case "sendtest":
      void sendtest(args[1] ?? process.cwd());
      return;
    default:
      console.error(
        `"${cmd}": not a known command. Try: arcane login | link | watch [path] | run <workload> --compare`,
      );
      process.exit(2);
  }
}

main();
