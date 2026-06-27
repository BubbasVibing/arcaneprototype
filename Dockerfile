# syntax=docker/dockerfile:1
# Arcane Cloud — the Bun engine. Built from the REPO ROOT context (NOT services/cloud): the cloud
# imports @arcane/shared, a workspace sibling under packages/, so the build needs the whole npm
# workspace. (Per CLAUDE.md: cloud = Bun, deps via npm-workspace install, run via `bun run`.)

# Bun is a single static binary; copy it from the official image onto a glibc Node base so the
# workspace install runs under npm (npm honors the `!apps/landing` exclusion in the root package.json).
FROM oven/bun:1 AS bun

FROM node:20-slim AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Full workspace install (incl. devDependencies — the cloud's @supabase/supabase-js is one, needed at
# runtime). Produces node_modules + the @arcane/shared symlink that the cloud resolves at runtime.
COPY . .
RUN npm install --no-audit --no-fund --loglevel=error

# Non-secret config; DATABASE_URL / DIRECT_URL / SUPABASE_* / ARCANE_DEV_TOKEN come from `fly secrets`.
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# Bun runs the TypeScript entry directly; @arcane/shared resolves to its src/ via the workspace link.
CMD ["bun", "run", "services/cloud/src/index.ts"]
