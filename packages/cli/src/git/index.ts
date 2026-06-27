import { spawn } from "node:child_process";
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

// M3D-2 — read-only baseline-tree access for `arcane run --compare --baseline <ref>`. These read a
// git ref WITHOUT a checkout (never mutate the working tree or index — invariant §16.1), so they can
// build the baseline manifest while the user keeps working. The CLI ships these bytes to the cloud
// (like `arcane link` ships the working tree); it NEVER runs anything.

// Resolve a ref to its commit SHA, or throw a clear error (so a bad --baseline fails helpfully rather
// than silently producing an empty baseline tree).
export async function resolveRef(root: string, ref: string): Promise<string> {
  try {
    const sha = (await simpleGit(root).revparse([ref])).trim();
    if (!sha) throw new Error("empty");
    return sha;
  } catch {
    throw new Error(
      `cannot resolve baseline ref "${ref}" — is it a valid commit/branch/tag? (e.g. it may need \`git fetch\`)`,
    );
  }
}

// List the repo-relative POSIX paths of every blob at a ref (recursive, no checkout). Filters to
// `blob` entries — tree rows are implicit and a submodule (`commit`) row has no file content here.
export async function listTreeAtRef(root: string, ref: string): Promise<string[]> {
  // -z: NUL-separated so paths with spaces/newlines are unambiguous; entries are
  // "<mode> <type> <oid>\t<path>".
  const raw = await simpleGit(root).raw(["ls-tree", "-r", "-z", ref]);
  const paths: string[] = [];
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const type = entry.slice(0, tab).split(/\s+/)[1]; // mode TYPE oid
    if (type === "blob") paths.push(entry.slice(tab + 1));
  }
  return paths;
}

// The EXACT bytes of a blob at a ref. Binary-safe: simple-git's `.raw()` decodes stdout as a string,
// which corrupts non-utf8 bytes (proven: 0xff/0xfe → U+FFFD), so we spawn `git show` and collect raw
// Buffer chunks instead. Read-only (`git show <ref>:<path>` outputs the stored blob, no smudge/checkout).
export function readBlobAtRef(root: string, ref: string, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // args array (no shell) — `ref` is pre-resolved and `path` comes from git's own ls-tree output.
    const child = spawn("git", ["-C", root, "show", `${ref}:${path}`]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject); // e.g. git binary missing
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git show ${ref}:${path} exited ${code}: ${Buffer.concat(errChunks)}`));
    });
  });
}
