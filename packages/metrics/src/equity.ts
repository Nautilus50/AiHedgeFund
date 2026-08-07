import { toDecimal, type Decimal } from "./decimal.js";
import type { MetricsTrade } from "./types.js";

export interface EquityPoint {
  sequenceNumber: number;
  time: string;
  equity: string;
}

/**
 * Reconstructs the equity curve from the trade ledger alone — never reads
 * an equity value out of a screenshot or a runner-reported summary
 * (CLAUDE.md 26). Closed trades are applied in exit-time order; the curve
 * starts at initialCapital before any trade closes.
 */
export function reconstructEquityCurve(
  trades: readonly MetricsTrade[],
  initialCapital: number | string,
): EquityPoint[] {
  const closed = trades
    .filter((t): t is MetricsTrade & { netPnl: number; exitTime: string } => !t.isOpen && t.netPnl !== undefined && t.exitTime !== undefined)
    .sort((a, b) => a.exitTime.localeCompare(b.exitTime));

  let equity: Decimal = toDecimal(initialCapital);
  const points: EquityPoint[] = [
    { sequenceNumber: 0, time: closed[0]?.entryTime ?? new Date(0).toISOString(), equity: equity.toFixed(8) },
  ];

  closed.forEach((trade, index) => {
    equity = equity.plus(trade.netPnl);
    points.push({ sequenceNumber: index + 1, time: trade.exitTime, equity: equity.toFixed(8) });
  });

  return points;
}
