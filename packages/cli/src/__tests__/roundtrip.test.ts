import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangeEventSchema, ResultEventSchema, type ChangeEvent } from "@arcane/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";

// Integration test: spin the REAL Bun stub on an ephemeral port, send one ChangeEvent, and assert
// the gateway streams an ORDERED `state` phase walk ending at `done` (M1A — the stub no longer
// returns a single finding). Makes the round-trip reproducible in CI instead of the manual
// two-terminal dance. Requires `bun` on PATH (a project requirement).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const cloudEntry = join(repoRoot, "services/cloud/src/index.ts");

let proc: ChildProcess;
let port = 0;

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
  proc = spawn("bun", ["run", cloudEntry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("cloud stub did not start within 10s")), 10_000);
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
});

it("streams an ordered `state` phase walk for one ChangeEvent over WebSocket", async () => {
  const event: ChangeEvent = ChangeEventSchema.parse({
    eventId: "00000000-0000-0000-0000-0000000000aa",
    sessionId: "00000000-0000-0000-0000-0000000000bb", // sessionId is .uuid() now (M1A)
    projectId: "it-project",
    parentSnapshotId: "it-snap",
    seq: 1,
    ts: Date.now(),
    op: "add",
    path: "src/it.ts",
    content: "export const it = 1;\n",
  });

  const phases = await new Promise<string[]>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const got: string[] = [];
    const t = setTimeout(() => rej(new Error("round-trip timed out")), 5_000);
    ws.on("open", () => ws.send(JSON.stringify(event)));
    ws.on("message", (data) => {
      const parsed = ResultEventSchema.parse(JSON.parse(data.toString()));
      if (parsed.kind === "state") {
        got.push(parsed.phase);
        if (parsed.phase === "done") {
          clearTimeout(t);
          ws.close();
          res(got);
        }
      }
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });

  // The stub walks the full session pipeline in order (§3B.1), ending at `done`.
  expect(phases).toEqual(["detected", "uploading", "queued", "analyzing", "results", "done"]);
});
