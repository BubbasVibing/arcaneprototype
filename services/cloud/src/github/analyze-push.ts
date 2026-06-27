import { createHash, randomUUID } from "node:crypto";
import { analyzeWorktree } from "../analyze-core";
import { installationOctokit } from "./app-auth";
import { fetchCommitTree } from "./fetch-tree";
import { changedPathsFromPush, type PushPayload } from "./push";
import { resolveProject } from "./resolve-project";

// A stable, valid-format UUID per project so every push for a repo reuses ONE github session — that
// chains snapshots (latestAnalyzedSnapshot) so each push's scores/findings carry deltas + is_new
// against the previous push (D2a), instead of every push looking brand new.
function githubSessionId(projectId: string): string {
  const h = createHash("sha256").update(`github-session:${projectId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Drive the SHARED analysis core (analyze-core.ts) from a verified GitHub push — the second source.
// Resolve the project, fetch the pushed commit's tree via the installation token, then analyze it
// exactly like the CLI path, writing result_events keyed by project_id so the dashboard renders
// findings identically. Web-only fan-out (no CLI socket — invariant §16.4's terminal half is N/A for a
// push source). Fire-and-forget from the webhook: it must not hold the delivery open.
export async function analyzePush(payload: PushPayload): Promise<void> {
  const installationId = payload.installation?.id;
  if (!installationId) {
    console.warn("⚠ github push without an installation id — ignored");
    return;
  }

  const repo = payload.repository;
  const projectId = await resolveProject(repo.full_name, repo.html_url, repo.clone_url, installationId);
  if (!projectId) {
    // Fail closed + legible: the repo isn't a linked project under a registered installation.
    console.warn(
      `⚠ github push for ${repo.full_name} (installation ${installationId}) — no linked project, ignored`,
    );
    return;
  }

  const [owner, name] = repo.full_name.split("/");
  const octokit = installationOctokit(installationId);
  const tree = await fetchCommitTree(octokit, owner!, name!, payload.after);
  try {
    // Scope per-file analysis to the push's changed files (delta semantics, like the CLI). If the push
    // carries no file list (e.g. a new branch / squashed history), fall back to the whole tree so the
    // first analysis is still meaningful. Whole-tree analyzers (semgrep/gitleaks/osv) always scan all.
    const pushChanged = changedPathsFromPush(payload);
    const changedPaths = pushChanged.length > 0 ? pushChanged : tree.manifest.map((f) => f.path);

    await analyzeWorktree({
      projectId,
      sessionId: githubSessionId(projectId),
      snapshotId: randomUUID(),
      rootDir: tree.rootDir,
      manifest: tree.manifest,
      changedPaths,
      baseSnapshotId: null, // GitHub source has no link-time baseline; first push has no parent
      config: undefined, // default analyzer set; reading the repo's arcane.toml is a later refinement
      label: `push ${payload.after.slice(0, 7)} ${repo.full_name} (${changedPaths.length} file(s))`,
    });
  } finally {
    await tree.cleanup(); // always remove the temp worktree, even if analysis threw
  }
}
