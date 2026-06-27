import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArcaneConfigSchema, type ArcaneConfig } from "@arcane/shared";
import { parse as parseToml } from "smol-toml";

// arcane.toml loading (Technical-Spec §12, Product-Requirements §4.1). Parses with smol-toml and
// validates against the SINGLE shared ArcaneConfigSchema (never a second schema). The file is
// optional — a repo with no arcane.toml is fine. M2A consumes only [project].ignore, [baseline].ref
// and [cloud].mode; the rest is validated (the schema is .strict(), so a typo is caught early) but
// interpreted later.

export interface LoadedConfig {
  config: ArcaneConfig;
  raw: string;
}

// Returns undefined when there is no arcane.toml. THROWS on a TOML-syntax or schema-validation
// error so the caller can exit 2 (config error, §4.2 exit contract).
export async function loadConfig(root: string): Promise<LoadedConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, "arcane.toml"), "utf8");
  } catch {
    return undefined; // no arcane.toml — config is optional
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    throw new Error(`arcane.toml: invalid TOML — ${(err as Error).message}`);
  }
  const result = ArcaneConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`arcane.toml: ${issues}`);
  }
  return { config: result.data, raw };
}
