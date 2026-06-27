// Arcane M3B — in-sandbox instrumentation probe (Node `--require` preload).
//
// RUNTIME NOTE: this file runs INSIDE the sandbox container (node:22-alpine), NOT in the Bun cloud.
// It is intentionally plain CommonJS (.cjs, no TypeScript, no deps) so it can be mounted read-only and
// `--require`d before user code with zero build step. It is excluded from the cloud `tsc` program
// (tsconfig has no allowJs). Injected via NODE_OPTIONS=--require /arcane/preload.cjs.
//
// SI-1 — THIS PROBE IS NEVER A CONTAINMENT BOUNDARY. It runs in the SAME process as hostile code and
// can be bypassed (a fresh require, a child process with NODE_OPTIONS stripped, a native addon, raw
// syscalls). It is TELEMETRY + record-replay CONVENIENCE only. Containment rests on the container alone
// (--network none, read-only rootfs, caps, watchdog). The escape suite proves containment with the
// probe ABSENT (escape.test.ts) AND with it PRESENT (probe-containment.test.ts). The network blocking
// below is defense-in-depth ON TOP of --network none, never a substitute for it.
//
// HONESTY (§21A / invariant 7): every outbound call is recorded as `blocked` or `recorded` — NEVER
// silently allowed. DEGRADE: this file must never throw out of `--require` (that would break the
// workload) — every patch is wrapped; a probe failure simply yields a thinner/absent trace.

"use strict";

