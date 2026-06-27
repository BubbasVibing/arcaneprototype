import { defineConfig } from "tsup";

// @arcane/shared builds FIRST. One entry → one bundled ESM file + .d.ts that both the Node CLI
// and the Bun cloud import as the single typed contract (Build Guide Lane D).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
