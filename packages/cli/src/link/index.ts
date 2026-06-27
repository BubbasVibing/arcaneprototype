import { randomUUID } from "node:crypto";
import {
  LinkRequestSchema,
  LinkResponseSchema,
  type ArcaneConfig,
  type GitContext,
} from "@arcane/shared";
import { loadIgnoreRules, makeIgnoreMatcher, type IgnoreRules } from "../collector/ignore";
import { repoProjectId } from "../project-id";
import { buildCurrentTree } from "../run/manifest";
import { saveLink, type LinkInfo } from "../session";

// `arcane link` (Technical-Spec §3A.4): build the initial manifest (path → xxhash) + inline bytes,
// POST it to the cloud, and persist the returned project + baseSnapshot to `.arcane/link.json`. The
// repo walk REUSES the collector's ignore set + content hasher so the baseline matches exactly what
// the watcher will later stream (no drift between `link` and `watch`).

export interface LinkOptions {
  rules?: IgnoreRules; // the shared ignore matcher; built here from projectIgnore if omitted
  projectIgnore?: string[]; // arcane.toml [project].ignore, used only when `rules` is omitted
  git?: GitContext; // read-only git context attached to the link body (§3A.5); omitted in metadata-only
  config?: ArcaneConfig; // validated arcane.toml uploaded so the cloud can select analyzers (M2B)
}

export async function link(
  root: string,
  httpBase: string,
  token: string,
  opts: LinkOptions = {},
): Promise<LinkInfo> {
  const rules = opts.rules ?? (await loadIgnoreRules(root, opts.projectIgnore));
  const ignore = makeIgnoreMatcher(rules);
  // The working-tree manifest — one authority, shared with `arcane run`'s current tree (no drift).
  const files = await buildCurrentTree(root, ignore);

  // A repo-stable projectId (UUIDv5 of the git remote/path) so the dashboard URL is the same every
  // time this repo is linked — on this machine or a fresh clone. The server echoes it back.
  const desiredProjectId = await repoProjectId(root);
  const body = LinkRequestSchema.parse({
    files,
    projectId: desiredProjectId,
    ...(opts.git ? { git: opts.git } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });
  const res = await fetch(`${httpBase}/link`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`link failed: ${res.status} ${await res.text()}`);

  const { projectId, baseSnapshotId } = LinkResponseSchema.parse(await res.json());
  const info: LinkInfo = { projectId, baseSnapshotId, sessionId: randomUUID() };
  saveLink(root, info);
  return info;
}
