export interface CsvParseResult {
  delimiter: "," | ";";
  headers: string[];
  rows: string[][];
}

/**
 * Minimal RFC 4180-ish CSV line splitter with quote support. TradingView
 * exports never embed newlines inside quoted fields for the reports we
 * support, so a line-by-line parser is sufficient and keeps this dependency-free.
 */
function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Detects comma vs semicolon delimiter from the header line (CLAUDE.md 15.2
 * — "detect delimiter and locale safely"). TradingView's European-locale
 * export uses semicolons because commas are already the decimal separator.
 */
export function detectDelimiter(headerLine: string): "," | ";" {
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(raw: string): CsvParseResult {
  const lines = raw.split(/\r\n|\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { delimiter: ",", headers: [], rows: [] };
  }

  const firstLine = lines[0];
  if (firstLine === undefined) {
    return { delimiter: ",", headers: [], rows: [] };
  }

  const delimiter = detectDelimiter(firstLine);
  const headers = splitLine(firstLine, delimiter);
  const rows = lines.slice(1).map((line) => splitLine(line, delimiter));

  return { delimiter, headers, rows };
}

/**
 * Parses a locale-ambiguous numeric string. When the delimiter is a
 * semicolon we assume the European convention (comma decimal, optional dot
 * thousands separator); otherwise the US convention (dot decimal, optional
 * comma thousands separator). Never silently coerces a value that doesn't
 * match either convention — callers get `undefined` and must warn.
 */
export function parseLocaleNumber(raw: string, delimiter: "," | ";"): number | undefined {
  const trimmed = raw.trim().replace(/[^0-9.,-]/g, "");
  if (trimmed.length === 0) {
    return undefined;
  }

  let normalized: string;
  if (delimiter === ";") {
    normalized = trimmed.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = trimmed.replace(/,/g, "");
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}
