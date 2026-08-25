import { and, eq } from "drizzle-orm";
import {
  SubscriptionQuote,
  generateId,
  type SubscriptionStatus,
} from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import {
  auditEvents,
  checkoutSessions,
  entitlements,
  billingEvents,
  storefronts,
  subscriptionItems,
  subscriptions,
} from "@arf-os/db";
import type { BillingProvider } from "./billing-provider.js";
import { entitlementEffectFor } from "./entitlement-policy.js";
import { toSnapshot } from "./stripe-provider.js";
import { CheckoutSessionCompleted, SubscriptionLifecycleEvent } from "./webhook-payloads.js";

export type WebhookOutcome =
  /** Signature did not verify. Nothing was read, nothing was written. */
  | { outcome: "REJECTED"; reasonCode: "INVALID_SIGNATURE" }
  /** Seen before. The first delivery already did the work. */
  | { outcome: "REPLAY"; providerEventId: string }
  | { outcome: "PROCESSED"; providerEventId: string; eventType: string }
  | { outcome: "IGNORED"; providerEventId: string; eventType: string }
  | { outcome: "FAILED"; providerEventId: string; eventType: string; reasonCode: string };

export interface WebhookDeps {
  db: Database;
  provider: BillingProvider;
  traceId?: string;
}

/**
 * The single entry point for processor webhooks (ADR 0015).
 *
 * Order matters and is the whole point: verify the signature, then claim the
 * event id, and only then act. Claiming happens through a unique constraint on
 * `provider_event_id`, so a redelivered event — the normal case with Stripe —
 * cannot grant a second entitlement or write a second subscription.
 */
export async function handleBillingWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<WebhookOutcome> {
  const verified = deps.provider.verifyWebhook(rawBody, signatureHeader);
  if (!verified) {
    return { outcome: "REJECTED", reasonCode: "INVALID_SIGNATURE" };
  }

  const claimed = await deps.db
    .insert(billingEvents)
    .values({
      id: generateId(),
      provider: deps.provider.name,
      providerEventId: verified.providerEventId,
      eventType: verified.type,
      payload: verified.payload,
      status: "RECEIVED",
    })
    .onConflictDoNothing({ target: billingEvents.providerEventId })
    .returning({ id: billingEvents.id });

  const billingEventId = claimed[0]?.id;
  if (billingEventId === undefined) {
    // The insert conflicted: this event id is already in the ledger, so an
    // earlier delivery has already done (or is doing) the work.
    return { outcome: "REPLAY", providerEventId: verified.providerEventId };
  }

  try {
    const result = await applyEvent(deps, verified.type, verified.payload);

    await deps.db
      .update(billingEvents)
      .set({ status: result.handled ? "PROCESSED" : "IGNORED", processedAt: new Date() })
      .where(eq(billingEvents.id, billingEventId));

    return result.handled
      ? { outcome: "PROCESSED", providerEventId: verified.providerEventId, eventType: verified.type }
      : { outcome: "IGNORED", providerEventId: verified.providerEventId, eventType: verified.type };
  } catch (error) {
    const reasonCode = error instanceof Error ? error.name : "UNKNOWN";
    await deps.db
      .update(billingEvents)
      .set({ status: "FAILED", failureReason: reasonCode, processedAt: new Date() })
      .where(eq(billingEvents.id, billingEventId));

    return { outcome: "FAILED", providerEventId: verified.providerEventId, eventType: verified.type, reasonCode };
  }
}

async function applyEvent(deps: WebhookDeps, type: string, payload: unknown): Promise<{ handled: boolean }> {
  switch (type) {
    case "checkout.session.completed": {
      const parsed = CheckoutSessionCompleted.safeParse(payload);
      if (!parsed.success) return { handled: false };
      await activateSubscription(deps, parsed.data);
      return { handled: true };
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const parsed = SubscriptionLifecycleEvent.safeParse(payload);
      if (!parsed.success) return { handled: false };
      await syncSubscription(deps, parsed.data);
      return { handled: true };
    }
    default:
      // Unknown event types are recorded and ignored, never guessed at.
      return { handled: false };
  }
}

/**
 * Turns a completed checkout into a subscription, its items and the customer's
 * entitlements — in one transaction, so a customer is never charged without
 * access or granted access without a subscription row (CLAUDE.md 9.3).
 */
