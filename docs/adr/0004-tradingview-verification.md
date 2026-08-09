# ADR 0004: Human-assisted TradingView verification, not browser automation

## Status

Accepted — 2026-08-08. Implemented in Milestones 7 and 8.

## Context

Pine Script strategies execute on TradingView's infrastructure. TradingView is
therefore the acceptance and parity environment for Pine behaviour (CLAUDE.md
1), but it exposes no supported public API for programmatically compiling and
running Strategy Tester at scale (spec 13.1).

CLAUDE.md 3.8 is explicit: do not build the platform around fragile UI
selectors or unattended browser automation without an approved ADR documenting
terms, reliability, and security implications. CLAUDE.md 26 adds: never make
screenshot data canonical when CSV or structured data exists.

## Decision

For the MVP, verification is **human-assisted CSV ingestion**.

1. The frontend shows the researcher exactly what to run: strategy version,
   Pine source hash, symbol, timeframe, and settings.
2. The researcher runs it in TradingView and exports Performance Summary and
   List of Trades CSVs.
3. They upload via presigned URL (ADR 0002).
4. ARF-OS preserves the raw file by recomputed checksum, then parses it
   through versioned adapters.

The parsers (`packages/pine/src/tradingview`) follow CLAUDE.md 15.2 strictly:
detect delimiter and locale, map columns through versioned matchers, preserve
raw rows, emit warnings, and **reject unknown required columns rather than
guessing**. A file whose columns cannot be identified fails loudly; it is
never partially interpreted.

TradingView-reported metrics are stored separately from ARF-OS's independently
calculated ones so parity can actually be evaluated (CLAUDE.md 26 — never
merge local-runner and TradingView results without a parity report).

## Alternatives

- **Headless browser automation of TradingView.** Would remove the human step
  entirely. Rejected: it depends on unstable UI selectors, likely conflicts
  with TradingView's terms, and would make the platform's core evidence path
  silently brittle. Revisiting requires its own ADR with a terms review, per
  CLAUDE.md 3.8.
- **Screenshot/OCR ingestion.** Rejected outright by CLAUDE.md 26 whenever
  structured data exists.
- **Trust a local Pine-compatible runner alone.** Faster and fully automatable,
  but a local engine's broker emulation differs from TradingView's. Without a
  parity check against the real thing, every downstream number inherits an
  unvalidated assumption.

## Consequences

- Verification throughput is bounded by human availability. This is the
  intended trade: the spec's scaling answer is a local research runner for
  exploration, with TradingView verifying finalists (spec 13.3).
- Parser adapters are versioned, and `report_uploads.parser_version` records
  which one produced a given result, so a parser fix does not silently
  reinterpret historical evidence.
- Locale ambiguity is a real failure mode. The parser refuses genuinely
  ambiguous numeric formats rather than picking one; fixtures cover both the
  comma/ISO and semicolon/EU-decimal export shapes.
- Open positions at the end of an export produce an `OPEN_POSITION_AT_END`
  warning rather than being silently closed or dropped.

## Security implications

- Uploads are validated for type and size, and the raw bytes are checksummed
  by the server, not the client.
- TradingView exports are never sent to a model (CLAUDE.md — "Do not send
  TradingView exports to a model").
- No TradingView credentials are stored anywhere in the platform; the
  researcher authenticates in their own browser session.

## Migration / rollback

If an automated path is approved later, it becomes an additional runner behind
the same ingestion interface. The parsers, checksum preservation, and parity
comparison stay unchanged — only the source of the CSV differs.
