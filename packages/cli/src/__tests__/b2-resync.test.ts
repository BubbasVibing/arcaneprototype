import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeEventSchema, type AckEvent, type ChangeEvent } from "@arcane/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { initHasher, readFileContent } from "../collector/hash";
import { Journal } from "../journal";
import { link } from "../link";
import { manifestResync } from "../resync";
import type { LinkInfo } from "../session";
import { WsClient } from "../transport/ws-client";

// B2 proof: the failure-mode hardening. Spins the REAL Bun gateway and drives the REAL CLI journal +
// ws-client + resync through disconnect/restart (Gate 1: kill+restart → resync, no drift), forced
// seq-gap (Gate 2: gap → resyncFrom → recovery), duplicate no-op, and the manifest-resync fallback.
// Assertions verify by RE-HASHING both manifests — drift can hide behind a matching ackSeq.

// GATED ON DATABASE_URL (M1C): the cloud now fails fast without Postgres (plan D3), so this
// full-stack resync test only runs when DATABASE_URL points at a MIGRATED database; otherwise it
// skips. The resync/ack logic it guards is unchanged from M1B — analysis just rides alongside it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cloudEntry = join(repoRoot, "services/cloud/src/index.ts");
const HAS_DB = Boolean(process.env.DATABASE_URL);

let proc: ChildProcess;
let port = 0;
let shadowRoot = "";
let token = "";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => res(p));
      } else {
        srv.close(() => rej(new Error("no free port")));
      }
    });
  });
}

const httpBase = (): string => `http://127.0.0.1:${port}`;
const ingestUrl = (): string => `ws://127.0.0.1:${port}/ingest?token=${token}`;

async function waitFor(pred: () => boolean, label: string, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function buildEvent(
  fixture: string,
  info: LinkInfo,
  seq: number,
  op: ChangeEvent["op"],
  path: string,
  parentSnapshotId: string,
): Promise<ChangeEvent> {
  const base = {
    eventId: randomUUID(),
    sessionId: info.sessionId,
    projectId: info.projectId,
    parentSnapshotId,
    seq,
    ts: Date.now(),
    op,
    path,
  };
  if (op === "delete") return ChangeEventSchema.parse(base);
  const fc = await readFileContent(join(fixture, path));
  return ChangeEventSchema.parse({
    ...base,
    contentHash: fc.hash,
    sizeBytes: fc.size,
    encoding: fc.encoding,
    ...(fc.content !== undefined ? { content: fc.content } : {}),
  });
}

// The server's shadow manifest for a session (via the debug endpoint).
async function serverManifest(sessionId: string): Promise<Record<string, string>> {
  const r = await fetch(`${httpBase()}/debug/session?sessionId=${sessionId}`);
  return ((await r.json()) as { files: Record<string, string> }).files;
}

// A fresh re-hash of the fixture on disk (the no-drift ground truth).
async function diskManifest(fixture: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of paths) out[p] = (await readFileContent(join(fixture, p))).hash;
  return out;
}

async function setupProject(): Promise<{ fixture: string; info: LinkInfo }> {
  const fixture = mkdtempSync(join(tmpdir(), "arcane-b2-"));
  writeFileSync(join(fixture, "a.txt"), "alpha\n");
  const info = await link(fixture, httpBase(), token);
  return { fixture, info };
}

