import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

// A materialized commit tree: the on-disk root the analyzers run against (exactly like the CLI's shadow
// worktree), its full manifest (path -> content hash), and a cleanup to remove the temp dir afterwards.
export interface FetchedTree {
  rootDir: string;
  manifest: Array<{ path: string; contentHash: string }>;
  cleanup: () => Promise<void>;
}

// Download a commit's source as a tarball via the installation token and extract it (Technical-Spec
// §13 clone-baseline path). We fetch the WHOLE tree — not just changed files — because project
// analyzers (semgrep/gitleaks/osv) scan the entire worktree, the same input the CLI shadow worktree
// gives them. The caller MUST call cleanup() once analysis is done.
export async function fetchCommitTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<FetchedTree> {
  // GitHub 302-redirects to a codeload tarball; octokit follows it and returns the gzip bytes as an
  // ArrayBuffer in `data`. (Verified against the live API in S3b — no network in unit tests.)
  const res = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner,
    repo,
    ref: sha,
  });
  return materializeTarball(Buffer.from(res.data as ArrayBuffer));
}

// Extract a gzip tarball (as produced by the GitHub tarball endpoint) to a fresh temp dir and build its
// manifest. Split out from the network fetch so it is unit-testable against a locally-built tarball.
export async function materializeTarball(gzipBytes: Buffer): Promise<FetchedTree> {
  const work = await mkdtemp(join(tmpdir(), "arcane-gh-"));
  try {
    const tarPath = join(work, "repo.tar.gz");
    await writeFile(tarPath, gzipBytes);
    await extractTarball(tarPath, work);
    const rootDir = await singleExtractedDir(work);
    const manifest = await buildManifest(rootDir);
    return {
      rootDir,
      manifest,
      cleanup: async () => {
        await rm(work, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(work, { recursive: true, force: true }); // never leak the temp dir on a failed extract
    throw err;
  }
}

// Extract with the system `tar` (present in the cloud container — no native npm dependency).
async function extractTarball(tarPath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", destDir], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed (exit ${code}): ${stderr.trim()}`);
  }
}

// The GitHub tarball wraps everything in a single top-level dir ("<owner>-<repo>-<sha7>/"). Find it,
// ignoring the downloaded archive file itself.
async function singleExtractedDir(workDir: string): Promise<string> {
  const entries = await readdir(workDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one extracted directory, found ${dirs.length}`);
  }
  return join(workDir, dirs[0]!.name);
}

// Walk the tree and hash every file (repo-relative POSIX paths). The content hash feeds source_files +
// the manifest hash; it only needs to be stable within this source (no cross-source comparison), so a
// plain SHA-256 of the bytes is sufficient.
async function buildManifest(rootDir: string): Promise<Array<{ path: string; contentHash: string }>> {
  const out: Array<{ path: string; contentHash: string }> = [];
  async function walk(absDir: string, rel: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git") continue; // belt-and-braces; the tarball carries no .git
        await walk(join(absDir, e.name), relPath);
      } else if (e.isFile()) {
        const buf = await readFile(join(absDir, e.name));
        out.push({ path: relPath, contentHash: createHash("sha256").update(buf).digest("hex") });
      }
    }
  }
  await walk(rootDir, "");
  return out;
}
