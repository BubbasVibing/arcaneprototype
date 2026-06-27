import type { ChangeEvent, ResultPhase } from "@arcane/shared";
import type { ConnState } from "../transport/ws-client";

// A tiny observable store bridging the (non-React) Collector + WsClient into the Ink tree via
// useSyncExternalStore. Re-render triggers (invariant §16.10 — render on streamed events):
//  • addEvent         — a new local ChangeEvent the collector committed (drives the change log)
//  • setPhase         — a new `state` ResultEvent from the cloud (drives the session pipeline stepper)
//  • setConn          — socket connection state.
//  • setJournalDepth  — count of unacked events still in the journal (drives the "unacked" badge).

export interface AppState {
  root: string;
  sessionId: string;
  events: ChangeEvent[];
  phase: ResultPhase | null;
  conn: ConnState;
  journalDepth: number; // unacked events buffered in the journal (§3A.3)
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
}