beforeAll(async () => {
  if (!HAS_DB) return; // skipped suite — don't spawn the cloud
  port = await freePort();
  shadowRoot = mkdtempSync(join(tmpdir(), "arcane-b2-shadow-"));
  proc = spawn("bun", ["run", cloudEntry], {
    env: { ...process.env, PORT: String(port), ARCANE_SHADOW_ROOT: shadowRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("cloud did not start within 10s")), 10_000);
    proc.stdout?.on("data", (b: Buffer) => {
      if (b.toString().includes("listening")) {
        clearTimeout(t);
        res();
      }
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });
  await initHasher();
  token = ((await (await fetch(`${httpBase()}/auth/token`, { method: "POST" })).json()) as {
    token: string;
  }).token;
}, 15_000);

afterAll(() => {
  proc?.kill();
  if (shadowRoot) rmSync(shadowRoot, { recursive: true, force: true });
});

it.skipIf(!HAS_DB)("Gate 1: disconnect → kill+restart CLI (durable seq) → reconnect-replay, no drift", async () => {
  const { fixture, info } = await setupProject();

  // Old CLI process: stream seq 1,2 and drain.
  const j1 = new Journal(fixture, info.sessionId, info.baseSnapshotId);
  const ws1 = new WsClient({
    url: ingestUrl(),
    onResult: () => {},
    onAck: (a) => j1.onAck(a),
    onOpen: () => {
      for (const ev of j1.replayUnacked()) ws1.send(ev);
    },
  });
  ws1.connect();
  writeFileSync(join(fixture, "b.txt"), "beta\n");
  writeFileSync(join(fixture, "c.txt"), "gamma\n");
  for (const [op, path] of [["add", "b.txt"], ["add", "c.txt"]] as const) {
    const ev = await buildEvent(fixture, info, j1.allocSeq(), op, path, j1.parentSnapshot);
    j1.append(ev);
    ws1.send(ev);
  }
  await waitFor(() => j1.depth() === 0, "j1 drains");
  expect(j1.ackSeq).toBe(2);

  // Disconnect (server stays up); edit OFFLINE → events buffered in the journal on disk.
  ws1.close();
  writeFileSync(join(fixture, "d.txt"), "delta\n");
  writeFileSync(join(fixture, "e.txt"), "epsilon\n");
  for (const [op, path] of [["add", "d.txt"], ["add", "e.txt"]] as const) {
    const ev = await buildEvent(fixture, info, j1.allocSeq(), op, path, j1.parentSnapshot);
    j1.append(ev);
    ws1.send(ev); // dropped on the wire (closed) — retained in the journal
  }

  // KILL + RESTART the CLI process: a fresh Journal re-reads the on-disk log.
  const j2 = new Journal(fixture, info.sessionId, info.baseSnapshotId);
  expect(j2.depth()).toBe(2); // seq 3,4 recovered from disk
  expect(j2.ackSeq).toBe(2);
  expect(j2.nextSeq).toBe(5); // resumes from the high-water mark (4) — NOT reset to 1

  // Reconnect: replay the unacked tail → server applies → drains.
  const ws2 = new WsClient({
    url: ingestUrl(),
    onResult: () => {},
    onAck: (a) => j2.onAck(a),
    onOpen: () => {
      for (const ev of j2.replayUnacked()) ws2.send(ev);
    },
  });
  ws2.connect();
  await waitFor(() => j2.depth() === 0, "j2 drains after restart");
  expect(j2.ackSeq).toBe(4);
  ws2.close();

  // No drift: re-hash both manifests.
  const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
  expect(await serverManifest(info.sessionId)).toEqual(await diskManifest(fixture, paths));
  rmSync(fixture, { recursive: true, force: true });
});

it.skipIf(!HAS_DB)("Gate 2: forced seq-gap → resyncFrom → journal replay recovers; duplicate is a no-op", async () => {
  const { fixture, info } = await setupProject();
  const j = new Journal(fixture, info.sessionId, info.baseSnapshotId);
  const acks: AckEvent[] = [];
  let ws!: WsClient;
  ws = new WsClient({
    url: ingestUrl(),
    onResult: () => {},
    onOpen: () => {
      for (const ev of j.replayUnacked()) ws.send(ev);
    },
    onAck: (ack) => {
      acks.push(ack);
      j.onAck(ack);
      if (ack.resyncFrom !== undefined && j.has(ack.resyncFrom)) {
        for (const ev of j.replayUnacked(ack.resyncFrom)) ws.send(ev);
      }
    },
  });
  ws.connect();

  // seq 1 applied normally.
  writeFileSync(join(fixture, "b.txt"), "beta\n");
  const ev1 = await buildEvent(fixture, info, j.allocSeq(), "add", "b.txt", j.parentSnapshot);
  j.append(ev1);
  ws.send(ev1);
  await waitFor(() => j.ackSeq === 1, "seq 1 acked");

  // Force a GAP: build seq 2 + 3, journal BOTH, but send only seq 3 (withhold seq 2).
  writeFileSync(join(fixture, "c.txt"), "gamma\n");
  writeFileSync(join(fixture, "d.txt"), "delta\n");
  const ev2 = await buildEvent(fixture, info, j.allocSeq(), "add", "c.txt", j.parentSnapshot);
  const ev3 = await buildEvent(fixture, info, j.allocSeq(), "add", "d.txt", j.parentSnapshot);
  j.append(ev2);
  j.append(ev3);
  ws.send(ev3); // seq 3 with seq 2 missing → server replies resyncFrom: 2

  // The resyncFrom replay (in onAck) re-sends 2 then 3 → both applied → journal drains.
  await waitFor(() => j.depth() === 0, "gap recovered via resync");
  expect(j.ackSeq).toBe(3);
  expect(acks.some((a) => a.resyncFrom === 2)).toBe(true); // Gate 2: server requested the resync

  // Duplicate: re-send an already-applied event → server no-op re-acks at the same high-water.
  const before = acks.length;
  ws.send(ev1);
  await waitFor(() => acks.length > before, "duplicate re-acked");
  const dup = acks.at(-1);
  expect(dup?.ackSeq).toBe(3);
  expect(j.depth()).toBe(0);

  ws.close();
  expect(await serverManifest(info.sessionId)).toEqual(
    await diskManifest(fixture, ["a.txt", "b.txt", "c.txt", "d.txt"]),
  );
  rmSync(fixture, { recursive: true, force: true });
});

it.skipIf(!HAS_DB)("manifest resync: when the journal can't replay, diff the server manifest vs disk and re-emit", async () => {
  const { fixture, info } = await setupProject();
  const j = new Journal(fixture, info.sessionId, info.baseSnapshotId);
  let ws!: WsClient;
  ws = new WsClient({
    url: ingestUrl(),
    onResult: () => {},
    onAck: (a) => j.onAck(a),
    onOpen: () => {
      for (const ev of j.replayUnacked()) ws.send(ev);
    },
  });
  ws.connect();

  // Apply seq 1 and drain — the journal drops it (so it can no longer replay seq 1's neighborhood).
  writeFileSync(join(fixture, "b.txt"), "beta\n");
  const ev1 = await buildEvent(fixture, info, j.allocSeq(), "add", "b.txt", j.parentSnapshot);
  j.append(ev1);
  ws.send(ev1);
  await waitFor(() => j.depth() === 0, "seq 1 drained");

  // Diverge disk from the server WITHOUT streaming (the events the journal "lost"): edit a.txt, add c.txt.
  writeFileSync(join(fixture, "a.txt"), "alpha-edited\n");
  writeFileSync(join(fixture, "c.txt"), "gamma\n");

  // Manifest resync reconciles: fetch the server manifest, diff vs disk, re-emit the delta.
  const emitted = await manifestResync(fixture, httpBase(), token, info, j, (ev) => ws.send(ev));
  expect(emitted).toBe(2); // change a.txt + add c.txt
  await waitFor(() => j.depth() === 0, "manifest-resync deltas acked");

  ws.close();
  expect(await serverManifest(info.sessionId)).toEqual(
    await diskManifest(fixture, ["a.txt", "b.txt", "c.txt"]),
  );
  rmSync(fixture, { recursive: true, force: true });
});
