import { randomUUID } from "node:crypto";
import { LinkRequestSchema, LinkResponseSchema, type LinkResponse } from "@arcane/shared";
import type { SessionStore } from "./session-store";
import { manifestHash, materializeBaseline } from "./shadow-worktree";

// `arcane link` (Technical-Spec §3A.4): the CLI uploads its initial manifest + inline file bytes;
// the server mints a projectId, materializes the shadow worktree, mints a baseSnapshotId, and
// records the baseline so the first watch session can seed from it. M1B always CREATES a project.

export async function handleLink(req: Request, store: SessionStore): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = LinkRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid LinkRequest", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const projectId = randomUUID(); // projects.id (§7)
  const manifest = await materializeBaseline(projectId, parsed.data.files);
  const baseSnapshotId = randomUUID(); // source_snapshots.id (§7) — minted, not content-derived
  await store.registerBaseline(projectId, { manifest, baseSnapshotId });

  const res: LinkResponse = { projectId, baseSnapshotId };
  LinkResponseSchema.parse(res); // self-check the contract before it goes on the wire
  console.log(
    `✓ link project=${projectId.slice(0, 8)} files=${parsed.data.files.length} ` +
      `baseSnapshot=${baseSnapshotId.slice(0, 8)} manifestHash=${manifestHash(manifest).slice(0, 12)}`,
  );
  return Response.json(res, { status: 200 });
}
