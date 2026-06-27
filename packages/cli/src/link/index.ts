import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { LinkRequestSchema, LinkResponseSchema, type ManifestFile } from "@arcane/shared";
import { initHasher, readFileContent } from "../collector/hash";
import { makeIgnoreMatcher } from "../collector/ignore";
import { saveLink, type LinkInfo } from "../session";

// `arcane link` (Technical-Spec §3A.4): build the initial manifest (path → xxhash) + inline bytes,
// POST it to the cloud, and persist the returned project + baseSnapshot to `.arcane/link.json`. The
// repo walk REUSES the collector's ignore set + content hasher so the baseline matches exactly what
// the watcher will later stream (no drift between `link` and `watch`).

async function walk(root: string, ignore: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function recur(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relative(root, abs).split("\\").join("/"); // repo-relative, POSIX
      if (ignore(rel)) continue;
      if (entry.isDirectory()) await recur(abs);
      else if (entry.isFile()) out.push(rel); // symlinks/specials skipped (§3A.1)
    }
  }
  await recur(root);
  return out.sort();
}

export async function link(root: string, httpBase: string, token: string): Promise<LinkInfo> {
  await initHasher(); // WASM ready before any file is hashed
  const ignore = makeIgnoreMatcher();
  const paths = await walk(root, ignore);

  const files: ManifestFile[] = [];
  for (const path of paths) {
    const fc = await readFileContent(join(root, path));
    const file: ManifestFile = {
      path,
      contentHash: fc.hash,
      sizeBytes: fc.size,
      encoding: fc.encoding,
    };
    if (fc.content !== undefined) file.content = fc.content; // inline only when utf8 (else hash-only)
    files.push(file);
  }

  const body = LinkRequestSchema.parse({ files });
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
