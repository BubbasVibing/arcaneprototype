import ts from "typescript";
import type {
  ArcaneConfig,
  Confidence,
  Finding,
  ManifestFile,
  RunAttribution,
  RunReport,
} from "@arcane/shared";
import { assertExecutionAllowed } from "../sandbox/gate";
import { selectSandboxRunner } from "../sandbox/runner";
import { DEFAULT_TIMEOUT_MS } from "../sandbox/spec";
import type { SandboxNetwork } from "../sandbox/spec";
import { measureSingle } from "./measure-single";
import { attributeQueryDelta, changedFunctions, RULE_N_PLUS_ONE } from "./attribute";
import type { ChangedFile } from "./attribute";
import { findingsFromReport, RULE_NON_TERMINATION, RULE_REGRESSION } from "./findings";
import { assembleRunReport, buildMetric, latencyConfidence, METRIC_LATENCY, METRIC_QUERIES } from "./report";
import { mad, removeOutliers, suppressionGate } from "./stats";
import { diffManifests, materializeRunTrees } from "./worktrees";
import type { RunTrees } from "./worktrees";

// M3C — the Runtime Delta Engine (Technical-Spec §19A). Materializes baseline + current trees, runs the
// SAME workload in BOTH under the M3A sandbox + M3B probe, ALTERNATING (counterbalanced), computes
// robust stats, and emits a RunReport + performance Findings WITH confidence on every result. Reuses
// the proven layers below it (measureSingle / dockerRunner / probe / materializeBaseline) — it defines
// no new sandbox or probe.
//
// TEST-HARNESS-TRIGGERED ONLY. This module is NOT wired into pipeline.ts / index.ts — no ChangeEvent /
// CLI / auto path reaches it. The public `arcane run` door + consent are M3D (the single auditable door).
//
// MEASUREMENT-INTEGRITY (decision: bounded trusted-workload assumption; see trace.ts boundary note).
// queryCount rides an in-process channel a HOSTILE workload could forge — but in M3C the only workloads
// that run are test fixtures (no untrusted trigger exists until M3D), and forging fools only the
// developer measuring their own code; containment is unaffected (M3A/M3B). The determinism check below
// defends the NON-adversarial case (flakiness), NOT tamper-resistance. *** M3D MUST NOT open the public
// execution trigger until an out-of-process query observer the workload cannot write to is in place —
// that is the first point an untrusted party chooses the workload a Finding rests on. ***

export const DEFAULT_WARMUP = 2; // discarded per side (JIT / module-load / cold-cache / daemon warm)
export const DEFAULT_MEASURED = 15; // kept per side — enough that p95 is an honest upper-order statistic
const SLACK_ROUNDS = 3; // extra rounds so a few degraded runs don't starve the measured set
const MIN_KEPT = 3; // a side needs at least this many measured samples to be comparable

export interface DeltaRunOptions {
  config: ArcaneConfig | undefined; // gated: execution.enabled must be true (default-deny)
  runId: string; // unique — names the materialized baseline/current shadow dirs
  workload: string; // workload label for the report
  command: string[]; // argv run in BOTH sandboxes, e.g. ["node", "/workspace/workload.js"]
  baselineRef: string; // label only (e.g. "origin/main")
  currentRef: string; // label only
  baselineFiles: ManifestFile[];
  currentFiles: ManifestFile[];
  network?: SandboxNetwork;
  timeoutMs?: number;
  image?: string;
  replayFixtures?: Record<string, { status?: number; body?: string }>;
  warmup?: number; // override DEFAULT_WARMUP (tests)
  measured?: number; // override DEFAULT_MEASURED (tests)
}

export interface DeltaRunResult {
  report: RunReport;
  findings: Finding[];
}

interface ValidSample {
  steadyMs: number | null;
  wallMs: number;
  q: number;
}

