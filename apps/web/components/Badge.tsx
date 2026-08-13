import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "ok" | "warn" | "danger";

/**
 * Every tone carries a glyph as well as a colour. Spec 15.17 requires
 * non-colour status indicators, so the meaning has to survive greyscale
 * printing, colour-blindness, and poor displays.
 */
const GLYPH: Record<BadgeTone, string> = {
  neutral: "○",
  info: "◐",
  ok: "●",
  warn: "▲",
  danger: "✕",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      {children}
    </span>
  );
}

/** Workflow lifecycle states, mapped to a tone by where they sit in the funnel. */
const WORKFLOW_TONE: Record<string, BadgeTone> = {
  CAMPAIGN_BACKLOG: "neutral",
  IDEA_RESEARCH: "neutral",
  HYPOTHESIS_DRAFT: "neutral",
  PINE_DEVELOPMENT: "info",
  TRADINGVIEW_VERIFICATION: "info",
  PAPER_APPROVAL_REVIEW: "info",
  PAPER_APPROVED: "ok",
  REJECTED: "danger",
  BLOCKED: "warn",
};

const CAMPAIGN_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  ACTIVE: "info",
  PAUSED: "warn",
  CANCELLED: "danger",
  COMPLETED: "ok",
};

const PARSE_TONE: Record<string, BadgeTone> = {
  PENDING: "neutral",
  PARSED: "ok",
  FAILED: "danger",
};

const VERIFICATION_TONE: Record<string, BadgeTone> = {
  PENDING: "neutral",
  UPLOADED: "info",
  PARSED: "info",
  PASSED: "ok",
  FAILED: "danger",
  INVESTIGATION_REQUIRED: "warn",
};

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  QUEUED: "neutral",
  RUNNING: "info",
  SUCCEEDED: "ok",
  FAILED_RETRYABLE: "warn",
  FAILED_TERMINAL: "danger",
  CANCELLED: "neutral",
};

const PARITY_TONE: Record<string, BadgeTone> = {
  PASS: "ok",
  WARN: "warn",
  FAIL: "danger",
  INSUFFICIENT_DATA: "neutral",
};

const FORWARD_DEPLOYMENT_TONE: Record<string, BadgeTone> = {
  PLANNED: "neutral",
  ACTIVE: "ok",
  PAUSED: "warn",
  COMPLETED: "info",
  FAILED: "danger",
  CANCELLED: "neutral",
};

const HEALTH_TONE: Record<string, BadgeTone> = {
  HEALTHY: "ok",
  DEGRADED: "warn",
  OK: "ok",
  DRAWDOWN_ALERT: "danger",
  NOT_CONFIGURED: "neutral",
};

const SIGNAL_PROCESSING_TONE: Record<string, BadgeTone> = {
  PENDING: "neutral",
  PROCESSED: "ok",
  REJECTED: "danger",
};

const DECISION_TONE: Record<string, BadgeTone> = {
  PAPER_APPROVED: "ok",
  REWORK_WITH_NEW_VERSION: "warn",
  REJECT: "danger",
};

export function humanise(state: string): string {
  return state.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function StateBadge({
  state,
  kind = "workflow",
}: {
  state: string;
  kind?:
    | "workflow"
    | "campaign"
    | "parse"
    | "verification"
    | "runStatus"
    | "parity"
    | "forwardDeployment"
    | "health"
    | "signalProcessing"
    | "decision";
}) {
  const map =
    kind === "campaign"
      ? CAMPAIGN_TONE
      : kind === "parse"
        ? PARSE_TONE
        : kind === "verification"
          ? VERIFICATION_TONE
          : kind === "runStatus"
            ? RUN_STATUS_TONE
            : kind === "parity"
              ? PARITY_TONE
              : kind === "forwardDeployment"
                ? FORWARD_DEPLOYMENT_TONE
                : kind === "health"
                  ? HEALTH_TONE
                  : kind === "signalProcessing"
                    ? SIGNAL_PROCESSING_TONE
                    : kind === "decision"
                      ? DECISION_TONE
                      : WORKFLOW_TONE;

  return <Badge tone={map[state] ?? "neutral"}>{humanise(state)}</Badge>;
}
