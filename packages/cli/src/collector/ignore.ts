import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

// M2A ignore engine (§3A.1: "honoring `.gitignore` + `arcane.toml` `ignore`"). Replaces M1A's
// hardcoded segment set with the gitignore-spec `ignore` library (pure-JS, zero native addon —
// invariant 15). The SAME `IgnoreRules` is built once per `watch`/`link` invocation and threaded to
// the watcher, the repo walk (link), AND the manifest-resync disk-diff, so all three observe the
// identical file set — divergence here is exactly what breaks the no-drift / byte-identical proof.
//
// Scope: the root `.gitignore` + `arcane.toml` `[project].ignore`, plus an always-on force-ignore of
// `.git/` and `.arcane/`. Nested per-directory `.gitignore` is deferred.

export interface IgnoreRules {
  readonly ig: Ignore;
  readonly root: string;
}

// Build the rule set once. `projectIgnore` is `arcane.toml [project].ignore` (already loaded). A
// missing `.gitignore` is fine (the repo may not have one).
export async function loadIgnoreRules(root: string, projectIgnore?: string[]): Promise<IgnoreRules> {
  const ig = ignore();
  // Always force-ignored: `.git` is never user source; `.arcane` is our own session state.
  ig.add(".git/").add(".arcane/");
  try {
    ig.add(await readFile(join(root, ".gitignore"), "utf8"));
  } catch {
    // no root .gitignore — nothing to add
  }
  if (projectIgnore && projectIgnore.length > 0) ig.add(projectIgnore);
  return { ig, root };
}

// A pure, sync predicate. `testPath` may arrive absolute (chokidar traversal) or repo-relative
// (the walk), with OS separators; normalize to repo-relative POSIX before `ig.ignores()` (it throws
// on absolute paths and rejects ""/"."). We test BOTH the bare path and `path/`: a directory pattern
// like `build/` matches `ignores("build/")` but NOT `ignores("build")`, so the bare-only test would
// miss directories and the walk would descend into them (verified against the `ignore` lib).
export function makeIgnoreMatcher(rules: IgnoreRules): (testPath: string) => boolean {
  const { ig, root } = rules;
  return (testPath: string): boolean => {
    let rel = (isAbsolute(testPath) ? relative(root, testPath) : testPath).split("\\").join("/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel.endsWith("/")) rel = rel.slice(0, -1);
    // The root itself, or anything resolving outside it, is never ignored.
    if (rel === "" || rel === "." || rel.startsWith("..")) return false;
    return ig.ignores(rel) || ig.ignores(`${rel}/`);
  };
}
