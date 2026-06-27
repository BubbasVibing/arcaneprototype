// M1A: a minimal, hardcoded ignore set (decision #3). Real `.gitignore` + `arcane.toml`
// `[project].ignore` parsing is M2 ("ignore-rule hardening") — chokidar 4 also dropped glob
// support, so a correct gitignore engine is a deliberate M2 dependency, not an M1A guess.
//
// chokidar 4's `ignored` takes a predicate. We ignore a path if ANY of its segments is a
// hardcoded name, which is robust whether chokidar passes an absolute or repo-relative path.
const IGNORED_SEGMENTS = new Set([".git", "node_modules", "dist", ".arcane"]);

export function makeIgnoreMatcher(): (testPath: string) => boolean {
  return (testPath: string): boolean =>
    testPath.split(/[/\\]/).some((seg) => IGNORED_SEGMENTS.has(seg));
}
