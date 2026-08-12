import type { Bar, OhlcvParseFailure, OhlcvParseResult, OhlcvParseWarning } from "./types.js";

export const OHLCV_CSV_PARSER_VERSION = "1.0.0";

const REQUIRED_COLUMNS = ["time", "open", "high", "low", "close", "volume"] as const;

interface ColumnIndexes {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function resolveColumnIndexes(headers: string[]): { indexes: ColumnIndexes | undefined; missing: string[] } {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !lower.includes(column));
  if (missing.length > 0) {
    return { indexes: undefined, missing };
  }

  return {
    missing: [],
    indexes: {
      time: lower.indexOf("time"),
      open: lower.indexOf("open"),
      high: lower.indexOf("high"),
      low: lower.indexOf("low"),
      close: lower.indexOf("close"),
      volume: lower.indexOf("volume"),
    },
  };
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function parseTime(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const date = new Date(raw.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Parses this platform's own `time,open,high,low,close,volume` OHLCV bar
 * export — this is a dataset we produce and control (seeded fixtures, later
 * a real ingestion pipeline), not a third-party report, so unlike the
 * TradingView parsers there is no locale/delimiter ambiguity to resolve.
 * Still versioned and still explicit about what it rejects (CLAUDE.md 15.2):
 * an unparseable row is dropped with a warning, never silently coerced.
 */
export function parseOhlcvCsv(raw: string): OhlcvParseResult | OhlcvParseFailure {
  const lines = raw.split(/\r\n|\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, reasonCode: "EMPTY_FILE", message: "The OHLCV file has no rows." };
  }

  const headerLine = lines[0];
  if (headerLine === undefined) {
    return { ok: false, reasonCode: "EMPTY_FILE", message: "The OHLCV file has no rows." };
  }

  const headers = headerLine.split(",").map((h) => h.trim());
  const { indexes, missing } = resolveColumnIndexes(headers);
  if (indexes === undefined) {
    return {
      ok: false,
      reasonCode: "MISSING_REQUIRED_COLUMNS",
      message: `OHLCV file is missing required columns: ${missing.join(", ")}.`,
      missingColumns: missing,
    };
  }

  const warnings: OhlcvParseWarning[] = [];
  const bars: Bar[] = [];

  const dataRows = lines.slice(1);
  dataRows.forEach((line, rowIndex) => {
    const fields = line.split(",").map((f) => f.trim());

    const time = parseTime(fields[indexes.time]);
    const open = parseNumber(fields[indexes.open]);
    const high = parseNumber(fields[indexes.high]);
    const low = parseNumber(fields[indexes.low]);
    const close = parseNumber(fields[indexes.close]);
    const volume = parseNumber(fields[indexes.volume]);

    if (time === undefined) {
      warnings.push({ code: "UNPARSEABLE_TIME", message: `Row ${rowIndex + 2}: unparseable time.`, rowIndex });
      return;
    }
    if (open === undefined || high === undefined || low === undefined || close === undefined || volume === undefined) {
      warnings.push({ code: "UNPARSEABLE_NUMBER", message: `Row ${rowIndex + 2}: unparseable OHLCV value.`, rowIndex });
      return;
    }

    bars.push({ time, open, high, low, close, volume });
  });

  bars.sort((a, b) => a.time.localeCompare(b.time));

  return {
    ok: true,
    parserVersion: OHLCV_CSV_PARSER_VERSION,
    bars,
    warnings,
    rawRowCount: dataRows.length,
  };
}
