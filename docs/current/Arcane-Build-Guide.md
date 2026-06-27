# Arcane — Build Guide

**The entry point for everyone (humans + coding agents).** Read §1 (Agent Operating Rules) before writing any code. This doc tells you *what to build, in what order, in which lane, and which other doc to open for detail.* It is optimized to be dropped in as / alongside `CLAUDE.md`.

**What Arcane is (one paragraph).** Arcane is a **thin local CLI + a hosted cloud analysis engine** (the Claude Code model). A lightweight Node npm CLI watches the repo and streams **every change** (inserts, edits, deletions, renames — accurately, in realtime) to **Arcane Cloud**; the cloud (Bun) runs all analysis, security, AI review, and sandboxed runtime verification, and streams results back **simultaneously to the terminal and the web dashboard**. Because no analysis or code execution happens locally, **Arcane runs on any computer.** The wedge is unchanged: agent-generated code "works in the demo" but silently degrades (N+1 queries, missing indexes, no caching, security holes, no tests), and Arcane catches it the moment it appears.

> **Runtime claim — say it exactly this way (you will be challenged on it):** Arcane does **not** predict production runtime from source. It measures *controlled runtime regressions* by running user-declared workloads in **Arcane-managed isolated cloud environments**, comparing **baseline vs current** under identical conditions, and attributing slowdowns to changed code via traces + static analysis. It's a consistent *relative regression* signal, not a production-runtime prediction; class-level microbenchmarks are **supporting diagnosis only**. Methodology: Technical-Spec §19A.

---

## 0. Document map — open the right file

| If you need… | Open | Notes |
|---|---|---|
| Rules, lanes, build order (start here) | **this file** (`Arcane-Build-Guide.md`) | the router + phase plan |
| How it works: the change-collector protocol, cloud engine, fan-out, schemas, sandbox, Runtime Delta Engine | **`Arcane-Technical-Spec.md`** | deep implementation reference; load only the cited section |
| Why it exists, positioning, the heartbeat vision | **`Arcane-Project-Map.md`** | background / narrative |
| Landing-page + dashboard **UI requirements**, full **`arcane.toml`** + **command reference**, marketing copy | **`Arcane-Product-Requirements.md`** | peripheral context — pulled out so it doesn't bloat the agent's window |

**Context rule for agents:** do **not** load all four docs at once. Load this Build Guide + the *one* Technical-Spec section your current phase cites. Pull from the Requirements doc only when your task is UI, config, or copy.

**Repo hygiene (do this once):** keep these four docs under `/docs/current/`; move any earlier drafts to `/docs/archive/`. Older drafts describe the superseded **local-first** design (local analyzers, "code never leaves the machine," offline analysis) and will mislead an agent. Put a line in the root `CLAUDE.md`: *"Only `/docs/current` is authoritative; ignore `/docs/archive` unless explicitly asked."* **Single sources of truth:** `arcane.toml` + commands → Requirements §4; milestone plan → Technical-Spec §17; wire protocol → `@arcane/shared` (Technical-Spec §3A.2/§3B.2).

---

## 1. Agent Operating Rules (READ FIRST — non-negotiable)

These rules exist to stop hallucination and scope drift. Treat them as hard constraints, not suggestions.

1. **Never invent APIs, flags, schema fields, config keys, file paths, or library behavior.** If it isn't written in these docs or visible in the codebase, it does not exist yet.
2. **If a needed detail is missing, STOP and ASK.** Do not guess a plausible value and move on. A one-line question beats an hour of wrong code.
3. **Build strictly phase-by-phase (§6). Never jump ahead.** Do not scaffold M3 while M1 is unfinished. Each phase has an explicit "Done when" gate; meet it before the next.
4. **Stay in your lane (§3).** A CLI task does not touch the dashboard; a landing task does not touch the engine. Cross-lane changes go through the shared package (Lane D), not by reaching into another lane's code.
5. **Respect the invariants (§8).** They hold across every phase. If a task seems to require breaking one, you've misread the task — ask.
6. **Verify before you claim "done."** Run `npm run build`, `npx vitest run`, and `npx tsc --noEmit`; from M7 also `arcane gate`. Paste the actual output. "It should work" is not done.
7. **No dependency that isn't listed for your phase.** Adding a package requires asking first (name + one-line reason). Lean dependency tree is an invariant.
8. **Never present mock/placeholder data as real.** Stubs must be labeled `// STUB:` and must not silently ship. No fabricated metrics, scores, or findings.
9. **Cite your source.** When a non-obvious decision comes from a doc, reference the section (e.g. `// per Technical-Spec §5`) in the code or PR description.
10. **One concern per commit/PR.** Small, atomic, reversible. A commit does one thing; its message says what and why.
11. **Don't reformat or refactor unrelated code** while doing a task. Touch only what the task needs.
12. **Match the established patterns.** Reuse the existing analyzer interface, schemas, error handling, and naming. Don't introduce a second way to do a thing that already has one.

