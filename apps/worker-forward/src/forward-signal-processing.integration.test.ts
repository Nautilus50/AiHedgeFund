import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  closeDatabase,
  createTestDatabase,
  forwardDeployments,
  forwardDrawdownPoints,
  forwardEquityPoints,
  isTestDatabaseAvailable,
  metricSnapshots,
  paperFills,
  paperOrders,
  seedOrganisation,
  seedStrategyVersion,
  signalEvents,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { handleForwardSignalProcessing } from "./handlers.js";

const available = await isTestDatabaseAvailable();

function fillModel(overrides: Record<string, unknown> = {}) {
  return {
    fillModelVersion: "1.0.0",
    latencyModel: { type: "fixed_seconds", seconds: 0 },
    slippageModel: { type: "fixed_percent", value: 0 },
    commissionModel: { type: "percent", value: 0 },
    quantityModel: { type: "fixed", quantity: 1 },
    stopTargetRule: { type: "external_alert_only" },
    ...overrides,
  };
}

describe.skipIf(!available)("handleForwardSignalProcessing (integration)", () => {
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

  async function seedDeployment(options: {
    state?: "ACTIVE" | "PAUSED";
    initialCapital?: string;
    fillModelOverrides?: Record<string, unknown>;
  } = {}): Promise<string> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const deploymentId = generateId<string>();

    await db.insert(forwardDeployments).values({
      id: deploymentId,
      organisationId: org.organisationId,
      strategyVersionId: strategy.strategyVersionId,
      createdByUserId: org.userId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: options.initialCapital ?? "10000",
      fillModel: fillModel(options.fillModelOverrides),
      timestampToleranceSeconds: 300,
      deploymentTokenHash: generateId<string>(),
      state: options.state ?? "ACTIVE",
      activatedAt: new Date(),
    });

    return deploymentId;
  }

  async function seedSignal(
    deploymentId: string,
    eventType: "ENTRY_LONG" | "ENTRY_SHORT" | "EXIT_LONG" | "EXIT_SHORT" | "STOP_HIT" | "TARGET_HIT",
    options: { price?: number; direction?: "LONG" | "SHORT" | null } = {},
  ): Promise<string> {
    const signalEventId = generateId<string>();
    const direction =
      options.direction !== undefined
        ? options.direction
        : eventType === "ENTRY_LONG" || eventType === "EXIT_LONG"
          ? "LONG"
          : eventType === "ENTRY_SHORT" || eventType === "EXIT_SHORT"
            ? "SHORT"
            : null;

    await db.insert(signalEvents).values({
      id: signalEventId,
      deploymentId,
      idempotencyKey: generateId<string>(),
      eventType,
      direction,
      rawPayload: {
        schema: "arf.signal.v1",
        deploymentId,
        strategyVersionId: generateId<string>(),
        eventId: signalEventId,
        eventType,
        symbol: "BTCUSD",
        timeframe: "60",
        barTime: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        price: options.price ?? 100,
        quantityModel: "fixed",
      },
      processingStatus: "PENDING",
    });

    return signalEventId;
  }

  it("opens a position on an ENTRY signal, without recomputing curves yet", async () => {
    const deploymentId = await seedDeployment();
    const signalEventId = await seedSignal(deploymentId, "ENTRY_LONG", { price: 100 });

    const result = await handleForwardSignalProcessing(db, { deploymentId, signalEventId });
    expect(result).toEqual({ status: "PROCESSED" });

    const [order] = await db.select().from(paperOrders).where(eq(paperOrders.signalEventId, signalEventId));
    expect(order?.role).toBe("ENTRY");
    expect(order?.direction).toBe("LONG");
    expect(order?.quantity).toBe("1.00000000");
    if (!order) throw new Error("unreachable");

    const [fill] = await db.select().from(paperFills).where(eq(paperFills.paperOrderId, order.id));
    expect(fill?.filledPrice).toBe("100.00000000");

    const [signal] = await db.select().from(signalEvents).where(eq(signalEvents.id, signalEventId));
    expect(signal?.processingStatus).toBe("PROCESSED");

    // No closing fill yet — nothing to recompute.
    expect(await db.select().from(forwardEquityPoints)).toHaveLength(0);
  });

  it("rejects a second entry while one is already open", async () => {
    const deploymentId = await seedDeployment();
    const firstEntry = await seedSignal(deploymentId, "ENTRY_LONG", { price: 100 });
    await handleForwardSignalProcessing(db, { deploymentId, signalEventId: firstEntry });

    const secondEntry = await seedSignal(deploymentId, "ENTRY_LONG", { price: 101 });
    const result = await handleForwardSignalProcessing(db, { deploymentId, signalEventId: secondEntry });

    expect(result).toEqual({ status: "REJECTED", reasonCode: "POSITION_ALREADY_OPEN" });
    expect(await db.select().from(paperOrders)).toHaveLength(1);

    const [signal] = await db.select().from(signalEvents).where(eq(signalEvents.id, secondEntry));
    expect(signal?.processingStatus).toBe("REJECTED");
    expect(signal?.rejectionReason).toBe("POSITION_ALREADY_OPEN");
  });

  it("rejects an exit when nothing is open", async () => {
    const deploymentId = await seedDeployment();
    const signalEventId = await seedSignal(deploymentId, "EXIT_LONG", { price: 100 });

    const result = await handleForwardSignalProcessing(db, { deploymentId, signalEventId });
    expect(result).toEqual({ status: "REJECTED", reasonCode: "NO_OPEN_POSITION" });
    expect(await db.select().from(paperOrders)).toHaveLength(0);
  });

  it("closes a position and recomputes equity/drawdown/metrics with a hand-calculated net P&L", async () => {
    const deploymentId = await seedDeployment({ initialCapital: "10000" });
    const entry = await seedSignal(deploymentId, "ENTRY_LONG", { price: 100 });
    await handleForwardSignalProcessing(db, { deploymentId, signalEventId: entry });

    const exit = await seedSignal(deploymentId, "EXIT_LONG", { price: 110 });
    const result = await handleForwardSignalProcessing(db, { deploymentId, signalEventId: exit });
    expect(result).toEqual({ status: "PROCESSED" });

    // quantity 1, zero fees/slippage: netPnl = (110 - 100) * 1 = 10.
    const equityRows = await db
      .select()
      .from(forwardEquityPoints)
      .where(eq(forwardEquityPoints.deploymentId, deploymentId))
      .orderBy(asc(forwardEquityPoints.sequenceNumber));
    expect(equityRows.map((r) => r.equity)).toEqual(["10000.00000000", "10010.00000000"]);

    const drawdownRows = await db.select().from(forwardDrawdownPoints).where(eq(forwardDrawdownPoints.deploymentId, deploymentId));
    expect(drawdownRows).toHaveLength(2);

    const netProfit = await db
      .select()
      .from(metricSnapshots)
      .where(
        and(
          eq(metricSnapshots.scopeType, "FORWARD_DEPLOYMENT"),
          eq(metricSnapshots.scopeId, deploymentId),
          eq(metricSnapshots.metricName, "net_profit"),
        ),
      );
    expect(Number(netProfit[0]?.value)).toBe(10);
  });

  it("applies slippage and commission from the deployment's declared fill model", async () => {
    const deploymentId = await seedDeployment({
      fillModelOverrides: {
        slippageModel: { type: "fixed_percent", value: 1 },
        commissionModel: { type: "percent", value: 0.5 },
      },
    });
    const entry = await seedSignal(deploymentId, "ENTRY_LONG", { price: 100 });
    await handleForwardSignalProcessing(db, { deploymentId, signalEventId: entry });

    const [order] = await db.select().from(paperOrders).where(eq(paperOrders.signalEventId, entry));
    if (!order) throw new Error("unreachable");
    const [fill] = await db.select().from(paperFills).where(eq(paperFills.paperOrderId, order.id));
    // 1% unfavourable slippage on a LONG entry: pay more, not less.
    expect(Number(fill?.filledPrice)).toBeCloseTo(101, 5);
    // 0.5% commission on filledPrice * quantity (101 * 1).
    expect(Number(fill?.fees)).toBeCloseTo(0.505, 5);
  });

  it("rejects when the deployment is not ACTIVE", async () => {
    const deploymentId = await seedDeployment({ state: "PAUSED" });
    const signalEventId = await seedSignal(deploymentId, "ENTRY_LONG");

    const result = await handleForwardSignalProcessing(db, { deploymentId, signalEventId });
    expect(result).toEqual({ status: "REJECTED", reasonCode: "DEPLOYMENT_NOT_ACTIVE" });
  });

  it("is idempotent — replaying the same signalEventId job twice never duplicates orders, fills, or curve rows", async () => {
    const deploymentId = await seedDeployment();
    const entry = await seedSignal(deploymentId, "ENTRY_LONG", { price: 100 });
    const exit = await seedSignal(deploymentId, "EXIT_LONG", { price: 110 });

    await handleForwardSignalProcessing(db, { deploymentId, signalEventId: entry });
    await handleForwardSignalProcessing(db, { deploymentId, signalEventId: exit });

    // Simulate a BullMQ redelivery of the same two jobs.
    const replayEntry = await handleForwardSignalProcessing(db, { deploymentId, signalEventId: entry });
    const replayExit = await handleForwardSignalProcessing(db, { deploymentId, signalEventId: exit });

    expect(replayEntry).toEqual({ status: "ALREADY_PROCESSED" });
    expect(replayExit).toEqual({ status: "ALREADY_PROCESSED" });

    expect(await db.select().from(paperOrders)).toHaveLength(2);
    expect(await db.select().from(paperFills)).toHaveLength(2);
    expect(await db.select().from(forwardEquityPoints).where(eq(forwardEquityPoints.deploymentId, deploymentId))).toHaveLength(2);
  });

  it("refuses an unknown signal event", async () => {
    const deploymentId = await seedDeployment();
    await expect(
      handleForwardSignalProcessing(db, { deploymentId, signalEventId: generateId<string>() }),
    ).rejects.toThrow(/not found/);
  });
});