export async function runDelta(opts: DeltaRunOptions): Promise<DeltaRunResult> {
  // §19.1 gate 1 — the default-deny master switch. A disabled call is a POLICY refusal → throw loudly
  // (consistent with measureSingle). EVERYTHING after this degrades to no-data, never throws.
  assertExecutionAllowed(opts.config);

  const warmup = opts.warmup ?? DEFAULT_WARMUP;
  const measured = opts.measured ?? DEFAULT_MEASURED;
  const baseMap = textMap(opts.baselineFiles);
  const curMap = textMap(opts.currentFiles);
  const budgetMs = opts.timeoutMs ?? opts.config?.execution?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const noData = (reason: string, summary?: string): DeltaRunResult => {
    const report = assembleRunReport({
      workload: opts.workload,
      baselineRef: opts.baselineRef,
      currentRef: opts.currentRef,
      status: "no-data",
      confidence: "low", // status:"no-data" carries the truth; confidence is moot but required
      skipped: [reason],
      summary,
    });
    return { report, findings: findingsFromReport(report) }; // findingsFromReport → [] for no-data
  };

  let trees: RunTrees;
  try {
    trees = await materializeRunTrees(opts.runId, opts.baselineFiles, opts.currentFiles);
  } catch (e) {
    return noData(`could not materialize run trees: ${(e as Error).message}`);
  }

  try {
    const changedPaths = diffManifests(trees.baselineManifest, trees.currentManifest);

    // ── PROVABLE no-op owner ─────────────────────────────────────────────────────────────────────
    // A whitespace/comment-only change (token-identical modulo formatting) carries NO behavioral
    // hypothesis → run ZERO containers and report no-data. This is what makes the no-op gate PROVABLE,
    // not statistical (the dual-gate in stats.ts is the separate owner of genuine near-noise changes).
    // Conservative: ANY non-code change, add/remove, or real token difference → measure.
    if (isBehavioralNoop(changedPaths, baseMap, curMap)) {
      return noData("no behavioral change", "No behavioral change in the changed set — not measured.");
    }

    // A measurable change → we now need a container runtime. Checked AFTER the no-op short-circuit, so a
    // no-op needs no runtime at all. Absence is honest no-data, NEVER "0 / clean" (§16.15 / SI-2).
    let available = false;
    try {
      available = await selectSandboxRunner(opts.config).isAvailable();
    } catch (e) {
      return noData(`sandbox backend unavailable: ${(e as Error).message}`);
    }
    if (!available) {
      return noData("no container runtime reachable (docker daemon down / not installed)");
    }

    const changed = changedFilesFrom(changedPaths, baseMap, curMap);

    // ── counterbalanced alternating schedule ─────────────────────────────────────────────────────
    const need = warmup + measured;
    const totalRounds = need + SLACK_ROUNDS;
    const bSamples: ValidSample[] = [];
    const cSamples: ValidSample[] = [];
    let bTimeouts = 0;
    let cTimeouts = 0;

    for (let r = 0; r < totalRounds; r++) {
      if (bSamples.length >= need && cSamples.length >= need) break;
      // Counterbalance the order each round (BC, CB, BC, …) so a monotonic drift (daemon warming,
      // thermal) cannot systematically bias one side — still "alternating, never batched" (§19A.3).
      const order: Array<["baseline" | "current", string]> =
        r % 2 === 0
          ? [
              ["baseline", trees.baselineDir],
              ["current", trees.currentDir],
            ]
          : [
              ["current", trees.currentDir],
              ["baseline", trees.baselineDir],
            ];
      for (const [side, dir] of order) {
        const m = await measureSingle({
          config: opts.config,
          command: opts.command,
          mountDir: dir,
          network: opts.network,
          timeoutMs: opts.timeoutMs,
          image: opts.image,
          replayFixtures: opts.replayFixtures,
        });
        const valid = m.trace !== null && m.result.exitCode === 0 && m.result.killReason === null;
        const timedOut = m.result.killReason === "timeout";
        const bucket = side === "baseline" ? bSamples : cSamples;
        if (valid && m.trace) {
          bucket.push({
            steadyMs: m.trace.steadyMs,
            wallMs: m.trace.wallMs ?? m.result.wallMs,
            q: m.trace.queryCount,
          });
        } else if (timedOut) {
          if (side === "baseline") bTimeouts++;
          else cTimeouts++;
        }
      }
    }

    const bEnough = bSamples.length >= warmup + MIN_KEPT;
    const cEnough = cSamples.length >= warmup + MIN_KEPT;

    // Non-termination: baseline measured fine but current could not be measured because it timed out.
    // Falls out cheaply from killReason — emit it rather than silently degrading to no-data.
    if (bEnough && !cEnough && cTimeouts > 0) {
      const attribution = attributeNonTermination(changed, changedPaths, budgetMs, cTimeouts);
      const report = assembleRunReport({
        workload: opts.workload,
        baselineRef: opts.baselineRef,
        currentRef: opts.currentRef,
        status: "measured",
        confidence: maxConfidence(attribution),
        warmupPerSide: warmup,
        attribution,
        skipped: ["current did not terminate within budget — latency/queries not measured"],
        summary: `Non-termination: current exceeded the ${budgetMs}ms budget (${cTimeouts}×) where baseline completed.`,
      });
      return { report, findings: findingsFromReport(report) };
    }

    if (!bEnough || !cEnough) {
      const which = !bEnough && !cEnough ? "both sides" : !bEnough ? "baseline" : "current";
      return noData(
        `insufficient valid runs on ${which} (baseline ${bSamples.length}, current ${cSamples.length} of ${need})`,
      );
    }

    // Discard warmup, keep the measured window.
    const bKept = bSamples.slice(warmup, warmup + measured);
    const cKept = cSamples.slice(warmup, warmup + measured);

    // Latency sample: steadyMs (warm steady-state) when present on EVERY kept run of BOTH sides; else a
    // SYMMETRIC fallback to wallMs for both (never mix cold/import/steady across sides) + lower confidence.
    const allSteady = bKept.every((s) => s.steadyMs != null) && cKept.every((s) => s.steadyMs != null);
    const pickLatency = (s: ValidSample): number => (allSteady ? (s.steadyMs as number) : s.wallMs);
    const bOut = removeOutliers(bKept.map(pickLatency));
    const cOut = removeOutliers(cKept.map(pickLatency));
    const bLat = bOut.kept;
    const cLat = cOut.kept;

    // Query counts are EXACT integers (no outlier removal). Determinism check (the integrity keystone):
    // queryCount must be constant within EACH side's repeats, else the workload is nondeterministic in
    // query count and N+1 attribution is withheld (honest no-data for the count claim).
    const bQ = bKept.map((s) => s.q);
    const cQ = cKept.map((s) => s.q);
    const determinismHeld = allEqual(bQ) && allEqual(cQ);
    const baselineQ = bQ[0]!;
    const currentQ = cQ[0]!;
    const queryDelta = currentQ - baselineQ;

    const latencyMetric = buildMetric(METRIC_LATENCY, "ms", bLat, cLat, true);
    const queriesMetric = buildMetric(METRIC_QUERIES, "queries", bQ, cQ);

    const attribution: RunAttribution[] = [];

    // N+1 — driven SOLELY by the query-count delta (the pg stub returns instantly, so N+1 is invisible
    // to the latency gate). Determinism-gated; queryDelta must be positive.
    if (determinismHeld && queryDelta > 0) {
      attribution.push(...attributeQueryDelta(changed, queryDelta, baselineQ, currentQ));
    }

    // Latency regression — the dual-gate (magnitude AND robust band non-overlap). Either fails → no finding.
    const gate = suppressionGate({
      baselineP95: latencyMetric.baseline.p95,
      currentP95: latencyMetric.current.p95,
      baselineMedian: latencyMetric.baseline.median,
      currentMedian: latencyMetric.current.median,
      baselineMad: mad(bLat),
      currentMad: mad(cLat),
    });
    const latConf = latencyConfidence({
      measuredBothSides: true,
      baselineLatency: bLat,
      currentLatency: cLat,
      latencyFallback: !allSteady,
    });
    if (gate.emit) {
      attribution.push(regressionAttribution(changed, gate.reasons, latConf, latencyMetric));
    }

    const reportConfidence = attribution.length ? maxConfidence(attribution) : latConf;
    const report = assembleRunReport({
      workload: opts.workload,
      baselineRef: opts.baselineRef,
      currentRef: opts.currentRef,
      status: "measured",
      confidence: reportConfidence,
      warmupPerSide: warmup,
      runsPerSide: measured,
      outliersRemoved: bOut.removed + cOut.removed,
      metrics: [latencyMetric, queriesMetric],
      attribution,
      skipped: determinismHeld
        ? undefined
        : ["query count was non-deterministic across repeats — N+1 attribution withheld"],
    });
    return { report, findings: findingsFromReport(report) };
  } catch (e) {
    // A delta-engine failure degrades to "no runtime data" — never crashes a caller (reuse degrade pattern).
    return noData(`runtime delta failed: ${(e as Error).message}`);
  } finally {
    await trees.cleanup().catch(() => {});
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function textMap(files: ManifestFile[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) if (typeof f.content === "string") m.set(f.path, f.content);
  return m;
}

function isCodeFile(path: string): boolean {
  return /\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(path);
}

// Token-stream equality modulo whitespace/comments (TS scanner with skipTrivia). Conservative: ANY real
// token difference returns false. This is the lexical basis of the PROVABLE no-op short-circuit.
function tokenEquivalent(a: string, b: string, path: string): boolean {
  const variant =
    path.endsWith(".tsx") || path.endsWith(".jsx")
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard;
  const toks = (src: string): string[] => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, variant, src);
    const out: string[] = [];
    let kind = scanner.scan();
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
      out.push(`${kind}:${scanner.getTokenText()}`);
      kind = scanner.scan();
    }
    return out;
  };
  const ta = toks(a);
  const tb = toks(b);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
  return true;
}

