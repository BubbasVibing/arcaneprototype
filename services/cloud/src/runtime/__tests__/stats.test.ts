import { describe, expect, test } from "bun:test";
import {
  ABS_FLOOR_MS,
  cv,
  mad,
  max,
  mean,
  median,
  min,
  percentile,
  removeOutliers,
  REL_THRESHOLD,
  stdev,
  suppressionGate,
  summarize,
} from "../stats";

// M3C PURE stats gate — no Docker, always runs. Proves the robust stats are correct AND that the dual
// suppression-gate fires on a real regression but NOT on noise (the statistical half of proof (b); the
// whitespace no-op is handled provably upstream by the source short-circuit, tested in delta-engine).

describe("robust stats primitives", () => {
  test("median — odd and even length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([42])).toBe(42);
  });

  test("percentile — interpolated, endpoints, single", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile(xs, 50)).toBeCloseTo(5.5, 5);
    expect(percentile([7], 95)).toBe(7);
  });

  test("min / max / mean", () => {
    expect(min([5, 2, 9])).toBe(2);
    expect(max([5, 2, 9])).toBe(9);
    expect(mean([2, 4, 6])).toBe(4);
  });

  test("stdev — sample (n−1), zero for n<2", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(stdev([5])).toBe(0);
    expect(stdev([])).toBe(0);
  });

  test("mad — robust spread", () => {
    // median = 3; abs devs = [2,1,0,1,2] → median 1
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
    expect(mad([10, 10, 10])).toBe(0);
  });

  test("cv — drops to 0 with no spread, Infinity when un-trustable", () => {
    expect(cv([100, 100, 100])).toBe(0);
    expect(cv([0, 0, 0])).toBe(0);
    expect(cv([0, 5, -5])).toBe(Infinity); // median 0 but real spread → un-trustable
  });
});

describe("removeOutliers", () => {
  test("drops a clear outlier", () => {
    const r = removeOutliers([100, 101, 99, 100, 102, 98, 500]);
    expect(r.removed).toBe(1);
    expect(r.kept).not.toContain(500);
  });

  test("MAD=0 (≥half identical) → remove nothing (spread un-estimable)", () => {
    const r = removeOutliers([10, 10, 10, 10, 999]);
    expect(r.removed).toBe(0);
    expect(r.kept.length).toBe(5);
  });

  test("never trims below MIN_SURVIVORS — keeps the side untouched", () => {
    const r = removeOutliers([1, 2, 100, 200]); // aggressive spread, small n
    expect(r.kept.length).toBeGreaterThanOrEqual(3);
  });

  test("n ≤ MIN_SURVIVORS is returned untouched", () => {
    const r = removeOutliers([1, 999, 2]);
    expect(r.removed).toBe(0);
    expect(r.kept.length).toBe(3);
  });
});

describe("summarize", () => {
  test("emits the robust block with no mean field", () => {
    const s = summarize([10, 12, 11, 13, 12, 14, 11]);
    expect(s.n).toBe(7);
    expect(s.median).toBe(12);
    expect(s.min).toBe(10);
    expect(s.max).toBe(14);
    expect(s.p95).toBeGreaterThanOrEqual(s.median);
    expect(s).not.toHaveProperty("mean");
  });
});

describe("suppressionGate — the noise model", () => {
  test("NO-OP-LIKE: same distribution → no finding (both gates fail)", () => {
    const g = suppressionGate({
      baselineP95: 104,
      currentP95: 105,
      baselineMedian: 100,
      currentMedian: 101,
      baselineMad: 3,
      currentMad: 3,
    });
    expect(g.magnitudePass).toBe(false); // delta 1ms < 15ms floor
    expect(g.bandNonOverlap).toBe(false); // bands overlap heavily
    expect(g.emit).toBe(false);
  });

  test("CLEAR REGRESSION: large, stable shift → finding (both gates pass)", () => {
    const g = suppressionGate({
      baselineP95: 104,
      currentP95: 210,
      baselineMedian: 100,
      currentMedian: 200,
      baselineMad: 2,
      currentMad: 3,
    });
    expect(g.magnitudePass).toBe(true);
    expect(g.bandNonOverlap).toBe(true);
    expect(g.emit).toBe(true);
    expect(g.p95Delta).toBe(106);
    expect(g.p95DeltaPct).toBeCloseTo(101.9, 1);
  });

  test("HIGH-VARIANCE: big delta but overlapping bands → suppressed (band protects)", () => {
    const g = suppressionGate({
      baselineP95: 1300,
      currentP95: 1500,
      baselineMedian: 1000,
      currentMedian: 1200,
      baselineMad: 200,
      currentMad: 250,
    });
    expect(g.magnitudePass).toBe(true); // 200ms ≥ 130ms
    expect(g.bandNonOverlap).toBe(false); // 950 ≤ 1200 → overlap
    expect(g.emit).toBe(false);
  });

  test("SUB-FLOOR: 20% rise on tiny absolute times → suppressed by ABS_FLOOR", () => {
    const g = suppressionGate({
      baselineP95: 10,
      currentP95: 12,
      baselineMedian: 10,
      currentMedian: 12,
      baselineMad: 0,
      currentMad: 0,
    });
    expect(g.threshold).toBe(ABS_FLOOR_MS); // max(1, 15) = 15
    expect(g.magnitudePass).toBe(false); // 2ms < 15ms
    expect(g.emit).toBe(false);
  });

  test("constants are the pinned values", () => {
    expect(REL_THRESHOLD).toBe(0.1);
    expect(ABS_FLOOR_MS).toBe(15);
  });
});
