import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import xxhash from "xxhash-wasm";
import type { FileContent } from "./types";

// Content hashing for the collector. xxhash-wasm is WASM (no native addon — invariant §29).
// `contentHash` lets the server hash-skip unchanged files (§3A.3) and lets the collector pair
// renames by content fingerprint without an inode (chokidar gives no inode on unlink).

type Hasher = Awaited<ReturnType<typeof xxhash>>;
let hasher: Hasher | undefined;

// §3A.1 "Binary/oversized files (> configurable cap) are sent as hash + size, not content." There is
// no [project] size-cap key in Product-Requirements §4.1, so per RULE 1 this is a hardcoded constant,
// not an invented config key. Making it configurable later needs a documented key first.
export const INLINE_CONTENT_CAP_BYTES = 512 * 1024; // 512 KiB

// Size-stability (§3A.3 "never drop the final state"): chokidar's awaitWriteFinish is OFF, so a flush
// can land mid-write and read torn bytes. We stat → read → stat; if the file changed under us we
// re-read, bounded so a continuously-rewritten file still resolves (then we take the latest read).
const MAX_STABILITY_RETRIES = 3;
const STABILITY_RETRY_MS = 25;

export async function initHasher(): Promise<void> {
  if (!hasher) hasher = await xxhash();
}

export function hashBuffer(buf: Uint8Array): string {
  if (!hasher) throw new Error("hasher not initialized — call initHasher() first");
  // 64-bit xxhash as fixed-width hex; stable across runs, cheap, collision-resistant enough for dedup.
  return hasher.h64Raw(buf).toString(16).padStart(16, "0");
}

// Streaming hash for over-cap files: bounded memory (we never load a multi-GB asset into a string).
// MUST produce the identical 16-hex digest to hashBuffer for the same bytes (pinned by a unit test).
async function hashFileStreaming(absPath: string): Promise<{ hash: string; size: number }> {
  if (!hasher) throw new Error("hasher not initialized — call initHasher() first");
  const h = hasher.create64();
  let size = 0;
  for await (const chunk of createReadStream(absPath)) {
    const u8 = chunk as Uint8Array;
    size += u8.byteLength;
    h.update(u8);
  }
  return { hash: h.digest().toString(16).padStart(16, "0"), size };
}

// A single reusable fatal decoder: throws on any byte sequence that is not valid utf8.
const utf8 = new TextDecoder("utf8", { fatal: true });

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readOnce(absPath: string, sizeHint: number): Promise<FileContent> {
  // Oversized → hash + size only (content omitted). Oversized text is NOT binary.
  if (sizeHint > INLINE_CONTENT_CAP_BYTES) {
    const { hash, size } = await hashFileStreaming(absPath);
    return { hash, size, encoding: "none", isBinary: false };
  }
  const buf = await readFile(absPath);
  const hash = hashBuffer(buf);
  const size = buf.length;
  // Grew past the cap between the stat and the read → treat as oversized (content omitted).
  if (size > INLINE_CONTENT_CAP_BYTES) return { hash, size, encoding: "none", isBinary: false };
  // utf8 guard: only inline content we can faithfully round-trip. Binary/invalid-utf8 → hash+size
  // only, isBinary:true (§3A.1), so we never emit a binary file mangled as utf8.
  try {
    const content = utf8.decode(buf);
    return { hash, size, encoding: "utf8", content, isBinary: false };
  } catch {
    return { hash, size, encoding: "none", isBinary: true };
  }
}

export async function readFileContent(absPath: string): Promise<FileContent> {
  for (let attempt = 0; ; attempt++) {
    const before = await stat(absPath);
    const fc = await readOnce(absPath, before.size);
    const after = await stat(absPath);
    if (after.size === before.size && after.mtimeMs === before.mtimeMs) return fc;
    if (attempt >= MAX_STABILITY_RETRIES) return fc; // give up: a continuous writer — take the latest
    await delay(STABILITY_RETRY_MS);
  }
}
