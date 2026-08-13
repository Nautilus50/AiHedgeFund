import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { getPendingVerificationsCount, getQueueDepths, listParseFailures, listRecentDecisions } from "../services/operations.js";

export interface OperationsRouteDeps {
  db: Database;
}

const RECENT_DECISIONS_LIMIT = 10;
const PARSE_FAILURES_LIMIT = 10;

/**
 * Command Centre's operational widgets (CLAUDE.md 20): pending
 * verifications, recent committee decisions, parse failures, and BullMQ
 * queue depth. One endpoint, matching `getDashboardKpis`'s "one dashboard
 * call" precedent rather than four separate round-trips for one page.
 */
export function registerOperationsRoutes(app: FastifyInstance, deps: OperationsRouteDeps): void {
  app.get("/v1/operations/summary", async (request, reply) => {
    const auth = request.requireAuth();

    const [pendingVerifications, recentDecisions, parseFailures, queueDepths] = await Promise.all([
      getPendingVerificationsCount(deps.db, auth.organisationId),
      listRecentDecisions(deps.db, auth.organisationId, RECENT_DECISIONS_LIMIT),
      listParseFailures(deps.db, auth.organisationId, PARSE_FAILURES_LIMIT),
      getQueueDepths(),
    ]);

    reply.send({ pendingVerifications, recentDecisions, parseFailures, queueDepths });
  });
}
