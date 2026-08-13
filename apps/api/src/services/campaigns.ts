import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { auditEvents, backtestRuns, campaigns, committeeDecisions, strategies, strategyVersions } from "@arf-os/db";
import { buildPage, clampPageSize, decodeCursor, type Page } from "../lib/pagination.js";

export const CreateCampaignInput = z.object({
  name: z.string().min(1).max(255),
  brief: z.string().min(1),
  allowedMarkets: z.array(z.string().min(1)).min(1),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;

export interface CampaignSummary {
  id: string;
  organisationId: string;
  name: string;
  brief: string;
  allowedMarkets: unknown;
  status: string;
  createdByUserId: string;
  createdAt: Date;
}

export async function createCampaign(
  db: Database,
  organisationId: string,
  createdByUserId: string,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  const id = generateId<string>();

  const [row] = await db
    .insert(campaigns)
    .values({
      id,
      organisationId,
      name: input.name,
      brief: input.brief,
      allowedMarkets: input.allowedMarkets,
      createdByUserId,
    })
    .returning();

  if (!row) {
    throw new Error("Insert into campaigns returned no row.");
  }
  return row;
}

export async function getCampaign(
  db: Database,
  organisationId: string,
  campaignId: string,
): Promise<CampaignSummary | undefined> {
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.organisationId, organisationId)))
    .limit(1);
  return row;
}

export interface CampaignSummaryStats {
  strategies: { total: number; byWorkflowState: Record<string, number> };
  backtestRuns: { total: number; byStatus: Record<string, number> };
  pendingCommitteeDecisions: number;
  lastActivityAt: Date | null;
}

/**
 * Campaign-scoped counterpart to `getDashboardKpis` (spec 14.12's "Campaign
 * command centre"). Every number is a real grouped `COUNT(*)` scoped to one
 * campaign, mirroring that function's pattern exactly rather than a
 * separate materialised table — at this scale a per-campaign grouped query
 * is exactly as fast as reading a denormalised row would be, and doesn't
 * add a second thing that needs to stay in sync with `strategies`/
 * `backtest_runs`. Returns `undefined` if the campaign isn't owned by this
 * organisation, mirroring `getCampaign`'s own check.
 */
export async function getCampaignSummary(
  db: Database,
  organisationId: string,
  campaignId: string,
): Promise<CampaignSummaryStats | undefined> {
  const campaign = await getCampaign(db, organisationId, campaignId);
  if (!campaign) return undefined;

  // Strategies grouped by their *latest* version's workflow state — same
  // LATERAL join `getDashboardKpis` uses, scoped to this campaign.
  const strategyStateRows = await db.execute<{ workflow_state: string; total: number }>(sql`
    SELECT latest.workflow_state, COUNT(*)::int as total
    FROM strategies s
    INNER JOIN LATERAL (
      SELECT sv.workflow_state
      FROM strategy_versions sv
      WHERE sv.strategy_id = s.id
      ORDER BY sv.version_number DESC
      LIMIT 1
    ) latest ON true
    WHERE s.campaign_id = ${campaignId}
    GROUP BY latest.workflow_state
  `);

  const byWorkflowState: Record<string, number> = {};
  let strategyTotal = 0;
  for (const row of strategyStateRows) {
    byWorkflowState[row.workflow_state] = row.total;
    strategyTotal += row.total;
  }

  const backtestStatusRows = await db
    .select({ status: backtestRuns.status, total: sql<number>`count(*)::int` })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.campaignId, campaignId))
    .groupBy(backtestRuns.status);

  const byStatus: Record<string, number> = {};
  let backtestTotal = 0;
  for (const row of backtestStatusRows) {
    byStatus[row.status] = row.total;
    backtestTotal += row.total;
  }

  // A raw `max(...)` aggregate isn't a typed column, so postgres-js returns
  // it as a string rather than applying its usual timestamptz -> Date
  // parsing — the `sql<Date | null>` annotation only affects TypeScript,
  // not the runtime value, so it's parsed explicitly here instead of
  // trusting the type.
  const [latestVersionActivity] = await db
    .select({ max: sql<string | null>`max(${strategyVersions.createdAt})` })
    .from(strategyVersions)
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.campaignId, campaignId));

  const [latestDecisionActivity] = await db
    .select({ max: sql<string | null>`max(${committeeDecisions.createdAt})` })
    .from(committeeDecisions)
    .innerJoin(strategyVersions, eq(strategyVersions.id, committeeDecisions.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.campaignId, campaignId));

  const activityDates = [latestVersionActivity?.max, latestDecisionActivity?.max]
    .filter((d): d is string => d !== null && d !== undefined)
    .map((d) => new Date(d));
  const lastActivityAt = activityDates.length > 0 ? new Date(Math.max(...activityDates.map((d) => d.getTime()))) : null;

  return {
    strategies: { total: strategyTotal, byWorkflowState },
    backtestRuns: { total: backtestTotal, byStatus },
    pendingCommitteeDecisions: byWorkflowState["PAPER_APPROVAL_REVIEW"] ?? 0,
    lastActivityAt,
  };
}