> Drop rules 1–12 verbatim into the root `CLAUDE.md` (a ready seed is in §9).

---

## 2. The decided stack (two runtimes — don't mix them)

- **Local CLI — `@arcane/cli` (Node.js ≥ 20, TS strict, ESM).** Deliberately **zero native addons** so `npm i -g` is painless on any machine. Deps: Ink + react (TUI) · chokidar (watch) · ws (WebSocket) · xxhash-wasm (hash) · simple-git (read-only git context) · smol-toml · zod (via `@arcane/shared`) · chalk. Token stored in a `~/.arcane` file. **The CLI never analyzes or runs code.**
- **Arcane Cloud — the engine (Bun + TS).** `Bun.serve` (WS+REST gateway) · BullMQ queue · Postgres + object storage (Supabase) · tree-sitter + semgrep/gitleaks/knip/osv analyzers · microVM/container sandbox (M3) · `@anthropic-ai/sdk` · Supabase Realtime for fan-out. **All analysis lives here.**
- **Shared — `@arcane/shared` (TS).** zod wire protocol (ChangeEvent, ResultEvent) + domain (Finding, Metric, Score, RunReport, ArcaneConfig). Imported by both CLI and cloud.
- **Web — `apps/dashboard` (Next.js + Tailwind + Supabase Realtime on Vercel).** Updates live, in lockstep with the terminal. **Landing — `apps/landing`** (Next.js, independent).
- **Distribution:** publish `@arcane/cli` to npm (`bin`, shebang, no native deps); deploy the Bun engine as a service (+ Supabase + Redis); self-host ships the same engine image.

Full split tables + rationale: Technical-Spec §2 and §2A.

---

## 3. Ownership lanes (so no one waits on anyone)

Five lanes. Several start **today, in parallel**.

| Lane | What it is | Path | Owner profile | Can start now? | Depends on | Primary docs |
|---|---|---|---|---|---|---|
| **D — Shared protocol/schemas** | `@arcane/shared`: zod **wire protocol** (ChangeEvent, ResultEvent) + domain (Finding, Metric, Score, RunReport, Config) | `packages/shared/` | any TS dev | ✅ **yes — do FIRST** | nothing | Technical-Spec §3A.2, §3B.2, §5–§6 |
| **A — CLI collector + TUI** | Thin Node client: watch → accurate change collector → stream over WSS → render results. **No analysis.** | `packages/cli/` | systems/TS dev | ✅ **yes** (needs D + a stub gateway) | Lane D; stub of Lane E | Build Guide §6A · Technical-Spec §3.1, §3A, §16 |
| **E — Cloud analysis engine** | Bun services: ingest gateway, shadow worktree, queue, analyzers, score, sandbox, fan-out | `services/cloud/` | backend/systems dev | ✅ **yes** (needs D) | Lane D; Supabase/Redis | Technical-Spec §3.2, §3B, §21, §21A, §22 |
| **C — Web dashboard** | Next.js app subscribing to Realtime: live Overview, Work-Tree, Findings, Insights, CI/CD, Team, Settings | `apps/dashboard/` | full-stack | 🟡 **frontend yes** (mock Realtime) / real data after E basic | Lane D types; Lane E stream | Requirements doc §3 · Technical-Spec §25 |
| **B — Landing site** | Marketing site (arcane.sh): hero, problem/solution, features, privacy modes, install, waitlist | `apps/landing/` | front-end / design | ✅ **yes** (fully independent) | nothing | Requirements doc §2 + §5 |

