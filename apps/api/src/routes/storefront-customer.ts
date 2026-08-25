import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { customerVerifiedResults, developerSubmissions, subscriptions } from "@arf-os/db";
import { and, eq } from "drizzle-orm";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey } from "../lib/request-helpers.js";
import type { BillingProvider } from "../services/storefront/billing-provider.js";
import { getStorefrontBySlug } from "../services/storefront/catalogue.js";
import { createCheckout } from "../services/storefront/checkout.js";
import { findCustomer } from "../services/storefront/customers.js";
import {
  deliverAlgoSource,
  listCustomerEntitlements,
  listCustomerSubscriptions,
} from "../services/storefront/delivery.js";

export interface StorefrontCustomerRouteDeps {
  db: Database;
  billing: BillingProvider;
}

const CheckoutBody = z.object({
  listingIds: z.array(z.string().uuid()).min(1).max(50),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const VerifiedResultBody = z.object({
  listingId: z.string().uuid(),
  broker: z.string().min(1).max(120),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  netReturnPct: z.number(),
  statementObjectKey: z.string().min(1),
  statementChecksum: z.string().min(1),
});

const DeveloperSubmissionBody = z.object({
  strategyVersionId: z.string().uuid(),
  proposedName: z.string().min(1).max(120),
  proposedTagline: z.string().max(240).default(""),
  notes: z.string().max(4000).default(""),
});

/**
 * Signed-in buyer routes (ADR 0015). These authenticate through
 * `request.requireCustomer()` — a personal identity with no organisation and no
 * research role. Nothing here can read research data, and a researcher's
 * org-scoped token grants no extra power on these routes.
 */
export function registerStorefrontCustomerRoutes(app: FastifyInstance, deps: StorefrontCustomerRouteDeps): void {
  app.post("/v1/storefronts/:slug/checkout", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug } = request.params as { slug: string };

    const parsed = CheckoutBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid checkout request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const idem = await checkIdempotency(deps.db, idempotencyKey, parsed.data);
    if (idem.status === "CONFLICT") {
      sendProblem(reply, {
        status: 409,
        title: "Idempotency-Key conflict",
        detail: "Key reused with a different body.",
        instance: request.url,
      });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const outcome = await createCheckout(deps.db, deps.billing, {
      storefront,
      userId: customerAuth.userId,
      listingIds: parsed.data.listingIds,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
      idempotencyKey,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Checkout could not be created",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    const result = { redirectUrl: outcome.redirectUrl, quote: outcome.quote };
    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: storefront.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });
    reply.code(201).send(result);
  });

  app.get("/v1/storefronts/:slug/account", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug } = request.params as { slug: string };

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const customer = await findCustomer(deps.db, storefront.id, customerAuth.userId);
    if (!customer) {
      // A signed-in visitor who has never bought anything is a valid state,
      // not an error: they simply own nothing yet.
      reply.send({ entitlements: [], subscriptions: [] });
      return;
    }

    const [entitlementRows, subscriptionRows] = await Promise.all([
      listCustomerEntitlements(deps.db, customer.id),
      listCustomerSubscriptions(deps.db, customer.id),
    ]);

    reply.send({ entitlements: entitlementRows, subscriptions: subscriptionRows });
  });

  /**
   * Source delivery. The entitlement check and the audit write both live in the
   * service — this handler only maps the outcome.
   */
  app.get("/v1/storefronts/:slug/algos/:listingSlug/source", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug, listingSlug } = request.params as { slug: string; listingSlug: string };

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const customer = await findCustomer(deps.db, storefront.id, customerAuth.userId);
    if (!customer) {
      sendProblem(reply, {
        status: 403,
        title: "Forbidden",
        detail: "No active subscription for this algo.",
        instance: request.url,
        code: "NOT_ENTITLED",
      });
      return;
    }

    const outcome = await deliverAlgoSource(deps.db, {
      storefrontId: storefront.id,
      customerId: customer.id,
      listingSlug,
      traceId: request.id,
    });

    if (!outcome.ok) {
      const status = outcome.reasonCode === "NOT_ENTITLED" ? 403 : 404;
      sendProblem(reply, {
        status,
        title: status === 403 ? "Forbidden" : "Not Found",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.send(outcome.delivery);
  });

  app.post("/v1/storefronts/:slug/subscriptions/:subscriptionId/cancel", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug, subscriptionId } = request.params as { slug: string; subscriptionId: string };

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const customer = await findCustomer(deps.db, storefront.id, customerAuth.userId);
    if (!customer) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such subscription.", instance: request.url });
      return;
    }

    const [subscription] = await deps.db
      .select({ id: subscriptions.id, providerSubscriptionId: subscriptions.providerSubscriptionId })
      .from(subscriptions)
      // Ownership is part of the lookup, not a check afterwards: another
      // customer's subscription id simply does not resolve.
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.customerId, customer.id)))
      .limit(1);

    if (!subscription) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such subscription.", instance: request.url });
      return;
    }

    // The processor is the source of truth for cancellation. Our row and the
    // customer's entitlements change when the resulting webhook arrives, never
    // optimistically here (ADR 0015).
    const snapshot = await deps.billing.cancelAtPeriodEnd(subscription.providerSubscriptionId);
    reply.send({
      status: snapshot.status,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      currentPeriodEnd: snapshot.currentPeriodEnd?.toISOString() ?? null,
    });
  });

  /** Customer-submitted broker statement. Counts for nothing until an admin approves it. */
  app.post("/v1/storefronts/:slug/verified-results", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug } = request.params as { slug: string };

    const parsed = VerifiedResultBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid submission",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const customer = await findCustomer(deps.db, storefront.id, customerAuth.userId);
    if (!customer) {
      sendProblem(reply, {
        status: 403,
        title: "Forbidden",
        detail: "Only a subscriber can submit results for an algo.",
        instance: request.url,
        code: "NOT_A_CUSTOMER",
      });
      return;
    }

    const periodStart = new Date(parsed.data.periodStart);
    const periodEnd = new Date(parsed.data.periodEnd);
    if (periodEnd.getTime() <= periodStart.getTime()) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid period",
        detail: "periodEnd must be after periodStart.",
        instance: request.url,
        code: "INVALID_PERIOD",
      });
      return;
    }

    const submissionId = generateId();
    await deps.db
      .insert(customerVerifiedResults)
      .values({
        id: submissionId,
        listingId: parsed.data.listingId,
        customerId: customer.id,
        broker: parsed.data.broker,
        periodStart,
        periodEnd,
        netReturnPct: String(parsed.data.netReturnPct),
        statementObjectKey: parsed.data.statementObjectKey,
        statementChecksum: parsed.data.statementChecksum,
        status: "SUBMITTED",
      })
      .onConflictDoNothing({
        target: [
          customerVerifiedResults.listingId,
          customerVerifiedResults.customerId,
          customerVerifiedResults.periodStart,
          customerVerifiedResults.periodEnd,
        ],
      });

    reply.code(202).send({ status: "SUBMITTED" });
  });

  /** Developer program: propose an existing strategy version for the catalogue. */
  app.post("/v1/storefronts/:slug/developer-submissions", async (request, reply) => {
    const customerAuth = request.requireCustomer();
    const { slug } = request.params as { slug: string };

    const parsed = DeveloperSubmissionBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid submission",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const submissionId = generateId();
    const inserted = await deps.db
      .insert(developerSubmissions)
      .values({
        id: submissionId,
        storefrontId: storefront.id,
        developerUserId: customerAuth.userId,
        strategyVersionId: parsed.data.strategyVersionId,
        proposedName: parsed.data.proposedName,
        proposedTagline: parsed.data.proposedTagline,
        notes: parsed.data.notes,
        status: "SUBMITTED",
      })
      .onConflictDoNothing({ target: [developerSubmissions.storefrontId, developerSubmissions.strategyVersionId] })
      .returning({ id: developerSubmissions.id });

    if (inserted.length === 0) {
      sendProblem(reply, {
        status: 409,
        title: "Already submitted",
        detail: "That strategy version has already been submitted to this storefront.",
        instance: request.url,
        code: "DUPLICATE_SUBMISSION",
      });
      return;
    }

    reply.code(201).send({ submissionId, status: "SUBMITTED" });
  });
}
