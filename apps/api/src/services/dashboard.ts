import { count, eq, sql } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { backtestRuns, campaigns, datasetVersions, parityReports, strategies, strategyVersions } from "@arf-os/db";

export interface DashboardKpis {
  campaigns: { total: number };
  strategies: { total: number; byWorkflowState: Record<string, number> };
  backtestRuns: { total: number; byStatus: Record<string, number>; byRunnerType: Record<string, number> };
  datasets: { total: number };
  parity: { total: number; byStatus: Record<string, number> };
}

/**
 * Organisation-scoped aggregate counts for the Command Centre KPI section.
 * Every number is a real grouped `COUNT(*)`, not client-side counting of a
 * paginated list — correct at any scale, not just "first page."
 */
export async function getDashboardKpis(db: Database, organisationId: string): Promise<DashboardKpis> {
  const [campaignCountRow] = await db
    .select({ total: count() })
    .from(campaigns)
    .where(eq(campaigns.organisationId, organisationId));

  const [datasetCountRow] = await db
    .select({ total: count() })
    .from(datasetVersions)
    .where(eq(datasetVersions.organisationId, organisationId));

  // Strategies grouped by their *latest* version's workflow state — the
  // same "latest version per strategy" LATERAL join strategy-registry's
  // filter resolver uses, aggregated instead of filtered.
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
    WHERE s.organisation_id = ${organisationId}
    GROUP BY latest.workflow_state
  `);

  const byWorkflowState: Record<string, number> = {};
  let strategyTotal = 0;
  for (const row of strategyStateRows) {
    byWorkflowState[row.workflow_state] = row.total;
    strategyTotal += row.total;
  }

  const backtestStatusRows = await db
    .select({ status: backtestRuns.status, total: count() })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.organisationId, organisationId))
    .groupBy(backtestRuns.status);

  const backtestRunnerTypeRows = await db
    .select({ runnerType: backtestRuns.runnerType, total: count() })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.organisationId, organisationId))
    .groupBy(backtestRuns.runnerType);

  const byStatus: Record<string, number> = {};
  let backtestTotal = 0;
  for (const row of backtestStatusRows) {
    byStatus[row.status] = row.total;
    backtestTotal += row.total;
  }

  const byRunnerType: Record<string, number> = {};
  for (const row of backtestRunnerTypeRows) {
    byRunnerType[row.runnerType] = row.total;
  }

  const parityStatusRows = await db
    .select({ status: parityReports.status, total: count() })
    .from(parityReports)
    .innerJoin(backtestRuns, eq(backtestRuns.id, parityReports.backtestRunId))
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.organisationId, organisationId))
    .groupBy(parityReports.status);

  const parityByStatus: Record<string, number> = {};
  let parityTotal = 0;
  for (const row of parityStatusRows) {
    parityByStatus[row.status] = row.total;
    parityTotal += row.total;
  }

  return {
    campaigns: { total: campaignCountRow?.total ?? 0 },
    strategies: { total: strategyTotal, byWorkflowState },
    backtestRuns: { total: backtestTotal, byStatus, byRunnerType },
    datasets: { total: datasetCountRow?.total ?? 0 },
    parity: { total: parityTotal, byStatus: parityByStatus },
  };
}
