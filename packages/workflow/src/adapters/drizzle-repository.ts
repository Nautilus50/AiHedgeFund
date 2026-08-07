import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  auditEvents,
  idempotencyRecords,
  outboxEvents,
  strategies,
  strategyVersions,
} from "@arf-os/db";
import type {
  StrategyVersionSnapshot,
  TransitionCommand,
  TransitionRecord,
  WorkflowRepository,
} from "../repository.js";

function toRecord(command: TransitionCommand, id: string, createdAt: Date): TransitionRecord {
  return {
    id,
    strategyVersionId: command.strategyVersionId,
    fromState: command.from,
    toState: command.to,
    actorId: command.actorId,
    evidenceIds: command.evidenceIds,
    reasonCodes: command.reasonCodes,
    freeTextSummary: command.freeTextSummary,
    policyVersion: command.policyVersion,
    humanOverride: command.humanOverride,
    overrideReason: command.overrideReason,
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Production adapter for {@link WorkflowRepository}. State update, audit
 * event, and outbox event are written in a single transaction
 * (CLAUDE.md 9.3). Requires a live PostgreSQL instance — exercised by
 * integration tests in Milestone 13, not by this package's unit tests.
 */
export class DrizzleWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Database) {}

  async getStrategyVersion(strategyVersionId: string): Promise<StrategyVersionSnapshot | undefined> {
    const [row] = await this.db
      .select({
        id: strategyVersions.id,
        workflowState: strategyVersions.workflowState,
        createdByActorId: strategyVersions.createdByAgentRunId,
      })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, strategyVersionId))
      .limit(1);

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      workflowState: row.workflowState,
      // strategy_versions only records the creating agent RUN, not a human/agent
      // actor id directly (agent_runs lands in Milestone 12). Until that join
      // exists, forbidCreatorAsActor checks against the run id as a stand-in.
      createdByActorId: row.createdByActorId ?? "",
    };
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ record: TransitionRecord; requestFingerprint: string } | undefined> {
    const [existing] = await this.db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!existing) {
      return undefined;
    }

    return {
      record: existing.responseBody as unknown as TransitionRecord,
      requestFingerprint: existing.requestHash,
    };
  }

  async applyTransition(
    command: TransitionCommand,
    requestFingerprint: string,
  ): Promise<{ record: TransitionRecord; alreadyApplied: boolean }> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, command.idempotencyKey))
        .limit(1);

      if (existing) {
        return {
          record: existing.responseBody as unknown as TransitionRecord,
          alreadyApplied: true,
        };
      }

      const [strategyRow] = await tx
        .select({ organisationId: strategies.organisationId })
        .from(strategyVersions)
        .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
        .where(eq(strategyVersions.id, command.strategyVersionId))
        .limit(1);

      if (!strategyRow) {
        throw new Error(`Strategy version ${command.strategyVersionId} has no parent strategy.`);
      }

      const transitionId = generateId<string>();
      const createdAt = new Date();

      await tx
        .update(strategyVersions)
        .set({ workflowState: command.to })
        .where(and(eq(strategyVersions.id, command.strategyVersionId), eq(strategyVersions.workflowState, command.from)));

      const record = toRecord(command, transitionId, createdAt);

      await tx.insert(auditEvents).values({
        id: generateId<string>(),
        organisationId: strategyRow.organisationId,
        actor: command.actorId,
        action: `workflow.transition.${command.from}_to_${command.to}`,
        aggregateType: "strategy_version",
        aggregateId: command.strategyVersionId,
        priorStateSummary: { workflowState: command.from },
        newStateSummary: { workflowState: command.to },
        reason: command.freeTextSummary,
        createdAt,
      });

      await tx.insert(outboxEvents).values({
        id: generateId<string>(),
        eventType: "strategy_version.transitioned",
        eventVersion: "1.0.0",
        aggregateId: command.strategyVersionId,
        aggregateVersion: createdAt.getTime().toString(),
        correlationId: generateId<string>(),
        actor: command.actorId,
        payload: { from: command.from, to: command.to, policyVersion: command.policyVersion },
        createdAt,
      });

      await tx.insert(idempotencyRecords).values({
        idempotencyKey: command.idempotencyKey,
        organisationId: strategyRow.organisationId,
        requestHash: requestFingerprint,
        responseBody: record,
        createdAt,
      });

      return { record, alreadyApplied: false };
    });
  }
}
