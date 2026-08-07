import type { ParityStatus } from "@arf-os/contracts";

export interface ParityFieldComparison {
  field: "closedTradeCount" | "netProfit" | "maxDrawdown";
  local: number;
  tradingview: number | undefined;
  diffPct: number | undefined;
  severity: "PASS" | "WARN" | "FAIL" | "MISSING";
}

export interface ParityReport {
  status: ParityStatus;
  comparisons: ParityFieldComparison[];
  firstDivergence?: string;
}

export interface ParityLocalMetrics {
  closedTradeCount: number;
  netProfit: number;
  maxDrawdown?: number;
}

export interface ParityTradingViewMetrics {
  closedTradeCount?: number;
  netProfit?: number;
  maxDrawdown?: number;
}

export interface ParityTolerance {
  /** Percent difference at or below this is a PASS. Defaults to 1%. */
  passTolerancePct: number;
  /** Percent difference at or below this (but above pass) is a WARN; above it is a FAIL. Defaults to 5%. */
  warnTolerancePct: number;
}

const DEFAULT_TOLERANCE: ParityTolerance = { passTolerancePct: 1, warnTolerancePct: 5 };

function percentDifference(local: number, remote: number): number {
  const denominator = Math.abs(remote) < 1e-9 ? 1e-9 : Math.abs(remote);
  return (Math.abs(local - remote) / denominator) * 100;
}

/**
 * Compares independently-calculated metrics against TradingView-reported
 * ones (spec 13.4, CLAUDE_CODE_BUILD_PROMPT.md — "basic parity report").
 * Reports the FIRST divergence, not only an aggregate score
 * (CLAUDE.md 15.3), so an investigator knows exactly where to look first.
 */
export function compareParity(
  local: ParityLocalMetrics,
  tradingview: ParityTradingViewMetrics,
  tolerance: ParityTolerance = DEFAULT_TOLERANCE,
): ParityReport {
  const comparisons: ParityFieldComparison[] = [];

  // Trade count must match exactly — any divergence signals a real reconstruction
  // defect, not a rounding difference, so it is always FAIL-severity.
  if (tradingview.closedTradeCount === undefined) {
    comparisons.push({
      field: "closedTradeCount",
      local: local.closedTradeCount,
      tradingview: undefined,
      diffPct: undefined,
      severity: "MISSING",
    });
  } else {
    comparisons.push({
      field: "closedTradeCount",
      local: local.closedTradeCount,
      tradingview: tradingview.closedTradeCount,
      diffPct: percentDifference(local.closedTradeCount, tradingview.closedTradeCount),
      severity: local.closedTradeCount === tradingview.closedTradeCount ? "PASS" : "FAIL",
    });
  }

  comparisons.push(compareNumericField("netProfit", local.netProfit, tradingview.netProfit, tolerance));

  if (local.maxDrawdown !== undefined) {
    comparisons.push(compareNumericField("maxDrawdown", local.maxDrawdown, tradingview.maxDrawdown, tolerance));
  }

  const withData = comparisons.filter((c) => c.severity !== "MISSING");
  if (withData.length === 0) {
    return { status: "INSUFFICIENT_DATA", comparisons };
  }

  const firstDivergent = comparisons.find((c) => c.severity === "WARN" || c.severity === "FAIL");
  const status: ParityStatus = withData.some((c) => c.severity === "FAIL")
    ? "FAIL"
    : withData.some((c) => c.severity === "WARN")
      ? "WARN"
      : "PASS";

  return {
    status,
    comparisons,
    ...(firstDivergent ? { firstDivergence: firstDivergent.field } : {}),
  };
}

function compareNumericField(
  field: "netProfit" | "maxDrawdown",
  local: number,
  remote: number | undefined,
  tolerance: ParityTolerance,
): ParityFieldComparison {
  if (remote === undefined) {
    return { field, local, tradingview: undefined, diffPct: undefined, severity: "MISSING" };
  }

  const diffPct = percentDifference(local, remote);
  const severity: ParityFieldComparison["severity"] =
    diffPct <= tolerance.passTolerancePct ? "PASS" : diffPct <= tolerance.warnTolerancePct ? "WARN" : "FAIL";

  return { field, local, tradingview: remote, diffPct, severity };
}
