import { readFile } from "node:fs/promises";
import xxhash from "xxhash-wasm";
import type { FileContent } from "./types";

// Content hashing for the collector. xxhash-wasm is WASM (no native addon — invariant §29).
// `contentHash` lets the server hash-skip unchanged files (§3A.3) and lets the collector pair
// renames by content fingerprint without an inode (chokidar gives no inode on unlink).

type Hasher = Awaited<ReturnType<typeof xxhash>>;
let hasher: Hasher | undefined;

export async function initHasher(): Promise<void> {
  if (!hasher) hasher = await xxhash();
}

export function hashBuffer(buf: Uint8Array): string {
  if (!hasher) throw new Error("hasher not initialized — call initHasher() first");
  // 64-bit xxhash as fixed-width hex; stable across runs, cheap, collision-resistant enough for dedup.
  return hasher.h64Raw(buf).toString(16).padStart(16, "0");
}

// A single reusable fatal decoder: throws on any byte sequence that is not valid utf8.
const utf8 = new TextDecoder("utf8", { fatal: true });

export async function readFileContent(absPath: string): Promise<FileContent> {
  const buf = await readFile(absPath);
  const hash = hashBuffer(buf);
  const size = buf.length;
  // utf8 guard (M1A): only inline content we can faithfully round-trip as utf8. Binary or
  // invalid-utf8 → hash + size only (no content), so we never emit a binary mangled as utf8.
  // A configurable size cap + richer binary handling are M2 ("large/binary caps").
  try {
    const content = utf8.decode(buf);
    return { hash, size, encoding: "utf8", content };
  } catch {
    return { hash, size, encoding: "none" };
  }
}
