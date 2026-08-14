import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import { AGENT_RUNTIME_REGISTRY, isRegisteredAgentRole, runStructuredAgent, type ModelProvider } from "@arf-os/agent-runtime";
import type { Database } from "@arf-os/db";
import { agentRunDiagnostics, prompts, researchTasks } from "@arf-os/db";
import type { AgentRunJob } from "@arf-os/event-bus";

export interface AgentRunResult {
  ok: boolean;
  skipped?: boolean;
}

/**
 * Loads the single APPROVED prompt record for a role (CLAUDE.md 11.2).
 * Hard-fails rather than falling back to anything — "never load an
 * unapproved challenger in production" is unconditional, a different
 * failure class from a schema-validation retry (CLAUDE.md 11.3 step 6).
 */
async function loadApprovedPrompt(db: Database, role: string) {
  const [row] = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.role, role), eq(prompts.status, "APPROVED")))
    .limit(1);

  if (!row) {
    throw new Error(`No APPROVED prompt found for role ${role}. Refusing to run without one (CLAUDE.md 11.2).`);
  }
  return row;
}

/**
 * Runs one specialist agent task. Generalized across every role in
 * {@link AGENT_RUNTIME_REGISTRY} — adding a role means registering it
 * there, not branching here. Deliberately does NOT transition workflow
 * state — the worker stores its structured output and the API/orchestrator
 * applies transition policy (CLAUDE.md 3.2).
 */
export async function handleAgentRun(db: Database, provider: ModelProvider, input: AgentRunJob): Promise<AgentRunResult> {
  if (!isRegisteredAgentRole(input.role)) {
    throw new Error(`Role ${input.role} is not wired yet.`);
  }
  const definition = AGENT_RUNTIME_REGISTRY[input.role];

  const [taskRow] = await db.select().from(researchTasks).where(eq(researchTasks.id, input.researchTaskId)).limit(1);
  if (!taskRow) {
    throw new Error(`Research task ${input.researchTaskId} not found.`);
  }

  // Idempotency guard against BullMQ redelivery (CLAUDE.md 3.6): a job that
  // already reached a terminal status must never run its side effects
  // again, whether that's a duplicate DB write today or, once a real
  // provider adapter exists, a duplicate model-API charge.
  if (taskRow.status === "SUCCEEDED" || taskRow.status === "FAILED_TERMINAL") {
    return { ok: true, skipped: true };
  }

  await db.update(researchTasks).set({ status: "RUNNING" }).where(eq(researchTasks.id, input.researchTaskId));

  const promptRecord = await loadApprovedPrompt(db, input.role);
  const objective = (taskRow.input as { objective?: string } | null)?.objective ?? `Campaign ${input.campaignId}`;

  const outcome = await runStructuredAgent(provider, {
    role: input.role,
    promptVersion: promptRecord.semanticVersion,
    systemPrompt: promptRecord.content,
    userInput: objective,
    outputSchema: definition.outputSchema,
  });

  if (!outcome.ok) {
    await db.transaction(async (tx) => {
      // Raw provider output stays out of the normal task record
      // (CLAUDE.md 11.3 step 8) — only the safe summary is persisted there;
      // the raw attempt goes to protected diagnostics storage instead.
      await tx
        .update(researchTasks)
        .set({
          status: "FAILED_TERMINAL",
          output: { reasonCode: outcome.reasonCode, issues: outcome.issues },
          completedAt: new Date(),
        })
        .where(eq(researchTasks.id, input.researchTaskId));

      await tx.insert(agentRunDiagnostics).values({
        id: generateId<string>(),
        researchTaskId: input.researchTaskId,
        rawProviderOutput: { rawOutput: outcome.rawOutput, reasonCode: outcome.reasonCode, issues: outcome.issues },
      });
    });

    return { ok: false };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(researchTasks)
      .set({
        status: "SUCCEEDED",
        output: {
          result: outcome.result.output,
          promptVersion: outcome.result.promptVersion,
          costUsd: outcome.result.costUsd,
          provider: provider.name,
        },
        completedAt: new Date(),
      })
      .where(eq(researchTasks.id, input.researchTaskId));

    await tx.insert(agentRunDiagnostics).values({
      id: generateId<string>(),
      researchTaskId: input.researchTaskId,
      rawProviderOutput: {
        rawOutput: outcome.result.rawOutput,
        inputTokens: outcome.result.inputTokens,
        outputTokens: outcome.result.outputTokens,
      },
    });
  });

  return { ok: true };
}
