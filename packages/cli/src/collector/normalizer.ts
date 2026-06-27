import type { FileContent, FileMeta, LogicalChange, RawEvent } from "./types";

// The normalization state machine — the collector's correctness core (Technical-Spec §3A.3).
// It is the SINGLE coalescing + correlation authority: a per-path hold window `W` sits in front
// of a serialized commit, so a burst coalesces (last-write-wins, never drop the final state),
// temp-then-rename collapses to one change, renames pair by content fingerprint (no inode), and
// deletes are held briefly for pairing but NEVER coalesced away.
//
// Dependencies are injected so the §3A.3 guarantees are unit-testable with fake timers + an
// in-memory filesystem, with zero real I/O or wall-clock flake.

export interface NormalizerDeps {
  readContent: (posixPath: string) => Promise<FileContent>;
  onChange: (change: LogicalChange, seq: number) => void;
  now: () => number;
  window: number; // W — the hold/pairing window (~150 ms)
  maxWait: number; // cap so a continuous writer still flushes (never drops the final state)
  // The seq source. Injected so the journal can be the single durable seq authority (M1B B2 —
  // resumes across CLI restarts). Defaults to an internal counter from 1 (used by unit tests).
  nextSeq?: () => number;
}

interface PendingContent {
  path: string;
  firstTs: number;
  gen: number; // bumped on every new write; guards against committing stale bytes
  mode?: number;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingDelete {
  path: string;
  meta: FileMeta; // the deleted file's last-known fingerprint (for rename pairing)
  timer: ReturnType<typeof setTimeout>;
}

export class Normalizer {
  private readonly known = new Map<string, FileMeta>(); // last committed fingerprint per live path
  private readonly pending = new Map<string, PendingContent>();
  private readonly deletes = new Map<string, PendingDelete>();
  private fallbackSeq = 1; // used only when no seq source is injected (unit tests)
  private readonly allocSeq: () => number;
  private chain: Promise<void> = Promise.resolve(); // FIFO serialization of all commits
  private disposed = false;

  constructor(private readonly deps: NormalizerDeps) {
    this.allocSeq = deps.nextSeq ?? (() => this.fallbackSeq++);
  }

  handle(ev: RawEvent): void {
    if (this.disposed) return;
    switch (ev.type) {
      case "add":
      case "change":
        this.onContent(ev.path, ev.mode);
        break;
      case "unlink":
        this.onUnlink(ev.path);
        break;
      case "unlinkDir":
        this.onUnlinkDir(ev.path);
        break;
      case "addDir":
        break; // directories carry no content; their files arrive as their own adds
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.pending.values()) clearTimeout(e.timer);
    for (const d of this.deletes.values()) clearTimeout(d.timer);
    this.pending.clear();
    this.deletes.clear();
  }

  // --- raw event handlers (synchronous; they only mutate buffers + (re)arm timers) ---

  private onContent(path: string, mode?: number): void {
    // A same-path pending delete means an in-place rewrite (truncate / atomic), NOT a deletion.
    const del = this.deletes.get(path);
    if (del) {
      clearTimeout(del.timer);
      this.deletes.delete(path);
    }
    const now = this.deps.now();
    const existing = this.pending.get(path);
    if (existing) {
      existing.gen++;
      if (mode !== undefined) existing.mode = mode;
      clearTimeout(existing.timer);
      const elapsed = now - existing.firstTs;
      const delay = Math.min(this.deps.window, Math.max(0, this.deps.maxWait - elapsed));
      existing.timer = setTimeout(() => this.onContentTimer(path), delay);
    } else {
      const entry: PendingContent = {
        path,
        firstTs: now,
        gen: 0,
        mode,
        timer: setTimeout(() => this.onContentTimer(path), this.deps.window),
      };
      this.pending.set(path, entry);
    }
  }

  private onUnlink(path: string): void {
    const pendingContent = this.pending.get(path);
    if (pendingContent) {
      clearTimeout(pendingContent.timer);
      this.pending.delete(path);
      if (!this.known.has(path)) {
        // Pending was an ADD that never committed → add-then-delete collapse (emit nothing). §3A.3
        return;
      }
      // Pending was a CHANGE to a known file, now deleted → register the delete below.
    }
    this.registerDelete(path);
  }

  private registerDelete(path: string): void {
    const meta = this.known.get(path);
    // No fingerprint → an untracked / pre-existing file (ignoreInitial). With no baseline in M1A
    // there is nothing to delete server-side; M1B's snapshot seeds pre-existing files.
    if (!meta) return;
    if (this.deletes.has(path)) return;
    this.deletes.set(path, {
      path,
      meta,
      timer: setTimeout(() => this.onDeleteTimer(path), this.deps.window),
    });
  }

  private onUnlinkDir(dir: string): void {
    // §3A.1: directory deletes expand to per-file deletes.
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const affected = new Set<string>();
    for (const p of this.known.keys()) if (p.startsWith(prefix)) affected.add(p);
    for (const p of this.pending.keys()) if (p.startsWith(prefix)) affected.add(p);
    for (const p of affected) this.onUnlink(p);
  }

