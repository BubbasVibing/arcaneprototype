import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// Build an Octokit authenticated as a specific GitHub App INSTALLATION (Technical-Spec §13). The App's
// private key signs a short-lived JWT; createAppAuth exchanges it for an installation access token and
// caches/refreshes it transparently, so callers just make API requests. Server-side only — the App
// private key never leaves the cloud (the §13 trust boundary: no token touches the user's machine).

function appCreds(): { appId: number; privateKey: string } | undefined {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return undefined;
  // Accept a single-line PEM with literal "\n" (convenient in .env / secret managers).
  const normalized = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
  return { appId: Number(appId), privateKey: normalized };
}

// True only when BOTH halves are configured: the App identity (to fetch source) AND the webhook secret
// (to verify deliveries). The webhook route 503s without the secret; analysis can't fetch without the
// App key — the connector is "on" only when both are present.
export function githubConnectorConfigured(): boolean {
  return appCreds() !== undefined && !!process.env.GITHUB_WEBHOOK_SECRET;
}

export function installationOctokit(installationId: number): Octokit {
  const creds = appCreds();
  if (!creds) {
    throw new Error("GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)");
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: creds.appId, privateKey: creds.privateKey, installationId },
  });
}
