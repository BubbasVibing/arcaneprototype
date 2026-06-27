import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { handleGithubWebhook } from "../webhook";

// S1 proof: the receiver verifies the X-Hub-Signature-256 HMAC and acknowledges. The signature here is
// computed with node:crypto as an INDEPENDENT oracle (not @octokit/webhooks), so this exercises real
// interop rather than testing the library against itself. No DB or network — pure request/response.

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pushBody(): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: "abc123def4567890abc123def4567890abc12345",
    repository: {
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
      clone_url: "https://github.com/acme/widgets.git",
      default_branch: "main",
      owner: { login: "acme" },
    },
    commits: [{ added: ["src/a.ts"], modified: ["src/b.ts"], removed: [] }],
    installation: { id: 42 },
  });
}

function req(
  body: string,
  opts: { signature?: string; event?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "push",
    "x-github-delivery": "00000000-0000-0000-0000-000000000000",
  };
  if (opts.signature !== undefined) headers["x-hub-signature-256"] = opts.signature;
  return new Request("http://localhost/github/webhook", { method: "POST", headers, body });
}

describe("github webhook receiver (S1: verify + acknowledge)", () => {
  const prev = process.env.GITHUB_WEBHOOK_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = prev;
  });

  test("503 when the connector is not configured", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = pushBody();
    const res = await handleGithubWebhook(req(body, { signature: sign(body) }));
    expect(res.status).toBe(503);
  });

  test("202 on a correctly-signed push", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const body = pushBody();
    const res = await handleGithubWebhook(req(body, { signature: sign(body) }));
    expect(res.status).toBe(202);
  });

  test("401 on a tampered body (signature no longer matches)", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const body = pushBody();
    const signature = sign(body);
    const tampered = body.replace("acme/widgets", "evil/widgets");
    const res = await handleGithubWebhook(req(tampered, { signature }));
    expect(res.status).toBe(401);
  });

  test("401 when the signature is computed with the wrong secret", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const body = pushBody();
    const res = await handleGithubWebhook(req(body, { signature: sign(body, "wrong-secret") }));
    expect(res.status).toBe(401);
  });

  test("401 when the signature header is absent", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const body = pushBody();
    const res = await handleGithubWebhook(req(body));
    expect(res.status).toBe(401);
  });

  test("202 (ignored) for a non-push event, even when well-signed", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const body = pushBody();
    const res = await handleGithubWebhook(req(body, { signature: sign(body), event: "ping" }));
    expect(res.status).toBe(202);
  });
});
