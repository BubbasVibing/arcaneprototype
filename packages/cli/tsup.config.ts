import { defineConfig } from "tsup";

// @arcane/cli — Node thin client. Build to a single ESM bin with a shebang.
// noExternal bundles @arcane/shared into the bin so the published CLI never depends on an
// unpublished workspace package (plan §2).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@arcane/shared"],
  // The CLI now imports an Ink/React .tsx tree (collector → ws → TUI). esbuild compiles JSX;
  // use the automatic runtime so we don't need `import React` in every component (M1A).
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
  },
});
