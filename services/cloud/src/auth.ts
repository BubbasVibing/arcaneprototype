// STUB: M1B auth (Build Guide §18 — "device-link stub is fine for M1"). A single configured dev
// token gates /auth/token, /link, and /ingest. This is NOT the §23 OAuth device grant (no users,
// no cli_tokens, no hashing) — only the browser-approval handshake is bypassed; the gating shape is
// real. Real login is deferred to a later milestone.

const DEV_TOKEN = process.env.ARCANE_DEV_TOKEN ?? "dev-stub-token";

// The token `arcane login` receives and stores in ~/.arcane.
export function mintDevToken(): string {
  return DEV_TOKEN;
}

// True iff the presented token is the configured dev token. (Constant-time comparison is overkill
// for a dev stub; a later milestone replaces this with real token verification.)
export function isValidToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.length > 0 && token === DEV_TOKEN;
}

// M3D deployment hardening: the default dev token is guessable and Bun binds an interface, so the
// EXECUTION endpoint (/run) must refuse it in production — execution is too dangerous to gate on a
// shared default. True iff the guessable default token is in effect AND we're in production; in
// dev/test (no NODE_ENV=production) it is allowed so the stub flow + tests work.
export function defaultExecutionTokenForbidden(): boolean {
  const usingDefaultToken = !process.env.ARCANE_DEV_TOKEN; // the literal "dev-stub-token" is in effect
  const isProd = process.env.NODE_ENV === "production";
  return usingDefaultToken && isProd;
}

// Extract a bearer token from an `Authorization: Bearer <t>` header (REST) — null if absent.
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}
