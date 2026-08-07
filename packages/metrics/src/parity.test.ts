import { describe, expect, it } from "vitest";
import { compareParity } from "./parity.js";

const local = { closedTradeCount: 4, netProfit: 90, maxDrawdown: 60 };

describe("compareParity", () => {
  it("passes when TradingView-reported values match exactly", () => {
    const report = compareParity(local, { closedTradeCount: 4, netProfit: 90, maxDrawdown: 60 });
    expect(report.status).toBe("PASS");
    expect(report.firstDivergence).toBeUndefined();
  });

  it("passes within a small tolerance", () => {
    const report = compareParity(local, { closedTradeCount: 4, netProfit: 90.5, maxDrawdown: 60 });
    expect(report.status).toBe("PASS");
  });

  it("warns when net profit diverges beyond pass tolerance but within warn tolerance", () => {
    const report = compareParity(local, { closedTradeCount: 4, netProfit: 87, maxDrawdown: 60 });
    expect(report.status).toBe("WARN");
    expect(report.firstDivergence).toBe("netProfit");
  });

  it("fails on any trade-count mismatch, reported as the first divergence", () => {
    const report = compareParity(local, { closedTradeCount: 3, netProfit: 90, maxDrawdown: 60 });
    expect(report.status).toBe("FAIL");
    expect(report.firstDivergence).toBe("closedTradeCount");
  });

  it("fails when net profit diverges beyond warn tolerance", () => {
    const report = compareParity(local, { closedTradeCount: 4, netProfit: 50, maxDrawdown: 60 });
    expect(report.status).toBe("FAIL");
  });

  it("reports INSUFFICIENT_DATA when TradingView provided nothing comparable", () => {
    const report = compareParity(local, {});
    expect(report.status).toBe("INSUFFICIENT_DATA");
    expect(report.firstDivergence).toBeUndefined();
  });

  it("reports the first divergence in field order, not severity order", () => {
    // netProfit WARN-level, maxDrawdown FAIL-level — netProfit still comes first.
    const report = compareParity(local, { closedTradeCount: 4, netProfit: 87, maxDrawdown: 10 });
    expect(report.firstDivergence).toBe("netProfit");
    expect(report.status).toBe("FAIL");
  });
});
