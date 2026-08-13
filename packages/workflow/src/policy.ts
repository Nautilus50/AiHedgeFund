import type { OrganisationRole, WorkflowState } from "@arf-os/contracts";

export const POLICY_VERSION = "1.0.0";

export interface TransitionRule {
  from: WorkflowState;
  to: WorkflowState;
  /** Role required to execute this transition (CLAUDE.md 3.4 — separation of duties). */
  requiredRole: OrganisationRole;
  /** When true, the actor must differ from the strategy version's creator. */
  forbidCreatorAsActor: boolean;
  /** When true, at least one evidenceId must be supplied. */
  requiresEvidence: boolean;
  /**
   * When true, the strategy version must have a PASSED TradingView
   * verification and no FAIL parity report (CLAUDE_CODE_BUILD_PROMPT.md:
   * "Do not permit PAPER_APPROVED when required verification evidence is
   * missing or parity is FAIL"). Only PAPER_APPROVAL_REVIEW -> PAPER_APPROVED
   * sets this — it is the one transition the build spec names explicitly.
   */
  requiresPassedVerification: boolean;
}

/**
 * The full allowed-transition table for the milestone lifecycle
 * (CLAUDE_CODE_BUILD_PROMPT.md "Workflow states for this milestone").
 * This is intentionally a flat, explicit table rather than a generic graph
 * so every transition's role/evidence requirement is visible in one place
 * (CLAUDE.md 10 — "Never scatter transition checks across route handlers").
 */
export const TRANSITION_RULES: readonly TransitionRule[] = [
  {
    from: "CAMPAIGN_BACKLOG",
    to: "IDEA_RESEARCH",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "IDEA_RESEARCH",
    to: "HYPOTHESIS_DRAFT",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "IDEA_RESEARCH",
    to: "BLOCKED",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "HYPOTHESIS_DRAFT",
    to: "PINE_DEVELOPMENT",
    requiredRole: "DEVELOPER",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "HYPOTHESIS_DRAFT",
    to: "BLOCKED",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "PINE_DEVELOPMENT",
    to: "TRADINGVIEW_VERIFICATION",
    requiredRole: "DEVELOPER",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "PINE_DEVELOPMENT",
    to: "REJECTED",
    requiredRole: "VALIDATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "PINE_DEVELOPMENT",
    to: "BLOCKED",
    requiredRole: "DEVELOPER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "TRADINGVIEW_VERIFICATION",
    to: "PAPER_APPROVAL_REVIEW",
    requiredRole: "OPERATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "TRADINGVIEW_VERIFICATION",
    to: "REJECTED",
    requiredRole: "VALIDATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "TRADINGVIEW_VERIFICATION",
    to: "BLOCKED",
    requiredRole: "OPERATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    // Creator cannot approve their own version (CLAUDE.md 3.4 / spec 17.2).
    from: "PAPER_APPROVAL_REVIEW",
    to: "PAPER_APPROVED",
    requiredRole: "COMMITTEE_MEMBER",
    forbidCreatorAsActor: true,
    requiresEvidence: true,
    requiresPassedVerification: true,
  },
  {
    from: "PAPER_APPROVAL_REVIEW",
    to: "REJECTED",
    requiredRole: "COMMITTEE_MEMBER",
    forbidCreatorAsActor: true,
    requiresEvidence: true,
    requiresPassedVerification: false,
  },
  {
    from: "BLOCKED",
    to: "IDEA_RESEARCH",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "BLOCKED",
    to: "HYPOTHESIS_DRAFT",
    requiredRole: "RESEARCHER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "BLOCKED",
    to: "PINE_DEVELOPMENT",
    requiredRole: "DEVELOPER",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "BLOCKED",
    to: "TRADINGVIEW_VERIFICATION",
    requiredRole: "OPERATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
  {
    from: "BLOCKED",
    to: "PAPER_APPROVAL_REVIEW",
    requiredRole: "OPERATOR",
    forbidCreatorAsActor: false,
    requiresEvidence: false,
    requiresPassedVerification: false,
  },
];

export function findRule(from: WorkflowState, to: WorkflowState): TransitionRule | undefined {
  return TRANSITION_RULES.find((rule) => rule.from === from && rule.to === to);
}

/** States with no outgoing transitions in this milestone's policy. */
export const TERMINAL_STATES: readonly WorkflowState[] = ["PAPER_APPROVED", "REJECTED"];