### Parallelization map (what to spin up immediately)
```
NOW, in parallel:
  ├─ Lane D  →  the wire protocol + domain schemas FIRST (ChangeEvent, ResultEvent, Finding, Score)   [tiny, unblocks A + E]
  ├─ Lane A  →  the change collector + WSS client + TUI (against a STUB gateway that echoes results)
  ├─ Lane E  →  the ingest gateway + shadow worktree + 3 analyzers + score + fan-out
  └─ Lane B  →  landing site (zero coupling; launch a waitlist before the engine is done)

AS SOON AS Lane E emits a result stream (even stubbed):
  └─ Lane C  →  dashboard subscribes to Realtime and renders the SAME live data as the terminal

The M1 goal is the ROUND-TRIP across D + A + E + C: edit a file → terminal AND web update live.
```

**Coordination contract:** the *only* shared surface between lanes is `@arcane/shared` — and the most important thing in it is the **wire protocol** (ChangeEvent up, ResultEvent down). Lock that schema early; A and E both build to it; C and the terminal both render ResultEvents. No lane imports another lane's internals. This is what lets your teammates work without you as a bottleneck.

---

## 4. Monorepo architecture

```
arcane/                          # pnpm/npm workspaces monorepo
├── package.json                 # workspaces: ["packages/*","services/*","apps/*"]
├── tsconfig.base.json
├── CLAUDE.md                    # root rules (seed in §9)
│
├── packages/
│   ├── shared/                  # LANE D — @arcane/shared
│   │   └── src/{protocol,domain}/   # ChangeEvent, ResultEvent · Finding, Metric, Score, Config
│   │
│   └── cli/                     # LANE A — @arcane/cli (Node, thin, published to npm)
│       └── src/
│           ├── cli.ts           # entrypoint → dist/cli.js (bin, shebang)
│           ├── collector/       # chokidar → ordered change events (op, path, hash, seq)
│           ├── snapshot/        # initial manifest + blob upload over TLS (§3A.6)
│           ├── transport/       # authenticated WSS client; reconnect + resync
│           ├── journal/         # offline buffer, replay unacked events safely
│           ├── git/             # read-only branch/commit/baseline (simple-git)
│           ├── auth/            # device-link; token file (~/.arcane)
│           ├── config/          # arcane.toml load + zod
│           └── tui/             # Ink views + pipeline states
│
├── services/
│   └── cloud/                   # LANE E — Arcane Cloud (Bun, deployed; NOT published)
│       └── src/{gateway,index,queue,analyzers,score,sandbox,instrument,runtime,ai,testgen,fixer,fanout,store,github}/
│
└── apps/
    ├── dashboard/               # LANE C — Next.js + Supabase Realtime
    └── landing/                 # LANE B — Next.js marketing site (independent)
```

CLI modules: Technical-Spec §3.1. Cloud modules: §3.2. Monorepo layout: §15.

---

## 5. Dependency install (per lane)

Run from the repo root unless noted. **Do not add packages outside these lists without asking (Rule 7).**

```bash
# ── Workspace bootstrap ──
npm init -y                       # then set "workspaces": ["packages/*","services/*","apps/*"]
npm i -D typescript tsup vitest @types/node

# ── Lane D: @arcane/shared ──  (only runtime dep is zod)
npm i -w packages/shared zod

# ── Lane A: @arcane/cli — Node thin client (Milestone 1 set) ──
#   ZERO native addons → painless `npm i -g`. NO better-sqlite3, NO tree-sitter, NO worker_threads.
npm i -w packages/cli ink react chokidar ws xxhash-wasm simple-git zod smol-toml chalk
npm i -D -w packages/cli @types/react @types/ws
#   tsconfig (cli): "jsx":"react-jsx", "module":"ESNext", "moduleResolution":"Bundler"

# ── Lane E: services/cloud — Bun engine ──  (run with Bun, not Node)
#   bun init in services/cloud; then:
bun add -d typescript                                  # in services/cloud
bun add zod bullmq ioredis @supabase/supabase-js
bun add web-tree-sitter @anthropic-ai/sdk             # AST + AI (AI wired at M4)
#   external analyzer CLIs (semgrep, gitleaks, knip, osv-scanner) are baked into the engine's
#   container image, NOT npm deps. Sandbox runtime (Firecracker/gVisor) is infra, added at M3.

# ── Lane B: landing ──
npx create-next-app@latest apps/landing --ts --tailwind --eslint --app

# ── Lane C: dashboard ──
npx create-next-app@latest apps/dashboard --ts --tailwind --eslint --app
npm i -w apps/dashboard @supabase/supabase-js
```

