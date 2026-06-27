"use client";

import type { ReactNode } from "react";
import { FindingsList } from "@/components/FindingsList";
import { RunView } from "@/components/RunView";
import { ScoreBars } from "@/components/ScoreBars";
import { StatusBar } from "@/components/StatusBar";
import { WorkTree } from "@/components/WorkTree";
import { useResultStream } from "@/lib/useResultStream";

// The live mirror (Build Guide Lane C1): the SAME scores + findings the terminal shows, updating live
// via Supabase Realtime, with honest empty/connecting states. Renders settled frames (per-frame
// flush); the analyzing-phase animation is terminal-only in M1D.
export default function ProjectView({ params }: { params: { projectId: string } }) {
  const { view, status } = useResultStream(params.projectId);

  if (status === "unconfigured") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">Dashboard not configured</p>
          <p className="mt-1 text-amber-700">
            Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
            <code className="font-mono">apps/dashboard/.env.local</code> (the anon key only — never{" "}
            <code className="font-mono">service_role</code>).
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-center justify-between border-b border-slate-200 pb-5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm bg-blue-600" />
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Arcane</h1>
          <span className="text-slate-300">/</span>
          <span className="text-sm text-slate-500">live</span>
        </div>
        <StatusBar status={status} projectId={params.projectId} />
      </header>

      <div className="mt-8 space-y-8">
        <Section title="Working tree">
          <WorkTree workTree={view.workTree} />
        </Section>

        <Section title="Scores">
          <ScoreBars scores={view.scores} />
        </Section>

        <Section title={`Findings${view.findings.length > 0 ? ` · ${view.findings.length}` : ""}`}>
          <FindingsList findings={view.findings} />
        </Section>

        <Section title="Run">
          <RunView run={view.run} />
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      {children}
    </section>
  );
}
