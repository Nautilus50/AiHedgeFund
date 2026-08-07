import type { OrganisationRole, WorkflowState } from "@arf-os/contracts";

export interface StrategyVersionSnapshot {
  id: string;
  workflowState: WorkflowState;
  createdByActorId: string;
}

export interface TransitionCommand {
  idempotencyKey: string;
  strategyVersionId: string;
  from: WorkflowState;
  to: WorkflowState;
  actorId: string;
  actorRoles: readonly OrganisationRole[];
  evidenceIds: readonly string[];
  reasonCodes: readonly string[];
  freeTextSummary: string;
  policyVersion: string;
  humanOverride: boolean;
  overrideReason?: string | undefined;
}

export interface TransitionRecord {
  id: string;
  strategyVersionId: string;
  fromState: WorkflowState;
  toState: WorkflowState;
  actorId: string;
  evidenceIds: readonly string[];
  reasonCodes: readonly string[];
  freeTextSummary: string;
  policyVersion: string;
  humanOverride: boolean;
  overrideReason?: string | undefined;
  createdAt: string;
}

/**
 * Port (CLAUDE.md 10). Workers and API routes depend on this interface,
 * never on a concrete database client — swapping the adapter (in-memory for
 * tests, Drizzle/Postgres for production) never changes policy logic.
 */
export interface WorkflowRepository {
  getStrategyVersion(strategyVersionId: string): Promise<StrategyVersionSnapshot | undefined>;

  /**
   * Looks up a previously applied transition by idempotency key, alongside
   * the fingerprint of the command that produced it. The service checks
   * this BEFORE evaluating policy against current state — otherwise a
   * retried request would be re-validated against a state the first call
   * already advanced past, and would be wrongly rejected as an unknown
   * transition instead of replayed (CLAUDE.md 3.6).
   */
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ record: TransitionRecord; requestFingerprint: string } | undefined>;

  /**
   * Persists the state change and its audit event in one atomic unit
   * (CLAUDE.md 9.3). `requestFingerprint` is stored alongside the record so
   * a later key reuse with a different body can be detected.
   */
  applyTransition(
    command: TransitionCommand,
    requestFingerprint: string,
  ): Promise<{
    record: TransitionRecord;
    alreadyApplied: boolean;
  }>;
}
