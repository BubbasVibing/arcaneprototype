import { runtimeAdvisory, type ResultPhase, type RunAttribution, type RunMetric, type RunReport } from "@arcane/shared";
import { Box, render, Text } from "ink";
import { useSyncExternalStore } from "react";

// M3D-3 — the terminal half of the live run view. The CLI opens /run/stream after the 202 and feeds
// phases + the final RunReport into a tiny store; this renders them. The SAME report renders on the
// web dashboard from the SAME events (Invariant 4). Pure line-formatters (below) are shared by the
// ink view AND the CI plain-text path so both surfaces describe a metric/attribution identically, and
// the n-plus-one advisory caveat comes from ONE source (runtimeAdvisory in @arcane/shared).

// The run pipeline (distinct from the watch pipeline): what `arcane run` steps through.
const RUN_PHASES: ResultPhase[] = ["queued", "running", "measuring", "done"];

// ---- pure formatters (shared by ink + CI plain text) ---------------------------------------------

function fmt(n: number | undefined): string {
  return n === undefined ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function metricSummary(m: RunMetric): string {
  const unit = m.unit ? ` ${m.unit}` : "";
  const pct = m.deltaPct == null ? "" : `, ${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(0)}%`;
  const arrow = `${fmt(m.baseline.median)} → ${fmt(m.current.median)}${unit}`;
  return `${m.key}: ${arrow} (Δ ${m.delta > 0 ? "+" : ""}${fmt(m.delta)}${pct})`;
}

export function attributionSummary(a: RunAttribution): string {
  const where = a.functionName ? `${a.file} · ${a.functionName}` : a.file;
  const line = a.range ? `:${a.range.startLine}` : "";
  return `${a.ruleId}  ${where}${line} — ${a.evidence}`;
}

// The honest one-line status: a no-data run says so (never a faked "clean").
export function reportHeadline(r: RunReport): string {
  const tag = r.status === "no-data" ? "NO DATA" : `confidence ${r.confidence}`;
  return `${r.workload}  (${r.baselineRef} → ${r.currentRef})  ·  ${tag}`;
}

// ---- CI plain-text path (no TTY): the same content as lines ---------------------------------------

export function formatReportLines(r: RunReport): string[] {
  const lines: string[] = [reportHeadline(r), r.summary];
  for (const m of r.metrics ?? []) lines.push(`  ${metricSummary(m)}`);
  for (const a of r.attribution ?? []) {
    lines.push(`  ${attributionSummary(a)}`);
    const adv = runtimeAdvisory(a.ruleId);
    if (adv) lines.push(`    ⚠ advisory: ${adv}`);
  }
  for (const s of r.skipped ?? []) lines.push(`  skipped: ${s}`);
  return lines;
}

// ---- the ink run view (TTY) ----------------------------------------------------------------------

export interface RunViewState {
  phase: ResultPhase | null;
  report: RunReport | null;
}

export class RunStore {
  private state: RunViewState = { phase: "queued", report: null }; // seed `queued` (we just enqueued)
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): RunViewState => this.state;
  setPhase(phase: ResultPhase): void {
    this.state = { ...this.state, phase };
    this.emit();
  }
  setReport(report: RunReport): void {
    this.state = { ...this.state, report };
    this.emit();
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function PhaseStepper({ phase, noColor }: { phase: ResultPhase | null; noColor: boolean }) {
  const activeIdx = phase ? RUN_PHASES.indexOf(phase) : -1;
  return (
    <Box>
      {RUN_PHASES.map((p, i) => {
        const done = i < activeIdx || phase === "done";
        const active = i === activeIdx && phase !== "done";
        const symbol = active ? "●" : done ? "✓" : "○";
        const color = noColor ? undefined : active ? "cyan" : done ? "green" : "gray";
        return (
          <Text key={p} color={color}>
            {symbol} {p}
            {i < RUN_PHASES.length - 1 ? <Text color={noColor ? undefined : "gray"}>{"  →  "}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function ReportView({ report, noColor }: { report: RunReport; noColor: boolean }) {
  const dim = noColor ? undefined : "gray";
  const regressed = (report.attribution?.length ?? 0) > 0 && report.status !== "no-data";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={noColor ? undefined : report.status === "no-data" ? "yellow" : regressed ? "red" : "green"}>
        {reportHeadline(report)}
      </Text>
      <Text>{report.summary}</Text>
      {(report.metrics ?? []).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={dim}>metrics</Text>
          {(report.metrics ?? []).map((m) => (
            <Text key={m.key}>
              {"  "}
              {m.headline ? <Text bold>{metricSummary(m)}</Text> : metricSummary(m)}
            </Text>
          ))}
        </Box>
      ) : null}
      {(report.attribution ?? []).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={dim}>attribution</Text>
          {(report.attribution ?? []).map((a, i) => {
            const adv = runtimeAdvisory(a.ruleId);
            const where = a.functionName ? `${a.file} · ${a.functionName}` : a.file;
            const loc = a.range ? `:${a.range.startLine}` : "";
            // Each piece on its OWN row (a long combined string mis-wraps in ink, colliding with the
            // caveat). The advisory is the honesty line — give it its own block + a blank line above so
            // it can never run into the wrapped evidence, at any terminal width.
            return (
              <Box flexDirection="column" marginTop={1} key={`${a.ruleId}:${a.file}:${i}`}>
                <Text>
                  {"  "}
                  <Text bold>{a.ruleId}</Text>
                  <Text color={dim}>
                    {"  "}
                    {where}
                    {loc}
                  </Text>
                </Text>
                <Text wrap="wrap">
                  {"  "}
                  {a.evidence}
                </Text>
                {adv ? (
                  <Box marginTop={1}>
                    <Text wrap="wrap" color={noColor ? undefined : "yellow"}>
                      {"  ⚠ advisory: "}
                      {adv}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
      {(report.skipped ?? []).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={dim}>skipped</Text>
          {(report.skipped ?? []).map((s, i) => (
            <Text key={i} color={dim}>{"  "}{s}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function RunView({ store, noColor }: { store: RunStore; noColor: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>arcane run</Text>
      <PhaseStepper phase={state.phase} noColor={noColor} />
      {state.report ? (
        <ReportView report={state.report} noColor={noColor} />
      ) : (
        <Text color={noColor ? undefined : "gray"}>measuring baseline vs current…</Text>
      )}
    </Box>
  );
}

export interface RunViewHandle {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
}

export function mountRunView(store: RunStore, noColor: boolean): RunViewHandle {
  const instance = render(<RunView store={store} noColor={noColor} />);
  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
