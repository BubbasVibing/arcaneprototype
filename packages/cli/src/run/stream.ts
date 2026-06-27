import { ResultEventSchema, type ResultPhase, type RunReport } from "@arcane/shared";
import { WebSocket } from "ws";
import { cloudWsRunStream } from "../cloud";

// M3D-3 — the CLI side of the run-stream channel. A ONE-SHOT reader (a run is a finite job, so no
// reconnect/journal like `watch`): open /run/stream, parse the run's ResultEvents, drive the caller's
// handlers, and resolve when the run reaches `done` (or an idle timeout). The CLI only reads — it
// never sends a frame, so this socket can never trigger or authorize a run (§16.1; the gate is /run).

export interface RunStreamResult {
  report: RunReport | null; // the final RunReport (kind:'run'), or null if it never arrived
  completed: boolean; // true iff the run reached the `done` phase before the socket closed/timed out
}

export interface RunStreamHandlers {
  onPhase?: (phase: ResultPhase) => void; // a run lifecycle phase (running/measuring/done)
  onReport?: (report: RunReport) => void; // the final report (arrives just before `done`)
}

// Stream one run to completion. `idleTimeoutMs` bounds the wait between events (the measuring phase is
// a multi-second gap with no frames), after which we give up and resolve with whatever we have.
export function streamRun(
  token: string,
  runSessionId: string,
  runId: string,
  handlers: RunStreamHandlers,
  opts: { idleTimeoutMs?: number } = {},
): Promise<RunStreamResult> {
  const idleMs = opts.idleTimeoutMs ?? 120_000;
  return new Promise<RunStreamResult>((resolve) => {
    const ws = new WebSocket(cloudWsRunStream(token, runSessionId));
    let report: RunReport | null = null;
    let completed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ report, completed });
    };
    const bumpIdle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    };

    ws.on("open", bumpIdle);
    ws.on("message", (data) => {
      bumpIdle();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const res = ResultEventSchema.safeParse(parsed);
      if (!res.success) return;
      const ev = res.data;
      // Defensive: ignore any event tagged for a different run (the socket is already runSessionId-scoped).
      if ("runId" in ev && ev.runId && ev.runId !== runId) return;
      if (ev.kind === "run") {
        report = ev.report;
        handlers.onReport?.(ev.report);
      } else if (ev.kind === "state") {
        handlers.onPhase?.(ev.phase);
        if (ev.phase === "done") {
          completed = true;
          finish(); // the run is over — the report (if any) already arrived just before this
        }
      }
    });
    ws.on("error", finish); // cloud unreachable / socket error → resolve with what we have
    ws.on("close", finish);
  });
}