export interface CampaignAuditEvent {
  id: string;
  actor: string;
  action: string;
  strategyVersionId: string;
  strategyName: string;
  priorStateSummary: unknown;
  newStateSummary: unknown;
  reason: string | null;
  createdAt: Date;
}

/**
 * Every workflow transition across the campaign's strategies, newest first
 * (spec 15's Campaign Detail task-timeline/audit section). Reads
 * `audit_events` directly rather than a new table — every transition
 * `packages/workflow`'s `applyTransition` makes already writes one row
 * there in the same transaction as the transition itself (CLAUDE.md 9.3),
 * with the actor, before/after state, and reason a timeline needs. A
 * committee decision shows up here too: recording one always transitions
 * the version in the same atomic operation (CLAUDE.md 9.3), so its own
 * audit row already carries the decision's effect.
 */
export async function listCampaignAuditEvents(
  db: Database,
  organisationId: string,
  campaignId: string,
  limit: number,
): Promise<CampaignAuditEvent[] | undefined> {
  const campaign = await getCampaign(db, organisationId, campaignId);
  if (!campaign) return undefined;

  return db
    .select({
      id: auditEvents.id,
      actor: auditEvents.actor,
      action: auditEvents.action,
      strategyVersionId: auditEvents.aggregateId,
      strategyName: strategies.name,
      priorStateSummary: auditEvents.priorStateSummary,
      newStateSummary: auditEvents.newStateSummary,
      reason: auditEvents.reason,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .innerJoin(strategyVersions, eq(strategyVersions.id, auditEvents.aggregateId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(auditEvents.aggregateType, "strategy_version"), eq(strategies.campaignId, campaignId)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}

export interface ListCampaignsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export type ListCampaignsResult = { ok: true; page: Page<CampaignSummary> } | { ok: false; reasonCode: "INVALID_CURSOR" };

/** Organisation-scoped, cursor-paginated (CLAUDE.md 19.1 / spec 14.11). */
export async function listCampaigns(
  db: Database,
  organisationId: string,
  input: ListCampaignsInput,
): Promise<ListCampaignsResult> {
  const limit = clampPageSize(input.limit);

  let cursorClause;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded.ok) {
      return { ok: false, reasonCode: "INVALID_CURSOR" };
    }
    const { createdAtIso, id } = decoded.cursor;
    const createdAtDate = new Date(createdAtIso);
    cursorClause = or(
      gt(campaigns.createdAt, createdAtDate),
      and(eq(campaigns.createdAt, createdAtDate), gt(campaigns.id, id)),
    );
  }

  const rows = await db
    .select()
    .from(campaigns)
    .where(cursorClause ? and(eq(campaigns.organisationId, organisationId), cursorClause) : eq(campaigns.organisationId, organisationId))
    .orderBy(campaigns.createdAt, campaigns.id)
    .limit(limit + 1);

  return { ok: true, page: buildPage(rows, limit) };
}
