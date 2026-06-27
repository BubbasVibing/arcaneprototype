import { randomUUID } from "node:crypto";
import { LinkRequestSchema, LinkResponseSchema, type LinkResponse } from "@arcane/shared";
import { ensureProject, insertBaselineSnapshot } from "./db/repository";
import type { SessionStore } from "./session-store";
import { manifestHash, materializeBaseline } from "./shadow-worktree";

// `arcane link` (Technical-Spec §3A.4): the CLI uploads its initial manifest + inline file bytes;
// the server mints a projectId, materializes the shadow worktree, mints a baseSnapshotId, and
// records the baseline so the first watch session can seed from it. M1B always CREATES a project.
// M1C also PERSISTS the project + baseline snapshot to Postgres (the first parent in the analyzed
// chain, plan D2a) so the §7 FK chain is satisfiable once watch events start producing scores.

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
  await store.registerBaseline(projectId, { manifest, baseSnapshotId, git: parsed.data.git });

  // Persist the project (→ dev org) + baseline snapshot/manifest (D2b/D2a).
  await ensureProject(projectId, `arcane-${projectId.slice(0, 8)}`);
  await insertBaselineSnapshot(
    projectId,
    baseSnapshotId,
    manifestHash(manifest),
    [...manifest].map(([path, contentHash]) => ({ path, contentHash })),
  );

  const res: LinkResponse = { projectId, baseSnapshotId };
  LinkResponseSchema.parse(res); // self-check the contract before it goes on the wire
  console.log(
    `✓ link project=${projectId.slice(0, 8)} files=${parsed.data.files.length} ` +
      `baseSnapshot=${baseSnapshotId.slice(0, 8)} manifestHash=${manifestHash(manifest).slice(0, 12)}`,
  );
  return Response.json(res, { status: 200 });
}
