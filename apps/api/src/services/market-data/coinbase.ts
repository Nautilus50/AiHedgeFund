/**
 * Fetches real historical OHLCV bars from Coinbase Exchange's public REST
 * API (`GET /products/{product_id}/candles`). Read-only public market
 * data — no API key, no account, no order routing — explicitly not the
 * live-trading scope CLAUDE.md 3.9 restricts (see ADR 0014).
 *
 * Binance's equivalent public endpoint was the original choice (ADR 0014's
 * first draft) but returns HTTP 451 ("Service unavailable from a
 * restricted location") from this deployment's network — a datacenter-IP
 * block, unrelated to code correctness and not something to route around
 * (no proxying/spoofing). Coinbase Exchange's public API is reachable and
 * covers the same symbols, quoted in USD rather than USDT.
 */

const COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products";
const MAX_CANDLES_PER_REQUEST = 300;
const PAGE_DELAY_MS = 250;

// Coinbase Exchange's public candles endpoint only accepts these exact
// granularities (seconds) — a smaller set than Binance's interval enum.
// Rejecting anything else up front gives a clear error instead of
// Coinbase's own less legible 400.
const SUPPORTED_GRANULARITY_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FetchCandlesInput {
  /** ARF-OS/trader-dev style symbol, e.g. "BTCUSDT" or "ZECUSDT". */
  symbol: string;
  timeframe: string;
  startTime: Date;
  endTime: Date;
}

/**
 * Maps this platform's `USDT`/`USD`-suffixed symbol convention (matching
 * SDL's `market.symbol` and trader-dev's own naming) onto a Coinbase
 * Exchange USD product id. Coinbase's own USDT-quoted products exist for
 * only a handful of assets, so USD is used uniformly — a labeled,
 * documented approximation (ADR 0014), not a claim that USDT and USD prices
 * are identical.
 */
export function mapSymbolToCoinbaseProductId(symbol: string): string {
  const base = symbol.endsWith("USDT")
    ? symbol.slice(0, -4)
    : symbol.endsWith("USD")
      ? symbol.slice(0, -3)
      : undefined;
  if (!base) {
    throw new Error(`Cannot map "${symbol}" to a Coinbase product: expected a USDT or USD-quoted symbol.`);
  }
  return `${base}-USD`;
}

function requireGranularitySeconds(timeframe: string): number {
  const granularitySeconds = SUPPORTED_GRANULARITY_SECONDS[timeframe];
  if (granularitySeconds === undefined) {
    throw new Error(
      `Unsupported timeframe "${timeframe}". Supported: ${Object.keys(SUPPORTED_GRANULARITY_SECONDS).join(", ")}.`,
    );
  }
  return granularitySeconds;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCandlesPage(productId: string, granularitySeconds: number, start: Date, end: Date): Promise<Candle[]> {
  const url = new URL(`${COINBASE_CANDLES_URL}/${productId}/candles`);
  url.searchParams.set("granularity", String(granularitySeconds));
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());

  const response = await fetch(url);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) detail = `${detail}: ${body.message}`;
    } catch {
      // Body wasn't JSON — the HTTP status alone is still a legible error.
    }
    throw new Error(`Coinbase candles request failed for ${productId}: ${detail}`);
  }

  const rows = (await response.json()) as [number, number, number, number, number, number][];
  // Coinbase documents [time, low, high, open, close, volume] — not OHLC order.
  return rows.map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume }));
}

/**
 * Paginates Coinbase's 300-candle-per-request cap by walking fixed-size
 * time windows (rather than Binance's "advance past the last bar"
 * approach, since Coinbase rejects a request whose range would exceed 300
 * candles at all, even if fewer would actually be returned near the range's
 * edge). Dedupes on exact timestamp in case adjacent windows overlap at a
 * boundary, then sorts ascending — Coinbase returns newest-first.
 */
export async function fetchCoinbaseCandles(input: FetchCandlesInput): Promise<Candle[]> {
  const granularitySeconds = requireGranularitySeconds(input.timeframe);
  const productId = mapSymbolToCoinbaseProductId(input.symbol);

  const windowMs = MAX_CANDLES_PER_REQUEST * granularitySeconds * 1000;
  const endMs = input.endTime.getTime();
  const byTime = new Map<number, Candle>();

  let windowStart = input.startTime.getTime();
  while (windowStart < endMs) {
    const windowEnd = Math.min(windowStart + windowMs, endMs);
    const page = await fetchCandlesPage(productId, granularitySeconds, new Date(windowStart), new Date(windowEnd));
    for (const candle of page) byTime.set(candle.time, candle);

    windowStart = windowEnd;
    if (windowStart < endMs) await delay(PAGE_DELAY_MS);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Converts Coinbase candles into the exact `time,open,high,low,close,volume`
 * CSV shape `parseOhlcvCsv` (packages/pine/src/ohlcv/csv.ts) already
 * expects — no changes needed to the parser.
 */
export function candlesToOhlcvCsv(candles: Candle[]): string {
  const header = "time,open,high,low,close,volume";
  const rows = candles.map(
    (c) => `${new Date(c.time * 1000).toISOString()},${c.open},${c.high},${c.low},${c.close},${c.volume}`,
  );
  return [header, ...rows].join("\n");
}
