# ADR 0014: Real OHLCV ingestion via Coinbase Exchange's public REST API

## Status

Accepted — 2026-08-18. Implemented in `apps/api/src/services/market-data/coinbase.ts`,
`apps/api/src/services/datasets.ts`, and `apps/api/src/scripts/ingest-ohlcv.ts`.

## Context

`dataset_versions` and the object-storage-backed `createDatasetVersion` insert path have
existed since ADR 0005 (the local Pine runner slice), but only ever backed two hand-inserted
test fixtures (14 hours and 6 hours of BTCUSD hourly bars). ADR 0005's own doc comments say
this out loud: *"There is no upload/ingestion API yet — this slice seeds one golden fixture
directly; real ingestion is separate future scope."* Every strategy screened from the
trader-dev leaderboard this session that could otherwise run through ARF-OS's own
`LOCAL_RUNNER` — including one explicitly parked for exactly this reason — was blocked purely
because no real dataset existed for its symbol. This ADR closes that gap.

## Decision

Fetch real historical OHLCV bars from **Coinbase Exchange's public
`GET /products/{product_id}/candles` REST endpoint**, convert them into this repo's own
`time,open,high,low,close,volume` CSV shape, and hand them to the existing
`createDatasetVersion` insert path unchanged.

### Binance was the original choice — it's geo-blocked from this deployment

The first draft of this ADR chose Binance's public `GET /api/v3/klines` endpoint: no API key,
and its symbol convention (`BTCUSDT`, `ZECUSDT`, ...) is literally what the trader-dev
leaderboard's own strategy authors already use. Implementation and unit tests were built
against it, then the first live run against this deployment's actual network failed:

```
HTTP 451: Service unavailable from a restricted location according to
'b. Eligibility' in https://www.binance.com/en/terms.
```

Confirmed with a plain `curl` (not a code bug): Binance returns 451 from this environment's
egress IP; Coinbase Exchange and Kraken's public endpoints both return 200 from the same
network. This is a datacenter-IP-range restriction Binance applies broadly, not a
jurisdiction-specific block worth working around — no proxying, spoofing, or other
circumvention was attempted; the response was to switch to a reachable, equally public,
equally credential-free provider instead. See Alternatives for why Coinbase over Kraken.

Why Coinbase Exchange:

