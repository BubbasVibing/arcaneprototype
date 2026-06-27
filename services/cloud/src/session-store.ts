// The sync-layer state store (Technical-Spec §7). M1B keeps it IN MEMORY (the persistence boundary
// the user fixed: Postgres is deferred to M1C — neither M1 "Done when" gate needs server-side
// durability). `ingest.ts` depends ONLY on the `SessionStore` interface, so M1C drops in a
// `PostgresSessionStore` (sessions + source_snapshots + source_files) without touching ingest logic.
// All methods are async for exactly that swap.

import type { ArcaneConfig, GitContext } from "@arcane/shared";

// A shadow-worktree manifest: repo-relative POSIX path → CLI-provided contentHash. The server never
// hashes (§3A.3) — it trusts these — so the manifest is the authority for `snapshotId`.
export type Manifest = Map<string, string>;

// The materialized baseline of a linked project (created by `arcane link`).
export interface ProjectBaseline {
  manifest: Manifest;
  baseSnapshotId: string;
  git?: GitContext; // read-only git context captured at link time (§3A.5)
  config?: ArcaneConfig; // validated arcane.toml — selects + configures analyzers (M2B)
  lastActiveAt: number; // epoch ms of last link/apply for this project — drives idle reaping
}

// One live `arcane watch` session's server-side state (the §7 `sessions` row + its current snapshot).
export interface SessionState {
  sessionId: string;
  projectId: string;
  appliedSeq: number; // highest CONTIGUOUS seq applied (== the ackSeq we return)
  manifest: Manifest; // path → contentHash of the shadow worktree (mutated in place on apply)
  currentSnapshotId: string;
  baseSnapshotId: string;
  git?: GitContext; // refreshed from /ingest connection metadata on each (re)connect (§3A.5)
  config?: ArcaneConfig; // from the project baseline (link time) — drives analyzer selection (M2B)
  lastActiveAt: number; // epoch ms of last apply/reconnect — drives idle reaping
}

export interface SessionStore {
  // `arcane link`: record a project's materialized baseline so the first watch event can seed from it.
  registerBaseline(projectId: string, baseline: Omit<ProjectBaseline, "lastActiveAt">): Promise<void>;
  // The project's link-time baseline (carries the authoritative ArcaneConfig). M3D's run endpoint +
  // worker read config from here to gate execution; undefined ⇒ never linked / reaped → fail closed.
  getBaseline(projectId: string): Promise<ProjectBaseline | undefined>;
  // First event of a session: create state seeded from the project baseline. `parentSnapshotId` is
  // the baseSnapshotId the CLI carries from `link`. Throws if the project was never linked here.
  getOrCreateSession(
    sessionId: string,
    projectId: string,
    parentSnapshotId: string,
    git?: GitContext, // connection metadata: seeds a new session, refreshes an existing one
  ): Promise<SessionState>;
  getSession(sessionId: string): Promise<SessionState | undefined>;
  // After a contiguous apply: advance the cursor + snapshot (the manifest is mutated in place by the
  // shadow worktree, so it is already current on the shared SessionState reference).
  recordApply(sessionId: string, appliedSeq: number, snapshotId: string): Promise<void>;
  // Every project with a live in-memory baseline. The boot orphan-sweep diffs this against the dirs
  // on disk; any dir without a baseline here is an orphan from before a restart.
  listProjectIds(): Promise<string[]>;
  // Reap projects idle longer than ttlMs (no link/apply/reconnect). Returns the reaped projectIds so
  // the caller can delete their shadow dirs. `now` is injectable for tests.
  reapIdle(ttlMs: number, now?: number): Promise<string[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly baselines = new Map<string, ProjectBaseline>();
  private readonly sessions = new Map<string, SessionState>();

  async registerBaseline(
    projectId: string,
    baseline: Omit<ProjectBaseline, "lastActiveAt">,
  ): Promise<void> {
    this.baselines.set(projectId, { ...baseline, lastActiveAt: Date.now() });
  }

  async getBaseline(projectId: string): Promise<ProjectBaseline | undefined> {
    return this.baselines.get(projectId);
  }

  async getOrCreateSession(
    sessionId: string,
    projectId: string,
    parentSnapshotId: string,
    git?: GitContext,
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (git) existing.git = git; // refresh on reconnect (the connection re-reads git, §3A.5)
      existing.lastActiveAt = Date.now();
      const base = this.baselines.get(projectId);
      if (base) base.lastActiveAt = existing.lastActiveAt; // keep the project alive while watched
      return existing;
    }

    const baseline = this.baselines.get(projectId);
    if (!baseline) {
      // The project was never linked on this server instance — the CLI must re-link (§3A.4).
      throw new Error(`unknown project ${projectId} — run \`arcane link\` first`);
    }
    const now = Date.now();
    baseline.lastActiveAt = now;
    const state: SessionState = {
      sessionId,
      projectId,
      appliedSeq: 0,
      manifest: new Map(baseline.manifest), // copy: a session's edits never mutate the baseline
      currentSnapshotId: parentSnapshotId,
      baseSnapshotId: baseline.baseSnapshotId,
      git: git ?? baseline.git, // connection git wins; else fall back to link-time git
      config: baseline.config,
      lastActiveAt: now,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  async getSession(sessionId: string): Promise<SessionState | undefined> {
    return this.sessions.get(sessionId);
  }

  async recordApply(sessionId: string, appliedSeq: number, snapshotId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`recordApply on unknown session ${sessionId}`);
    state.appliedSeq = appliedSeq;
    state.currentSnapshotId = snapshotId;
    state.lastActiveAt = Date.now();
    const base = this.baselines.get(state.projectId);
    if (base) base.lastActiveAt = state.lastActiveAt;
  }

  async listProjectIds(): Promise<string[]> {
    return [...this.baselines.keys()];
  }

  async reapIdle(ttlMs: number, now = Date.now()): Promise<string[]> {
    // Latest activity per project = its baseline's lastActiveAt (sessions keep it bumped on apply/
    // reconnect). Reap a project + all its sessions when idle longer than ttlMs.
    const reaped: string[] = [];
    for (const [projectId, baseline] of this.baselines) {
      if (now - baseline.lastActiveAt <= ttlMs) continue;
      this.baselines.delete(projectId);
      for (const [sid, s] of this.sessions) if (s.projectId === projectId) this.sessions.delete(sid);
      reaped.push(projectId);
    }
    return reaped;
  }
}
