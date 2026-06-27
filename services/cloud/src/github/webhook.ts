import { Webhooks } from "@octokit/webhooks";
import { analyzePush } from "./analyze-push";
import { githubConnectorConfigured } from "./app-auth";
import { branchFromRef, changedPathsFromPush, type PushPayload } from "./push";

// GitHub App connector — the webhook receiver (Technical-Spec §13). A SECOND analysis source: a push
// to a connected repo is verified here, then (S3b) fetched + analyzed server-side, fanning findings to
// the dashboard exactly like the CLI path. This is additive — it never touches the CLI/ingest path.
//
// S1 scope: verify the X-Hub-Signature-256 HMAC and acknowledge. No GitHub API calls, no analysis yet.
// Disabled (503) until GITHUB_WEBHOOK_SECRET is set, so the "off" state is explicit, never a silent 200.

function webhookSecret(): string | undefined {
  const s = process.env.GITHUB_WEBHOOK_SECRET;
  return s && s.length > 0 ? s : undefined;
}

export async function handleGithubWebhook(req: Request): Promise<Response> {
  const secret = webhookSecret();
  if (!secret) {
    return new Response("github connector disabled (set GITHUB_WEBHOOK_SECRET)", { status: 503 });
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!signature) return new Response("missing signature", { status: 401 });

  // Verify against the EXACT received bytes — the HMAC is over the raw body, so we must read the body
  // as text and feed that same string to both verification and JSON parsing (never re-serialize).
  const body = await req.text();
  const webhooks = new Webhooks({ secret });
  let valid = false;
  try {
    valid = await webhooks.verify(body, signature);
  } catch {
    valid = false; // malformed signature header → treat as invalid, never throw to the caller
  }
  if (!valid) return new Response("invalid signature", { status: 401 });

  const event = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery") ?? "";

  // Only `push` drives analysis (S3b). Acknowledge every other event fast — GitHub expects a prompt 2xx
  // or it retries and eventually disables the webhook.
  if (event !== "push") {
    return new Response(`ignored event: ${event || "(none)"}`, { status: 202 });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  // Branch-delete pushes carry no tree to analyze.
  if (payload.deleted) {
    return new Response("ignored: branch deleted", { status: 202 });
  }

  const changed = changedPathsFromPush(payload);
  console.log(
    `📥 github push ${payload.repository.full_name}@${payload.after.slice(0, 7)} ` +
      `on ${branchFromRef(payload.ref)} — ${changed.length} changed file(s) (delivery ${delivery})`,
  );

  // Analyze only when the App credentials are ALSO present (verification alone can't fetch source).
  // Fire-and-forget: acknowledge the delivery immediately; the fetch+analyze runs out of band so GitHub
  // never waits on it. Errors are logged, never thrown back to the delivery.
  if (githubConnectorConfigured()) {
    void analyzePush(payload).catch((err: unknown) =>
      console.error(`✗ analyzePush failed for ${payload.repository.full_name}:`, err),
    );
  } else {
    console.log("  ↳ verified, but App credentials not set — not analyzing (set GITHUB_APP_ID/KEY)");
  }

  return new Response("accepted", { status: 202 });
}
