import type { ChangeOp, Encoding } from "@arcane/shared";

// Internal collector types (not on the wire). The collector turns raw chokidar events into
// ORDERED LogicalChanges; the Collector envelope adds eventId/sessionId/seq/ts to make a
// @arcane/shared ChangeEvent (Technical-Spec §3A.2). Never redefine the wire shape here.

export type RawEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

// A raw, un-normalized filesystem event from the watcher (chokidar as a raw source).
export interface RawEvent {
  type: RawEventType;
  path: string; // repo-relative, POSIX
  mode?: number; // unix file-mode bits, when chokidar provided stats
}

// The last committed fingerprint of a live path — lets an unlink recover the deleted file's
// identity with zero I/O (for rename pairing) and lets us tell add from change.
export interface FileMeta {
  hash: string;
  size: number;
}

// Result of reading + hashing a file at flush time (with the M1A utf8 guard applied).
export interface FileContent {
  hash: string;
  size: number;
  encoding: "utf8" | "none";
  content?: string; // present only when faithfully representable as utf8 (M1A)
}

// One normalized, committed logical change (post-coalesce/pairing) — minus the wire envelope.
export interface LogicalChange {
  op: ChangeOp;
  path: string;
  oldPath?: string;
  contentHash?: string;
  sizeBytes?: number;
  encoding?: Encoding;
  content?: string;
  mode?: number;
}
