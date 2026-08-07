import { z } from "zod";
import { CommitteeDecisionType } from "./enums.js";

/**
 * A final, audited research decision (spec 7.9, 16). Missing mandatory
 * evidence means no promotion — enforced by packages/workflow, not by this
 * schema alone (CLAUDE.md 3.7).
 */
export const CommitteeDecision = z.object({
  id: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  decision: CommitteeDecisionType,
  reasonCodes: z.array(z.string().min(1)).min(1),
  rejectionCase: z.string().min(1),
  positiveCase: z.string().min(1),
  conditions: z.array(z.string()),
  requiredNextEvidence: z.array(z.string()),
  reviewDate: z.string().datetime().optional(),
  actorId: z.string().min(1),
  humanOverride: z.boolean(),
  overrideReason: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type CommitteeDecision = z.infer<typeof CommitteeDecision>;
