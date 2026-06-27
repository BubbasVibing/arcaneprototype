import type { GitContext } from "@arcane/shared";
import { simpleGit } from "simple-git";

// Read-only git context (Technical-Spec §3A.5). The CLI is a thin client (invariant §16.1) — it
// NEVER writes git, only reads branch + HEAD SHA + the optional delta baseline ref/SHA. Everything
// degrades gracefully: not-a-repo, a detached HEAD, an empty repo, or a missing `git` binary all
// resolve to a well-formed GitContext rather than throwing (the watcher must never crash on git).

function notARepo(baselineRef?: string): GitContext {
  return { isRepo: false, branch: null, headSha: null, ...(baselineRef ? { baselineRef } : {}) };
}

export async function readGitContext(root: string, baselineRef?: string): Promise<GitContext> {
  try {
    const git = simpleGit(root);
    if (!(await git.checkIsRepo())) return notARepo(baselineRef);

    const branchRaw = await git
      .revparse(["--abbrev-ref", "HEAD"])
      .then((s) => s.trim())
      .catch(() => null);
    const branch = !branchRaw || branchRaw === "HEAD" ? null : branchRaw; // detached/empty → null

    const headSha = await git
      .revparse(["HEAD"])
      .then((s) => s.trim())
      .catch(() => null); // no commits yet → null

    const ctx: GitContext = { isRepo: true, branch, headSha };
    if (baselineRef) {
      ctx.baselineRef = baselineRef;
      ctx.baselineSha = await git
        .revparse([baselineRef])
        .then((s) => s.trim())
        .catch(() => null); // unresolvable ref (e.g. origin/main not fetched) → null
    }
    return ctx;
  } catch {
    // git binary absent, or any unexpected failure → graceful "not a repo".
    return notARepo(baselineRef);
  }
}
