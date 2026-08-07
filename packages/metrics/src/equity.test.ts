import { describe, expect, it } from "vitest";
import { reconstructEquityCurve } from "./equity.js";
import type { MetricsTrade } from "./types.js";

const trades: MetricsTrade[] = [
  { tradeNumber: 1, direction: "LONG", entryTime: "2024-01-01T00:00:00.000Z", exitTime: "2024-01-02T00:00:00.000Z", netPnl: 100, isOpen: false },
  { tradeNumber: 2, direction: "LONG", entryTime: "2024-01-03T00:00:00.000Z", exitTime: "2024-01-03T12:00:00.000Z", netPnl: -40, isOpen: false },
  { tradeNumber: 3, direction: "SHORT", entryTime: "2024-01-10T00:00:00.000Z", exitTime: "2024-01-10T06:00:00.000Z", netPnl: -20, isOpen: false },
  { tradeNumber: 4, direction: "LONG", entryTime: "2024-02-01T00:00:00.000Z", exitTime: "2024-02-01T10:00:00.000Z", netPnl: 50, isOpen: false },
];

describe("reconstructEquityCurve", () => {
  it("starts at initial capital and applies each closed trade's net P&L in exit-time order", () => {
    const points = reconstructEquityCurve(trades, 1000);

    expect(points).toEqual([
      { sequenceNumber: 0, time: "2024-01-01T00:00:00.000Z", equity: "1000.00000000" },
      { sequenceNumber: 1, time: "2024-01-02T00:00:00.000Z", equity: "1100.00000000" },
      { sequenceNumber: 2, time: "2024-01-03T12:00:00.000Z", equity: "1060.00000000" },
      { sequenceNumber: 3, time: "2024-01-10T06:00:00.000Z", equity: "1040.00000000" },
      { sequenceNumber: 4, time: "2024-02-01T10:00:00.000Z", equity: "1090.00000000" },
    ]);
  });

  it("excludes open trades", () => {
    const withOpen: MetricsTrade[] = [
      ...trades,
      { tradeNumber: 5, direction: "LONG", entryTime: "2024-03-01T00:00:00.000Z", isOpen: true },
    ];
    const points = reconstructEquityCurve(withOpen, 1000);
    expect(points).toHaveLength(5); // unchanged — the open trade contributes no point
  });

  it("returns a single starting point when there are no closed trades", () => {
    const points = reconstructEquityCurve([], 500);
    expect(points).toEqual([{ sequenceNumber: 0, time: new Date(0).toISOString(), equity: "500.00000000" }]);
  });
});
