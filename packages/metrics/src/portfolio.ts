/**
 * Portfolio-level metrics computed across multiple strategies (spec §7.11).
 *
 * `equity_points`/`drawdown_points` are trade-close-event series, not a
 * regularly-sampled daily grid (`reconstructEquityCurve` in equity.ts emits
 * one point per closed trade, timestamped by that trade's exit) — every
 * function below is designed around that fact, not a naive daily-bar
 * assumption. See ADR 0011 for the full methodology writeup, including the
 * honest ceiling this implies: these functions measure correlation of
 * *realized P&L timing*, never correlation of held exposure.
 */

/** Collapses same-day duplicates to the highest-sequenceNumber (most recent) point that day — never an average, never a naive last-by-timestamp. */
function toDailySeries(points: readonly { sequenceNumber: number; barTime: Date; value: number }[]): Map<string, number> {
  const byDay = new Map<string, { sequenceNumber: number; value: number }>();
  for (const point of points) {
    const day = point.barTime.toISOString().slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || point.sequenceNumber > existing.sequenceNumber) {
      byDay.set(day, { sequenceNumber: point.sequenceNumber, value: point.value });
    }
  }
  return new Map(Array.from(byDay.entries(), ([day, v]) => [day, v.value]));
}

export function toDailyEquitySeries(points: readonly { sequenceNumber: number; barTime: Date; equity: string }[]): Map<string, number> {
  return toDailySeries(points.map((p) => ({ sequenceNumber: p.sequenceNumber, barTime: p.barTime, value: Number(p.equity) })));
}

export function toDailyDrawdownSeries(
  points: readonly { sequenceNumber: number; barTime: Date; drawdownPct: number }[],
): Map<string, number> {
  return toDailySeries(points.map((p) => ({ sequenceNumber: p.sequenceNumber, barTime: p.barTime, value: p.drawdownPct })));
}

/**
 * % change between consecutive *available* days — not consecutive calendar
 * days. A return here can span however many days actually elapsed since
 * the previous trade close for that strategy; this is an irregular-period
 * return by construction, not a daily return (ADR 0011).
 */
export function toReturnSeries(dailyEquity: ReadonlyMap<string, number>): Map<string, number> {
  const days = Array.from(dailyEquity.keys()).sort();
  const returns = new Map<string, number>();
  for (let i = 1; i < days.length; i++) {
    const prevDay = days[i - 1];
    const day = days[i];
    if (prevDay === undefined || day === undefined) continue;
    const prev = dailyEquity.get(prevDay);
    const curr = dailyEquity.get(day);
    if (prev === undefined || curr === undefined || prev === 0) continue;
    returns.set(day, ((curr - prev) / Math.abs(prev)) * 100);
  }
  return returns;
}

function rank(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]?.v === indexed[i]?.v) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      const entry = indexed[k];
      if (entry) ranks[entry.i] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n === 0) return null;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;

  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return null;
  return numerator / Math.sqrt(denomA * denomB);
}

/**
 * Rank correlation, not Pearson — deliberately, for two independent
 * reasons (ADR 0011): equity returns here are irregular-period (not fixed
 * daily bars), undermining Pearson's linearity assumption further than
 * ordinary fat-tailed-returns concerns already would; drawdown levels are
 * strongly serially autocorrelated, which produces spurious level
 * correlation between two unrelated strategies that each simply had one
 * drawdown episode sometime in the sample.
 */
export function computeSpearmanCorrelation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  return pearson(rank(a), rank(b));
}

/**
 * No analogous threshold exists anywhere else in this package — this is
 * the first invented statistical constant here (ADR 0011). Below it, a
 * pair's correlation isn't just noisy: the surviving overlap days skew
 * toward correlated-shock days (both strategies happening to close a
 * trade the same day is disproportionately likely on volatility spikes),
 * biasing the coefficient upward, not just widening its variance.
 */
export const MIN_OVERLAP_DAYS = 10;

export interface SeriesCorrelationResult {
  coefficient: number | null;
  overlapDays: number;
  /** overlapDays as a % of the *union* of both series' available days — "10 of 12" reads very differently from "10 of 400." */
  overlapPct: number;
  reasonCode?: "INSUFFICIENT_OVERLAP";
}

