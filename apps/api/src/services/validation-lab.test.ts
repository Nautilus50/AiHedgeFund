import { describe, expect, it } from "vitest";
import type { Bar } from "@arf-os/pine";
import { resolveBenchmarkComparison } from "./validation-lab.js";

const BARS: Bar[] = [
  { time: "2023-12-31T23:00:00.000Z", open: 90, high: 91, low: 89, close: 90, volume: 1 }, // before the window
  { time: "2024-01-01T00:00:00.000Z", open: 100, high: 102, low: 99, close: 101, volume: 1 },
  { time: "2024-01-15T00:00:00.000Z", open: 105, high: 106, low: 104, close: 105, volume: 1 },
  { time: "2024-02-01T00:00:00.000Z", open: 108, high: 110, low: 107, close: 110, volume: 1 },
  { time: "2024-02-02T00:00:00.000Z", open: 111, high: 112, low: 110, close: 112, volume: 1 }, // after the window
];

describe("resolveBenchmarkComparison", () => {
  it("uses the first in-window bar's open and the last in-window bar's close", () => {
    // Window bars: 2024-01-01 (open 100) through 2024-02-01 (close 110).
    // strategyReturnPct = 500/10000*100 = 5%. benchmarkReturnPct = (110-100)/100*100 = 10%.
    const panel = resolveBenchmarkComparison(
      BARS,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-02-01T00:00:00Z"),
      "500.00000000",
      "10000.00000000",
    );
    expect(panel.reasonCode).toBeUndefined();
    expect(panel.result?.strategyReturnPct).toBeCloseTo(5, 6);
    expect(panel.result?.benchmarkReturnPct).toBeCloseTo(10, 6);
  });

  it("does not assume bars arrive pre-sorted", () => {
    const shuffled = [...BARS].reverse();
    const panel = resolveBenchmarkComparison(
      shuffled,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-02-01T00:00:00Z"),
      "0.00000000",
      "10000.00000000",
    );
    expect(panel.result?.benchmarkReturnPct).toBeCloseTo(10, 6);
  });

  it("reports NO_BARS_IN_WINDOW when no bar falls inside [fromTs, toTs]", () => {
    const panel = resolveBenchmarkComparison(
      BARS,
      new Date("2025-01-01T00:00:00Z"),
      new Date("2025-02-01T00:00:00Z"),
      "0.00000000",
      "10000.00000000",
    );
    expect(panel.result).toBeUndefined();
    expect(panel.reasonCode).toBe("NO_BARS_IN_WINDOW");
  });

  it("treats a single in-window bar as both entry and exit — zero benchmark return, not a crash", () => {
    const panel = resolveBenchmarkComparison(
      BARS,
      new Date("2024-01-15T00:00:00Z"),
      new Date("2024-01-15T00:00:00Z"),
      "0.00000000",
      "10000.00000000",
    );
    expect(panel.result?.benchmarkReturnPct).toBe(0);
  });
});
