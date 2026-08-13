import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { strategyReadModels } from "@arf-os/db";

export interface CommitteeQueueItem {
  strategyId: string;
  campaignId: string;
  name: string;
  latestVersionId: string;
  latestVersionNumber: number;
  refreshedAt: Date;
}

/**
 * Every strategy currently awaiting a committee decision (spec 14.12's
 * "Committee queue"), organisation-scoped and optionally narrowed to one
 * campaign. Deliberately not a new table: `strategy_read_models` already
 * carries everything a queue view needs (spec 14.12's "Strategy Library"
 * read model), so this is a filtered read over it rather than a second
 * projection that would need its own refresh path to stay in sync.
 * Ordered oldest-first — the version that has waited longest surfaces
 * first, same intent as any other work queue.
 */
export async function listCommitteeQueue(
  db: Database,
  organisationId: string,
  campaignId?: string,
): Promise<CommitteeQueueItem[]> {
  return db
    .select({
      strategyId: strategyReadModels.strategyId,
      campaignId: strategyReadModels.campaignId,
      name: strategyReadModels.name,
      latestVersionId: strategyReadModels.latestVersionId,
      latestVersionNumber: strategyReadModels.latestVersionNumber,
      refreshedAt: strategyReadModels.refreshedAt,
    })
    .from(strategyReadModels)
    .where(
      and(
        eq(strategyReadModels.organisationId, organisationId),
        eq(strategyReadModels.workflowState, "PAPER_APPROVAL_REVIEW"),
        campaignId ? eq(strategyReadModels.campaignId, campaignId) : undefined,
      ),
    )
    .orderBy(asc(strategyReadModels.refreshedAt));
}
