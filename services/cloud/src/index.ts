import { bearerToken, isValidToken, mintDevToken } from "./auth";
import { handleIngest } from "./ingest";
import { handleLink } from "./link";
import { InMemorySessionStore } from "./session-store";
import { manifestHash } from "./shadow-worktree";

// Arcane Cloud — M1B REAL ingestion gateway (Build Guide §6 Lane E, the M1B sub-step). Turns the
// M1A stub into real cloud ingestion: a stub-token session, `arcane link` materializing a shadow
// worktree, streamed ChangeEvents applied to that worktree and acked, the `state` walk still echoed.
// NO analyzers, score engine, queue, sandbox, AI, or Postgres here — analysis + persistence are
// M1C (§3B.1). State is IN MEMORY (persistence deferred per the M1B decision); the shadow worktree
// is on the server filesystem. Run with Bun.

const store = new InMemorySessionStore();
const port = Number(process.env.PORT ?? 8787);

// Per-connection serialization chain: one `arcane watch` = one WS = one session, so serializing
// every frame on the socket keeps the seq-check from racing concurrent applies into a false gap.
interface IngestConn {
  chain: Promise<void>;
}

const server = Bun.serve<IngestConn>({
  port,
  async fetch(req, server) {
    const url = new URL(req.url);

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

    // `arcane watch` — the WS ingest channel, token-gated at the upgrade.
    if (url.pathname === "/ingest") {
      if (!isValidToken(url.searchParams.get("token"))) {
        return new Response("unauthorized", { status: 401 });
      }
      if (server.upgrade(req, { data: { chain: Promise.resolve() } })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    return new Response("Arcane Cloud (M1B). POST /auth/token, POST /link, WS /ingest.", {
      status: 404,
    });
  },
  websocket: {
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      // Serialize apply+ack per connection (§3A.3 ordering); the state walk inside runs detached.
      ws.data.chain = ws.data.chain
        .then(() => handleIngest(ws, text, store))
        .catch((err: unknown) => console.error("ingest error:", err));
    },
  },
});

console.log(`Arcane Cloud (M1B) listening on http://127.0.0.1:${server.port}  (ws path: /ingest)`);
