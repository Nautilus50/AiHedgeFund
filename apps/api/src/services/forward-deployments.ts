import { and, desc, eq, gt } from "drizzle-orm";
import { generateId, type CreateForwardDeploymentInput } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  forwardDeployments,
  forwardDrawdownPoints,
  forwardEquityPoints,
  signalEvents,
  strategies,
  strategyVersions,
} from "@arf-os/db";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";

const MAX_EVIDENCE_ROWS = 5000;
/** Over how many of the most recent signals the health endpoint's rejection rate is computed. */
const HEALTH_SIGNAL_WINDOW = 20;
/** A rejection rate above this fraction of the recent window marks infrastructureHealth DEGRADED. */
const DEGRADED_REJECTION_RATE = 0.5;

export type CreateForwardDeploymentResult =
  | { ok: true; deploymentId: string; token: string }
  | { ok: false; reasonCode: "STRATEGY_VERSION_NOT_FOUND" | "NOT_PAPER_APPROVED"; message: string };

/**
 * Creates a forward-test deployment for an immutable, PAPER_APPROVED
 * strategy version. Goes straight to ACTIVE — this slice has no separate
 * CONFIGURING step (config is fully supplied here) and no reason to require
 * a manual activation click for a paper-only deployment. `PLANNED` remains
 * in `ForwardDeploymentState` for a future review-before-activating step,
 * but this flow never produces it.
 *
 * The plaintext token is generated here and returned exactly once — only
 * its hash is ever persisted (CLAUDE.md 16.1, 19: never log secrets).
 */
export async function createForwardDeployment(
  db: Database,
  organisationId: string,
  createdByUserId: string,
  input: CreateForwardDeploymentInput,
): Promise<CreateForwardDeploymentResult> {
  const [versionRow] = await db
    .select({ workflowState: strategyVersions.workflowState })
    .from(strategyVersions)
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategyVersions.id, input.strategyVersionId), eq(strategies.organisationId, organisationId)))
    .limit(1);

  if (!versionRow) {
    return {
      ok: false,
      reasonCode: "STRATEGY_VERSION_NOT_FOUND",
      message: `No strategy version ${input.strategyVersionId}.`,
    };
  }
  if (versionRow.workflowState !== "PAPER_APPROVED") {
    return {
      ok: false,
      reasonCode: "NOT_PAPER_APPROVED",
      message: `Strategy version ${input.strategyVersionId} is ${versionRow.workflowState}, not PAPER_APPROVED.`,
    };
  }

  const deploymentId = generateId<string>();
  const token = generateOpaqueToken();
  const now = new Date();

  await db.insert(forwardDeployments).values({
    id: deploymentId,
    organisationId,
    strategyVersionId: input.strategyVersionId,
    createdByUserId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    initialCapital: String(input.initialCapital),
    fillModel: input.fillModel,
    timestampToleranceSeconds: input.timestampToleranceSeconds,
    maxDrawdownPctAlertThreshold:
      input.maxDrawdownPctAlertThreshold === undefined ? null : String(input.maxDrawdownPctAlertThreshold),
    deploymentTokenHash: hashToken(token),
    state: "ACTIVE",
    activatedAt: now,
  });

  return { ok: true, deploymentId, token };
}

/**
 * Organisation-scoped fetch, plus `newerApprovedVersionExists` — the
 * concrete fact CLAUDE.md 3.4 is protecting against here: the deployment's
 * own strategy version can't itself change (PAPER_APPROVED is a
 * TERMINAL_STATES entry), but a sibling version can quietly supersede it
 * while the deployment keeps running against the older one. Surfaced, not
 * auto-acted-on — a human decides whether to complete this deployment and
 * start a new one against the newer version.
 */
export async function getForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  const [row] = await db
    .select({
      id: forwardDeployments.id,
      organisationId: forwardDeployments.organisationId,
      strategyVersionId: forwardDeployments.strategyVersionId,
      strategyId: strategyVersions.strategyId,
      currentVersionNumber: strategyVersions.versionNumber,
      symbol: forwardDeployments.symbol,
      timeframe: forwardDeployments.timeframe,
      initialCapital: forwardDeployments.initialCapital,
      fillModel: forwardDeployments.fillModel,
      timestampToleranceSeconds: forwardDeployments.timestampToleranceSeconds,
      maxDrawdownPctAlertThreshold: forwardDeployments.maxDrawdownPctAlertThreshold,
      state: forwardDeployments.state,
      createdAt: forwardDeployments.createdAt,
      activatedAt: forwardDeployments.activatedAt,
      pausedAt: forwardDeployments.pausedAt,
      completedAt: forwardDeployments.completedAt,
    })
    .from(forwardDeployments)
    .innerJoin(strategyVersions, eq(strategyVersions.id, forwardDeployments.strategyVersionId))
    .where(and(eq(forwardDeployments.id, deploymentId), eq(forwardDeployments.organisationId, organisationId)))
    .limit(1);

  if (!row) return undefined;

  const [newerVersion] = await db
    .select({ id: strategyVersions.id })
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.strategyId, row.strategyId),
        eq(strategyVersions.workflowState, "PAPER_APPROVED"),
        gt(strategyVersions.versionNumber, row.currentVersionNumber),
      ),
    )
    .limit(1);

  return { ...row, newerApprovedVersionExists: newerVersion !== undefined };
}

export type DeploymentTransitionResult =
  | { ok: true }
  | { ok: false; reasonCode: "NOT_FOUND" | "INVALID_STATE"; message: string };

