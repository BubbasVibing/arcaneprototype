import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ChangeEventSchema,
  applyResultEvent,
  emptyResultView,
  type ChangeEvent,
  type ResultEvent,
  type ResultView,
} from "@arcane/shared";
import { afterAll, beforeAll, expect, test } from "bun:test";

// D1 headless proof (plan M1D): the web fan-out + hydration data-plane, with NO browser. An ANON
// Supabase client subscribes to project:{id} postgres_changes on result_events, the real cloud is
// driven through one edit, and we assert the anon-reduced LIVE state == the analyzer output, then
// that a session-scoped hydration query reconstructs the same state. Uses the ANON key so it actually
// exercises the publication + RLS (a service-role client would pass while anon is silently blocked).
//
// GATED ON DATABASE_URL + SUPABASE_URL + SUPABASE_ANON_KEY (and migration 0003 applied). Otherwise it
// skips — LOUDLY (no silent skips of the load-bearing realtime proof).
const HAS_REALTIME = Boolean(
  process.env.DATABASE_URL && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY,
);
if (!HAS_REALTIME) {
  console.warn(
    "\n⚠️  realtime FAN-OUT PROOF SKIPPED — needs DATABASE_URL + SUPABASE_URL + SUPABASE_ANON_KEY (and migration 0003 applied).\n" +
      "    The anon Realtime fan-out + hydration proof (invariant 4) did NOT run.\n" +
      "    Run it: services/cloud/README.md → set the three vars in services/cloud/.env, then `bun test`.\n",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const cloudEntry = join(here, "..", "index.ts");
const DEV_TOKEN = "dev-stub-token";
const ANY_FILE = "src/escape.ts";
const ANY_SRC = "export const x: any = 1;\n"; // escape-hatch → a `types` finding

let proc: ChildProcess;
let port = 0;
let shadowRoot = "";
let anon: SupabaseClient;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => res(addr.port));
      else srv.close(() => rej(new Error("no free port")));
    });
  });
}

async function waitFor(pred: () => boolean, label: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const http = () => `http://127.0.0.1:${port}`;
const reduce = (events: ResultEvent[]): ResultView => events.reduce(applyResultEvent, emptyResultView());

beforeAll(async () => {
  if (!HAS_REALTIME) return;
  port = await freePort();
  shadowRoot = join(process.env.TMPDIR ?? "/tmp", `arcane-rt-${randomUUID()}`);
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
  anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
}, 20_000);

afterAll(async () => {
  if (anon) await anon.removeAllChannels();
  proc?.kill();
});

test.skipIf(!HAS_REALTIME)(
  "fan-out: anon Realtime mirrors the analyzed frame, and session-scoped hydration reconstructs it",
  async () => {
    // 1. session: link an empty baseline (token-gated REST).
    const token = (
      (await (await fetch(`${http()}/auth/token`, { method: "POST" })).json()) as { token: string }
    ).token;
    expect(token).toBe(DEV_TOKEN);
    const link = (await (
      await fetch(`${http()}/link`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ files: [] }),
      })
    ).json()) as { projectId: string; baseSnapshotId: string };

    // 2. SUBSCRIBE FIRST (anon, postgres_changes) — buffer every result_events row for this project.
    const live: { seq: number; ev: ResultEvent }[] = [];
    let subscribed = false;
    anon
      .channel(`project:${link.projectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "result_events",
          filter: `project_id=eq.${link.projectId}`,
        },
        (payload) => {
          const row = payload.new as { seq: number | string; payload: ResultEvent };
          live.push({ seq: Number(row.seq), ev: row.payload });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") subscribed = true;
      });
    await waitFor(() => subscribed, "anon channel SUBSCRIBED");

    // 3. stream ONE edit that introduces a finding (`any` → escape-hatch → `types`).
    const sessionId = randomUUID();
    const event: ChangeEvent = ChangeEventSchema.parse({
      eventId: randomUUID(),
      sessionId,
      projectId: link.projectId,
      parentSnapshotId: link.baseSnapshotId,
      seq: 1,
      ts: Date.now(),
      op: "add",
      path: ANY_FILE,
      contentHash: "deadbeefdeadbeef",
      sizeBytes: ANY_SRC.length,
      encoding: "utf8",
      content: ANY_SRC,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest?token=${token}`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ingest ws error"));
    });
    ws.send(JSON.stringify(event));

    // 4. the browser sees a frame land atomically (ends with state `done`). Reduce by seq → LIVE view.
    await waitFor(
      () => live.some((r) => r.ev.kind === "state" && r.ev.phase === "done"),
      "anon received the analyzed frame",
    );
    ws.close();
    const liveView = reduce([...live].sort((a, b) => a.seq - b.seq).map((r) => r.ev));

    // The analyzed frame mirrors to the browser: a `types` finding (the `any`) + a `types` score < 100.
    expect(liveView.findings.some((f) => f.dimension === "types" && f.file === ANY_FILE)).toBe(true);
    const typesScore = liveView.scores.find((s) => s.dimension === "types");
    expect(typesScore).toBeDefined();
    expect(typesScore!.value).toBeLessThan(100);

    // 5. HYDRATION (anon SELECT under RLS): latest session → its latest `analyzing` boundary → replay.
    const { data: latest } = await anon
      .from("result_events")
      .select("session_id")
      .eq("project_id", link.projectId)
      .order("seq", { ascending: false })
      .limit(1);
    const S = (latest as { session_id: string }[])[0]!.session_id;
    const { data: sessionRows } = await anon
      .from("result_events")
      .select("seq, kind, payload")
      .eq("project_id", link.projectId)
      .eq("session_id", S)
      .order("seq", { ascending: true });
    const rows = (sessionRows as { seq: number; kind: string; payload: ResultEvent }[]) ?? [];
    // Boundary = the latest `analyzing` row (its frame-minimum seq); replay from there.
    let boundary = 0;
    for (const r of rows) if (r.kind === "state" && r.payload.kind === "state" && r.payload.phase === "analyzing") boundary = r.seq;
    const hydratedView = reduce(rows.filter((r) => r.seq >= boundary).map((r) => r.payload));

    // Hydration reconstructs the SAME current state as the live stream — no partial, no dupes.
    expect(hydratedView.findings).toEqual(liveView.findings);
    expect(hydratedView.scores).toEqual(liveView.scores);
  },
  30_000,
);
