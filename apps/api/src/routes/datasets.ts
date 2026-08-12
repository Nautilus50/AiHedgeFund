import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import { listDatasetVersions } from "../services/datasets.js";

export interface DatasetRouteDeps {
  db: Database;
}

export function registerDatasetRoutes(app: FastifyInstance, deps: DatasetRouteDeps): void {
  app.get("/v1/dataset-versions", async (request, reply) => {
    const auth = request.requireAuth();
    const query = request.query as { cursor?: string; limit?: string };

    const result = await listDatasetVersions(deps.db, auth.organisationId, {
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
}
