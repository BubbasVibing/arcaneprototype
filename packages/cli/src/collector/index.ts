import { join } from "node:path";
import { initHasher, readFileContent } from "./hash";
import { Normalizer } from "./normalizer";
import { startWatcher, type WatcherHandle } from "./watcher";
import type { LogicalChange } from "./types";

// The Collector wires the raw watcher → the normalization state machine, reading file content
// from disk at flush time. It NEVER analyzes or runs user code (invariant §16.1) — it only
// watches, normalizes, hashes, and hands ORDERED LogicalChanges (+ seq) to its consumer.

export type { LogicalChange } from "./types";

export interface CollectorOptions {
  root: string; // absolute path to the watched repo
  onChange: (change: LogicalChange, seq: number) => void;
  onReady?: () => void;
  window?: number; // W, default 150 ms
  maxWait?: number; // default 600 ms
  nextSeq?: () => number; // injected seq source (the journal, in `watch`) — see Normalizer (M1B B2)
}

export class Collector {
  private watcher: WatcherHandle | undefined;
  private readonly normalizer: Normalizer;

  constructor(private readonly opts: CollectorOptions) {
    this.normalizer = new Normalizer({
      readContent: (posixPath) => readFileContent(join(opts.root, posixPath)),
      onChange: opts.onChange,
      now: () => Date.now(),
      window: opts.window ?? 150,
      maxWait: opts.maxWait ?? 600,
      nextSeq: opts.nextSeq,
    });
  }

  async start(): Promise<void> {
    await initHasher(); // WASM ready before any file is hashed
    this.watcher = startWatcher(
      this.opts.root,
      (ev) => this.normalizer.handle(ev),
      this.opts.onReady,
    );
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.normalizer.dispose();
  }
}
