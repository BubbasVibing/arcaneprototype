import { sql } from "../db/client";

// Map a GitHub push to an Arcane project_id (Technical-Spec §13). Authorization is two-step and fails
// closed — we NEVER auto-provision:
//   1. the installation must be a registered `github_app` integration  → gives the owning org
//   2. the repo must be a linked project (matched on projects.repo_url) within that org
// Returns null (→ the push is ignored) when either is missing. arcane_cloud reads both tables under its
// grants (integrations via the 0007 server-only RLS policy; projects has no RLS).
export async function resolveProject(
  repoFullName: string,
  repoHtmlUrl: string,
  repoCloneUrl: string,
  installationId: number,
): Promise<string | null> {
  const integ = await sql`
    SELECT org_id FROM integrations
    WHERE type = 'github_app' AND config_json->>'installation_id' = ${String(installationId)}
    LIMIT 1`;
  if (integ.length === 0) return null;
  const orgId = integ[0].org_id as string;

  // Match the common ways a repo URL may be stored, so a project linked by the CLI (which may store the
  // https URL) or seeded with the clone URL both resolve. Scalar IN-list (not ANY(array)) — Bun.sql
  // binds each value as its own parameter, avoiding array-literal serialization pitfalls.
  const httpsName = `https://github.com/${repoFullName}`;
  const httpsNameGit = `https://github.com/${repoFullName}.git`;
  const proj = await sql`
    SELECT id FROM projects
    WHERE org_id = ${orgId}
      AND repo_url IN (${repoHtmlUrl}, ${repoCloneUrl}, ${repoFullName}, ${httpsName}, ${httpsNameGit})
    ORDER BY created_at DESC
    LIMIT 1`;
  if (proj.length === 0) return null;
  return proj[0].id as string;
}
