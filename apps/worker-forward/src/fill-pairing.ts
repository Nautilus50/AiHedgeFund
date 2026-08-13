import type { MetricsTrade } from "@arf-os/metrics";

/** A `paper_fills` row joined with its `paper_orders` row (for direction and quantity, which live there). */
export interface PaperFillRow {
  sequenceNumber: number;
  role: "ENTRY" | "EXIT";
  direction: "LONG" | "SHORT";
  quantity: string;
  filledPrice: string;
  fees: string;
  filledAt: Date;
}

/**
 * Pairs a deployment's ENTRY/EXIT fills into `MetricsTrade[]`, the shape
 * `@arf-os/metrics`'s `reconstructEquityCurve`/`computeDrawdownCurve`/
 * `calculateCoreMetrics` already consume unchanged — mirrors the
 * entry/exit-row pairing shape in `packages/pine`'s list-of-trades parser,
 * operating on `paper_fills` rows instead of CSV rows. Unlike that parser,
 * `role` is already explicit on every row (no type-string inference
 * needed), and one open position at a time (no pyramiding, matching every
 * other runner in this repo) means pairing is a simple stack of depth ≤ 1:
 * an ENTRY opens the pending trade, the next EXIT closes it.
 */
export function pairPaperFillsIntoTrades(fills: readonly PaperFillRow[]): MetricsTrade[] {
  const ordered = [...fills].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const trades: MetricsTrade[] = [];
  let pending:
    | { tradeNumber: number; direction: "LONG" | "SHORT"; entryTime: string; entryPrice: number; quantity: number; entryFees: number }
    | undefined;
  let tradeNumber = 0;

  for (const fill of ordered) {
    if (fill.role === "ENTRY") {
      tradeNumber += 1;
      pending = {
        tradeNumber,
        direction: fill.direction,
        entryTime: fill.filledAt.toISOString(),
        entryPrice: Number(fill.filledPrice),
        quantity: Number(fill.quantity),
        entryFees: Number(fill.fees),
      };
      continue;
    }

    // EXIT with nothing open shouldn't happen — the processing worker
    // rejects that signal before ever writing a fill — but skip rather
    // than throw if it's ever seen, so a read path never crashes on data
    // written by a future bug.
    if (!pending) continue;

    const exitPrice = Number(fill.filledPrice);
    const priceDelta = pending.direction === "LONG" ? exitPrice - pending.entryPrice : pending.entryPrice - exitPrice;
    const netPnl = priceDelta * pending.quantity - pending.entryFees - Number(fill.fees);

    trades.push({
      tradeNumber: pending.tradeNumber,
      direction: pending.direction,
      entryTime: pending.entryTime,
      exitTime: fill.filledAt.toISOString(),
      netPnl,
      isOpen: false,
    });
    pending = undefined;
  }

  if (pending) {
    trades.push({
      tradeNumber: pending.tradeNumber,
      direction: pending.direction,
      entryTime: pending.entryTime,
      isOpen: true,
    });
  }

  return trades;
}
