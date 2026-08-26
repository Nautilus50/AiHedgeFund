import { describe, expect, it } from "vitest";
import {
  computeBenchmarkComparison,
  computeDegradation,
  computeDirectionalBreakdown,
  computeMonteCarloFan,
  computeTradeRemovalConcentration,
} from "./robustness.js";
import type { MetricsTrade } from "./types.js";
import type { SubsetMetrics } from "./robustness.js";

describe("computeTradeRemovalConcentration", () => {
  // Hand-calculated fixture: closed trades +100, +50, -10, -30 (order given,
  // exit-time irrelevant here); one open trade excluded entirely.
  // totalNetProfit = 100+50-10-30 = 110.
  // Sorted descending by netPnl: +100, +50, -10, -30.
  // Cumulative: 100 -> 90.909...%; 150 -> 136.363...%; 140 -> 127.272...%; 110 -> 100%.
  const trades: MetricsTrade[] = [
    { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: "2024-01-02T00:00:00.000Z", netPnl: 100, isOpen: false },
    { tradeNumber: 2, direction: "LONG", entryTime: "2024-01-03T00:00:00.000Z", exitTime: "2024-01-03T12:00:00.000Z", netPnl: 50, isOpen: false },
    { tradeNumber: 3, direction: "SHORT", entryTime: "2024-01-10T00:00:00.000Z", exitTime: "2024-01-10T06:00:00.000Z", netPnl: -10, isOpen: false },
    { tradeNumber: 4, direction: "LONG", entryTime: "2024-02-01T00:00:00.000Z", exitTime: "2024-02-01T10:00:00.000Z", netPnl: -30, isOpen: false },
    { tradeNumber: 5, direction: "LONG", entryTime: "2024-02-05T00:00:00.000Z", isOpen: true },
  ];

  const result = computeTradeRemovalConcentration(trades);

  it("excludes the open trade and reports the true total net profit", () => {
    expect(result.totalNetProfit).toBe("110.00000000");
  });

  it("orders the curve by netPnl descending, largest contributor first", () => {
    expect(result.curve.map((c) => c.tradeNumber)).toEqual([1, 2, 3, 4]);
  });

  it("computes the running cumulative % of total net profit", () => {
    expect(result.curve[0]?.cumulativePct).toBeCloseTo(90.909, 2);
    expect(result.curve[1]?.cumulativePct).toBeCloseTo(136.364, 2);
    expect(result.curve[2]?.cumulativePct).toBeCloseTo(127.273, 2);
    expect(result.curve[3]?.cumulativePct).toBeCloseTo(100, 2);
  });

  it("returns an empty curve and zero total for no closed trades", () => {
    const empty = computeTradeRemovalConcentration([{ tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", isOpen: true }]);
    expect(empty.curve).toEqual([]);
    expect(empty.totalNetProfit).toBe("0.00000000");
  });
});

describe("computeDirectionalBreakdown", () => {
  // Hand-calculated fixture, mixed directions:
  //   LONG:  +100, +50, -30   -> grossProfit=150 grossLoss=30 netProfit=120 winRate=66.67%
  //   SHORT: -10, -10, +40    -> grossProfit=40  grossLoss=20 netProfit=20  winRate=33.33%
  const trades: MetricsTrade[] = [
    { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: "2024-01-02T00:00:00.000Z", netPnl: 100, isOpen: false },
    { tradeNumber: 2, direction: "SHORT", entryTime: "2024-01-02T00:00:00.000Z", exitTime: "2024-01-02T06:00:00.000Z", netPnl: -10, isOpen: false },
    { tradeNumber: 3, direction: "LONG", entryTime: "2024-01-03T00:00:00.000Z", exitTime: "2024-01-03T12:00:00.000Z", netPnl: 50, isOpen: false },
    { tradeNumber: 4, direction: "SHORT", entryTime: "2024-01-04T00:00:00.000Z", exitTime: "2024-01-04T06:00:00.000Z", netPnl: -10, isOpen: false },
    { tradeNumber: 5, direction: "LONG", entryTime: "2024-01-05T00:00:00.000Z", exitTime: "2024-01-05T06:00:00.000Z", netPnl: -30, isOpen: false },
    { tradeNumber: 6, direction: "SHORT", entryTime: "2024-01-06T00:00:00.000Z", exitTime: "2024-01-06T06:00:00.000Z", netPnl: 40, isOpen: false },
  ];

  const result = computeDirectionalBreakdown(trades);

  it("computes long-only metrics correctly", () => {
    expect(result.long.netProfit).toBe("120.00000000");
    expect(result.long.closedTradeCount).toBe(3);
    expect(result.long.winRatePct).toBeCloseTo(66.667, 2);
  });

  it("computes short-only metrics correctly", () => {
    expect(result.short.netProfit).toBe("20.00000000");
    expect(result.short.closedTradeCount).toBe(3);
    expect(result.short.winRatePct).toBeCloseTo(33.333, 2);
  });

  it("never exposes longestLosingStreak or monthlyReturns — both are sequence-shaped over the real interleaved ledger, not the direction-filtered subset", () => {
    expect(result.long).not.toHaveProperty("longestLosingStreak");
    expect(result.long).not.toHaveProperty("monthlyReturns");
    expect(result.short).not.toHaveProperty("longestLosingStreak");
    expect(result.short).not.toHaveProperty("monthlyReturns");
  });
});

describe("computeDegradation", () => {
  const baseline: SubsetMetrics = {
    calculationVersion: "1.0.0",
    closedTradeCount: 10,
    winningTrades: 6,
    losingTrades: 4,
    grossProfit: "150.00000000",
    grossLoss: "50.00000000",
    netProfit: "100.00000000",
    profitFactor: 2,
    winRatePct: 60,
    avgWin: "25.00000000",
    avgLoss: "-12.50000000",
    payoffRatio: 2,
    avgHoldingDurationHours: 10,
  };

  it("computes relative degradation for netProfit and profitFactor, and a point difference for winRate", () => {
    const comparison: SubsetMetrics = { ...baseline, netProfit: "50.00000000", profitFactor: 1, winRatePct: 40 };
    const result = computeDegradation(baseline, comparison);
    expect(result.netProfitDegradationPct).toBeCloseTo(50, 5);
    expect(result.profitFactorDegradationPct).toBeCloseTo(50, 5);
    expect(result.winRateDegradationPct).toBe(20);
  });

  it("reports improvement as a negative degradation", () => {
    const comparison: SubsetMetrics = { ...baseline, netProfit: "200.00000000" };
    const result = computeDegradation(baseline, comparison);
    expect(result.netProfitDegradationPct).toBeCloseTo(-100, 5);
  });

  it("returns null netProfitDegradationPct when the baseline is breakeven", () => {
    const zeroBaseline: SubsetMetrics = { ...baseline, netProfit: "0.00000000" };
    const result = computeDegradation(zeroBaseline, baseline);
    expect(result.netProfitDegradationPct).toBeNull();
  });

  it("returns null profitFactorDegradationPct when either side has no losing trades", () => {
    const noLosses: SubsetMetrics = { ...baseline, profitFactor: null };
    expect(computeDegradation(baseline, noLosses).profitFactorDegradationPct).toBeNull();
    expect(computeDegradation(noLosses, baseline).profitFactorDegradationPct).toBeNull();
  });
});

describe("computeBenchmarkComparison", () => {
  it("computes strategy and benchmark returns and their percentage-point gap — hand-calculated", () => {
    // strategyReturnPct = 500/10000*100 = 5%. benchmarkReturnPct = (110-100)/100*100 = 10%.
    // excessReturnPct = 5 - 10 = -5 (strategy underperformed buy-and-hold by 5 points).
    const result = computeBenchmarkComparison("500.00000000", "10000.00000000", 100, 110);
    expect(result?.strategyReturnPct).toBeCloseTo(5, 6);
    expect(result?.benchmarkReturnPct).toBeCloseTo(10, 6);
    expect(result?.excessReturnPct).toBeCloseTo(-5, 6);
  });

  it("reports the strategy beating a falling benchmark as a positive excess", () => {
    // strategyReturnPct = 200/1000*100 = 20%. benchmarkReturnPct = (90-100)/100*100 = -10%.
    const result = computeBenchmarkComparison("200.00000000", "1000.00000000", 100, 90);
    expect(result?.strategyReturnPct).toBeCloseTo(20, 6);
    expect(result?.benchmarkReturnPct).toBeCloseTo(-10, 6);
    expect(result?.excessReturnPct).toBeCloseTo(30, 6);
  });

  it("returns undefined when initialCapital is zero — no return is defined to divide by", () => {
    expect(computeBenchmarkComparison("100.00000000", "0.00000000", 100, 110)).toBeUndefined();
  });

  it("returns undefined when the benchmark entry price is zero", () => {
    expect(computeBenchmarkComparison("100.00000000", "1000.00000000", 0, 110)).toBeUndefined();
  });
});

describe("computeMonteCarloFan", () => {
  function trade(netPnl: number, isOpen = false): MetricsTrade {
    return { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: isOpen ? undefined : "2024-01-01T01:00:00.000Z", netPnl: isOpen ? undefined : netPnl, isOpen };
  }

  it("is deterministic — identical seed and trades produce identical output, run twice", () => {
    const trades = [trade(100), trade(-40), trade(60), trade(-20), trade(30)];
    const a = computeMonteCarloFan(trades, "1000.00000000");
    const b = computeMonteCarloFan(trades, "1000.00000000");
    expect(a).toEqual(b);
  });

  it("p50 sits between p5 and p95 for both bands, over a mixed win/loss ledger", () => {
    const trades = [trade(100), trade(-40), trade(60), trade(-20), trade(30), trade(-10), trade(50)];
    const result = computeMonteCarloFan(trades, "1000.00000000");
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.finalReturnPct.p5).toBeLessThanOrEqual(result.finalReturnPct.p50);
    expect(result.finalReturnPct.p50).toBeLessThanOrEqual(result.finalReturnPct.p95);
    expect(result.maxDrawdownPct.p5).toBeLessThanOrEqual(result.maxDrawdownPct.p50);
    expect(result.maxDrawdownPct.p50).toBeLessThanOrEqual(result.maxDrawdownPct.p95);
  });

  it("reports zero drawdown and a fixed final return when every trade is a winner", () => {
    // Every resample only ever draws from all-positive outcomes, so equity is monotonically non-decreasing on every path.
    const trades = [trade(10), trade(10), trade(10)];
    const result = computeMonteCarloFan(trades, "1000.00000000", { iterations: 200 });
    expect(result?.maxDrawdownPct.p95).toBe(0);
    // Sum of any 3-of-3-with-replacement draws from {10,10,10} is always 30 -> return = 30/1000*100 = 3%.
    expect(result?.finalReturnPct.p5).toBeCloseTo(3, 6);
    expect(result?.finalReturnPct.p95).toBeCloseTo(3, 6);
  });

  it("excludes open trades from the resampling pool", () => {
    const trades = [trade(10), trade(20), trade(0, true)];
    const result = computeMonteCarloFan(trades, "1000.00000000", { iterations: 500 });
    // Only {10, 20} ever get drawn, 2 draws per path — every path's sum lies in [20, 40].
    // A stray 0 from the open trade leaking in would let a path sum below 20, pulling p5 down.
    expect(result?.finalReturnPct.p5).toBeGreaterThanOrEqual((10 + 10) / 10 - 0.01);
    expect(result?.finalReturnPct.p95).toBeLessThanOrEqual((20 + 20) / 10 + 0.01);
  });

  it("returns undefined for a run with no closed trades", () => {
    expect(computeMonteCarloFan([trade(0, true)], "1000.00000000")).toBeUndefined();
  });

  it("returns undefined for a non-positive initialCapital", () => {
    expect(computeMonteCarloFan([trade(10)], "0.00000000")).toBeUndefined();
    expect(computeMonteCarloFan([trade(10)], "-500.00000000")).toBeUndefined();
  });

  it("a different seed produces a different fan over the same trades", () => {
    const trades = [trade(100), trade(-40), trade(60), trade(-20), trade(30), trade(-70), trade(15)];
    const a = computeMonteCarloFan(trades, "1000.00000000", { seed: 1 });
    const b = computeMonteCarloFan(trades, "1000.00000000", { seed: 2 });
    expect(a?.finalReturnPct).not.toEqual(b?.finalReturnPct);
  });
});
