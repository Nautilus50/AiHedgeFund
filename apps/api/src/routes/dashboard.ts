import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { getDashboardKpis } from "../services/dashboard.js";

export interface DashboardRouteDeps {
  db: Database;
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  app.get("/v1/dashboard/kpis", async (request, reply) => {
    const auth = request.requireAuth();
    const kpis = await getDashboardKpis(deps.db, auth.organisationId);
    reply.send(kpis);
  });
}
