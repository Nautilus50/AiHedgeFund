import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import { getPublishedListingDetail, getStorefrontBySlug, listPublishedListings } from "../services/storefront/catalogue.js";
import { quoteSelection } from "../services/storefront/checkout.js";

export interface StorefrontPublicRouteDeps {
  db: Database;
}

const ListingQuery = z.object({
  marketCategory: z.enum(["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"]).optional(),
  symbol: z.string().min(1).max(40).optional(),
  timeframe: z.string().min(1).max(10).optional(),
});

const QuoteBody = z.object({
  listingIds: z.array(z.string().uuid()).min(1).max(50),
});

/**
 * Anonymous catalogue routes (ADR 0015). These are the only routes in the API
 * that serve an unauthenticated caller, so every one of them is scoped to a
 * single storefront resolved by slug and returns published rows only. None of
 * them can reach Pine source, draft listings, or any customer record.
 */
export function registerStorefrontPublicRoutes(app: FastifyInstance, deps: StorefrontPublicRouteDeps): void {
  app.get("/v1/public/storefronts/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }
    // organisationId is deliberately not in the response: the operating
    // organisation is an internal identity, not a public one.
    reply.send({
      slug: storefront.slug,
      name: storefront.name,
      tagline: storefront.tagline,
      supportEmail: storefront.supportEmail,
      defaultCurrency: storefront.defaultCurrency,
    });
  });

  app.get("/v1/public/storefronts/:slug/listings", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = ListingQuery.safeParse(request.query);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid filters",
        detail: "Query parameters failed validation.",
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

    const items = await listPublishedListings(deps.db, storefront.id, parsed.data);
    reply.send({ items });
  });

  app.get("/v1/public/storefronts/:slug/listings/:listingSlug", async (request, reply) => {
    const { slug, listingSlug } = request.params as { slug: string; listingSlug: string };
    const storefront = await getStorefrontBySlug(deps.db, slug);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such storefront.", instance: request.url });
      return;
    }

    const listing = await getPublishedListingDetail(deps.db, storefront.id, listingSlug);
    if (!listing) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such algo.", instance: request.url });
      return;
    }
    reply.send(listing);
  });

  /**
   * Prices a cart before sign-in. Read-only and side-effect free — it creates
   * nothing, so an anonymous shopper can see the volume discount they would get
   * without an account.
   */
  app.post("/v1/public/storefronts/:slug/quote", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = QuoteBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid quote request",
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

    const quoted = await quoteSelection(deps.db, { storefrontId: storefront.id, listingIds: parsed.data.listingIds });
    if (!quoted.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Cannot price this selection",
        detail: quoted.message,
        instance: request.url,
        code: quoted.reasonCode,
      });
      return;
    }
    reply.send(quoted.quote);
  });
}
