import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ResyncResponseSchema, type ChangeEvent } from "@arcane/shared";
import { initHasher, readFileContent } from "../collector/hash";
import { makeIgnoreMatcher } from "../collector/ignore";
import type { FileContent } from "../collector/types";
import type { Journal } from "../journal";
import { walkRepo } from "../repo-walk";
import type { LinkInfo } from "../session";

// Manifest resync (Technical-Spec §3A.4): the fallback when a `resyncFrom` names a seq the journal
// can no longer replay (acked + dropped, or the log was truncated). Fetch the server's shadow
// manifest, diff it against disk, and re-emit the delta as ordered ChangeEvents numbered from the
// server's applied high-water (realigning the journal's seq counter so they land contiguously).
//
// Assumes the collector is quiescent during recovery — there is one seq authority (the journal) but
// no pause coordination yet, so a concurrent edit mid-resync is an M1C concern.
export async function manifestResync(
  root: string,
  httpBase: string,
  token: string,
  session: LinkInfo,
  journal: Journal,
  send: (ev: ChangeEvent) => void,
): Promise<number> {
  const res = await fetch(`${httpBase}/resync?sessionId=${session.sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`resync fetch failed: ${res.status}`);
  const { appliedSeq, serverSnapshotId, files: serverFiles } = ResyncResponseSchema.parse(
    await res.json(),
  );

  await initHasher();
  const ignore = makeIgnoreMatcher();
  const paths = await walkRepo(root, ignore);

  // Disk manifest (path → content), then diff vs the server: add (disk-only), change (hash differs),
  // delete (server-only).
  const disk = new Map<string, FileContent>();
  for (const p of paths) disk.set(p, await readFileContent(join(root, p)));

  const deltas: Array<{ op: "add" | "change" | "delete"; path: string }> = [];
  for (const [p, fc] of disk) {
    const serverHash = serverFiles[p];
    if (serverHash === undefined) deltas.push({ op: "add", path: p });
    else if (serverHash !== fc.hash) deltas.push({ op: "change", path: p });
  }
  for (const p of Object.keys(serverFiles)) {
    if (!disk.has(p)) deltas.push({ op: "delete", path: p });
  }

  // Re-number from the server's applied high-water so the deltas land contiguously.
  journal.resetSeqTo(appliedSeq + 1);
  for (const delta of deltas) {
    const seq = journal.allocSeq();
    let ev: ChangeEvent = {
      eventId: randomUUID(),
      sessionId: session.sessionId,
      projectId: session.projectId,
      parentSnapshotId: serverSnapshotId, // advisory in M1B; the server orders by seq
      seq,
      ts: Date.now(),
      op: delta.op,
      path: delta.path,
    };
    if (delta.op !== "delete") {
      const fc = disk.get(delta.path) as FileContent;
      ev = {
        ...ev,
        contentHash: fc.hash,
        sizeBytes: fc.size,
        encoding: fc.encoding,
        ...(fc.content !== undefined ? { content: fc.content } : {}),
      };
    }
    journal.append(ev);
    send(ev);
  }
  return deltas.length;
}
