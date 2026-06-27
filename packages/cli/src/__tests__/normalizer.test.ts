import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashBuffer, initHasher } from "../collector/hash";
import { Normalizer } from "../collector/normalizer";
import type { FileContent, LogicalChange } from "../collector/types";

// Deterministic unit tests for the §3A.3 correctness machinery: fake timers drive the hold
// window `W`; an in-memory filesystem backs readContent. No real I/O, no wall-clock flake.

const W = 150;
const MAXWAIT = 600;

beforeAll(async () => {
  await initHasher();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Emitted = LogicalChange & { seq: number };

function setup() {
  const files = new Map<string, string>();
  const emitted: Emitted[] = [];
  const readContent = async (p: string): Promise<FileContent> => {
    const c = files.get(p);
    if (c === undefined) {
      const e: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
      e.code = "ENOENT";
      throw e;
    }
    const buf = Buffer.from(c, "utf8");
    return { hash: hashBuffer(buf), size: buf.length, encoding: "utf8", content: c };
  };
  const norm = new Normalizer({
    readContent,
    onChange: (change, seq) => emitted.push({ ...change, seq }),
    now: () => Date.now(),
    window: W,
    maxWait: MAXWAIT,
  });
  return { files, emitted, norm };
}

// Create a known/committed file and clear the emission log, so each test starts from a baseline.
async function seed(files: Map<string, string>, emitted: Emitted[], norm: Normalizer, path: string, content: string) {
  files.set(path, content);
  norm.handle({ type: "add", path });
  await vi.advanceTimersByTimeAsync(W + 5);
  emitted.length = 0;
}

describe("collector normalizer — §3A.3 correctness", () => {
  it("emits one add for a new file", async () => {
    const { files, emitted, norm } = setup();
    files.set("a.ts", "v1");
    norm.handle({ type: "add", path: "a.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "add", path: "a.ts", seq: 1, content: "v1" });
    expect(emitted[0]?.contentHash).toBeTruthy();
  });

  it("coalesces a burst into one change with the final content (last-write-wins, no drop)", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "v0");
    for (const v of ["v1", "v2", "v3", "v4", "v5"]) {
      files.set("a.ts", v);
      norm.handle({ type: "change", path: "a.ts" });
      await vi.advanceTimersByTimeAsync(20); // < W: keeps the window sliding
    }
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "change", path: "a.ts", content: "v5" });
  });

  it("flushes a continuous writer at maxWait without dropping the final state", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "v0");
    // Write every 50 ms for well past maxWait; the window would slide forever but maxWait forces a flush.
    for (let i = 1; i <= 20; i++) {
      files.set("a.ts", `v${i}`);
      norm.handle({ type: "change", path: "a.ts" });
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.at(-1)).toMatchObject({ op: "change", path: "a.ts", content: "v20" });
  });

  it("coalesces write-temp-then-rename over an existing file into one change, suppressing the temp", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "v0");
    files.set("a.ts.tmp", "v1");
    norm.handle({ type: "add", path: "a.ts.tmp" });
    // rename a.ts.tmp -> a.ts (unlink temp + add over the known file, same new bytes)
    files.delete("a.ts.tmp");
    files.set("a.ts", "v1");
    norm.handle({ type: "unlink", path: "a.ts.tmp" });
    norm.handle({ type: "add", path: "a.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "change", path: "a.ts", content: "v1" });
    expect(emitted.some((e) => e.path === "a.ts.tmp")).toBe(false);
  });

  it("creates a brand-new file via temp-then-rename as one add of the final path", async () => {
    const { files, emitted, norm } = setup();
    files.set("new.ts.tmp", "hello");
    norm.handle({ type: "add", path: "new.ts.tmp" });
    files.delete("new.ts.tmp");
    files.set("new.ts", "hello");
    norm.handle({ type: "unlink", path: "new.ts.tmp" });
    norm.handle({ type: "add", path: "new.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "add", path: "new.ts" });
    expect(emitted.some((e) => e.path === "new.ts.tmp")).toBe(false);
  });

  it("detects a rename as one event carrying oldPath (add arrives after unlink)", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "hello-world");
    files.delete("a.ts");
    files.set("b.ts", "hello-world");
    norm.handle({ type: "unlink", path: "a.ts" });
    norm.handle({ type: "add", path: "b.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "rename", path: "b.ts", oldPath: "a.ts" });
  });

  it("detects a rename when the add is observed before the unlink", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "payload");
    files.set("b.ts", "payload");
    norm.handle({ type: "add", path: "b.ts" }); // add first
    files.delete("a.ts");
    norm.handle({ type: "unlink", path: "a.ts" }); // then unlink
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "rename", path: "b.ts", oldPath: "a.ts" });
  });

  it("falls back to delete + add when a move also edits the content", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "original");
    files.delete("a.ts");
    files.set("b.ts", "edited-while-moving");
    norm.handle({ type: "unlink", path: "a.ts" });
    norm.handle({ type: "add", path: "b.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    const ops = emitted.map((e) => `${e.op}:${e.path}`).sort();
    expect(ops).toEqual(["add:b.ts", "delete:a.ts"]);
  });

  it("never coalesces a delete away (and carries no content)", async () => {
    const { files, emitted, norm } = setup();
    await seed(files, emitted, norm, "a.ts", "x");
    files.delete("a.ts");
    norm.handle({ type: "unlink", path: "a.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: "delete", path: "a.ts" });
    expect(emitted[0]?.content).toBeUndefined();
    expect(emitted[0]?.contentHash).toBeUndefined();
  });

  it("expands a directory delete into per-file deletes", async () => {
    const { files, emitted, norm } = setup();
    files.set("d/x.ts", "k1");
    files.set("d/y.ts", "k2");
    norm.handle({ type: "add", path: "d/x.ts" });
    norm.handle({ type: "add", path: "d/y.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    emitted.length = 0;
    files.delete("d/x.ts");
    files.delete("d/y.ts");
    norm.handle({ type: "unlinkDir", path: "d" });
    await vi.advanceTimersByTimeAsync(W + 5);
    const deleted = emitted.filter((e) => e.op === "delete").map((e) => e.path).sort();
    expect(deleted).toEqual(["d/x.ts", "d/y.ts"]);
  });

  it("collapses an add-then-delete within the window to nothing", async () => {
    const { files, emitted, norm } = setup();
    files.set("z", "tmp");
    norm.handle({ type: "add", path: "z" });
    files.delete("z");
    norm.handle({ type: "unlink", path: "z" });
    await vi.advanceTimersByTimeAsync(W + 5);
    expect(emitted).toHaveLength(0);
  });

  it("assigns strictly increasing, contiguous seq across a mixed sequence", async () => {
    const { files, emitted, norm } = setup();
    files.set("a.ts", "1");
    norm.handle({ type: "add", path: "a.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    files.set("a.ts", "2");
    norm.handle({ type: "change", path: "a.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    files.delete("a.ts");
    files.set("c.ts", "2"); // same bytes as a.ts → rename
    norm.handle({ type: "unlink", path: "a.ts" });
    norm.handle({ type: "add", path: "c.ts" });
    await vi.advanceTimersByTimeAsync(W + 5);
    const seqs = emitted.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(emitted.map((e) => e.op)).toEqual(["add", "change", "rename"]);
  });
});
