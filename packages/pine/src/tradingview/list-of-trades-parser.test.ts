import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseListOfTrades } from "./list-of-trades-parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../pine/fixtures/tradingview");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("parseListOfTrades", () => {
  it("pairs entry/exit rows and computes closed trades (comma-delimited, ISO dates)", () => {
    const result = parseListOfTrades(loadFixture("list-of-trades-comma-iso.csv"));
    if (!result.ok) throw new Error(`Unexpected parse failure: ${result.message}`);

    expect(result.trades).toHaveLength(3);

    const trade1 = result.trades.find((t) => t.tradeNumber === 1);
    expect(trade1).toMatchObject({
      direction: "LONG",
      entryPrice: 43000.25,
      exitPrice: 43500.5,
      quantity: 0.01,
      grossPnl: 15.25,
      isOpen: false,
    });
    expect(trade1?.entryTime).toBe("2024-01-15T08:30:00.000Z");
    expect(trade1?.exitTime).toBe("2024-01-16T10:00:00.000Z");

    const trade2 = result.trades.find((t) => t.tradeNumber === 2);
    expect(trade2?.grossPnl).toBeCloseTo(-8.3);

    const trade3 = result.trades.find((t) => t.tradeNumber === 3);
    expect(trade3?.isOpen).toBe(true);
    expect(trade3?.direction).toBe("SHORT");
  });

  it("flags the unclosed trade with an OPEN_POSITION_AT_END warning", () => {
    const result = parseListOfTrades(loadFixture("list-of-trades-comma-iso.csv"));
    if (!result.ok) throw new Error("Unexpected parse failure");
    expect(result.warnings.some((w) => w.code === "OPEN_POSITION_AT_END")).toBe(true);
  });

  it("parses the semicolon/EU-locale variant identically in substance", () => {
    const result = parseListOfTrades(loadFixture("list-of-trades-semicolon-eu.csv"));
    if (!result.ok) throw new Error(`Unexpected parse failure: ${result.message}`);

    expect(result.trades).toHaveLength(2);
    const trade1 = result.trades.find((t) => t.tradeNumber === 1);
    expect(trade1).toMatchObject({ direction: "LONG", entryPrice: 43000.25, exitPrice: 43500.5, grossPnl: 15.25 });
    expect(trade1?.entryTime).toBe("2024-01-15T08:30:00.000Z");

    const trade2 = result.trades.find((t) => t.tradeNumber === 2);
    expect(trade2?.direction).toBe("SHORT");
    expect(trade2?.grossPnl).toBeCloseTo(4.9);
  });

  it("rejects a file with required columns missing rather than guessing", () => {
    const result = parseListOfTrades("Foo,Bar\n1,2");
    expect(result).toMatchObject({ ok: false, reasonCode: "MISSING_REQUIRED_COLUMNS" });
    if (result.ok !== false) throw new Error("expected failure");
    expect(result.missingColumns).toContain("Trade #");
  });

  it("rejects an empty file", () => {
    const result = parseListOfTrades("");
    expect(result).toMatchObject({ ok: false, reasonCode: "EMPTY_FILE" });
  });
});
