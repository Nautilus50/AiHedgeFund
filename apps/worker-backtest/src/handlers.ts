import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { BacktestPlan } from "@arf-os/contracts";
import { BacktestSegmentKind, CostModel, StrategyDefinition, generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { artefacts, backtestRuns, datasetVersions, outboxEvents, reportUploads, strategyDefinitions, trades } from "@arf-os/db";
import { createLocalPineRunner, type BacktestTrade } from "@arf-os/backtest-sdk";
import { parseOhlcvCsv, type ParsedTrade } from "@arf-os/pine";
import { fetchObjectText } from "./object-store.js";

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

export interface LocalRunnerExecutionDeps {
  s3: S3Client;
  bucket: string;
}

export interface LocalRunnerExecutionResult {
  status: "SUCCEEDED" | "FAILED_TERMINAL";
  tradeCount: number;
  errorCode?: string | undefined;
}

function tradeRow(backtestRunId: string, trade: BacktestTrade) {
  return {
    id: generateId<string>(),
    backtestRunId,
    sequenceNumber: trade.sequenceNumber,
    direction: trade.direction,
    entryTime: new Date(trade.entryTime),
    exitTime: trade.exitTime === undefined ? null : new Date(trade.exitTime),
    entryPrice: String(trade.entryPrice),
    exitPrice: trade.exitPrice === undefined ? null : String(trade.exitPrice),
    quantity: String(trade.quantity),
    grossPnl: trade.grossPnl === undefined ? null : String(trade.grossPnl),
    fees: String(trade.fees),
    netPnl: trade.netPnl === undefined ? null : String(trade.netPnl),
    entryReason: trade.entryReason,
    exitReason: trade.exitReason ?? null,
  };
}

/**
 * Marks a run as terminally failed with no trade ledger. Compile/simulation
 * failures are deterministic — an SDL using an unsupported feature will
 * fail identically on retry — so this is not a job failure BullMQ should
 * retry (CLAUDE.md 3.6): the job itself completes normally, having recorded
 * a failed *backtest run*.
 */
async function markFailed(db: Database, backtestRunId: string, errorCode: string): Promise<void> {
  await db
    .update(backtestRuns)
    .set({ status: "FAILED_TERMINAL", errorCode, completedAt: new Date() })
    .where(eq(backtestRuns.id, backtestRunId));
}

/**
 * Executes a LOCAL_RUNNER backtest: loads the run's dataset and SDL,
 * compiles and runs the strategy via `@arf-os/backtest-sdk`'s local Pine
 * runner, and writes the resulting trade ledger.
 *
 * Deliberately emits the *same* `trades.normalised` event
 * {@link handleTradeNormalisation} does, with the identical payload shape —
 * the existing equity-reconstruction → metric-calculation chain picks it up
 * unchanged, so this handler never touches equity or metrics directly.
 *
 * Idempotent by deletion-then-insert per run, matching
 * {@link handleTradeNormalisation}.
 */
export async function handleLocalRunnerExecution(
  db: Database,
  deps: LocalRunnerExecutionDeps,
  input: { backtestRunId: string },
): Promise<LocalRunnerExecutionResult> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, input.backtestRunId)).limit(1);

  if (!run) {
    throw new Error(`Backtest run ${input.backtestRunId} not found.`);
  }
  if (!run.datasetVersionId) {
    // Defensive: the API only emits this job for LOCAL_RUNNER runs, and the
    // route requires a datasetVersionId for those.
    throw new Error(`Backtest run ${input.backtestRunId} has no dataset_version_id.`);
  }

  await db.update(backtestRuns).set({ status: "RUNNING", startedAt: new Date() }).where(eq(backtestRuns.id, run.id));

  const [definitionRow] = await db
    .select({ definition: strategyDefinitions.definition })
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.strategyVersionId, run.strategyVersionId))
    .limit(1);
  if (!definitionRow) {
    await markFailed(db, run.id, "MISSING_STRATEGY_DEFINITION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_STRATEGY_DEFINITION" };
  }
  const definitionResult = StrategyDefinition.safeParse(definitionRow.definition);
  if (!definitionResult.success) {
    await markFailed(db, run.id, "INVALID_STRATEGY_DEFINITION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "INVALID_STRATEGY_DEFINITION" };
  }
  const definition = definitionResult.data;

  const [dataset] = await db
    .select({ artefactId: datasetVersions.artefactId })
    .from(datasetVersions)
    .where(eq(datasetVersions.id, run.datasetVersionId))
    .limit(1);
  if (!dataset) {
    await markFailed(db, run.id, "MISSING_DATASET_VERSION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_DATASET_VERSION" };
  }

  const [artefact] = await db
    .select({ objectKey: artefacts.objectKey })
    .from(artefacts)
    .where(eq(artefacts.id, dataset.artefactId))
    .limit(1);
  if (!artefact) {
    await markFailed(db, run.id, "MISSING_DATASET_ARTEFACT");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_DATASET_ARTEFACT" };
  }

  const csv = await fetchObjectText(deps.s3, deps.bucket, artefact.objectKey);
  const parsed = parseOhlcvCsv(csv);
  if (!parsed.ok) {
    await markFailed(db, run.id, "DATASET_PARSE_FAILED");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "DATASET_PARSE_FAILED" };
  }

  const fromMs = run.fromTs.getTime();
  const toMs = run.toTs.getTime();
  const bars = parsed.bars.filter((bar) => {
    const t = new Date(bar.time).getTime();
    return t >= fromMs && t <= toMs;
  });

  // The route only validates costModel as "some object" (z.record(z.unknown()))
  // since TRADINGVIEW runs use a different, looser shape — so a LOCAL_RUNNER
  // run's costModel is only actually validated here, at the point it matters.
  const costModelResult = CostModel.safeParse(run.costModel);
  const segmentKindResult = BacktestSegmentKind.safeParse(run.segmentKind);
  if (!costModelResult.success || !segmentKindResult.success) {
    const errorCode = !costModelResult.success ? "INVALID_COST_MODEL" : "INVALID_SEGMENT_KIND";
    await markFailed(db, run.id, errorCode);
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode };
  }

  const plan: BacktestPlan = {
    strategyVersionId: run.strategyVersionId,
    runnerType: "LOCAL_RUNNER",
    symbol: run.symbol,
    timeframe: run.timeframe,
    segmentKind: segmentKindResult.data,
    fromTs: run.fromTs.toISOString(),
    toTs: run.toTs.toISOString(),
    costModel: costModelResult.data,
    initialCapital: Number(run.initialCapital),
  };

  const runner = createLocalPineRunner();
  const compileResult = await runner.compile({ definition });
  if (!compileResult.ok) {
    await markFailed(db, run.id, "COMPILE_FAILED");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "COMPILE_FAILED" };
  }

  const result = await runner.run({ runId: run.id, definition, plan, bars });
  if (!result.ok) {
    await markFailed(db, run.id, result.errorCode);
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: result.errorCode };
  }

  const rows = result.trades.map((trade) => tradeRow(run.id, trade));

  await db.transaction(async (tx) => {
    await tx.delete(trades).where(eq(trades.backtestRunId, run.id));
    if (rows.length > 0) {
      await tx.insert(trades).values(rows);
    }

    await tx
      .update(backtestRuns)
      .set({ status: "SUCCEEDED", completedAt: new Date(), errorCode: null })
      .where(eq(backtestRuns.id, run.id));

    // Same transaction as the ledger (CLAUDE.md 9.3). EquityReconstructionJob's exact shape.
    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "trades.normalised",
      eventVersion: "1.0.0",
      aggregateId: run.id,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      actor: "worker-backtest",
      payload: { backtestRunId: run.id, initialCapital: run.initialCapital },
      createdAt: now,
    });
  });

  return { status: "SUCCEEDED", tradeCount: rows.length };
}
