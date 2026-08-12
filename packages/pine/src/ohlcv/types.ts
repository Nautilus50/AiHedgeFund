/** A single OHLCV bar. `time` is the bar's open time, ISO 8601 UTC. */
export interface Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OhlcvParseWarning {
  code: string;
  message: string;
  rowIndex?: number;
}

export interface OhlcvParseResult {
  ok: true;
  parserVersion: string;
  bars: Bar[];
  warnings: OhlcvParseWarning[];
  rawRowCount: number;
}

export type OhlcvParseFailureReason = "MISSING_REQUIRED_COLUMNS" | "EMPTY_FILE";

export interface OhlcvParseFailure {
  ok: false;
  reasonCode: OhlcvParseFailureReason;
  message: string;
  missingColumns?: string[];
}
