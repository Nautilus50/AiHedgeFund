import type { Bar } from "@arf-os/pine";
import { describe, expect, it } from "vitest";
import { evaluateSeries, validateExpression } from "./evaluate.js";
import { parseExpression } from "./parser.js";

function bar(time: string, close: number): Bar {
  return { time, open: close, high: close, low: close, close, volume: 1000 };
}

function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => bar(`2024-01-01T${String(i).padStart(2, "0")}:00:00Z`, c));
}

function ohlcBars(rows: Array<{ open: number; high: number; low: number; close: number }>): Bar[] {
  return rows.map((r, i) => ({ time: `2024-01-01T${String(i).padStart(2, "0")}:00:00Z`, volume: 1000, ...r }));
}

const RAMP_CLOSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const RAMP_BARS = bars(RAMP_CLOSES);

// Flat for 7 bars (so SMA3 == SMA7 once both are defined), then a jump — the
// only shape in which ta.crossover can observe an actual cross rather than
// one series already being ahead before the slower one is even defined.
const CROSS_CLOSES = [10, 10, 10, 10, 10, 10, 10, 40, 41, 42];
const CROSS_BARS = bars(CROSS_CLOSES);

describe("evaluateSeries", () => {
  it("evaluates a plain identifier as the raw series", () => {
    const result = evaluateSeries(parseExpression("close"), { bars: RAMP_BARS, params: {} });
    expect(result).toEqual(RAMP_CLOSES);
  });

  it("computes ta.sma with correct warmup undefined-ness", () => {
    const result = evaluateSeries(parseExpression("ta.sma(close, 3)"), { bars: RAMP_BARS, params: {} });
    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBeCloseTo(2); // avg(1,2,3)
    expect(result[9]).toBeCloseTo((8 + 9 + 10) / 3);
  });

  it("resolves a parameter identifier to its numeric value", () => {
    const result = evaluateSeries(parseExpression("close > threshold"), {
      bars: RAMP_BARS,
      params: { threshold: 5 },
    });
    expect(result).toEqual([false, false, false, false, false, true, true, true, true, true]);
  });

  it("detects a crossover exactly once, at the crossing bar", () => {
    const result = evaluateSeries(parseExpression("ta.crossover(ta.sma(close, 3), ta.sma(close, 7))"), {
      bars: CROSS_BARS,
      params: {},
    });
    expect(result[6]).toBe(false); // SMA7 only just became defined; nothing to compare it against yet
    expect(result[7]).toBe(true); // SMA3 jumps from equal-to-SMA7 to above it
    expect(result[8]).toBe(false); // already crossed — not a new event
  });

  it("propagates undefined through arithmetic rather than coercing to a number", () => {
    const result = evaluateSeries(parseExpression("ta.sma(close, 3) + 1"), { bars: RAMP_BARS, params: {} });
    expect(result[0]).toBeUndefined();
    expect(result[2]).toBeCloseTo(3);
  });

  it("computes ta.highest and ta.lowest over a rolling window", () => {
    const bars: Bar[] = ohlcBars([
      { open: 5, high: 5, low: 4, close: 5 },
      { open: 8, high: 8, low: 6, close: 8 },
      { open: 3, high: 3, low: 2, close: 3 },
      { open: 9, high: 9, low: 8, close: 9 },
      { open: 2, high: 2, low: 1, close: 2 },
      { open: 7, high: 7, low: 5, close: 7 },
    ]);

    const highest = evaluateSeries(parseExpression("ta.highest(high, 3)"), { bars, params: {} });
    expect(highest[0]).toBeUndefined();
    expect(highest[1]).toBeUndefined();
    expect(highest[2]).toBeCloseTo(8); // max(5,8,3)
    expect(highest[3]).toBeCloseTo(9); // max(8,3,9)
    expect(highest[4]).toBeCloseTo(9); // max(3,9,2)
    expect(highest[5]).toBeCloseTo(9); // max(9,2,7)

    const lowest = evaluateSeries(parseExpression("ta.lowest(low, 3)"), { bars, params: {} });
    expect(lowest[2]).toBeCloseTo(2); // min(4,6,2)
    expect(lowest[3]).toBeCloseTo(2); // min(6,2,8)
    expect(lowest[4]).toBeCloseTo(1); // min(2,8,1)
    expect(lowest[5]).toBeCloseTo(1); // min(8,1,5)
  });

  it("computes ta.atr via Wilder smoothing, not a plain moving average", () => {
    const bars: Bar[] = ohlcBars([
      { open: 10, high: 12, low: 9, close: 11 },
      { open: 11, high: 13, low: 10, close: 12 },
      { open: 12, high: 14, low: 11, close: 13 },
      { open: 13, high: 16, low: 12, close: 15 },
      { open: 15, high: 17, low: 14, close: 16 },
    ]);
    // True ranges (hand-calculated): [3, 3, 3, 4, 3] — bar 0 has no prior
    // close, so TR0 = high - low.
    const result = evaluateSeries(parseExpression("ta.atr(3)"), { bars, params: {} });
    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBeCloseTo(3); // seed: avg(3,3,3)
    expect(result[3]).toBeCloseTo(4 * (1 / 3) + 3 * (2 / 3)); // 3.3333...
    expect(result[4]).toBeCloseTo(3 * (1 / 3) + (4 * (1 / 3) + 3 * (2 / 3)) * (2 / 3)); // 3.2222...
  });

  it("shifts a series with the [n] historical-offset operator", () => {
    const result = evaluateSeries(parseExpression("close[1]"), { bars: RAMP_BARS, params: {} });
    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeCloseTo(1); // close[0]
    expect(result[5]).toBeCloseTo(5); // close[4]
  });

  it("[0] is a no-op shift", () => {
    const result = evaluateSeries(parseExpression("close[0]"), { bars: RAMP_BARS, params: {} });
    expect(result).toEqual(RAMP_CLOSES);
  });
});

describe("validateExpression", () => {
  it("accepts OHLCV fields and declared parameters", () => {
    const errors = validateExpression(parseExpression("close > fastLength"), new Set(["fastLength"]));
    expect(errors).toEqual([]);
  });

  it("rejects an unknown identifier", () => {
    const errors = validateExpression(parseExpression("close > mystery"), new Set());
    expect(errors).toEqual([expect.stringContaining('Unknown identifier "mystery"')]);
  });

  it("rejects an unsupported function", () => {
    const errors = validateExpression(parseExpression("ta.vwap(close)"), new Set());
    expect(errors).toEqual([expect.stringContaining('Unsupported function "ta.vwap"')]);
  });

  it("rejects a wrong argument count", () => {
    const errors = validateExpression(parseExpression("ta.sma(close)"), new Set());
    expect(errors).toEqual([expect.stringContaining("expects 2 argument(s), got 1")]);
  });
});