// True iff the change provably cannot alter behavior: nothing changed, or every changed path is an
// in-place code edit that is token-identical modulo formatting. An add/remove, a non-code change, or any
// real token difference → false (we must measure).
function isBehavioralNoop(
  changedPaths: string[],
  baseMap: Map<string, string>,
  curMap: Map<string, string>,
): boolean {
  if (changedPaths.length === 0) return true;
  for (const p of changedPaths) {
    if (!isCodeFile(p)) return false;
    const before = baseMap.get(p);
    const after = curMap.get(p);
    if (before === undefined || after === undefined) return false; // added / removed / non-inline
    if (!tokenEquivalent(before, after, p)) return false;
  }
  return true;
}

function changedFilesFrom(
  changedPaths: string[],
  baseMap: Map<string, string>,
  curMap: Map<string, string>,
): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const p of changedPaths) {
    if (!isCodeFile(p)) continue; // AST attribution is code-only
    const currentText = curMap.get(p);
    if (currentText === undefined) continue; // removed / non-inline → can't AST-attribute
    out.push({ path: p, baselineText: baseMap.get(p), currentText });
  }
  return out;
}

function allEqual(xs: number[]): boolean {
  return xs.every((x) => x === xs[0]);
}

function maxConfidence(attrs: RunAttribution[]): Confidence {
  if (attrs.some((a) => a.confidence === "high")) return "high";
  if (attrs.some((a) => a.confidence === "medium")) return "medium";
  return "low";
}

