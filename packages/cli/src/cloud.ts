import type { GitContext } from "@arcane/shared";

// Resolve the cloud endpoints from a single env var. ARCANE_CLOUD_URL is a ws(s) URL (M1A default);
// `link`/`login` need the matching http(s) base, and `watch` needs the authed /ingest WS URL.

const DEFAULT_CLOUD_URL = "ws://127.0.0.1:8787";

// http(s) base for REST (/auth/token, /link) — derived by swapping the ws scheme.
export function cloudHttpBase(): string {
  const u = new URL(process.env.ARCANE_CLOUD_URL ?? DEFAULT_CLOUD_URL);
  u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  u.pathname = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

// The token-gated WS ingest URL for `arcane watch` (§3B.1 /ingest channel). Git context (§3A.5) rides
// along as connection metadata query params (re-read on each (re)connect) rather than a new message
// frame — the server reads them at the upgrade and stores them on the session.
export function cloudWsIngest(token: string, git?: GitContext): string {
  const ws = cloudHttpBase().replace(/^http/, "ws");
  const params = new URLSearchParams({ token });
  if (git?.branch) params.set("branch", git.branch);
  if (git?.headSha) params.set("headSha", git.headSha);
  if (git?.baselineRef) params.set("baselineRef", git.baselineRef);
  if (git?.baselineSha) params.set("baselineSha", git.baselineSha);
  return `${ws}/ingest?${params.toString()}`;
}

// The token-gated, runSessionId-scoped WS for `arcane run`'s live view (M3D-3 /run/stream channel).
// READ-ONLY results: the CLI opens it after the 202 to render this run's streamed events; it never
// sends anything back (the channel cannot trigger or authorize a run).
export function cloudWsRunStream(token: string, runSessionId: string): string {
  const ws = cloudHttpBase().replace(/^http/, "ws");
  const params = new URLSearchParams({ token, runSessionId });
  return `${ws}/run/stream?${params.toString()}`;
}
