export interface ParsedTrade {
  tradeNumber: number;
  direction: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  exitTime?: string | undefined;
  exitPrice?: number | undefined;
  quantity: number;
  grossPnl?: number | undefined;
  grossPnlPct?: number | undefined;
  isOpen: boolean;
}

export interface ParseWarning {
  code: string;
  message: string;
  rowIndex?: number;
}

export interface ListOfTradesParseResult {
  ok: true;
  parserVersion: string;
  trades: ParsedTrade[];
  warnings: ParseWarning[];
  rawRowCount: number;
}

export interface PerformanceSummaryMetric {
  name: string;
  /** Keyed by the exact source column header (e.g. "All USD", "Long %") — never inferred beyond what the header literally says. */
  values: Record<string, number | undefined>;
}

export interface PerformanceSummaryParseResult {
  ok: true;
  parserVersion: string;
  metrics: PerformanceSummaryMetric[];
  warnings: ParseWarning[];
  rawRowCount: number;
}

export type TradingViewParseFailureReason = "UNKNOWN_REPORT_TYPE" | "MISSING_REQUIRED_COLUMNS" | "EMPTY_FILE";

export interface TradingViewParseFailure {
  ok: false;
  reasonCode: TradingViewParseFailureReason;
  message: string;
  missingColumns?: string[];
}
