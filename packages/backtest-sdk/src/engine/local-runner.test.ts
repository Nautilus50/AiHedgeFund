import type { StrategyDefinition } from "@arf-os/contracts";
import { describe, expect, it } from "vitest";
import { createLocalPineRunner } from "./local-runner.js";

function baseDefinition(): StrategyDefinition {
  return {
    schemaVersion: "1.0.0",
    strategy: { name: "Test", family: "trend", thesis: "test", directions: ["long"] },
    market: {
      assetClass: "crypto",
      symbols: ["BTCUSD"],
      timeframe: "1h",
      timezone: "UTC",
      session: "24x7",
      chartType: "standard_ohlc",
    },
    signals: { longEntry: "ta.crossover(ta.sma(close, 3), ta.sma(close, 7))", shortEntry: "false" },
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
    falsification: ["test"],
  };
}

describe("createLocalPineRunner", () => {
  it("declares its real, current constraints via capabilities()", () => {
    const runner = createLocalPineRunner();
    const capabilities = runner.capabilities();
    expect(capabilities.supportedEntryOrders).toEqual(["market_next_bar"]);
    expect(capabilities.supportedStopLossTypes).toEqual(["fixed_percent", "atr_multiple"]);
    expect(capabilities.supportedTakeProfitTypes).toEqual(["fixed_percent", "none"]);
    expect(capabilities.supportedExpressionFunctions).toEqual(
      expect.arrayContaining(["ta.highest", "ta.lowest", "ta.atr"]),
    );
    expect(capabilities.supportsSessionFilter).toBe(false);
    expect(capabilities.supportsNonZeroTickSlippage).toBe(false);
    expect(capabilities.supportsPersistentState).toBe(false);
  });

  it("compiles a valid, supported strategy definition", async () => {
    const runner = createLocalPineRunner();
    const result = await runner.compile({ definition: baseDefinition() });
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported entry order at compile time", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.execution.entryOrder = "stop";
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes('entryOrder "stop"'))).toBe(true);
  });

  it("rejects an unsupported stop-loss type at compile time", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.risk.stopLoss = { type: "risk_multiple", valueParameter: "r_mult" };
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes('stopLoss.type "risk_multiple"'))).toBe(true);
  });

  it("accepts an atr_multiple stop with a valid atrLengthParameter", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.risk.stopLoss = { type: "atr_multiple", valueParameter: "atr_mult", atrLengthParameter: "atr_len" };
    definition.risk.takeProfit = { type: "none" };
    definition.parameters.push(
      { key: "atr_mult", type: "float", default: 2, min: 0.5, max: 8, step: 0.5 },
      { key: "atr_len", type: "int", default: 14, min: 5, max: 50, step: 1 },
    );
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(true);
  });

  it("rejects an atr_multiple stop whose atrLengthParameter isn't a declared numeric parameter", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.risk.stopLoss = { type: "atr_multiple", valueParameter: "atr_mult", atrLengthParameter: "nope" };
    definition.parameters.push({ key: "atr_mult", type: "float", default: 2, min: 0.5, max: 8, step: 0.5 });
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes('atrLengthParameter "nope"'))).toBe(true);
  });

  it("accepts a stop-only strategy (takeProfit.type = \"none\")", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.risk.takeProfit = { type: "none" };
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(true);
  });

  it("rejects nonzero slippage ticks at compile time", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.costs.slippageTicks = 2;
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("slippageTicks must be 0"))).toBe(true);
  });

  it("rejects an unparseable signal expression with a clear diagnostic", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.signals.longEntry = "close >";
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.startsWith("signals.longEntry:"))).toBe(true);
  });

  it("rejects an unknown identifier in a signal expression", async () => {
    const runner = createLocalPineRunner();
    const definition = baseDefinition();
    definition.signals.longEntry = "close > mysteryValue";
    const result = await runner.compile({ definition });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes('Unknown identifier "mysteryValue"'))).toBe(true);
  });

  it("cancel() before run() prevents that run from starting", async () => {
    const runner = createLocalPineRunner();
    await runner.cancel("run-1");
    const result = await runner.run({
      runId: "run-1",
      definition: baseDefinition(),
      plan: {
        strategyVersionId: "00000000-0000-0000-0000-000000000000",
        runnerType: "LOCAL_RUNNER",
        symbol: "BTCUSD",
        timeframe: "1h",
        segmentKind: "IN_SAMPLE",
        fromTs: "2024-01-01T00:00:00.000Z",
        toTs: "2024-01-01T01:00:00.000Z",
        costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
        initialCapital: 10000,
      },
      bars: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errorCode).toBe("CANCELLED");
  });
});
