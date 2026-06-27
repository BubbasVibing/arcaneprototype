# @arcane/landing

**Lane B** — the independent Next.js marketing site (arcane.sh): hero, the vibe-coding wedge,
"runs on any computer", privacy block, install snippet, waitlist (Build Guide §6 / B1,
Product-Requirements §2 + §5).

Fully decoupled from the engine — it can be built and deployed anytime, independently of the
CLI and cloud.

> **Not part of the root npm workspace.** It runs React 19 / Next 16, whereas the CLI, cloud, and
> dashboard run React 18 — so it is deliberately excluded (`"!apps/landing"` in the root
> `workspaces`) and keeps its own isolated `node_modules` + lockfile. Install and run it from
> *inside this directory*, not from the repo root.

## Stack

Next.js 16 (App Router, Turbopack) + React 19 + Tailwind v4 + Radix UI + Framer Motion. Imported
from the v0 landing design.

## Develop

```bash
# from THIS directory (apps/landing), not the repo root
npm install
npm run dev    # http://localhost:3000
npm run build
```

Structure: `app/` (routes + layout), `components/` (sections + `ui/` primitives), `hooks/`,
`lib/`, `public/` (assets), `styles/`.
