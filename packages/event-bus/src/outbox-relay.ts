import { QUEUE_NAMES, deterministicJobId, type QueueName } from "./queues.js";

export interface OutboxRow {
  id: string;
  eventType: string;
  eventVersion: string;
  aggregateId: string;
  correlationId: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface RoutedJob {
  queue: QueueName;
  jobId: string;
  data: Record<string, unknown>;
}

/**
 * Maps a domain event type to the queue that should react to it. Returning
 * undefined for an unrecognised type is deliberate: an event nobody
 * subscribes to yet is marked PUBLISHED and dropped rather than retried
 * forever or crashing the relay.
 */
export function routeOutboxEvent(row: OutboxRow): RoutedJob | undefined {
  switch (row.eventType) {
    case "report_upload.uploaded":
      return {
        queue: QUEUE_NAMES.reportParse,
        jobId: deterministicJobId(QUEUE_NAMES.reportParse, row.id),
        data: row.payload,
      };
    case "report_upload.parsed":
      return {
        queue: QUEUE_NAMES.tradeNormalisation,
        // Keyed by the outbox row id, so a relay retry after a crash
        // produces the identical job id and BullMQ dedupes it.
        jobId: deterministicJobId(QUEUE_NAMES.tradeNormalisation, row.id),
        data: row.payload,
      };
    case "backtest_run.local_execution_requested":
      return {
        queue: QUEUE_NAMES.localRunnerExecution,
        jobId: deterministicJobId(QUEUE_NAMES.localRunnerExecution, row.id),
        data: row.payload,
      };
    case "trades.normalised":
      return {
        queue: QUEUE_NAMES.equityReconstruction,
        jobId: deterministicJobId(QUEUE_NAMES.equityReconstruction, row.id),
        data: row.payload,
      };
    case "equity.reconstructed":
      return {
        queue: QUEUE_NAMES.metricCalculation,
        jobId: deterministicJobId(QUEUE_NAMES.metricCalculation, row.id),
        data: row.payload,
      };
    case "metrics.calculated":
      return {
        queue: QUEUE_NAMES.parityCalculation,
        jobId: deterministicJobId(QUEUE_NAMES.parityCalculation, row.id),
        data: row.payload,
      };
    case "strategy_version.transitioned":
    case "committee_decision.created":
      return {
        queue: QUEUE_NAMES.readModelRefresh,
        jobId: deterministicJobId(QUEUE_NAMES.readModelRefresh, row.id),
        data: row.payload,
      };
    case "forward_signal.received":
      return {
        queue: QUEUE_NAMES.forwardSignalProcessing,
        jobId: deterministicJobId(QUEUE_NAMES.forwardSignalProcessing, row.id),
        data: row.payload,
      };
    case "agent_run.requested":
      return {
        queue: QUEUE_NAMES.agentRun,
        jobId: deterministicJobId(QUEUE_NAMES.agentRun, row.id),
        data: row.payload,
      };
    case "practice_run.requested":
      return {
        queue: QUEUE_NAMES.practiceRun,
        jobId: deterministicJobId(QUEUE_NAMES.practiceRun, row.id),
        data: row.payload,
      };
    default:
      return undefined;
  }
}

export interface OutboxStore {
  /** Claims a batch of PENDING rows. Implementations must use SELECT ... FOR UPDATE SKIP LOCKED so concurrent relays never claim the same row. */
  claimPending(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export interface JobPublisher {
  publish(job: RoutedJob): Promise<void>;
}

export interface RelayResult {
  claimed: number;
  published: number;
  skipped: number;
  failed: number;
}

/**
 * Drains one batch of the transactional outbox (CLAUDE.md 9.3). Pure
 * orchestration over two injected ports, so the claim/route/publish/mark
 * sequence — including partial-failure behaviour — is unit-testable with
 * no Postgres or Redis.
 *
 * A publish failure marks only that row FAILED and lets the rest of the
 * batch through; one poison event must not stall the queue.
 */
export async function relayOutboxBatch(
  store: OutboxStore,
  publisher: JobPublisher,
  batchSize = 50,
): Promise<RelayResult> {
  const rows = await store.claimPending(batchSize);
  const publishedIds: string[] = [];
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const job = routeOutboxEvent(row);
    if (!job) {
      skipped += 1;
      publishedIds.push(row.id);
      continue;
    }

    try {
      await publisher.publish(job);
      publishedIds.push(row.id);
    } catch (error) {
      failed += 1;
      await store.markFailed(row.id, error instanceof Error ? error.message : String(error));
    }
  }

  if (publishedIds.length > 0) {
    await store.markPublished(publishedIds);
  }

  return {
    claimed: rows.length,
    published: publishedIds.length - skipped,
    skipped,
    failed,
  };
}
