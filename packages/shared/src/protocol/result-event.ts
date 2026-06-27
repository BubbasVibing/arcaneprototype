import { z } from "zod";
import { FindingSchema } from "../domain/finding";
import { RunReportSchema } from "../domain/run-report";
import { ScoreSchema } from "../domain/score";

// Technical-Spec §3B.2 — wire protocol, cloud → CLI + web result stream. One ResultEvent fans out
// to the CLI socket AND Supabase Realtime at the same time (invariant 4).
//
// `phase` is the SUPERSET of §3B.2's typed enum (uploading|queued|analyzing|done) and the TUI
// pipeline states (§2A/§3B.1: change detected → uploading → queued → analyzing → results), so the
// contract covers every state the terminal renders without a later breaking change.
// ('detected' = "change detected".)
//
// M3D (approved Q4): a RUN's lifecycle rides the SAME kind:'state' event — `running` (sandbox
// executing) and `measuring` (alternating runs in flight) — NOT a new wire event. `queued`/`done` are
// reused for the run-job lifecycle too.
export const ResultPhaseSchema = z.enum([
  "detected",
  "uploading",
  "queued",
  "analyzing",
  "results",
  "running", // M3D: a run job is executing in the sandbox
  "measuring", // M3D: the Runtime Delta Engine's alternating runs are in flight
  "done",
]);
export type ResultPhase = z.infer<typeof ResultPhaseSchema>;

export const StateResultSchema = z.object({
  kind: z.literal("state"),
  sessionId: z.string(),
  phase: ResultPhaseSchema,
  // M3D: present on RUN lifecycle events so a consumer can disambiguate concurrent runs / run-vs-
  // analysis on the shared project:{id} channel. Absent for static-analysis state events.
  runId: z.string().optional(),
});

// { kind: 'score'; dimension; value; delta } — reuses the Score domain shape (§6).
export const ScoreResultSchema = ScoreSchema.extend({
  kind: z.literal("score"),
});

export const FindingResultSchema = z.object({
  kind: z.literal("finding"),
  finding: FindingSchema,
  isNew: z.boolean(),
});

// Runtime Delta Engine (§19A). M3D streams this as the final event of a run job; `runId` ties it to
// the run's `state` lifecycle events on the shared channel.
export const RunResultSchema = z.object({
  kind: z.literal("run"),
  report: RunReportSchema,
  runId: z.string().optional(),
});

// Working-tree state — the live single-branch git context of an `arcane watch` session. Rides the
// SAME result stream as state/score/finding so the web dashboard renders it with no new channel. The
// cloud emits it once per analysis frame, sourcing branch/headSha/baselineRef from the CLI's /ingest
// git context (§3A.5) and changeCount from the shadow-worktree manifest vs the link baseline. (The
// multi-branch Work-Tree DAG + teammate presence remain a later milestone, §22.)
export const WorkTreeResultSchema = z.object({
  kind: z.literal("worktree"),
  sessionId: z.string(),
  branch: z.string().nullable(), // null on detached HEAD / not-a-repo
  headSha: z.string().nullable(), // null when the repo has no commits yet
  baselineRef: z.string().optional(), // e.g. "origin/main" (from arcane.toml [baseline].ref)
  changeCount: z.number().int().nonnegative().optional(), // files changed vs the link baseline
});

export const ResultEventSchema = z.discriminatedUnion("kind", [
  StateResultSchema,
  ScoreResultSchema,
  FindingResultSchema,
  RunResultSchema,
  WorkTreeResultSchema,
]);
export type ResultEvent = z.infer<typeof ResultEventSchema>;
