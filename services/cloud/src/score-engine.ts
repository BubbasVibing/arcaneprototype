import type { Dimension, Finding, Score, Severity } from "@arcane/shared";
import { liveFindingKey } from "./analyzers/types";

// Score engine (plan M1C, Technical-Spec §6). PURE — no I/O, no DB (plan D2a): pipeline.ts reads the
// parent snapshot's scores/finding-keys from Postgres and passes them in. That keeps the durable
// read (pipeline) and the math (here) as separate, independently testable concerns.
//
// §6: each dimension starts at 100; findings subtract a weight by severity; clamp 0–100.
// delta = value − parent score (parent absent → vs 100). is_new = the finding's line-level key
// wasn't present in the parent snapshot.

const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  low: 2,
  medium: 6,
  high: 15,
  critical: 30,
};

export interface ScoredFinding extends Finding {
  isNew: boolean;
}

export interface SnapshotResult {
  scores: Score[];
  findings: ScoredFinding[];
}

export function scoreSnapshot(
  current: Finding[],
  parentScores: Map<Dimension, number>,
  parentKeys: Set<string>,
  covered: Dimension[],
): SnapshotResult {
  const findings: ScoredFinding[] = current.map((f) => ({
    ...f,
    isNew: !parentKeys.has(liveFindingKey(f)),
  }));

  // Score every covered dimension (so a clean dimension still shows 100) plus any dimension that
  // actually has a finding this snapshot.
  const dimensions = new Set<Dimension>(covered);
  for (const f of current) dimensions.add(f.dimension);

  const scores: Score[] = [...dimensions]
    .map((dimension) => {
      const penalty = current
        .filter((f) => f.dimension === dimension)
        .reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
      const value = Math.max(0, Math.min(100, 100 - penalty));
      const prev = parentScores.get(dimension) ?? 100;
      return { dimension, value, delta: value - prev };
    })
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  return { scores, findings };
}
