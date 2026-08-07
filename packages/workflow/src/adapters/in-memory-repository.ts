import { generateId } from "@arf-os/contracts";
import type {
  StrategyVersionSnapshot,
  TransitionCommand,
  TransitionRecord,
  WorkflowRepository,
} from "../repository.js";

/**
 * Reference implementation used by workflow's own test suite and available
 * to other packages/apps for local development without Postgres. The
 * Drizzle-backed adapter (packages/workflow/src/adapters/drizzle-repository.ts)
 * implements the identical port for production.
 */
export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly versions = new Map<string, StrategyVersionSnapshot>();
  private readonly transitionsByIdempotencyKey = new Map<
    string,
    { record: TransitionRecord; requestFingerprint: string }
  >();
  readonly auditLog: TransitionRecord[] = [];

  seedStrategyVersion(version: StrategyVersionSnapshot): void {
    this.versions.set(version.id, version);
  }

  async getStrategyVersion(strategyVersionId: string): Promise<StrategyVersionSnapshot | undefined> {
    return this.versions.get(strategyVersionId);
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ record: TransitionRecord; requestFingerprint: string } | undefined> {
    return this.transitionsByIdempotencyKey.get(idempotencyKey);
  }

  async applyTransition(
    command: TransitionCommand,
    requestFingerprint: string,
  ): Promise<{ record: TransitionRecord; alreadyApplied: boolean }> {
    const existing = this.transitionsByIdempotencyKey.get(command.idempotencyKey);
    if (existing) {
      return { record: existing.record, alreadyApplied: true };
    }

    const record: TransitionRecord = {
      id: generateId(),
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
      createdAt: new Date().toISOString(),
    };

    const version = this.versions.get(command.strategyVersionId);
    if (version) {
      this.versions.set(command.strategyVersionId, { ...version, workflowState: command.to });
    }

    this.transitionsByIdempotencyKey.set(command.idempotencyKey, { record, requestFingerprint });
    this.auditLog.push(record);

    return { record, alreadyApplied: false };
  }
}
