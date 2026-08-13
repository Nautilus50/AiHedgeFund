import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  isTestDatabaseAvailable,
  parityReports,
  seedOrganisation,
  strategies,
  strategyDefinitions,
  strategyVersions,
  tradingviewVerifications,
  truncateAll,
  type Database,
  type SeededOrganisation,
} from "@arf-os/db";
import { listStrategies } from "./strategy-registry.js";

const available = await isTestDatabaseAvailable();

type WorkflowState =
  | "CAMPAIGN_BACKLOG"
  | "IDEA_RESEARCH"
  | "HYPOTHESIS_DRAFT"
  | "PINE_DEVELOPMENT"
  | "TRADINGVIEW_VERIFICATION"
  | "PAPER_APPROVAL_REVIEW"
  | "PAPER_APPROVED"
  | "REJECTED"
  | "BLOCKED";

type ParityStatus = "PASS" | "WARN" | "FAIL" | "INSUFFICIENT_DATA";

describe.skipIf(!available)("listStrategies filters (integration)", () => {
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

  async function seedStrategy(
    org: SeededOrganisation,
    input: {
      name: string;
      workflowState: WorkflowState;
      market?: { symbols: string[]; timeframe: string };
      parityStatus?: ParityStatus;
    },
  ): Promise<string> {
    const strategyId = generateId<string>();
    const strategyVersionId = generateId<string>();

    await db.insert(strategies).values({
      id: strategyId,
      organisationId: org.organisationId,
      campaignId: org.campaignId,
      name: input.name,
    });

    await db.insert(strategyVersions).values({
      id: strategyVersionId,
      strategyId,
      parentVersionId: null,
      versionNumber: 1,
      workflowState: input.workflowState,
    });

    if (input.market) {
      await db.insert(strategyDefinitions).values({
        id: generateId<string>(),
        strategyVersionId,
        definition: { market: { symbols: input.market.symbols, timeframe: input.market.timeframe } },
        definitionHash: `hash-${strategyVersionId}`,
      });
    }

    if (input.parityStatus) {
      const verificationId = generateId<string>();
      await db.insert(tradingviewVerifications).values({
        id: verificationId,
        strategyVersionId,
        requiredSymbol: input.market?.symbols[0] ?? "BTCUSD",
        requiredTimeframe: input.market?.timeframe ?? "1h",
        requestedByUserId: org.userId,
      });

      const backtestRunId = generateId<string>();
      await db.insert(backtestRuns).values({
        id: backtestRunId,
        strategyVersionId,
        runnerType: "TRADINGVIEW",
        runnerVersion: "n/a",
        verificationId,
        symbol: input.market?.symbols[0] ?? "BTCUSD",
        timeframe: input.market?.timeframe ?? "1h",
        segmentKind: "IN_SAMPLE",
        fromTs: new Date("2024-01-01T00:00:00Z"),
        toTs: new Date("2024-01-02T00:00:00Z"),
        costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
        initialCapital: "10000",
        sourceHash: "hash",
      });

      await db.insert(parityReports).values({
        id: generateId<string>(),
        backtestRunId,
        verificationId,
        status: input.parityStatus,
        comparison: {},
      });
    }

    return strategyId;
  }

  it("filters by the strategy's latest version workflow state", async () => {
    const org = await seedOrganisation(db, { slug: "filters-state" });
    const matching = await seedStrategy(org, { name: "Matches", workflowState: "PINE_DEVELOPMENT" });
    await seedStrategy(org, { name: "Does not match", workflowState: "CAMPAIGN_BACKLOG" });

    const result = await listStrategies(db, org.organisationId, { workflowState: "PINE_DEVELOPMENT" });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items.map((s) => s.id)).toEqual([matching]);
  });

  it("filters by SDL market symbol via JSONB containment", async () => {
    const org = await seedOrganisation(db, { slug: "filters-symbol" });
    const matching = await seedStrategy(org, {
      name: "BTC strategy",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
    });
    await seedStrategy(org, {
      name: "ETH strategy",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["ETHUSD"], timeframe: "1h" },
    });
    await seedStrategy(org, { name: "No SDL", workflowState: "PINE_DEVELOPMENT" });

    const result = await listStrategies(db, org.organisationId, { symbol: "BTCUSD" });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items.map((s) => s.id)).toEqual([matching]);
  });

  it("filters by SDL market timeframe", async () => {
    const org = await seedOrganisation(db, { slug: "filters-timeframe" });
    await seedStrategy(org, {
      name: "1h strategy",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
    });
    const matching = await seedStrategy(org, {
      name: "4h strategy",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "4h" },
    });

    const result = await listStrategies(db, org.organisationId, { timeframe: "4h" });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items.map((s) => s.id)).toEqual([matching]);
  });

  it("filters by parity status across any run of any version", async () => {
    const org = await seedOrganisation(db, { slug: "filters-parity" });
    const matching = await seedStrategy(org, {
      name: "Passing",
      workflowState: "TRADINGVIEW_VERIFICATION",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
      parityStatus: "PASS",
    });
    await seedStrategy(org, {
      name: "No parity yet",
      workflowState: "TRADINGVIEW_VERIFICATION",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
    });

    const result = await listStrategies(db, org.organisationId, { parityStatus: "PASS" });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items.map((s) => s.id)).toEqual([matching]);
  });

  it("combines multiple filters with AND, not OR", async () => {
    const org = await seedOrganisation(db, { slug: "filters-combo" });
    const matching = await seedStrategy(org, {
      name: "Matches both",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
    });
    await seedStrategy(org, {
      name: "Right state, wrong symbol",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["ETHUSD"], timeframe: "1h" },
    });
    await seedStrategy(org, {
      name: "Right symbol, wrong state",
      workflowState: "CAMPAIGN_BACKLOG",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
    });

    const result = await listStrategies(db, org.organisationId, {
      workflowState: "PINE_DEVELOPMENT",
      symbol: "BTCUSD",
    });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items.map((s) => s.id)).toEqual([matching]);
  });

  it("never matches another organisation's strategies through any filter", async () => {
    const orgA = await seedOrganisation(db, { slug: "filters-iso-a" });
    const orgB = await seedOrganisation(db, { slug: "filters-iso-b" });

    await seedStrategy(orgA, {
      name: "Org A strategy",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
      parityStatus: "PASS",
    });
    await seedStrategy(orgB, {
      name: "Org B strategy — identical shape",
      workflowState: "PINE_DEVELOPMENT",
      market: { symbols: ["BTCUSD"], timeframe: "1h" },
      parityStatus: "PASS",
    });

    const result = await listStrategies(db, orgA.organisationId, {
      workflowState: "PINE_DEVELOPMENT",
      symbol: "BTCUSD",
      timeframe: "1h",
      parityStatus: "PASS",
    });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items).toHaveLength(1);
    expect(result.page.items[0]?.name).toBe("Org A strategy");
  });

  it("returns an empty page, not an error, when a filter matches nothing", async () => {
    const org = await seedOrganisation(db, { slug: "filters-empty" });
    await seedStrategy(org, { name: "Irrelevant", workflowState: "PINE_DEVELOPMENT" });

    const result = await listStrategies(db, org.organisationId, { workflowState: "PAPER_APPROVED" });
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items).toEqual([]);
    expect(result.page.nextCursor).toBeUndefined();
  });

  /**
   * Regression test for the cursor-pagination precision bug (see
   * packages/db/src/schema/strategy.ts's `strategies.created_at` comment,
   * and its sibling fix for dataset_versions.created_at): without
   * `precision: 3` on the column, a row whose real timestamp has nonzero
   * sub-millisecond digits spuriously re-matches its own
   * millisecond-truncated cursor on the next page. Walks every page rather
   * than checking one page's shape, so a duplicated or skipped row anywhere
   * in the sequence is caught.
   */
  it("never duplicates or skips a strategy across a full pagination walk", async () => {
    const org = await seedOrganisation(db, { slug: "filters-pagination-walk" });
    const created: string[] = [];
    for (let i = 0; i < 11; i++) {
      created.push(await seedStrategy(org, { name: `Strategy ${i}`, workflowState: "PINE_DEVELOPMENT" }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await listStrategies(db, org.organisationId, { cursor, limit: 3 });
      if (!result.ok) throw new Error("expected ok result");
      seen.push(...result.page.items.map((s) => s.id));
      if (!result.page.nextCursor) break;
      cursor = result.page.nextCursor;
    }

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect(new Set(seen)).toEqual(new Set(created));
  });
});
