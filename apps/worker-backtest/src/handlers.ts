import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { BacktestPlan } from "@arf-os/contracts";
import { BacktestSegmentKind, CostModel, StrategyDefinition, generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  artefacts,
  backtestRuns,
  datasetVersions,
  outboxEvents,
  reportUploads,
  strategies,
  strategyDefinitions,
  strategyVersions,
  trades,
} from "@arf-os/db";
import { createLocalPineRunner, type BacktestTrade } from "@arf-os/backtest-sdk";
import type { ReportParseJob } from "@arf-os/event-bus";
import { parseListOfTrades, parseOhlcvCsv, parsePerformanceSummary, type ParsedTrade } from "@arf-os/pine";
import { fetchObjectText } from "./object-store.js";

/**
 * A `backtest_runs` row doesn't carry its own organisation — only
 * `strategies` does. Every outbox event this file emits needs one (SSE
 * streams filter and resume by it), so this is resolved once wherever a run
 * id is available rather than duplicating the join at each insert site.
 */
async function resolveOrganisationId(db: Database, backtestRunId: string): Promise<string> {
  const [row] = await db
    .select({ organisationId: strategies.organisationId })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(backtestRuns.id, backtestRunId))
    .limit(1);

  if (!row) {
    throw new Error(`Cannot resolve organisationId for backtest run ${backtestRunId}.`);
  }
  return row.organisationId;
}

export interface ReportParseResult {
  parseStatus: "PARSED" | "FAILED";
  /** True when a report_upload.parsed event was emitted, i.e. normalisation will run. */
  normalisationQueued: boolean;
}

/**
 * Parses a raw report upload — the job the outbox routes from
 * `report_upload.uploaded`. Re-fetches the object by key rather than trusting
 * anything cached in the job payload, so the parse is always against the
 * exact bytes that were durably stored (CLAUDE.md 15.1).
 *
 * The raw artefact is already persisted by the API before this job ever
 * runs, so a parse failure here only ever downgrades `report_uploads` to
 * FAILED with warnings — it never loses the raw upload.
 */
export async function handleReportParse(db: Database, s3: S3Client, bucket: string, input: ReportParseJob): Promise<ReportParseResult> {
  const text = await fetchObjectText(s3, bucket, input.objectKey);

  const outcome =
    input.kind === "LIST_OF_TRADES"
      ? { kind: "LIST_OF_TRADES" as const, result: parseListOfTrades(text) }
      : { kind: "PERFORMANCE_SUMMARY" as const, result: parsePerformanceSummary(text) };

  const parseStatus = outcome.result.ok ? "PARSED" : "FAILED";
  const parserVersion = outcome.result.ok ? outcome.result.parserVersion : undefined;
  const parseWarnings = outcome.result.ok
    ? outcome.result.warnings.map((w) => `${w.code}: ${w.message}`)
    : [outcome.result.message];

  // A Performance Summary's reported metrics are the only TradingView side
  // parity has to compare against, so they are persisted here rather than
  // returned and discarded. Stored verbatim — titles and source column
  // headers as the parser produced them, no reinterpretation (CLAUDE.md 15.2).
  const parsedMetrics = outcome.kind === "PERFORMANCE_SUMMARY" && outcome.result.ok ? outcome.result.metrics : null;

  // Likewise for a trade ledger: normalisation reads this rather than
  // re-fetching and re-parsing the raw CSV, so the ledger it writes is
  // traceable to one stored parse result and one parser version.
  const parsedTrades = outcome.kind === "LIST_OF_TRADES" && outcome.result.ok ? outcome.result.trades : null;

  // Only a successfully parsed ledger attached to a known run can be
  // normalised. Without both, the upload is still stored — it is evidence
  // either way — but no event is emitted, because there is nothing a
  // consumer could do with it.
  const normalisationQueued = parsedTrades !== null && input.backtestRunId !== undefined;

  await db.transaction(async (tx) => {
    await tx
      .update(reportUploads)
      .set({ parseStatus, parserVersion, parseWarnings, parsedMetrics, parsedTrades })
      .where(eq(reportUploads.id, input.reportUploadId));

    // Same transaction as the parse result (CLAUDE.md 9.3). The relay routes
    // this to trade normalisation.
    if (normalisationQueued) {
      const now = new Date();
      await tx.insert(outboxEvents).values({
        id: generateId<string>(),
        eventType: "report_upload.parsed",
        eventVersion: "1.0.0",
        aggregateId: input.reportUploadId,
        aggregateVersion: now.getTime().toString(),
        correlationId: generateId<string>(),
        organisationId: input.organisationId,
        actor: "worker-backtest",
        // TradeNormalisationJob's exact shape.
        payload: { backtestRunId: input.backtestRunId, reportUploadId: input.reportUploadId },
        createdAt: now,
      });
    }
  });

  return { parseStatus, normalisationQueued };
}

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

  const organisationId = await resolveOrganisationId(db, input.backtestRunId);

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
      organisationId,
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
 *
 * Transactional (CLAUDE.md 9.3): the status update and the `backtest_run
 * .completed` notification it emits must both survive or both roll back —
 * an SSE viewer resuming from a gap should never see a run whose failure
 * was recorded but never announced, or announced but not actually recorded.
 * Never called for `FAILED_RETRYABLE` (this handler never sets that status)
 * — a "completed" event on a run about to retry would tell a live viewer
 * it's done when it isn't.
 */
