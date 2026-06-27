import type { GitContext } from "@arcane/shared";
import { bearerToken, isValidToken, mintDevToken } from "./auth";
import { handleIngest } from "./ingest";
import { handleLink } from "./link";
import { handleRun } from "./run-endpoint";
import { startRunWorker } from "./run-queue";
import { deregisterRunStream, registerRunStream } from "./run-stream";
import { handleGithubWebhook } from "./github/webhook";
import { InMemorySessionStore } from "./session-store";
import { listShadowProjectDirs, manifestHash, removeProjectDir } from "./shadow-worktree";

// Decode git context (§3A.5) carried as /ingest connection metadata. metadata-only mode / not-a-repo
// sends nothing → undefined. Any param present ⇒ it's a repo (branch/headSha may still be null).
function parseGitParams(url: URL): GitContext | undefined {
  const branch = url.searchParams.get("branch");
  const headSha = url.searchParams.get("headSha");
  const baselineRef = url.searchParams.get("baselineRef");
  const baselineSha = url.searchParams.get("baselineSha");
  if (!branch && !headSha && !baselineRef && !baselineSha) return undefined;
  return {
    isRepo: true,
    branch: branch ?? null,
    headSha: headSha ?? null,
    ...(baselineRef ? { baselineRef } : {}),
    ...(baselineSha ? { baselineSha } : {}),
  };
}

// Arcane Cloud — M1C analysis gateway (Build Guide §6 Lane E). On top of M1B's real ingestion
// (stub-token session, `arcane link` shadow worktree, ordered apply + acks) it now runs the real
// pipeline: an applied ChangeEvent is analyzed (complexity in C1), scored per dimension, persisted
// to Postgres, and streamed back as `finding`/`score`/`state` events (§3B.1). The SYNC cursor stays
// IN MEMORY (InMemorySessionStore); RESULTS persist to Postgres (db/*). No queue/sandbox/AI yet.
// Run with Bun; requires DATABASE_URL (see .env.example) — db/client.ts fails fast without it.

const store = new InMemorySessionStore();
const port = Number(process.env.PORT ?? 8787);
// Bind loopback by default (M3D hardening); HOST=0.0.0.0 opts into all-interfaces for a hosted
// deploy (e.g. Fly, where the platform proxy must reach the container). The token gate + the /run
// prod-default-token refusal (auth.ts) remain the execution guard, so exposing the interface alone
// does not open execution.
const hostname = process.env.HOST ?? "127.0.0.1";

// Per-connection serialization chain: one `arcane watch` = one WS = one session, so serializing
// every frame on the socket keeps the seq-check from racing concurrent applies into a false gap.
interface IngestConn {
  kind: "ingest";
  chain: Promise<void>;
  git?: GitContext; // read once at the upgrade from the /ingest query params (§3A.5)
}
// M3D-3 — a `/run/stream` reader watching ONE run. READ-ONLY: it carries no chain and the socket
// ignores inbound frames; it exists only to be pushed this run's events (run-stream.ts).
interface RunStreamConn {
  kind: "run-stream";
  runSessionId: string;
}
type ConnData = IngestConn | RunStreamConn;

