import { and, desc, eq } from "drizzle-orm";
import { generateId, type AlgoDelivery } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { algoReleases, algos, auditEvents, pineRevisions } from "@arf-os/db";

export type DeliveryOutcome =
  | { ok: true; delivery: AlgoDelivery }
  | { ok: false; reasonCode: "NOT_FOUND" | "NO_PUBLISHED_RELEASE" | "SOURCE_MISSING"; message: string };

export interface DeliveryRequest {
  organisationId: string;
  actorUserId: string;
  slug: string;
  traceId?: string;
}

/**
 * Hands back the Pine source of an algo's current release, and records that it
 * was read.
 *
 * The source comes from `pine_revisions` through the release's immutable
 * strategy version — the library never holds its own copy, so what you get is
 * by construction the code the evidence was produced from.
 */
export async function getAlgoSource(db: Database, request: DeliveryRequest): Promise<DeliveryOutcome> {
  const [algo] = await db
    .select({ id: algos.id, name: algos.name })
    .from(algos)
    .where(and(eq(algos.organisationId, request.organisationId), eq(algos.slug, request.slug)))
    .limit(1);

  if (!algo) {
    return { ok: false, reasonCode: "NOT_FOUND", message: "No such algo." };
  }

  const [release] = await db
    .select()
    .from(algoReleases)
    .where(and(eq(algoReleases.algoId, algo.id), eq(algoReleases.status, "PUBLISHED")))
    .orderBy(desc(algoReleases.releaseNumber))
    .limit(1);

  if (!release) {
    return { ok: false, reasonCode: "NO_PUBLISHED_RELEASE", message: "This algo has no published release yet." };
  }

  const [revision] = await db
    .select({ source: pineRevisions.source, sourceHash: pineRevisions.sourceHash })
    .from(pineRevisions)
    .where(eq(pineRevisions.strategyVersionId, release.strategyVersionId))
    .limit(1);

  if (!revision) {
    return { ok: false, reasonCode: "SOURCE_MISSING", message: "The published release has no Pine revision." };
  }

  await db.insert(auditEvents).values({
    id: generateId(),
    organisationId: request.organisationId,
    actor: `user:${request.actorUserId}`,
    action: "ALGO_SOURCE_READ",
    aggregateType: "algo_release",
    aggregateId: release.id,
    priorStateSummary: null,
    newStateSummary: {
      algoId: algo.id,
      releaseNumber: release.releaseNumber,
      // The hash, never the source: an audit trail is not a second copy of the
      // thing it records access to.
      pineSourceHash: revision.sourceHash,
    },
    reason: "Algo source read from the library.",
    traceId: request.traceId ?? null,
  });

  return {
    ok: true,
    delivery: {
      contractVersion: 1,
      algoId: algo.id,
      releaseId: release.id,
      releaseNumber: release.releaseNumber,
      name: algo.name,
      pineSource: revision.source,
      pineSourceHash: revision.sourceHash,
      changelog: release.changelog,
      setupInstructions: release.setupInstructions,
    },
  };
}
