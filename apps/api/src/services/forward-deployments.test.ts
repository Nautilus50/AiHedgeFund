import { describe, expect, it } from "vitest";
import { classifyInfrastructureHealth, classifyStrategyPerformanceHealth } from "./forward-deployments.js";

describe("classifyInfrastructureHealth", () => {
  it("is HEALTHY with no recent signals", () => {
    expect(classifyInfrastructureHealth([])).toEqual({ health: "HEALTHY", reasons: [], rejectionRate: 0 });
  });

  it("is HEALTHY exactly at the 0.5 rejection-rate threshold, not above it", () => {
    const signals = [
      { processingStatus: "REJECTED", rejectionReason: "DUPLICATE" },
      { processingStatus: "PROCESSED", rejectionReason: null },
    ];
    const result = classifyInfrastructureHealth(signals);
    expect(result.rejectionRate).toBe(0.5);
    expect(result.health).toBe("HEALTHY");
  });

  it("is DEGRADED just above the 0.5 threshold, with deduped reasons", () => {
    const signals = [
      { processingStatus: "REJECTED", rejectionReason: "DUPLICATE" },
      { processingStatus: "REJECTED", rejectionReason: "DUPLICATE" },
      { processingStatus: "REJECTED", rejectionReason: "STALE_TIMESTAMP" },
      { processingStatus: "PROCESSED", rejectionReason: null },
    ];
    const result = classifyInfrastructureHealth(signals);
    expect(result.rejectionRate).toBe(0.75);
    expect(result.health).toBe("DEGRADED");
    expect(result.reasons.sort()).toEqual(["DUPLICATE", "STALE_TIMESTAMP"]);
  });

  it("reports no reasons when HEALTHY, even if some signals were rejected", () => {
    const signals = [
      { processingStatus: "REJECTED", rejectionReason: "DUPLICATE" },
      { processingStatus: "PROCESSED", rejectionReason: null },
      { processingStatus: "PROCESSED", rejectionReason: null },
    ];
    const result = classifyInfrastructureHealth(signals);
    expect(result.health).toBe("HEALTHY");
    expect(result.reasons).toEqual([]);
  });
});

describe("classifyStrategyPerformanceHealth", () => {
  it("is NOT_CONFIGURED when no threshold is set, regardless of drawdown", () => {
    expect(classifyStrategyPerformanceHealth(5, null)).toBe("NOT_CONFIGURED");
    expect(classifyStrategyPerformanceHealth(null, null)).toBe("NOT_CONFIGURED");
  });

  it("is DRAWDOWN_ALERT exactly at the threshold, not only above it", () => {
    expect(classifyStrategyPerformanceHealth(10, 10)).toBe("DRAWDOWN_ALERT");
  });

  it("is OK strictly below the threshold", () => {
    expect(classifyStrategyPerformanceHealth(9.99, 10)).toBe("OK");
  });

  it("treats a null current drawdown as 0", () => {
    expect(classifyStrategyPerformanceHealth(null, 5)).toBe("OK");
    expect(classifyStrategyPerformanceHealth(null, 0)).toBe("DRAWDOWN_ALERT");
  });
});
