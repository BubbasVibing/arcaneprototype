import { z } from "zod";
import { BlobRefSchema, EncodingSchema } from "./change-event";

// Technical-Spec §3A.4 — the `arcane link` REST contract (CLI → cloud), kept here because it is a
// cross-lane contract (Build Guide rule 4) just like the streaming ChangeEvent/AckEvent. `link`
// builds an initial manifest (path → hash) + uploads file bytes; the server materializes the shadow
// worktree and mints a `baseSnapshotId`. The server NEVER re-hashes — it trusts the CLI's
// `contentHash` (§3A.3), so the baseline manifest travels in this request.

// One file in the link manifest. The fields mirror the file half of a ChangeEvent (§3A.2) — same
// vocabulary, no new shape — so a baseline file and a streamed change describe a file identically.
export const ManifestFileSchema = z.object({
  path: z.string(), // repo-relative, POSIX
  contentHash: z.string(), // xxhash computed by the CLI (the server trusts it)
  sizeBytes: z.number().optional(),
  isBinary: z.boolean().optional(),
  encoding: EncodingSchema.optional(),
  mode: z.number().optional(),
  // Inline if small/text; a blob ref otherwise. M1B materializes inline content only — a blobRef is
  // recorded in the manifest by hash but its bytes are not written (snapshotId derives from the
  // manifest, not the bytes), so the round-trip holds without blob storage (§3A.6 is M2+).
  content: z.union([z.string(), BlobRefSchema]).optional(),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

// CLI → POST /link. M1B always CREATES a project (no re-link/lookup yet — §23).
export const LinkRequestSchema = z.object({
  files: z.array(ManifestFileSchema),
});
export type LinkRequest = z.infer<typeof LinkRequestSchema>;

// Server → CLI. Both ids are server-minted UUIDs (projects.id / source_snapshots.id, §7).
export const LinkResponseSchema = z.object({
  projectId: z.string().uuid(),
  baseSnapshotId: z.string().uuid(),
});
export type LinkResponse = z.infer<typeof LinkResponseSchema>;

// STUB: the M1 auth path is a dev token, not the §23 OAuth device grant. `arcane login` exchanges
// nothing and receives the configured dev token, which then gates /link + /ingest. Real device-flow
// login (§23) is deferred (Build Guide §18: "device-link stub is fine for M1").
export const AuthTokenResponseSchema = z.object({
  token: z.string(),
});
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
