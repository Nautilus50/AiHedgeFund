import { eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { sseTickets } from "@arf-os/db";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";

/**
 * Short — this ticket only needs to survive the moment between "mint" and
 * "open the EventSource", not the life of the connection itself (ADR 0007).
 */
const TICKET_TTL_MS = 30_000;

export interface MintedSseTicket {
  ticket: string;
  expiresAt: Date;
}

/**
 * Bridges a normal Bearer-authenticated request into an SSE connection
 * browser `EventSource` cannot itself authenticate. Only the hash is ever
 * persisted, mirroring the forward-deployment webhook token.
 */
export async function mintSseTicket(db: Database, organisationId: string, userId: string): Promise<MintedSseTicket> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);

  await db.insert(sseTickets).values({
    id: generateId<string>(),
    tokenHash: hashToken(token),
    organisationId,
    userId,
    expiresAt,
  });

  return { ticket: token, expiresAt };
}

export type ClaimTicketOutcome = { ok: true; organisationId: string } | { ok: false };

/**
 * Looks up a ticket and, if it's valid, marks it used and returns the
 * organisation to stream. Validity and "mark used" happen together here
 * rather than as two separate steps the route could interleave with a
 * failure in between — a ticket found valid by this function is
 * unconditionally consumed by it.
 *
 * Missing, expired, and already-used all return the same `{ ok: false }`
 * shape — a caller must never be able to distinguish "wrong ticket" from
 * "right ticket, already spent" (CLAUDE.md 19.1's non-leaking-lookup
 * pattern, applied here instead of to organisation ownership).
 */
export async function claimSseTicket(db: Database, ticket: string): Promise<ClaimTicketOutcome> {
  const [row] = await db.select().from(sseTickets).where(eq(sseTickets.tokenHash, hashToken(ticket))).limit(1);

  if (!row || row.usedAt !== null || row.expiresAt.getTime() < Date.now()) {
    return { ok: false };
  }

  await db.update(sseTickets).set({ usedAt: new Date() }).where(eq(sseTickets.id, row.id));
  return { ok: true, organisationId: row.organisationId };
}
