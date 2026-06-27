import type { Score } from "@arcane/shared";

// Per-dimension health bars — mirrors the TUI's score panel data (not its pixels). Amber/red under
// the quality threshold (Requirements §4.1: bars turn amber/red below ~70).
function barColor(value: number): string {
  if (value >= 90) return "bg-emerald-500";
  if (value >= 70) return "bg-amber-500";
  return "bg-rose-500";
}

export function ScoreBars({ scores }: { scores: Score[] }) {
  if (scores.length === 0) {
    return <p className="text-sm text-zinc-500">No scores yet — edit a watched file to run analysis.</p>;
  }
  return (
    <div className="space-y-3">
      {scores.map((s) => (
        <div key={s.dimension}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium capitalize">{s.dimension}</span>
            <span className="tabular-nums text-zinc-400">
              {s.value}
              {s.delta !== 0 && (
                <span className={s.delta < 0 ? "text-rose-400" : "text-emerald-400"}>
                  {" "}
                  ({s.delta > 0 ? "+" : ""}
                  {s.delta})
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded bg-zinc-800">
            <div className={`h-full ${barColor(s.value)}`} style={{ width: `${s.value}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
