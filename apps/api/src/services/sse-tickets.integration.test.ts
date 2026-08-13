import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createTestDatabase, isTestDatabaseAvailable, seedOrganisation, sseTickets, truncateAll, type Database } from "@arf-os/db";
import { hashToken } from "../lib/tokens.js";
import { claimSseTicket, mintSseTicket } from "./sse-tickets.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("SSE tickets (integration)", () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("mints a ticket whose plaintext is never itself persisted", async () => {
    const org = await seedOrganisation(db);
    const minted = await mintSseTicket(db, org.organisationId, org.userId);

    const [row] = await db.select().from(sseTickets);
    if (!row) throw new Error("expected a row");
    expect(row.tokenHash).not.toBe(minted.ticket);
    expect(row.organisationId).toBe(org.organisationId);
    expect(row.usedAt).toBeNull();
  });

  it("claims a freshly minted ticket and returns its organisation", async () => {
    const org = await seedOrganisation(db);
    const minted = await mintSseTicket(db, org.organisationId, org.userId);

    const outcome = await claimSseTicket(db, minted.ticket);
    expect(outcome).toEqual({ ok: true, organisationId: org.organisationId });
  });

  it("never allows the same ticket to be claimed twice", async () => {
    const org = await seedOrganisation(db);
    const minted = await mintSseTicket(db, org.organisationId, org.userId);

    const first = await claimSseTicket(db, minted.ticket);
    const second = await claimSseTicket(db, minted.ticket);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false });
  });

  it("rejects an unknown ticket", async () => {
    const outcome = await claimSseTicket(db, "not-a-real-ticket");
    expect(outcome).toEqual({ ok: false });
  });

  it("rejects an expired ticket without claiming it", async () => {
    const org = await seedOrganisation(db);
    const minted = await mintSseTicket(db, org.organisationId, org.userId);

    await db
      .update(sseTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sseTickets.tokenHash, hashToken(minted.ticket)));

    const outcome = await claimSseTicket(db, minted.ticket);
    expect(outcome).toEqual({ ok: false });
  });
});