  // --- timers schedule the (serialized) resolvers ---

  private onContentTimer(path: string): void {
    this.schedule(() => this.resolveContent(path));
  }

  private onDeleteTimer(path: string): void {
    this.schedule(() => this.resolveDelete(path));
  }

  private schedule(fn: () => Promise<void>): void {
    // Serialize every commit through one promise chain. All async work (read + hash + pairing)
    // happens inside; `commit` then assigns seq + emits with NO further await, so emission order
    // == seq order (§3A.3). A single failing flush must never break the chain.
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      console.error("collector: flush error —", err);
    });
  }

  // --- resolvers (run one-at-a-time on the chain) ---

  private async resolveContent(path: string): Promise<void> {
    const entry = this.pending.get(path);
    if (!entry) return; // already resolved (e.g. paired by a delete flush)
    const gen = entry.gen;

    let fc: FileContent;
    try {
      fc = await this.deps.readContent(path);
    } catch {
      // Vanished between stabilize and read (ENOENT) — the delete path handles it.
      if (this.pending.get(path) === entry) this.pending.delete(path);
      return;
    }

    // A newer write landed during the read → abort; its timer will re-resolve with fresh bytes.
    const current = this.pending.get(path);
    if (!current || current !== entry || current.gen !== gen) return;
    this.pending.delete(path);

    const meta: FileMeta = { hash: fc.hash, size: fc.size };
    const isKnown = this.known.has(path);

    // Rename pairing only when the target path is NEW (op would be 'add'); an add to an
    // already-known path is always a 'change' (atomic-write / overwrite), never a rename target.
    if (!isKnown) {
      const match = this.findDeleteByMeta(meta);
      if (match) {
        clearTimeout(match.timer);
        this.deletes.delete(match.path);
        this.known.delete(match.path);
        this.known.set(path, meta);
        this.commit(renameChange(match.path, path, fc, entry.mode));
        return;
      }
    }

    this.known.set(path, meta);
    this.commit(contentChange(isKnown ? "change" : "add", path, fc, entry.mode));
  }

  private async resolveDelete(path: string): Promise<void> {
    const del = this.deletes.get(path);
    if (!del) return; // already resolved (paired by a content flush)

    // Pair from the delete side: a buffered add of byte-identical content is this file, moved.
    if (del.meta.size > 0) {
      const candidates = [...this.pending.values()].filter((e) => !this.known.has(e.path));
      for (const cand of candidates) {
        let fc: FileContent;
        try {
          fc = await this.deps.readContent(cand.path);
        } catch {
          continue;
        }
        if (!this.deletes.has(path)) return; // delete got resolved during the await
        if (this.pending.get(cand.path) !== cand) continue; // candidate changed during the await
        if (fc.size === del.meta.size && fc.hash === del.meta.hash) {
          clearTimeout(cand.timer);
          this.pending.delete(cand.path);
          this.deletes.delete(path);
          this.known.delete(path);
          this.known.set(cand.path, { hash: fc.hash, size: fc.size });
          this.commit(renameChange(path, cand.path, fc, cand.mode));
          return;
        }
      }
    }

    if (!this.deletes.has(path)) return;
    this.deletes.delete(path);
    this.known.delete(path);
    this.commit({ op: "delete", path }); // §3A.3: never coalesced away; no content/contentHash
  }

  private findDeleteByMeta(meta: FileMeta): PendingDelete | undefined {
    if (meta.size === 0) return undefined; // zero-byte files are too collision-prone to pair
    for (const del of this.deletes.values()) {
      if (del.meta.size === meta.size && del.meta.hash === meta.hash) return del;
    }
    return undefined;
  }

  private commit(change: LogicalChange): void {
    // §3A.3: seq is assigned HERE, at the commit point (post-coalesce/pairing), with NO await
    // between allocation and onChange → emission order == seq order. The allocator is the journal's
    // (single durable authority) in `watch`, or the internal fallback counter in unit tests.
    const seq = this.allocSeq();
    this.deps.onChange(change, seq);
  }
}

function contentChange(
  op: "add" | "change",
  path: string,
  fc: FileContent,
  mode: number | undefined,
): LogicalChange {
  const change: LogicalChange = {
    op,
    path,
    contentHash: fc.hash,
    sizeBytes: fc.size,
    encoding: fc.encoding,
  };
  if (fc.content !== undefined) change.content = fc.content;
  if (mode !== undefined) change.mode = mode;
  return change;
}

function renameChange(
  oldPath: string,
  path: string,
  fc: FileContent,
  mode: number | undefined,
): LogicalChange {
  const change: LogicalChange = {
    op: "rename",
    path,
    oldPath,
    contentHash: fc.hash,
    sizeBytes: fc.size,
    encoding: fc.encoding,
  };
  if (fc.content !== undefined) change.content = fc.content;
  if (mode !== undefined) change.mode = mode;
  return change;
}
