import { describe, expect, it } from "vitest";
import { calculateCoreMetrics } from "./trade-metrics.js";
import type { MetricsTrade } from "./types.js";

// Hand-calculated fixture (CLAUDE.md 21.1 — tests against hand-calculated fixtures):
//   trade 1: +100  (24h hold)   trade 2: -40  (12h hold)
//   trade 3: -20   (6h hold)    trade 4: +50  (10h hold)
//   trade 5: still open — must be excluded entirely.
// grossProfit=150 grossLoss=60 netProfit=90 profitFactor=2.5 winRate=50%
// avgWin=75 avgLoss=-30 payoffRatio=2.5 longestLosingStreak=2 avgHold=13h
const trades: MetricsTrade[] = [
  { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: "2024-01-02T00:00:00.000Z", netPnl: 100, isOpen: false },
  { tradeNumber: 2, direction: "LONG", entryTime: "2024-01-03T00:00:00.000Z", exitTime: "2024-01-03T12:00:00.000Z", netPnl: -40, isOpen: false },
  { tradeNumber: 3, direction: "SHORT", entryTime: "2024-01-10T00:00:00.000Z", exitTime: "2024-01-10T06:00:00.000Z", netPnl: -20, isOpen: false },
  { tradeNumber: 4, direction: "LONG", entryTime: "2024-02-01T00:00:00.000Z", exitTime: "2024-02-01T10:00:00.000Z", netPnl: 50, isOpen: false },
  { tradeNumber: 5, direction: "LONG", entryTime: "2024-02-05T00:00:00.000Z", isOpen: true },
];

describe("calculateCoreMetrics", () => {
  const metrics = calculateCoreMetrics(trades);

  it("excludes the open trade from the closed count", () => {
    expect(metrics.closedTradeCount).toBe(4);
  });

  it("computes gross profit, gross loss, and net profit", () => {
    expect(metrics.grossProfit).toBe("150.00000000");
    expect(metrics.grossLoss).toBe("60.00000000");
    expect(metrics.netProfit).toBe("90.00000000");
  });

  it("computes profit factor", () => {
    expect(metrics.profitFactor).toBeCloseTo(2.5);
  });

  it("computes win rate as a 0-100 percentage", () => {
    expect(metrics.winRatePct).toBeCloseTo(50);
  });

  it("computes average win and average loss (loss reported as negative)", () => {
    expect(metrics.avgWin).toBe("75.00000000");
    expect(metrics.avgLoss).toBe("-30.00000000");
  });

  it("computes payoff ratio", () => {
    expect(metrics.payoffRatio).toBeCloseTo(2.5);
  });

  it("computes the longest losing streak in exit-time order", () => {
    expect(metrics.longestLosingStreak).toBe(2);
  });

  it("computes average holding duration in hours", () => {
    expect(metrics.avgHoldingDurationHours).toBeCloseTo(13);
  });

  it("buckets monthly returns by exit month", () => {
    expect(metrics.monthlyReturns).toEqual([
      { month: "2024-01", netProfit: "40.00000000" },
      { month: "2024-02", netProfit: "50.00000000" },
    ]);
  });

  it("returns null profit factor and payoff ratio when there are no losing trades", () => {
    const onlyWins = calculateCoreMetrics([
      { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: "2024-01-02T00:00:00.000Z", netPnl: 10, isOpen: false },
    ]);
    expect(onlyWins.profitFactor).toBeNull();
    expect(onlyWins.payoffRatio).toBeNull();
  });

  it("handles zero closed trades", () => {
    const empty = calculateCoreMetrics([]);
    expect(empty.closedTradeCount).toBe(0);
    expect(empty.winRatePct).toBe(0);
    expect(empty.avgHoldingDurationHours).toBeNull();
    expect(empty.monthlyReturns).toEqual([]);
  });
});
