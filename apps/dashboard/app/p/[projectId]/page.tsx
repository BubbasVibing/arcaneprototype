"use client";

import { FindingsList } from "@/components/FindingsList";
import { ScoreBars } from "@/components/ScoreBars";
import { StatusBar } from "@/components/StatusBar";
import { useResultStream } from "@/lib/useResultStream";

// The live mirror (Build Guide Lane C1): the SAME scores + findings the terminal shows, updating live
// via Supabase Realtime, with honest empty/connecting states. Renders settled frames (per-frame
// flush); the analyzing-phase animation is terminal-only in M1D.
export default function ProjectView({ params }: { params: { projectId: string } }) {
  const { view, status } = useResultStream(params.projectId);

  if (status === "unconfigured") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="rounded border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Dashboard not configured — set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>apps/dashboard/.env.local</code> (the
          anon key only — never <code>service_role</code>).
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">Arcane — live</h1>
        <StatusBar status={status} projectId={params.projectId} />
      </header>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">Scores</h2>
        <ScoreBars scores={view.scores} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
          Findings{view.findings.length > 0 ? ` (${view.findings.length})` : ""}
        </h2>
        <FindingsList findings={view.findings} />
      </section>
    </main>
  );
}
