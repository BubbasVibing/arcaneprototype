"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Minimal index: open a project's live view. The project id is printed by `arcane link`.
export default function Home() {
  const router = useRouter();
  const [id, setId] = useState("");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Arcane</h1>
      <p className="text-sm text-zinc-400">
        Open a project to mirror its live analysis from the terminal. The project id is printed by{" "}
        <code className="rounded bg-zinc-800 px-1">arcane link</code> (and in{" "}
        <code className="rounded bg-zinc-800 px-1">.arcane/link.json</code>).
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
          className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          className="rounded bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900"
        >
          Open
        </button>
      </form>
    </main>
  );
}
