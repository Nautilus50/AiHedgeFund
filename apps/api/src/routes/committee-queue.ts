import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { listCommitteeQueue } from "../services/committee-queue.js";

export interface CommitteeQueueRouteDeps {
  db: Database;
}

export function registerCommitteeQueueRoutes(app: FastifyInstance, deps: CommitteeQueueRouteDeps): void {
  app.get("/v1/committee-queue", async (request, reply) => {
    const auth = request.requireAuth();
    const { campaignId } = request.query as { campaignId?: string };

    const items = await listCommitteeQueue(deps.db, auth.organisationId, campaignId);
    reply.send({ items });
  });
}