function attributeNonTermination(
  changed: ChangedFile[],
  changedPaths: string[],
  budgetMs: number,
  timeouts: number,
): RunAttribution[] {
  const evidence = `current exceeded the ${budgetMs}ms time budget (${timeouts} timeout${timeouts === 1 ? "" : "s"}); baseline completed`;
  const named = changedFunctions(changed).filter((s) => s.functionName);
  if (named.length === 1) {
    const s = named[0]!;
    return [
      {
        ruleId: RULE_NON_TERMINATION,
        file: s.file,
        functionName: s.functionName,
        range: s.range,
        confidence: "high",
        evidence,
      },
    ];
  }
  if (named.length > 1) {
    return named.map((s) => ({
      ruleId: RULE_NON_TERMINATION,
      file: s.file,
      functionName: s.functionName,
      range: s.range,
      confidence: "medium" as const,
      evidence,
    }));
  }
  const file = changedPaths[0] ?? "(workload)";
  return [{ ruleId: RULE_NON_TERMINATION, file, confidence: "medium", evidence }];
}

function regressionAttribution(
  changed: ChangedFile[],
  reasons: string[],
  confidence: Confidence,
  metric: { baseline: { p95: number }; current: { p95: number }; deltaPct: number | null },
): RunAttribution {
  const named = changedFunctions(changed).filter((s) => s.functionName);
  const pct = metric.deltaPct != null ? `${metric.deltaPct.toFixed(0)}%` : "?";
  const evidence = `measured p95 ${metric.baseline.p95.toFixed(1)}→${metric.current.p95.toFixed(1)}ms (${pct}); ${reasons.join("; ")}`;
  if (named.length === 1) {
    const s = named[0]!;
    return {
      ruleId: RULE_REGRESSION,
      file: s.file,
      functionName: s.functionName,
      range: s.range,
      confidence,
      evidence,
    };
  }
  const file = named[0]?.file ?? changed[0]?.path ?? "(workload)";
  return { ruleId: RULE_REGRESSION, file, confidence, evidence };
}
