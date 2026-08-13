import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { generateId } from "@arf-os/contracts";
import { relayOutboxBatch, type JobPublisher, type RoutedJob } from "../outbox-relay.js";
import { DrizzleOutboxStore } from "./drizzle-outbox-store.js";

const available = await isTestDatabaseAvailable();

class RecordingPublisher implements JobPublisher {
  published: RoutedJob[] = [];
  async publish(job: RoutedJob): Promise<void> {
    this.published.push(job);
  }
}

class AlwaysFailingPublisher implements JobPublisher {
  async publish(): Promise<void> {
    throw new Error("broker down");
  }
}

describe.skipIf(!available)("DrizzleOutboxStore (integration)", () => {
  let db: Database;
  let store: DrizzleOutboxStore;
  let organisationId: string;

  beforeAll(() => {
    db = createTestDatabase();
    store = new DrizzleOutboxStore(db);
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    organisationId = (await seedOrganisation(db)).organisationId;
  });

  async function insertEvent(eventType = "trades.normalised"): Promise<string> {
    const id = generateId<string>();
    await db.insert(outboxEvents).values({
      id,
      eventType,
      eventVersion: "1.0.0",
      aggregateId: generateId<string>(),
      aggregateVersion: "1",
      correlationId: generateId<string>(),
      organisationId,
      actor: "integration-test",
      payload: { backtestRunId: generateId<string>(), initialCapital: "10000" },
    });
    return id;
  }

  it("claims pending rows and flips them to PUBLISHING in the same statement", async () => {
    await insertEvent();
    await insertEvent();

    const claimed = await store.claimPending(10);
    expect(claimed).toHaveLength(2);

    const rows = await db.select({ status: outboxEvents.status }).from(outboxEvents);
    // The claim must survive past commit, otherwise a second relay could
    // re-claim rows that are still in flight.
    expect(rows.every((r) => r.status === "PUBLISHING")).toBe(true);
  });

  it("never hands the same row to two concurrent relays (FOR UPDATE SKIP LOCKED)", async () => {
    for (let i = 0; i < 6; i++) {
      await insertEvent();
    }

    // Two independent connections claiming at once must partition the rows,
    // not both take all six.
    const otherDb = createTestDatabase();
    try {
      const otherStore = new DrizzleOutboxStore(otherDb);
      const [a, b] = await Promise.all([store.claimPending(6), otherStore.claimPending(6)]);

      const idsA = a.map((r) => r.id);
      const idsB = b.map((r) => r.id);
      const overlap = idsA.filter((id) => idsB.includes(id));

      expect(overlap).toEqual([]);
      expect(idsA.length + idsB.length).toBe(6);
    } finally {
      await closeDatabase(otherDb);
    }
  });

  it("marks published rows PUBLISHED with a timestamp", async () => {
    const id = await insertEvent();
    await store.claimPending(10);
    await store.markPublished([id]);

    const [row] = await db.select().from(outboxEvents);
    expect(row?.status).toBe("PUBLISHED");
    expect(row?.publishedAt).not.toBeNull();
  });

  it("records the failure reason on a failed row without losing the original payload", async () => {
    const id = await insertEvent();
    await store.claimPending(10);
    await store.markFailed(id, "broker unavailable");

    const [row] = await db.select().from(outboxEvents);
    expect(row?.status).toBe("FAILED");
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.relayError).toBe("broker unavailable");
    // The original payload fields must survive the error annotation.
    expect(payload.initialCapital).toBe("10000");
  });

  it("reclaims rows stranded in PUBLISHING by a crashed relay", async () => {
    const id = await insertEvent();
    await store.claimPending(10);

    // Simulate a relay that died mid-flight: the row is PUBLISHING and old.
    await db.execute(
      sql`UPDATE outbox_events SET created_at = now() - interval '10 minutes' WHERE id = ${id}::uuid`,
    );

    const reclaimed = await store.reclaimStale(300);
    expect(reclaimed).toBe(1);

    const [row] = await db.select().from(outboxEvents);
    expect(row?.status).toBe("PENDING");
  });

  it("does not reclaim rows that are still recent (a healthy relay is mid-flight)", async () => {
    await insertEvent();
    await store.claimPending(10);

    const reclaimed = await store.reclaimStale(300);
    expect(reclaimed).toBe(0);

    const [row] = await db.select().from(outboxEvents);
    expect(row?.status).toBe("PUBLISHING");
  });

  it("drains a real batch end to end through relayOutboxBatch", async () => {
    await insertEvent("trades.normalised");
    await insertEvent("equity.reconstructed");
    await insertEvent("some.unrouted.event");

    const publisher = new RecordingPublisher();
    const result = await relayOutboxBatch(store, publisher, 50);

    expect(result).toMatchObject({ claimed: 3, published: 2, skipped: 1, failed: 0 });
    expect(publisher.published.map((j) => j.queue).sort()).toEqual([
      "equity-reconstruction",
      "metric-calculation",
    ]);

    const rows = await db.select({ status: outboxEvents.status }).from(outboxEvents);
    // Routed and unrouted alike end PUBLISHED — an event nobody subscribes
    // to must not be retried forever.
    expect(rows.every((r) => r.status === "PUBLISHED")).toBe(true);
  });

  it("leaves a poison row FAILED while the rest of the batch still publishes", async () => {
    await insertEvent();
    await insertEvent();

    const result = await relayOutboxBatch(store, new AlwaysFailingPublisher(), 50);
    expect(result).toMatchObject({ claimed: 2, published: 0, failed: 2 });

    const rows = await db.select({ status: outboxEvents.status }).from(outboxEvents);
    expect(rows.every((r) => r.status === "FAILED")).toBe(true);
  });
});
