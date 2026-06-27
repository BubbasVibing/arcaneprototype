// M3B — the in-sandbox probe's trace shape. CLOUD-INTERNAL ONLY: this type is the raw, single-side
// measurement the probe writes to /scratch and the cloud reads back. It does NOT cross to
// @arcane/shared — only a `RunReport` (assembled in M3C) is wire-bound. Keep it here so M3C can build
// baseline-vs-current/stats/attribution on top without leaking internal telemetry onto the protocol.
//
// The field set mirrors `preload.cjs`'s emitted object (the two are hand-kept in sync — the probe is
// plain .cjs and shares no types). It is what M3C will consume: query/fetch counts feed N+1 detection;
// the cold/import/steady split feeds warmup-aware timing; memorySamples feed leak curves.

export type OutboundKind = "fetch" | "http" | "query";

// HONESTY (§21A): every outbound interaction is one of these — never silently allowed.
//   "blocked"  — the probe refused it (and the container's --network none denies egress regardless).
//   "recorded" — the probe served/logged a recorded interaction (a replay fixture, or a counted query).
export type OutboundDisposition = "blocked" | "recorded";

export interface OutboundEvent {
  kind: OutboundKind;
  target: string; // url / host+path / query-shape — bounded, never values or secrets
  disposition: OutboundDisposition;
}

export interface TraceSample {
  schema: 1; // version marker (the probe writes schema:1)
  queryCount: number;
  fetchCount: number;
  httpCount: number;
  childSpawnCount: number;
  fsReadCount: number;
  fsWriteCount: number;
  unhandledRejections: number;
  outbound: OutboundEvent[];
  memorySamples: number[]; // RSS bytes, sampled after a forced GC
  // §19A.3 warmup separation — kept DISTINCT, never mixed.
  coldStartMs: number | null; // process start → probe armed
  importLoadMs: number | null; // probe armed → first user activity (module load / first patched call)
  steadyMs: number | null; // first user activity → exit (warm steady-state)
  wallMs: number | null; // process start → exit
  functions: never[]; // EMPTY in M3B — per-function self-time profiling is M3C
}

// The probe emits its trace on STDOUT as a single line prefixed with this sentinel (it cannot write a
// readable file — the only writable container paths are tmpfs, unmounted on stop). Kept IN SYNC with
// the literal in preload.cjs (the probe is plain .cjs and shares no types with this module).
export const TRACE_SENTINEL = "__ARCANE_TRACE__ ";

// MEASUREMENT-INTEGRITY BOUNDARY (read before M3C builds on this):
//   The trace rides STDOUT, a channel the workload SHARES with the probe — and the probe runs IN the
//   workload's process. So the trace is NOT tamper-proof against a HOSTILE workload: in-process code
//   can print its own sentinel line (or register a later `exit` handler) and forge counts. This is the
//   SAME exposure the file channel would have had (the workload shares the /scratch tmpfs too) — it is
//   INHERENT to in-process telemetry, which is exactly why SI-1 says the probe is never load-bearing.
//   Forged telemetry CANNOT escape the sandbox (containment is unaffected); it only corrupts the
//   measurement. M3B's measurement layer therefore assumes a NON-ADVERSARIAL workload (the developer
//   measuring their own code; forging only fools themselves). Two defenses make accidental/casual
//   corruption a non-issue: (1) `parseTrace` accepts ONLY a COMPLETE, well-typed sample — a truncated
//   or partial line is rejected, never read as a partial-but-valid trace; (2) it returns the LAST
//   complete sentinel line, and the probe writes its trace in the `exit` handler (after all normal
//   workload output), so a forged line printed DURING the run never overrides the genuine one. The
//   residual gap — a workload that registers a LATER exit handler to forge after the probe — is the
//   documented trusted-workload assumption. *** M3C MUST add a tamper-resistant channel (e.g. an
//   out-of-process observer the workload cannot write to) before runtime ATTRIBUTION is allowed to
//   rest on a workload-forgeable signal like queryCount. ***

// Every required field present and correctly typed. This is what makes "partial parses as whole"
// impossible: a truncated JSON object loses its closing brace → JSON.parse throws; a structurally
// valid but INCOMPLETE object (e.g. `{"schema":1}`) fails this guard → rejected.
function isCompleteTrace(o: unknown): o is TraceSample {
  if (!o || typeof o !== "object") return false;
  const t = o as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number";
  const numOrNull = (v: unknown) => v === null || typeof v === "number";
  return (
    t.schema === 1 &&
    num(t.queryCount) &&
    num(t.fetchCount) &&
    num(t.httpCount) &&
    num(t.childSpawnCount) &&
    num(t.fsReadCount) &&
    num(t.fsWriteCount) &&
    num(t.unhandledRejections) &&
    Array.isArray(t.outbound) &&
    Array.isArray(t.memorySamples) &&
    numOrNull(t.coldStartMs) &&
    numOrNull(t.importLoadMs) &&
    numOrNull(t.steadyMs) &&
    numOrNull(t.wallMs) &&
    Array.isArray(t.functions)
  );
}

// Lift the trace out of captured stdout (which also holds the workload's own output). Scan every line
// for the sentinel and return the LAST line that parses to a COMPLETE sample (see the integrity note
// above for why "last" + "complete"). Returns null when there is nothing usable → the caller degrades
// to "no trace", never a partial/fabricated trace. Never throws.
export function parseTrace(stdout: string): TraceSample | null {
  let last: TraceSample | null = null;
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(TRACE_SENTINEL);
    if (at === -1) continue;
    const json = line.slice(at + TRACE_SENTINEL.length).trim();
    if (!json) continue;
    try {
      const obj: unknown = JSON.parse(json);
      if (isCompleteTrace(obj)) last = obj; // incomplete/partial → skipped, never read as whole
    } catch {
      /* skip a corrupt line — best-effort */
    }
  }
  return last;
}
