import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import {
  IdeaCard,
  IDEA_SCOUT_PROMPT_VERSION,
  IDEA_SCOUT_SYSTEM_PROMPT,
  createDevelopmentProvider,
  runStructuredAgent,
} from "@arf-os/agent-runtime";
import { createDatabase } from "@arf-os/db";
import { researchTasks } from "@arf-os/db";
import { AgentRunJob, QUEUE_NAMES, parseRedisUrl } from "@arf-os/event-bus";
import { createLogger } from "@arf-os/observability";

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
 * Runs specialist agent tasks. Only the IDEA_SCOUT path is wired for this
 * milestone (CLAUDE_CODE_BUILD_PROMPT.md), and it deliberately does NOT
 * transition workflow state — the worker stores its structured output and
 * the API/orchestrator applies transition policy (CLAUDE.md 3.2).
 */
async function main() {
  const db = createDatabase(requireEnv("DATABASE_URL"));
  const connection = parseRedisUrl(requireEnv("REDIS_URL"));
  const provider = createDevelopmentProvider();

  const worker = new Worker(
    QUEUE_NAMES.agentRun,
    async (job) => {
      const input = AgentRunJob.parse(job.data);

      if (input.role !== "IDEA_SCOUT") {
        throw new Error(`Role ${input.role} is not wired in this milestone.`);
      }

      await db
        .update(researchTasks)
        .set({ status: "RUNNING" })
        .where(eq(researchTasks.id, input.researchTaskId));

      const outcome = await runStructuredAgent(provider, {
        role: "IDEA_SCOUT",
        promptVersion: IDEA_SCOUT_PROMPT_VERSION,
        systemPrompt: IDEA_SCOUT_SYSTEM_PROMPT,
        userInput: `Campaign ${input.campaignId}: propose one falsifiable idea.`,
        outputSchema: IdeaCard,
      });

      if (!outcome.ok) {
        // Raw provider output stays out of the normal task record
        // (CLAUDE.md 11.3 step 8) — only the safe summary is persisted.
        await db
          .update(researchTasks)
          .set({
            status: "FAILED_TERMINAL",
            output: { reasonCode: outcome.reasonCode, issues: outcome.issues },
            completedAt: new Date(),
          })
          .where(eq(researchTasks.id, input.researchTaskId));

        logger.warn({ jobId: job.id, issues: outcome.issues }, "agent output failed schema validation");
        return { ok: false };
      }

      await db
        .update(researchTasks)
        .set({
          status: "SUCCEEDED",
          output: {
            ideaCard: outcome.result.output,
            promptVersion: outcome.result.promptVersion,
            costUsd: outcome.result.costUsd,
            provider: provider.name,
          },
          completedAt: new Date(),
        })
        .where(eq(researchTasks.id, input.researchTaskId));

      logger.info(
        { jobId: job.id, campaignId: input.campaignId, costUsd: outcome.result.costUsd },
        "idea card produced",
      );
      return { ok: true };
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "agent run failed");
  });

  logger.info({ queue: QUEUE_NAMES.agentRun, provider: provider.name }, "worker started");

  const shutdown = async () => {
    logger.info("shutting down");
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
