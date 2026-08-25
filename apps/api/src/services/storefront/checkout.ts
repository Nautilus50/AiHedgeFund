import { and, eq, inArray } from "drizzle-orm";
import { generateId, quoteSubscription, type PriceableListing, type SubscriptionQuote } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { algoListings, checkoutSessions, listingPrices, volumeDiscountTiers } from "@arf-os/db";
import type { BillingProvider } from "./billing-provider.js";
import { ensureCustomer } from "./customers.js";
import type { StorefrontRow } from "./catalogue.js";

export interface QuoteInput {
  storefrontId: string;
  listingIds: readonly string[];
}

export type QuoteOutcome =
  | { ok: true; quote: SubscriptionQuote }
  | { ok: false; reasonCode: "LISTING_NOT_AVAILABLE" | "LISTING_NOT_PRICED" | "INVALID_SELECTION"; message: string };

/**
 * Re-prices a selection server-side. The browser's cart total is never trusted:
 * this is the only function allowed to decide what a subscription costs.
 */
export async function quoteSelection(db: Database, input: QuoteInput): Promise<QuoteOutcome> {
  const uniqueIds = [...new Set(input.listingIds)];
  if (uniqueIds.length !== input.listingIds.length) {
    return { ok: false, reasonCode: "INVALID_SELECTION", message: "The same algo was selected more than once." };
  }

  const rows = await db
    .select({
      listingId: algoListings.id,
      slug: algoListings.slug,
      name: algoListings.name,
      currency: listingPrices.currency,
      monthlyAmountMinor: listingPrices.monthlyAmountMinor,
    })
    .from(algoListings)
    .leftJoin(listingPrices, and(eq(listingPrices.listingId, algoListings.id), eq(listingPrices.active, true)))
    .where(
      and(
        eq(algoListings.storefrontId, input.storefrontId),
        eq(algoListings.status, "PUBLISHED"),
        inArray(algoListings.id, uniqueIds),
      ),
    );

  if (rows.length !== uniqueIds.length) {
    // Covers unknown ids, another storefront's ids, and unpublished ids with
    // one message — an anonymous caller learns nothing about which it was.
    return {
      ok: false,
      reasonCode: "LISTING_NOT_AVAILABLE",
      message: "One or more selected algos are not available in this storefront.",
    };
  }

  const priceable: PriceableListing[] = [];
  for (const row of rows) {
    if (row.currency === null || row.monthlyAmountMinor === null) {
      return {
        ok: false,
        reasonCode: "LISTING_NOT_PRICED",
        message: `Algo ${row.slug} has no active price and cannot be sold.`,
      };
    }
    priceable.push({
      listingId: row.listingId,
      slug: row.slug,
      name: row.name,
      currency: row.currency,
      monthlyAmountMinor: row.monthlyAmountMinor,
    });
  }

  const tiers = await db
    .select({ minAlgos: volumeDiscountTiers.minAlgos, discountBps: volumeDiscountTiers.discountBps })
    .from(volumeDiscountTiers)
    .where(eq(volumeDiscountTiers.storefrontId, input.storefrontId));

  const result = quoteSubscription(priceable, tiers);
  if (!result.ok) {
    return { ok: false, reasonCode: "INVALID_SELECTION", message: result.message };
  }
  return { ok: true, quote: result.quote };
}

export interface CreateCheckoutServiceInput {
  storefront: StorefrontRow;
  userId: string;
  listingIds: readonly string[];
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export type CreateCheckoutOutcome =
  | { ok: true; redirectUrl: string; quote: SubscriptionQuote }
  | { ok: false; reasonCode: string; message: string };

/**
 * Opens a processor checkout for a re-priced selection and records the quote we
 * showed. The stored quote is what the webhook later turns into subscription
 * items and entitlements, so the customer is granted exactly what was priced.
 */
export async function createCheckout(
  db: Database,
  provider: BillingProvider,
  input: CreateCheckoutServiceInput,
): Promise<CreateCheckoutOutcome> {
  const quoted = await quoteSelection(db, { storefrontId: input.storefront.id, listingIds: input.listingIds });
  if (!quoted.ok) return quoted;

  const customer = await ensureCustomer(db, provider, input.storefront.id, input.userId);
  if (!customer.providerCustomerId) {
    return { ok: false, reasonCode: "BILLING_CUSTOMER_UNAVAILABLE", message: "Could not prepare a billing customer." };
  }

  const checkoutSessionId = generateId();

  const created = await provider.createCheckout({
    providerCustomerId: customer.providerCustomerId,
    quote: quoted.quote,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: { checkout_session_id: checkoutSessionId, storefront_id: input.storefront.id, customer_id: customer.id },
    idempotencyKey: input.idempotencyKey,
  });

  await db
    .insert(checkoutSessions)
    .values({
      id: checkoutSessionId,
      storefrontId: input.storefront.id,
      customerId: customer.id,
      provider: provider.name,
      providerSessionId: created.providerSessionId,
      quote: quoted.quote,
    })
    // A retried command reaches the same provider session (same idempotency
    // key); keeping the first row means one checkout, not two.
    .onConflictDoNothing({ target: checkoutSessions.providerSessionId });

  return { ok: true, redirectUrl: created.redirectUrl, quote: quoted.quote };
}
