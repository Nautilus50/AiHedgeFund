# TradingView report parsers

`packages/pine/src/tradingview/`. Two parsers, both versioned, both governed
by one rule from CLAUDE.md 15.2: **never guess an unknown column's meaning.**
A file the parser cannot confidently identify fails loudly and keeps its raw
artefact, rather than being partially interpreted into misleading evidence.

## Contract

Both parsers return a discriminated union:

```ts
type Result = { ok: true; parserVersion: string; warnings: ParseWarning[]; ... }
            | { ok: false; reasonCode: "EMPTY_FILE" | "MISSING_REQUIRED_COLUMNS" | "UNKNOWN_REPORT_TYPE";
                message: string; missingColumns?: string[] }
```

`report_uploads.parser_version` records which parser produced a stored result,
so fixing a parser never silently reinterprets historical evidence.

## Delimiter and locale

TradingView's European-locale export uses `;` as the field delimiter because
`,` is already the decimal separator. `detectDelimiter` counts both in the
header line and picks the more frequent.

`parseLocaleNumber` then interprets numbers **according to that delimiter**:

| File delimiter | Convention | `1.234,56` | `1,234.56` |
|---|---|---|---|
| `,` | US — dot decimal | — | `1234.56` |
| `;` | EU — comma decimal | `1234.56` | — |

A value matching neither convention returns `undefined` and produces an
`UNPARSEABLE_NUMBER` warning. It is never coerced to `0`.

## List of Trades

TradingView emits **one row per entry and one per exit**, sharing a `Trade #`.
The parser pairs them into a single trade.

Required columns (missing any is a hard failure): `Trade #`, `Type`,
`Date/Time`, `Price`, `Contracts`. Optional: `Profit`, `Profit %`.

Column matching is case-insensitive and tolerates the currency suffix
TradingView appends (`Price USDT`, `Profit USDT`).

Date/time accepts exactly two known shapes — ISO (`2024-01-15 08:30`) and
European (`15.01.2024 08:30`). Anything else is an `UNPARSEABLE_DATE`
warning, not a best guess.

### Warnings

| Code | Meaning |
|---|---|
| `OPEN_POSITION_AT_END` | Trade has an entry but no exit — still open at export |
| `INCOMPLETE_TRADE` | Exit row with no matching entry; dropped |
| `UNKNOWN_TRADE_TYPE` | `Type` is neither long nor short |
| `UNPARSEABLE_DATE` | Date/time matched neither known format |
| `UNPARSEABLE_NUMBER` | Price or Contracts could not be read |
| `INVALID_TRADE_NUMBER` | `Trade #` was not numeric |

Open trades are surfaced, never silently closed. `packages/metrics` then
excludes them from every calculation.

## Performance Summary

Segment columns (All / Long / Short, sometimes split into currency and percent
sub-columns) vary by TradingView version and locale. Rather than assume a
fixed schema, the parser keys each value by its **exact source header**:

```ts
{ name: "Net Profit", values: { "All USD": 7.95, "Long USD": 6.95, "Short USD": 1.0 } }
```

Only a `Title` column is required. A metric with no value in a segment gets
`undefined`, not `0` — the distinction between "not applicable" and "zero"
matters for evidence.

## Fixtures

`pine/fixtures/tradingview/`:

| File | Covers |
|---|---|
| `list-of-trades-comma-iso.csv` | US locale, ISO dates, one open position |
| `list-of-trades-semicolon-eu.csv` | EU locale, `;` delimiter, comma decimals |
| `performance-summary-comma.csv` | Segment columns incl. a partially-empty row |

These are hand-written to mirror real TradingView export shapes. They are
used by unit tests, and by the integration suite which uploads them through
real R2 and asserts the parse is identical after the round trip.

Adding a fixture: keep it minimal and make it exercise one distinct shape.
Note in this table what it covers.

## Adding a new export variant

1. Add a fixture.
2. Extend the column matchers — do not loosen an existing regex to the point
   it matches something it should not.
3. If the shape is genuinely different, write a new versioned adapter rather
   than making one parser handle both.
4. Bump the parser version.
