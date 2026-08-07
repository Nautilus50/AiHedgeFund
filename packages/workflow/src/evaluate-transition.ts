import type { OrganisationRole, WorkflowState } from "@arf-os/contracts";
import { findRule, POLICY_VERSION, type TransitionRule } from "./policy.js";

export interface TransitionRequest {
  from: WorkflowState;
  to: WorkflowState;
  actorId: string;
  actorRoles: readonly OrganisationRole[];
  strategyVersionCreatedByActorId: string;
  evidenceIds: readonly string[];
}

export type TransitionRejectionReason =
  | "UNKNOWN_TRANSITION"
  | "ROLE_NOT_PERMITTED"
  | "CREATOR_CANNOT_APPROVE_OWN_VERSION"
  | "EVIDENCE_REQUIRED";

export type TransitionEvaluation =
  | { ok: true; rule: TransitionRule; policyVersion: string }
  | { ok: false; reasonCode: TransitionRejectionReason; message: string };

/**
 * Pure policy check — no I/O. Given the same inputs it always returns the
 * same result, so it can be fully unit-tested without a database
 * (CLAUDE.md 21.1 — unit test policies and transitions).
 *
 * Does not throw for expected policy rejection (CLAUDE.md 10 — "The
 * workflow returns a typed success or failure result").
 */
export function evaluateTransition(request: TransitionRequest): TransitionEvaluation {
  const rule = findRule(request.from, request.to);

  if (!rule) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_TRANSITION",
      message: `No policy allows ${request.from} -> ${request.to}.`,
    };
  }

  if (!request.actorRoles.includes(rule.requiredRole)) {
    return {
      ok: false,
      reasonCode: "ROLE_NOT_PERMITTED",
      message: `Transition ${request.from} -> ${request.to} requires role ${rule.requiredRole}.`,
    };
  }

  if (rule.forbidCreatorAsActor && request.actorId === request.strategyVersionCreatedByActorId) {
    return {
      ok: false,
      reasonCode: "CREATOR_CANNOT_APPROVE_OWN_VERSION",
      message: "The actor who created this strategy version cannot approve it (CLAUDE.md 3.4).",
    };
  }

  if (rule.requiresEvidence && request.evidenceIds.length === 0) {
    return {
      ok: false,
      reasonCode: "EVIDENCE_REQUIRED",
      message: `Transition ${request.from} -> ${request.to} requires at least one evidence reference.`,
    };
  }

  return { ok: true, rule, policyVersion: POLICY_VERSION };
}
