import type { Score } from "@arcane/shared";

// Per-dimension health bars — mirrors the TUI's score panel data (not its pixels). Blue when healthy,
// rose below the quality threshold (Requirements §4.1: bars turn red below ~70).
function barColor(value: number): string {
  if (value >= 90) return "bg-blue-600";
  if (value >= 70) return "bg-blue-400";
  return "bg-rose-500";
}

export function ScoreBars({ scores }: { scores: Score[] }) {
  if (scores.length === 0) {
    return (
      <p className="text-sm text-slate-400">No scores yet — edit a watched file to run analysis.</p>
    );
  }
  return (
    <div className="space-y-4">
      {scores.map((s) => (
        <div key={s.dimension}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium capitalize text-slate-700">{s.dimension}</span>
            <span className="tabular-nums text-slate-500">
              {s.value}
              {s.delta !== 0 && (
                <span className={s.delta < 0 ? "text-rose-600" : "text-emerald-600"}>
                  {" "}
                  ({s.delta > 0 ? "+" : ""}
                  {s.delta})
                </span>
              )}
            </span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all ${barColor(s.value)}`}
              style={{ width: `${s.value}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
