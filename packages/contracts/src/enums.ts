import { z } from "zod";

/** Strategy approval levels (spec 1.3). No model or agent can independently grant LIVE_APPROVED. */
export const StrategyApprovalStatus = z.enum([
  "RESEARCH_APPROVED",
  "PAPER_APPROVED",
  "LIVE_CANDIDATE",
  "LIVE_APPROVED",
  "REJECTED",
  "ARCHIVED",
]);
export type StrategyApprovalStatus = z.infer<typeof StrategyApprovalStatus>;

/** Research lifecycle states implemented in this milestone (CLAUDE_CODE_BUILD_PROMPT.md). */
export const WorkflowState = z.enum([
  "CAMPAIGN_BACKLOG",
  "IDEA_RESEARCH",
  "HYPOTHESIS_DRAFT",
  "PINE_DEVELOPMENT",
  "TRADINGVIEW_VERIFICATION",
  "PAPER_APPROVAL_REVIEW",
  "PAPER_APPROVED",
  "REJECTED",
  "BLOCKED",
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

export const AgentRole = z.enum([
  "CHIEF_RESEARCH_ORCHESTRATOR",
  "IDEA_SCOUT",
  "INDICATOR_RESEARCHER",
  "STRATEGY_ARCHITECT",
  "PINE_ENGINEER",
  "BACKTEST_ENGINEER",
  "ROBUSTNESS_VALIDATOR",
  "FORWARD_TEST_OPERATOR",
  "STRATEGY_JUDGE",
  "DATA_INTEGRITY_ANALYST",
  "PORTFOLIO_RESEARCHER",
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** RBAC roles (spec 17.1). */
export const OrganisationRole = z.enum([
  "VIEWER",
  "RESEARCHER",
  "DEVELOPER",
  "VALIDATOR",
  "OPERATOR",
  "COMMITTEE_MEMBER",
  "ADMIN",
  "SERVICE_ACCOUNT",
]);
export type OrganisationRole = z.infer<typeof OrganisationRole>;

export const CommitteeDecisionType = z.enum([
  "REJECT",
  "REWORK_WITH_NEW_VERSION",
  "PAPER_APPROVED",
]);
export type CommitteeDecisionType = z.infer<typeof CommitteeDecisionType>;

export const ParityStatus = z.enum(["PASS", "WARN", "FAIL", "INSUFFICIENT_DATA"]);
export type ParityStatus = z.infer<typeof ParityStatus>;
