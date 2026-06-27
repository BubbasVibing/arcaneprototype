import { hasRuntimeRegression, runtimeAdvisory, type RunReport } from "@arcane/shared";

// The web half of the live run view (Build Guide Lane C / Invariant 4): the SAME RunReport the
// terminal renders, from the SAME fanned-out `kind:'run'` event (project:{id} Realtime → view.run).
// The n-plus-one advisory caveat is sourced from @arcane/shared (runtimeAdvisory) — the exact string
// the CLI shows — and the pass/fail verdict from the shared hasRuntimeRegression (one authority).

function fmt(n: number | undefined): string {
  return n === undefined ? "?" : Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function RunView({ run }: { run: RunReport | null }) {
  if (!run) {
    return <p className="text-sm text-zinc-500">No run yet — trigger one with <code>arcane run</code>.</p>;
  }

  const noData = run.status === "no-data";
  const regressed = hasRuntimeRegression(run);
  const headlineColor = noData ? "text-amber-300" : regressed ? "text-rose-400" : "text-emerald-400";
  const tag = noData ? "NO DATA" : `confidence ${run.confidence}`;

  return (
    <div className="space-y-4 rounded border border-zinc-800 bg-zinc-900/60 p-4">
      <div>
        <div className={`text-sm font-semibold ${headlineColor}`}>
          {run.workload}{" "}
          <span className="font-normal text-zinc-400">
            ({run.baselineRef} → {run.currentRef}) · {tag}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-100">{run.summary}</p>
      </div>

      {(run.metrics ?? []).length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Metrics</h3>
          <ul className="space-y-1">
            {(run.metrics ?? []).map((m) => {
              const pct = m.deltaPct == null ? "" : `, ${m.deltaPct > 0 ? "+" : ""}${m.deltaPct.toFixed(0)}%`;
              return (
                <li key={m.key} className="flex items-baseline justify-between text-sm">
                  <span className={m.headline ? "font-medium" : ""}>{m.key}</span>
                  <span className="font-mono tabular-nums text-zinc-300">
                    {fmt(m.baseline.median)} → {fmt(m.current.median)}
                    {m.unit ? ` ${m.unit}` : ""}{" "}
                    <span className={m.delta > 0 ? "text-rose-400" : "text-emerald-400"}>
                      (Δ {m.delta > 0 ? "+" : ""}
                      {fmt(m.delta)}
                      {pct})
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(run.attribution ?? []).length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Attribution</h3>
          <ul className="space-y-2">
            {(run.attribution ?? []).map((a, i) => {
              const advisory = runtimeAdvisory(a.ruleId);
              return (
                <li key={`${a.ruleId}:${a.file}:${i}`} className="rounded border-l-2 border-zinc-700 bg-zinc-900/60 p-2">
                  <p className="text-sm text-zinc-100">{a.evidence}</p>
                  <p className="mt-0.5 font-mono text-xs text-zinc-500">
                    {a.file}
                    {a.range ? `:${a.range.startLine}` : ""}
                    {a.functionName ? ` · ${a.functionName}` : ""} · {a.ruleId} · {a.confidence}
                  </p>
                  {advisory && (
                    <p className="mt-1 text-xs italic text-amber-300/80">⚠ advisory: {advisory}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(run.skipped ?? []).length > 0 && (
        <p className="text-xs text-zinc-500">skipped: {(run.skipped ?? []).join("; ")}</p>
      )}
    </div>
  );
}
