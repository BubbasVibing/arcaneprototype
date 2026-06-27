import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";

// DB-gated integration test (plan D2a). Runs only when DATABASE_URL points at a MIGRATED database
// (so the dev org/user seed exists). Dynamic imports keep db/client — which fails fast without
// DATABASE_URL — out of the module graph when the test is skipped.
const HAS_DB = Boolean(process.env.DATABASE_URL);

test.skipIf(!HAS_DB)("repository round-trips an analyzed snapshot chain", async () => {
  const repo = await import("../db/repository");
  const { sql } = await import("../db/client");

  const projectId = randomUUID();
  const baseId = randomUUID();
  const sessionId = randomUUID();
  const snapId = randomUUID();

  try {
    await repo.ensureProject(projectId, "repo-test");
    await repo.insertBaselineSnapshot(projectId, baseId, "hash0", [
      { path: "a.ts", contentHash: "h1" },
    ]);
    await repo.ensureSession(sessionId, projectId, baseId);

    await repo.persistSnapshotResults({
      projectId,
      sessionId,
      snapshotId: snapId,
      parentSnapshotId: baseId,
      manifestHash: "hash1",
      files: [{ path: "a.ts", contentHash: "h2" }],
      scores: [{ dimension: "complexity", value: 80, delta: -20 }],
      findings: [
        {
          id: "f1",
          dimension: "complexity",
          severity: "high",
          ruleId: "complexity/cyclomatic",
          message: "too complex",
          file: "a.ts",
          range: { startLine: 3, startCol: 1, endLine: 9, endCol: 1 },
          fixable: false,
          isNew: true,
        },
      ],
    });

    expect(await repo.latestAnalyzedSnapshot(sessionId)).toBe(snapId);
    expect((await repo.getScores(snapId)).get("complexity")).toBe(80);

    const findings = await repo.getFindings(snapId);
    expect(findings.length).toBe(1);
    expect(findings[0]!.startLine).toBe(3);
    expect(findings[0]!.endLine).toBe(9);
  } finally {
    await sql`DELETE FROM findings WHERE snapshot_id = ${snapId}`;
    await sql`DELETE FROM scores WHERE snapshot_id = ${snapId}`;
    await sql`DELETE FROM source_files WHERE snapshot_id IN (${snapId}, ${baseId})`;
    await sql`DELETE FROM source_snapshots WHERE id IN (${snapId}, ${baseId})`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
  }
});
