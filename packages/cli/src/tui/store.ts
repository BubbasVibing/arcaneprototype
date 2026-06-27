import type { ChangeEvent, Finding, ResultPhase, Score } from "@arcane/shared";
import type { ConnState } from "../transport/ws-client";

// A tiny observable store bridging the (non-React) Collector + WsClient into the Ink tree via
// useSyncExternalStore. Re-render triggers (invariant §16.10 — render on streamed events):
//  • addEvent         — a new local ChangeEvent the collector committed (drives the change log)
//  • setPhase         — a new `state` ResultEvent from the cloud (drives the session pipeline stepper)
//  • upsertScore      — a `score` ResultEvent (M1C — drives the per-dimension score bars)
//  • addFinding       — a `finding` ResultEvent (M1C — drives the findings list)
//  • beginFrame       — the cloud's `analyzing` phase opens a new result frame (clears stale findings)
//  • setConn          — socket connection state.
//  • setJournalDepth  — count of unacked events still in the journal (drives the "unacked" badge).

// A Finding plus the cloud's is_new verdict for this snapshot (ResultEvent `finding`).
export type FindingRow = Finding & { isNew: boolean };

export interface AppState {
  root: string;
  sessionId: string;
  events: ChangeEvent[];
  phase: ResultPhase | null;
  conn: ConnState;
  journalDepth: number; // unacked events buffered in the journal (§3A.3)
  resync: boolean; // a reconnect/gap is being replayed (§3A.4)
  scores: Score[]; // latest per-dimension score (M1C) — replaced per dimension as `score` events arrive
  findings: FindingRow[]; // findings from the latest analysis frame (M1C)
  showScores: boolean; // `d` toggles the per-dimension score panel (§8)
}

export class Store {
  private state: AppState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  getSnapshot = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  addEvent(ev: ChangeEvent): void {
    this.state = { ...this.state, events: [...this.state.events, ev] };
    this.emit();
  }

  setPhase(phase: ResultPhase): void {
    this.state = { ...this.state, phase };
    this.emit();
  }

  setConn(conn: ConnState): void {
    this.state = { ...this.state, conn };
    this.emit();
  }

  setJournalDepth(journalDepth: number): void {
    if (journalDepth === this.state.journalDepth) return;
    this.state = { ...this.state, journalDepth };
    this.emit();
  }

  setResync(resync: boolean): void {
    if (resync === this.state.resync) return;
    this.state = { ...this.state, resync };
    this.emit();
  }

  // A new analysis frame (the cloud's `analyzing` phase): the upcoming `finding` events are the
  // COMPLETE current set for this snapshot, so clear the prior frame's findings before they arrive.
  // Scores are NOT cleared — each `score` event replaces its dimension in place via upsertScore.
  beginFrame(): void {
    this.state = { ...this.state, findings: [] };
    this.emit();
  }

  upsertScore(score: Score): void {
    const scores = [...this.state.scores.filter((s) => s.dimension !== score.dimension), score].sort(
      (a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0),
    );
    this.state = { ...this.state, scores };
    this.emit();
  }

  addFinding(finding: Finding, isNew: boolean): void {
    this.state = { ...this.state, findings: [...this.state.findings, { ...finding, isNew }] };
    this.emit();
  }

  toggleScores(): void {
    this.state = { ...this.state, showScores: !this.state.showScores };
    this.emit();
  }
}
