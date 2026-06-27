// GitHub `push` webhook payload — narrowed to only the fields the connector reads (GitHub sends far
// more). Repo identity + the head sha + per-commit file lists + the installation id (needed for the
// installation token in S2). Keeping this minimal avoids coupling the connector to GitHub's full schema.

export interface PushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface PushPayload {
  ref: string; // e.g. "refs/heads/main"
  after: string; // the new head sha after the push ("000…0" when the branch was deleted)
  deleted?: boolean; // true for a branch-delete push — no tree to fetch
  repository: {
    full_name: string; // "owner/repo"
    html_url: string; // "https://github.com/owner/repo"
    clone_url: string; // "https://github.com/owner/repo.git"
    default_branch: string;
    owner: { name?: string; login?: string };
  };
  head_commit?: PushCommit | null;
  commits?: PushCommit[];
  installation?: { id: number };
}

// The blast radius for a push = the union of every pushed commit's added/modified/removed paths
// (deduped). Mirrors the CLI path's per-event changed-file scoping, aggregated across the push.
export function changedPathsFromPush(payload: PushPayload): string[] {
  const set = new Set<string>();
  for (const c of payload.commits ?? []) {
    for (const p of c.added ?? []) set.add(p);
    for (const p of c.modified ?? []) set.add(p);
    for (const p of c.removed ?? []) set.add(p);
  }
  return [...set];
}

// "refs/heads/main" → "main"; anything else (tags etc.) is returned as-is.
export function branchFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
