import { watch, type FSWatcher } from "chokidar";
import { makeIgnoreMatcher } from "./ignore";
import type { RawEvent } from "./types";

// The watcher is a RAW filesystem event source. chokidar's own coalescers (`atomic`,
// `awaitWriteFinish`) are deliberately OFF so the normalizer is the SINGLE coalescing +
// correlation authority and rename pairing keys off raw FS timing, not chokidar's emit timing
// (resolved post-review). §3A.1: ignoreInitial streams the delta; symlinks are not followed.

export interface WatcherHandle {
  close: () => Promise<void>;
}

const toPosix = (p: string): string => p.split("\\").join("/");

export function startWatcher(
  root: string,
  onEvent: (ev: RawEvent) => void,
  onReady?: () => void,
): WatcherHandle {
  const fsw: FSWatcher = watch(root, {
    cwd: root, // event paths arrive repo-relative
    ignoreInitial: true, // §3A.1: stream changes, not an add-storm of the existing tree
    followSymlinks: false, // §3A.1
    persistent: true,
    ignorePermissionErrors: true,
    alwaysStat: true, // we want stats.mode on add/change
    atomic: false, // normalizer owns same-path-rewrite collapse
    awaitWriteFinish: false, // normalizer owns write coalescing (read-at-flush)
    ignored: makeIgnoreMatcher(),
  });

  fsw.on("add", (p, stats) => onEvent({ type: "add", path: toPosix(p), mode: stats?.mode }));
  fsw.on("change", (p, stats) => onEvent({ type: "change", path: toPosix(p), mode: stats?.mode }));
  fsw.on("unlink", (p) => onEvent({ type: "unlink", path: toPosix(p) }));
  fsw.on("addDir", (p) => onEvent({ type: "addDir", path: toPosix(p) }));
  fsw.on("unlinkDir", (p) => onEvent({ type: "unlinkDir", path: toPosix(p) }));
  if (onReady) fsw.on("ready", onReady);

  return { close: () => fsw.close() };
}