async function activateSubscription(deps: WebhookDeps, event: CheckoutSessionCompleted): Promise<void> {
  const session = event.data.object;

  const [checkout] = await deps.db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.providerSessionId, session.id))
    .limit(1);

  if (!checkout) {
    // We never opened this session. Better to leave it unhandled and visible
    // in billing_events than to invent a customer from webhook metadata.
    const error = new Error(`Unknown checkout session ${session.id}.`);
    error.name = "UNKNOWN_CHECKOUT_SESSION";
    throw error;
  }

  const quote = SubscriptionQuote.safeParse(checkout.quote);
  if (!quote.success) {
    const error = new Error("Stored quote failed validation.");
    error.name = "INVALID_STORED_QUOTE";
    throw error;
  }

  const providerSnapshot = await deps.provider.getSubscription(session.subscription);
  const status: SubscriptionStatus = providerSnapshot?.status ?? "ACTIVE";
  const currentPeriodEnd = providerSnapshot?.currentPeriodEnd ?? null;
  const cancelAtPeriodEnd = providerSnapshot?.cancelAtPeriodEnd ?? false;

  const [storefront] = await deps.db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, checkout.storefrontId))
    .limit(1);

  await deps.db.transaction(async (tx) => {
    const subscriptionId = generateId();
    const inserted = await tx
      .insert(subscriptions)
      .values({
        id: subscriptionId,
        storefrontId: checkout.storefrontId,
        customerId: checkout.customerId,
        provider: deps.provider.name,
        providerSubscriptionId: session.subscription,
        status,
        currency: quote.data.currency,
        totalMinor: quote.data.totalMinor,
        discountBps: quote.data.appliedTier?.discountBps ?? 0,
        currentPeriodEnd,
        cancelAtPeriodEnd,
      })
      .onConflictDoNothing({ target: subscriptions.providerSubscriptionId })
      .returning({ id: subscriptions.id });

    // A concurrent subscription.updated delivery may have created the row
    // first; adopt it rather than failing the checkout event.
    const resolvedSubscriptionId =
      inserted[0]?.id ??
      (
        await tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(eq(subscriptions.providerSubscriptionId, session.subscription))
          .limit(1)
      )[0]?.id;

    if (!resolvedSubscriptionId) {
      const error = new Error("Subscription row could not be resolved.");
      error.name = "SUBSCRIPTION_NOT_RESOLVED";
      throw error;
    }

    for (const line of quote.data.lines) {
      await tx
        .insert(subscriptionItems)
        .values({
          id: generateId(),
          subscriptionId: resolvedSubscriptionId,
          listingId: line.listingId,
          listAmountMinor: line.listAmountMinor,
          netAmountMinor: line.netAmountMinor,
        })
        .onConflictDoNothing({ target: [subscriptionItems.subscriptionId, subscriptionItems.listingId] });

      await tx
        .insert(entitlements)
        .values({
          id: generateId(),
          storefrontId: checkout.storefrontId,
          customerId: checkout.customerId,
          listingId: line.listingId,
          source: "SUBSCRIPTION",
          subscriptionId: resolvedSubscriptionId,
          status: "ACTIVE",
          grantedAt: new Date(),
          revokedAt: null,
          expiresAt: cancelAtPeriodEnd ? currentPeriodEnd : null,
        })
        // Re-subscribing reuses the customer's existing row for this algo
        // rather than accumulating duplicates.
        .onConflictDoUpdate({
          target: [entitlements.customerId, entitlements.listingId],
          set: {
            status: "ACTIVE",
            source: "SUBSCRIPTION",
            subscriptionId: resolvedSubscriptionId,
            grantedAt: new Date(),
            revokedAt: null,
            expiresAt: cancelAtPeriodEnd ? currentPeriodEnd : null,
          },
        });
    }

    await tx
      .update(checkoutSessions)
      .set({ completedAt: new Date() })
      .where(eq(checkoutSessions.id, checkout.id));

    if (storefront) {
      await tx.insert(auditEvents).values({
        id: generateId(),
        organisationId: storefront.organisationId,
        actor: `billing:${deps.provider.name.toLowerCase()}`,
        action: "ENTITLEMENTS_GRANTED",
        aggregateType: "subscription",
        aggregateId: resolvedSubscriptionId,
        priorStateSummary: { status: "NONE" },
        newStateSummary: {
          status,
          listingIds: quote.data.lines.map((line) => line.listingId),
          totalMinor: quote.data.totalMinor,
          currency: quote.data.currency,
        },
        reason: "Checkout completed.",
        traceId: deps.traceId ?? null,
      });
    }
  });
}

/** Applies a provider lifecycle change to our subscription row and its entitlements. */
async function syncSubscription(deps: WebhookDeps, event: SubscriptionLifecycleEvent): Promise<void> {
  const object = event.data.object;
  const snapshot = toSnapshot({
    id: object.id,
    status: object.status,
    current_period_end: object.current_period_end ?? null,
    cancel_at_period_end: object.cancel_at_period_end ?? false,
  });

  const [existing] = await deps.db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.providerSubscriptionId, object.id))
    .limit(1);

  if (!existing) {
    // An update for a subscription we never recorded: nothing to change.
    // The event stays in billing_events for operators to look at.
    return;
  }

  const [storefront] = await deps.db
    .select({ organisationId: storefronts.organisationId })
    .from(storefronts)
    .where(eq(storefronts.id, existing.storefrontId))
    .limit(1);

  const effect = entitlementEffectFor(snapshot.status, {
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    currentPeriodEnd: snapshot.currentPeriodEnd,
  });

  await deps.db.transaction(async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        status: snapshot.status,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, existing.id));

    if (effect.action === "LEAVE_UNCHANGED") return;

    const patch =
      effect.action === "REVOKE"
        ? { status: "REVOKED" as const, revokedAt: new Date() }
        : effect.action === "GRANT_UNTIL"
          ? { status: "ACTIVE" as const, revokedAt: null, expiresAt: effect.expiresAt }
          : { status: "ACTIVE" as const, revokedAt: null, expiresAt: null };

    await tx
      .update(entitlements)
      .set(patch)
      .where(and(eq(entitlements.subscriptionId, existing.id), eq(entitlements.storefrontId, existing.storefrontId)));

    if (storefront) {
      await tx.insert(auditEvents).values({
        id: generateId(),
        organisationId: storefront.organisationId,
        actor: `billing:${deps.provider.name.toLowerCase()}`,
        action: effect.action === "REVOKE" ? "ENTITLEMENTS_REVOKED" : "ENTITLEMENTS_UPDATED",
        aggregateType: "subscription",
        aggregateId: existing.id,
        priorStateSummary: { status: existing.status, cancelAtPeriodEnd: existing.cancelAtPeriodEnd },
        newStateSummary: { status: snapshot.status, cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd },
        reason: `Provider lifecycle event applied (${effect.action}).`,
        traceId: deps.traceId ?? null,
      });
    }
  });
}
