# Arcane

A **thin Node CLI** that watches a repo and streams every change to a **hosted Bun cloud engine**,
which runs all analysis and fans results back to the terminal and a web app at the same time. No
analysis or code execution happens locally, so Arcane runs on any computer.

> Authoritative design docs live in [`docs/current/`](./docs/current). Start with
> `Arcane-Build-Guide.md`. Ignore `docs/archive/` (superseded local-first design).

## Monorepo layout

```
packages/shared    @arcane/shared — zod wire protocol + domain types (built FIRST; CLI + cloud import it)
packages/cli       @arcane/cli    — Node thin client (watch → stream → render). No analysis.
services/cloud     @arcane/cloud  — Bun analysis engine (deployed, not published). All analysis lives here.
apps/dashboard     Next.js web dashboard (Lane C) — placeholder until M1
apps/landing       Next.js marketing site (Lane B) — placeholder
```

The CLI is **Node** and the cloud is **Bun** — two runtimes sharing one typed contract
(`@arcane/shared`) so the wire protocol can't drift.

## Status: Session 0 (proof-of-life round-trip)

This phase scaffolds the repo and proves a single fake `ChangeEvent` can travel CLI → cloud over a
WebSocket and a single fake `ResultEvent` comes back. There is **no** watcher, analyzer, database,
auth, sandbox, or web wiring yet — those land in M1A+ (Build Guide §6).

### Prerequisites
Node ≥ 20, npm, and [Bun](https://bun.sh) (the cloud engine runs on Bun).

### Prove the round-trip

```bash
# one-time
npm install
npm run build:shared          # @arcane/shared → dist (required before cloud/CLI resolve it)

# terminal 1 — start the cloud stub (Bun)
npm run cloud                 # → "Arcane Cloud (stub) listening on ws://127.0.0.1:8787"

# terminal 2 — build + run the CLI (Node)
npm run build -w @arcane/cli
node packages/cli/dist/cli.js sendtest
```

You should see the CLI send one `ChangeEvent`, the cloud log it, and the CLI print the one
`ResultEvent` it gets back (`✓ round-trip OK`).

### Gates
```bash
npm run typecheck   # tsc --noEmit, strict, across workspaces
npm run test        # vitest (shared schema round-trip)
npm run build       # shared → cli
```
