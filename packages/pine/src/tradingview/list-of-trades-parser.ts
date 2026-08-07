import { parseCsv, parseLocaleNumber } from "./csv.js";
import type {
  ListOfTradesParseResult,
  ParsedTrade,
  ParseWarning,
  TradingViewParseFailure,
} from "./types.js";

export const LIST_OF_TRADES_PARSER_VERSION = "1.0.0";

interface ColumnMatcher {
  canonical: string;
  /** Header names are matched case-insensitively; a symbol suffix like " USDT" is common. */
  pattern: RegExp;
  required: boolean;
}

const COLUMNS: ColumnMatcher[] = [
  { canonical: "Trade #", pattern: /^trade\s*#$/i, required: true },
  { canonical: "Type", pattern: /^type$/i, required: true },
  { canonical: "Date/Time", pattern: /^date\/?time$/i, required: true },
  { canonical: "Price", pattern: /^price(\s+\w+)?$/i, required: true },
  { canonical: "Contracts", pattern: /^contracts$/i, required: true },
  { canonical: "Profit", pattern: /^profit(\s+\w+)?$/i, required: false },
  { canonical: "Profit %", pattern: /^profit\s*%$/i, required: false },
];

interface RequiredIndexes {
  tradeNumber: number;
  type: number;
  dateTime: number;
  price: number;
  contracts: number;
  profit: number | undefined;
  profitPct: number | undefined;
}

/**
 * Resolves every required column to a definite index (or returns the list
 * of missing ones). Once `missing` is empty, {@link toRequiredIndexes} can
 * build a fully-typed lookup without any non-null assertions.
 */
function resolveColumnIndexes(headers: string[]): {
  indexes: Map<string, number>;
  missing: string[];
} {
  const indexes = new Map<string, number>();
  const missing: string[] = [];

  for (const column of COLUMNS) {
    const index = headers.findIndex((h) => column.pattern.test(h.trim()));
    if (index >= 0) {
      indexes.set(column.canonical, index);
    } else if (column.required) {
      missing.push(column.canonical);
    }
  }

  return { indexes, missing };
}

/** Only call after confirming `missing.length === 0` from {@link resolveColumnIndexes}. */
function toRequiredIndexes(indexes: Map<string, number>): RequiredIndexes {
  const tradeNumber = indexes.get("Trade #");
  const type = indexes.get("Type");
  const dateTime = indexes.get("Date/Time");
  const price = indexes.get("Price");
  const contracts = indexes.get("Contracts");

  if (
    tradeNumber === undefined ||
    type === undefined ||
    dateTime === undefined ||
    price === undefined ||
    contracts === undefined
  ) {
    throw new Error(
      "toRequiredIndexes called before confirming all required columns were resolved.",
    );
  }

  return {
    tradeNumber,
    type,
    dateTime,
    price,
    contracts,
    profit: indexes.get("Profit"),
    profitPct: indexes.get("Profit %"),
  };
}

/** ISO ("2024-01-15 08:30") or European ("15.01.2024 08:30") date/time — never guessed beyond these two known TradingView export shapes. */
function parseDateTime(raw: string): string | undefined {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(:(\d{2}))?$/);
  if (iso) {
    const [, y, mo, d, h, mi, , s] = iso;
    return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}.000Z`;
  }

  const eu = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(:(\d{2}))?$/);
  if (eu) {
    const [, d, mo, y, h, mi, , s] = eu;
    return `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}.000Z`;
  }

  return undefined;
}

function directionFromType(type: string): "LONG" | "SHORT" | undefined {
  const normalized = type.toLowerCase();
  if (normalized.includes("long")) return "LONG";
  if (normalized.includes("short")) return "SHORT";
  return undefined;
}

function isEntryRow(type: string): boolean {
  return type.toLowerCase().includes("entry");
}

interface TradeBuilder {
  tradeNumber: number;
  direction: "LONG" | "SHORT";
  isOpen: boolean;
  entryTime?: string | undefined;
  entryPrice?: number | undefined;
  exitTime?: string | undefined;
  exitPrice?: number | undefined;
  quantity?: number | undefined;
  grossPnl?: number | undefined;
  grossPnlPct?: number | undefined;
}

/**
 * Parses a TradingView "List of Trades" export. TradingView emits one row
 * per entry AND one row per exit, sharing the same "Trade #" — this parser
 * pairs them into a single {@link ParsedTrade} per CLAUDE.md 15.2 ("map
 * columns through versioned adapters", "never guess an unknown column's
 * meaning").
 */
export function parseListOfTrades(raw: string): ListOfTradesParseResult | TradingViewParseFailure {
  const { headers, rows, delimiter } = parseCsv(raw);

  if (headers.length === 0) {
    return { ok: false, reasonCode: "EMPTY_FILE", message: "The uploaded file has no rows." };
  }

  const { indexes, missing } = resolveColumnIndexes(headers);
  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: "MISSING_REQUIRED_COLUMNS",
      message: `List of Trades export is missing required columns: ${missing.join(", ")}.`,
      missingColumns: missing,
    };
  }
  const col = toRequiredIndexes(indexes);

  const warnings: ParseWarning[] = [];
  const byTradeNumber = new Map<number, TradeBuilder>();

  rows.forEach((row, rowIndex) => {
    const tradeNumberRaw = row[col.tradeNumber] ?? "";
    const type = row[col.type] ?? "";
    const dateTimeRaw = row[col.dateTime] ?? "";
    const priceRaw = row[col.price] ?? "";
    const contractsRaw = row[col.contracts] ?? "";

    const tradeNumber = Number(tradeNumberRaw);
    if (!Number.isFinite(tradeNumber)) {
      warnings.push({ code: "INVALID_TRADE_NUMBER", message: `Row ${rowIndex + 2}: unparseable Trade #.`, rowIndex });
      return;
    }

    const direction = directionFromType(type);
    if (!direction) {
      warnings.push({ code: "UNKNOWN_TRADE_TYPE", message: `Row ${rowIndex + 2}: unrecognised Type "${type}".`, rowIndex });
      return;
    }

    const time = parseDateTime(dateTimeRaw);
    if (!time) {
      warnings.push({ code: "UNPARSEABLE_DATE", message: `Row ${rowIndex + 2}: unparseable Date/Time "${dateTimeRaw}".`, rowIndex });
      return;
    }

    const price = parseLocaleNumber(priceRaw, delimiter);
    const quantity = parseLocaleNumber(contractsRaw, delimiter);
    if (price === undefined || quantity === undefined) {
      warnings.push({ code: "UNPARSEABLE_NUMBER", message: `Row ${rowIndex + 2}: unparseable Price or Contracts.`, rowIndex });
      return;
    }

    const existing: TradeBuilder = byTradeNumber.get(tradeNumber) ?? { tradeNumber, direction, isOpen: true };

    if (isEntryRow(type)) {
      existing.entryTime = time;
      existing.entryPrice = price;
      existing.quantity = quantity;
    } else {
      existing.exitTime = time;
      existing.exitPrice = price;
      existing.isOpen = false;
      if (col.profit !== undefined) {
        existing.grossPnl = parseLocaleNumber(row[col.profit] ?? "", delimiter);
      }
      if (col.profitPct !== undefined) {
        existing.grossPnlPct = parseLocaleNumber(row[col.profitPct] ?? "", delimiter);
      }
    }

    byTradeNumber.set(tradeNumber, existing);
  });

  const trades: ParsedTrade[] = [];
  for (const builder of byTradeNumber.values()) {
    if (builder.entryTime === undefined || builder.entryPrice === undefined || builder.quantity === undefined) {
      warnings.push({
        code: "INCOMPLETE_TRADE",
        message: `Trade #${builder.tradeNumber} has no entry row and was dropped.`,
      });
      continue;
    }
    if (builder.isOpen) {
      warnings.push({
        code: "OPEN_POSITION_AT_END",
        message: `Trade #${builder.tradeNumber} has no exit row (open position at end of export).`,
      });
    }
    trades.push({
      tradeNumber: builder.tradeNumber,
      direction: builder.direction,
      entryTime: builder.entryTime,
      entryPrice: builder.entryPrice,
      exitTime: builder.exitTime,
      exitPrice: builder.exitPrice,
      quantity: builder.quantity,
      grossPnl: builder.grossPnl,
      grossPnlPct: builder.grossPnlPct,
      isOpen: builder.isOpen,
    });
  }

  trades.sort((a, b) => a.tradeNumber - b.tradeNumber);

  return {
    ok: true,
    parserVersion: LIST_OF_TRADES_PARSER_VERSION,
    trades,
    warnings,
    rawRowCount: rows.length,
  };
}
