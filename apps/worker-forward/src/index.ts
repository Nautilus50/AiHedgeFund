import { Worker } from "bullmq";
import Fastify from "fastify";
import { createDatabase } from "@arf-os/db";
import { ForwardSignalProcessingJob, QUEUE_NAMES, parseRedisUrl } from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";
import { handleForwardSignalProcessing } from "./handlers.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — expected in production where env vars are injected directly.
}

const logger = createLogger("worker-forward");
const PORT = Number(process.env.PORT ?? 4004);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const connection = parseRedisUrl(requireEnv("REDIS_URL"));

  const signalWorker = new Worker(
    QUEUE_NAMES.forwardSignalProcessing,
    async (job) => {
      const input = ForwardSignalProcessingJob.parse(job.data);
      const result = await handleForwardSignalProcessing(db, input);
      logger.info({ jobId: job.id, ...input, ...result }, "forward signal processed");
      return result;
    },
    { connection },
  );

  signalWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, queue: QUEUE_NAMES.forwardSignalProcessing, err: error }, "job failed");
  });

  logger.info({ queues: [QUEUE_NAMES.forwardSignalProcessing] }, "worker started");

  const app = Fastify({ logger: true });
  app.get("/health", async () => ({
    status: "ok",
    service: "arf-os-worker-forward",
    timestamp: new Date().toISOString(),
  }));
  await app.listen({ port: PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    logger.info("shutting down");
    await Promise.all([signalWorker.close(), app.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
