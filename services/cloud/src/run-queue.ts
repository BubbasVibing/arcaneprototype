import type { ResultEvent, ResultPhase, RunReport } from "@arcane/shared";
import {
  claimNextRun,
  getProjectOrgId,
  insertResultEvents,
  markRunDone,
  markRunError,
  reapOldRuns,
} from "./db/repository";
import type { RunJob } from "./db/repository";
import { authorizeExecution } from "./run-gate";
import { runDelta } from "./runtime/delta-engine";
import type { SessionStore } from "./session-store";

// M3D — the cold-path run worker. Claims gated run jobs from Postgres (Q3) and executes them via the
// proven M3C engine, streaming the lifecycle (queued→running→measuring→run→done) + the final RunReport.
// DECOUPLED from the hot static fan-out: a slow run never blocks /ingest analysis (runDelta awaits docker
// subprocess I/O, so the event loop stays free). The gate is RE-ASSERTED here, at the point of execution.

const RUN_TTL_MS = 60 * 60 * 1000; // reap finished run rows (heavy two-tree jsonb) after 1h
const REAP_INTERVAL_MS = 15 * 60 * 1000;

// Best-effort fan-out of a run's lifecycle events: durable result_events rows → Supabase Realtime (web)
// and (M3D-3) the CLI run-stream socket. Logs + swallows so a fan-out failure never derails the worker.
export async function fanOutRun(
  projectId: string,
  sessionId: string,
  events: ResultEvent[],
): Promise<void> {
  try {
    await insertResultEvents({ projectId, sessionId, snapshotId: null, events });
  } catch (e) {
    console.error("run fan-out failed:", e);
  }
}

function stateEv(sessionId: string, phase: ResultPhase, runId: string): ResultEvent {
  return { kind: "state", sessionId, phase, runId };
}

// Honest no-data report for refusal/failure paths (§16.15 — never "0 / clean").
function noDataReport(job: RunJob, reason: string): RunReport {
  return {
    workload: job.workloadName,
    baselineRef: job.baselineRef,
    currentRef: job.currentRef,
    confidence: "low",
    summary: `No runtime data — ${reason}.`,
    status: "no-data",
    skipped: [reason],
  };
}

// Process ONE claimed run. Re-asserts Gates 0/A/B against CURRENT config (the gate at the point of
// EXECUTION — config may have changed/vanished since enqueue, and a directly-inserted row never passed
// the endpoint), runs the engine, streams the report. Never throws — failures → job error + no-data.
async function processRun(store: SessionStore, job: RunJob): Promise<void> {
  const { projectId, sessionId, id: runId } = job;
  try {
    await fanOutRun(projectId, sessionId, [stateEv(sessionId, "running", runId)]);

    // Re-assert at claim: reload the AUTHORITATIVE config + owner org. Fail closed if absent/changed.
    const baseline = await store.getBaseline(projectId);
    const config = baseline?.config;
    const projectOrgId = await getProjectOrgId(projectId);
    const auth = authorizeExecution({ projectOrgId, config, workloadName: job.workloadName });
    if (!auth.ok) {
      const report = noDataReport(job, `refused at claim: ${auth.reason}`);
      await fanOutRun(projectId, sessionId, [
        { kind: "run", report, runId },
        stateEv(sessionId, "done", runId),
      ]);
      await markRunError(runId, auth.reason);
      return;
    }

    await fanOutRun(projectId, sessionId, [stateEv(sessionId, "measuring", runId)]);

    const result = await runDelta({
      config,
      runId,
      workload: job.workloadName,
      command: auth.argv, // SERVER-DERIVED argv — never from the request
      baselineRef: job.baselineRef,
      currentRef: job.currentRef,
      baselineFiles: job.baselineFiles,
      currentFiles: job.currentFiles,
      // network/timeout are derived from config inside measureSingle — never from the request
    });

    await fanOutRun(projectId, sessionId, [
      { kind: "run", report: result.report, runId },
      stateEv(sessionId, "done", runId),
    ]);
    await markRunDone(runId, result.report);
  } catch (e) {
    const reason = (e as Error).message;
    await fanOutRun(projectId, sessionId, [
      { kind: "run", report: noDataReport(job, `run failed: ${reason}`), runId },
      stateEv(sessionId, "done", runId),
    ]);
    await markRunError(runId, reason);
  }
}

// Claim + process one queued run. Returns true if a job was processed, false if the queue was empty.
// Exported so tests drive the worker deterministically (no background loop).
export async function runOnce(store: SessionStore): Promise<boolean> {
  const job = await claimNextRun();
  if (!job) return false;
  await processRun(store, job);
  return true;
}

// The boot worker: a poll loop draining the queue one run at a time (concurrency cap = 1). Returns a
// stop fn. Decoupled from the hot path — runs await docker I/O, never blocking static analysis.
export function startRunWorker(store: SessionStore, opts?: { intervalMs?: number }): () => void {
  const intervalMs = opts?.intervalMs ?? 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      while (!stopped && (await runOnce(store))) {
        /* drain queued runs sequentially */
      }
    } catch (e) {
      console.error("run worker tick error:", e);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  const reaper = setInterval(() => void reapOldRuns(RUN_TTL_MS).catch(() => {}), REAP_INTERVAL_MS);
  reaper.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(reaper);
  };
}
