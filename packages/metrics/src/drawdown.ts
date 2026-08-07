import { Decimal, toDecimal } from "./decimal.js";
import type { EquityPoint } from "./equity.js";

export interface DrawdownPoint {
  sequenceNumber: number;
  time: string;
  drawdown: string;
  drawdownPct: number;
}

export interface DrawdownResult {
  points: DrawdownPoint[];
  maxDrawdown: string;
  maxDrawdownPct: number;
}

/**
 * Computes drawdown from the reconstructed equity curve (never independently
 * estimated). Drawdown is reported as a positive magnitude: distance below
 * the running peak.
 */
export function computeDrawdownCurve(equityPoints: readonly EquityPoint[]): DrawdownResult {
  let peak: Decimal | undefined;
  let maxDrawdown = new Decimal(0);
  let maxDrawdownPct = 0;

  const points: DrawdownPoint[] = equityPoints.map((point) => {
    const equity = toDecimal(point.equity);
    peak = peak === undefined ? equity : Decimal.max(peak, equity);

    const drawdown = peak.minus(equity);
    const drawdownPct = peak.isZero() ? 0 : drawdown.dividedBy(peak).times(100).toNumber();

    if (drawdown.greaterThan(maxDrawdown)) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
    }

    return {
      sequenceNumber: point.sequenceNumber,
      time: point.time,
      drawdown: drawdown.toFixed(8),
      drawdownPct,
    };
  });

  return { points, maxDrawdown: maxDrawdown.toFixed(8), maxDrawdownPct };
}