const server = Bun.serve<ConnData>({
  port,
  // M3D deployment hardening: bind loopback by default; HOST=0.0.0.0 opts into all-interfaces for a
  // hosted deploy. Execution stays gated by the token + the /run prod-default-token refusal (auth.ts).
  hostname,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Liveness for the hosting platform (Fly health check): a cheap 200 on / and /healthz so the
    // proxy sees the listener as healthy without needing a token or a DB round-trip.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return new Response("ok", { status: 200 });
    }

    // STUB auth (§18): `arcane login` exchanges nothing and receives the configured dev token.
    if (url.pathname === "/auth/token" && req.method === "POST") {
      return Response.json({ token: mintDevToken() }, { status: 200 });
    }

    // `arcane link` — token-gated REST. Materializes the baseline → { projectId, baseSnapshotId }.
    if (url.pathname === "/link" && req.method === "POST") {
      if (!isValidToken(bearerToken(req))) return new Response("unauthorized", { status: 401 });
      return handleLink(req, store);
    }

    // debug-only (the proof's no-drift assertion hook): the server's current manifest for a session.
    // snapshotId is random and cannot be compared across ends — the manifest/manifestHash can.
    if (url.pathname === "/debug/session" && req.method === "GET") {
      const sid = url.searchParams.get("sessionId");
      const s = sid ? await store.getSession(sid) : undefined;
      if (!s) return new Response("no such session", { status: 404 });
      return Response.json({
        sessionId: s.sessionId,
        projectId: s.projectId,
        appliedSeq: s.appliedSeq,
        currentSnapshotId: s.currentSnapshotId,
        manifestHash: manifestHash(s.manifest),
        git: s.git ?? null,
        files: Object.fromEntries([...s.manifest.entries()].sort()),
      });
    }

    // Manifest resync (§3A.4) — token-gated. The CLI fetches the server's shadow manifest when its
    // journal can no longer replay a requested seq, then diffs against disk and re-emits the delta.
    if (url.pathname === "/resync" && req.method === "GET") {
      if (!isValidToken(bearerToken(req))) return new Response("unauthorized", { status: 401 });
      const sid = url.searchParams.get("sessionId");
      const s = sid ? await store.getSession(sid) : undefined;
      if (!s) return new Response("no such session", { status: 404 });
      return Response.json({
        appliedSeq: s.appliedSeq,
        serverSnapshotId: s.currentSnapshotId,
        files: Object.fromEntries([...s.manifest.entries()].sort()),
      });
    }

    // `arcane run` — M3D public execution trigger, token-gated REST. The cloud is the AUTHORITATIVE
    // consent gate (it runs the code); handleRun enforces all three §19.1 gates + server-derives the argv.
    if (url.pathname === "/run" && req.method === "POST") {
      if (!isValidToken(bearerToken(req))) return new Response("unauthorized", { status: 401 });
      return handleRun(req, store);
    }

    // GitHub App connector (Technical-Spec §13) — a SECOND analysis source, additive to the CLI path.
    // NOT gated by the Arcane dev token: GitHub authenticates each delivery with an HMAC over the body
    // (X-Hub-Signature-256), which handleGithubWebhook verifies against GITHUB_WEBHOOK_SECRET. Disabled
    // (503) until that secret is configured.
    if (url.pathname === "/github/webhook" && req.method === "POST") {
      return handleGithubWebhook(req);
    }

    // `arcane run` live view (M3D-3) — the CLI run-stream WS, token-gated at the upgrade and scoped
    // to one runSessionId. READ-ONLY results: it only receives this run's events (queued→…→done +
    // the RunReport) that fanOutRun pushes; it has NO inbound handling, so it cannot trigger or
    // authorize a run (the execution door is /run alone). A client only ever sees the runSessionId it
    // names (no cross-session/cross-project firehose).
    if (url.pathname === "/run/stream") {
      if (!isValidToken(url.searchParams.get("token"))) {
        return new Response("unauthorized", { status: 401 });
      }
      const runSessionId = url.searchParams.get("runSessionId");
      if (!runSessionId) return new Response("missing runSessionId", { status: 400 });
      if (server.upgrade(req, { data: { kind: "run-stream", runSessionId } })) {
        return undefined;
      }
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    // `arcane watch` — the WS ingest channel, token-gated at the upgrade.
    if (url.pathname === "/ingest") {
      if (!isValidToken(url.searchParams.get("token"))) {
        return new Response("unauthorized", { status: 401 });
      }
      const data: ConnData = { kind: "ingest", chain: Promise.resolve(), git: parseGitParams(url) };
      if (server.upgrade(req, { data })) {
        return undefined;
      }
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    return new Response("Arcane Cloud (M1B). POST /auth/token, POST /link, WS /ingest.", {
      status: 404,
    });
  },
  websocket: {
    // A /run/stream reader registers on open; it is a pure results sink (no inbound handling).
    open(ws) {
      if (ws.data.kind === "run-stream") registerRunStream(ws.data.runSessionId, ws);
    },
    message(ws, raw) {
      // /run/stream is READ-ONLY — drop any client→server frame (it can never trigger a run).
      if (ws.data.kind !== "ingest") return;
      const conn = ws.data; // narrowed to IngestConn (kept through the deferred closure below)
      const text = typeof raw === "string" ? raw : raw.toString();
      // Serialize apply+ack per connection (§3A.3 ordering); the state walk inside runs detached.
      conn.chain = conn.chain
        .then(() => handleIngest(ws, text, store, conn.git))
        .catch((err: unknown) => console.error("ingest error:", err));
    },
    close(ws) {
      if (ws.data.kind === "run-stream") deregisterRunStream(ws.data.runSessionId, ws);
    },
  },
});

console.log(`Arcane Cloud (M1C) listening on http://${hostname}:${server.port}  (ws path: /ingest)`);

// Shadow-worktree reaping (M2A — resolves the M1 `.arcane-shadow/<projectId>` leak).
const IDLE_TTL_MS = 60 * 60 * 1000; // reap a project's worktree after 1h with no link/apply/reconnect
const REAP_INTERVAL_MS = 15 * 60 * 1000; // reaper cadence

// Boot orphan-sweep: the in-memory store is empty on a cold boot, so EVERY dir under SHADOW_ROOT is an
// orphan (its baseline is gone) → remove it; the restart self-heal (§3A.4) re-links live projects.
// NOTE: once a PostgresSessionStore persists baselines, this must reconcile against persisted projects
// instead of "delete all".
async function sweepOrphans(): Promise<void> {
  const live = new Set(await store.listProjectIds());
  let removed = 0;
  for (const projectId of await listShadowProjectDirs()) {
    if (live.has(projectId)) continue;
    await removeProjectDir(projectId);
    removed++;
  }
  if (removed > 0) console.log(`🧹 swept ${removed} orphaned shadow worktree(s) on boot`);
}
await sweepOrphans();

const reaper = setInterval(() => {
  void store.reapIdle(IDLE_TTL_MS).then((reaped) => {
    for (const projectId of reaped) void removeProjectDir(projectId);
    if (reaped.length > 0) console.log(`🧹 reaped ${reaped.length} idle project worktree(s)`);
  });
}, REAP_INTERVAL_MS);
reaper.unref(); // don't keep the process alive for the reaper alone

// M3D cold-path run worker — drains the Postgres run_jobs queue, decoupled from the hot static fan-out.
startRunWorker(store);
console.log("🏃 run worker started (cold-path queue)");