**Install-ergonomics note (important):** the CLI is **pure JS + WASM, no native addons** — `xxhash-wasm` is WASM, `simple-git` shells out to the user's `git`, everything else is pure JS. That's deliberate: it's what makes `npm i -g @arcane/cli` "just work" on any machine. All native/heavy tooling (tree-sitter, semgrep, the sandbox) lives in the Bun cloud engine, which you deploy — users never install it.

---

## 6. Build phases — in strict order

Each phase: **Goal · Lane · Prereqs · Build · Done when · Docs.** Don't start a phase until its prereqs' "Done when" gates pass. **∥ parallel-safe** phases can run at the same time in different lanes.

> **Milestone 1 is a cross-lane ROUND-TRIP**, not one lane's deliverable: **D0 + A1 + E1 + C1** together prove `edit file → cloud analysis → terminal AND web update live`. Build the shared protocol (D0) first, then a stubbed gateway so A1 and E1 can develop against the contract in parallel.

> **De-risk M1 — build it in four internal steps, not one pass** (M1 is a *platform* MVP; don't let one agent session attempt the whole thing):
> - **Session 0 (do this first):** scaffold the monorepo; create `@arcane/shared` with `ChangeEvent`/`ResultEvent`/`AckEvent`/`Finding`/`Score`; a Node CLI shell and a Bun gateway **stub**; prove the CLI can send **one fake `ChangeEvent`** and receive **one fake `ResultEvent`**. No watcher, no analyzers.
> - **M1A — Protocol + collector + stub gateway:** real change collector (watch → ordered events) streaming to a stub that just echoes `state` events; TUI renders pipeline state.
> - **M1B — Cloud ingestion:** real Bun gateway + auth stub + shadow worktree (apply changes, acks, resync); still no analyzers — return `state` events.
> - **M1C — First real analysis:** complexity + escape-hatch + secrets analyzers + score engine + Postgres persistence; terminal renders real scores/findings.
> - **M1D — Web mirror:** dashboard subscribes to the same `ResultEvent` stream and shows pipeline state + scores + findings, simultaneously with the terminal.
> Only `login`, `link`, `arcane`/`watch`, `init`, `status` (and optionally `score`) are implemented in M1; every other command is a stub that prints "not available in this milestone."

### Lane D — shared protocol + schemas (do this FIRST, it's small)
**D0 · Goal:** the typed contract every other lane builds against.
**Prereqs:** none. **∥ parallel-safe.**
**Build:** zod schemas + types for the **wire protocol** — `ChangeEvent` + `AckEvent` (eventId/seq/parentSnapshotId, §3A.2) and `ResultEvent` (state|score|finding|run, §3B.2) — and the **domain** — `Finding`, `Metric`, `Score`/`HealthScore`, `RunReport` (§19A.6), `ArcaneConfig`. Export from `@arcane/shared`.
**Done when:** `tsc --noEmit` passes; CLI and cloud both `import { ChangeEvent, ResultEvent } from "@arcane/shared"`.
**Docs:** Technical-Spec §3A.2, §3B.2, §5, §6, §19A.6.

### Lane A — CLI collector + TUI (thin client; never analyzes)
**A1 · M1 — Collector + stream + render.** **∥ parallel-safe** (against a stub gateway).
**Prereqs:** D0.
**Build:** cli package; `arcane login` (device-link; token → `~/.arcane`, chmod 600); `arcane link` (build manifest path→xxhash, **upload blobs over TLS**; the cloud stores them **encrypted at rest** per §3A.6 — no client-side encryption in M1); `arcane`/`watch` → **change collector** per §3A (chokidar → add/change/delete/rename, monotonic `seq`, content hash, atomic-write coalescing, deletes never dropped) → stream over authenticated **ws**; journal unacked events; resync on reconnect/seq-gap. Ink TUI: **pipeline states** (change detected → uploading → queued → analyzing → results), Health read-out + plain-English findings by default, per-dimension bars on `d`.
**Done when:** editing/renaming/deleting files produces correct ordered events the server can replay; killing+restarting the CLI resyncs with no drift; TUI renders streamed `ResultEvent`s; idle CPU ≈ 0.
**Docs:** Technical-Spec §3.1, §3A, §8, §16, §18 (M1 prompt). Config/commands: Requirements §4.

**A2 · M2 — Collector hardening + git context.** Robustness: large/binary caps, ignore rules, debounce-without-loss edge cases, reconnect/resync fuzz-tested; read git branch/commit/baseline and include it in the stream. **Done when:** a scripted burst of mixed edits/renames/deletes reconstructs byte-identical on the server. **Docs:** §3A, §13.

**A3 · M3 — Run consent + live run view.** CLI side of execution: the permission prompt (allow once/session/always/deny), `arcane run [workload] --compare`, and rendering the streamed live run graphs (latency/throughput/leak-curve). The *execution itself* is Lane E. **Docs:** §19, §19A, §21A.

**A4 · M6 — Apply fixes.** Receive verified fix diffs from the cloud (Lane E6) and apply them locally on user confirmation; atomic. **Docs:** §21.

**A5 · M7 — Gate + publish.** `arcane gate --baseline <ref>` (calls the cloud or a self-hosted engine; delta-first; exit 0/1/2; `--json`/`--sarif`/`--junit`) + publish `@arcane/cli` to npm (no native deps → painless install, §29). **Docs:** §28, §29.

### Lane E — cloud analysis engine (Bun; where all analysis lives) — NEW, biggest lane
**E1 · M1 — Ingest + worktree + 3 analyzers + score + fan-out.** **∥ parallel-safe** (against D0).
**Prereqs:** D0; a Supabase project + Redis.
**Build:** `Bun.serve` WS+REST **gateway** (auth, per-session channel, zod-validate, seq-check); **shadow worktree** (apply ChangeEvents, blast radius); **BullMQ** queue (debounce/coalesce per session); **3 analyzers** (complexity, escape-hatch, secrets); **score engine** (0–100/dim + delta + is_new) → persist to Postgres; **fan-out** the `ResultEvent` to the CLI socket **and** Supabase Realtime `project:{id}`.
**Done when:** a ChangeEvent in → a ResultEvent out to both surfaces in well under a second; bursts coalesce; seq-gap triggers a resync request.
**Docs:** Technical-Spec §3.2, §3B, §21, §21A, §22.

**E2 · M2 — More analyzers + delta-first + git.** semgrep, knip, gitleaks, osv-scanner, tree-sitter AST + import/dependency graph; baseline + delta suppression server-side; per-language support. **Docs:** §3B, §5.

**E3 · M3 — Cloud sandbox + Runtime Delta Engine.** *(highest-risk — slow down)* Per-run **microVM/container isolation** (no network, CPU/mem/time caps, no shared FS, secret stripping, outbound block/record, §21A) + in-sandbox instrumentation probe; the **Runtime Delta Engine (§19A)**: baseline/current worktrees on the same server class, alternating runs, median/p95/p99, warmup separation, representative inputs, hotness-weighted attribution, microbench buckets A/B/C, **confidence on every result**; stream the live run view to terminal + web. **Done when:** a deliberate N+1 in a fixture is detected and attributed; nothing executes without consent; isolation holds. **Docs:** §9, §19, **§19A**, §21A.

**E4 · M4 — AI layer.** `claude-opus-4-8` judge + `claude-haiku-4-5` triage, prompt caching, diff-hash cache, Batch in CI, daily budget cap, zod-validated verdicts. **Docs:** §10.

**E5 · M5 — Test generation.** Characterization + property-based **from the contract** (types/schemas/prompts), never from the implementation; run + mutation-test in the sandbox; labeled drafts streamed back. **Docs:** §19A overlap.

**E6 · M6 — Auto-fix.** Deterministic → codemods → verified LLM fixes in a cloud worktree (re-run analyzers+tests; only surface if it clears with no regressions); stream the diff back to the CLI (A4). **Docs:** §21.

**E7 · M7 — GitHub App + gate backend + self-host packaging.** GitHub App (Checks API, clone-baseline path), the gate's server side, and a container image for self-host (`[cloud] endpoint`). **Docs:** §13, §28, §29.

### Lane C — web dashboard (live from M1)
**C1 · M1 — Live mirror.** **Prereqs:** E1 emitting (or a stub). Subscribe to Supabase Realtime `project:{id}`; render the **same** scores/findings/pipeline-state as the terminal, updating simultaneously; hydrate history from Postgres for late joiners. **Done when:** an edit in the terminal updates the browser live, in lockstep. **Docs:** Technical-Spec §3B.2, §25; UI: Requirements §3.
**C2 · M8 — Full surface.** Overview, Work-Tree (DAG), Findings, Insights (incl. runtime-delta history + confidence) + account-aware terminal tabs. **Docs:** §25, §27.
**C3 · M9–M10 — Team + CI/CD.** ci_runs, gate history, GitHub App install, integrations, members/roles/invites, billing, Settings (source-access mode per project), self-host docs. **Docs:** §26, §28.

### Lane B — landing site (independent, start anytime) **∥ parallel-safe**
**B1 · Goal:** a live marketing site + waitlist before the engine ships.
**Build:** Next.js/Tailwind on Vercel. Sections per Requirements §2: hero + the vibe-coding wedge, "runs on any computer" + thin-client/cloud explainer, problem/solution, "how it works" (install → link → watch), **honest privacy block** (source uploaded over TLS, encrypted at rest, deletable; metadata-only + self-host **planned**), the honest runtime claim, install snippet (`npm i -g @arcane/cli`), pricing placeholder, waitlist. Copy: Requirements §5.
**Done when:** deploys on Vercel; waitlist persists; Lighthouse ≥ 90; mobile-clean.
**Docs:** Requirements §2 + §5.

---

## 7. Definition of Done & gates

**Per phase (all must pass before the next phase):**
- `npm run build` succeeds; `npx tsc --noEmit` clean (strict); `npx vitest run` green.
- New behavior has tests. Stubs are labeled `// STUB:` and tracked, never shipped as real.
- No new dependency outside the phase's list (or it was explicitly approved).
- The phase's "Done when" bullet is demonstrably met (show the output / a short clip / a passing fixture).

**From M7 on, the loop/CI stop condition is:** `npx vitest run && npx tsc --noEmit && arcane gate` — `arcane gate` is delta-first (fails only on **new** regressions vs baseline, never the legacy backlog). This is the same gate locally, in CI, and as an unattended-agent-loop exit condition.

---

## 8. Invariants (true in every phase — breaking one = wrong approach)

1. **The CLI is a thin client** — it only watches, collects changes, streams, authenticates, renders. It never analyzes, never produces findings, never executes user code, needs no database.
2. **Change collection is accurate, ordered, recoverable** — every add/change/delete/rename is seq-numbered + hashed; the server can rebuild the tree; gaps/reconnects resync, never silent drift (§3A).
3. **All analysis runs in Arcane Cloud (Bun)** — against a shadow worktree built from streamed changes.
4. **Results fan out to terminal AND web simultaneously** — one ResultEvent → CLI socket + Realtime (§3B.2).
5. **Incremental on the server** — content-hash skip + blast-radius + burst-coalesce; never re-analyze the world.
6. **Source upload is explicit, encrypted, deletable** — consent at link; **TLS in transit + encrypted at rest (Arcane-managed keys, §3A.6)**; deletable. **Metadata-only + self-host are planned** modes (§24).
7. **Cloud execution is sandboxed, isolated per tenant** — microVM/container, no network, caps; opt-in + user-declared workloads only (§21A).
8. **Delta-first** — surface what a change *introduced*, not the whole backlog.
9. **Analyzers are plugins** behind the `Analyzer` interface (server-side) — never edit core to add one.
10. **Event-driven UI** — render on streamed events; show pipeline state so a round-trip never reads as a hang.
11. **Fixes are verified, scoped, reversible** — verified in a cloud worktree; streamed back as a diff; atomic.
12. **Approachable by default, deep on toggle** — one Health Score + plain-English findings up front; no "simple mode."
13. **The TUI/UI is a real product surface** — intentional states, not a debug dump.
14. **Runtime is measured, never simulated** — baseline-vs-current in Arcane's isolated cloud env, confidence-scored; static layer says "risk increased," not "runtime slower" (§19A).
15. **The CLI install stays painless** — zero native addons; pure JS + WASM.

Source of truth: Technical-Spec §16 + §21A + §19A.

---

## 9. CLAUDE.md seed (drop at repo root; trim per package)

```md
# CLAUDE.md — Arcane

Arcane = a THIN Node CLI (collects repo changes) + a HOSTED Bun cloud engine (does ALL analysis),
streaming results to the terminal AND a web dashboard simultaneously. Runs on any computer.
Read `Arcane-Build-Guide.md` before coding. Open `Arcane-Technical-Spec.md` ONLY at the section
your current phase cites. UI/config/marketing live in `Arcane-Product-Requirements.md`.

AUTHORITATIVE DOCS: only the four docs in `/docs/current/` are authoritative. Any older docs in
`/docs/archive/` describe a SUPERSEDED local-first design — IGNORE them unless explicitly asked.
If a file says "the CLI runs analyzers locally," "code never leaves the machine," or "works fully
offline," it is the OLD design; the current design is thin-client + cloud. When in doubt, ask.
Single sources of truth: `arcane.toml` + command reference → Product-Requirements §4; milestones →
Technical-Spec §17; the wire protocol → @arcane/shared (Technical-Spec §3A.2 / §3B.2).

RULES (hard):
1. Never invent APIs, flags, schema fields, config keys, or paths. Not in the docs = doesn't exist.
2. Missing a detail? STOP and ASK. Do not guess.
3. Build phase-by-phase (Build Guide §6). Never jump ahead. Meet each "Done when" gate first.
4. Stay in your lane (D shared / A cli / E cloud / C dashboard / B landing). Cross-lane = via
   @arcane/shared only — and the wire protocol (ChangeEvent, ResultEvent) is the key contract.
5. Respect the invariants (Build Guide §8). If a task seems to break one, you misread it — ask.
   Most important: the CLI NEVER analyzes or runs user code; all analysis is server-side.
6. Before "done": build + `vitest run` + `tsc --noEmit` in the package you touched (+ `arcane gate`
   from M7). Paste the output. "Should work" ≠ done.
7. No dependency outside the current phase's list without asking. The CLI must stay native-dep-free.
8. Never present mock data as real. Label stubs `// STUB:`.
9. Cite the doc section for non-obvious decisions (e.g. // per Technical-Spec §3A).
10. One concern per commit/PR. Small, atomic, reversible. Don't refactor unrelated code.

STACK (two runtimes — don't mix):
- CLI (packages/cli): Node ≥20, TS strict, ESM. ink+react (jsx: react-jsx), chokidar, ws,
  xxhash-wasm, simple-git, smol-toml, zod, chalk. NO native addons.
- Cloud (services/cloud): Bun + TS. Bun.serve (WS/REST), BullMQ, Postgres+storage (Supabase),
  tree-sitter, semgrep/gitleaks/knip/osv, microVM/container sandbox (M3), @anthropic-ai/sdk.
- Shared (packages/shared): zod protocol + domain schemas.

CURRENT PHASE: <set this — e.g. "Lane E / M1 — ingest + 3 analyzers + fan-out">. Do only this phase.
```

> Keep a per-package `CLAUDE.md` that sets `CURRENT PHASE` + the lane (and which runtime — Node vs Bun) so each agent session stays narrow.
