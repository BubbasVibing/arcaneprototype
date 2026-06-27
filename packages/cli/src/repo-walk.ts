import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Recursive repo walk honoring an ignore predicate, returning sorted repo-relative POSIX paths.
// Shared by `arcane link` (the baseline manifest) and the manifest-resync fallback so both observe
// exactly the same file set as the watcher (no drift). Symlinks/specials are skipped (§3A.1).
export async function walkRepo(root: string, ignore: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function recur(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (ignore(rel)) continue;
      if (entry.isDirectory()) await recur(abs);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await recur(root);
  return out.sort();
}
