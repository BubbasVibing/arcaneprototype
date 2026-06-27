"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Optional default project: set NEXT_PUBLIC_DEFAULT_PROJECT_ID in the dashboard env (Next inlines
// NEXT_PUBLIC_* at build) and the root URL opens straight into that project — no UUID to copy for a
// demo. Unset → the manual "open a project" form below.
const DEFAULT_PROJECT_ID = process.env.NEXT_PUBLIC_DEFAULT_PROJECT_ID;

export default function Home() {
  const router = useRouter();
  const [id, setId] = useState(DEFAULT_PROJECT_ID ?? "");

  useEffect(() => {
    if (DEFAULT_PROJECT_ID) router.replace(`/p/${DEFAULT_PROJECT_ID}`);
  }, [router]);

  // A default project is configured — we're redirecting; don't flash the form.
  if (DEFAULT_PROJECT_ID) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6">
        <span className="h-3 w-3 animate-pulse rounded-sm bg-blue-600" />
        <p className="text-sm text-slate-500">Opening your project…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-sm bg-blue-600" />
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Arcane</h1>
      </div>
      <p className="text-sm leading-relaxed text-slate-500">
        Open a project to mirror its live analysis from the terminal. The project id is printed by{" "}
        <code className="rounded bg-slate-100 px-1 font-mono text-slate-700">arcane link</code> (and
        in <code className="rounded bg-slate-100 px-1 font-mono text-slate-700">.arcane/link.json</code>
        ).
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim()) router.push(`/p/${id.trim()}`);
        }}
        className="flex gap-2"
      >
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="project id (uuid)"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Open
        </button>
      </form>
    </main>
  );
}
