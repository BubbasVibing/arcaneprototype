import { join } from "node:path";
import type { ManifestFile } from "@arcane/shared";
import { hashBuffer, initHasher, INLINE_CONTENT_CAP_BYTES, readFileContent } from "../collector/hash";
import { listTreeAtRef, readBlobAtRef } from "../git";
import { walkRepo } from "../repo-walk";

// M3D-2 — the two file trees `arcane run --compare` ships to the cloud (POST /run carries
// baselineFiles + currentFiles; the cloud materializes both worktrees and runs the workload IN THE
// CLOUD — the CLI never executes anything, §16.1). Both reuse the SAME ignore matcher + content
// hasher as `arcane link`, so the baseline and current trees describe files identically (no drift).

// The single decoder for utf8-inlining (fatal → throws on non-utf8, exactly like the collector).
const utf8 = new TextDecoder("utf8", { fatal: true });

// Build the CURRENT working-tree manifest (path → xxhash + inline utf8 bytes under the cap). This is
// the one authority for "the working tree as a manifest" — `arcane link` reuses it (no second copy
// of the walk+hash loop to drift).
export async function buildCurrentTree(
  root: string,
  ignore: (testPath: string) => boolean,
): Promise<ManifestFile[]> {
  await initHasher(); // WASM ready before any file is hashed
  const paths = await walkRepo(root, ignore);
  const files: ManifestFile[] = [];
  for (const path of paths) {
    const fc = await readFileContent(join(root, path));
    const file: ManifestFile = {
      path,
      contentHash: fc.hash,
      sizeBytes: fc.size,
      encoding: fc.encoding,
    };
    if (fc.isBinary) file.isBinary = true;
    if (fc.content !== undefined) file.content = fc.content; // inline only when utf8 (else hash-only)
    files.push(file);
  }
  return files;
}

// Build the BASELINE manifest from a git ref WITHOUT a checkout (read-only — the user keeps working).
// Same ignore matcher as the current tree so the two trees are comparable. Per-blob bytes are read
// binary-safe (readBlobAtRef), then inlined/hashed with the identical utf8-or-hash-only rule as link.
export async function buildBaselineTree(
  root: string,
  ref: string,
  ignore: (testPath: string) => boolean,
): Promise<ManifestFile[]> {
  await initHasher();
  const paths = (await listTreeAtRef(root, ref)).filter((p) => !ignore(p));
  const files: ManifestFile[] = [];
  for (const path of paths) {
    const buf = await readBlobAtRef(root, ref, path);
    files.push(manifestFileFromBuffer(path, buf));
  }
  return files;
}

// Bytes → ManifestFile, mirroring collector/hash.ts readOnce: hash the bytes; inline as utf8 only
// when valid utf8 AND under the size cap; otherwise hash + size only (oversized text → encoding
// "none"; non-utf8 → isBinary). The cloud trusts contentHash and materializes inline content only.
function manifestFileFromBuffer(path: string, buf: Buffer): ManifestFile {
  const hash = hashBuffer(buf);
  const size = buf.length;
  const file: ManifestFile = { path, contentHash: hash, sizeBytes: size };
  if (size > INLINE_CONTENT_CAP_BYTES) {
    file.encoding = "none"; // oversized text is content-omitted but NOT binary
    return file;
  }
  try {
    file.content = utf8.decode(buf);
    file.encoding = "utf8";
  } catch {
    file.encoding = "none";
    file.isBinary = true; // non-utf8 → hash + size only (never emit binary mangled as utf8)
  }
  return file;
}
