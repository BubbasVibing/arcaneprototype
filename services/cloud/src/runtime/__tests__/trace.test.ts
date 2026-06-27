import { describe, expect, test } from "bun:test";
import { parseTrace, TRACE_SENTINEL, type TraceSample } from "../trace";

// M3B measurement-integrity unit tests (pure — always run, no Docker). These pin the two defenses that
// keep the stdout trace channel honest: (1) a truncated/partial line is NEVER read as a valid trace,
// (2) the LAST complete sentinel line wins, so a forged line printed mid-run can't override the
// probe's genuine exit-time trace. The residual forgeability by a hostile workload (a later exit
// handler) is the documented trusted-workload assumption — not tested here because it is an accepted
// limitation of in-process telemetry (SI-1), not a bug.

function completeTrace(over: Partial<TraceSample> = {}): TraceSample {
  return {
    schema: 1,
    queryCount: 0,
    fetchCount: 0,
    httpCount: 0,
    childSpawnCount: 0,
    fsReadCount: 0,
    fsWriteCount: 0,
    unhandledRejections: 0,
    outbound: [],
    memorySamples: [1024],
    coldStartMs: 5,
    importLoadMs: 1,
    steadyMs: 2,
    wallMs: 8,
    functions: [],
    ...over,
  };
}
const line = (t: unknown) => `${TRACE_SENTINEL}${JSON.stringify(t)}`;

describe("parseTrace — measurement integrity", () => {
  test("parses a complete sentinel line out of mixed stdout", () => {
    const stdout = `workload log line\n${line(completeTrace({ queryCount: 5 }))}\n`;
    expect(parseTrace(stdout)?.queryCount).toBe(5);
  });

  test("a sentinel prefixed by workload text on the same line still parses (indexOf)", () => {
    const stdout = `someprefix>>> ${line(completeTrace({ fetchCount: 2 }))}`;
    expect(parseTrace(stdout)?.fetchCount).toBe(2);
  });

  test("truncated JSON after the sentinel → null (never a partial trace)", () => {
    // simulate the flood/64KiB-cap case: the trace line is cut mid-object → no closing brace.
    const full = line(completeTrace({ queryCount: 9 }));
    const truncated = full.slice(0, full.length - 12); // chop the tail incl. the closing brace
    expect(parseTrace(`output\n${truncated}`)).toBeNull();
  });

  test("structurally-valid but INCOMPLETE object → null (partial is never read as whole)", () => {
    expect(parseTrace(line({ schema: 1 }))).toBeNull(); // only schema, missing every count
    expect(parseTrace(line({ schema: 1, queryCount: 3 }))).toBeNull(); // still missing fields
  });

  test("a field of the wrong type → null", () => {
    expect(parseTrace(line(completeTrace({ queryCount: "3" as unknown as number })))).toBeNull();
  });

  test("take-last: a forged line printed BEFORE the genuine exit-time trace does not win", () => {
    // The probe writes its trace LAST (in the exit handler). A forged earlier line must lose.
    const forged = line(completeTrace({ queryCount: 999 }));
    const genuine = line(completeTrace({ queryCount: 3 }));
    expect(parseTrace(`${forged}\nFORGE_DONE\n${genuine}`)?.queryCount).toBe(3);
  });

  test("no sentinel anywhere → null", () => {
    expect(parseTrace("just\nworkload\noutput\n")).toBeNull();
  });

  test("empty payload after the sentinel → null", () => {
    expect(parseTrace(`${TRACE_SENTINEL}\n`)).toBeNull();
  });
});
