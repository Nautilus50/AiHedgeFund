import { describe, expect, it } from "vitest";
import {
  MIN_OVERLAP_DAYS,
  computeExposureOverlap,
  computeSeriesCorrelation,
  computeSpearmanCorrelation,
  toDailyDrawdownSeries,
  toDailyEquitySeries,
  toReturnSeries,
} from "./portfolio.js";

describe("toDailyEquitySeries", () => {
  it("collapses same-day duplicates to the highest sequenceNumber, not an average or naive last-by-timestamp", () => {
    const series = toDailyEquitySeries([
      { sequenceNumber: 1, barTime: new Date("2024-01-01T02:00:00.000Z"), equity: "100.00000000" },
      { sequenceNumber: 3, barTime: new Date("2024-01-01T01:00:00.000Z"), equity: "150.00000000" }, // earlier clock time, higher sequenceNumber
      { sequenceNumber: 2, barTime: new Date("2024-01-01T10:00:00.000Z"), equity: "120.00000000" },
      { sequenceNumber: 4, barTime: new Date("2024-01-02T00:00:00.000Z"), equity: "200.00000000" },
    ]);

    expect(series.get("2024-01-01")).toBe(150); // sequenceNumber 3 wins, not the latest clock time (sequenceNumber 2)
    expect(series.get("2024-01-02")).toBe(200);
    expect(series.size).toBe(2);
  });
});

describe("toDailyDrawdownSeries", () => {
  it("collapses same-day duplicates by sequenceNumber for drawdownPct too", () => {
    const series = toDailyDrawdownSeries([
      { sequenceNumber: 1, barTime: new Date("2024-01-01T01:00:00.000Z"), drawdownPct: 5 },
      { sequenceNumber: 2, barTime: new Date("2024-01-01T02:00:00.000Z"), drawdownPct: 8 },
    ]);
    expect(series.get("2024-01-01")).toBe(8);
  });
});

describe("toReturnSeries", () => {
  it("computes % change between consecutive available days — hand-calculated", () => {
    // 100 -> 110 -> 99: returns +10% then -10%.
    const daily = new Map([
      ["2024-01-01", 100],
      ["2024-01-05", 110], // irregular gap — 4 days elapsed, still just "the next available return"
      ["2024-01-06", 99],
    ]);
    const returns = toReturnSeries(daily);
    expect(returns.get("2024-01-05")).toBeCloseTo(10, 6);
    expect(returns.get("2024-01-06")).toBeCloseTo(-10, 6);
    expect(returns.size).toBe(2);
  });
});

