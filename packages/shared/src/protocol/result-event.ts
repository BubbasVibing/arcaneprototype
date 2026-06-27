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
export const ResultPhaseSchema = z.enum([
  "detected",
  "uploading",
  "queued",
  "analyzing",
  "results",
  "done",
]);
export type ResultPhase = z.infer<typeof ResultPhaseSchema>;

export const StateResultSchema = z.object({
  kind: z.literal("state"),
  sessionId: z.string(),
  phase: ResultPhaseSchema,
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

// Runtime Delta Engine (§19A) — RunReport is a placeholder until M3 (see domain/run-report.ts).
export const RunResultSchema = z.object({
  kind: z.literal("run"),
  report: RunReportSchema,
});

export const ResultEventSchema = z.discriminatedUnion("kind", [
  StateResultSchema,
  ScoreResultSchema,
  FindingResultSchema,
  RunResultSchema,
]);
export type ResultEvent = z.infer<typeof ResultEventSchema>;
