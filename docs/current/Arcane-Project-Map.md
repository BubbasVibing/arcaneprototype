# Arcane — Project Map & Build Plan

> Arcane runs next to whatever AI is writing your code and tells you, in real time and in plain language, whether that code is actually good — fast, secure, clean, and ready to scale — then offers to fix what isn't. Easy to use by default; every advanced detail is one toggle away.

---

## 1. What Arcane is (in plain language)

**AI coding tools write code fast — but they write it to *work right now*, not to be fast, secure, or ready for real users. Arcane is the safety net that fixes that.** It sits quietly next to whatever AI is building your app (Claude Code, Cursor, Lovable, Bolt, v0…) and, as the code is written, tells you whether it's actually good — and offers to fix what isn't.

**You don't need to be an engineer to use it.** By default it shows a simple health read-out and plain-English warnings ("this part is getting slow and won't handle many users"). Every advanced detail — the granular metrics, thresholds, deep scans — is one toggle away when you want it. The tool is easy on the surface and deep underneath; there's no separate "beginner mode," just sensible defaults with power on tap.

**Why it's needed:** millions of people now "vibe-code" whole apps by prompting. The code usually *looks* finished and works in the demo — then falls over the moment real users arrive: slow pages, runaway database queries, security holes, and a tangled codebase nobody can maintain. Nothing watches for this while the AI churns out code. Arcane is that missing check.

---

## 2. The problem it solves

When you run constant prompts at a coding agent:

- The agent makes large, fast, sweeping changes across many files.
- You can't realistically read every diff, so quality, security, and performance **drift silently**.
- Dead code, duplicated logic, and leak-prone patterns accumulate.
- By the time it's committed and pushed, the repo has problems you never saw being introduced.

Arcane closes that gap: every burst of edits gets scored, and you see the *effect* of those edits in real time, before they reach the repo.

**Key design principle:** Arcane is **agent-agnostic**. It does not hook into Claude Code's internals. It watches the **filesystem + git**, which means it works with *any* agent (or you typing by hand). That's a feature, not a limitation.

**How it runs (architecture in one breath):** Arcane is a **thin local CLI + a hosted cloud engine** — the Claude Code model. The CLI's only job is to watch your repo and stream **every change** (inserts, edits, deletions, renames — accurately, in realtime) to **Arcane Cloud**, which runs all the analysis, security, AI, and sandboxed runtime work and streams results back **to your terminal and the web app at the same time**. Nothing heavy runs locally, so **Arcane runs on any computer.** Your source is streamed over TLS and stored encrypted, and is deletable; metadata-only and self-host modes are **planned** for teams that can't upload code (details in §13 and §23).

---

## 3. How a change gets evaluated (the heartbeat)

```
file saved
  ─▶ CLI collector normalizes it to an ordered change event (op, path, hash, seq)
  ─▶ streams it over WSS to Arcane Cloud (or journals it if offline)
  ─▶ cloud applies the patch to the project's shadow worktree
  ─▶ cloud runs incremental analyzers on changed files (+ dependents)
  ─▶ score engine recomputes per-dimension scores + deltas vs the last snapshot
  ─▶ a ResultEvent fans out to the terminal AND the web app at the same time
  ─▶ both surfaces update eval bars + append the change to the timeline
```

Nothing is analyzed or stored on your machine — the CLI collects and renders; the cloud does the work. A "change event" reads like:
`payments.ts  ▸  complexity +6 (warn) · removed 2 dead exports · 1 NEW high-severity semgrep finding · bundle +1.2kb`

---

## 4. Feature map (with an honest feasibility rating)

The dimensions you listed split cleanly into **what's continuously doable today** vs. **what's genuinely hard** and should be scoped as on-demand or later.

| Dimension | Feasibility | How |
|---|---|---|
| Code simplicity / complexity | 🟢 Continuous | Cyclomatic + cognitive complexity per function |
| Redundant / dead code | 🟢 Continuous | Unused exports, unreachable code, duplication |
| Lint / correctness | 🟢 Continuous | Wrap ESLint / Ruff / etc. |
| Security vulnerabilities | 🟢 Continuous | Semgrep rules, language linters |
| Leaked secrets | 🟢 Continuous | gitleaks on the diff |
| Dependency vulnerabilities | 🟢 Continuous | `npm audit` / `pip-audit` / `osv-scanner` |
| Git working-tree / branch diagram | 🟢 Continuous | Read git, render a live tree |
| Change churn / diff size | 🟢 Continuous | Lines added/removed/touched per burst |
| Memory **leak patterns** | 🟡 On-demand | Catch *known* leak-prone patterns (missing cleanup, unclosed handles, listeners not removed). True leak detection needs runtime profiling. |
| Runtime performance | 🟡 On-demand | Run the project's existing test/bench suite, track timing deltas. Not "magically benchmark everything." |
| Threading / concurrency | 🟡 On-demand | Use language-native race detectors during a deep-scan pass. |
| Continuous live profiling of memory/CPU | 🔴 Hard / later | Requires instrumentation + representative inputs. Treat as later-milestone research (M3+). |

**The honest takeaway:** the static + git layer (all the 🟢 rows) is a *strong, shippable, genuinely useful product on its own* — and all of it runs **in Arcane Cloud** (the CLI just streams the changes that trigger it). The dynamic layer (🟡/🔴) is where most tools overpromise. Build the green core first; make the yellow stuff an explicit on-demand run (cloud sandbox) rather than a fake live bar.

---

## 5. Architecture

```
  LOCAL · any computer                              ARCANE CLOUD · Bun
  ┌────────────────────────────┐                    ┌──────────────────────────────────────┐
  │        Arcane TUI          │ ◀──result events── │  Ingest gateway (auth, WS/REST)        │
  │ eval bars · timeline ·     │                    │  Shadow worktree (apply change events) │
  │ findings · pipeline state  │                    │  Orchestrator: queue · blast radius    │
  └──────────────▲─────────────┘                    │  Analyzer plugins (semgrep, knip, …)   │
                 │                                   │  Score engine → bars + deltas          │
  ┌──────────────┴─────────────┐ ──change events──▶ │  Sandbox runner (isolated, M3)         │
  │   Change collector         │   (WSS / TLS)      │  Durable store: Postgres + object stg  │
  │ chokidar · op/seq/hash ·   │                    │  Fan-out ─┬─▶ CLI socket (terminal)    │
  │ journal (offline buffer)   │                    │           └─▶ Realtime ─▶ web dashboard│
  │   git read (context only)  │                    └──────────────────────────────────────┘
  └────────────────────────────┘
```

