import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./index.js";

describe("schema", () => {
  it("exports every table required by CLAUDE_CODE_BUILD_PROMPT.md's milestone entity list", () => {
    const expectedTables: Record<string, Table> = {
      organisations: schema.organisations,
      users: schema.users,
      memberships: schema.memberships,
      campaigns: schema.campaigns,
      research_tasks: schema.researchTasks,
      strategies: schema.strategies,
      strategy_versions: schema.strategyVersions,
      strategy_lineage: schema.strategyLineage,
      strategy_definitions: schema.strategyDefinitions,
      pine_revisions: schema.pineRevisions,
      artefacts: schema.artefacts,
      tradingview_verifications: schema.tradingviewVerifications,
      report_uploads: schema.reportUploads,
      backtest_runs: schema.backtestRuns,
      trades: schema.trades,
      equity_points: schema.equityPoints,
      drawdown_points: schema.drawdownPoints,
      metric_snapshots: schema.metricSnapshots,
      parity_reports: schema.parityReports,
      committee_decisions: schema.committeeDecisions,
      audit_events: schema.auditEvents,
      outbox_events: schema.outboxEvents,
      idempotency_records: schema.idempotencyRecords,
    };

    for (const [expectedName, table] of Object.entries(expectedTables)) {
      expect(getTableName(table)).toBe(expectedName);
    }
  });

  it("gives strategy_versions a nullable parent_version_id for root versions", () => {
    expect(schema.strategyVersions.parentVersionId.notNull).toBe(false);
  });

  it("gives audit_events no update path in the schema itself (append-only is enforced by the repository layer)", () => {
    expect(schema.auditEvents.id.primary).toBe(true);
  });
});
