import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AckEvent, ChangeEvent } from "@arcane/shared";

// The append-only offline journal (Technical-Spec §3.1 / §3A.3): the CLI keeps each ChangeEvent
// until an AckEvent covers its seq, then drops it. Lives under `.arcane/journal/<sessionId>.*` so it
// survives a CLI restart (Gate 1). B1 implements append + drop-on-ack + depth; replaying unacked
// events on reconnect and resuming `nextSeq` from the high-water mark are B2.

interface JournalState {
  ackSeq: number; // highest seq the server has acked (drop watermark)
  parentSnapshot: string; // last acked serverSnapshotId — what the next event applies onto
}

export class Journal {
  private readonly ndjsonPath: string;
  private readonly statePath: string;
  private readonly unacked = new Map<number, ChangeEvent>();
  private state: JournalState;

  constructor(root: string, sessionId: string, baseSnapshotId: string) {
    const dir = join(root, ".arcane", "journal");
    mkdirSync(dir, { recursive: true });
    this.ndjsonPath = join(dir, `${sessionId}.ndjson`);
    this.statePath = join(dir, `${sessionId}.state.json`);
    this.state = this.loadState(baseSnapshotId);
  }

  get parentSnapshot(): string {
    return this.state.parentSnapshot;
  }

  get ackSeq(): number {
    return this.state.ackSeq;
  }

  depth(): number {
    return this.unacked.size;
  }

  // Record an event as it is sent — kept until an ack covers its seq.
  append(event: ChangeEvent): void {
    if (event.seq <= this.state.ackSeq) return; // already acked — nothing to journal
    this.unacked.set(event.seq, event);
    appendFileSync(this.ndjsonPath, `${JSON.stringify(event)}\n`);
  }

  // Drop everything the ack covers and advance the snapshot the next event applies onto (§3A.3).
  onAck(ack: AckEvent): void {
    for (const seq of [...this.unacked.keys()]) {
      if (seq <= ack.ackSeq) this.unacked.delete(seq);
    }
    this.state = { ackSeq: ack.ackSeq, parentSnapshot: ack.serverSnapshotId };
    this.persistState();
  }

  private loadState(baseSnapshotId: string): JournalState {
    if (existsSync(this.statePath)) {
      try {
        const s = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<JournalState>;
        if (typeof s.ackSeq === "number" && typeof s.parentSnapshot === "string") {
          return { ackSeq: s.ackSeq, parentSnapshot: s.parentSnapshot };
        }
      } catch {
        // corrupt state file — fall through to a fresh baseline
      }
    }
    return { ackSeq: 0, parentSnapshot: baseSnapshotId };
  }

  private persistState(): void {
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
