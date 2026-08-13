import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId, signalIdempotencyKey } from "@arf-os/contracts";
import {
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  seedStrategyVersion,
  signalEvents,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { ForwardSignalProcessingJob, QUEUE_NAMES, routeOutboxEvent } from "@arf-os/event-bus";
import { createForwardDeployment, pauseForwardDeployment } from "./forward-deployments.js";
import { ingestTradingViewSignal } from "./forward-signals.js";

const available = await isTestDatabaseAvailable();

function fillModel() {
  return {
    fillModelVersion: "1.0.0",
    latencyModel: { type: "fixed_seconds" as const, seconds: 0 },
    slippageModel: { type: "fixed_percent" as const, value: 0 },
    commissionModel: { type: "percent" as const, value: 0 },
    quantityModel: { type: "percent_of_equity" as const, percent: 10 },
    stopTargetRule: { type: "external_alert_only" as const },
  };
}

describe.skipIf(!available)("ingestTradingViewSignal (integration)", () => {
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

  async function seedActiveDeployment() {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");
    return {
      organisationId: org.organisationId,
      deploymentId: created.deploymentId,
      token: created.token,
      strategyVersionId: strategy.strategyVersionId,
    };
  }

  function validSignal(deploymentId: string, strategyVersionId: string, overrides: Record<string, unknown> = {}) {
    return {
      schema: "arf.signal.v1",
      deploymentId,
      strategyVersionId,
      eventId: "order-1",
      eventType: "ENTRY_LONG",
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      barTime: "2026-08-04T17:00:00.000Z",
      sentAt: new Date().toISOString(),
      price: 100000,
      quantityModel: "percent_of_equity",
      ...overrides,
    };
  }

  it("rejects an unknown token without persisting anything", async () => {
    const outcome = await ingestTradingViewSignal(db, "not-a-real-token", {});
    expect(outcome).toEqual({ kind: "TOKEN_INVALID" });
    expect(await db.select().from(signalEvents)).toHaveLength(0);
  });

  it("rejects a deployment that is not ACTIVE without persisting anything", async () => {
    const { organisationId, deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    await pauseForwardDeployment(db, organisationId, deploymentId);

    const outcome = await ingestTradingViewSignal(db, token, validSignal(deploymentId, strategyVersionId));
    expect(outcome).toEqual({ kind: "DEPLOYMENT_NOT_ACTIVE" });
    expect(await db.select().from(signalEvents)).toHaveLength(0);
  });

  it("rejects a malformed body without persisting anything — no reliable key can be derived", async () => {
    const { token } = await seedActiveDeployment();
    const outcome = await ingestTradingViewSignal(db, token, { not: "a signal event" });
    expect(outcome).toEqual({ kind: "MALFORMED_PAYLOAD" });
    expect(await db.select().from(signalEvents)).toHaveLength(0);
  });

  it("accepts a valid signal, storing it PENDING and emitting an event the worker can consume", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();

    const outcome = await ingestTradingViewSignal(db, token, validSignal(deploymentId, strategyVersionId));
    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind !== "ACCEPTED") return;
    expect(outcome.duplicate).toBe(false);

    const [row] = await db.select().from(signalEvents).where(eq(signalEvents.id, outcome.signalEventId));
    expect(row?.processingStatus).toBe("PENDING");
    expect(row?.direction).toBe("LONG");

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "forward_signal.received"));
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.aggregateId).toBe(outcome.signalEventId);
    const payload = ForwardSignalProcessingJob.parse(event.payload);
    expect(payload).toEqual({ deploymentId, signalEventId: outcome.signalEventId });
    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      QUEUE_NAMES.forwardSignalProcessing,
    );
  });

  it("treats a retried delivery of the same signal as already-accepted, without a duplicate row or a duplicate event", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    const signal = validSignal(deploymentId, strategyVersionId);

    const first = await ingestTradingViewSignal(db, token, signal);
    const second = await ingestTradingViewSignal(db, token, signal);

    expect(first.kind).toBe("ACCEPTED");
    expect(second).toEqual({ kind: "ACCEPTED", signalEventId: first.kind === "ACCEPTED" ? first.signalEventId : "", duplicate: true });
    expect(await db.select().from(signalEvents)).toHaveLength(1);
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "forward_signal.received"))).toHaveLength(1);
  });

  it("rejects and records a strategyVersionId mismatch, guarded against double-counting on retry", async () => {
    const { deploymentId, token } = await seedActiveDeployment();
    const signal = validSignal(deploymentId, generateId<string>());

    const first = await ingestTradingViewSignal(db, token, signal);
    expect(first).toMatchObject({ kind: "REJECTED", reasonCode: "STRATEGY_VERSION_MISMATCH" });

    const second = await ingestTradingViewSignal(db, token, signal);
    expect(second).toEqual(first);
    expect(await db.select().from(signalEvents)).toHaveLength(1);
  });

  it("rejects a symbol mismatch", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    const outcome = await ingestTradingViewSignal(db, token, validSignal(deploymentId, strategyVersionId, { symbol: "COINBASE:BTCUSD" }));
    expect(outcome).toMatchObject({ kind: "REJECTED", reasonCode: "SYMBOL_MISMATCH" });
  });

  it("rejects a timeframe mismatch", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    const outcome = await ingestTradingViewSignal(db, token, validSignal(deploymentId, strategyVersionId, { timeframe: "240" }));
    expect(outcome).toMatchObject({ kind: "REJECTED", reasonCode: "TIMEFRAME_MISMATCH" });
  });

  it("rejects a signal sent outside the deployment's timestamp tolerance", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    const stale = new Date(Date.now() - 3600_000).toISOString();
    const outcome = await ingestTradingViewSignal(db, token, validSignal(deploymentId, strategyVersionId, { sentAt: stale }));
    expect(outcome).toMatchObject({ kind: "REJECTED", reasonCode: "TIMESTAMP_OUT_OF_TOLERANCE" });
  });

  it("derives the same idempotency key the worker-side helper would, from eventId as the order id", async () => {
    const { deploymentId, token, strategyVersionId } = await seedActiveDeployment();
    const signal = validSignal(deploymentId, strategyVersionId);

    const outcome = await ingestTradingViewSignal(db, token, signal);
    if (outcome.kind !== "ACCEPTED") throw new Error("unreachable");

    const [row] = await db.select().from(signalEvents).where(eq(signalEvents.id, outcome.signalEventId));
    const expectedKey = signalIdempotencyKey(
      { deploymentId, strategyVersionId, eventType: "ENTRY_LONG", barTime: signal.barTime },
      signal.eventId,
    );
    expect(row?.idempotencyKey).toBe(expectedKey);
  });
});
