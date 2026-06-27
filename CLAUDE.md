# CLAUDE.md — Arcane

Arcane = a THIN Node CLI (collects repo changes) + a HOSTED Bun cloud engine (does ALL analysis),
streaming results to the terminal AND a web dashboard simultaneously. Runs on any computer.
Read `docs/current/Arcane-Build-Guide.md` before coding. Open `docs/current/Arcane-Technical-Spec.md`
ONLY at the section your current phase cites. UI/config/marketing live in
`docs/current/Arcane-Product-Requirements.md`.

AUTHORITATIVE DOCS: only the four docs in `docs/current/` are authoritative. Any older docs in
`docs/archive/` describe a SUPERSEDED local-first design — IGNORE them unless explicitly asked.
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

SESSION GIT DISCIPLINE (hard — a prior session reported "committed" when nothing was; never again):
- START of session: run `git log --oneline` and confirm it shows the expected prior-phase commit,
  and `git status` shows a CLEAN working tree, BEFORE building. If the log is empty/unexpected or
  the tree is dirty, STOP and tell the user — do not build on an unverified baseline.
- END of session: actually `git commit` AND `git push`, then PROVE the push landed — `git status`
  says "up to date with 'origin/main'" and `git rev-parse HEAD` == `git rev-parse origin/main`.
  Never report "committed"/"pushed" without that `git log`/`rev-parse` proof.

STACK (two runtimes — don't mix):
- CLI (packages/cli): Node ≥20, TS strict, ESM. ink+react (jsx: react-jsx), chokidar, ws,
  xxhash-wasm, simple-git, smol-toml, zod, chalk. NO native addons.
- Cloud (services/cloud): Bun + TS. Bun.serve (WS/REST), BullMQ, Postgres+storage (Supabase),
  tree-sitter, semgrep/gitleaks/knip/osv, microVM/container sandbox (M3), @anthropic-ai/sdk.
- Shared (packages/shared): zod protocol + domain schemas.

CURRENT PHASE: Session 0 (Build Guide §6) — scaffold the monorepo; build @arcane/shared
(ChangeEvent/AckEvent/ResultEvent + Finding/Metric/Score/RunReport/ArcaneConfig); a Node CLI shell
and a Bun gateway STUB; prove ONE fake ChangeEvent → ONE fake ResultEvent over WS. No watcher, no
analyzers, no DB, no auth, no sandbox, no web wiring (those are M1A+). Do only this phase.

> Per-package CLAUDE.md files set CURRENT PHASE + the lane + the runtime (Node vs Bun) so each
> agent session stays narrow.
