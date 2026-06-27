# Arcane — Product Requirements (UI · CLI config · marketing)

> **Purpose & scope.** This is *peripheral context*, deliberately separated from `Arcane-Technical-Spec.md` so it doesn't crowd a coding agent's window. It defines **what the UIs must capture and display** (landing + dashboard), the **full `arcane.toml` + command reference**, and **marketing/positioning**. Engine algorithms, schemas, and the build order are **not** here — those live in the Technical Spec and Build Guide.
>
> **Who reads what:** Lane B (landing) → §2 + §5. Lane C (dashboard) → §3. Anyone wiring CLI config/commands → §4. Don't load this file for core-engine tasks.

---

## 1. How to use this doc
- **Requirements, not implementation.** Each UI section lists *what it must show* and *what data it must get* — not the React/component code.
- **Data shapes are owned by `@arcane/shared`.** When a screen needs a field, confirm it exists in the shared schemas (Technical-Spec §5–§7); if not, it's added there first.
- **The runtime claim is fixed copy** (see §5). Use it verbatim anywhere performance is described — landing, dashboard tooltips, docs.

---

## 2. Landing page — UI requirements (Lane B)

**Goal:** explain the wedge in 10 seconds, prove credibility, capture a waitlist/install. Static-first, fast, mobile-clean. No engine dependency.

> **Honesty rule for the landing page:** market **what M1 actually does** as present-tense, and clearly label everything else **"coming soon."** M1 = the live cloud round-trip with three static analyzers (complexity, escape-hatch, secrets), scores/findings, and terminal+web sync. Runtime delta (M3), AI review (M4), test-gen (M5), auto-fix (M6), CI gate + self-host (M7), metadata-only (later) are **roadmap** — show them as "coming soon," never as if they work today.

| Section | Must display | Must get / wire to |
|---|---|---|
| **Hero** | One-line value prop (§5 taglines), sub-line ("Runs on any computer — a tiny CLI streams your changes to Arcane's cloud engine"), primary CTA, install snippet `npm i -g @arcane/cli`, a terminal+browser loop showing both updating live together | waitlist endpoint (email → durable store) |
| **The problem** | The vibe-coding gap: "works in the demo, breaks at scale" — N+1 queries, missing indexes, no caching, security holes, no tests | static copy (§5) |
| **The solution** | A thin CLI watches as your agent writes and streams every change to Arcane Cloud; live eval bars + findings stream back to your terminal **and** the web app at once | static copy + the twin terminal/browser visual |
| **How it works (3 steps)** | 1) `npm i -g @arcane/cli`, `arcane login`, `arcane link` · 2) `arcane` — edit with your agent, watch scores + findings update live in the terminal and dashboard · 3) review the deltas before you ship | static |
| **Runs anywhere** | Because all analysis is in the cloud, Arcane needs no local toolchain/horsepower — same experience on any laptop, like Claude Code | static |
| **What's live now** | **Available today:** live cloud analysis · terminal ↔ web sync · complexity / escape-hatch / secret scanning · scores + delta findings · agent-agnostic | static |
| **Coming soon** (clearly labeled) | runtime delta engine · AI review · test generation · auto-fix · CI merge gate · self-host & metadata-only modes | static; "join the waitlist to follow along" |
| **Privacy & trust block** | Honest, explicit: a tiny CLI streams changes to Arcane Cloud over **TLS**; **source is stored encrypted at rest, scoped to your project, and deletable**; default is **Cloud**; **Metadata-only** and **Self-host** are **planned**; isolated sandboxes, no-network execution (for the coming runtime features) | static (verbatim §5.7) |
| **Runtime honesty block** | The exact product-truth line (§5.4), framed as a **coming-soon** capability — turns a liability into a credibility signal | static (verbatim) |
| **Social proof / logos** | agent logos it works alongside (Claude Code, Cursor, Copilot, Lovable, Bolt, v0); GitHub stars when live | GitHub API (stars) optional |
| **Pricing (placeholder)** | Free tier (generous cloud analysis quota); paid team/cloud + self-host later | static until pricing decided (§5.5) |
| **Install / docs / CTA footer** | install commands, links to docs + GitHub + the dashboard app, repeat waitlist CTA | links |

