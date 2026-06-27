// Shared subprocess helper for external-CLI analyzers (M2B). Captures stdout/stderr/exit code and
// honors an AbortSignal (a newer burst supersedes this run). The CLI tools are baked into the engine
// image, not npm deps; the per-analyzer wrapper parses the tool's native JSON.

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runTool(
  cmd: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<ToolResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// Repo-relative POSIX path from a tool's output path, which may be absolute or `./`-prefixed.
export function toRepoRelative(rootDir: string, p: string): string {
  let rel = p.replaceAll("\\", "/");
  const root = rootDir.replaceAll("\\", "/").replace(/\/$/, "");
  if (rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
  if (rel.startsWith("./")) rel = rel.slice(2);
  return rel;
}
