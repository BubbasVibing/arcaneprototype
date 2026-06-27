import { z } from "zod";

// Technical-Spec §3A.5 — git context the CLI reads (READ-ONLY) and attaches to the stream: the
// branch + HEAD commit, plus the delta baseline ref and its resolved SHA. Sent "on link and when
// they change" (§3A.5); metadata-only mode sends none of it. M2A only READS + ATTACHES this; the
// delta-first engine that consumes `baselineSha` is later.
//
// As a cross-lane contract (Build Guide rule 4) it lives here in @arcane/shared. It travels two
// ways, both as connection metadata (NOT a new message frame): in the `link` REST body
// (LinkRequest.git) and as `/ingest` WS-URL query params re-read on each (re)connect.
export const GitContextSchema = z.object({
  isRepo: z.boolean(), // false when the root is not a git repo or the git binary is absent
  branch: z.string().nullable(), // null on detached HEAD
  headSha: z.string().nullable(), // null when the repo has no commits yet
  baselineRef: z.string().optional(), // from arcane.toml [baseline].ref (e.g. "origin/main")
  baselineSha: z.string().nullable().optional(), // baselineRef resolved to a SHA, null if unresolvable
});
export type GitContext = z.infer<typeof GitContextSchema>;