**Non-functional:** Lighthouse ≥ 90, responsive, dark-mode default to match the terminal aesthetic, `NO_COLOR`/contrast-safe palette parity with the CLI accent.

---

## 3. Web dashboard — UI requirements (Lane C)

The web dashboard and the terminal are **twin live front-ends over the same cloud result stream** — when analysis runs, **both update simultaneously** (§3B.2). Every tab lists **what it shows** and **what it must get** (Postgres via Supabase Realtime/RLS). Frontend can be built early against mock data shaped by `@arcane/shared`; real data lands as soon as the cloud engine (Lane E) emits a stream.

| Tab / screen | Must display | Must get (data) |
|---|---|---|
| **Live (the headline view)** | **What's happening right now, in lockstep with the terminal:** the active session's pipeline state (uploading → queued → analyzing → done), eval bars + findings updating *as the user edits*, the file currently being analyzed, and (during a run) live latency/throughput/leak-curve graphs. This is the "watch everything run" view. | Supabase Realtime `project:{id}` (`ResultEvent` stream: state/score/finding/run), same events the CLI receives |
| **Overview** | Per-project Health Score + per-dimension bars, trend over time, latest run summary, "safe to go live" signal, active branches count | `projects`, latest `runs`, aggregated `findings`, `ci_runs` latest |
| **Work-Tree / Branches** | Branch list with owner, health, ahead/behind, last activity, findings count; commit DAG; teammates' local/unpushed branches (opt-in presence) | `branches`, presence channel (Realtime), git metadata from the CLI stream |
| **Findings** | Filterable list (dimension, severity, new-vs-existing, file, branch); finding detail (rule, message, location, suggested fix, confidence); group by dimension | `findings` (normalized `Finding` shape), filter/sort server-side |
| **Insights** | Score history; regressions over time; hotspots (files/methods most flagged); runtime-delta history (p95 trend, query-count trend) with **confidence badges** | `runs` time series, `RunReport` metrics (§19A.6), aggregations |
| **CI/CD** | `ci_runs` list + gate pass/fail history; gate config (`gate_on`, perf budget) with write-back via PR; GitHub App install; integration cards (GitHub, GitLab, Slack); "safe to go live" | `ci_runs`, gate config, integration status |
| **Contributors** | Per-contributor activity, health of their branches, findings introduced/resolved | derived from `runs`/`findings`/`branches` by author |
| **Team** | Members, roles, invites | `members`, `invites`, role policy (RLS) |
| **Settings** | CLI tokens (create/revoke), integrations, project config, **source-access mode** (cloud / metadata-only / self-host), data deletion, presence opt-in, billing | `cli_tokens`, integration records, project source-access mode, billing provider |

**Cross-cutting UI requirements:**
- **Simultaneous with the terminal (the core feature):** every result the developer sees in the TUI appears in the browser at the same time, from the same `ResultEvent` stream. No manual refresh; late-joining tabs hydrate from Postgres then continue live.
- **States:** every tab needs intentional empty / loading / signed-out / **connecting** / offline states. Never blank panels.
- **Privacy surface:** the UI must make the project's **source-access mode** explicit — whether source is uploaded (encrypted, deletable), metadata-only, or self-hosted — and let the user delete uploaded source. Presence is opt-in (branch names + health, never code).
- **Parity with TUI:** account-aware terminal tabs (`arcane branches|contributors|ci|insights`) mirror these screens — same data, same shapes (Technical-Spec §27).

---

## 4. CLI configuration & command reference

The authoritative *surface* for users and for agents wiring config. The CLI streams changes to Arcane Cloud and renders streamed results; it never analyzes locally. (Semantics: Technical-Spec §3A (collector), §3B (fan-out), §11–§13, §19A, §24 (source-access modes), §28.)

### 4.1 `arcane.toml` (project root)

