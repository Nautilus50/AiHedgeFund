import { Worker } from "bullmq";
import { createDatabase } from "@arf-os/db";
import {
  BullMqPublisher,
  DrizzleOutboxStore,
  LocalRunnerExecutionJob,
  QUEUE_NAMES,
  ReportParseJob,
  TradeNormalisationJob,
  parseRedisUrl,
  relayOutboxBatch,
} from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";
import { handleLocalRunnerExecution, handleReportParse, handleTradeNormalisation } from "./handlers.js";
import { createObjectStoreClient } from "./object-store.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — expected in production where env vars are injected directly.
}

const logger = createLogger("worker-backtest");

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
const RECLAIM_INTERVAL_MS = Number(process.env.OUTBOX_RECLAIM_INTERVAL_MS ?? 60_000);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Runs the transactional-outbox relay: claims committed domain events and
 * publishes them onto BullMQ (CLAUDE.md 9.3). Separate from the API process
 * so a publish stall can never block a request, and safe to run in multiple
 * replicas because claims use FOR UPDATE SKIP LOCKED.
 *
 * Also hosts report-ingestion consumers, which is this app's stated
 * responsibility (CLAUDE.md — "runner and report ingestion jobs"). The
 * BullMQ worker is event-driven and the relay loop awaits on every
 * iteration, so the two run concurrently in one process.
 */
async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const connection = parseRedisUrl(requireEnv("REDIS_URL"));
  const store = new DrizzleOutboxStore(db);
  const publisher = new BullMqPublisher(connection);

  const bucket = requireEnv("OBJECT_STORE_BUCKET");
  const s3 = createObjectStoreClient({
    endpoint: requireEnv("OBJECT_STORE_ENDPOINT"),
    accessKeyId: requireEnv("OBJECT_STORE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("OBJECT_STORE_SECRET_ACCESS_KEY"),
    region: process.env.OBJECT_STORE_REGION,
  });

  const reportParseWorker = new Worker(
    QUEUE_NAMES.reportParse,
    async (job) => {
      const input = ReportParseJob.parse(job.data);
      const result = await handleReportParse(db, s3, bucket, input);
      logger.info({ jobId: job.id, ...input, ...result }, "report upload parsed");
      return result;
    },
    { connection },
  );

  reportParseWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, queue: QUEUE_NAMES.reportParse, err: error }, "job failed");
  });

  const normalisationWorker = new Worker(
    QUEUE_NAMES.tradeNormalisation,
    async (job) => {
      const input = TradeNormalisationJob.parse(job.data);
      const result = await handleTradeNormalisation(db, input);
      logger.info({ jobId: job.id, ...input, ...result }, "trades normalised");
      return result;
    },
    { connection },
  );

  normalisationWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, queue: QUEUE_NAMES.tradeNormalisation, err: error }, "job failed");
  });

  const localRunnerWorker = new Worker(
    QUEUE_NAMES.localRunnerExecution,
    async (job) => {
      const input = LocalRunnerExecutionJob.parse(job.data);
      const result = await handleLocalRunnerExecution(db, { s3, bucket }, input);
      logger.info({ jobId: job.id, ...input, ...result }, "local backtest run executed");
      return result;
    },
    { connection },
  );

  localRunnerWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, queue: QUEUE_NAMES.localRunnerExecution, err: error }, "job failed");
  });

  let running = true;

  const shutdown = async () => {
    logger.info("shutting down");
    running = false;
    await reportParseWorker.close();
    await normalisationWorker.close();
    await localRunnerWorker.close();
    await publisher.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Rows stranded in PUBLISHING by a crashed relay are returned to PENDING.
  // Re-publishing is safe: routed jobs carry deterministic ids, so BullMQ
  // collapses any duplicate.
  const reclaimTimer = setInterval(() => {
    void store
      .reclaimStale()
      .then((count) => {
        if (count > 0) logger.warn({ count }, "reclaimed stale outbox rows");
      })
      .catch((error: unknown) => logger.error({ err: error }, "outbox reclaim failed"));
  }, RECLAIM_INTERVAL_MS);
  reclaimTimer.unref();

  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      queues: [QUEUE_NAMES.reportParse, QUEUE_NAMES.tradeNormalisation, QUEUE_NAMES.localRunnerExecution],
    },
    "outbox relay started",
  );

  while (running) {
    try {
      const result = await relayOutboxBatch(store, publisher, BATCH_SIZE);
      if (result.claimed > 0) {
        logger.info(result, "outbox batch relayed");
      }
      // Only idle when the outbox was empty; a full batch likely means more
      // is waiting, so loop straight into the next one.
      if (result.claimed === 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      logger.error({ err: error }, "outbox relay iteration failed");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "outbox relay failed to start");
  process.exit(1);
});
