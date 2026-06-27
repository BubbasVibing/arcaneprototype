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

// The token-gated WS ingest URL for `arcane watch` (§3B.1 /ingest channel).
export function cloudWsIngest(token: string): string {
  const ws = cloudHttpBase().replace(/^http/, "ws");
  return `${ws}/ingest?token=${encodeURIComponent(token)}`;
}
