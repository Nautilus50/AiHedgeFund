import { createDatabase } from "@arf-os/db";
import {
  BullMqPublisher,
  DrizzleOutboxStore,
  parseRedisUrl,
  relayOutboxBatch,
} from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";

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
 */
async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const store = new DrizzleOutboxStore(db);
  const publisher = new BullMqPublisher(parseRedisUrl(requireEnv("REDIS_URL")));

  let running = true;

  const shutdown = async () => {
    logger.info("shutting down");
    running = false;
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

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE }, "outbox relay started");

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
