import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Collector } from "../collector";
import type { LogicalChange } from "../collector/types";

// Real-filesystem proof of the collector against REAL chokidar (not synthetic events): run the
// §3A.3 proof-table edit burst against a temp dir and assert the ordered ChangeEvents. This is the
// automated form of the manual two-terminal demo for the collector half of M1A.

type Emitted = LogicalChange & { seq: number };

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, label: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${label}`);
    await delay(25);
  }
}

let dir: string;
let collector: Collector;
let events: Emitted[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "arcane-collector-"));
  events = [];
  let ready!: () => void;
  const readyP = new Promise<void>((res) => {
    ready = res;
  });
  collector = new Collector({
    root: dir,
    window: 150,
    maxWait: 600,
    onChange: (change, seq) => events.push({ ...change, seq }),
    onReady: () => ready(),
  });
  await collector.start();
  await readyP; // wait out chokidar's initial scan so the burst is the only source of events
});

afterEach(async () => {
  await collector.stop();
  rmSync(dir, { recursive: true, force: true });
});

const find = (op: string, path: string): Emitted | undefined =>
  events.find((e) => e.op === op && e.path === path);

const findLast = (op: string, path: string): Emitted | undefined =>
  [...events].reverse().find((e) => e.op === op && e.path === path);

it("captures an ordered add → change → rename → delete burst against the real filesystem", async () => {
  // 1) create a.ts → one add
  writeFileSync(join(dir, "a.ts"), "v1");
  await waitFor(() => !!find("add", "a.ts"), "add a.ts");

  // 2) rapid burst → coalesce to one change with the FINAL content (never drop the final state)
  for (const v of ["v2", "v3", "v4", "v5", "v6"]) writeFileSync(join(dir, "a.ts"), v);
  await waitFor(() => !!find("change", "a.ts"), "change a.ts");
  await delay(250); // settle
  expect(find("change", "a.ts")?.content).toBe("v6");

  // 3) write-temp-then-rename over the existing file → one change, temp never surfaces.
  // NOTE: this is a SECOND `change a.ts`, distinct from step 2's — the >W settle above means the
  // file went quiet and step 2 committed, so two settled edits = two changes (intended; the
  // collector coalesces a burst, not two separate user actions). Hence findLast, not find.
  const beforeTmp = events.length;
  writeFileSync(join(dir, "a.ts.tmp"), "v7");
  renameSync(join(dir, "a.ts.tmp"), join(dir, "a.ts"));
  await waitFor(() => events.length > beforeTmp, "atomic write of a.ts");
  await delay(250);
  expect(events.some((e) => e.path === "a.ts.tmp" || e.oldPath === "a.ts.tmp")).toBe(false);
  expect(findLast("change", "a.ts")?.content).toBe("v7"); // latest a.ts state is the temp's bytes

  // 4) rename a.ts → b.ts (content unchanged) → one rename carrying oldPath
  renameSync(join(dir, "a.ts"), join(dir, "b.ts"));
  await waitFor(() => !!find("rename", "b.ts"), "rename b.ts");
  await delay(150);
  expect(find("rename", "b.ts")?.oldPath).toBe("a.ts");

  // 5) delete b.ts → one delete, no content/contentHash, never coalesced away
  rmSync(join(dir, "b.ts"));
  await waitFor(() => !!find("delete", "b.ts"), "delete b.ts");
  const del = find("delete", "b.ts");
  expect(del?.content).toBeUndefined();
  expect(del?.contentHash).toBeUndefined();

  // seq is strictly increasing and contiguous in emission order (§3A.3)
  const seqs = events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
}, 30_000);

it("expands a directory delete into per-file deletes", async () => {
  mkdirSync(join(dir, "d"));
  writeFileSync(join(dir, "d", "x.ts"), "x");
  writeFileSync(join(dir, "d", "y.ts"), "y");
  await waitFor(() => !!find("add", "d/x.ts") && !!find("add", "d/y.ts"), "adds under d/");
  await delay(200);

  rmSync(join(dir, "d"), { recursive: true, force: true });
  await waitFor(() => !!find("delete", "d/x.ts") && !!find("delete", "d/y.ts"), "per-file deletes");
  expect(find("delete", "d/x.ts")).toBeTruthy();
  expect(find("delete", "d/y.ts")).toBeTruthy();
}, 30_000);
