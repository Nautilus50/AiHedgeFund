import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  algos,
  auditEvents,
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  seedOrganisation,
  seedPineRevision,
  seedStrategyVersion,
  trades,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { generateId } from "@arf-os/contracts";
import { getAlgoDetail, listAlgos } from "./catalogue.js";
import { getAlgoSource } from "./delivery.js";
import { createAlgo, publishAlgo, publishRelease, publishStatSnapshot, retireAlgo } from "./publishing.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("algo library (integration)", () => {
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

  /** seedOrganisation derives its default slug from a UUIDv7 prefix, which two orgs share within a millisecond. */
  function uniqueOrg() {
    return seedOrganisation(db, { slug: `org-${generateId<string>().slice(24)}` });
  }

  /** Catalogues a fully published algo with evidence, the way an operator would. */
  async function catalogueAlgo(
    options: { slug?: string; into?: Awaited<ReturnType<typeof uniqueOrg>> } = {},
  ) {
    const org = options.into ?? (await uniqueOrg());
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const revision = await seedPineRevision(db, strategy.strategyVersionId);

    const algo = await createAlgo(db, {
      organisationId: org.organisationId,
      slug: options.slug ?? "momentum-btc",
      name: "Momentum BTC",
      tagline: "Trend continuation on BTC 1h.",
      description: "A long-only momentum system.",
      riskNote: "Simulated results. Past performance does not predict future results.",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!algo.ok) throw new Error(`algo not created: ${algo.message}`);

    const release = await publishRelease(db, {
      algoId: algo.algoId,
      organisationId: org.organisationId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "First release.",
      setupInstructions: "Paste into TradingView and set the alert webhook.",
      actorUserId: org.userId,
    });
    if (!release.ok) throw new Error(`release not published: ${release.message}`);

    const backtestRunId = await seedSucceededRun(strategy.strategyVersionId);
    const stats = await publishStatSnapshot(db, {
      releaseId: release.releaseId,
      organisationId: org.organisationId,
      backtestRunId,
      scope: "OUT_OF_SAMPLE",
      actorUserId: org.userId,
    });
    if (!stats.ok) throw new Error(`stats not catalogued: ${stats.message}`);

    const published = await publishAlgo(db, {
      algoId: algo.algoId,
      organisationId: org.organisationId,
      actorUserId: org.userId,
    });
    if (!published.ok) throw new Error(`algo not published: ${published.message}`);

    return { org, strategy, revision, algoId: algo.algoId, releaseId: release.releaseId, backtestRunId };
  }

  async function seedSucceededRun(strategyVersionId: string): Promise<string> {
    const backtestRunId = generateId<string>();
    await db.insert(backtestRuns).values({
      id: backtestRunId,
      strategyVersionId,
      runnerType: "LOCAL_RUNNER",
      runnerVersion: "1.0.0",
      symbol: "BTCUSD",
      timeframe: "60",
      segmentKind: "VALIDATION",
      fromTs: new Date("2025-01-01T00:00:00.000Z"),
      toTs: new Date("2025-06-30T00:00:00.000Z"),
      costModel: { commissionPct: 0.05, slippageTicks: 1 },
      initialCapital: "10000",
      status: "SUCCEEDED",
      sourceHash: "source-hash",
    });

    await db.insert(trades).values([
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 1,
        direction: "LONG",
        entryTime: new Date("2025-01-05T00:00:00.000Z"),
        exitTime: new Date("2025-01-06T00:00:00.000Z"),
        entryPrice: "100",
        exitPrice: "110",
        quantity: "1",
        grossPnl: "10",
        fees: "1",
        netPnl: "900",
      },
      {
        id: generateId<string>(),
        backtestRunId,
        sequenceNumber: 2,
        direction: "LONG",
        entryTime: new Date("2025-02-05T00:00:00.000Z"),
        exitTime: new Date("2025-02-06T00:00:00.000Z"),
        entryPrice: "110",
        exitPrice: "105",
        quantity: "1",
        grossPnl: "-5",
        fees: "1",
        netPnl: "-300",
      },
    ]);

    return backtestRunId;
  }

  it("catalogues an algo with evidence recomputed from its trade ledger", async () => {
    const { org } = await catalogueAlgo();

    const items = await listAlgos(db, org.organisationId, { status: "PUBLISHED" });
    expect(items).toHaveLength(1);
    // Net profit of 600 on 10,000 initial capital — recomputed here, not read
    // from any runner-reported summary.
    expect(items[0]?.headline).toMatchObject({ scope: "OUT_OF_SAMPLE", netProfitPct: 6, tradeCount: 2 });

    const detail = await getAlgoDetail(db, org.organisationId, "momentum-btc");
    expect(detail?.currentRelease).toMatchObject({ releaseNumber: 1 });
    expect(detail?.snapshots).toHaveLength(1);
    expect(detail?.snapshots[0]?.monthlyReturns.map((entry) => entry.month)).toEqual(["2025-01", "2025-02"]);
    expect(detail?.snapshots[0]?.costsApplied).toBe(true);
    // The catalogue payload carries the hash, never the source itself.
    expect(JSON.stringify(detail)).not.toContain("@version=6");
  });

  it("refuses a release from a strategy version that is not PAPER_APPROVED", async () => {
    const org = await uniqueOrg();
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });
    await seedPineRevision(db, strategy.strategyVersionId);

    const algo = await createAlgo(db, {
      organisationId: org.organisationId,
      slug: "unvalidated",
      name: "Unvalidated",
      tagline: "",
      description: "",
      riskNote: "",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!algo.ok) throw new Error("algo not created");

    const release = await publishRelease(db, {
      algoId: algo.algoId,
      organisationId: org.organisationId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "",
      setupInstructions: "",
      actorUserId: org.userId,
    });

    expect(release).toMatchObject({ ok: false, reasonCode: "NOT_PAPER_APPROVED" });
  });

  it("refuses to publish an algo with no evidence snapshot", async () => {
    const org = await uniqueOrg();
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    await seedPineRevision(db, strategy.strategyVersionId);

    const algo = await createAlgo(db, {
      organisationId: org.organisationId,
      slug: "no-evidence",
      name: "No evidence",
      tagline: "",
      description: "",
      riskNote: "",
      marketCategory: "CRYPTO",
      symbol: "BTCUSD",
      timeframe: "60",
    });
    if (!algo.ok) throw new Error("algo not created");

    await publishRelease(db, {
      algoId: algo.algoId,
      organisationId: org.organisationId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "",
      setupInstructions: "",
      actorUserId: org.userId,
    });

    const outcome = await publishAlgo(db, {
      algoId: algo.algoId,
      organisationId: org.organisationId,
      actorUserId: org.userId,
    });
    expect(outcome).toMatchObject({ ok: false, reasonCode: "NO_PUBLISHED_EVIDENCE" });

    const [row] = await db.select({ status: algos.status }).from(algos).where(eq(algos.id, algo.algoId));
    expect(row?.status).toBe("DRAFT");
  });

  it("refuses evidence from a run that belongs to a different strategy version", async () => {
    const { org, releaseId } = await catalogueAlgo();
    const otherStrategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const foreignRunId = await seedSucceededRun(otherStrategy.strategyVersionId);

    const outcome = await publishStatSnapshot(db, {
      releaseId,
      organisationId: org.organisationId,
      backtestRunId: foreignRunId,
      scope: "IN_SAMPLE",
      actorUserId: org.userId,
    });

    expect(outcome).toMatchObject({ ok: false, reasonCode: "RUN_VERSION_MISMATCH" });
  });

  it("never returns another organisation's algo", async () => {
    const first = await catalogueAlgo({ slug: "algo-one" });
    const stranger = await uniqueOrg();

    expect(await listAlgos(db, stranger.organisationId)).toEqual([]);
    expect(await getAlgoDetail(db, stranger.organisationId, "algo-one")).toBeNull();

    const denied = await getAlgoSource(db, {
      organisationId: stranger.organisationId,
      actorUserId: stranger.userId,
      slug: "algo-one",
    });
    expect(denied).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
    expect(first.algoId).toBeTruthy();
  });

  it("returns the exact tested revision as source, and records the read", async () => {
    const { org, revision } = await catalogueAlgo();

    const delivered = await getAlgoSource(db, {
      organisationId: org.organisationId,
      actorUserId: org.userId,
      slug: "momentum-btc",
      traceId: "trace-1",
    });

    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.delivery.pineSource).toBe(revision.source);
    expect(delivered.delivery.pineSourceHash).toBe(revision.sourceHash);

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.action, "ALGO_SOURCE_READ"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(`user:${org.userId}`);
    // The audit trail records the hash, never a second copy of the source.
    expect(JSON.stringify(audits[0]?.newStateSummary)).not.toContain("@version=6");
  });

  it("supersedes the previous release when a new version is published", async () => {
    const { org, algoId, revision } = await catalogueAlgo();

    const second = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVED" });
    const secondRevision = await seedPineRevision(db, second.strategyVersionId, {
      source: "//@version=6\nstrategy(\"Second revision\")",
      sourceHash: "hash-second",
    });

    const release = await publishRelease(db, {
      algoId,
      organisationId: org.organisationId,
      strategyVersionId: second.strategyVersionId,
      changelog: "Tightened the stop.",
      setupInstructions: "Same as before.",
      actorUserId: org.userId,
    });
    expect(release).toMatchObject({ ok: true, releaseNumber: 2 });

    const detail = await getAlgoDetail(db, org.organisationId, "momentum-btc");
    expect(detail?.currentRelease).toMatchObject({ releaseNumber: 2, pineSourceHash: secondRevision.sourceHash });

    const delivered = await getAlgoSource(db, {
      organisationId: org.organisationId,
      actorUserId: org.userId,
      slug: "momentum-btc",
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.delivery.pineSource).toBe(secondRevision.source);
    expect(delivered.delivery.pineSource).not.toBe(revision.source);
  });

  it("re-releasing the same strategy version is idempotent", async () => {
    const { org, algoId, strategy } = await catalogueAlgo();

    const again = await publishRelease(db, {
      algoId,
      organisationId: org.organisationId,
      strategyVersionId: strategy.strategyVersionId,
      changelog: "Retried command.",
      setupInstructions: "",
      actorUserId: org.userId,
    });

    expect(again).toMatchObject({ ok: true, releaseNumber: 1 });
    const detail = await getAlgoDetail(db, org.organisationId, "momentum-btc");
    expect(detail?.currentRelease?.releaseNumber).toBe(1);
  });

  it("retiring an algo hides it from the active library but keeps its evidence readable", async () => {
    const { org, algoId } = await catalogueAlgo();

    expect(await retireAlgo(db, { algoId, organisationId: org.organisationId, actorUserId: org.userId })).toMatchObject({
      ok: true,
    });

    expect(await listAlgos(db, org.organisationId, { status: "PUBLISHED" })).toEqual([]);

    const detail = await getAlgoDetail(db, org.organisationId, "momentum-btc");
    expect(detail?.status).toBe("RETIRED");
    expect(detail?.snapshots).toHaveLength(1);
  });

  it("rejects a duplicate slug within one library", async () => {
    const { org } = await catalogueAlgo();

    const duplicate = await createAlgo(db, {
      organisationId: org.organisationId,
      slug: "momentum-btc",
      name: "Another one",
      tagline: "",
      description: "",
      riskNote: "",
      marketCategory: "CRYPTO",
      symbol: "ETHUSD",
      timeframe: "60",
    });

    expect(duplicate).toMatchObject({ ok: false, reasonCode: "SLUG_TAKEN" });
  });
});
