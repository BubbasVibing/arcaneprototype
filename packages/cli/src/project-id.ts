import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";

// A STABLE projectId for this repo so the dashboard URL doesn't change between links/clones/machines.
// Derived from the git `origin` remote when present (so the same GitHub repo maps to the same id on
// any machine), else the absolute repo path (local-only). Formatted as a deterministic UUIDv5 — a
// valid UUID (the link contract + .arcane/link.json both require one).

export async function repoProjectId(root: string): Promise<string> {
  return uuidV5(`arcane:${await repoIdentity(root)}`);
}

async function repoIdentity(root: string): Promise<string> {
  try {
    const remotes = await simpleGit(root).getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
    const url = origin?.refs?.fetch || origin?.refs?.push;
    if (url) return normalizeRemote(url);
  } catch {
    // not a repo / no git binary — fall through to the path
  }
  return resolve(root);
}

// git@github.com:user/repo.git | https://github.com/user/repo.git | ssh://… → github.com/user/repo
function normalizeRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/, "$1/") // scp-style → host/path
    .replace(/^[a-z]+:\/\//, "") // strip scheme
    .replace(/^[^@/]+@/, "") // strip user[:pass]@ credentials
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

// Deterministic UUIDv5 (SHA-1 based) of `name` — same input ⇒ same UUID, every time.
function uuidV5(name: string): string {
  const b = Buffer.from(createHash("sha1").update(name).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
