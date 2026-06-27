import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadConfig } from "../config";

// arcane.toml loader: optional file, parsed by smol-toml, validated by the shared ArcaneConfigSchema.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arcane-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("returns undefined when there is no arcane.toml", async () => {
  expect(await loadConfig(dir)).toBeUndefined();
});

it("parses [project].ignore and [baseline].ref", async () => {
  writeFileSync(
    join(dir, "arcane.toml"),
    '[project]\nignore = ["vendor", "dist"]\n[baseline]\nref = "origin/main"\n',
  );
  const loaded = await loadConfig(dir);
  expect(loaded?.config.project?.ignore).toEqual(["vendor", "dist"]);
  expect(loaded?.config.baseline?.ref).toBe("origin/main");
});

it("throws on invalid TOML", async () => {
  writeFileSync(join(dir, "arcane.toml"), "this is = = not toml");
  await expect(loadConfig(dir)).rejects.toThrow(/invalid TOML/);
});

it("throws on a schema violation (strict schema rejects unknown keys)", async () => {
  writeFileSync(join(dir, "arcane.toml"), "[project]\nnonsense_key = 1\n");
  await expect(loadConfig(dir)).rejects.toThrow(/arcane\.toml:/);
});