async function markFailed(db: Database, backtestRunId: string, organisationId: string, errorCode: string): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(backtestRuns)
      .set({ status: "FAILED_TERMINAL", errorCode, completedAt: now })
      .where(eq(backtestRuns.id, backtestRunId));

    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "backtest_run.completed",
      eventVersion: "1.0.0",
      aggregateId: backtestRunId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      organisationId,
      actor: "worker-backtest",
      payload: { backtestRunId, status: "FAILED_TERMINAL", errorCode },
      createdAt: now,
    });
  });
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
    // No aggregate exists to attach a completion event to — genuinely
    // should never happen (the job is only ever enqueued for a run the API
    // just created), so left as a throw rather than a markFailed call.
    throw new Error(`Backtest run ${input.backtestRunId} not found.`);
  }

  const organisationId = await resolveOrganisationId(db, run.id);

  if (!run.datasetVersionId) {
    // Defensive: the API only emits this job for LOCAL_RUNNER runs, and the
    // route requires a datasetVersionId for those. The run row already
    // exists, though, so — unlike the not-found case above — leaving it
    // un-terminal here would mean a live viewer sees it hang forever;
    // treat it like every other validation failure below.
    await markFailed(db, run.id, organisationId, "MISSING_DATASET_VERSION_ID");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_DATASET_VERSION_ID" };
  }

  await db.update(backtestRuns).set({ status: "RUNNING", startedAt: new Date() }).where(eq(backtestRuns.id, run.id));

  const [definitionRow] = await db
    .select({ definition: strategyDefinitions.definition })
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.strategyVersionId, run.strategyVersionId))
    .limit(1);
  if (!definitionRow) {
    await markFailed(db, run.id, organisationId, "MISSING_STRATEGY_DEFINITION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_STRATEGY_DEFINITION" };
  }
  const definitionResult = StrategyDefinition.safeParse(definitionRow.definition);
  if (!definitionResult.success) {
    await markFailed(db, run.id, organisationId, "INVALID_STRATEGY_DEFINITION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "INVALID_STRATEGY_DEFINITION" };
  }
  const definition = definitionResult.data;

  const [dataset] = await db
    .select({ artefactId: datasetVersions.artefactId })
    .from(datasetVersions)
    .where(eq(datasetVersions.id, run.datasetVersionId))
    .limit(1);
  if (!dataset) {
    await markFailed(db, run.id, organisationId, "MISSING_DATASET_VERSION");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_DATASET_VERSION" };
  }

  const [artefact] = await db
    .select({ objectKey: artefacts.objectKey })
    .from(artefacts)
    .where(eq(artefacts.id, dataset.artefactId))
    .limit(1);
  if (!artefact) {
    await markFailed(db, run.id, organisationId, "MISSING_DATASET_ARTEFACT");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "MISSING_DATASET_ARTEFACT" };
  }

  const csv = await fetchObjectText(deps.s3, deps.bucket, artefact.objectKey);
  const parsed = parseOhlcvCsv(csv);
  if (!parsed.ok) {
    await markFailed(db, run.id, organisationId, "DATASET_PARSE_FAILED");
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
    await markFailed(db, run.id, organisationId, errorCode);
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
    await markFailed(db, run.id, organisationId, "COMPILE_FAILED");
    return { status: "FAILED_TERMINAL", tradeCount: 0, errorCode: "COMPILE_FAILED" };
  }

  const result = await runner.run({ runId: run.id, definition, plan, bars });
  if (!result.ok) {
    await markFailed(db, run.id, organisationId, result.errorCode);
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
      organisationId,
      actor: "worker-backtest",
      payload: { backtestRunId: run.id, initialCapital: run.initialCapital },
      createdAt: now,
    });

    // SSE-only notification (no downstream queue consumer) — a live viewer
    // on the backtest-run page refetches on receiving this rather than the
    // event carrying computed state itself (ADR 0007).
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "backtest_run.completed",
      eventVersion: "1.0.0",
      aggregateId: run.id,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      organisationId,
      actor: "worker-backtest",
      payload: { backtestRunId: run.id, status: "SUCCEEDED" },
      createdAt: now,
    });
  });

  return { status: "SUCCEEDED", tradeCount: rows.length };
}
