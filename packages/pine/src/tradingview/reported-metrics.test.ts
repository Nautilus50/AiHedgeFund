import { describe, expect, it } from "vitest";
import { extractReportedParityMetrics } from "./reported-metrics.js";
import type { PerformanceSummaryMetric } from "./types.js";

const metric = (name: string, values: Record<string, number | undefined>): PerformanceSummaryMetric => ({
  name,
  values,
});

describe("extractReportedParityMetrics", () => {
  it("reads all three figures from the absolute-value column", () => {
    const result = extractReportedParityMetrics([
      metric("Net Profit", { "All USD": 7.95, "All %": 0.08 }),
      metric("Total Closed Trades", { "All USD": 2 }),
      metric("Max Drawdown", { "All USD": 12.5 }),
    ]);

    expect(result).toEqual({ netProfit: 7.95, closedTradeCount: 2, maxDrawdown: 12.5 });
  });

  it("omits a figure the report never stated, rather than defaulting it to zero", () => {
    const result = extractReportedParityMetrics([metric("Net Profit", { "All USD": 7.95 })]);

    expect(result).toEqual({ netProfit: 7.95 });
    // Absent, not present-and-undefined: parity must be able to tell
    // "not reported" apart from "reported as nothing".
    expect("maxDrawdown" in result).toBe(false);
    expect("closedTradeCount" in result).toBe(false);
  });

  it("omits a metric whose value in that column failed to parse", () => {
    // The parser yields undefined for an unparseable number rather than
    // coercing it — that must not become a comparable 0 here either.
    const result = extractReportedParityMetrics([metric("Net Profit", { "All USD": undefined })]);

    expect(result).toEqual({});
  });

  it("matches titles case-insensitively and ignores surrounding whitespace", () => {
    const result = extractReportedParityMetrics([
      metric("  net profit  ", { "All USD": 3 }),
      metric("TOTAL CLOSED TRADES", { "All USD": 9 }),
    ]);

    expect(result).toEqual({ netProfit: 3, closedTradeCount: 9 });
  });

  it("ignores rows it does not recognise instead of guessing", () => {
    const result = extractReportedParityMetrics([
      metric("Sharpe Ratio", { "All USD": 1.4 }),
      metric("Profit Factor", { "All USD": 1.85 }),
      metric("Net Profit", { "All USD": 7.95 }),
    ]);

    expect(result).toEqual({ netProfit: 7.95 });
  });

  it("does not fall back to another column when the requested one is empty", () => {
    const result = extractReportedParityMetrics([metric("Net Profit", { "Long USD": 6.95, "All %": 0.08 })]);

    expect(result).toEqual({});
  });

  it("reads a caller-specified column, for long/short-only comparisons", () => {
    const result = extractReportedParityMetrics(
      [metric("Net Profit", { "All USD": 7.95, "Long USD": 6.95 })],
      "Long USD",
    );

    expect(result).toEqual({ netProfit: 6.95 });
  });

  it("rejects a non-finite value", () => {
    const result = extractReportedParityMetrics([metric("Net Profit", { "All USD": Number.NaN })]);

    expect(result).toEqual({});
  });

  it("returns nothing for an empty report", () => {
    expect(extractReportedParityMetrics([])).toEqual({});
  });
});