```toml
# ── General ──
[project]
languages = ["ts", "js"]          # detected if omitted
ignore    = ["dist", "node_modules", ".arcane"]

[ui]
theme   = "auto"                   # auto | dark | light
density = "summary"                # summary | full  (default detail level; NOT a beginner/pro mode)
accent  = "violet"

# ── Scoring & analyzers (analyzers run in Arcane Cloud; this just configures them) ──
[score]
weights = { quality = 1.0, security = 1.5, performance = 1.0, maintainability = 1.0 }

[analyzers]
enabled  = ["complexity", "escape-hatch", "semgrep", "knip", "gitleaks", "osv"]
disabled = []
[analyzers.complexity]
max_cyclomatic = 15
[analyzers.thresholds]
quality = 70                       # bar turns amber/red below thresholds

# ── Baseline / delta ──
[baseline]
ref = "origin/main"                # delta-first: only NEW findings vs this ref are surfaced

# ── Execution (OFF by default; runs in Arcane Cloud's isolated sandbox; gates the Runtime Delta Engine) ──
[execution]
enabled            = false         # master switch — nothing runs unless true
require_permission = true          # prompt before each run (allow once/session/always/deny)
allow_in_ci        = false         # CI must opt in explicitly (or pass --yes)
isolation          = "microvm"     # cloud runner isolation: microvm | container
timeout_ms         = 30000         # watchdog SIGKILL on overrun
network            = "deny"        # deny | replay | allow(only with explicit grant)

# Declaring a workload ≠ permission to run it (still gated by [execution]).
[[workload]]
name       = "unit-tests"
command    = "npm test"
type       = "test"                # test | server | benchmark | function
auto_grant = false                 # true = skip the prompt for THIS workload only

[[workload]]
name       = "api-smoke"
command    = "npm run arcane:smoke"
type       = "server"
inputs     = "fixtures"            # tests | fixtures | zod | openapi | recorded | sample
perf_budget = { p95_ms = 200 }     # optional regression budget for the gate

# ── AI (opt-in, budgeted; runs in the cloud) ──
[ai]
enabled      = false
judge_model  = "claude-opus-4-8"
triage_model = "claude-haiku-4-5"
daily_budget_usd = 2.00
batch_in_ci  = true                # use Batch API (50% off) for gate/nightly

# ── Gate (CI) ──
[gate]
gate_on = ["security", "performance"]   # which dimensions block a merge
fail_on = "new-regressions"             # never the legacy backlog

# ── Cloud (source-access mode — how Arcane gets your code) ──
[cloud]
mode           = "cloud"           # cloud | metadata-only | self-host
endpoint       = ""                # self-host engine URL (mode = self-host)
ephemeral      = false             # cloud mode: analyze-and-discard, persist results only
share_presence = false             # publish branch names + health to teammates (NEVER code)
```

### 4.2 Command reference

| Command | Purpose | Key flags | Exit |
|---|---|---|---|
| `arcane login` | Device-link this machine to your account (token → `~/.arcane`) | — | 0 |
| `arcane link` | Link this repo to a project; upload the initial encrypted snapshot (per source-access mode) | `--mode <cloud\|metadata-only\|self-host>` | 0 |
| `arcane` | Launch the live TUI: stream changes to Arcane Cloud, render results as they arrive | `--no-color` | 0 |
| `arcane init` | Detect stack, scaffold `arcane.toml`, suggest workloads (confirmed by user) | — | 0 |
| `arcane watch` | Headless watch — stream changes, print results (no TUI) | `--json` | 0 |
| `arcane scan` | One-shot: analyze current state in the cloud, print report | `--json`, `--deep` | 0/1 |
| `arcane score` | Print current scores (from the cloud) | `--json` | 0 |
| `arcane baseline set` | Set the delta baseline ref | `<ref>` | 0 |
| `arcane run [workload]` | Run a declared workload in the cloud sandbox (consent-gated) + report | `--compare`, `--baseline <ref>`, `--yes` | 0/1 |
| `arcane review` | AI semantic review (opt-in, cloud) | `--json` | 0/1 |
| `arcane explain` | Plain-English explanation of a finding | `<id>` | 0 |
| `arcane fix` | Apply a cloud-verified fix diff locally (trust ladder) | `--all`, `--safe`, `--dry-run` | 0/1 |
| `arcane gate` | CI merge gate (delta-first) | `--baseline <ref>`, `--json`, `--sarif`, `--junit` | 0/1/2 |
| `arcane whoami` / `logout` | Show / clear the linked account | — | 0 |
| `arcane branches \| contributors \| ci \| insights` | Account-aware views (mirror web tabs) | `--json` | 0 |

