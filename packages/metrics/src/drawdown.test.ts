import { describe, expect, it } from "vitest";
import { computeDrawdownCurve } from "./drawdown.js";
import type { EquityPoint } from "./equity.js";

// Hand-calculated: peak tracks 1000 -> 1100, drawdown at each later point is
// distance below 1100. Max drawdown is 60 at sequence 3 (1100 - 1040).
const equityPoints: EquityPoint[] = [
  { sequenceNumber: 0, time: "t0", equity: "1000.00000000" },
  { sequenceNumber: 1, time: "t1", equity: "1100.00000000" },
  { sequenceNumber: 2, time: "t2", equity: "1060.00000000" },
  { sequenceNumber: 3, time: "t3", equity: "1040.00000000" },
  { sequenceNumber: 4, time: "t4", equity: "1090.00000000" },
];

describe("computeDrawdownCurve", () => {
  const result = computeDrawdownCurve(equityPoints);

  it("computes zero drawdown at a new peak", () => {
    expect(result.points[1]).toMatchObject({ drawdown: "0.00000000", drawdownPct: 0 });
  });

  it("computes drawdown as distance below the running peak, not the previous point", () => {
    expect(result.points[2]).toMatchObject({ drawdown: "40.00000000" });
    expect(result.points[3]).toMatchObject({ drawdown: "60.00000000" });
    // A partial recovery still measures against the 1100 peak, not the 1040 trough.
    expect(result.points[4]).toMatchObject({ drawdown: "10.00000000" });
  });

  it("computes drawdown percentage relative to the peak", () => {
    expect(result.points[3]?.drawdownPct).toBeCloseTo((60 / 1100) * 100);
  });

  it("tracks the maximum drawdown across the whole curve", () => {
    expect(result.maxDrawdown).toBe("60.00000000");
    expect(result.maxDrawdownPct).toBeCloseTo((60 / 1100) * 100);
  });
});
