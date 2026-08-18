import { createDatabase } from "@arf-os/db";
import { fetchCoinbaseCandles, candlesToOhlcvCsv } from "../services/market-data/coinbase.js";
import { createDatasetVersion, findMatchingDatasetVersion } from "../services/datasets.js";
import { createObjectStoreClient } from "../services/object-store.js";

/**
 * Operator-run backfill script (ADR 0014): pulls real historical OHLCV bars
 * from Coinbase Exchange's public REST API and stores them as a
 * `dataset_versions` row, closing the gap ADR 0005 left open ("real
 * ingestion is separate future scope"). Mirrors `reap-abandoned-uploads.ts`
 * / `sweep-health-snapshots.ts`'s exact shape — this repo has no
 * in-process scheduled-job mechanism, so this is a manually-run (or
 * externally scheduled) one-off, not something the app triggers itself.
 *
 * Read-only public market data, no API key, no account, no order routing —
 * this is explicitly not the live-trading scope CLAUDE.md 3.9 restricts.
 * Binance was the original choice but returns HTTP 451 from this
 * deployment's network (datacenter-IP restriction); Coinbase Exchange is
 * reachable and covers the same symbols, quoted in USD rather than USDT
 * (see ADR 0014). Only symbols Coinbase actually lists can be ingested;
 * forex/commodities strategies still need TradingView verification.
 *
 * Usage:
 *   tsx src/scripts/ingest-ohlcv.ts <organisationId> <symbol> <timeframe> --from=<ISO> --to=<ISO>
 *
 * Example:
 *   tsx src/scripts/ingest-ohlcv.ts ab5a2d1f-... BTCUSDT 1h --from=2024-01-01T00:00:00Z --to=2024-04-01T00:00:00Z
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [organisationId, symbol, timeframe] = positional;

  if (!organisationId || !symbol || !timeframe) {
    throw new Error(
      "Usage: tsx src/scripts/ingest-ohlcv.ts <organisationId> <symbol> <timeframe> --from=<ISO> --to=<ISO>",
    );
  }

  const fromArg = parseFlag(args, "from");
  const toArg = parseFlag(args, "to");
  if (!fromArg || !toArg) {
    throw new Error("Both --from=<ISO> and --to=<ISO> are required (no implicit default range).");
  }

  const from = new Date(fromArg);
  const to = new Date(toArg);
  if (Number.isNaN(from.getTime())) throw new Error(`--from is not a valid date: ${fromArg}`);
  if (Number.isNaN(to.getTime())) throw new Error(`--to is not a valid date: ${toArg}`);
  if (from >= to) throw new Error("--from must be earlier than --to.");

  const db = createDatabase(requireEnv("DATABASE_URL"));
  const bucket = requireEnv("OBJECT_STORE_BUCKET");
  const s3 = createObjectStoreClient({
    endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
    bucket,
    accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    region: process.env.OBJECT_STORE_REGION,
  });

  console.log(`Fetching ${symbol} ${timeframe} from Coinbase Exchange, ${from.toISOString()} -> ${to.toISOString()}...`);
  const candles = await fetchCoinbaseCandles({ symbol, timeframe, startTime: from, endTime: to });
  if (candles.length === 0) {
    throw new Error(`Coinbase returned zero bars for ${symbol} ${timeframe} in this range — check the symbol and range.`);
  }

  const csv = candlesToOhlcvCsv(candles);
  const firstBar = candles[0];
  const lastBar = candles[candles.length - 1];
  if (!firstBar || !lastBar) throw new Error("Unreachable: candles non-empty but first/last bar missing.");

  const actualFromTs = new Date(firstBar.time * 1000);
  const actualToTs = new Date(lastBar.time * 1000);
  console.log(
    `Received ${candles.length} bar(s), actual coverage ${actualFromTs.toISOString()} -> ${actualToTs.toISOString()}` +
      (actualFromTs.getTime() !== from.getTime() ? " (earliest available bar is later than --from — Coinbase has no earlier data for this symbol)." : "."),
  );

  const existing = await findMatchingDatasetVersion(db, organisationId, symbol, timeframe, actualFromTs, actualToTs);
  if (existing) {
    console.log(`A dataset version already covers this exact symbol/timeframe/range: ${existing.datasetVersionId} (skipped, no duplicate written).`);
    return;
  }

  const filename = `${symbol}-${timeframe}-${actualFromTs.toISOString()}-${actualToTs.toISOString()}.csv`;
  const { datasetVersionId } = await createDatasetVersion(db, s3, bucket, { organisationId, symbol, timeframe, filename, csv });
  console.log(`Created dataset version ${datasetVersionId} (${candles.length} bars).`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
