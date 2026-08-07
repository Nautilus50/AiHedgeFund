import { fingerprint, generateId } from "@arf-os/contracts";
import type { OrganisationRole, WorkflowState } from "@arf-os/contracts";
import { evaluateTransition, type TransitionRejectionReason } from "./evaluate-transition.js";
import type { TransitionRecord, WorkflowRepository } from "./repository.js";
import { TERMINAL_STATES } from "./policy.js";

export interface TransitionInput {
  idempotencyKey: string;
  strategyVersionId: string;
  to: WorkflowState;
  actorId: string;
  actorRoles: readonly OrganisationRole[];
  evidenceIds: readonly string[];
  reasonCodes: readonly string[];
  freeTextSummary: string;
  humanOverride?: boolean;
  overrideReason?: string | undefined;
}

export type TransitionOutcome =
  | { ok: true; record: TransitionRecord; alreadyApplied: boolean }
  | {
      ok: false;
      reasonCode: TransitionRejectionReason | "STRATEGY_VERSION_NOT_FOUND" | "IDEMPOTENCY_KEY_CONFLICT";
      message: string;
    };

export interface WorkflowService {
  transition(input: TransitionInput): Promise<TransitionOutcome>;
  isTerminal(state: WorkflowState): boolean;
}

/**
 * Owns lifecycle transitions end to end (CLAUDE.md 10 / CLAUDE_CODE_BUILD_PROMPT.md
 * "All lifecycle transitions go through packages/workflow. Workers cannot
 * update lifecycle state directly."). The API layer is the only caller;
 * workers only emit results for the API/orchestrator to act on.
 */
export function createWorkflowService(repository: WorkflowRepository): WorkflowService {
  return {
    isTerminal(state) {
      return TERMINAL_STATES.includes(state);
    },

    async transition(input) {
      const requestFingerprint = fingerprint({
        strategyVersionId: input.strategyVersionId,
        to: input.to,
        actorId: input.actorId,
        actorRoles: input.actorRoles,
        evidenceIds: input.evidenceIds,
        reasonCodes: input.reasonCodes,
        freeTextSummary: input.freeTextSummary,
        humanOverride: input.humanOverride ?? false,
        overrideReason: input.overrideReason,
      });

      const existing = await repository.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return {
            ok: false,
            reasonCode: "IDEMPOTENCY_KEY_CONFLICT",
            message: `Idempotency key ${input.idempotencyKey} was already used for a different request.`,
          };
        }
        return { ok: true, record: existing.record, alreadyApplied: true };
      }

      const version = await repository.getStrategyVersion(input.strategyVersionId);
      if (!version) {
        return {
          ok: false,
          reasonCode: "STRATEGY_VERSION_NOT_FOUND",
          message: `No strategy version ${input.strategyVersionId}.`,
        };
      }

      const evaluation = evaluateTransition({
        from: version.workflowState,
        to: input.to,
        actorId: input.actorId,
        actorRoles: input.actorRoles,
        strategyVersionCreatedByActorId: version.createdByActorId,
        evidenceIds: input.evidenceIds,
      });

      if (!evaluation.ok) {
        return evaluation;
      }

      const { record, alreadyApplied } = await repository.applyTransition(
        {
          idempotencyKey: input.idempotencyKey,
          strategyVersionId: input.strategyVersionId,
          from: version.workflowState,
          to: input.to,
          actorId: input.actorId,
          actorRoles: input.actorRoles,
          evidenceIds: input.evidenceIds,
          reasonCodes: input.reasonCodes,
          freeTextSummary: input.freeTextSummary,
          policyVersion: evaluation.policyVersion,
          humanOverride: input.humanOverride ?? false,
          overrideReason: input.overrideReason,
        },
        requestFingerprint,
      );

      return { ok: true, record, alreadyApplied };
    },
  };
}

/** Generates a fresh idempotency key for callers that do not need to dedupe a specific client request. */
export function generateIdempotencyKey(): string {
  return generateId();
}
