import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePerformanceSummary } from "./performance-summary-parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../pine/fixtures/tradingview");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("parsePerformanceSummary", () => {
  it("preserves each segment column under its exact source header", () => {
    const result = parsePerformanceSummary(loadFixture("performance-summary-comma.csv"));
    if (!result.ok) throw new Error(`Unexpected parse failure: ${result.message}`);

    expect(result.metrics).toHaveLength(4);

    const netProfit = result.metrics.find((m) => m.name === "Net Profit");
    expect(netProfit?.values["All USD"]).toBeCloseTo(7.95);
    expect(netProfit?.values["Long USD"]).toBeCloseTo(6.95);
    expect(netProfit?.values["Short USD"]).toBeCloseTo(1.0);

    const profitFactor = result.metrics.find((m) => m.name === "Profit Factor");
    expect(profitFactor?.values["All USD"]).toBeCloseTo(1.85);
    expect(profitFactor?.values["Long USD"]).toBeUndefined();
  });

  it("rejects a file with no Title column", () => {
    const result = parsePerformanceSummary("A,B\n1,2");
    expect(result).toMatchObject({ ok: false, reasonCode: "MISSING_REQUIRED_COLUMNS" });
  });

  it("rejects an empty file", () => {
    expect(parsePerformanceSummary("")).toMatchObject({ ok: false, reasonCode: "EMPTY_FILE" });
  });
});
