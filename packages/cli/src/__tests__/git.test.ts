import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { readGitContext } from "../git";

// readGitContext is READ-ONLY (§3A.5) and degrades gracefully. Tests set up real repos via simple-git
// (test setup may mutate; the product code never does).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arcane-git-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("returns a graceful not-a-repo context for a plain directory", async () => {
  const ctx = await readGitContext(dir);
  expect(ctx).toEqual({ isRepo: false, branch: null, headSha: null });
});

it("reads branch + headSha for a repo with a commit", async () => {
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "t@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "hi");
  await git.add("a.txt");
  await git.commit("init");

  const ctx = await readGitContext(dir);
  expect(ctx.isRepo).toBe(true);
  expect(ctx.branch).toBe("main");
  expect(ctx.headSha).toMatch(/^[0-9a-f]{40}$/);
});

it("attaches baselineRef and resolves baselineSha when the ref exists", async () => {
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "t@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "hi");
  await git.add("a.txt");
  await git.commit("init");

  const ctx = await readGitContext(dir, "main");
  expect(ctx.baselineRef).toBe("main");
  expect(ctx.baselineSha).toMatch(/^[0-9a-f]{40}$/);
  expect(ctx.baselineSha).toBe(ctx.headSha); // main == HEAD here

  // An unresolvable ref degrades to null, never throws.
  const ctx2 = await readGitContext(dir, "origin/does-not-exist");
  expect(ctx2.baselineRef).toBe("origin/does-not-exist");
  expect(ctx2.baselineSha).toBeNull();
});
