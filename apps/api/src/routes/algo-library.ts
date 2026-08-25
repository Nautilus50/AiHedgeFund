import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { getAlgoDetail, listAlgos } from "../services/algo-library/catalogue.js";
import { getAlgoSource } from "../services/algo-library/delivery.js";
import {
  createAlgo,
  publishAlgo,
  publishRelease,
  publishStatSnapshot,
  retireAlgo,
} from "../services/algo-library/publishing.js";

export interface AlgoLibraryRouteDeps {
  db: Database;
}

/** Cataloguing is an operator action; it is separate from doing the research. */
const PUBLISHING_ROLES = ["OPERATOR", "ADMIN"] as const;

const AlgoQuery = z.object({
  status: z.enum(["DRAFT", "PUBLISHED", "RETIRED"]).optional(),
  marketCategory: z.enum(["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"]).optional(),
  symbol: z.string().min(1).max(40).optional(),
  timeframe: z.string().min(1).max(10).optional(),
});

const CreateAlgoBody = z.object({
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
});

const PublishReleaseBody = z.object({
  strategyVersionId: z.string().uuid(),
  changelog: z.string().max(4000).default(""),
  setupInstructions: z.string().max(20_000).default(""),
});

const PublishStatsBody = z.object({
  backtestRunId: z.string().uuid(),
  scope: z.enum(["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER"]),
});

/**
 * Algo library routes (ADR 0015). Organisation-scoped throughout: every handler
 * passes the caller's own organisationId into the service, and no route accepts
 * an organisation or library id from the request body.
 */
export function registerAlgoLibraryRoutes(app: FastifyInstance, deps: AlgoLibraryRouteDeps): void {
  app.get("/v1/algos", async (request, reply) => {
    const auth = request.requireAuth();
    const parsed = AlgoQuery.safeParse(request.query);
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

    const items = await listAlgos(deps.db, auth.organisationId, parsed.data);
    reply.send({ items });
  });

  app.get("/v1/algos/:slug", async (request, reply) => {
    const auth = request.requireAuth();
    const { slug } = request.params as { slug: string };

    const algo = await getAlgoDetail(deps.db, auth.organisationId, slug);
    if (!algo) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No such algo.", instance: request.url });
      return;
    }
    reply.send(algo);
  });

  /**
   * The algo's Pine source. Reading it writes an audit event in the service —
   * the library records what was taken out of it, not just what went in.
   */
  app.get("/v1/algos/:slug/source", async (request, reply) => {
    const auth = request.requireAuth();
    const { slug } = request.params as { slug: string };

    const outcome = await getAlgoSource(deps.db, {
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      slug,
      traceId: request.id,
    });

    if (!outcome.ok) {
      sendProblem(reply, {
        status: 404,
        title: "Not Found",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.send(outcome.delivery);
  });

  app.post("/v1/algos", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const parsed = CreateAlgoBody.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid algo",
        detail: "Request body failed validation.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return;

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

    const outcome = await createAlgo(deps.db, { organisationId: auth.organisationId, ...parsed.data });
    if (!outcome.ok) {
      sendProblem(reply, {
        status: 409,
        title: "Algo could not be created",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    const result = { algoId: outcome.algoId };
    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: result,
    });
    reply.code(201).send(result);
  });

  app.post("/v1/algos/:algoId/releases", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { algoId } = request.params as { algoId: string };
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

    const outcome = await publishRelease(deps.db, {
      algoId,
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      traceId: request.id,
      ...parsed.data,
    });

    if (!outcome.ok) {
      const status = outcome.reasonCode === "ALGO_NOT_FOUND" ? 404 : 422;
      sendProblem(reply, {
        status,
        title: status === 404 ? "Not Found" : "Release rejected",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.code(201).send({ releaseId: outcome.releaseId, releaseNumber: outcome.releaseNumber });
  });

  app.post("/v1/algo-releases/:releaseId/stats", async (request, reply) => {
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

    const outcome = await publishStatSnapshot(deps.db, {
      releaseId,
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      traceId: request.id,
      ...parsed.data,
    });

    if (!outcome.ok) {
      const status = outcome.reasonCode === "RELEASE_NOT_FOUND" ? 404 : 422;
      sendProblem(reply, {
        status,
        title: status === 404 ? "Not Found" : "Evidence rejected",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }

    reply.code(201).send({ snapshotId: outcome.snapshotId });
  });

  app.post("/v1/algos/:algoId/publish", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { algoId } = request.params as { algoId: string };
    const outcome = await publishAlgo(deps.db, {
      algoId,
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      traceId: request.id,
    });

    if (!outcome.ok) {
      const status = outcome.reasonCode === "ALGO_NOT_FOUND" ? 404 : 422;
      sendProblem(reply, {
        status,
        title: status === 404 ? "Not Found" : "Algo cannot be published",
        detail: outcome.message,
        instance: request.url,
        code: outcome.reasonCode,
      });
      return;
    }
    reply.send({ status: "PUBLISHED" });
  });

  app.post("/v1/algos/:algoId/retire", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, PUBLISHING_ROLES)) return;

    const { algoId } = request.params as { algoId: string };
    const outcome = await retireAlgo(deps.db, {
      algoId,
      organisationId: auth.organisationId,
      actorUserId: auth.userId,
      traceId: request.id,
    });

    if (!outcome.ok) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: outcome.message, instance: request.url });
      return;
    }
    reply.send({ status: "RETIRED" });
  });
}
