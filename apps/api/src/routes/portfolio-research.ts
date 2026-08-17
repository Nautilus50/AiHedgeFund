import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import { getPortfolioCorrelationReport } from "../services/portfolio-research.js";

export interface PortfolioResearchRouteDeps {
  db: Database;
}

const StrategyVersionIdsQuery = z.string().uuid().array().optional();

export function registerPortfolioResearchRoutes(app: FastifyInstance, deps: PortfolioResearchRouteDeps): void {
  app.get("/v1/portfolio-research/correlation", async (request, reply) => {
    const auth = request.requireAuth();
    const { strategyVersionIds: raw } = request.query as { strategyVersionIds?: string };

    const ids = raw ? raw.split(",").filter((id) => id.length > 0) : undefined;
    const parsed = StrategyVersionIdsQuery.safeParse(ids);
    if (!parsed.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid strategyVersionIds",
        detail: "strategyVersionIds must be a comma-separated list of UUIDs.",
        instance: request.url,
        validationErrors: parsed.error.issues,
      });
      return;
    }

    const result = await getPortfolioCorrelationReport(deps.db, auth.organisationId, { strategyVersionIds: parsed.data });
    reply.send(result);
  });
}