**Exit-code contract:** `0` clean · `1` findings/regressions (gate fails the build) · `2` config/tool error. The agent-loop / CI stop condition is `npx vitest run && npx tsc --noEmit && arcane gate`.

---

## 5. Marketing & positioning

> Reference for landing copy, README, docs tone. Keep claims honest — the honesty *is* the differentiator in a category full of hype.

### 5.1 The wedge (one sentence)
**Arcane is the quality, security, and performance layer for AI-written code — it watches as your agent codes and stops "works-in-the-demo" code from silently degrading before it ships.**

### 5.2 Audience
- Solo builders / "vibe coders" shipping fast with Claude Code, Cursor, Lovable, Bolt, v0 — who keep hitting scale/security walls later.
- Small teams adding AI agents to their workflow who need a guardrail in CI.
- Eng leads who want a delta-first gate that blocks *new* regressions without drowning in legacy debt.

### 5.3 Taglines (pick/test)
- "Production-grade guardrails for AI-written code."
- "Your agent writes fast. Arcane keeps it shippable."
- "Catch the N+1 before it ships."
- "Live code health, while the agent types."

### 5.4 The runtime honesty block (verbatim — a credibility asset)
> Arcane does **not** predict production runtime from source code alone. Arcane measures *controlled runtime regressions* by running your declared workloads inside **Arcane-managed isolated cloud environments**, comparing **baseline vs current** code under identical conditions, and attributing slowdowns to the changed files/classes/functions using runtime traces and static analysis. Because both runs happen on the same server class, it's a consistent **relative regression signal** — not a prediction of your production runtime. Class-level microbenchmarks are supporting diagnosis only. Every runtime result ships with a **confidence level**.

This is a feature, not a disclaimer: it signals that Arcane is engineered by people who understand benchmarking, in a space full of tools that overclaim.

### 5.5 Pricing posture (placeholder — decide later)
- **Free:** a generous cloud analysis quota (watch, scan, score, gate, delta findings) — the wedge, drives adoption.
- **Team/Cloud (paid):** higher quotas, the web dashboard + history, presence, CI/CD integrations, team management, cloud sandbox/runtime minutes, AI review budget.
- **Self-host (enterprise):** run the engine in your own infra; source never leaves your network.
- Anthropic API usage (AI layer) and cloud compute bill separately — make this explicit in docs to avoid surprise.

### 5.6 Positioning guardrails (don't overclaim)
- Say "thin client + cloud engine," "runs on any computer." **Never** say "local-first," "code never leaves your machine," or "runs fully offline" — those are no longer true (metadata-only/self-host are the options for teams that can't upload source).
- Say "controlled/relative runtime regressions," never "predicts production performance."
- Say "performance risk increased" for static signals; reserve "slower/faster" for *measured* deltas.
- Always pair a runtime number with its confidence level and the workload it came from.
- Be explicit and upfront about source upload, encryption, deletion, and the three source-access modes — trust is the core sales issue now.
- Agent-agnostic: never imply lock-in to one coding tool.
- **Don't imply roadmap features are live.** M1 is the static cloud round-trip (complexity / escape-hatch / secrets + scores/findings + terminal↔web sync). Runtime delta (M3), AI review (M4), test-gen (M5), auto-fix (M6), CI gate + self-host (M7), and metadata-only (later) must be labeled **"coming soon"** on the site until they ship. Taglines in §5.3 describe the product *vision*; the feature sections must still separate live vs coming.

### 5.7 Privacy & trust block (verbatim — say it plainly)
> Arcane installs a lightweight CLI that watches your repo and securely streams your code changes to Arcane's hosted analysis engine, where all analysis, security checks, AI review, and runtime verification run in isolated cloud sandboxes; results stream back to your terminal and dashboard. **Your source is encrypted in transit and at rest, scoped to your project, and you can delete it at any time** — or analyze ephemerally (analyze-and-discard). Teams that can't upload source will be able to use a **metadata-only** mode (only scores/findings leave your machine) or **self-host** the engine entirely — both **planned**, not yet shipped. Code is never shared between customers; execution runs in per-run isolated sandboxes with no default network access.
