import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BacktestPlan, StrategyDefinition } from "@arf-os/contracts";
import { parseOhlcvCsv } from "@arf-os/pine";
import type { Bar, OhlcvParseResult } from "@arf-os/pine";
import { describe, expect, it } from "vitest";
import { simulate } from "./simulate.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../../pine/fixtures/ohlcv/golden-crossover.csv", import.meta.url),
);

function loadGoldenBars(): Bar[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const result = parseOhlcvCsv(raw) as OhlcvParseResult;
  if (!result.ok) throw new Error("golden fixture failed to parse");
  return result.bars;
}

/**
 * Long-only SMA(3)/SMA(7) crossover. Hand-calculated against
 * pine/fixtures/ohlcv/golden-crossover.csv (see that file's bars): the
 * crossover signal fires on the close of the bar at 07:00, entry fills at
 * the 08:00 bar's open (110), and the take-profit (10% above entry = 121)
 * is touched by the 11:00 bar's high (123) — the stop-loss (5% below entry
 * = 104.5) is never touched.
 */
function goldenDefinition(): StrategyDefinition {
  return {
    schemaVersion: "1.0.0",
    strategy: { name: "Golden Crossover", family: "trend", thesis: "SMA crossover", directions: ["long"] },
    market: {
      assetClass: "crypto",
      symbols: ["BTCUSD"],
      timeframe: "1h",
      timezone: "UTC",
      session: "24x7",
      chartType: "standard_ohlc",
    },
    signals: {
      longEntry: "ta.crossover(ta.sma(close, 3), ta.sma(close, 7))",
      shortEntry: "false",
    },
    execution: {
      entryOrder: "market_next_bar",
      pyramiding: 0,
      allowReversal: false,
      processOnClose: true,
      calcOnEveryTick: false,
    },
    risk: {
      sizingModel: "percent_of_equity",
      sizePercent: 10,
      leverage: 1,
      stopLoss: { type: "fixed_percent", valueParameter: "stop_pct" },
      takeProfit: { type: "fixed_percent", valueParameter: "target_pct" },
      oneStopOneTarget: true,
    },
    costs: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
    parameters: [
      { key: "stop_pct", type: "float", default: 5, min: 0, max: 50, step: 0.5 },
      { key: "target_pct", type: "float", default: 10, min: 0, max: 100, step: 0.5 },
    ],
    segments: { warmupBars: 7, selectionMode: "fixed_parameters", embargoBars: 0 },
    falsification: ["Crossover lag underperforms buy-and-hold in strong trends"],
  };
}

function goldenPlan(): BacktestPlan {
  return {
    strategyVersionId: "00000000-0000-0000-0000-000000000000",
    runnerType: "LOCAL_RUNNER",
    symbol: "BTCUSD",
    timeframe: "1h",
    segmentKind: "IN_SAMPLE",
    fromTs: "2024-01-01T00:00:00.000Z",
    toTs: "2024-01-01T14:00:00.000Z",
    costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
    initialCapital: 11000,
  };
}

describe("simulate — golden crossover fixture", () => {
  it("produces exactly one closed trade matching the hand-calculated values", () => {
    const bars = loadGoldenBars();
    const result = simulate(bars, goldenDefinition(), goldenPlan());

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    if (trade === undefined) throw new Error("expected a trade");

    expect(trade.direction).toBe("LONG");
    expect(trade.entryTime).toBe("2024-01-01T08:00:00.000Z");
    expect(trade.entryPrice).toBeCloseTo(110);
    expect(trade.quantity).toBeCloseTo(10); // 10% of 11000 equity / 110 entry price
    expect(trade.exitTime).toBe("2024-01-01T11:00:00.000Z");
    expect(trade.exitPrice).toBeCloseTo(121); // take-profit: 110 * 1.10
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.grossPnl).toBeCloseTo(110); // (121 - 110) * 10
    expect(trade.fees).toBeCloseTo(2.31); // (1100 + 1210) * 0.001
    expect(trade.netPnl).toBeCloseTo(107.69);
    expect(trade.isOpen).toBe(false);
  });

  it("emits no warnings when the position closes before the data ends", () => {
    const bars = loadGoldenBars();
    const result = simulate(bars, goldenDefinition(), goldenPlan());
    expect(result.warnings).toEqual([]);
  });

  it("marks a trade open when data ends before stop or target is hit", () => {
    const bars = loadGoldenBars().slice(0, 9); // stop right after entry, before the target bar
    const result = simulate(bars, goldenDefinition(), goldenPlan());
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.isOpen).toBe(true);
    expect(result.trades[0]?.exitTime).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });
});

/**
 * Donchian-channel-breakout entry with a one-time ATR-multiple stop and no
 * target — the "faithful entries, simplified exit" extension (no ratcheting
 * trail, no drawdown halt; see docs/adr/0005-local-pine-runner.md's
 * extension section). Bars are handcrafted inline; TR/ATR are re-derived
 * from Wilder's own formula in this test rather than by calling the
 * production code, so the test can't just be checking itself.
 */