**Components**

*Local (CLI — thin):*
1. **Change collector** — chokidar detects add/change/delete/rename, normalizes to ordered events (seq + content hash), ignores `node_modules`/build dirs.
2. **Transport + journal** — streams events over an authenticated WebSocket; buffers in an append-only journal when offline.
3. **Git read** — reads branch/commit/baseline for context only (no analysis).
4. **TUI** — renders streamed results next to your agent; shows pipeline state (uploading → queued → analyzing → results).

*Cloud (Bun — the engine):*
5. **Gateway + shadow worktree** — authenticates, validates, and applies change events to a server-side mirror of the repo.
6. **Orchestrator** — decides what to re-run (changed files + dependents), queues, prevents pile-ups during rapid agent edits.
7. **Analyzers** — a plugin interface; each wraps a battle-tested tool and normalizes output to a common schema.
8. **Score engine** — findings → 0–100 per-dimension scores + deltas.
9. **Durable store** — Postgres (projects, runs, findings, scores) + object storage (encrypted snapshots). The CLI keeps no database — only its journal.
10. **Fan-out** — publishes each result to the CLI socket and the web Realtime channel simultaneously.

---

## 6. Tech stack (decided)

**Two pieces, two runtimes. The CLI is a Node + TypeScript package on npm; the engine is a Bun + TypeScript cloud service.** A user installs only the CLI (`npm install -g @arcane/cli`) and runs `arcane` — nothing else to install, no local toolchain, no horsepower needed, because the analysis runs in Arcane Cloud.

- **CLI (local, thin):** Node.js (LTS ≥ 20), TypeScript strict, ESM. **Zero native addons** so the npm install just works anywhere. Ink (TUI) · chokidar (watch) · ws (stream) · xxhash-wasm (hash) · simple-git (read-only context). It collects changes and renders results — nothing more.
- **Cloud (the engine):** Bun + TypeScript for throughput. Hosts the shadow worktree, the queue, every analyzer (semgrep, gitleaks, knip, osv, tree-sitter…), the isolated sandbox, the AI layer, and the realtime fan-out.
- **Why this split:** users get a trivially-installable tool that runs on any machine (the Claude Code model); we control the analysis environment centrally (consistent versions, instant updates, server-class runtime measurement), and the web app can mirror everything live.

The heavy analysis is still **wrapped existing tools** — Arcane is an orchestrator + scorer + great UI (now cloud-hosted), *not* a from-scratch static analyzer.

---

## 7. Analyzer toolbox (what to wrap)

| Dimension | JS/TS | Python | Multi-language |
|---|---|---|---|
| Lint | ESLint | Ruff | — |
| Complexity | eslint complexity rules / `ts-complexity` | radon | `lizard` (many langs) |
| Dead/unused code | `knip`, `ts-prune` | `vulture` | — |
| Duplication | `jscpd` | `jscpd` | `jscpd` |
| Security SAST | semgrep | bandit / semgrep | **semgrep** (great default) |
| Secrets | gitleaks | gitleaks | **gitleaks** |
| Dep vulns | `npm audit` | `pip-audit` | **osv-scanner** |
| Race/concurrency | — | — | language-native race detectors |
| Git | libgit2 binding or shell out to `git` | same | same |

**Strategy:** ship a sensible default set, auto-detect the project's language(s), and let users enable/disable analyzers in config.

---

## 8. MVP definition (build this first)

A tight, demoable slice — the **round-trip**. Resist scope creep:

1. **`arcane login` + `arcane link`** — pair the machine, upload the initial encrypted snapshot, server builds the project index.
2. **`arcane`** launches the TUI and the **change collector**: watch the repo and stream every insert/edit/delete/rename to Arcane Cloud, accurately and in order.
3. **Cloud engine** applies the changes to a shadow worktree and runs **3 analyzers** (complexity, escape-hatch, secrets) → score + delta.
4. **Realtime fan-out**: results stream back to the terminal **and** a minimal web view **at the same time** — pipeline states (uploading → queued → analyzing → results) + eval bars + findings.
5. **Eval bars** (0–100, color-coded) + a **change timeline** with score deltas, updating live as you edit.

The win to demo: edit a file locally → the terminal and the browser both light up with new scores/findings within a second.

Explicitly **out of MVP**: the cloud sandbox + runtime profiling, memory-leak detection, AI review, test-gen, auto-fix, teams/billing. Those are later milestones — prove the round-trip first.

---

## 9. Roadmap

This mirrors the milestone plan in **Technical-Spec §17** (the spec is authoritative; this is the narrative view). Each milestone is one focused build.

**M1 — The round-trip (MVP above).** Thin CLI (login, link, watch/collect, render) + cloud (ingest, shadow worktree, queue, 3 analyzers, score, fan-out) + minimal live web mirror. Prove: edit → cloud analysis → terminal + web update together.

**M2 — Collector hardening + git + more analyzers.** Robust rename/delete/atomic-write/resync; git branch/commit/baseline context; delta-first; semgrep, knip, gitleaks, osv, tree-sitter AST.

**M3 — Cloud sandbox + Runtime Delta Engine.** Isolated microVM/container runs; consent + declared workloads; baseline-vs-current runtime deltas with confidence; live run graphs.

**M4 — AI layer (cloud).** Opus judge + Haiku triage, caching, Batch, budget cap.

**M5 — Test generation (cloud).** Characterization + property-based from the contract.

**M6 — Auto-fix.** Verified in a cloud worktree; streamed back as diffs the user applies.

**M7 — GitHub App + CI/CD gate + npm publish + self-host packaging.**

**M8 — Web app full surface + account-aware terminal tabs.**

**M9–M10 — Teams/roles/billing/integrations; then enterprise (self-host, metadata-only, hardened isolation).**

---

## 10. Distribution

**Primary (and all the *user* needs): npm.** The CLI is a standard Node CLI.
1. Compile TS → JS (`tsc` or `tsup`) into `dist/`.
2. `package.json` declares `"bin": { "arcane": "dist/cli.js" }` (with a `#!/usr/bin/env node` shebang) and `"engines": { "node": ">=20" }`.
3. `npm publish`.
4. Users run `npm install -g @arcane/cli`, `npx @arcane/cli`, or add it as a project dev-dependency. **No native deps → it just installs.**

