import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The per-repo link record written by `arcane link` and read by `arcane watch`. It pins the project
// + baseline snapshot the watch session streams onto. Persisted to `.arcane/link.json` (repo-local,
// gitignored) — the four current docs name `~/.arcane` for the TOKEN but are silent on where the
// project id lives, so this location was decided with the user (M1B). `sessionId` is persisted so a
// CLI restart resumes the SAME session (Gate 1: no drift), not a fresh one.

export interface LinkInfo {
  projectId: string; // arcane link → projects.id (uuid)
  baseSnapshotId: string; // the baseline snapshot the first event applies onto (uuid)
  sessionId: string; // this watch session (uuid), stable across CLI restarts
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function linkPath(root: string): string {
  return join(root, ".arcane", "link.json");
}

export function saveLink(root: string, info: LinkInfo): void {
  const path = linkPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
}

// Load the link record, or throw a clear "run `arcane link` first" if the repo isn't linked. Watch
// now REQUIRES a prior link (parentSnapshotId is .uuid() — a real baseSnapshotId is mandatory).
export function loadSession(root: string): LinkInfo {
  const path = linkPath(root);
  if (!existsSync(path)) {
    throw new Error("this repo is not linked — run `arcane link` first");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`corrupt link file at ${path} — re-run \`arcane link\``);
  }
  const info = parsed as Partial<LinkInfo>;
  if (!isUuid(info.projectId) || !isUuid(info.baseSnapshotId) || !isUuid(info.sessionId)) {
    throw new Error(`invalid link file at ${path} — re-run \`arcane link\``);
  }
  return { projectId: info.projectId, baseSnapshotId: info.baseSnapshotId, sessionId: info.sessionId };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
