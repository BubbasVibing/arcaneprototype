import { z } from "zod";
import { ArcaneConfigSchema } from "../domain/config";
import { BlobRefSchema, EncodingSchema } from "./change-event";
import { GitContextSchema } from "./git-context";

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

// CLI → POST /link. The CLI may supply a deterministic projectId (derived from the repo identity) so
// the dashboard URL is STABLE per repo across re-links/clones; omitted ⇒ the server mints a random id.
export const LinkRequestSchema = z.object({
  files: z.array(ManifestFileSchema),
  // A repo-stable projectId the CLI derives from the git remote (else the local path), as a UUIDv5.
  // Optional + demo-grade: single-tenant today, so a client-chosen id is acceptable (real per-account
  // ownership is §23 auth). The server upserts on it (re-link ⇒ same project).
  projectId: z.string().uuid().optional(),
  // Read-only git context captured at link time (§3A.5). Optional: omitted in metadata-only mode and
  // when the root isn't a git repo. The server stores it on the project baseline (M2A); the
  // delta-first engine that consumes it is later.
  git: GitContextSchema.optional(),
  // The validated arcane.toml (§12). Optional: omitted when the repo has no arcane.toml. The cloud
  // uses it to select + configure analyzers (M2B). Not source — sent in all source-access modes.
  config: ArcaneConfigSchema.optional(),
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

// CLI → GET /resync?sessionId — the server's current shadow manifest (§3A.4). Used by the CLI's
// manifest-resync fallback when a resyncFrom names a seq the journal can no longer replay (it was
// acked + dropped, or the log was truncated): the CLI diffs this against disk and re-emits the delta.
export const ResyncResponseSchema = z.object({
  appliedSeq: z.number().int(), // server's highest contiguous applied seq
  serverSnapshotId: z.string().uuid(), // the snapshot the re-emitted deltas apply onto
  files: z.record(z.string()), // path → contentHash of the server's shadow worktree
});
export type ResyncResponse = z.infer<typeof ResyncResponseSchema>;
