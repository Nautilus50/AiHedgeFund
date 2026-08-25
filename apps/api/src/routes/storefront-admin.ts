import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { algoListings, algoReleases, customerVerifiedResults, developerSubmissions, storefronts } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import {
  createListing,
  publishListing,
  publishRelease,
  publishStatSnapshot,
  retireListing,
  setListingPrice,
} from "../services/storefront/publishing.js";

export interface StorefrontAdminRouteDeps {
  db: Database;
}

/** Publishing is an operator action; a researcher cannot put their own work on sale. */
const PUBLISHING_ROLES = ["OPERATOR", "ADMIN"] as const;

const CreateListingBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lower-case words separated by single hyphens."),
  name: z.string().min(1).max(120),
  tagline: z.string().max(240).default(""),
  description: z.string().max(20_000).default(""),
  riskNote: z.string().max(4000).default(""),
  marketCategory: z.enum(["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"]),
  symbol: z.string().min(1).max(40),
  timeframe: z.string().min(1).max(10),
  developerUserId: z.string().uuid().nullable().default(null),
  revenueShareBps: z.number().int().min(0).max(10_000).default(0),
});

const SetPriceBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  monthlyAmountMinor: z.number().int().positive(),
});

const PublishReleaseBody = z.object({
  strategyVersionId: z.string().uuid(),
  changelog: z.string().max(4000).default(""),
  setupInstructions: z.string().max(20_000).default(""),
});

const PublishStatsBody = z.object({
  backtestRunId: z.string().uuid(),
  scope: z.enum(["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER", "CUSTOMER_VERIFIED"]),
});

const ReviewBody = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().max(4000).default(""),
});

/**
 * Back-office routes (ADR 0015). Organisation-scoped and role-gated: the
 * storefront is administered from inside the research organisation that owns
 * it, and every route below resolves the caller's own storefront rather than
 * accepting a storefront id from the request.
 */