- **No API key, no account, no credentials.** Same as Binance — a public, unauthenticated,
  read-only endpoint. This matters directly against CLAUDE.md 3.9 ("no exchange credentials,
  order-routing code, or live execution side effects without a separately approved project
  specification") — see Security implications below for why this doesn't trigger that rule.
- **Reachable from this deployment.** Confirmed via direct `curl` before building against it.
- **Covers the same underlying assets** (`BTC`, `ETH`, `SOL`, `ZEC`, ...) the trader-dev
  leaderboard screen surfaced, quoted in USD rather than USDT — see Symbol mapping below.
- **Operationally identical to what this repo already does.** Invoked the same way as
  `reap-abandoned-uploads.ts` / `sweep-health-snapshots.ts`: a manually-run (or
  externally-scheduled) one-off script, not a service the app calls itself.

## Alternatives considered

- **Kraken's public API.** Also reachable from this deployment (confirmed via `curl`), and was
  a real contender. Coinbase Exchange was chosen instead for its simpler product-id convention
  (`BTC-USD` vs. Kraken's `XXBTZUSD`-style asset-pair codes) and candle response shape closer to
  plain OHLCV — a smaller, more legible mapping layer. Revisit if a needed symbol turns out to
  be Kraken-only.
- **CCXT** (multi-exchange abstraction library). Rejected: it exists to normalise across many
  exchanges, but one reachable exchange covers every symbol currently in play — CCXT would add
  a dependency and an abstraction layer for exchanges nothing in this repo actually targets yet.
- **A paid provider (Polygon, Alpaca market data, etc.)**. Rejected for now: needs API-key
  provisioning (a real, if lower-stakes, credential to manage) and its main advantage —
  covering forex/equities/commodities — isn't the current bottleneck. The strategies blocked on
  forex (`AUDNZD`) or commodities (`XAUUSD`) symbols still need TradingView verification, not
  local backtesting; a local-runner dataset wouldn't unblock them even if the data existed,
  because SDL's expression grammar doesn't support what those strategies actually compute
  (VWAP, ADX, custom loop-based functions — see the local-runner capability ceiling documented
  in ADR 0005).

## Symbol mapping

`mapSymbolToCoinbaseProductId` strips a trailing `USDT` or `USD` from the platform's own
symbol convention (matching SDL's `market.symbol` and trader-dev's naming, e.g. `ZECUSDT`) and
maps the base asset onto Coinbase's `{BASE}-USD` product id (e.g. `ZEC-USD`). The
`dataset_versions.symbol` column still stores the caller's original symbol (`ZECUSDT`), not the
Coinbase product id — so it keeps matching `backtest_runs`/SDL's own symbol field. This is a
**labeled approximation**: USD and USDT prices track closely (both are dollar-pegged) but are
not identical, and this repo makes no claim otherwise.

## Scope

- **Crypto only, assets Coinbase Exchange lists.** An unmappable or unlisted symbol fails
  loudly (Coinbase's own `NotFound` message, or `mapSymbolToCoinbaseProductId`'s own error for
  a symbol that isn't USD/USDT-quoted at all) — never a silent empty dataset.
- **A narrower timeframe set than Binance would have allowed**: Coinbase Exchange's public
  candles endpoint only accepts `1m/5m/15m/1h/6h/1d` granularities (vs. Binance's much richer
  interval enum) — `2h/4h/12h` and multi-day/week/month bars aren't fetchable through this
  endpoint at all. `fetchCoinbaseCandles` rejects anything else up front.
- **Manual/offline, not continuous.** This is a backfill tool, not a live price feed. It has no
  relationship to forward-test paper execution (ADR 0006), which remains driven entirely by
  TradingView webhook signals — this ADR does not add any live-market-data dependency to that
  path.
- **A new immutable `dataset_versions` row per distinct symbol/timeframe/date-range**, matching
  CLAUDE.md 3.1's treatment of datasets as an immutable input to strategy versions. Re-running
  the exact same ingest command is a no-op (see below), not a duplicate insert.

## Idempotency

`findMatchingDatasetVersion` (new, in `datasets.ts`) checks for an existing dataset version
with the same organisation/symbol/timeframe/`fromTs`/`toTs` before inserting. A different date
range for the same symbol/timeframe is treated as a genuinely different dataset and gets its
own version — this is a duplicate-run guard, not a "latest data wins" upsert. `fromTs`/`toTs`
are the *actual* bar coverage Coinbase returned (not the requested `--from`/`--to`), since a
newly-listed pair's earliest available bar can be later than what was asked for; the script
logs this explicitly rather than silently reporting the requested range as satisfied.

## Security implications

Outbound-only HTTPS `GET` to a public, unauthenticated, read-only endpoint. No secrets
involved anywhere in this path — nothing to redact, nothing to rotate. No write access to any
external account (there is no account). No order routing, no position management, no exchange
credentials of any kind stored or transmitted. This is explicitly **not** the live-trading
scope CLAUDE.md 3.9 restricts: it is a historical-data research input, run manually, entirely
analogous to a human downloading a CSV and uploading it by hand — just automated because the
data is already in a machine-readable format at the source.

## Consequences

- Real backtests are now possible for any Coinbase-listed symbol a screened strategy targets,
  not just the two fixture windows.
- Dataset `volume`/price values come from Coinbase's own USD-quoted market and are **not**
  cross-validated against trader-dev's self-reported (Binance-USDT-sourced) figures — a
  strategy's apparent edge on trader-dev's platform and its behaviour against this dataset can
  diverge for reasons having nothing to do with the strategy logic itself (different exchange,
  different quote currency, possibly different historical window, possibly different
  fee/slippage assumptions already baked into trader-dev's own numbers).
- Coinbase's 300-candle-per-request cap (vs. Binance's 1000) means a long backfill takes
  proportionally more paginated requests; the script paces them with a small delay as
  public-API rate-limit courtesy. This is fine for a one-off manual backfill; it is not
  designed for high-frequency or bulk-multi-symbol automation.
- Only `1m/5m/15m/1h/6h/1d` timeframes are ingestible — a strategy defined on `2h`/`4h`/`12h`
  bars cannot get a real dataset through this script today.
- Forex/commodity strategies remain blocked on real local backtesting; that gap is unchanged by
  this ADR and stays explicitly out of scope.

## Migration / rollback

No schema changes — `dataset_versions`/`artefacts` are unchanged. Rollback is simply: stop
running the script. Any `dataset_versions` rows it already created remain valid, immutable,
and usable exactly like the hand-seeded fixtures were.
