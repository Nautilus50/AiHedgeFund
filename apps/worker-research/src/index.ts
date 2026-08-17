import { Worker } from "bullmq";
import { createDevelopmentProvider } from "@arf-os/agent-runtime";
import { createDatabase } from "@arf-os/db";
import { AgentRunJob, PracticeRunJob, QUEUE_NAMES, parseRedisUrl } from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";
import { handleAgentRun, handlePracticeRun } from "./handlers.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file — expected in production where env vars are injected directly.
}

const logger = createLogger("worker-research");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Runs specialist agent tasks for every role in `AGENT_RUNTIME_REGISTRY`
 * (currently IDEA_SCOUT and INDICATOR_RESEARCHER — see ADR 0008 for the
 * remaining roles and why no real LLM provider adapter exists yet).
 */
async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const connection = parseRedisUrl(requireEnv("REDIS_URL"));
  const provider = createDevelopmentProvider();

  const worker = new Worker(
    QUEUE_NAMES.agentRun,
    async (job) => {
      const input = AgentRunJob.parse(job.data);
      const result = await handleAgentRun(db, provider, input);

      logger.info(
        { jobId: job.id, campaignId: input.campaignId, role: input.role, ...result },
        result.skipped ? "already terminal, skipping redelivered job" : "agent run completed",
      );
      return result;
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "agent run failed");
  });

  logger.info({ queue: QUEUE_NAMES.agentRun, provider: provider.name }, "worker started");

  const practiceWorker = new Worker(
    QUEUE_NAMES.practiceRun,
    async (job) => {
      const input = PracticeRunJob.parse(job.data);
      const result = await handlePracticeRun(db, provider, input);

      logger.info(
        { jobId: job.id, benchmarkTaskId: input.benchmarkTaskId, role: input.role, ...result },
        result.skipped ? "already terminal, skipping redelivered job" : "practice run completed",
      );
      return result;
    },
    { connection },
  );

  practiceWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "practice run failed");
  });

  logger.info({ queue: QUEUE_NAMES.practiceRun, provider: provider.name }, "worker started");

  const shutdown = async () => {
    logger.info("shutting down");
    await Promise.all([worker.close(), practiceWorker.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
