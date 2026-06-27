// The sync-layer state store (Technical-Spec §7). M1B keeps it IN MEMORY (the persistence boundary
// the user fixed: Postgres is deferred to M1C — neither M1 "Done when" gate needs server-side
// durability). `ingest.ts` depends ONLY on the `SessionStore` interface, so M1C drops in a
// `PostgresSessionStore` (sessions + source_snapshots + source_files) without touching ingest logic.
// All methods are async for exactly that swap.

// A shadow-worktree manifest: repo-relative POSIX path → CLI-provided contentHash. The server never
// hashes (§3A.3) — it trusts these — so the manifest is the authority for `snapshotId`.
export type Manifest = Map<string, string>;

// The materialized baseline of a linked project (created by `arcane link`).
export interface ProjectBaseline {
  manifest: Manifest;
  baseSnapshotId: string;
}

// One live `arcane watch` session's server-side state (the §7 `sessions` row + its current snapshot).
export interface SessionState {
  sessionId: string;
  projectId: string;
  appliedSeq: number; // highest CONTIGUOUS seq applied (== the ackSeq we return)
  manifest: Manifest; // path → contentHash of the shadow worktree (mutated in place on apply)
  currentSnapshotId: string;
  baseSnapshotId: string;
}

export interface SessionStore {
  // `arcane link`: record a project's materialized baseline so the first watch event can seed from it.
  registerBaseline(projectId: string, baseline: ProjectBaseline): Promise<void>;
  // First event of a session: create state seeded from the project baseline. `parentSnapshotId` is
  // the baseSnapshotId the CLI carries from `link`. Throws if the project was never linked here.
  getOrCreateSession(
    sessionId: string,
    projectId: string,
    parentSnapshotId: string,
  ): Promise<SessionState>;
  getSession(sessionId: string): Promise<SessionState | undefined>;
  // After a contiguous apply: advance the cursor + snapshot (the manifest is mutated in place by the
  // shadow worktree, so it is already current on the shared SessionState reference).
  recordApply(sessionId: string, appliedSeq: number, snapshotId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly baselines = new Map<string, ProjectBaseline>();
  private readonly sessions = new Map<string, SessionState>();

  async registerBaseline(projectId: string, baseline: ProjectBaseline): Promise<void> {
    this.baselines.set(projectId, baseline);
  }

  async getOrCreateSession(
    sessionId: string,
    projectId: string,
    parentSnapshotId: string,
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const baseline = this.baselines.get(projectId);
    if (!baseline) {
      // The project was never linked on this server instance — the CLI must re-link (§3A.4).
      throw new Error(`unknown project ${projectId} — run \`arcane link\` first`);
    }
    const state: SessionState = {
      sessionId,
      projectId,
      appliedSeq: 0,
      manifest: new Map(baseline.manifest), // copy: a session's edits never mutate the baseline
      currentSnapshotId: parentSnapshotId,
      baseSnapshotId: baseline.baseSnapshotId,
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
  }
}
