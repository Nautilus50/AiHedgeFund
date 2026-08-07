import { parseCsv, parseLocaleNumber } from "./csv.js";
import type {
  ParseWarning,
  PerformanceSummaryMetric,
  PerformanceSummaryParseResult,
  TradingViewParseFailure,
} from "./types.js";

export const PERFORMANCE_SUMMARY_PARSER_VERSION = "1.0.0";

/**
 * Parses a TradingView "Performance Summary" export. The report's segment
 * columns (All / Long / Short, each possibly split into currency and
 * percent sub-columns) vary by TradingView version and locale, so this
 * parser preserves each column under its exact source header rather than
 * inventing a fixed schema (CLAUDE.md 15.2 — "never guess an unknown
 * column's meaning").
 */
export function parsePerformanceSummary(raw: string): PerformanceSummaryParseResult | TradingViewParseFailure {
  const { headers, rows, delimiter } = parseCsv(raw);

  if (headers.length === 0) {
    return { ok: false, reasonCode: "EMPTY_FILE", message: "The uploaded file has no rows." };
  }

  const titleIndex = headers.findIndex((h) => /^title$/i.test(h.trim()));
  if (titleIndex < 0) {
    return {
      ok: false,
      reasonCode: "MISSING_REQUIRED_COLUMNS",
      message: 'Performance Summary export is missing a required "Title" column.',
      missingColumns: ["Title"],
    };
  }

  const valueColumns = headers
    .map((header, index) => ({ header: header.trim(), index }))
    .filter(({ index }) => index !== titleIndex);

  if (valueColumns.length === 0) {
    return {
      ok: false,
      reasonCode: "MISSING_REQUIRED_COLUMNS",
      message: "Performance Summary export has a Title column but no value columns.",
    };
  }

  const warnings: ParseWarning[] = [];
  const metrics: PerformanceSummaryMetric[] = [];

  rows.forEach((row, rowIndex) => {
    const name = row[titleIndex]?.trim();
    if (!name) {
      warnings.push({ code: "MISSING_METRIC_NAME", message: `Row ${rowIndex + 2}: empty Title.`, rowIndex });
      return;
    }

    const values: Record<string, number | undefined> = {};
    for (const { header, index } of valueColumns) {
      const raw = row[index] ?? "";
      const parsed = parseLocaleNumber(raw, delimiter);
      if (raw.trim().length > 0 && parsed === undefined) {
        warnings.push({
          code: "UNPARSEABLE_NUMBER",
          message: `Row ${rowIndex + 2}: unparseable value "${raw}" for column "${header}".`,
          rowIndex,
        });
      }
      values[header] = parsed;
    }

    metrics.push({ name, values });
  });

  return {
    ok: true,
    parserVersion: PERFORMANCE_SUMMARY_PARSER_VERSION,
    metrics,
    warnings,
    rawRowCount: rows.length,
  };
}
