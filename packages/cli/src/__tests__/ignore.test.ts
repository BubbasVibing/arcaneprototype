import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadIgnoreRules, makeIgnoreMatcher } from "../collector/ignore";

// M2A ignore engine: real .gitignore + arcane.toml [project].ignore, single shared matcher. The
// load-bearing property is that a directory pattern (`build/`) is matched for the directory ENTRY
// itself so the repo walk skips it (the `ignore` lib returns false for `ignores("build")` but true
// for `ignores("build/")`, so the matcher tests both forms).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arcane-ignore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ignore engine", () => {
  it("honors a root .gitignore (dir pattern, glob, and nested files)", async () => {
    writeFileSync(join(dir, ".gitignore"), "build/\n*.log\n");
    const match = makeIgnoreMatcher(await loadIgnoreRules(dir));

    expect(match("build")).toBe(true); // the directory entry itself → walk skips recursion
    expect(match("build/output.js")).toBe(true);
    expect(match("app.log")).toBe(true);
    expect(match("src/server.log")).toBe(true);
    expect(match("src/main.ts")).toBe(false);
  });

  it("honors arcane.toml [project].ignore passed as projectIgnore", async () => {
    const match = makeIgnoreMatcher(await loadIgnoreRules(dir, ["vendor", "*.snap"]));
    expect(match("vendor")).toBe(true);
    expect(match("vendor/lib.js")).toBe(true);
    expect(match("a.snap")).toBe(true);
    expect(match("keep.ts")).toBe(false);
  });

  it("always force-ignores .git and .arcane even with no .gitignore", async () => {
    const match = makeIgnoreMatcher(await loadIgnoreRules(dir));
    expect(match(".git")).toBe(true);
    expect(match(".git/HEAD")).toBe(true);
    expect(match(".arcane")).toBe(true);
    expect(match(".arcane/link.json")).toBe(true);
  });

  it("never ignores the repo root and accepts absolute paths", async () => {
    writeFileSync(join(dir, ".gitignore"), "build/\n");
    const match = makeIgnoreMatcher(await loadIgnoreRules(dir));
    expect(match(dir)).toBe(false); // the root itself
    expect(match("")).toBe(false);
    expect(match(join(dir, "build"))).toBe(true); // absolute path normalized to repo-relative
    expect(match(join(dir, "src", "main.ts"))).toBe(false);
  });
});
