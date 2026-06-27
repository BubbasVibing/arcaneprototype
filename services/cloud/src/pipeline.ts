import { ResultEventSchema, type ChangeEvent, type ResultEvent, type WorkTree } from "@arcane/shared";
import { analyzeWorktree } from "./analyze-core";
import type { WsLike } from "./ingest";
import type { SessionState } from "./session-store";
import { projectDir } from "./shadow-worktree";

// The CLI analysis pipeline (plan M1C / D2a). Runs AFTER the ack in handleIngest's in-order branch,
// serialized per connection. S3a refactor: the source-agnostic analysis body now lives in
// analyze-core.ts (analyzeWorktree) so the GitHub connector can drive the SAME chain; this file is the
// CLI ADAPTER — per-session debounce + the WebSocket sink — over that core. Behavior is unchanged: the
// acked snapshotId is threaded in as source_snapshots.id, and every ResultEvent still tees to the CLI
// socket (here, via onEvent) AND result_events (in the core).

function send(ws: WsLike, event: ResultEvent): void {
  if (ws.readyState !== 1) return; // client disconnected — stop quietly
  ResultEventSchema.parse(event); // self-check the contract before it goes on the wire
  ws.send(JSON.stringify(event));
}

// Per-session trailing debounce + AbortController (M2B): whole-tree project analyzers (semgrep etc.)
// can't run on every keystroke, so coalesce a burst to the latest tree state (§3B.1/§3B.3). The ack
// already went out in handleIngest, so this added latency is post-ack. A newer event aborts the
// in-flight/pending analysis and reschedules.
interface ScheduledAnalysis {
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}
const scheduled = new Map<string, ScheduledAnalysis>();
const DEBOUNCE_MS = 120;

export function scheduleAnalysis(
  ws: WsLike,
  session: SessionState,
  ev: ChangeEvent,
  snapshotId: string,
  workTree?: WorkTree, // live git context for the dashboard's Working-tree card (§3A.5)
): void {
  const existing = scheduled.get(ev.sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.controller.abort(); // supersede a pending or in-flight analysis for this session
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void analyzeAndEmit(ws, session, ev, snapshotId, controller.signal, workTree).finally(() => {
      if (scheduled.get(ev.sessionId)?.controller === controller) scheduled.delete(ev.sessionId);
    });
  }, DEBOUNCE_MS);
  scheduled.set(ev.sessionId, { timer, controller });
}

export async function analyzeAndEmit(
  ws: WsLike,
  session: SessionState,
  ev: ChangeEvent,
  snapshotId: string,
  signal: AbortSignal = new AbortController().signal,
  workTree?: WorkTree,
): Promise<void> {
  // CLI adapter over the shared analysis core (S3a). Build an AnalyzeContext from the watch session +
  // this ChangeEvent: analyze the shadow worktree at projectDir; the changed file(s) are this event's
  // path (+ oldPath on rename — a deleted/renamed-away path reads null in the core and is skipped,
  // exactly as before); the live sink is the CLI socket. The web fan-out is owned by the core.
  const changedPaths = ev.oldPath ? [ev.path, ev.oldPath] : [ev.path];
  await analyzeWorktree({
    projectId: session.projectId,
    sessionId: ev.sessionId,
    snapshotId,
    rootDir: projectDir(session.projectId),
    manifest: [...session.manifest].map(([path, contentHash]) => ({ path, contentHash })),
    changedPaths,
    baseSnapshotId: session.baseSnapshotId,
    config: session.config,
    label: `seq=${ev.seq} ${ev.path}`,
    signal,
    onEvent: (event) => send(ws, event),
    workTree,
  });
}