async function transitionDeploymentState(
  db: Database,
  organisationId: string,
  deploymentId: string,
  from: readonly string[],
  to: "ACTIVE" | "PAUSED" | "COMPLETED",
  timestampColumn: "activatedAt" | "pausedAt" | "completedAt",
): Promise<DeploymentTransitionResult> {
  const [current] = await db
    .select({ state: forwardDeployments.state })
    .from(forwardDeployments)
    .where(and(eq(forwardDeployments.id, deploymentId), eq(forwardDeployments.organisationId, organisationId)))
    .limit(1);

  if (!current) {
    return { ok: false, reasonCode: "NOT_FOUND", message: `No forward deployment ${deploymentId}.` };
  }
  if (!from.includes(current.state)) {
    return {
      ok: false,
      reasonCode: "INVALID_STATE",
      message: `Deployment is ${current.state}; expected one of ${from.join(", ")}.`,
    };
  }

  await db
    .update(forwardDeployments)
    .set({ state: to, [timestampColumn]: new Date() })
    .where(eq(forwardDeployments.id, deploymentId));

  return { ok: true };
}

export function pauseForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["ACTIVE"], "PAUSED", "pausedAt");
}

/** Not in the spec's literal endpoint list — a one-way pause would be an operational trap, so this is a deliberate small addition. */
export function resumeForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["PAUSED"], "ACTIVE", "activatedAt");
}

export function completeForwardDeployment(db: Database, organisationId: string, deploymentId: string) {
  return transitionDeploymentState(db, organisationId, deploymentId, ["ACTIVE", "PAUSED"], "COMPLETED", "completedAt");
}

export interface ForwardDeploymentHealth {
  deploymentState: string;
  infrastructureHealth: "HEALTHY" | "DEGRADED";
  infrastructureReasons: string[];
  strategyPerformanceHealth: "OK" | "DRAWDOWN_ALERT" | "NOT_CONFIGURED";
}

/**
 * Two independent axes, per CLAUDE.md 16.3 ("infrastructure degradation
 * must be tracked separately from strategy performance"). Computed live on
 * every read — no stored snapshot table, no scheduled job (this repo has no
 * cron/interval mechanism yet, not invented for this slice). CLAUDE.md 17.4
 * names forward-deployment health as an SSE use case; polling this endpoint
 * is a deliberate deviation for this first slice, documented in ADR 0006.
 */
export async function getForwardDeploymentHealth(
  db: Database,
  organisationId: string,
  deploymentId: string,
): Promise<ForwardDeploymentHealth | undefined> {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  const recentSignals = await db
    .select({ processingStatus: signalEvents.processingStatus, rejectionReason: signalEvents.rejectionReason })
    .from(signalEvents)
    .where(eq(signalEvents.deploymentId, deploymentId))
    .orderBy(desc(signalEvents.receivedAt))
    .limit(HEALTH_SIGNAL_WINDOW);

  const rejected = recentSignals.filter((s) => s.processingStatus === "REJECTED");
  const rejectionRate = recentSignals.length > 0 ? rejected.length / recentSignals.length : 0;
  const infrastructureHealth: "HEALTHY" | "DEGRADED" = rejectionRate > DEGRADED_REJECTION_RATE ? "DEGRADED" : "HEALTHY";
  const infrastructureReasons =
    infrastructureHealth === "DEGRADED"
      ? Array.from(new Set(rejected.map((s) => s.rejectionReason).filter((r): r is string => r !== null)))
      : [];

  let strategyPerformanceHealth: ForwardDeploymentHealth["strategyPerformanceHealth"] = "NOT_CONFIGURED";
  if (deployment.maxDrawdownPctAlertThreshold !== null) {
    const [latestDrawdown] = await db
      .select({ drawdownPct: forwardDrawdownPoints.drawdownPct })
      .from(forwardDrawdownPoints)
      .where(eq(forwardDrawdownPoints.deploymentId, deploymentId))
      .orderBy(desc(forwardDrawdownPoints.sequenceNumber))
      .limit(1);

    const threshold = Number(deployment.maxDrawdownPctAlertThreshold);
    const currentDrawdownPct = latestDrawdown ? Number(latestDrawdown.drawdownPct) : 0;
    strategyPerformanceHealth = currentDrawdownPct >= threshold ? "DRAWDOWN_ALERT" : "OK";
  }

  return {
    deploymentState: deployment.state,
    infrastructureHealth,
    infrastructureReasons,
    strategyPerformanceHealth,
  };
}

export async function getForwardEquityCurve(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select()
    .from(forwardEquityPoints)
    .where(eq(forwardEquityPoints.deploymentId, deploymentId))
    .orderBy(forwardEquityPoints.sequenceNumber)
    .limit(MAX_EVIDENCE_ROWS);
}

export async function getForwardDrawdownCurve(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select()
    .from(forwardDrawdownPoints)
    .where(eq(forwardDrawdownPoints.deploymentId, deploymentId))
    .orderBy(forwardDrawdownPoints.sequenceNumber)
    .limit(MAX_EVIDENCE_ROWS);
}

/** Raw signal events, newest first — the event timeline spec 15.9 calls for (signal received/rejected). */
export async function getForwardSignalEvents(db: Database, organisationId: string, deploymentId: string) {
  const deployment = await getForwardDeployment(db, organisationId, deploymentId);
  if (!deployment) return undefined;

  return db
    .select({
      id: signalEvents.id,
      eventType: signalEvents.eventType,
      direction: signalEvents.direction,
      processingStatus: signalEvents.processingStatus,
      rejectionReason: signalEvents.rejectionReason,
      receivedAt: signalEvents.receivedAt,
    })
    .from(signalEvents)
    .where(eq(signalEvents.deploymentId, deploymentId))
    .orderBy(desc(signalEvents.receivedAt))
    .limit(MAX_EVIDENCE_ROWS);
}
