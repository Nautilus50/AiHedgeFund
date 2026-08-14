import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import { isRegisteredAgentRole, type RegisteredAgentRole } from "@arf-os/agent-runtime";
import type { Database } from "@arf-os/db";
import { campaigns, outboxEvents, researchTasks } from "@arf-os/db";

/** Organisation-scoped existence check — mirrors `getCampaign`'s own pattern. */
export async function campaignBelongsToOrg(db: Database, organisationId: string, campaignId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organisationId, organisationId)))
    .limit(1);
  return row !== undefined;
}

export interface CreateResearchTaskInput {
  organisationId: string;
  campaignId: string;
  role: RegisteredAgentRole;
  objective: string;
  actor: string;
}

/**
 * Creates the research task and emits the job that runs it, in one
 * transaction (CLAUDE.md 9.3), mirroring `createBacktestRun`'s exact
 * pattern. `agent_run.requested`'s payload is AgentRunJob's exact shape —
 * `routeOutboxEvent` passes it straight through with no transform.
 */
export async function createResearchTask(db: Database, input: CreateResearchTaskInput): Promise<{ researchTaskId: string }> {
  const researchTaskId = generateId<string>();

  await db.transaction(async (tx) => {
    await tx.insert(researchTasks).values({
      id: researchTaskId,
      campaignId: input.campaignId,
      role: input.role,
      status: "QUEUED",
      input: { objective: input.objective },
    });

    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "agent_run.requested",
      eventVersion: "1.0.0",
      aggregateId: researchTaskId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      organisationId: input.organisationId,
      actor: input.actor,
      // AgentRunJob's exact shape.
      payload: { campaignId: input.campaignId, researchTaskId, role: input.role },
      createdAt: now,
    });
  });

  return { researchTaskId };
}

export interface SubmitResearchTaskInput {
  organisationId: string;
  campaignId: string;
  role: string;
  objective: string;
  actor: string;
}

export type SubmitResearchTaskOutcome =
  | { ok: true; researchTaskId: string }
  | { ok: false; reasonCode: "CAMPAIGN_NOT_FOUND" }
  | { ok: false; reasonCode: "ROLE_NOT_REGISTERED" };

/**
 * Route-facing entry point: validates the role against only what this
 * runtime can actually run (AGENT_RUNTIME_REGISTRY, not the full 11-member
 * AgentRole enum) and confirms campaign ownership before creating anything
 * — a role with no worker implementation must fail here, not create a row
 * and fail deep inside the worker (ADR 0008).
 */
export async function submitResearchTask(db: Database, input: SubmitResearchTaskInput): Promise<SubmitResearchTaskOutcome> {
  if (!isRegisteredAgentRole(input.role)) {
    return { ok: false, reasonCode: "ROLE_NOT_REGISTERED" };
  }

  const owned = await campaignBelongsToOrg(db, input.organisationId, input.campaignId);
  if (!owned) {
    return { ok: false, reasonCode: "CAMPAIGN_NOT_FOUND" };
  }

  const { researchTaskId } = await createResearchTask(db, {
    organisationId: input.organisationId,
    campaignId: input.campaignId,
    role: input.role,
    objective: input.objective,
    actor: input.actor,
  });

  return { ok: true, researchTaskId };
}

/** Organisation-scoped list for the Campaign Detail page — newest first. */
export async function listResearchTasks(db: Database, organisationId: string, campaignId: string) {
  const owned = await campaignBelongsToOrg(db, organisationId, campaignId);
  if (!owned) return undefined;

  return db.select().from(researchTasks).where(eq(researchTasks.campaignId, campaignId)).orderBy(researchTasks.createdAt);
}
