import type { ResultFinding } from "@arcane/shared";

// The latest analysis frame's findings — mirrors the TUI findings list. `new` = is_new vs the parent
// snapshot (delta-first, invariant 8). Severity drives the left accent rail.
const SEV_COLOR: Record<string, string> = {
  critical: "border-l-rose-500",
  high: "border-l-rose-400",
  medium: "border-l-amber-400",
  low: "border-l-slate-300",
  info: "border-l-slate-200",
};

export function FindingsList({ findings }: { findings: ResultFinding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-slate-400">No findings in the latest analysis. ✓</p>;
  }
  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li
          key={f.id}
          className={`rounded-lg border border-l-2 border-slate-200 bg-white p-3 shadow-sm ${
            SEV_COLOR[f.severity] ?? "border-l-slate-300"
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            <span>{f.severity}</span>
            <span className="text-slate-300">·</span>
            <span>{f.dimension}</span>
            {f.isNew && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium normal-case text-blue-700 ring-1 ring-blue-200">
                new
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-slate-800">{f.message}</p>
          <p className="mt-1 font-mono text-xs text-slate-400">
            {f.file}
            {f.range ? `:${f.range.startLine}` : ""} · {f.ruleId}
          </p>
        </li>
      ))}
    </ul>
  );
}
