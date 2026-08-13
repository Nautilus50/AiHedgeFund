import { Worker } from "bullmq";
import { createDatabase } from "@arf-os/db";
import {
  EquityReconstructionJob,
  MetricCalculationJob,
  ParityCalculationJob,
  QUEUE_NAMES,
  ReadModelRefreshJob,
  parseRedisUrl,
} from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";
import {
  handleEquityReconstruction,
  handleMetricCalculation,
  handleParityCalculation,
  handleReadModelRefresh,
  markRunAnalysed,
} from "./handlers.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — expected in production where env vars are injected directly.
}

const logger = createLogger("worker-analytics");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const connection = parseRedisUrl(requireEnv("REDIS_URL"));

  const equityWorker = new Worker(
    QUEUE_NAMES.equityReconstruction,
    async (job) => {
      const input = EquityReconstructionJob.parse(job.data);
      const result = await handleEquityReconstruction(db, input);
      logger.info({ jobId: job.id, backtestRunId: input.backtestRunId, ...result }, "equity reconstructed");
      return result;
    },
    { connection },
  );

  const metricsWorker = new Worker(
    QUEUE_NAMES.metricCalculation,
    async (job) => {
      const input = MetricCalculationJob.parse(job.data);
      const result = await handleMetricCalculation(db, input);
      await markRunAnalysed(db, input.backtestRunId);
      logger.info({ jobId: job.id, backtestRunId: input.backtestRunId, ...result }, "metrics calculated");
      return result;
    },
    { connection },
  );

  const parityWorker = new Worker(
    QUEUE_NAMES.parityCalculation,
    async (job) => {
      const input = ParityCalculationJob.parse(job.data);
      const result = await handleParityCalculation(db, input);
      logger.info(
        { jobId: job.id, backtestRunId: input.backtestRunId, verificationId: input.verificationId, ...result },
        "parity calculated",
      );
      return result;
    },
    { connection },
  );

  const readModelWorker = new Worker(
    QUEUE_NAMES.readModelRefresh,
    async (job) => {
      const input = ReadModelRefreshJob.parse(job.data);
      const result = await handleReadModelRefresh(db, input);
      logger.info({ jobId: job.id, ...input, ...result }, "read model refreshed");
      return result;
    },
    { connection },
  );

  for (const worker of [equityWorker, metricsWorker, parityWorker, readModelWorker]) {
    worker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, queue: worker.name, err: error }, "job failed");
    });
  }

  logger.info(
    {
      queues: [
        QUEUE_NAMES.equityReconstruction,
        QUEUE_NAMES.metricCalculation,
        QUEUE_NAMES.parityCalculation,
        QUEUE_NAMES.readModelRefresh,
      ],
    },
    "worker started",
  );

  const shutdown = async () => {
    logger.info("shutting down");
    await Promise.all([equityWorker.close(), metricsWorker.close(), parityWorker.close(), readModelWorker.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
