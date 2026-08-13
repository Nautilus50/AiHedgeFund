import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@arf-os/db";
import { committeeDecisions, reportUploads, strategies, strategyVersions, tradingviewVerifications } from "@arf-os/db";
import { getQueueDepths as getQueueDepthsFromRedis, parseRedisUrl, type QueueDepth } from "@arf-os/event-bus";

/**
 * Verifications not yet at a terminal or human-actionable state — awaiting
 * either an upload (`PENDING`) or its parse (`UPLOADED`). Organisation-scoped
 * counterpart to the operational widgets CLAUDE.md 20 calls for on the
 * Command Centre.
 */
export async function getPendingVerificationsCount(db: Database, organisationId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(tradingviewVerifications)
    .innerJoin(strategyVersions, eq(strategyVersions.id, tradingviewVerifications.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategies.organisationId, organisationId), inArray(tradingviewVerifications.status, ["PENDING", "UPLOADED"])));

  return row?.total ?? 0;
}

export interface RecentDecision {
  id: string;
  decision: string;
  strategyVersionId: string;
  strategyName: string;
  actorId: string;
  createdAt: Date;
}

/** Most recent committee decisions across the organisation, newest first. */
export async function listRecentDecisions(db: Database, organisationId: string, limit: number): Promise<RecentDecision[]> {
  return db
    .select({
      id: committeeDecisions.id,
      decision: committeeDecisions.decision,
      strategyVersionId: committeeDecisions.strategyVersionId,
      strategyName: strategies.name,
      actorId: committeeDecisions.actorId,
      createdAt: committeeDecisions.createdAt,
    })
    .from(committeeDecisions)
    .innerJoin(strategyVersions, eq(strategyVersions.id, committeeDecisions.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(eq(strategies.organisationId, organisationId))
    .orderBy(desc(committeeDecisions.createdAt))
    .limit(limit);
}

export interface ParseFailure {
  id: string;
  verificationId: string;
  strategyVersionId: string;
  strategyName: string;
  kind: string;
  parseWarnings: string[];
}

/** Uploads whose parse failed — the raw artefact survives either way (CLAUDE.md 15.1), but these need a human's attention. */
export async function listParseFailures(db: Database, organisationId: string, limit: number): Promise<ParseFailure[]> {
  return db
    .select({
      id: reportUploads.id,
      verificationId: reportUploads.verificationId,
      strategyVersionId: tradingviewVerifications.strategyVersionId,
      strategyName: strategies.name,
      kind: reportUploads.kind,
      parseWarnings: reportUploads.parseWarnings,
    })
    .from(reportUploads)
    .innerJoin(tradingviewVerifications, eq(tradingviewVerifications.id, reportUploads.verificationId))
    .innerJoin(strategyVersions, eq(strategyVersions.id, tradingviewVerifications.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .where(and(eq(strategies.organisationId, organisationId), eq(reportUploads.parseStatus, "FAILED")))
    .orderBy(desc(reportUploads.createdAt))
    .limit(limit);
}

/**
 * Live BullMQ job counts (CLAUDE.md 20: "Instrument: queue depth"). Not
 * organisation-scoped — BullMQ queues are global to the deployment, same as
 * every worker that drains them.
 */
export async function getQueueDepths(): Promise<QueueDepth[]> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return [];
  return getQueueDepthsFromRedis(parseRedisUrl(redisUrl));
}