describe("computeSpearmanCorrelation", () => {
  it("returns 1 for a perfectly monotonic (nonlinear) positive relationship — Spearman, not Pearson", () => {
    // a=[1,2,3,4,5], b=[1,4,9,16,25]: ranks are identical for both, so rank-correlation is exactly 1
    // even though the raw relationship is nonlinear (Pearson would be < 1).
    expect(computeSpearmanCorrelation([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 6);
  });

  it("returns -1 for a perfectly monotonic negative relationship", () => {
    expect(computeSpearmanCorrelation([1, 2, 3, 4, 5], [25, 16, 9, 4, 1])).toBeCloseTo(-1, 6);
  });

  it("averages ranks correctly for ties — hand-calculated", () => {
    // a=[1,1,2] -> ranks [1.5, 1.5, 3]; b=[3,4,5] -> ranks [1,2,3].
    // Pearson of [1.5,1.5,3] vs [1,2,3] = 1.5/sqrt(3) ≈ 0.8660254
    expect(computeSpearmanCorrelation([1, 1, 2], [3, 4, 5])).toBeCloseTo(0.8660254, 6);
  });

  it("returns null for mismatched or empty series", () => {
    expect(computeSpearmanCorrelation([1, 2], [1])).toBeNull();
    expect(computeSpearmanCorrelation([], [])).toBeNull();
  });
});

describe("computeSeriesCorrelation", () => {
  it(`returns a coefficient when overlap meets MIN_OVERLAP_DAYS (${MIN_OVERLAP_DAYS})`, () => {
    const seriesA = new Map<string, number>();
    const seriesB = new Map<string, number>();
    for (let i = 1; i <= 12; i++) {
      const day = `2024-01-${String(i).padStart(2, "0")}`;
      seriesA.set(day, i);
      if (i <= 10) seriesB.set(day, i * 10); // same relative order over the first 10 overlapping days
    }

    const result = computeSeriesCorrelation(seriesA, seriesB);
    expect(result.overlapDays).toBe(10);
    expect(result.overlapPct).toBeCloseTo((10 / 12) * 100, 6); // union of A's 12 days and B's 10 (subset) = 12
    expect(result.coefficient).toBeCloseTo(1, 6);
    expect(result.reasonCode).toBeUndefined();
  });

  it("returns null with INSUFFICIENT_OVERLAP below the threshold, but still echoes the real overlap count", () => {
    const seriesA = new Map([
      ["2024-01-01", 1],
      ["2024-01-02", 2],
      ["2024-01-03", 3],
      ["2024-01-04", 4],
      ["2024-01-05", 5],
    ]);
    const seriesB = new Map(seriesA); // fully overlapping, but only 5 days — below MIN_OVERLAP_DAYS

    const result = computeSeriesCorrelation(seriesA, seriesB);
    expect(result.coefficient).toBeNull();
    expect(result.reasonCode).toBe("INSUFFICIENT_OVERLAP");
    expect(result.overlapDays).toBe(5);
    expect(result.overlapPct).toBeCloseTo(100, 6);
  });
});

describe("computeExposureOverlap", () => {
  it("computes the Jaccard index for a fully-nested interval pair — hand-calculated", () => {
    const base = Date.UTC(2024, 0, 1);
    const tradesA = [{ entryTime: new Date(base), exitTime: new Date(base + 10 * 3_600_000) }]; // 0h-10h
    const tradesB = [{ entryTime: new Date(base + 2 * 3_600_000), exitTime: new Date(base + 8 * 3_600_000) }]; // 2h-8h, fully within A

    const result = computeExposureOverlap(tradesA, tradesB);
    expect(result.overlapHours).toBeCloseTo(6, 6);
    // totalA=10h totalB=6h union=10+6-6=10h -> jaccard=6/10*100=60%
    expect(result.jaccardPct).toBeCloseTo(60, 6);
  });

  it("sums overlap across multiple trade pairs on each side — hand-calculated", () => {
    const base = Date.UTC(2024, 0, 1);
    const tradesA = [
      { entryTime: new Date(base), exitTime: new Date(base + 2 * 3_600_000) }, // 0h-2h
      { entryTime: new Date(base + 4 * 3_600_000), exitTime: new Date(base + 6 * 3_600_000) }, // 4h-6h
    ];
    const tradesB = [{ entryTime: new Date(base + 1 * 3_600_000), exitTime: new Date(base + 5 * 3_600_000) }]; // 1h-5h

    const result = computeExposureOverlap(tradesA, tradesB);
    // A1 vs B: overlap(0-2, 1-5) = 1h. A2 vs B: overlap(4-6, 1-5) = 1h. total = 2h.
    // totalA = 2+2=4h, totalB=4h, union=4+4-2=6h -> jaccard=2/6*100=33.333...%
    expect(result.overlapHours).toBeCloseTo(2, 6);
    expect(result.jaccardPct).toBeCloseTo(33.333333, 4);
  });

  it("returns zero for non-overlapping intervals", () => {
    const base = Date.UTC(2024, 0, 1);
    const tradesA = [{ entryTime: new Date(base), exitTime: new Date(base + 2 * 3_600_000) }];
    const tradesB = [{ entryTime: new Date(base + 5 * 3_600_000), exitTime: new Date(base + 7 * 3_600_000) }];

    const result = computeExposureOverlap(tradesA, tradesB);
    expect(result.overlapHours).toBe(0);
    expect(result.jaccardPct).toBe(0);
  });
});
