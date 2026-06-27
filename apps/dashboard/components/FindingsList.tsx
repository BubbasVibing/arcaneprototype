import type { ResultFinding } from "@arcane/shared";

// The latest analysis frame's findings — mirrors the TUI findings list. `new` = is_new vs the parent
// snapshot (delta-first, invariant 8).
const SEV_COLOR: Record<string, string> = {
  critical: "border-rose-500/60",
  high: "border-rose-500/40",
  medium: "border-amber-500/40",
  low: "border-zinc-600",
  info: "border-zinc-700",
};

export function FindingsList({ findings }: { findings: ResultFinding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-zinc-500">No findings in the latest analysis. ✓</p>;
  }
  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li
          key={f.id}
          className={`rounded border-l-2 bg-zinc-900/60 p-3 ${SEV_COLOR[f.severity] ?? "border-zinc-700"}`}
        >
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-400">
            <span>{f.severity}</span>
            <span className="text-zinc-600">·</span>
            <span>{f.dimension}</span>
            {f.isNew && (
              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] normal-case text-sky-300">
                new
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-100">{f.message}</p>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">
            {f.file}
            {f.range ? `:${f.range.startLine}` : ""} · {f.ruleId}
          </p>
        </li>
      ))}
    </ul>
  );
}
