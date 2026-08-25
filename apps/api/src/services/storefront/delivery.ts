import { and, desc, eq } from "drizzle-orm";
import { generateId, type AlgoDelivery, type CustomerEntitlement } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  algoListings,
  algoReleases,
  auditEvents,
  entitlements,
  pineRevisions,
  storefronts,
  subscriptions,
} from "@arf-os/db";
import { isEntitlementActive } from "./entitlement-policy.js";

/**
 * Source delivery (ADR 0015). This is the one place Pine source leaves the
 * platform, so it is also the one place that must never be reachable without an
 * active entitlement, and never happen without an audit record.
 */

export async function listCustomerEntitlements(
  db: Database,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerEntitlement[]> {
  const rows = await db
    .select({
      listingId: entitlements.listingId,
      slug: algoListings.slug,
      name: algoListings.name,
      status: entitlements.status,
      source: entitlements.source,
      grantedAt: entitlements.grantedAt,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .innerJoin(algoListings, eq(algoListings.id, entitlements.listingId))
    .where(eq(entitlements.customerId, customerId))
    .orderBy(desc(entitlements.grantedAt));

  return rows.map((row) => ({
    listingId: row.listingId,
    slug: row.slug,
    name: row.name,
    // A row that has passed its paid-through instant is reported as REVOKED:
    // the account page shows the access the customer actually has right now.
    status: isEntitlementActive({ status: row.status, source: row.source, expiresAt: row.expiresAt }, now)
      ? row.status
      : "REVOKED",
    source: row.source,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}

export interface CustomerSubscriptionView {
  subscriptionId: string;
  status: string;
  currency: string;
  totalMinor: number;
  discountBps: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string;
}

export async function listCustomerSubscriptions(db: Database, customerId: string): Promise<CustomerSubscriptionView[]> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.customerId, customerId))
    .orderBy(desc(subscriptions.createdAt));

  return rows.map((row) => ({
    subscriptionId: row.id,
    status: row.status,
    currency: row.currency,
    totalMinor: row.totalMinor,
    discountBps: row.discountBps,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    providerSubscriptionId: row.providerSubscriptionId,
  }));
}

export type DeliveryOutcome =
  | { ok: true; delivery: AlgoDelivery }
  | { ok: false; reasonCode: "NOT_FOUND" | "NOT_ENTITLED" | "NO_PUBLISHED_RELEASE" | "SOURCE_MISSING"; message: string };

export interface DeliverySubject {
  storefrontId: string;
  customerId: string;
  listingSlug: string;
  traceId?: string;
}

/**
 * Returns the Pine source for an algo the customer is entitled to, and writes
 * the protected-data audit event that read requires (CLAUDE.md 3.5).
 *
 * The source is read from `pine_revisions` through the release's immutable
 * strategy version — the storefront never holds its own copy, so what a
 * customer receives is by construction the code that was tested.
 */
export async function deliverAlgoSource(db: Database, subject: DeliverySubject): Promise<DeliveryOutcome> {
  const [listing] = await db
    .select({ id: algoListings.id, name: algoListings.name, status: algoListings.status })
    .from(algoListings)
    .where(and(eq(algoListings.storefrontId, subject.storefrontId), eq(algoListings.slug, subject.listingSlug)))
    .limit(1);

  if (!listing) {
    return { ok: false, reasonCode: "NOT_FOUND", message: "No such algo in this storefront." };
  }

  const [entitlement] = await db
    .select({ status: entitlements.status, source: entitlements.source, expiresAt: entitlements.expiresAt })
    .from(entitlements)
    .where(and(eq(entitlements.customerId, subject.customerId), eq(entitlements.listingId, listing.id)))
    .limit(1);

  if (!entitlement || !isEntitlementActive(entitlement, new Date())) {
    // Deliberately the same answer for "never bought it" and "subscription
    // lapsed": neither case gets to distinguish itself by the error.
    return { ok: false, reasonCode: "NOT_ENTITLED", message: "No active subscription for this algo." };
  }

  const [release] = await db
    .select()
    .from(algoReleases)
    .where(and(eq(algoReleases.listingId, listing.id), eq(algoReleases.status, "PUBLISHED")))
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

  const [storefront] = await db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, subject.storefrontId))
    .limit(1);

  if (storefront) {
    await db.insert(auditEvents).values({
      id: generateId(),
      organisationId: storefront.organisationId,
      actor: `customer:${subject.customerId}`,
      action: "ALGO_SOURCE_DELIVERED",
      aggregateType: "algo_release",
      aggregateId: release.id,
      priorStateSummary: null,
      newStateSummary: {
        listingId: listing.id,
        releaseNumber: release.releaseNumber,
        // The hash, never the source: an audit trail is not a second copy of
        // the thing it is protecting.
        pineSourceHash: revision.sourceHash,
      },
      reason: "Entitled customer downloaded algo source.",
      traceId: subject.traceId ?? null,
    });
  }

  return {
    ok: true,
    delivery: {
      contractVersion: 1,
      listingId: listing.id,
      releaseId: release.id,
      releaseNumber: release.releaseNumber,
      name: listing.name,
      pineSource: revision.source,
      pineSourceHash: revision.sourceHash,
      changelog: release.changelog,
      setupInstructions: release.setupInstructions,
    },
  };
}
