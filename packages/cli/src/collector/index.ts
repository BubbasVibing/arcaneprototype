import { join } from "node:path";
import { walkRepo } from "../repo-walk";
import { initHasher, readFileContent } from "./hash";
import { Normalizer } from "./normalizer";
import { startWatcher, type WatcherHandle } from "./watcher";
import type { FileMeta, LogicalChange } from "./types";

// The Collector wires the raw watcher → the normalization state machine, reading file content
// from disk at flush time. It NEVER analyzes or runs user code (invariant §16.1) — it only
// watches, normalizes, hashes, and hands ORDERED LogicalChanges (+ seq) to its consumer.

export type { LogicalChange } from "./types";

export interface CollectorOptions {
  root: string; // absolute path to the watched repo
  ignore: (testPath: string) => boolean; // the single shared ignore matcher (§3A.1, M2A)
  onChange: (change: LogicalChange, seq: number) => void;
  onReady?: () => void;
  window?: number; // W, default 150 ms
  maxWait?: number; // default 600 ms
  nextSeq?: () => number; // injected seq source (the journal, in `watch`) — see Normalizer (M1B B2)
  seed?: ReadonlyMap<string, FileMeta>; // baseline fingerprints so pre-existing deletes/renames fire
}

// Build the baseline fingerprint map (path → {hash,size}) by walking the repo with the SAME ignore
// matcher used everywhere else. Seeds the normalizer so a pre-existing file that's renamed/deleted
// without an edit this session is still recognized (no server drift — M2A). O(repo) scan at watch
// start, same cost as `link`'s walk.
export async function buildBaselineSeed(
  root: string,
  ignore: (testPath: string) => boolean,
): Promise<Map<string, FileMeta>> {
  await initHasher();
  const seed = new Map<string, FileMeta>();
  for (const path of await walkRepo(root, ignore)) {
    const fc = await readFileContent(join(root, path));
    seed.set(path, { hash: fc.hash, size: fc.size });
  }
  return seed;
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
      seed: opts.seed,
    });
  }

  async start(): Promise<void> {
    await initHasher(); // WASM ready before any file is hashed
    this.watcher = startWatcher(
      this.opts.root,
      this.opts.ignore,
      (ev) => this.normalizer.handle(ev),
      this.opts.onReady,
    );
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.normalizer.dispose();
  }
}
