import type { PerformanceSummaryMetric } from "./types.js";

/**
 * The three figures parity compares, pulled out of a Performance Summary's
 * reported metrics. A figure the report did not state — or whose value
 * failed to parse — is **absent** rather than present-and-undefined, so
 * "the report never said" is structurally distinct from "the report said
 * nothing meaningful". Never substituted with zero (CLAUDE.md 15.2).
 */
export interface ReportedParityMetrics {
  closedTradeCount?: number;
  netProfit?: number;
  maxDrawdown?: number;
}

/**
 * Row titles TradingView uses for the figures we compare. Matched
 * case-insensitively after trimming, because exports vary in casing, but
 * never fuzzily — an unrecognised title is left alone rather than guessed
 * at.
 */
const TITLES = {
  closedTradeCount: ["total closed trades"],
  netProfit: ["net profit"],
  maxDrawdown: ["max drawdown"],
} as const;

/**
 * The column holding absolute (non-percentage) values. TradingView puts
 * plain counts here too — `Total Closed Trades` reports `2` under
 * `All USD` — so this one column covers all three figures.
 */
const ABSOLUTE_VALUE_COLUMN = "All USD";

function findValue(
  metrics: PerformanceSummaryMetric[],
  titles: readonly string[],
  column: string,
): number | undefined {
  const match = metrics.find((metric) => titles.includes(metric.name.trim().toLowerCase()));
  if (!match) return undefined;

  const value = match.values[column];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads the parity-relevant figures a Performance Summary reported.
 *
 * Deliberately tolerant of absence and intolerant of ambiguity: it looks up
 * known row titles in one known column and returns whatever it finds. It
 * does not derive one metric from another, and it does not fall back to a
 * different column if the expected one is empty — either the report stated
 * the figure or it did not.
 */
export function extractReportedParityMetrics(
  metrics: PerformanceSummaryMetric[],
  column: string = ABSOLUTE_VALUE_COLUMN,
): ReportedParityMetrics {
  const found = {
    closedTradeCount: findValue(metrics, TITLES.closedTradeCount, column),
    netProfit: findValue(metrics, TITLES.netProfit, column),
    maxDrawdown: findValue(metrics, TITLES.maxDrawdown, column),
  };

  // Absent keys, not undefined values — see ReportedParityMetrics.
  return Object.fromEntries(
    Object.entries(found).filter(([, value]) => value !== undefined),
  ) as ReportedParityMetrics;
}