(() => {
  // ── timing origin ────────────────────────────────────────────────────────────────────────────
  // performance.now() is ms since timeOrigin (≈ process start), so it doubles as the cold-start clock.
  const tPreloadStart = performance.now();
  let tFirstActivity = null; // set on the first patched call → splits import-load from warm steady-state
  const markActivity = () => {
    if (tFirstActivity === null) tFirstActivity = performance.now();
  };

  // ── env (set by measure-single; all optional) ────────────────────────────────────────────────
  const NET = process.env.ARCANE_NET || "deny"; // "deny" → block outbound; "replay" → serve fixtures
  let replayFixtures = {};
  try {
    replayFixtures = JSON.parse(process.env.ARCANE_REPLAY_FIXTURES || "{}");
  } catch {
    replayFixtures = {};
  }

  // Capture the ORIGINAL synchronous fd writer BEFORE we wrap fs. The trace leaves the sandbox on
  // STDOUT (fd 1) as a sentinel-prefixed line — NOT a file: the only writable paths in the container
  // are tmpfs (/scratch, /tmp), and a tmpfs is unmounted when the container STOPS, so `docker cp`
  // cannot read it post-exit. fd-1 stdout is captured by the runner and survives. fs.writeSync is a
  // synchronous write(2), so it flushes reliably from inside the 'exit' handler (unlike async stdout).
  let realWriteSync = null;
  try {
    realWriteSync = require("node:fs").writeSync;
  } catch {
    realWriteSync = null;
  }

  // ── counters + outbound log (the trace payload) ──────────────────────────────────────────────
  let queryCount = 0;
  let fetchCount = 0;
  let httpCount = 0;
  let childSpawnCount = 0;
  let fsReadCount = 0;
  let fsWriteCount = 0;
  let unhandledRejections = 0;
  const memorySamples = []; // RSS bytes, sampled after a forced GC
  const outbound = []; // { kind, target, disposition: "blocked"|"recorded" }
  const OUTBOUND_CAP = 1000; // a chatty workload can't grow the trace without bound

  const pushOutbound = (kind, target, disposition) => {
    if (outbound.length < OUTBOUND_CAP) {
      outbound.push({ kind, target: String(target).slice(0, 200), disposition });
    }
  };

  const forceGc = () => {
    // Trigger a real GC without needing the --expose-gc flag (which NODE_OPTIONS disallows): flip the
    // V8 flag at runtime, grab the global gc() from a fresh context, call it, then flip it back.
    try {
      const v8 = require("node:v8");
      const vm = require("node:vm");
      v8.setFlagsFromString("--expose-gc");
      const gc = vm.runInNewContext("gc");
      if (typeof gc === "function") gc();
      v8.setFlagsFromString("--no-expose-gc");
    } catch {
      /* gc best-effort — never fatal */
    }
  };

  // ── DB query counting via an instrumented driver stub (hermetic — no real DB, no network, no flags).
  // We intercept `require('pg')` (which isn't installed in the image) and hand back an instrumented
  // stub whose .query() increments the REAL query count. STUB: the returned rows are synthetic — M3B
  // surfaces only the COUNT (and the query SHAPE, never values). Real-driver patching is an M3C add.
  try {
    const Module = require("node:module");
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "pg") {
        markActivity();
        return makePgStub();
      }
      return origLoad.apply(this, arguments);
    };
  } catch {
    /* module intercept best-effort */
  }

  function shapeOf(sql) {
    // first two tokens only (e.g. "SELECT users") — never query values, never secrets.
    return String(typeof sql === "string" ? sql : (sql && sql.text) || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
  }
  function makePgStub() {
    const record = (sql) => {
      queryCount++;
      pushOutbound("query", shapeOf(sql), "recorded");
    };
    class Client {
      async connect() {}
      async end() {}
      query(sql) {
        record(sql);
        return Promise.resolve({ rows: [], rowCount: 0 }); // STUB: synthetic result; the count is real
      }
    }
    class Pool {
      async connect() {
        return new Client();
      }
      query(sql) {
        record(sql);
        return Promise.resolve({ rows: [], rowCount: 0 }); // STUB: synthetic result; the count is real
      }
      async end() {}
    }
    return { Client, Pool };
  }

  // ── fetch: block (deny) or serve a recorded fixture (replay). Never silently allow. ──────────────
  try {
    const origFetch = globalThis.fetch;
    if (typeof origFetch === "function") {
      globalThis.fetch = function (input, init) {
        markActivity();
        fetchCount++;
        const url = typeof input === "string" ? input : (input && input.url) || String(input);
        if (NET === "replay" && Object.prototype.hasOwnProperty.call(replayFixtures, url)) {
          const fx = replayFixtures[url] || {};
          pushOutbound("fetch", url, "recorded");
          return Promise.resolve(
            new Response(fx.body != null ? String(fx.body) : "", { status: fx.status || 200 }),
          );
        }
        // deny, or replay with no matching fixture → BLOCK (fail-closed). The container denies egress too.
        pushOutbound("fetch", url, "blocked");
        return Promise.reject(
          new Error(`arcane-sandbox: outbound fetch blocked (network=${NET}) → ${url}`),
        );
      };
    }
  } catch {
    /* fetch patch best-effort */
  }

  // ── node:http / node:https: record + BLOCK (M3B). Raw-stream replay is M3C; --network none denies
  //    egress regardless, so this is honest defense-in-depth, never a silent allow. ─────────────────
  for (const modName of ["node:http", "node:https"]) {
    try {
      const m = require(modName);
      for (const fn of ["request", "get"]) {
        const orig = m[fn];
        if (typeof orig !== "function") continue;
        m[fn] = function (...a) {
          markActivity();
          httpCount++;
          const target = describeHttpTarget(a);
          pushOutbound("http", target, "blocked");
          throw new Error(`arcane-sandbox: outbound ${modName} ${fn} blocked → ${target}`);
        };
      }
    } catch {
      /* http patch best-effort */
    }
  }
  function describeHttpTarget(args) {
    const a0 = args[0];
    if (typeof a0 === "string") return a0.slice(0, 200);
    if (a0 && typeof a0 === "object") {
      const host = a0.hostname || a0.host || "?";
      const path = a0.path || "";
      return `${host}${path}`.slice(0, 200);
    }
    return "?";
  }

  // ── fs: RECORD only (telemetry), never block. The read-only mount + per-run scratch are the boundary
  //    (SI-1), not the probe. The probe's own trace write (TRACE_PATH) is excluded from the counts. ──
  try {
    const fs = require("node:fs");
    const wrap = (obj, name, kind) => {
      const orig = obj[name];
      if (typeof orig !== "function") return;
      obj[name] = function (...a) {
        markActivity();
        if (kind === "read") fsReadCount++;
        else fsWriteCount++;
        return orig.apply(this, a);
      };
    };
    for (const n of ["readFile", "readFileSync", "createReadStream", "open", "openSync"]) {
      wrap(fs, n, "read");
    }
    for (const n of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream"]) {
      wrap(fs, n, "write");
    }
    if (fs.promises) {
      wrap(fs.promises, "readFile", "read");
      wrap(fs.promises, "writeFile", "write");
      wrap(fs.promises, "appendFile", "write");
    }
  } catch {
    /* fs patch best-effort */
  }

  // ── child_process: RECORD only (count + that a spawn happened). Never block — the container's
  //    pids-limit + --network none + read-only rootfs bound any child (incl. a NODE_OPTIONS-stripped
  //    one, which is exactly the SI-1 bypass adversary). ─────────────────────────────────────────────
  try {
    const cp = require("node:child_process");
    for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
      const orig = cp[fn];
      if (typeof orig !== "function") continue;
      cp[fn] = function (...a) {
        markActivity();
        childSpawnCount++;
        return orig.apply(this, a);
      };
    }
  } catch {
    /* child_process patch best-effort */
  }

  // ── unhandled rejections (telemetry; does not change process behavior) ───────────────────────────
  try {
    process.on("unhandledRejection", () => {
      unhandledRejections++;
    });
  } catch {
    /* best-effort */
  }

  // ── trace flush on exit (synchronous; uses the captured ORIGINAL appendFileSync) ─────────────────
  const tPreloadDone = performance.now(); // probe armed → boundary between cold-start and import-load
  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    try {
      forceGc();
      memorySamples.push(process.memoryUsage().rss);
      const tExit = performance.now();
      const sample = {
        schema: 1,
        queryCount,
        fetchCount,
        httpCount,
        childSpawnCount,
        fsReadCount,
        fsWriteCount,
        unhandledRejections,
        outbound,
        memorySamples,
        // §19A.3 warmup separation — cold-start / import-load / warm steady-state kept DISTINCT, never mixed.
        coldStartMs: Math.round(tPreloadDone),
        importLoadMs: tFirstActivity !== null ? Math.round(tFirstActivity - tPreloadDone) : null,
        steadyMs: tFirstActivity !== null ? Math.round(tExit - tFirstActivity) : null,
        wallMs: Math.round(tExit),
        functions: [], // per-function self-time PROFILING is M3C; M3B captures counts only
      };
      // Emit the trace on fd 1 (stdout), prefixed with a sentinel so the cloud can lift it out of the
      // workload's own output. The sentinel string is kept IN SYNC with TRACE_SENTINEL in trace.ts
      // (this file is plain .cjs and shares no types). Leading \n guarantees it starts its own line.
      if (typeof realWriteSync === "function") {
        realWriteSync(1, `\n__ARCANE_TRACE__ ${JSON.stringify(sample)}\n`);
      }
    } catch {
      // Never throw from an exit handler. No trace written → the cloud degrades to "no trace".
    }
  };
  try {
    process.on("exit", flush);
  } catch {
    /* best-effort */
  }

  // touch tPreloadStart so a strict lint can't flag it unused; it anchors the cold-start clock conceptually.
  void tPreloadStart;
})();
