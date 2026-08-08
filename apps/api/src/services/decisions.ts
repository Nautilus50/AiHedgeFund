import { z } from "zod";
import { generateId } from "@arf-os/contracts";
import type { OrganisationRole, WorkflowState } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { committeeDecisions } from "@arf-os/db";
import type { WorkflowService } from "@arf-os/workflow";

export const RecordDecisionInput = z.object({
  strategyVersionId: z.string().uuid(),
  decision: z.enum(["REJECT", "REWORK_WITH_NEW_VERSION", "PAPER_APPROVED"]),
  reasonCodes: z.array(z.string().min(1)).min(1),
  rejectionCase: z.string().min(1),
  positiveCase: z.string().min(1),
  conditions: z.array(z.string()).default([]),
  requiredNextEvidence: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string().uuid()).min(1),
  humanOverride: z.boolean().default(false),
  overrideReason: z.string().optional(),
});
export type RecordDecisionInput = z.infer<typeof RecordDecisionInput>;

/**
 * REWORK_WITH_NEW_VERSION and REJECT both end THIS version's lifecycle at
 * REJECTED — our milestone's workflow states have no separate "rework"
 * state. The distinction is in the decision record and the human's next
 * action: for REWORK, a researcher calls createChildStrategyVersion
 * (Milestone 6) to continue; for REJECT, the line of research stops here.
 */
function targetStateFor(decision: RecordDecisionInput["decision"]): WorkflowState {
  switch (decision) {
    case "REJECT":
    case "REWORK_WITH_NEW_VERSION":
      return "REJECTED";
    case "PAPER_APPROVED":
      return "PAPER_APPROVED";
  }
}

export type RecordDecisionResult =
  | { ok: true; decisionId: string }
  | { ok: false; reasonCode: string; message: string };

/**
 * Records a committee decision and drives the corresponding workflow
 * transition. Callers (route handlers) are expected to wrap this whole
 * operation behind the API-level Idempotency-Key check
 * (lib/idempotency.ts) — that is the primary protection against duplicate
 * decisions; the workflow's own idempotency check (same key) is
 * defense-in-depth for the transition specifically, not a substitute.
 */
export async function recordCommitteeDecision(
  db: Database,
  workflow: WorkflowService,
  actor: { id: string; roles: readonly OrganisationRole[] },
  idempotencyKey: string,
  input: RecordDecisionInput,
): Promise<RecordDecisionResult> {
  const transitionOutcome = await workflow.transition({
    idempotencyKey,
    strategyVersionId: input.strategyVersionId,
    to: targetStateFor(input.decision),
    actorId: actor.id,
    actorRoles: actor.roles,
    evidenceIds: input.evidenceIds,
    reasonCodes: input.reasonCodes,
    freeTextSummary: input.decision === "PAPER_APPROVED" ? input.positiveCase : input.rejectionCase,
    humanOverride: input.humanOverride,
    overrideReason: input.overrideReason,
  });

  if (!transitionOutcome.ok) {
    return { ok: false, reasonCode: transitionOutcome.reasonCode, message: transitionOutcome.message };
  }

  const decisionId = generateId<string>();

  await db.insert(committeeDecisions).values({
    id: decisionId,
    strategyVersionId: input.strategyVersionId,
    decision: input.decision,
    reasonCodes: input.reasonCodes,
    rejectionCase: input.rejectionCase,
    positiveCase: input.positiveCase,
    conditions: input.conditions,
    requiredNextEvidence: input.requiredNextEvidence,
    actorId: actor.id,
    humanOverride: input.humanOverride,
    overrideReason: input.overrideReason,
  });

  return { ok: true, decisionId };
}
