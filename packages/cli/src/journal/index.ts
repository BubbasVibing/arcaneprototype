import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangeEventSchema, type AckEvent, type ChangeEvent } from "@arcane/shared";

// The append-only offline journal (Technical-Spec §3.1 / §3A.3) and the single SEQ authority. The
// CLI keeps each ChangeEvent until an AckEvent covers its seq, then drops it; on reconnect it
// replays the unacked tail (duplicates absorbed by the server's eventId/seq dedup). Lives under
// `.arcane/journal/<sessionId>.*` so it survives a CLI restart (Gate 1): on construction it re-reads
// the ndjson to repopulate the unacked set AND to resume `seq` from the high-water mark — never
// resetting to 1, which would collide new events with already-applied seqs (silent drift).
//
// `seq` is allocated HERE (one authority) so both the collector and a manifest resync draw from the
// same monotonic counter (no two producers, no collision).

interface JournalState {
  ackSeq: number; // highest seq the server has acked (drop watermark)
  parentSnapshot: string; // last acked serverSnapshotId — what the next event applies onto
}

export class Journal {
  private readonly ndjsonPath: string;
  private readonly statePath: string;
  private readonly unacked = new Map<number, ChangeEvent>();
  private state: JournalState;
  private seqCounter: number; // next seq to hand out

  constructor(root: string, sessionId: string, baseSnapshotId: string) {
    const dir = join(root, ".arcane", "journal");
    mkdirSync(dir, { recursive: true });
    this.ndjsonPath = join(dir, `${sessionId}.ndjson`);
    this.statePath = join(dir, `${sessionId}.state.json`);
    this.state = this.loadState(baseSnapshotId);
    this.seqCounter = this.replayFromDisk() + 1; // resume from the high-water mark (Gate 1)
  }

  get parentSnapshot(): string {
    return this.state.parentSnapshot;
  }

  get ackSeq(): number {
    return this.state.ackSeq;
  }

  get nextSeq(): number {
    return this.seqCounter;
  }

  depth(): number {
    return this.unacked.size;
  }

  has(seq: number): boolean {
    return this.unacked.has(seq);
  }

  // The single monotonic seq source (§3A.3 — assigned synchronously at commit, no await before the
  // event is emitted, so emission order == seq order).
  allocSeq(): number {
    return this.seqCounter++;
  }

  // Realign the counter after a manifest resync re-numbers from the server's applied high-water.
  resetSeqTo(seq: number): void {
    this.seqCounter = seq;
  }

  // Record an event as it is sent — kept until an ack covers its seq.
  append(event: ChangeEvent): void {
    if (event.seq <= this.state.ackSeq) return; // already acked — nothing to journal
    this.unacked.set(event.seq, event);
    if (event.seq >= this.seqCounter) this.seqCounter = event.seq + 1;
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

  // The unacked tail in seq order, from `fromSeq` onward — what reconnect/resync replays.
  replayUnacked(fromSeq = this.state.ackSeq + 1): ChangeEvent[] {
    return [...this.unacked.values()]
      .filter((e) => e.seq >= fromSeq)
      .sort((a, b) => a.seq - b.seq);
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

  // Re-read the append-only log into the unacked set and return the highest seq ever written, so a
  // restarted CLI resumes the same seq line and replays exactly the unacked tail.
  private replayFromDisk(): number {
    let highWater = this.state.ackSeq;
    if (!existsSync(this.ndjsonPath)) return highWater;
    for (const line of readFileSync(this.ndjsonPath, "utf8").split("\n")) {
      if (!line) continue;
      let event: ChangeEvent;
      try {
        event = ChangeEventSchema.parse(JSON.parse(line));
      } catch {
        continue; // skip a torn/partial trailing line
      }
      if (event.seq > highWater) highWater = event.seq;
      if (event.seq > this.state.ackSeq) this.unacked.set(event.seq, event);
    }
    return highWater;
  }

  private persistState(): void {
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
