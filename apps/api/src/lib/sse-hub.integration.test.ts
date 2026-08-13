import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import { closeDatabase, createTestDatabase, isTestDatabaseAvailable, outboxEvents, seedOrganisation, truncateAll, type Database } from "@arf-os/db";
import { SseHub, ZERO_CURSOR } from "./sse-hub.js";

const available = await isTestDatabaseAvailable();

async function insertPublishedEvent(
  db: Database,
  organisationId: string,
  aggregateId: string,
  eventType = "backtest_run.completed",
): Promise<string> {
  const id = generateId<string>();
  await db.insert(outboxEvents).values({
    id,
    eventType,
    eventVersion: "1.0.0",
    aggregateId,
    aggregateVersion: "1",
    correlationId: generateId<string>(),
    organisationId,
    actor: "test",
    payload: {},
    status: "PUBLISHED",
  });
  return id;
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("timed out waiting for condition"));
      }
    }, 20);
  });
}

describe.skipIf(!available)("SseHub (integration)", () => {
  let db: Database;
  let hub: SseHub;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    hub = new SseHub(db, 30);
  });

  afterEach(() => {
    hub.stop();
  });

  it("catches up a new subscriber on events published before it subscribed", async () => {
    const org = await seedOrganisation(db);
    const aggregateId = generateId<string>();
    const eventId = await insertPublishedEvent(db, org.organisationId, aggregateId);

    const received: string[] = [];
    await hub.subscribe(org.organisationId, undefined, undefined, (event) => received.push(event.id));

    expect(received).toEqual([eventId]);
  });

  it("never delivers another organisation's events during catch-up or live", async () => {
    const orgA = await seedOrganisation(db, { slug: "sse-org-a" });
    const orgB = await seedOrganisation(db, { slug: "sse-org-b" });
    await insertPublishedEvent(db, orgB.organisationId, generateId<string>());

    const received: string[] = [];
    await hub.subscribe(orgA.organisationId, undefined, undefined, (event) => received.push(event.id));
    await hub.start();

    await insertPublishedEvent(db, orgB.organisationId, generateId<string>());
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received).toEqual([]);
  });

  it("narrows to one aggregate when the subscriber asks for it", async () => {
    const org = await seedOrganisation(db);
    const aggregateA = generateId<string>();
    const aggregateB = generateId<string>();
    await insertPublishedEvent(db, org.organisationId, aggregateA);
    await insertPublishedEvent(db, org.organisationId, aggregateB);

    const received: string[] = [];
    await hub.subscribe(org.organisationId, aggregateA, undefined, (event) => received.push(event.aggregateId));

    expect(received).toEqual([aggregateA]);
  });

  it("delivers a newly published event to an already-live subscriber, exactly once", async () => {
    const org = await seedOrganisation(db);
    const aggregateId = generateId<string>();

    const received: string[] = [];
    await hub.subscribe(org.organisationId, undefined, undefined, (event) => received.push(event.id));
    await hub.start();

    const eventId = await insertPublishedEvent(db, org.organisationId, aggregateId);
    await waitFor(() => received.length === 1);

    expect(received).toEqual([eventId]);
  });

  it("resumes from a client-supplied cursor without replaying what it already saw", async () => {
    const org = await seedOrganisation(db);
    const aggregateId = generateId<string>();
    const first = await insertPublishedEvent(db, org.organisationId, aggregateId);
    const second = await insertPublishedEvent(db, org.organisationId, aggregateId);

    const received: string[] = [];
    await hub.subscribe(org.organisationId, undefined, first, (event) => received.push(event.id));

    expect(received).toEqual([second]);
  });

  it("a subscriber with no cursor and no history sees only what comes after start", async () => {
    const org = await seedOrganisation(db);
    const received: string[] = [];
    await hub.subscribe(org.organisationId, undefined, ZERO_CURSOR, (event) => received.push(event.id));
    expect(received).toEqual([]);
  });
});
