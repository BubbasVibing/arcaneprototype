import { randomUUID } from "node:crypto";
import type { ResultEvent } from "@arcane/shared";
import { RunRequestSchema } from "@arcane/shared";
import { defaultExecutionTokenForbidden } from "./auth";
import { enqueueRun, ensureSession, getProjectOrgId } from "./db/repository";
import { authorizeExecution, checkConsent } from "./run-gate";
import { fanOutRun } from "./run-queue";
import type { SessionStore } from "./session-store";

// M3D POST /run — the public execution trigger (the first non-test path to running code). CLOUD-
// AUTHORITATIVE consent: every gate is enforced HERE from the config the cloud holds + the server-
// derived argv; the request can only NAME a workload (no command field — see RunRequestSchema). On
// accept the run is ENQUEUED and 202 returned immediately; execution happens in the worker, decoupled
// from this request and from the hot static fan-out. Every refusal is a 4xx + a plain-text reason and
// enqueues NOTHING. Caller (index.ts) has already checked the bearer token.
export async function handleRun(req: Request, store: SessionStore): Promise<Response> {
  // Deployment hardening (§4): refuse the guessable default token for execution in production.
  if (defaultExecutionTokenForbidden()) {
    return new Response(
      "execution refused: the default dev token is not permitted for /run in production — set ARCANE_DEV_TOKEN",
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  // .strict() rejects unknown keys — a `command`/`network`/`timeout` in the body is a 400, NOT ignored.
  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return new Response(`invalid run request: ${detail}`, { status: 400 });
  }
  const run = parsed.data;

  const config = (await store.getBaseline(run.projectId))?.config;
  const projectOrgId = await getProjectOrgId(run.projectId);

  // Gates 0 (single-tenant) + A (master switch) + B (declared + server-derived argv).
  const auth = authorizeExecution({ projectOrgId, config, workloadName: run.workloadName });
  if (!auth.ok) return new Response(auth.reason, { status: auth.status });

  // Gate C — per-run consent (require_permission is NOT consulted; CLI-UX only).
  const consent = checkConsent({
    consent: run.consent,
    autoGrant: auth.autoGrant,
    ci: run.ci,
    config,
  });
  if (!consent.ok) return new Response(consent.reason, { status: consent.status });

  // All gates passed → enqueue (cold path). Create the run's own session (fan-out anchor), enqueue the
  // job (with the two trees), emit the `queued` phase, and return immediately — execution is deferred.
  const runSessionId = randomUUID();
  await ensureSession(runSessionId, run.projectId, null);
  const runId = await enqueueRun({
    projectId: run.projectId,
    sessionId: runSessionId,
    workloadName: run.workloadName,
    baselineRef: run.baselineRef,
    currentRef: run.currentRef,
    consent: run.consent,
    baselineFiles: run.baselineFiles,
    currentFiles: run.currentFiles,
  });
  const queued: ResultEvent = { kind: "state", sessionId: runSessionId, phase: "queued", runId };
  await fanOutRun(run.projectId, runSessionId, [queued]);

  return Response.json({ runId, runSessionId }, { status: 202 });
}