export function computeSeriesCorrelation(seriesA: ReadonlyMap<string, number>, seriesB: ReadonlyMap<string, number>): SeriesCorrelationResult {
  const daysA = new Set(seriesA.keys());
  const daysB = new Set(seriesB.keys());
  const overlapDays = Array.from(daysA).filter((d) => daysB.has(d)).sort();
  const unionSize = new Set([...daysA, ...daysB]).size;
  const overlapPct = unionSize === 0 ? 0 : (overlapDays.length / unionSize) * 100;

  if (overlapDays.length < MIN_OVERLAP_DAYS) {
    return { coefficient: null, overlapDays: overlapDays.length, overlapPct, reasonCode: "INSUFFICIENT_OVERLAP" };
  }

  const a = overlapDays.map((d) => seriesA.get(d) ?? 0);
  const b = overlapDays.map((d) => seriesB.get(d) ?? 0);
  return { coefficient: computeSpearmanCorrelation(a, b), overlapDays: overlapDays.length, overlapPct };
}

export interface TradeInterval {
  entryTime: Date;
  exitTime: Date;
}

export interface ExposureOverlapResult {
  overlapHours: number;
  /** Jaccard index (0-100): overlap / union of both strategies' total in-market time. */
  jaccardPct: number;
}

/**
 * Sums pairwise interval overlaps across all trade pairs — O(n·m), not a
 * sweep-line, documented as a complexity ceiling rather than fixed
 * preemptively for trade counts this stage doesn't have (ADR 0011).
 * Assumes one open position at a time per strategy (no pyramiding,
 * matching every runner's actual behavior in this codebase) — a
 * strategy's own trades are assumed non-overlapping with each other, so
 * summing individual trade durations is a valid total-in-market figure.
 */
export function computeExposureOverlap(tradesA: readonly TradeInterval[], tradesB: readonly TradeInterval[]): ExposureOverlapResult {
  let overlapMs = 0;
  for (const a of tradesA) {
    for (const b of tradesB) {
      const start = Math.max(a.entryTime.getTime(), b.entryTime.getTime());
      const end = Math.min(a.exitTime.getTime(), b.exitTime.getTime());
      if (end > start) overlapMs += end - start;
    }
  }

  const totalA = tradesA.reduce((sum, t) => sum + (t.exitTime.getTime() - t.entryTime.getTime()), 0);
  const totalB = tradesB.reduce((sum, t) => sum + (t.exitTime.getTime() - t.entryTime.getTime()), 0);
  const unionMs = totalA + totalB - overlapMs;

  return {
    overlapHours: overlapMs / 3_600_000,
    jaccardPct: unionMs === 0 ? 0 : (overlapMs / unionMs) * 100,
  };
}

export interface SignalExpressions {
  longEntry: string;
  shortEntry: string;
}

export interface SignalOverlapResult {
  /** Jaccard index (0-100) over the token sets described below. */
  jaccardPct: number;
  sharedTokens: string[];
}

function tokenizeSignalExpression(expression: string): Set<string> {
  return new Set(expression.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 0));
}

/**
 * Token-set Jaccard similarity over each strategy's SDL `signals.longEntry`
 * + `signals.shortEntry` expressions, lowercased and split on
 * non-identifier characters. This is TEXTUAL similarity, not semantic: two
 * strategies with differently-worded but functionally identical logic score
 * low, and two unrelated strategies that happen to share common terms (e.g.
 * both reference "rsi" and "cross") score higher than their real overlap.
 * It exists to flag a pair worth reading side by side, not to stand in for
 * that reading (ADR 0011).
 */
export function computeSignalOverlap(signalsA: SignalExpressions, signalsB: SignalExpressions): SignalOverlapResult {
  const tokensA = tokenizeSignalExpression(`${signalsA.longEntry} ${signalsA.shortEntry}`);
  const tokensB = tokenizeSignalExpression(`${signalsB.longEntry} ${signalsB.shortEntry}`);

  const sharedTokens = Array.from(tokensA).filter((token) => tokensB.has(token)).sort();
  const unionSize = new Set([...tokensA, ...tokensB]).size;

  return {
    jaccardPct: unionSize === 0 ? 0 : (sharedTokens.length / unionSize) * 100,
    sharedTokens,
  };
}
