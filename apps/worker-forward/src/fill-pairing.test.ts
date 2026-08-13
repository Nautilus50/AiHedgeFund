import { describe, expect, it } from "vitest";
import { pairPaperFillsIntoTrades, type PaperFillRow } from "./fill-pairing.js";

function fill(overrides: Partial<PaperFillRow> & Pick<PaperFillRow, "sequenceNumber" | "role" | "direction">): PaperFillRow {
  return {
    quantity: "1",
    filledPrice: "100",
    fees: "0",
    filledAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("pairPaperFillsIntoTrades", () => {
  it("pairs a clean entry/exit round trip with a hand-calculated net P&L", () => {
    const trades = pairPaperFillsIntoTrades([
      fill({
        sequenceNumber: 1,
        role: "ENTRY",
        direction: "LONG",
        quantity: "1",
        filledPrice: "100",
        fees: "0.1",
        filledAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      fill({
        sequenceNumber: 2,
        role: "EXIT",
        direction: "LONG",
        filledPrice: "110",
        fees: "0.1",
        filledAt: new Date("2026-01-01T01:00:00.000Z"),
      }),
    ]);

    expect(trades).toEqual([
      {
        tradeNumber: 1,
        direction: "LONG",
        entryTime: "2026-01-01T00:00:00.000Z",
        exitTime: "2026-01-01T01:00:00.000Z",
        // (110 - 100) * 1 - 0.1 - 0.1 = 9.8
        netPnl: 9.8,
        isOpen: false,
      },
    ]);
  });

  it("computes a SHORT trade's P&L in the opposite direction, scaled by quantity", () => {
    const trades = pairPaperFillsIntoTrades([
      fill({ sequenceNumber: 1, role: "ENTRY", direction: "SHORT", quantity: "2", filledPrice: "200", fees: "0.5" }),
      fill({ sequenceNumber: 2, role: "EXIT", direction: "SHORT", filledPrice: "190", fees: "0.5" }),
    ]);

    // (200 - 190) * 2 - 0.5 - 0.5 = 19
    expect(trades[0]?.netPnl).toBe(19);
  });

  it("leaves a trade with no exit fill still open, with no net P&L", () => {
    const trades = pairPaperFillsIntoTrades([
      fill({ sequenceNumber: 1, role: "ENTRY", direction: "LONG", filledPrice: "100" }),
    ]);

    expect(trades).toEqual([
      { tradeNumber: 1, direction: "LONG", entryTime: "2026-01-01T00:00:00.000Z", isOpen: true },
    ]);
  });

  it("numbers trades sequentially across a full history of round trips", () => {
    const trades = pairPaperFillsIntoTrades([
      fill({ sequenceNumber: 1, role: "ENTRY", direction: "LONG", filledPrice: "100" }),
      fill({ sequenceNumber: 2, role: "EXIT", direction: "LONG", filledPrice: "105" }),
      fill({ sequenceNumber: 3, role: "ENTRY", direction: "SHORT", filledPrice: "105" }),
      fill({ sequenceNumber: 4, role: "EXIT", direction: "SHORT", filledPrice: "100" }),
    ]);

    expect(trades.map((t) => t.tradeNumber)).toEqual([1, 2]);
    expect(trades.every((t) => !t.isOpen)).toBe(true);
  });

  it("sorts by sequenceNumber rather than trusting array order", () => {
    const trades = pairPaperFillsIntoTrades([
      fill({ sequenceNumber: 2, role: "EXIT", direction: "LONG", filledPrice: "110" }),
      fill({ sequenceNumber: 1, role: "ENTRY", direction: "LONG", filledPrice: "100" }),
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]?.isOpen).toBe(false);
  });
});