function donchianBars(): Bar[] {
  const rows: Array<{ open: number; high: number; low: number; close: number }> = [
    { open: 100, high: 102, low: 99, close: 100 },
    { open: 100, high: 103, low: 99, close: 101 },
    { open: 101, high: 104, low: 100, close: 102 },
    { open: 102, high: 103, low: 101, close: 102 },
    { open: 102, high: 112, low: 105, close: 110 }, // close breaks the 3-bar-high-as-of-one-bar-ago (104) — signal fires here
    { open: 110, high: 115, low: 108, close: 112 }, // entry fills at this bar's open (110)
    { open: 112, high: 113, low: 100, close: 101 }, // low touches the ATR stop
  ];
  return rows.map((r, i) => ({ time: `2024-02-01T${String(i).padStart(2, "0")}:00:00Z`, volume: 1000, ...r }));
}

function donchianDefinition(): StrategyDefinition {
  return {
    schemaVersion: "1.0.0",
    strategy: { name: "Golden Donchian Breakout", family: "trend", thesis: "channel breakout, ATR stop", directions: ["long"] },
    market: {
      assetClass: "crypto",
      symbols: ["BTCUSD"],
      timeframe: "1h",
      timezone: "UTC",
      session: "24x7",
      chartType: "standard_ohlc",
    },
    signals: {
      // The `[1]` avoids reading the current bar's own high into its own breakout level (CLAUDE.md 12.2 — no lookahead).
      longEntry: "close > ta.highest(high, 3)[1]",
      shortEntry: "false",
    },
    execution: {
      entryOrder: "market_next_bar",
      pyramiding: 0,
      allowReversal: false,
      processOnClose: true,
      calcOnEveryTick: false,
    },
    risk: {
      sizingModel: "percent_of_equity",
      sizePercent: 10,
      leverage: 1,
      stopLoss: { type: "atr_multiple", valueParameter: "atr_mult", atrLengthParameter: "atr_len" },
      takeProfit: { type: "none" },
      oneStopOneTarget: true,
    },
    costs: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
    parameters: [
      { key: "atr_mult", type: "float", default: 1.5, min: 0.5, max: 8, step: 0.5 },
      { key: "atr_len", type: "int", default: 3, min: 2, max: 50, step: 1 },
    ],
    segments: { warmupBars: 4, selectionMode: "fixed_parameters", embargoBars: 0 },
    falsification: ["Breakout entries lag in choppy, range-bound markets"],
  };
}

function donchianPlan(): BacktestPlan {
  return {
    strategyVersionId: "00000000-0000-0000-0000-000000000000",
    runnerType: "LOCAL_RUNNER",
    symbol: "BTCUSD",
    timeframe: "1h",
    segmentKind: "IN_SAMPLE",
    fromTs: "2024-02-01T00:00:00.000Z",
    toTs: "2024-02-01T06:00:00.000Z",
    costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
    initialCapital: 11000,
  };
}

describe("simulate — golden Donchian breakout + ATR-stop fixture", () => {
  it("enters on the channel breakout and exits at the one-time ATR stop", () => {
    // True Range per bar, hand-computed from donchianBars() (bar 0 has no
    // prior close, so TR0 = high - low):
    const [tr0, tr1, tr2, tr3, tr4, tr5]: [number, number, number, number, number, number] = [3, 4, 4, 2, 10, 7];
    // Wilder's RMA: seed with the SMA of the first 3, then alpha = 1/3 per step.
    const seed = (tr0 + tr1 + tr2) / 3;
    const atrAt3 = tr3 * (1 / 3) + seed * (2 / 3);
    const atrAt4 = tr4 * (1 / 3) + atrAt3 * (2 / 3);
    const atrAtEntry = tr5 * (1 / 3) + atrAt4 * (2 / 3); // ATR at index 5, the entry bar

    const entryPrice = 110;
    const atrMultiple = 1.5;
    const expectedStopPrice = entryPrice - atrMultiple * atrAtEntry;
    const quantity = 10; // 10% of 11000 initial equity / 110 entry price
    const expectedGrossPnl = (expectedStopPrice - entryPrice) * quantity;
    const expectedFees = (entryPrice * quantity + expectedStopPrice * quantity) * 0.001;
    const expectedNetPnl = expectedGrossPnl - expectedFees;

    const result = simulate(donchianBars(), donchianDefinition(), donchianPlan());

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    if (trade === undefined) throw new Error("expected a trade");

    expect(trade.direction).toBe("LONG");
    expect(trade.entryTime).toBe("2024-02-01T05:00:00Z");
    expect(trade.entryPrice).toBeCloseTo(entryPrice);
    expect(trade.quantity).toBeCloseTo(quantity);
    expect(trade.exitTime).toBe("2024-02-01T06:00:00Z");
    expect(trade.exitPrice).toBeCloseTo(expectedStopPrice);
    expect(trade.exitReason).toBe("stop_loss");
    expect(trade.grossPnl).toBeCloseTo(expectedGrossPnl);
    expect(trade.fees).toBeCloseTo(expectedFees);
    expect(trade.netPnl).toBeCloseTo(expectedNetPnl);
    expect(trade.isOpen).toBe(false);
  });

  it("never enters before the channel breakout actually happens", () => {
    const result = simulate(donchianBars().slice(0, 4), donchianDefinition(), donchianPlan());
    expect(result.trades).toHaveLength(0);
  });
});
