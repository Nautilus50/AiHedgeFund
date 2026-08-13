import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  closeDatabase,
  createTestDatabase,
  forwardDeployments,
  forwardDrawdownPoints,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedStrategyVersion,
  signalEvents,
  strategyVersions,
  truncateAll,
  type Database,
} from "@arf-os/db";
import {
  completeForwardDeployment,
  createForwardDeployment,
  getForwardDeployment,
  getForwardDeploymentHealth,
  pauseForwardDeployment,
  resumeForwardDeployment,
} from "./forward-deployments.js";

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

describe.skipIf(!available)("forward deployments (integration)", () => {
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

  it("refuses a deployment for a strategy version that isn't PAPER_APPROVED", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "TRADINGVIEW_VERIFICATION" });

    const result = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });

    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_PAPER_APPROVED" });
  });

  it("creates an ACTIVE deployment for a PAPER_APPROVED version, persisting only the token's hash", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });

    const result = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BYBIT:BTCUSDT.P",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.length).toBeGreaterThan(20);

    const [row] = await db.select().from(forwardDeployments).where(eq(forwardDeployments.id, result.deploymentId));
    expect(row?.state).toBe("ACTIVE");
    expect(row?.deploymentTokenHash).not.toBe(result.token);
    expect(row?.activatedAt).not.toBeNull();
  });

  it("never returns another organisation's deployment", async () => {
    const orgA = await seedOrganisation(db, { slug: "forward-org-a" });
    const orgB = await seedOrganisation(db, { slug: "forward-org-b" });
    const strategy = await seedStrategyVersion(db, orgA, { workflowState: "PAPER_APPROVED" });

    const created = await createForwardDeployment(db, orgA.organisationId, orgA.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");

    expect(await getForwardDeployment(db, orgB.organisationId, created.deploymentId)).toBeUndefined();
    expect(await getForwardDeployment(db, orgA.organisationId, created.deploymentId)).toBeDefined();
  });

  it("flags when a newer PAPER_APPROVED sibling version exists (CLAUDE.md 3.4)", async () => {
    const org = await seedOrganisation(db);
    const v1 = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });

    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: v1.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");

    const before = await getForwardDeployment(db, org.organisationId, created.deploymentId);
    expect(before?.newerApprovedVersionExists).toBe(false);

    // A second, newer PAPER_APPROVED version of the SAME strategy.
    await db.insert(strategyVersions).values({
      id: generateId<string>(),
      strategyId: v1.strategyId,
      parentVersionId: v1.strategyVersionId,
      versionNumber: 2,
      workflowState: "PAPER_APPROVED",
    });

    const after = await getForwardDeployment(db, org.organisationId, created.deploymentId);
    expect(after?.newerApprovedVersionExists).toBe(true);
  });

  async function seedActiveDeployment(): Promise<{ organisationId: string; deploymentId: string }> {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
    });
    if (!created.ok) throw new Error("unreachable");
    return { organisationId: org.organisationId, deploymentId: created.deploymentId };
  }

  it("pauses an ACTIVE deployment, resumes it, then completes it", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const paused = await pauseForwardDeployment(db, organisationId, deploymentId);
    expect(paused.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("PAUSED");

    const resumed = await resumeForwardDeployment(db, organisationId, deploymentId);
    expect(resumed.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("ACTIVE");

    const completed = await completeForwardDeployment(db, organisationId, deploymentId);
    expect(completed.ok).toBe(true);
    expect((await getForwardDeployment(db, organisationId, deploymentId))?.state).toBe("COMPLETED");
  });

  it("refuses to pause a deployment that is not ACTIVE", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();
    await pauseForwardDeployment(db, organisationId, deploymentId);

    const result = await pauseForwardDeployment(db, organisationId, deploymentId);
    expect(result).toMatchObject({ ok: false, reasonCode: "INVALID_STATE" });
  });

  it("refuses a transition on an unknown deployment", async () => {
    const org = await seedOrganisation(db);
    const result = await pauseForwardDeployment(db, org.organisationId, generateId<string>());
    expect(result).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
  });

  it("computes health as HEALTHY with no signals yet, and NOT_CONFIGURED for strategy performance without a threshold", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    const health = await getForwardDeploymentHealth(db, organisationId, deploymentId);
    expect(health).toEqual({
      deploymentState: "ACTIVE",
      infrastructureHealth: "HEALTHY",
      infrastructureReasons: [],
      strategyPerformanceHealth: "NOT_CONFIGURED",
    });
  });

  it("flags infrastructureHealth DEGRADED when most recent signals were rejected", async () => {
    const { organisationId, deploymentId } = await seedActiveDeployment();

    for (let i = 0; i < 3; i++) {
      await db.insert(signalEvents).values({
        id: generateId<string>(),
        deploymentId,
        idempotencyKey: generateId<string>(),
        eventType: "ENTRY_LONG",
        direction: "LONG",
        rawPayload: {},
        processingStatus: "REJECTED",
        rejectionReason: "SYMBOL_MISMATCH",
      });
    }
    await db.insert(signalEvents).values({
      id: generateId<string>(),
      deploymentId,
      idempotencyKey: generateId<string>(),
      eventType: "ENTRY_LONG",
      direction: "LONG",
      rawPayload: {},
      processingStatus: "PROCESSED",
    });

    const health = await getForwardDeploymentHealth(db, organisationId, deploymentId);
    expect(health?.infrastructureHealth).toBe("DEGRADED");
    expect(health?.infrastructureReasons).toContain("SYMBOL_MISMATCH");
  });

  it("flags strategyPerformanceHealth DRAWDOWN_ALERT once realised drawdown crosses the configured threshold", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const created = await createForwardDeployment(db, org.organisationId, org.userId, {
      strategyVersionId: strategy.strategyVersionId,
      symbol: "BTCUSD",
      timeframe: "60",
      initialCapital: 10000,
      timestampToleranceSeconds: 300,
      fillModel: fillModel(),
      maxDrawdownPctAlertThreshold: 5,
    });
    if (!created.ok) throw new Error("unreachable");

    await db.insert(forwardDrawdownPoints).values({
      id: generateId<string>(),
      deploymentId: created.deploymentId,
      sequenceNumber: 1,
      barTime: new Date(),
      drawdown: "1000",
      drawdownPct: "10",
    });

    const health = await getForwardDeploymentHealth(db, org.organisationId, created.deploymentId);
    expect(health?.strategyPerformanceHealth).toBe("DRAWDOWN_ALERT");
  });
});
