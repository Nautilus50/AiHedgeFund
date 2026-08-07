import { describe, expect, it, vi } from "vitest";
import {
  hashPineManifest,
  hashPineSource,
  hashStrategyDefinition,
  saveStrategyDefinition,
} from "./strategy-registry.js";

const validDefinition = {
  schemaVersion: "1.0.0",
  strategy: { name: "Test", family: "trend_following", thesis: "x", directions: ["long"] },
  market: {
    assetClass: "crypto",
    symbols: ["BYBIT:BTCUSDT.P"],
    timeframe: "60",
    timezone: "Etc/UTC",
    session: "0000-2359:1234567",
    chartType: "standard_ohlc",
  },
  signals: { longEntry: "a", shortEntry: "b" },
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
    leverage: 1,
    stopLoss: { type: "atr_multiple", valueParameter: "stop_atr" },
    takeProfit: { type: "risk_multiple", valueParameter: "target_r" },
    oneStopOneTarget: true,
  },
  costs: { commissionType: "percent", commissionValue: 0.05, slippageTicks: 0 },
  parameters: [],
  segments: { warmupBars: 100, selectionMode: "fixed_parameters", embargoBars: 0 },
  falsification: ["OOS net profit is non-positive."],
};

describe("hashPineSource", () => {
  it("is deterministic for identical source", () => {
    expect(hashPineSource("//@version=6\nstrategy(\"x\")")).toBe(hashPineSource("//@version=6\nstrategy(\"x\")"));
  });

  it("differs on any whitespace change (formatting is a different revision)", () => {
    expect(hashPineSource("a")).not.toBe(hashPineSource("a "));
  });
});

describe("hashStrategyDefinition", () => {
  it("is independent of key order", () => {
    const reordered = { ...validDefinition, strategy: { ...validDefinition.strategy } };
    expect(hashStrategyDefinition(validDefinition as never)).toBe(hashStrategyDefinition(reordered as never));
  });

  it("changes when a risk parameter changes", () => {
    const changed = { ...validDefinition, risk: { ...validDefinition.risk, sizePercent: 20 } };
    expect(hashStrategyDefinition(validDefinition as never)).not.toBe(hashStrategyDefinition(changed as never));
  });
});

describe("hashPineManifest", () => {
  it("is deterministic and key-order independent", () => {
    expect(hashPineManifest({ a: 1, b: 2 })).toBe(hashPineManifest({ b: 2, a: 1 }));
  });
});

describe("saveStrategyDefinition", () => {
  it("rejects an invalid definition without touching the database", async () => {
    const fakeDb = { transaction: vi.fn() } as never;
    const result = await saveStrategyDefinition(fakeDb, {
      strategyVersionId: "sv-1",
      definition: { schemaVersion: "1.0.0" }, // missing every other required field
    });

    expect(result).toMatchObject({ ok: false, reasonCode: "INVALID_DEFINITION" });
    expect((fakeDb as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });

  it("rejects pyramiding > 0 before ever reaching the database", async () => {
    const fakeDb = { transaction: vi.fn() } as never;
    const result = await saveStrategyDefinition(fakeDb, {
      strategyVersionId: "sv-1",
      definition: { ...validDefinition, execution: { ...validDefinition.execution, pyramiding: 1 } },
    });

    expect(result.ok).toBe(false);
  });
});
