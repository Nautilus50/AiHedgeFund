import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  closeDatabase,
  createTestDatabase,
  datasetVersions,
  isTestDatabaseAvailable,
  seedOrganisation,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { findMatchingDatasetVersion, listDatasetVersions } from "./datasets.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("listDatasetVersions (integration)", () => {
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

  async function seedDataset(organisationId: string, overrides: Partial<{ symbol: string; timeframe: string }> = {}) {
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId,
      objectKey: `test/${datasetVersionId}.csv`,
      contentType: "text/csv",
      sizeBytes: 10,
      checksumSha256: "deadbeef",
      kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId,
      symbol: overrides.symbol ?? "BTCUSD",
      timeframe: overrides.timeframe ?? "1h",
      fromTs: new Date("2024-01-01T00:00:00Z"),
      toTs: new Date("2024-01-02T00:00:00Z"),
      barCount: 24,
      checksumSha256: "deadbeef",
      artefactId,
    });
    return datasetVersionId;
  }

  it("lists only the caller's organisation's dataset versions", async () => {
    const orgA = await seedOrganisation(db, { slug: "datasets-org-a" });
    const orgB = await seedOrganisation(db, { slug: "datasets-org-b" });

    const ownId = await seedDataset(orgA.organisationId, { symbol: "BTCUSD" });
    await seedDataset(orgB.organisationId, { symbol: "ETHUSD" });

    const result = await listDatasetVersions(db, orgA.organisationId, {});
    if (!result.ok) throw new Error("expected ok result");

    expect(result.page.items).toHaveLength(1);
    expect(result.page.items[0]?.id).toBe(ownId);
    expect(result.page.items[0]?.symbol).toBe("BTCUSD");
    expect(result.page.items[0]?.barCount).toBe(24);
  });

  it("paginates with a cursor rather than returning everything at once", async () => {
    const org = await seedOrganisation(db);
    for (let i = 0; i < 3; i++) {
      await seedDataset(org.organisationId, { symbol: `SYM${i}` });
    }

    const firstPage = await listDatasetVersions(db, org.organisationId, { limit: 2 });
    if (!firstPage.ok) throw new Error("expected ok result");
    expect(firstPage.page.items).toHaveLength(2);
    expect(firstPage.page.nextCursor).toBeDefined();

    const secondPage = await listDatasetVersions(db, org.organisationId, {
      limit: 2,
      cursor: firstPage.page.nextCursor,
    });
    if (!secondPage.ok) throw new Error("expected ok result");
    expect(secondPage.page.items).toHaveLength(1);
    expect(secondPage.page.nextCursor).toBeUndefined();
  });

  it("rejects a malformed cursor rather than silently ignoring it", async () => {
    const org = await seedOrganisation(db);
    const result = await listDatasetVersions(db, org.organisationId, { cursor: "not-a-real-cursor" });
    expect(result).toEqual({ ok: false, reasonCode: "INVALID_CURSOR" });
  });
});

describe.skipIf(!available)("findMatchingDatasetVersion (integration)", () => {
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

  const FROM = new Date("2024-01-01T00:00:00Z");
  const TO = new Date("2024-01-02T00:00:00Z");

  async function seed(organisationId: string, overrides: Partial<{ symbol: string; timeframe: string; fromTs: Date; toTs: Date }> = {}) {
    const artefactId = generateId<string>();
    const datasetVersionId = generateId<string>();
    await db.insert(artefacts).values({
      id: artefactId,
      organisationId,
      objectKey: `test/${datasetVersionId}.csv`,
      contentType: "text/csv",
      sizeBytes: 10,
      checksumSha256: "deadbeef",
      kind: "ohlcv_dataset",
    });
    await db.insert(datasetVersions).values({
      id: datasetVersionId,
      organisationId,
      symbol: overrides.symbol ?? "BTCUSDT",
      timeframe: overrides.timeframe ?? "1h",
      fromTs: overrides.fromTs ?? FROM,
      toTs: overrides.toTs ?? TO,
      barCount: 24,
      checksumSha256: "deadbeef",
      artefactId,
    });
    return datasetVersionId;
  }

  it("finds an existing dataset version with the exact same symbol/timeframe/range", async () => {
    const org = await seedOrganisation(db);
    const existingId = await seed(org.organisationId);

    const match = await findMatchingDatasetVersion(db, org.organisationId, "BTCUSDT", "1h", FROM, TO);
    expect(match).toEqual({ datasetVersionId: existingId });
  });

  it("does not match a different date range for the same symbol/timeframe", async () => {
    const org = await seedOrganisation(db);
    await seed(org.organisationId);

    const match = await findMatchingDatasetVersion(
      db,
      org.organisationId,
      "BTCUSDT",
      "1h",
      new Date("2024-02-01T00:00:00Z"),
      new Date("2024-02-02T00:00:00Z"),
    );
    expect(match).toBeUndefined();
  });

  it("does not match another organisation's identical dataset", async () => {
    const orgA = await seedOrganisation(db, { slug: "match-org-a" });
    const orgB = await seedOrganisation(db, { slug: "match-org-b" });
    await seed(orgA.organisationId);

    const match = await findMatchingDatasetVersion(db, orgB.organisationId, "BTCUSDT", "1h", FROM, TO);
    expect(match).toBeUndefined();
  });
});
