import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { githubConnectorConfigured, installationOctokit } from "../app-auth";
import { materializeTarball } from "../fetch-tree";

// S2 proof: extraction + manifest run against a locally-built gzip tarball shaped like GitHub's tarball
// endpoint (a single top-level "<owner>-<repo>-<sha>/" dir). No network, no DB — pure filesystem.

async function buildGithubStyleTarball(
  topDir: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const work = await mkdtemp(join(tmpdir(), "arcane-gh-test-"));
  const root = join(work, topDir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  const tarPath = join(work, "archive.tgz");
  // `-C work topDir` → archive entries are "<topDir>/...", exactly like GitHub's tarball.
  const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", work, topDir], { stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`test tar failed: ${await new Response(proc.stderr).text()}`);
  const bytes = await readFile(tarPath);
  await rm(work, { recursive: true, force: true });
  return bytes;
}

describe("fetch-tree materializeTarball (S2)", () => {
  test("extracts the single top-level dir and manifests every file with a sha256", async () => {
    const files = {
      "README.md": "# widgets\n",
      "src/a.ts": "export const a = 1;\n",
      "src/nested/b.ts": "export const b = 2;\n",
    };
    const bytes = await buildGithubStyleTarball("acme-widgets-abc1234", files);

    const tree = await materializeTarball(bytes);
    try {
      expect(basename(tree.rootDir)).toBe("acme-widgets-abc1234");

      const byPath = new Map(tree.manifest.map((m) => [m.path, m.contentHash]));
      expect([...byPath.keys()].sort()).toEqual(["README.md", "src/a.ts", "src/nested/b.ts"]);

      // Hash matches an independent sha256 of the same bytes.
      const expected = createHash("sha256").update(files["src/a.ts"]).digest("hex");
      expect(byPath.get("src/a.ts")).toBe(expected);

      // The temp file readable until cleanup.
      const content = await readFile(join(tree.rootDir, "src/nested/b.ts"), "utf8");
      expect(content).toBe(files["src/nested/b.ts"]);
    } finally {
      await tree.cleanup();
    }

    await expect(readFile(join(tree.rootDir, "README.md"))).rejects.toThrow(); // cleanup removed it
  });

  test("rejects a tarball with no single top-level dir", async () => {
    // An empty archive (no top-level dir) must fail loudly, not silently analyze nothing.
    const work = await mkdtemp(join(tmpdir(), "arcane-gh-empty-"));
    const tarPath = join(work, "empty.tgz");
    await writeFile(join(work, "loose.txt"), "x");
    const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", work, "loose.txt"], { stderr: "pipe" });
    await proc.exited;
    const bytes = await readFile(tarPath);
    await rm(work, { recursive: true, force: true });

    await expect(materializeTarball(bytes)).rejects.toThrow(/extracted director/);
  });
});

describe("app-auth connector gating (S2)", () => {
  const prevId = process.env.GITHUB_APP_ID;
  const prevKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const prevSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    restore("GITHUB_APP_ID", prevId);
    restore("GITHUB_APP_PRIVATE_KEY", prevKey);
    restore("GITHUB_WEBHOOK_SECRET", prevSecret);
  });

  test("installationOctokit throws when the App is not configured", () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(() => installationOctokit(42)).toThrow(/not configured/);
  });

  test("githubConnectorConfigured requires app id, private key AND webhook secret", () => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nx\\n-----END RSA PRIVATE KEY-----";
    delete process.env.GITHUB_WEBHOOK_SECRET;
    expect(githubConnectorConfigured()).toBe(false); // secret still missing

    process.env.GITHUB_WEBHOOK_SECRET = "s";
    expect(githubConnectorConfigured()).toBe(true);
  });
});