**The cloud engine is deployed, not published.** The Bun engine (`services/cloud`) ships as a container image to our infra (alongside Supabase + Redis); for **self-host** customers, the same image runs in their network and the CLI points at it via `[cloud] endpoint`.

**Optional extras (later):**
- **Homebrew** — a formula that depends on `node` and installs the npm package, for `brew install` fans. Not required; npm covers everyone.
- **curl installer** — `curl -fsSL https://arcane.sh/install | sh` wrapping the npm install.

Full packaging detail (bin shim, files, ESM, native-dep notes): **Technical-Spec §29**.

### ⚠️ Naming note
`arcane` is a common word and almost certainly **taken on npm** — publish under a scope you own (e.g. `@arcane/cli` or `@<you>/arcane`) with `"publishConfig": { "access": "public" }`. Check with `npm view arcane` (a 404 means it's free). The command stays `arcane` regardless of the package name.

---

## 11. Suggested repo structure

```
arcane/                          # monorepo (npm/pnpm workspaces)
├── packages/
│   ├── shared/                  # @arcane/shared — wire protocol + domain schemas (zod)
│   └── cli/                     # @arcane/cli — Node THIN client (published to npm)
│       └── src/{cli,collector,snapshot,transport,journal,git,auth,config,tui}/
│                                #  watch · collect changes · stream · render — NO analysis
├── services/
│   └── cloud/                   # Arcane Cloud — Bun engine (deployed, not published)
│       └── src/{gateway,index,queue,analyzers,score,sandbox,runtime,ai,testgen,fixer,fanout,store,github}/
└── apps/
    ├── dashboard/               # Next.js web app (Supabase Realtime)
    └── landing/                 # marketing site
```
> The CLI is **Node** (painless `npm i -g`, zero native deps); the engine is **Bun** (max throughput). All analyzers, the score engine, the sandbox, and the durable store live in the cloud — the CLI only collects and renders. Full layout: Technical-Spec §15.
(Full module list: Technical-Spec §3 and §15.)

---

## 12. Open decisions (answer these to start)

1. **Stack:** ✅ decided — **CLI: Node.js + TypeScript on npm; Cloud engine: Bun + TypeScript** (hosted). Shared `@arcane/shared` protocol/schemas.
2. **Architecture:** ✅ decided — **thin local collector + hosted cloud analysis engine**, results fanned out to terminal + web simultaneously.
3. **Source-access default + modes:** **Cloud mode (encrypted, deletable) is the M1 default and the only mode shipping in M1.** Metadata-only and Self-host are **planned** (self-host packaged at M7). Confirm the Cloud-mode retention policy (persist vs ephemeral) and quotas.
4. **Languages to support first:** JS/TS only, or JS/TS + Python? (Start JS/TS.)
5. **Name:** keep `arcane` (check availability) or pick a collision-free alias?
6. **CI gate:** is `arcane gate` a v1 must-have or a later nice-to-have?

---

## 13. The GitHub connector & the two-plane model

I covered *local* git earlier but not the **GitHub connector** — they're different jobs. The clean mental model: Arcane gets your code into the cloud engine on **two planes**, and only one needs GitHub.

**Collector plane (the default — realtime).** The CLI watches your local `.git` + filesystem and streams every change to Arcane Cloud (encrypted), which analyzes against a server-side shadow copy of your repo and streams results back to the terminal and web app live. This is the MVP path. (It reads local git for branch/commit context; the *analysis* is all cloud, so it needs a connection — see §21 for offline behaviour and the privacy modes.)

**Remote / CI plane (needs the GitHub connector).** This is what your sketch's "CI/CD pipeline" box really is, and it's an alternative way for the cloud to get the baseline (clone via the GitHub App instead of an uploaded snapshot — good for teams and metadata-only setups). You need a GitHub connector to:
- read remote branches & open PRs (and the team's working trees — your Jussama / Yassine / Durramin branches),
- post Arcane's scores as a **commit status / Check** on PRs ("Arcane: complexity +12, 1 new high-severity finding"),
- drop **line-level annotations** on the PR diff,
- **gate merges** (block when a threshold regresses),
- correlate with Actions/CI status.

**Hosted infrastructure is required from M1 — because Arcane Cloud *is* the analysis engine.** Unlike the old local-first idea, the MVP itself needs the gateway, shadow worktree, queue, analyzers, score engine, fan-out, and Postgres/object storage running as a service. The GitHub **Action** is added later (M7) for CI/gate flows — it runs `arcane gate` in the user's pipeline and posts a Check via the auto-provided `GITHUB_TOKEN` — but it's a *complement* to the hosted engine, not a way to avoid running one. (The GitHub **App** is also the alternative way for the cloud to fetch a repo baseline — clone instead of snapshot-upload — for teams and metadata-only setups.)

| Tier | Auth mechanism | Why |
|---|---|---|
| Any user, default (cloud) | **`arcane login` + `arcane link`** (device flow) | analysis runs in Arcane Cloud, so auth + project link are required from the start |
| Reading your own local git | none | branch/commit/working-tree context is read locally without a token |
| Team / PR checks | **GitHub App** (fine-grained, least-privilege) | post checks/annotations org-wide; optional clone-baseline path |
| CI gating | **GitHub Action** + `GITHUB_TOKEN` | runs `arcane gate` in their pipeline, no extra auth |

---

## 14. Granular testing strategies by surface — leave no stone unturned

Unifying idea: **snapshot every measurable property, then show the delta each agent burst caused.** "The diff of everything" is the product. Per-surface playbook:

### APIs (REST / GraphQL / gRPC)
- **Spec ↔ code drift**: parse OpenAPI / GraphQL schema, diff against actual route handlers. Agent adds a route but not the spec → flag.
- **Breaking-change detection**: diff specs across commits (`oasdiff` for OpenAPI, `graphql-inspector` for GraphQL) — removed endpoints, narrowed types, newly-required params.
- **Schema-driven fuzzing**: feed the OpenAPI spec to **schemathesis** → thousands of property-based edge-case requests that surface 500s & schema violations for free.
- **Response-shape regression**: snapshot real response shapes, replay after changes, diff (record/replay golden master).
- **Auth-boundary tests**: enumerate protected routes, assert they reject unauthenticated calls — catches "agent dropped the auth middleware."

### Databases
- **Migration safety linter**: flag destructive ops (DROP/RENAME COLUMN, NOT NULL w/o default on populated tables, table-locking index builds) *before* prod.
- **Shadow-DB migration test**: apply the migration to an ephemeral copy of the dev DB; verify it applies *and reverses* cleanly.
- **Schema drift**: diff ORM models ↔ migration history ↔ live dev schema. Model changed, no migration generated → flag.
- **Query-plan analysis**: `EXPLAIN ANALYZE` extracted/logged queries against a shadow DB → catch full table scans & missing indexes.
- **N+1 detection**: instrument the ORM in dev, count queries per logical op, flag explosions (the #1 perf bug agents introduce).

### JSON Schemas / data contracts
- **Cross-boundary validation**: validate fixtures, payloads, queue events, config files against their JSON Schemas.
- **Schema compatibility**: diff schemas across commits (added-required breaks producers; removed-field breaks consumers) — Kafka/Avro discipline applied everywhere.
- **Type ↔ schema sync**: generate types from schema (or vice versa) and diff — catch the agent updating a Zod/Pydantic validator but not the TS type.
- **Config schema checks**: validate `.env`, `tsconfig.json`, `package.json`, framework configs.

### Types & type safety
- **Type-coverage trend** (type-coverage / mypy strict). Flag drops.
- **Escape-hatch creep**: count/trend `any`, `as`, `!`, `# type: ignore`, `@ts-ignore` — agents spam these to silence errors.

### Tests (testing the tests)
- **Coverage delta per change**: new code without tests → flag.
- **Mutation testing** (Stryker / mutmut): mutate code, see if tests catch it — exposes assertion-free "fake" tests.
- **Assertion-free / always-true test detection** (static).
- **Flake detection**: run hot tests N times / shuffle order.

### Dependencies & supply chain
- **New-dep scrutiny** on every add: typosquat check, maintenance/popularity, license, known CVEs, install-script presence (malware vector), bundle-size impact.
- **License compliance**: GPL/AGPL creeping into proprietary code → flag.
- **Lockfile integrity**: manifest ↔ lockfile match; no floating versions.

### Concurrency & async
- **Floating/unawaited promises** (agents constantly forget `await`).
- **Native race detection** where available (language-native race detectors).
- **Lock-ordering / deadlock heuristics.**

### Performance (granular)
- **Differential micro-benchmarks**: bench touched hot functions before/after; flag regressions past a threshold.
- **Bundle-size & chunk budgets** (web).
- **Import-time / cold-start tracking**: agents add heavy imports that balloon startup.
- **Algorithmic-complexity heuristics**: nested loops over the same large collection → accidental O(n²); repeated work that should be memoized.

### Security (beyond basic SAST)
- **Taint / dataflow**: untrusted input → dangerous sink (SQL, shell, eval, path, SSRF). Semgrep for fast rules, **CodeQL** for deep dataflow.
- **Injection & XSS patterns**, **missing-authz-check** on mutations.
- **IaC scanning** (trivy / checkov) for Dockerfiles/Terraform: root user, exposed ports, secrets in layers.

### Cross-cutting power moves (the real differentiators)
1. **Diff-of-everything** — snapshot types, API surface, schemas, query plans, bundle size, coverage, complexity; show what each burst changed. This *is* Arcane.
2. **Ephemeral shadow environment** — throwaway container + snapshotted dev DB where all unsafe dynamic checks run; never touches live.
3. **Record/replay golden master** — capture real behavior, replay after changes, diff outputs; regression detection with zero authored assertions.
4. **Schema-driven fuzzing** — weaponize the schemas/types the agent already wrote (schemathesis, fast-check, Hypothesis).
5. **AST semantic diffing + blast radius** — diff ASTs (not text) to know *what kind* of change happened; dependency graph re-tests exactly the affected blast radius. Granular *and* fast.
6. **Runtime instrumentation in dev** — lightweight preload (`node --require`, Python `sitecustomize`, OpenTelemetry) records queries, timings, allocations, unhandled rejections during ordinary runs; normal usage becomes Arcane's data feed.
7. **LLM-as-judge (bounded)** — for what static tools can't see (does the code do what the prompt asked? is the business-logic authz right?), run a model over the diff with a strict rubric, cite line numbers, cache by diff hash, opt-in & budget-capped.
8. **Differential testing vs. last-known-good** — run old and new builds on identical inputs, diff outputs; automatic regression catching.

---

## 15. The hardest parts — and clever fixes

The questions that actually decide whether Arcane works, each with the cleverest fix I know:

**1. Analysis can't keep up with a fast agent.** A burst touches 30 files; running everything on every save lags hopelessly.
→ *Tiered + incremental.* Instant cheap checks on save; expensive checks debounced & coalesced; deep checks on commit / `--deep` only. **Blast-radius re-runs** via the dependency graph (test only what's affected — all of it). **Warm daemons** (keep tsserver/semgrep resident). **Content-hash caching** (never re-analyze an unchanged AST). Heavy work runs in a background pool and **streams in** — eventual, never blocking the UI.

**2. The dynamic checks are unsafe / environment-dependent.** Running code, migrations, benchmarks can hit real DBs and have side effects.
→ *Never run in the real environment.* **Ephemeral sandbox** (container) + **snapshotted copy** of the dev DB; all runtime checks live there. Use the project's **existing test harness** as the safe execution surface instead of inventing how to boot the app.

**3. Signal-to-noise — the linter that cried wolf.** Wrap 15 tools, get 4,000 findings, users mute it forever. This is what kills tools like this.
→ *Delta-first, always.* Show only findings **this change introduced** — baseline the legacy backlog and hide it. Severity-weight the score, dedupe/group, and **blame the burst** that caused each finding. One regression that matters beats 200 legacy nits.

**4. Attribution — "which prompt made it worse?"** You see file bursts, not prompts.
→ *Burst attribution is achievable; prompt attribution is a bonus.* Debounce edits into timestamped change-sets, correlate with git. If the agent writes a session log to disk, read it to **label the burst with the prompt**; otherwise the change-set timeline is already 90% of the value.

**5. You don't know how to boot or test the user's app.**
→ *Detect, then remember.* Read `package.json` scripts / Makefile / `pyproject` for dev/test/build commands; ask once, cache in `arcane.toml`. Default to the **test runner** as the entrypoint — already configured and safe.

**6. Multi-language / framework sprawl.** A tool needing heavy per-project config dies.
→ *Zero-config detection + progressive depth.* Auto-detect stack from manifests (package.json, prisma schema, openapi.yaml, Dockerfile). Opinionated defaults out of the box; deepen only if the user adds config. A **plugin registry** fills the long tail.

**7. The perf tool must not be a perf problem.** A heavy process fighting Claude Code for CPU is self-defeating.
→ *Lean by construction.* a single lightweight Node process, capped parallelism, nice-priority workers, and **reuse the project's language server** for ASTs/typechecks instead of duplicating work.

**8. Score jitter destroys trust.** Flaky tests / nondeterministic benchmarks make bars bounce.
→ *Split deterministic from noisy.* Static scores are deterministic and always shown; dynamic scores are **averaged over runs with a confidence band**, never blocking on one noisy run. Pin tool versions.

**9. GitHub connector security.** Tokens, least privilege, posting to PRs safely.
→ *Push the trust boundary to GitHub.* Do remote/CI work inside a **GitHub Action** with the scoped `GITHUB_TOKEN` (no token touches your machine or a server). Local remote-reads use **OAuth device flow**; the CLI token lives in a `~/.arcane` file (chmod 600), no native keychain dep. A **GitHub App** with fine-grained perms only at the team tier.

---

## 16. How the CLI operates & the command set

**Operating model — two modes:**
1. **Interactive daemon (the 90% case):** `arcane` launches the live TUI you keep open in a split pane next to Claude Code. Watcher + analyzers + eval bars + change timeline + git tree, all live.
2. **One-shot / headless:** every capability is also a scriptable command that prints a report (human or `--json`) and exits — for CI, hooks, and quick checks.

### Command set (★ = most useful day to day)

**Daily / interactive**
| Command | What it does |
|---|---|
| ★ `arcane` (alias `arcane watch`) | Launch the live dashboard. The daily driver. |
| ★ `arcane review [--range a..b] [--staged]` | **Opus 4.8** semantic pass over the current diff — intent match, business-logic authz, subtle bugs static tools miss. *(uses tokens)* |
| ★ `arcane diff [<ref>]` | The "what did that prompt actually change" command — every dimension's delta since a ref/snapshot. |
| `arcane explain <finding-id>` | Deep-dive one finding with a plain-English cause + suggested fix. *(uses tokens)* |

**Health / reporting**
| Command | What it does |
|---|---|
| `arcane scan [--deep]` | One-shot full analysis report. `--deep` runs the dynamic checks in the sandbox. |
| `arcane score [--json]` | Current eval bars as text — quick health check, composable. |
| `arcane history` | Score timeline over commits/time. |
| `arcane tree` | Render the git working-tree / branch node-graph (your sketch). |

**CI / gating**
| Command | What it does |
|---|---|
| ★ `arcane gate [--baseline <ref>]` | Pass/fail for CI. Non-zero exit on a threshold regression. What the GitHub Action calls. |
| ★ `arcane baseline set` | Snapshot current state as the suppression baseline — the delta-first switch that hides the legacy backlog. |

**Setup / ops**
| Command | What it does |
|---|---|
| `arcane init` | First-run wizard: detect stack, write `arcane.toml`, pick default analyzers. |
| `arcane login` / `arcane connect github` | OAuth device-flow auth for the remote plane. |
| `arcane doctor` | Env check — which analyzers are installed, is the API key set, is the sandbox ready. |
| `arcane sandbox [up\|down\|status]` | Manage the ephemeral env for dynamic checks. |
| `arcane budget` | Show / cap AI token spend (see §17). |
| `arcane config` · `arcane plugins` | Manage config & analyzers. |

### TUI keybindings
`j/k` navigate findings · `enter` expand · `e` explain with AI · `f` apply safe autofix · `d` deep-scan · `g` toggle git tree · `b` set baseline · `r` re-run · `/` filter · `$` spend meter · `?` help · `q` quit.

### Conventions
- `--json` on every command for tooling/composition.
- Exit codes: `0` pass · `1` gate failure · `2` tool error. (Makes `arcane gate` drop straight into CI.)
- `--no-ai` disables all token usage (sensitive repos / cost control).
- Global flags: `--cwd`, `--config`, `--profile <name>`, `--quiet`/`--verbose`, `--no-color`.

---

## 17. The AI layer — powered by Claude Opus 4.8

**Model:** `claude-opus-4-8` via the Anthropic API. 1M-token context at standard pricing. This is the semantic-judge layer from §14 — the part that catches what static tools structurally cannot.

**What Opus 4.8 is used for (and only this):**
- Does the code actually do what the prompt asked? (intent ↔ implementation)
- Business-logic security: missing authorization on a mutation, an IDOR, a broken invariant — things SAST can't reason about.
- Architectural sanity: is this abstraction reasonable, or did the agent paint you into a corner?
- Plain-English explanations + concrete fixes for findings (`arcane explain`).

It is **not** used for anything a deterministic tool already does well. Static tools are free and fast; tokens are spent only on judgment.

### Cost reality (this drives the design)
- Standard rate: **$5 / MTok input, $25 / MTok output**. Output is the expensive half (5×), so the judge must emit **terse structured JSON**, not prose.
- **A Claude Max subscription does NOT cover API usage.** Arcane's calls bill per-token, separately. Budget for it explicitly.

### Cost-control architecture (non-negotiable for a tool that runs continuously)
1. **Static-first gate — earn the token.** Never call Opus on formatting/trivial diffs. Use the AST semantic diff to decide if a change is *logic-significant* before spending anything.
2. **Triage routing.** A cheap model (Haiku `claude-haiku-4-5` / Sonnet `claude-sonnet-4-6`) pre-filters "is this diff worth Opus's attention?"; Opus 4.8 only runs the deep judgment. Biggest saver after caching.
3. **Prompt caching.** Cache the stable prefix — system prompt, review rubric, repo conventions, relevant type/schema context — so repeated reviews hit cache at **~$0.50/MTok (≈90% off)**. Send only the small fresh diff each call. Arcane reviews many diffs against the same repo, so cache-hit rate is naturally high.
4. **Diff-hash cache (local).** Never re-review an identical diff — answer served from disk, zero tokens.
5. **Batch API for non-urgent work.** `arcane gate` in CI and nightly deep reviews go through the **Batch API (50% off in+out)**; interactive `arcane review` stays standard/real-time. Batch stacks with caching.
6. **Effort + output caps.** Run the judge at low/high effort by stakes; cap `max_tokens`; force JSON. Effort drives output length, which is where the money goes.
7. **Budget guardrails.** `arcane.toml` sets a token/$ ceiling per hour/day. On breach, degrade gracefully to static-only and surface a `$ spent today` meter in the TUI (on-brand for a tool about keeping things clean).
8. **Privacy / local mode.** Code is sent to the API — the AI layer is **opt-in per repo**, `--no-ai` disables it, and Arcane should remind users to disclose this to *their* users for sensitive code.

### Effective-cost intuition
Standard prose review = expensive. The same review with cached repo context + a terse JSON verdict + Haiku triage filtering out 70% of diffs = a small fraction of list price. The whole design is "spend Opus tokens on the 5% of changes where frontier judgment changes the outcome, and nowhere else."

**Auth/keys:** the AI layer runs in Arcane Cloud, so the `ANTHROPIC_API_KEY` lives **server-side** (managed by Arcane, or supplied by the customer in self-host) — never on the user's machine. For latency-critical interactive reviews, Opus 4.8 **Fast Mode** is an option but a 2× premium — default to standard.

---

## 18. The execution-safety core — realtime without danger

**Stack:** the CLI is a thin **Node** client (collect + stream + render); the engine is **Bun + TypeScript** in Arcane Cloud (all analysis + execution). The CLI keeps only a tiny offline journal — no database, no analyzers, no code execution.

**The core idea:** "analyze code" ≠ "run code," and the safety boundary is now also a *machine* boundary. The local CLI **never runs your code and never even analyzes it** — it only watches the filesystem and streams changes. Everything that could be heavy or dangerous happens in the cloud, where it's isolated:

```
   LOCAL (CLI, thin)                         ARCANE CLOUD (Bun)
   file change (chokidar)                    ┌──── HOT PATH (static, NEVER runs code) ─────────────┐
     → ordered change event       ──stream──▶│ shadow worktree → blast radius → parse-only:        │
       (op, path, hash, seq)        (TLS)    │ complexity · escape-hatch · secrets · semgrep · …   │
     → render results ◀────────────events────│ → scores/findings. Cost scales with change.         │
   (CLI does nothing else)                    └─────────────────────────────────────────────────────┘
                                              ┌──── COLD PATH (executes code — isolated sandbox) ───┐
                                              │ microVM/container PER RUN · no network by default   │
                                              │ CPU/mem/time caps → SIGKILL on overrun              │
                                              │ probe intercepts fetch/http/db/fs → block/replay    │
                                              │ no shared FS between tenants · secret stripping     │
                                              └─────────────────────────────────────────────────────┘
```

**Why this is safe by construction:** untrusted code never touches the user's machine *or* another customer's environment. **Infinite loops** die to a watchdog SIGKILL in the cloud sandbox and surface as a finding ("functionX did not terminate within budget"). **API calls / side effects** are denied by default — the probe intercepts `fetch`/http/DB/`fs` before user code loads, so calls are blocked or served from recorded fixtures (record-replay). No real charges, no prod, no exfiltration.

**Honest "realtime perf":** static perf signals (O(n²) loops, heavy-import cold start, bundle bloat, complexity) are truly live (parse-only, server-side). Measured numbers (benchmarks, queries, memory) come from sandboxed runs, labelled with freshness — never live-looped on code that might hang. Full isolation spec: Technical-Spec §21A.

---

## 19. Test generation — feeding the measurement engine

Test generation is not a side feature: it's the **execution surface** the dynamic layer (§18 cold path) measures against. No tests → no real timing, no real N+1 count, no regression baseline. Generating tests manufactures that surface.

### The one rule that decides if it helps or hurts
**Generate tests from the CONTRACT, never from the implementation.**
Hand a model a function and say "write tests for this," and it infers intent *from the code* — so buggy code gets tests asserting the bug is correct, handing you a green check over broken behavior. Worse than no tests. Anchor generation to intent sources independent of the implementation:
- type signature, docstring/JSDoc, function contract
- JSON Schema / OpenAPI spec
- **the prompt the user gave the agent** (from the session log, via burst attribution)
- existing passing tests (style anchor)

Then run contract-derived tests against the implementation. A failure is a **finding** ("code doesn't match its contract"), not a reason to weaken the test. This flips test-gen from rubber-stamping code into verifying it.

### Tiers (cheapest & safest first)
1. **Characterization / golden-master (no LLM).** Run fn, snapshot output. Doesn't claim correctness — pins current behavior so the next edit that changes it gets flagged. Highest value, lowest risk, ~free.
2. **Property-based (fast-check / schemathesis).** Derive invariants from schema/types (no crash, output matches output schema, round-trip = identity); throw thousands of inputs. Properties come from the contract → can't codify the bug. Strongest auto-correctness signal.
3. **Opus example tests.** Edge-case & error-path tests anchored to prompt + types. Most useful, most trap-prone → clearly labeled AI drafts the human promotes; never silently merged into the real suite.

### The trustworthy loop
```
new/changed fn, low coverage
   → extract contract (sig, types, docstring, schema, originating prompt)
   → generate (property-based + optional Opus example tests)
   → RUN IN SANDBOX (§18 cold path: infinite loops killed, API calls intercepted)
   → pass  → coverage↑ + execution surface for perf + regression baseline
     fail  → finding: "implementation may not match intent"
   → mutation-test the generated tests (Stryker) → confirm they test something
```
Arcane validating its own tests via mutation testing catches the fake-test trap in its own output.

### Placement & cost (per §17)
- Generated tests target `vitest run`; land in a marked namespace (`*.arcane.test.ts` / `__arcane__/`) — drafts, not auto-committed into the user's suite.
- Tier 0–1 (characterization, property-based) need little/no model → prefer them. Reserve Opus for ambiguous intent + tricky edge cases. Cache by function-signature hash; batch whole-PR gen via Batch API.
- Roadmap: **not MVP.** Characterization + property-based land in M5 (they feed the dynamic layer); the full Opus intent-verification loop comes with M5–M6.

### Honest caveat
Auto-generated tests are drafts, not truth. Excellent at catching *change* and *contract violations*; they cannot invent correctness you never specified. Garbage intent in → garbage tests out. The more real intent Arcane is fed (prompts, types, schemas), the better the tests.

---

## 20. Runtime Delta Engine (run, measure & report)

> **Product truth (defensible claim):** Arcane does **not** predict production runtime from source. It measures *controlled runtime regressions* by running user-declared workloads in **Arcane-managed isolated cloud environments**, comparing **baseline vs current** under identical conditions, and attributing slowdowns to changed code via traces + static analysis. Both runs share the same server class, so it's a consistent *relative* signal — not a production-runtime prediction. Class-level microbenchmarks are **supporting diagnosis only**, never the headline. (Full vetted methodology — worktrees, alternating runs, p95-not-average, warmup separation, hotness weighting, microbench buckets, confidence scoring: **Technical-Spec §19A**.)

**Status:** the *engine* exists (sandbox §18, instrumentation, `.arcane/` store) — this section adds the explicit user-facing capability: Arcane runs a workload, measures it baseline-vs-current, and produces a delta report with a confidence level.

The naïve version ("copy every class, average the runtimes") is explicitly rejected: it yields real-looking numbers that don't mean anything (classes don't run in isolation; averages hide bottlenecks). The real product is **measured change impact**, not simulation.

**Consent (non-negotiable):** execution is **opt-in and off by default**, runs **only workloads the user explicitly declares** in `arcane.toml` (Arcane never invents an entrypoint), and **asks permission before every run** (Allow once / session / always / deny; headless/CI must opt in explicitly). Results stream into a **live run view** with real-time graphs — latency, throughput, and the memory-over-iterations leak curve. Full spec: Technical-Spec §19.

### Define the workload (answers "you don't know how to boot the app", §15)
Execution targets are declared in `arcane.toml` (auto-detected from `package.json` scripts where possible, confirmed once, remembered):
- **function/module** — microbenchmark a unit
- **test suite** — `vitest run` (timing, coverage, query counts, flakiness)
- **server/app** — boot in sandbox, drive endpoints under load
- **custom workload** — a representative scenario script

### What gets measured ("different aspects")
Latency (p50/p95/p99) · throughput (ops/req per sec) · peak & growth memory · CPU · allocations/GC pressure · DB query count + slow queries · intercepted outbound calls · cold-start/import time · errors/unhandled rejections · coverage.

### Measurement primitives
`process.hrtime.bigint()` (hi-res timing) · `tinybench` (statistical microbench w/ warmup) · `process.memoryUsage().rss` sampled over time · `global.gc()` + `v8.getHeapStatistics()` for memory introspection · load: internal concurrent fetch driver or shell out to `autocannon` · `vitest run --coverage`.

**Real memory-leak detection (finally measured, not guessed):** run the workload in a loop, `global.gc()` between iterations, sample the heap. A monotonic climb across iterations after GC = a real leak signal. This is the runtime profiling that the static pattern-flagging (§4) could only hypothesize — now feasible because the sandbox + repeated-workload harness give a controlled environment.

### The report (a delta, not a dump)
- Rendered to `.arcane/reports/<ts>-<sha>/` as Markdown + HTML + JSON, correlated to a git state.
- Most valuable as a **comparison**: `arcane report --compare main` → "p95 +40ms vs main · heap +12MB/1000 iters (likely leak) · 3 new slow queries."
- **Opus 4.8 writes the narrative on top of the raw numbers** (§17): prioritizes, attributes ("~80% of the latency increase is the N+1 introduced in the last burst"). Interprets measured data — never fabricates it.
- `arcane gate` can fail CI on a perf-budget regression from a run.

### Commands
`arcane run [workload]` (execute + measure) · `arcane report [--html] [--compare <ref>]` (render). Multiple runs + confidence bands to handle run-to-run variance (§15 jitter).

**Honest framing:** this is the most powerful *and* most operationally fraught capability — it requires real execution (sandbox must be solid), a defined/bootable workload, and accepting variance (report with confidence intervals, never a single noisy number).

---

## 21. Auto-fix — the trust ladder

**The irony to avoid:** Arcane exists *because* agents make sweeping unreviewed edits. If Arcane itself makes sweeping unreviewed AI edits, it becomes the problem it solves. So fixes are **deterministic-first, verified, scoped, and reversible** — never blanket LLM rewrites.

### Fix tiers (by confidence)
1. **Deterministic autofix (no LLM).** ESLint/Ruff `--fix`, formatters, remove unused imports/exports (knip), organize imports, mechanical missing-`await`. Most "fixing" lives here. Reviewable diff, safe.
2. **Codemods / AST transforms (deterministic, structural).** Well-defined patterns: serialized awaits → `Promise.all`, wrap multi-write in a transaction, memoize repeated computation.
3. **LLM-proposed fixes (Opus, gated).** Semantic issues (real bugs, N+1 restructuring, missing authz). Propose, never blind-apply.

### The verify-before-offer gate (the differentiator)
```
finding → propose fix (autofix | codemod | Opus)
   → apply to an ISOLATED git worktree (never the user's working dir)
   → re-run affected analyzers + tests in the sandbox (§18)
   → fix clears the finding  AND  no new findings  AND  tests still pass?
        yes → present a verified, reviewable diff (human approves / one-key apply)
        no  → discard; mark "couldn't safely auto-fix" + explain why
```
This is "Arcane *proves* the fix works before you accept it," not "AI rewrote your code." Synergy: the fix gate is only as good as the tests — which is exactly why §19 test-gen matters. Better tests → safer fixes.

### Modes & commands
- **suggest** (default, never writes) · **apply-with-confirm** · **auto-safe** (deterministic + verified only, e.g. pre-commit hook). No unattended LLM-fix-everything default.
- `arcane fix [finding-id]` (verified fix, show diff, confirm) · `arcane fix --all --safe` (bulk deterministic/verified only) · TUI `f` = propose, preview, `a` = apply.
- Each applied fix = its own atomic commit (`arcane: fix <finding>`) → trivially revertible, shows cleanly in the working-tree diagram.

### Cost (per §17) & roadmap
Deterministic fixes free; reserve Opus for confirmed meaningful findings; cache; batch bulk fixes. **Roadmap:** deterministic autofix and the verified LLM-fix loop land in M6 (the loop depends on the cloud sandbox §18/§21A, strengthened by test-gen).

**Caveat:** some findings (architectural, intent-dependent) should be *explained, not auto-fixed*. Arcane must know when to defer to the human.

---

## 22. Design philosophy — easy by default, deep when you want it

Arcane has **no separate "simple mode."** The whole tool is approachable out of the box, and the advanced power is configurable on top. The same defaults serve a non-engineer who vibe-coded an app and a senior engineer auditing a monorepo:

- **One Health read-out first.** The default view leads with a single health indicator (green / amber / red) and plain-English warnings ("this part is getting slow and won't handle many users") — not eight raw metric bars. The granular dimension bars are one keystroke away (`d` / "show details").
- **Plain English everywhere.** Findings are written for humans by default ("complexity 24 in payments.ts" → "this code is getting hard to change safely"). Templated for common rules (no token cost); AI rewrites only the unusual ones.
- **Guided actions.** "3 safe issues found — fix them for me? [Y]" wired to the verified auto-fix (§21).
- **Power on tap, not in your face.** Thresholds, deep scans, custom analyzers, raw metrics — all configurable in `arcane.toml`, none required to get value on day one.
- **Plain-language onboarding** at `arcane init`.

The principle: nobody should need a manual to benefit, and nobody should hit a ceiling when they want to go deep.

---

## 23. The Arcane web platform

The hosted web app is where you **sign up, link your CLI, and *see* your project** — and because all analysis already runs in Arcane Cloud, the web app and the terminal are **twin live front-ends over the same result stream**: when evals run, both update at the same time. This is the "team plane" foreshadowed in §13.

**Two principles:**
- **The terminal and the web update together.** A single analysis run fans out to the CLI socket and the dashboard's realtime channel simultaneously — what you see in your terminal, a teammate sees in the browser, live. The web app isn't a delayed mirror; it's the same stream.
- **Source handling is explicit and honest.** In the default **Cloud** mode your source is streamed to Arcane over **TLS** and stored **encrypted at rest** (Arcane-managed per-project keys), scoped to your project, and **deletable** (with an ephemeral analyze-and-discard option). **Planned** for teams that can't upload source: a **Metadata-only** mode (only scores/findings leave the machine) and a **Self-host** option (run the engine in your own infra). No "code never leaves your machine" hand-waving — Arcane is upfront that cloud analysis means cloud source access, and is building real options for those who need them.

**What it does (a real app, not one feature):**
- **Sign up / auth** (email + GitHub/Google OAuth), orgs & teams, roles, invites, billing.
- **CLI device-link** — `arcane login` pairs the CLI to your account (browser approval, like `gh`/`vercel`).
- **Live visual work tree** — the polished web version of your sketch: the full commit graph, remote **and local** branches (the CLI reports local branch state, so you can see work that isn't even pushed yet), with every contributor on the codebase shown on their branches.
- **CI/CD tab** — pipeline runs, Arcane gate pass/fail history, and integration setup (GitHub App/Action, GitLab, Slack notifications).
- **Project insights** — health trends over time, hotspot files, risk areas (high-severity findings, vuln deps, coverage gaps), contributor views (framed as "where the codebase needs attention," not blame), and an AI **executive summary** ("security dropped this week from 2 new high-severity findings in payments").

**Tabs:** Overview (non-technical default) · Work Tree · Findings · Insights · CI/CD · Team · Settings.

**Honest scoping:** this roughly doubles the project and is a later set of milestones — the standalone CLI ships and earns users first; the platform is the team/business layer on top.

---

## 24. Twin front-ends: the terminal is account-aware too

Signing in isn't web-only. The CLI and web app are two windows onto the same account and the same live data — a terminal-native user never has to open the browser to see team-wide state. Once you sign in from the TUI (press `L` → browser approval → back to the terminal), the dashboard gains tabs that mirror the web app: **Branches** (your local branches, the team's remote branches, and — if teammates opt into presence — their unpushed local branches), **Contributors** (everyone on the codebase), **CI/CD**, and **Insights** — all updating live via the same realtime channels the browser uses. Your own git state (branches, working tree) is read locally and shown instantly; analysis comes from the cloud. Detail: Technical-Spec §27.

---

## 25. What vibe-coding tools get wrong — and how Arcane fixes it

Tools like **Lovable, Bolt, v0, and Replit Agent** are astonishing at turning a prompt into a working app. But the most common complaint about them is consistent: **the code works in the demo and then doesn't hold up.** It's written to *look done*, not to run at scale. What people run into as their app grows:

- **It doesn't scale.** Database queries with no indexes, N+1 query explosions (one request firing hundreds of queries), no caching — fine with 5 users, unusable with 5,000.
- **It's bloated and slow.** Duplicated and dead code, heavy imports, ballooning bundles, slow cold starts.
- **It's insecure.** Exposed API keys, missing authorization checks, injection-prone code, vulnerable dependencies — afterthoughts the generator skips.
- **It's untested and fragile.** No tests, no error handling, hardcoded values that break in production.
- **It rots.** Every new prompt piles onto a tangle nobody can follow, until the codebase is unmaintainable and the next change breaks something else.
- **You don't see any of it** until real users hit it in production — exactly when it's most expensive to fix.

**Arcane's whole reason to exist is this gap.** It catches each of these *as the code is written*, not months later:

| The vibe-coding problem | How Arcane catches it |
|---|---|
| Won't scale: N+1, missing indexes, slow queries | Query-plan analysis + N+1 detection (flagged on write, confirmed on measure) |
| Slow / bloated: O(n²), heavy imports, big bundles | Static perf heuristics + real profiling + the memory leak curve |
| Messy / unmaintainable: dead & duplicate code, complexity | Continuous static analysis with a live health trend prompt-by-prompt |
| Insecure: secrets, missing authz, injection, vuln deps | semgrep + gitleaks + dependency scanning + the AI judge for business-logic security |
| Untested / fragile | Test generation from the contract (§19) |
| "Is it safe to launch?" | The gate + "ready to go live" readiness signal |

The one-sentence version: **vibe-coding tools optimize for "works in the demo"; Arcane makes sure it also works at scale, securely, and maintainably — continuously, while it's being built, so a prototype becomes production-grade instead of a liability.**

---

## 26. CI/CD: Arcane as a merge gate

Beyond watching your local edits, Arcane runs in the pipeline as a **gate**: one headless command (`arcane gate`) that compares a PR against its target branch and blocks the merge if the change introduces *new* security, quality, or performance regressions — never failing on pre-existing debt. It posts findings to GitHub/GitLab's native Security tab (SARIF) and inline on the PR, records the run to the web CI/CD tab, and drives the "safe to go live" signal. Works in GitHub Actions, GitLab CI, CircleCI, Bitbucket, Jenkins, or as a local pre-push hook — and it's the same gate that ends an unattended agent loop. Full configs + semantics: Technical-Spec §28.
