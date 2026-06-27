import type { WorkTree as WorkTreeData } from "@arcane/shared";

// The live single-branch working tree of the watch session (the `worktree` ResultEvent, §3A.5). REAL
// data: branch + HEAD come from the CLI's git context; changeCount is the cloud's count of files that
// differ from the link baseline. (The multi-branch DAG + teammate presence are a later milestone.)

function BranchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-blue-600"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5a6 6 0 0 1-6 6H8.5" />
    </svg>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-slate-700">{value}</dd>
    </div>
  );
}

export function WorkTree({ workTree }: { workTree: WorkTreeData | null }) {
  if (!workTree || (!workTree.branch && !workTree.headSha)) {
    return (
      <p className="text-sm text-slate-400">
        No working tree yet — run{" "}
        <code className="rounded bg-slate-100 px-1 font-mono text-slate-600">arcane watch</code> in a
        git repo.
      </p>
    );
  }

  const { branch, headSha, baselineRef, changeCount } = workTree;
  const branchLabel = branch ?? "detached HEAD";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BranchGlyph />
          <span className="font-medium text-slate-900">{branchLabel}</span>
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-500"
            title="watching this branch live"
          />
        </div>
        {typeof changeCount === "number" && (
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
            {changeCount} {changeCount === 1 ? "change" : "changes"}
          </span>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <Field label="HEAD" value={headSha ? headSha.slice(0, 10) : "—"} />
        <Field label="baseline" value={baselineRef ?? "—"} />
      </dl>

      {/* A neat one-line branch graph: baseline ●──── +N ────● branch */}
      <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs">
        <span className="h-2 w-2 shrink-0 rounded-full bg-slate-300" />
        <span className="shrink-0 font-mono text-slate-500">{baselineRef ?? "baseline"}</span>
        <span className="h-px flex-1 bg-gradient-to-r from-slate-300 to-blue-500" />
        {typeof changeCount === "number" && changeCount > 0 && (
          <span className="shrink-0 font-mono font-medium text-blue-600">+{changeCount}</span>
        )}
        <span className="h-px w-5 shrink-0 bg-blue-500" />
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600 ring-2 ring-blue-100" />
        <span className="shrink-0 font-mono font-medium text-blue-700">{branchLabel}</span>
      </div>
    </div>
  );
}