export function registerStorefrontAdminRoutes(app: FastifyInstance, deps: StorefrontAdminRouteDeps): void {
  /** Resolves the caller's storefront from their organisation — never from client input. */
  async function resolveOwnStorefront(organisationId: string) {
    const [row] = await deps.db
      .select({ id: storefronts.id, organisationId: storefronts.organisationId })
      .from(storefronts)
      .where(eq(storefronts.organisationId, organisationId))
      .limit(1);
    return row ?? null;
  }

  /** Confirms a listing belongs to the caller's storefront before any write touches it. */
  async function requireOwnListing(organisationId: string, listingId: string) {
    const [row] = await deps.db
      .select({ id: algoListings.id })
      .from(algoListings)
      .innerJoin(storefronts, eq(storefronts.id, algoListings.storefrontId))
      .where(and(eq(algoListings.id, listingId), eq(storefronts.organisationId, organisationId)))
      .limit(1);
    return row ?? null;
  }

  app.get("/v1/storefront/listings", async (request, reply) => {
    const auth = request.requireAuth();
    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      reply.send({ items: [] });
      return;
    }

    const items = await deps.db
      .select()
      .from(algoListings)
      .where(eq(algoListings.storefrontId, storefront.id))
      .orderBy(desc(algoListings.createdAt));

    reply.send({ items });
  });

  app.post("/v1/storefront/listings", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const parsed = CreateListingBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid listing",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      sendProblem(reply, {
        status: 404,
        title: "Not Found",
        detail: "This organisation has no storefront.",
        instance: request.url,
      });
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

    const outcome = await createListing(deps.db, {
      storefrontId: storefront.id,
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      ...parsed.data,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 409,
        title: "Listing could not be created",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    const result = { listingId: outcome.listingId };
    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });
    reply.code(201).send(result);
  });

  app.put("/v1/storefront/listings/:listingId/price", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { listingId } = request.params as { listingId: string };
    const parsed = SetPriceBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid price",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    if (!(await requireOwnListing(auth.organisationId, listingId))) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such listing.", instance: request.url });
      return;
    }

    const outcome = await setListingPrice(deps.db, { listingId, ...parsed.data });
    reply.send({ priceId: outcome.priceId });
  });

  app.post("/v1/storefront/listings/:listingId/releases", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { listingId } = request.params as { listingId: string };
    const parsed = PublishReleaseBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid release",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    if (!(await requireOwnListing(auth.organisationId, listingId))) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such listing.", instance: request.url });
      return;
    }

    const outcome = await publishRelease(deps.db, {
      listingId,
      actorUserId: auth.userId,
      traceId: request.id,
      ...parsed.data,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Release rejected",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.code(201).send({ releaseId: outcome.releaseId, releaseNumber: outcome.releaseNumber });
  });

  app.post("/v1/storefront/releases/:releaseId/stats", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { releaseId } = request.params as { releaseId: string };
    const parsed = PublishStatsBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid stats request",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const [release] = await deps.db
      .select({ listingId: algoReleases.listingId })
      .from(algoReleases)
      .where(eq(algoReleases.id, releaseId))
      .limit(1);

    if (!release || !(await requireOwnListing(auth.organisationId, release.listingId))) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such release.", instance: request.url });
      return;
    }

    const outcome = await publishStatSnapshot(deps.db, {
      releaseId,
      actorUserId: auth.userId,
      traceId: request.id,
      ...parsed.data,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Evidence rejected",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.code(201).send({ snapshotId: outcome.snapshotId });
  });

  app.post("/v1/storefront/listings/:listingId/publish", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { listingId } = request.params as { listingId: string };
    if (!(await requireOwnListing(auth.organisationId, listingId))) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such listing.", instance: request.url });
      return;
    }

    const outcome = await publishListing(deps.db, { listingId, actorUserId: auth.userId, traceId: request.id });
    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Listing cannot be published",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }
    reply.send({ status: "PUBLISHED" });
  });

  app.post("/v1/storefront/listings/:listingId/retire", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { listingId } = request.params as { listingId: string };
    if (!(await requireOwnListing(auth.organisationId, listingId))) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such listing.", instance: request.url });
      return;
    }

    const outcome = await retireListing(deps.db, { listingId, actorUserId: auth.userId, traceId: request.id });
    if (!outcome.ok) {
      sendProblem(reply, {
        status: 422,
        title: "Listing cannot be retired",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }
    reply.send({ status: "RETIRED" });
  });

  app.get("/v1/storefront/developer-submissions", async (request, reply) => {
    const auth = request.requireAuth();
    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      reply.send({ items: [] });
      return;
    }

    const items = await deps.db
      .select()
      .from(developerSubmissions)
      .where(eq(developerSubmissions.storefrontId, storefront.id))
      .orderBy(desc(developerSubmissions.createdAt));

    reply.send({ items });
  });

  /**
   * Reviewing a submission records the decision only. It deliberately does not
   * create a listing: publishing stays a separate, explicit action with its own
   * evidence gates (CLAUDE.md 3.4 — no single step both accepts work and ships it).
   */
  app.post("/v1/storefront/developer-submissions/:submissionId/review", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { submissionId } = request.params as { submissionId: string };
    const parsed = ReviewBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid review",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such submission.", instance: request.url });
      return;
    }

    const [submission] = await deps.db
      .select({ id: developerSubmissions.id, developerUserId: developerSubmissions.developerUserId })
      .from(developerSubmissions)
      .where(
        and(eq(developerSubmissions.id, submissionId), eq(developerSubmissions.storefrontId, storefront.id)),
      )
      .limit(1);

    if (!submission) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such submission.", instance: request.url });
      return;
    }

    if (submission.developerUserId === auth.userId) {
      // Separation of duties: a developer cannot approve their own submission,
      // whatever role they hold in the organisation (CLAUDE.md 3.4).
      sendProblem(reply, {
        status: 403,
        title: "Forbidden",
        detail: "A developer cannot review their own submission.",
        instance: request.url,
        code: "SELF_REVIEW_FORBIDDEN",
      });
      return;
    }

    await deps.db
      .update(developerSubmissions)
      .set({
        status: parsed.data.decision,
        reviewNotes: parsed.data.notes,
        reviewedByUserId: auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(developerSubmissions.id, submissionId));

    reply.send({ status: parsed.data.decision });
  });

  app.get("/v1/storefront/verified-results", async (request, reply) => {
    const auth = request.requireAuth();
    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      reply.send({ items: [] });
      return;
    }

    const items = await deps.db
      .select({
        id: customerVerifiedResults.id,
        listingId: customerVerifiedResults.listingId,
        broker: customerVerifiedResults.broker,
        periodStart: customerVerifiedResults.periodStart,
        periodEnd: customerVerifiedResults.periodEnd,
        netReturnPct: customerVerifiedResults.netReturnPct,
        status: customerVerifiedResults.status,
        createdAt: customerVerifiedResults.createdAt,
      })
      .from(customerVerifiedResults)
      .innerJoin(algoListings, eq(algoListings.id, customerVerifiedResults.listingId))
      .where(eq(algoListings.storefrontId, storefront.id))
      .orderBy(desc(customerVerifiedResults.createdAt));

    reply.send({ items });
  });

  app.post("/v1/storefront/verified-results/:resultId/review", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { resultId } = request.params as { resultId: string };
    const parsed = ReviewBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid review",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const storefront = await resolveOwnStorefront(auth.organisationId);
    if (!storefront) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such result.", instance: request.url });
      return;
    }

    const [result] = await deps.db
      .select({ id: customerVerifiedResults.id })
      .from(customerVerifiedResults)
      .innerJoin(algoListings, eq(algoListings.id, customerVerifiedResults.listingId))
      .where(and(eq(customerVerifiedResults.id, resultId), eq(algoListings.storefrontId, storefront.id)))
      .limit(1);

    if (!result) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such result.", instance: request.url });
      return;
    }

    await deps.db
      .update(customerVerifiedResults)
      .set({
        status: parsed.data.decision,
        reviewNotes: parsed.data.notes,
        reviewedByUserId: auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(customerVerifiedResults.id, resultId));

    reply.send({ status: parsed.data.decision });
  });
}
