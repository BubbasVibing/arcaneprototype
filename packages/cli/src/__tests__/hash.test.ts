import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { hashBuffer, initHasher, INLINE_CONTENT_CAP_BYTES, readFileContent } from "../collector/hash";

// M2A binary/size caps (§3A.1): non-UTF-8 → isBinary + hash/size only; oversized text → hash/size
// only (content omitted, NOT binary); small UTF-8 → inline content. Plus the load-bearing property
// that the streaming (over-cap) hash equals the in-memory hash for identical bytes.

let dir: string;
beforeAll(async () => {
  await initHasher();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arcane-hash-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("inlines small UTF-8 content", async () => {
  const p = join(dir, "a.ts");
  writeFileSync(p, "export const x = 1;\n");
  const fc = await readFileContent(p);
  expect(fc.encoding).toBe("utf8");
  expect(fc.isBinary).toBe(false);
  expect(fc.content).toBe("export const x = 1;\n");
});

it("omits content for non-UTF-8 (binary) files and marks isBinary", async () => {
  const p = join(dir, "logo.bin");
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xfe]));
  const fc = await readFileContent(p);
  expect(fc.encoding).toBe("none");
  expect(fc.isBinary).toBe(true);
  expect(fc.content).toBeUndefined();
  expect(fc.size).toBe(7);
});

it("omits content for oversized UTF-8 text (cap exceeded) WITHOUT marking it binary", async () => {
  const p = join(dir, "big.txt");
  const big = "a".repeat(INLINE_CONTENT_CAP_BYTES + 10); // valid utf8, but over the inline cap
  writeFileSync(p, big);
  const fc = await readFileContent(p);
  expect(fc.encoding).toBe("none");
  expect(fc.isBinary).toBe(false); // oversized text is not binary
  expect(fc.content).toBeUndefined();
  expect(fc.size).toBe(INLINE_CONTENT_CAP_BYTES + 10);
});

it("streaming (over-cap) hash equals the in-memory hash for identical bytes", async () => {
  const big = Buffer.from("z".repeat(INLINE_CONTENT_CAP_BYTES + 100));
  const p = join(dir, "big2.txt");
  writeFileSync(p, big);
  const fc = await readFileContent(p); // takes the streaming path (over cap)
  expect(fc.hash).toBe(hashBuffer(big)); // must match h64Raw over the full buffer
});
