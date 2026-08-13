import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { checkIdempotency, recordIdempotency } from "../lib/idempotency.js";
import { sendProblem } from "../lib/problem-details.js";
import { requireIdempotencyKey, requireRoleOr403 } from "../lib/request-helpers.js";
import { CreateCampaignInput, createCampaign, getCampaign, getCampaignSummary, listCampaigns } from "../services/campaigns.js";

export interface CampaignRouteDeps {
  db: Database;
}

export function registerCampaignRoutes(app: FastifyInstance, deps: CampaignRouteDeps): void {
  app.post("/v1/campaigns", async (request, reply) => {
    const auth = request.requireAuth();
    if (!requireRoleOr403(request, reply, auth.role, ["RESEARCHER", "ADMIN"])) return;

    const parsed = CreateCampaignInput.safeParse(request.body);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid campaign",
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
        detail: "This key was already used for a different request body.",
        instance: request.url,
      });
      return;
    }
    if (idem.status === "REPLAY") {
      reply.code(200).send(idem.storedResponse);
      return;
    }

    const campaign = await createCampaign(deps.db, auth.organisationId, auth.userId, parsed.data);
    await recordIdempotency(deps.db, {
      idempotencyKey,
      organisationId: auth.organisationId,
      requestBody: parsed.data,
      responseBody: campaign,
    });

    reply.code(201).send(campaign);
  });

  app.get("/v1/campaigns", async (request, reply) => {
    const auth = request.requireAuth();
    const query = request.query as { cursor?: string; limit?: string };

    const result = await listCampaigns(deps.db, auth.organisationId, {
      cursor: query.cursor,
      limit: query.limit ? Number(query.limit) : undefined,
    });

    if (!result.ok) {
      sendProblem(reply, {
        status: 400,
        title: "Invalid cursor",
        detail: "The cursor query parameter is malformed.",
        instance: request.url,
      });
      return;
    }

    reply.send(result.page);
  });

  app.get("/v1/campaigns/:id", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const campaign = await getCampaign(deps.db, auth.organisationId, id);
    if (!campaign) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No campaign ${id}.`, instance: request.url });
      return;
    }

    reply.send(campaign);
  });

  app.get("/v1/campaigns/:id/summary", async (request, reply) => {
    const auth = request.requireAuth();
    const { id } = request.params as { id: string };

    const summary = await getCampaignSummary(deps.db, auth.organisationId, id);
    if (!summary) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: `No campaign ${id}.`, instance: request.url });
      return;
    }

    reply.send(summary);
  });
}
