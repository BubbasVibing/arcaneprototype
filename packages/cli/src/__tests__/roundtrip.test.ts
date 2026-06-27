import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AckEventSchema,
  ChangeEventSchema,
  ResultEventSchema,
  type AckEvent,
  type ChangeEvent,
} from "@arcane/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import { initHasher, readFileContent } from "../collector/hash";
import { Journal } from "../journal";
import { link } from "../link";
import { WsClient } from "../transport/ws-client";

// Integration test (M1B): spin the REAL Bun gateway on an ephemeral port and drive the full ingest
// round-trip — POST /auth/token → POST /link → WS /ingest one ChangeEvent — asserting the server
// APPLIES it to the shadow worktree, ACKs the contiguous seq, and still echoes the `state` phase
// walk. This is the automated form of the B1 happy-path proof. Requires `bun` on PATH.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cloudEntry = join(repoRoot, "services/cloud/src/index.ts");
const DEV_TOKEN = "dev-stub-token";

let proc: ChildProcess;
let port = 0;
let shadowRoot = "";

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
        srv.close(() => rej(new Error("could not acquire a free port")));
      }
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  shadowRoot = mkdtempSync(join(tmpdir(), "arcane-shadow-"));
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
}, 15_000);

afterAll(() => {
  proc?.kill();
  if (shadowRoot) rmSync(shadowRoot, { recursive: true, force: true });
});

it("links, applies + acks one ChangeEvent, and echoes the state walk (M1B ingest)", async () => {
  const httpBase = `http://127.0.0.1:${port}`;

  // 1. STUB auth → dev token.
  const tokenRes = await fetch(`${httpBase}/auth/token`, { method: "POST" });
  const { token } = (await tokenRes.json()) as { token: string };
  expect(token).toBe(DEV_TOKEN);

  // 2. link an empty baseline → { projectId, baseSnapshotId }.
  const linkRes = await fetch(`${httpBase}/link`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ files: [] }),
  });
  expect(linkRes.status).toBe(200);
  const { projectId, baseSnapshotId } = (await linkRes.json()) as {
    projectId: string;
    baseSnapshotId: string;
  };

  // 3. stream one ChangeEvent over the authed /ingest channel.
  const sessionId = randomUUID();
  const eventId = randomUUID();
  const event: ChangeEvent = ChangeEventSchema.parse({
    eventId,
    sessionId,
    projectId,
    parentSnapshotId: baseSnapshotId,
    seq: 1,
    ts: Date.now(),
    op: "add",
    path: "src/it.ts",
    contentHash: "deadbeefdeadbeef",
    encoding: "utf8",
    content: "export const it = 1;\n",
  });

  const result = await new Promise<{ ack: AckEvent; phases: string[] }>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest?token=${token}`);
    const phases: string[] = [];
    let ack: AckEvent | undefined;
    const t = setTimeout(() => rej(new Error("round-trip timed out")), 5_000);
    const maybeDone = (): void => {
      if (ack && phases[phases.length - 1] === "done") {
        clearTimeout(t);
        ws.close();
        res({ ack, phases });
      }
    };
    ws.on("open", () => ws.send(JSON.stringify(event)));
    ws.on("message", (data) => {
      const payload = JSON.parse(data.toString());
      // Server → CLI carries BOTH AckEvent (has ackSeq, no kind) and ResultEvent (has kind).
      if ("ackSeq" in payload) {
        ack = AckEventSchema.parse(payload);
      } else {
        const ev = ResultEventSchema.parse(payload);
        if (ev.kind === "state") phases.push(ev.phase);
      }
      maybeDone();
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });

  // The contiguous seq is applied + acked, with the resulting shadow-worktree snapshot id.
  expect(result.ack.ackSeq).toBe(1);
  expect(result.ack.acceptedEventIds).toContain(eventId);
  expect(result.ack.serverSnapshotId).toMatch(/^[0-9a-f-]{36}$/);
  // The pipeline walk still streams in order, ending at `done` (§3B.1).
  expect(result.phases).toEqual(["detected", "uploading", "queued", "analyzing", "results", "done"]);

  // The server applied the op to its shadow worktree (no drift): the manifest holds the file's hash.
  const dbg = await fetch(`${httpBase}/debug/session?sessionId=${sessionId}`);
  const state = (await dbg.json()) as { appliedSeq: number; files: Record<string, string> };
  expect(state.appliedSeq).toBe(1);
  expect(state.files["src/it.ts"]).toBe("deadbeefdeadbeef");
});

it("drives the real CLI journal + WsClient: acks drain the journal and the shadow matches (no drift)", async () => {
  const httpBase = `http://127.0.0.1:${port}`;
  await initHasher();

  // login + link a temp fixture with one baseline file (uses the REAL CLI `link`).
  const token = (
    (await (await fetch(`${httpBase}/auth/token`, { method: "POST" })).json()) as { token: string }
  ).token;
  const fixture = mkdtempSync(join(tmpdir(), "arcane-fix-"));
  writeFileSync(join(fixture, "a.txt"), "alpha\n");
  const info = await link(fixture, httpBase, token);

  const journal = new Journal(fixture, info.sessionId, info.baseSnapshotId);
  const ws = new WsClient({
    url: `ws://127.0.0.1:${port}/ingest?token=${token}`,
    onResult: () => {},
    onAck: (ack) => journal.onAck(ack),
  });
  ws.connect();

  // Mutate the fixture, then stream the changes the way `watch` does (envelope on the journal's
  // current parent snapshot, journal-then-send), with real CLI-computed content hashes.
  writeFileSync(join(fixture, "b.txt"), "beta\n");
  writeFileSync(join(fixture, "c.txt"), "gamma\n");
  writeFileSync(join(fixture, "a.txt"), "alpha-edited\n");

  const plan: Array<[number, "add" | "change", string]> = [
    [1, "add", "b.txt"],
    [2, "add", "c.txt"],
    [3, "change", "a.txt"],
  ];
  for (const [seq, op, path] of plan) {
    const fc = await readFileContent(join(fixture, path));
    const ev: ChangeEvent = ChangeEventSchema.parse({
      eventId: randomUUID(),
      sessionId: info.sessionId,
      projectId: info.projectId,
      parentSnapshotId: journal.parentSnapshot,
      seq,
      ts: Date.now(),
      op,
      path,
      contentHash: fc.hash,
      sizeBytes: fc.size,
      encoding: fc.encoding,
      ...(fc.content !== undefined ? { content: fc.content } : {}),
    });
    journal.append(ev);
    ws.send(ev);
  }

  // Acks drive the journal to empty; the contiguous high-water reaches seq 3.
  await waitFor(() => journal.depth() === 0, 4_000);
  expect(journal.ackSeq).toBe(3);
  ws.close();

  // No drift: the server's shadow manifest equals a fresh re-hash of the fixture on disk.
  const server = (await (
    await fetch(`${httpBase}/debug/session?sessionId=${info.sessionId}`)
  ).json()) as { files: Record<string, string> };
  const disk: Record<string, string> = {};
  for (const p of ["a.txt", "b.txt", "c.txt"]) disk[p] = (await readFileContent(join(fixture, p))).hash;
  expect(server.files).toEqual(disk);

  rmSync(fixture, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for journal to drain");
    await new Promise((r) => setTimeout(r, 20));
  }
}
