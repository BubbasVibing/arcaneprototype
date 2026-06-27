import type { StreamStatus } from "@/lib/useResultStream";

// Honest connection/empty states — never a blank panel (Requirements §3: empty/connecting states).
const LABEL: Record<StreamStatus, { text: string; dot: string }> = {
  unconfigured: { text: "not configured", dot: "bg-zinc-500" },
  connecting: { text: "connecting…", dot: "bg-amber-400 animate-pulse" },
  live: { text: "live", dot: "bg-emerald-400" },
  empty: { text: "waiting for first analysis", dot: "bg-sky-400" },
  error: { text: "error", dot: "bg-rose-500" },
};

export function StatusBar({ status, projectId }: { status: StreamStatus; projectId: string }) {
  const s = LABEL[status];
  return (
    <div className="flex items-center justify-between text-sm text-zinc-400">
      <span className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
        {s.text}
      </span>
      <span className="font-mono text-xs text-zinc-600">project {projectId.slice(0, 8)}</span>
    </div>
  );
}
