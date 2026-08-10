import { eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { backtestRuns, outboxEvents, reportUploads, trades } from "@arf-os/db";
import type { ParsedTrade } from "@arf-os/pine";

export interface TradeNormalisationResult {
  tradeCount: number;
  openTradeCount: number;
}

/**
 * Writes the trade ledger from a stored List of Trades parse result.
 *
 * The ledger is the foundation every later figure rests on — equity,
 * drawdown, metrics, parity — so this reads `report_uploads.parsed_trades`
 * rather than re-fetching and re-parsing the CSV: the rows it writes are
 * traceable to one stored parse result produced by one recorded parser
 * version (CLAUDE.md 15.1).
 *
 * Idempotent by deletion-then-insert per run, matching the analytics
 * handlers: replaying replaces the ledger instead of duplicating it.
 *
 * **On P&L:** a TradingView export states one profit figure per trade and no
 * per-trade fee breakdown. That figure is recorded as both `gross_pnl` and
 * `net_pnl`, with `fees` left at 0 — meaning "no separate fee figure was
 * reported", not "there were no fees". Leaving `net_pnl` null instead would
 * make every downstream metric silently compute zero closed trades, which
 * is a worse failure than an explicit, recorded assumption. If a runner ever
 * supplies real fee data, that is a new parser version and a new ledger, not
 * an edit to these rows.
 */
export async function handleTradeNormalisation(
  db: Database,
  input: { backtestRunId: string; reportUploadId: string },
): Promise<TradeNormalisationResult> {
  const [upload] = await db
    .select({ parsedTrades: reportUploads.parsedTrades, kind: reportUploads.kind })
    .from(reportUploads)
    .where(eq(reportUploads.id, input.reportUploadId))
    .limit(1);

  if (!upload) {
    throw new Error(`Report upload ${input.reportUploadId} not found.`);
  }
  if (upload.kind !== "LIST_OF_TRADES") {
    throw new Error(
      `Report upload ${input.reportUploadId} is a ${upload.kind}; only a LIST_OF_TRADES yields a trade ledger.`,
    );
  }
  if (!upload.parsedTrades) {
    // The API only emits the event for a successful parse, so this means the
    // row changed underneath us rather than that the ledger is legitimately
    // empty. Fail loudly instead of writing an empty ledger that would read
    // as "this strategy took no trades".
    throw new Error(`Report upload ${input.reportUploadId} has no parsed trades to normalise.`);
  }

  const [run] = await db
    .select({ initialCapital: backtestRuns.initialCapital })
    .from(backtestRuns)
    .where(eq(backtestRuns.id, input.backtestRunId))
    .limit(1);

  if (!run) {
    throw new Error(`Backtest run ${input.backtestRunId} not found.`);
  }

  const parsed = upload.parsedTrades as ParsedTrade[];
  const rows = parsed.map((trade) => ({
    id: generateId<string>(),
    backtestRunId: input.backtestRunId,
    sequenceNumber: trade.tradeNumber,
    direction: trade.direction,
    entryTime: new Date(trade.entryTime),
    exitTime: trade.exitTime === undefined ? null : new Date(trade.exitTime),
    entryPrice: String(trade.entryPrice),
    exitPrice: trade.exitPrice === undefined ? null : String(trade.exitPrice),
    quantity: String(trade.quantity),
    grossPnl: trade.grossPnl === undefined ? null : String(trade.grossPnl),
    fees: "0",
    netPnl: trade.grossPnl === undefined ? null : String(trade.grossPnl),
  }));

  await db.transaction(async (tx) => {
    await tx.delete(trades).where(eq(trades.backtestRunId, input.backtestRunId));

    if (rows.length > 0) {
      await tx.insert(trades).values(rows);
    }

    // Same transaction as the ledger (CLAUDE.md 9.3). The relay routes this
    // to equity reconstruction, which needs the run's capital as well as
    // its id — EquityReconstructionJob's exact shape.
    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "trades.normalised",
      eventVersion: "1.0.0",
      aggregateId: input.backtestRunId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      actor: "worker-backtest",
      payload: { backtestRunId: input.backtestRunId, initialCapital: run.initialCapital },
      createdAt: now,
    });
  });

  return {
    tradeCount: rows.length,
    openTradeCount: parsed.filter((trade) => trade.isOpen).length,
  };
}
