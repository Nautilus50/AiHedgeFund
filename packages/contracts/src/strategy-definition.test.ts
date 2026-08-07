import { describe, expect, it } from "vitest";
import { StrategyDefinition } from "./strategy-definition.js";

const validDefinition = {
  schemaVersion: "1.0.0",
  strategy: {
    name: "Example Trend Pullback",
    family: "trend_following",
    thesis: "Enter pullbacks in a confirmed higher-timeframe trend.",
    directions: ["long", "short"],
  },
  market: {
    assetClass: "crypto",
    symbols: ["BYBIT:BTCUSDT.P"],
    timeframe: "60",
    timezone: "Etc/UTC",
    session: "0000-2359:1234567",
    chartType: "standard_ohlc",
  },
  signals: {
    longEntry: "trend_fast_above_slow AND pullback_recovery AND confirmed_bar",
    shortEntry: "trend_fast_below_slow AND pullback_rejection AND confirmed_bar",
  },
  execution: {
    entryOrder: "market_next_bar",
    pyramiding: 0,
    allowReversal: false,
    processOnClose: false,
    calcOnEveryTick: false,
  },
  risk: {
    sizingModel: "percent_of_equity",
    sizePercent: 10,
    leverage: 3,
    stopLoss: { type: "atr_multiple", valueParameter: "stop_atr" },
    takeProfit: { type: "risk_multiple", valueParameter: "target_r" },
    oneStopOneTarget: true,
  },
  costs: {
    commissionType: "percent",
    commissionValue: 0.06,
    slippageTicks: 2,
  },
  parameters: [
    { key: "fast_length", type: "int", default: 20, min: 10, max: 50, step: 5 },
    { key: "slow_length", type: "int", default: 100, min: 60, max: 200, step: 10 },
  ],
  segments: {
    warmupBars: 300,
    selectionMode: "rolling_walk_forward",
    embargoBars: 10,
  },
  falsification: ["Out-of-sample net profit is non-positive."],
};

describe("StrategyDefinition", () => {
  it("accepts the canonical spec example (AI_RESEARCH_HEDGE_FUND_SPEC.md 9.1)", () => {
    const result = StrategyDefinition.safeParse(validDefinition);
    expect(result.success).toBe(true);
  });

  it("rejects pyramiding > 0 (CLAUDE.md 3.9 / 11.6 — no pyramiding by default)", () => {
    const result = StrategyDefinition.safeParse({
      ...validDefinition,
      execution: { ...validDefinition.execution, pyramiding: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a parameter with min > max", () => {
    const result = StrategyDefinition.safeParse({
      ...validDefinition,
      parameters: [{ key: "bad", type: "int", default: 5, min: 100, max: 1, step: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty falsification list (spec 9.1 requires pre-registered failure conditions)", () => {
    const result = StrategyDefinition.safeParse({ ...validDefinition, falsification: [] });
    expect(result.success).toBe(false);
  });
});
