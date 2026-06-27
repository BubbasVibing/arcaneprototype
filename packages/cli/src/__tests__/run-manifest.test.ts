import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { hashBuffer, initHasher } from "../collector/hash";
import { makeIgnoreMatcher } from "../collector/ignore";
import { listTreeAtRef, readBlobAtRef, resolveRef } from "../git";
import { buildBaselineTree } from "../run/manifest";

// M3D-2 — the baseline tree is read from a git ref WITHOUT a checkout (read-only). These tests prove
// it is faithful for text (utf8 inline + correct hash) AND binary (binary-safe bytes, hash-only).
// Test setup mutates a throwaway repo; the product code under test never writes git.

let dir: string;

async function initRepo(): Promise<ReturnType<typeof simpleGit>> {
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "t@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arcane-run-manifest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("lists blob paths at a ref and resolves the ref to a sha", async () => {
  const git = await initRepo();
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  await git.add(".");
  await git.commit("init");

  expect((await listTreeAtRef(dir, "main")).sort()).toEqual(["a.ts", "b.ts"]);
  expect(await resolveRef(dir, "main")).toMatch(/^[0-9a-f]{40}$/);
});

it("throws a clear error for an unresolvable baseline ref", async () => {
  await initRepo();
  await expect(resolveRef(dir, "origin/nope")).rejects.toThrow(/cannot resolve baseline ref/);
});

it("reads blob bytes binary-safe (non-utf8 round-trips exactly)", async () => {
  const git = await initRepo();
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  writeFileSync(join(dir, "bin.dat"), bytes);
  await git.add(".");
  await git.commit("init");

  const read = await readBlobAtRef(dir, "main", "bin.dat");
  expect(read.equals(bytes)).toBe(true); // exact bytes, not utf8-mangled
});

it("builds a baseline tree: utf8 text inlined, binary hash-only, hashes correct", async () => {
  const git = await initRepo();
  const text = "export function f() { return 1; }\n";
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]); // PNG-ish header, non-utf8
  writeFileSync(join(dir, "src.ts"), text);
  writeFileSync(join(dir, "img.bin"), bin);
  await git.add(".");
  await git.commit("init");

  // Mutate the working tree AFTER committing — the baseline must reflect the COMMIT, not disk.
  writeFileSync(join(dir, "src.ts"), "// changed on disk, not committed\n");

  await initHasher();
  const ignore = makeIgnoreMatcher({ ig: (await import("ignore")).default(), root: dir });
  const tree = await buildBaselineTree(dir, "main", ignore);
  const find = (p: string) => tree.find((f) => f.path === p)!;

  // Text file: inlined as utf8 with the COMMITTED content + a hash of those bytes.
  const src = find("src.ts");
  expect(src.encoding).toBe("utf8");
  expect(src.content).toBe(text);
  expect(src.contentHash).toBe(hashBuffer(Buffer.from(text, "utf8")));
  expect(src.isBinary).toBeUndefined();

  // Binary file: hash-only (no inline content), isBinary, hash of the true bytes.
  const img = find("img.bin");
  expect(img.content).toBeUndefined();
  expect(img.isBinary).toBe(true);
  expect(img.encoding).toBe("none");
  expect(img.contentHash).toBe(hashBuffer(bin));
});

it("applies the ignore matcher to the baseline tree (same file set as the current tree)", async () => {
  const git = await initRepo();
  writeFileSync(join(dir, "keep.ts"), "1\n");
  writeFileSync(join(dir, "skip.log"), "noise\n");
  await git.add(".");
  await git.commit("init");

  const ig = (await import("ignore")).default();
  ig.add("*.log");
  const ignore = makeIgnoreMatcher({ ig, root: dir });
  const paths = (await buildBaselineTree(dir, "main", ignore)).map((f) => f.path);
  expect(paths).toContain("keep.ts");
  expect(paths).not.toContain("skip.log");
});
