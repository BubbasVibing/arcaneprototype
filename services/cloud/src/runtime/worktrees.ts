// M3C — "what are the two trees, and what changed between them". Owns tree materialization + diffing
// for the Runtime Delta Engine. Reuses the proven shadow-worktree helpers (materializeBaseline /
// projectDir / removeProjectDir) — it does NOT define a new on-disk format. Both trees are mounted
// READ-ONLY by the M3A runner, so there is no new writable surface (SI-1 unchanged).

import type { ManifestFile } from "@arcane/shared";
import { materializeBaseline, projectDir, removeProjectDir } from "../shadow-worktree";
import type { Manifest } from "../session-store";

export interface RunTrees {
  baselineDir: string;
  currentDir: string;
  baselineManifest: Manifest;
  currentManifest: Manifest;
  cleanup: () => Promise<void>;
}

// Materialize BOTH sides as on-disk trees for the alternating runs. `materializeBaseline` (despite the
// name) just writes a tree + returns its manifest, so it serves both sides under distinct shadow dirs.
// In the M3D live flow the CURRENT side will instead be the session's existing projectDir (no
// re-materialization); M3C is test-harness-only, so both are materialized explicitly here.
export async function materializeRunTrees(
  runId: string,
  baselineFiles: ManifestFile[],
  currentFiles: ManifestFile[],
): Promise<RunTrees> {
  const baselineId = `${runId}__baseline`;
  const currentId = `${runId}__current`;
  const baselineManifest = await materializeBaseline(baselineId, baselineFiles);
  const currentManifest = await materializeBaseline(currentId, currentFiles);
  return {
    baselineDir: projectDir(baselineId),
    currentDir: projectDir(currentId),
    baselineManifest,
    currentManifest,
    cleanup: async () => {
      await removeProjectDir(baselineId);
      await removeProjectDir(currentId);
    },
  };
}

// Paths whose content differs between the two trees: added, removed, or hash-changed. Pure Map vs Map.
// (Only `manifestHash` existed before — this is the per-path diff.) The changed set is the SOLE possible
// cause of any deterministic runtime delta (the causal-elimination argument attribute.ts rests on).
export function diffManifests(baseline: Manifest, current: Manifest): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of current) {
    if (baseline.get(path) !== hash) changed.add(path); // added or hash-changed
  }
  for (const path of baseline.keys()) {
    if (!current.has(path)) changed.add(path); // removed
  }
  return [...changed].sort();
}

export interface LineRange {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

const MAX_DIFF_LINES = 5000; // O(n·m) guard — above this, treat the whole current file as changed

// Changed/added line ranges in CURRENT coordinates (1-based). A minimal LCS line diff: current lines
// with no identical counterpart in the LCS are "changed", grouped into consecutive ranges. Used to
// locate the enclosing function of a change (attribute.ts). The regression lives in CURRENT, so ranges
// are always in current coordinates. Pure JS, no dep.
export function changedRanges(baselineText: string | undefined, currentText: string): LineRange[] {
  const cur = splitLines(currentText);
  if (cur.length === 0) return [];
  const base = baselineText === undefined ? [] : splitLines(baselineText);
  // New file, or too large to diff cheaply → the whole current file is the changed range.
  if (base.length === 0 || base.length > MAX_DIFF_LINES || cur.length > MAX_DIFF_LINES) {
    return [{ startLine: 1, endLine: cur.length }];
  }
  const matched = lcsMatchedCurrentLines(base, cur); // 0-based current indices that are unchanged
  const ranges: LineRange[] = [];
  let start = -1;
  for (let i = 0; i < cur.length; i++) {
    const isChanged = !matched.has(i);
    if (isChanged && start === -1) start = i;
    if (!isChanged && start !== -1) {
      ranges.push({ startLine: start + 1, endLine: i }); // run [start, i-1] (0-based) → endLine = i
      start = -1;
    }
  }
  if (start !== -1) ranges.push({ startLine: start + 1, endLine: cur.length });
  return ranges;
}

function splitLines(text: string): string[] {
  // Strip one trailing newline so a file ending in "\n" doesn't yield a phantom empty last line.
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t.split("\n");
}

// Standard LCS DP over lines; returns the set of CURRENT (0-based) line indices that participate in the
// longest common subsequence with baseline (the unchanged lines). Everything else in current is changed.
function lcsMatchedCurrentLines(base: string[], cur: string[]): Set<number> {
  const n = base.length;
  const m = cur.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = base[i] === cur[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === cur[j]) {
      matched.add(j);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}
