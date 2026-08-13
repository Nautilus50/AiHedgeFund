import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@arf-os/db";
import { sendProblem } from "../lib/problem-details.js";
import { formatSseEvent, type SseHub } from "../lib/sse-hub.js";
import { claimSseTicket, mintSseTicket } from "../services/sse-tickets.js";

export interface SseRouteDeps {
  db: Database;
  sseHub: SseHub;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

const StreamQuery = z.object({
  cursor: z.string().uuid().optional(),
  aggregateId: z.string().uuid().optional(),
});

export function registerSseRoutes(app: FastifyInstance, deps: SseRouteDeps): void {
  app.post("/v1/sse/tickets", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const auth = request.requireAuth();
    const minted = await mintSseTicket(deps.db, auth.organisationId, auth.userId);
    reply.code(201).send({ ticket: minted.ticket, expiresAt: minted.expiresAt.toISOString() });
  });

  // No requireAuth() — same non-pattern as the TradingView webhook route.
  // The ticket itself is the auth; browser EventSource cannot set an
  // Authorization header, so a normal Bearer-authenticated request mints
  // this short-lived, single-use bridge first (ADR 0007).
  app.get("/v1/events/stream/:ticket", async (request, reply) => {
    const { ticket } = request.params as { ticket: string };
    const parsedQuery = StreamQuery.safeParse(request.query);
    if (!parsedQuery.success) {
      sendProblem(reply, {
        status: 422,
        title: "Invalid stream query",
        detail: "cursor and aggregateId, when present, must be UUIDs.",
        instance: request.url,
        validationErrors: parsedQuery.error.issues,
      });
      return;
    }

    const claimed = await claimSseTicket(deps.db, ticket);
    // Same non-leaking shape whether the ticket is missing, expired, or
    // already used — never distinguish which, that would let a caller
    // probe for a ticket that "almost" matched.
    if (!claimed.ok) {
      sendProblem(reply, { status: 404, title: "Not Found", detail: "No active stream ticket.", instance: request.url });
      return;
    }

    // `reply.raw.writeHead` bypasses Fastify's normal reply pipeline
    // entirely, which is also where `@fastify/cors` attaches its headers —
    // so a cross-origin browser call needs them added explicitly here, or
    // the browser blocks the response before the page ever sees a byte of
    // it. `origin: true` on the plugin means "reflect the request's own
    // Origin," so that's what's reproduced here.
    const origin = request.headers.origin;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = await deps.sseHub.subscribe(
      claimed.organisationId,
      parsedQuery.data.aggregateId,
      parsedQuery.data.cursor,
      (event) => {
        reply.raw.write(formatSseEvent(event));
      },
    );

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
