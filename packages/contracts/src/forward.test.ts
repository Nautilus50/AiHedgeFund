import { describe, expect, it } from "vitest";
import { CreateForwardDeploymentInput, ForwardFillModel } from "./forward.js";

function validFillModel() {
  return {
    fillModelVersion: "1.0.0",
    latencyModel: { type: "fixed_seconds", seconds: 2 },
    slippageModel: { type: "fixed_percent", value: 0.05 },
    commissionModel: { type: "percent", value: 0.04 },
    quantityModel: { type: "percent_of_equity", percent: 10 },
    stopTargetRule: { type: "external_alert_only" },
  };
}

describe("ForwardFillModel", () => {
  it("accepts a well-formed fill model with every CLAUDE.md 16.2 field present", () => {
    expect(ForwardFillModel.safeParse(validFillModel()).success).toBe(true);
  });

  it("rejects a quantity model missing its discriminated fields", () => {
    const model = { ...validFillModel(), quantityModel: { type: "fixed" } };
    expect(ForwardFillModel.safeParse(model).success).toBe(false);
  });

  it("rejects negative slippage", () => {
    const model = { ...validFillModel(), slippageModel: { type: "fixed_percent", value: -1 } };
    expect(ForwardFillModel.safeParse(model).success).toBe(false);
  });

  it("does not carry a slippageTicks field the way backtest's CostModel does — one slippage source of truth", () => {
    const parsed = ForwardFillModel.parse(validFillModel());
    expect(parsed.slippageModel.type).toBe("fixed_percent");
    expect("slippageTicks" in parsed).toBe(false);
  });
});

describe("CreateForwardDeploymentInput", () => {
  function validInput() {
    return {
      strategyVersionId: "019ff901-4814-7098-bf99-dbad6d5f68fb",
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: validFillModel(),
    };
  }

  it("accepts a well-formed deployment request without a drawdown threshold configured", () => {
    expect(CreateForwardDeploymentInput.safeParse(validInput()).success).toBe(true);
  });

  it("accepts an explicit maxDrawdownPctAlertThreshold", () => {
    const input = { ...validInput(), maxDrawdownPctAlertThreshold: 20 };
    expect(CreateForwardDeploymentInput.safeParse(input).success).toBe(true);
  });

  it("rejects a threshold above 100 percent", () => {
    const input = { ...validInput(), maxDrawdownPctAlertThreshold: 150 };
    expect(CreateForwardDeploymentInput.safeParse(input).success).toBe(false);
  });

  it("rejects a non-positive initial capital", () => {
    const input = { ...validInput(), initialCapital: 0 };
    expect(CreateForwardDeploymentInput.safeParse(input).success).toBe(false);
  });
});
