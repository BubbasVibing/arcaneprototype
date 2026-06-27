import { z } from "zod";

// Technical-Spec §3A.2 — wire protocol, CLI → cloud change stream.
// Delivery is at-least-once + idempotent (§3A.3): `eventId` is the dedup unit, `seq` is strictly
// monotonic per session for gap detection, `parentSnapshotId` pins the shadow-worktree state.

export const ChangeOpSchema = z.enum(["add", "change", "delete", "rename"]);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;

export const EncodingSchema = z.enum(["utf8", "base64", "none"]);
export type Encoding = z.infer<typeof EncodingSchema>;

// content?: string | { blobRef: string } — inline if small, else an uploaded blob ref (§3A.6).
export const BlobRefSchema = z.object({ blobRef: z.string() });
export type BlobRef = z.infer<typeof BlobRefSchema>;

export const ChangeEventSchema = z.object({
  // eventId + sessionId are real UUIDs the moment the collector exists (crypto.randomUUID),
  // so they're tightened to z.string().uuid() (M1A decision #1). projectId/parentSnapshotId stay
  // plain strings — they're placeholders until M1B brings real link + shadow-worktree snapshots.
  eventId: z.string().uuid(), // stable UUID — the unit of dedup (survives retries)
  sessionId: z.string().uuid(), // one watch session
  projectId: z.string(),
  parentSnapshotId: z.string(), // the shadow-worktree snapshot this event applies on top of
  seq: z.number().int().nonnegative(), // strictly monotonic per session — server detects gaps
  ts: z.number(),
  op: ChangeOpSchema,
  path: z.string(), // repo-relative, POSIX
  oldPath: z.string().optional(), // for rename
  contentHash: z.string().optional(), // xxhash of new content (omitted for delete)
  sizeBytes: z.number().optional(),
  isBinary: z.boolean().optional(),
  encoding: EncodingSchema.optional(),
  mode: z.number().optional(), // unix file-mode bits
  content: z.union([z.string(), BlobRefSchema]).optional(),
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

// Server → CLI acknowledgement (§3A.2). Drives the journal: the CLI keeps events until acked.
export const AckEventSchema = z.object({
  sessionId: z.string(),
  ackSeq: z.number().int(), // highest CONTIGUOUS seq the server has durably applied
  acceptedEventIds: z.array(z.string()),
  serverSnapshotId: z.string(), // resulting shadow-worktree snapshot
  resyncFrom: z.number().int().optional(), // present iff the server detected a gap
});
export type AckEvent = z.infer<typeof AckEventSchema>;
