import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  artefacts,
  closeDatabase,
  committeeDecisions,
  createTestDatabase,
  isTestDatabaseAvailable,
  reportUploads,
  seedOrganisation,
  seedStrategyVersion,
  tradingviewVerifications,
  truncateAll,
  type Database,
  type SeededOrganisation,
} from "@arf-os/db";
import { getPendingVerificationsCount, listParseFailures, listRecentDecisions } from "./operations.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("operations (integration)", () => {
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

  async function seedVerification(
    org: SeededOrganisation,
    status: "PENDING" | "UPLOADED" | "PARSED" | "PASSED" | "FAILED" | "INVESTIGATION_REQUIRED",
  ): Promise<{ verificationId: string; strategyVersionId: string }> {
    const strategy = await seedStrategyVersion(db, org, { workflowState: "TRADINGVIEW_VERIFICATION" });
    const verificationId = generateId<string>();
    await db.insert(tradingviewVerifications).values({
      id: verificationId,
      strategyVersionId: strategy.strategyVersionId,
      status,
      requiredSymbol: "BTCUSD",
      requiredTimeframe: "1h",
      requestedByUserId: org.userId,
    });
    return { verificationId, strategyVersionId: strategy.strategyVersionId };
  }

  describe("getPendingVerificationsCount", () => {
    it("counts only PENDING and UPLOADED, never a terminal status", async () => {
      const org = await seedOrganisation(db, { slug: "ops-pending" });
      await seedVerification(org, "PENDING");
      await seedVerification(org, "UPLOADED");
      await seedVerification(org, "PASSED");
      await seedVerification(org, "FAILED");

      expect(await getPendingVerificationsCount(db, org.organisationId)).toBe(2);
    });

    it("never counts another organisation's verifications", async () => {
      const orgA = await seedOrganisation(db, { slug: "ops-pending-a" });
      const orgB = await seedOrganisation(db, { slug: "ops-pending-b" });
      await seedVerification(orgB, "PENDING");

      expect(await getPendingVerificationsCount(db, orgA.organisationId)).toBe(0);
    });
  });

  describe("listRecentDecisions", () => {
    it("returns decisions newest first, with the strategy name attached", async () => {
      const org = await seedOrganisation(db, { slug: "ops-decisions" });
      const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVAL_REVIEW" });

      const older = generateId<string>();
      await db.insert(committeeDecisions).values({
        id: older,
        strategyVersionId: strategy.strategyVersionId,
        decision: "REJECT",
        reasonCodes: ["insufficient_evidence"],
        positiveCase: "p",
        rejectionCase: "r",
        actorId: org.userId,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      });
      const newer = generateId<string>();
      await db.insert(committeeDecisions).values({
        id: newer,
        strategyVersionId: strategy.strategyVersionId,
        decision: "PAPER_APPROVED",
        reasonCodes: [],
        positiveCase: "p",
        rejectionCase: "r",
        actorId: org.userId,
        createdAt: new Date("2024-06-01T00:00:00Z"),
      });

      const decisions = await listRecentDecisions(db, org.organisationId, 10);
      expect(decisions.map((d) => d.id)).toEqual([newer, older]);
      expect(decisions[0]?.strategyName).toBe("Integration test strategy");
      expect(decisions[0]?.decision).toBe("PAPER_APPROVED");
    });

    it("respects the limit", async () => {
      const org = await seedOrganisation(db, { slug: "ops-decisions-limit" });
      const strategy = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVAL_REVIEW" });
      for (let i = 0; i < 5; i++) {
        await db.insert(committeeDecisions).values({
          id: generateId<string>(),
          strategyVersionId: strategy.strategyVersionId,
          decision: "REJECT",
          reasonCodes: [],
          positiveCase: "p",
          rejectionCase: "r",
          actorId: org.userId,
        });
      }

      expect(await listRecentDecisions(db, org.organisationId, 3)).toHaveLength(3);
    });

    it("never returns another organisation's decisions", async () => {
      const orgA = await seedOrganisation(db, { slug: "ops-decisions-a" });
      const orgB = await seedOrganisation(db, { slug: "ops-decisions-b" });
      const strategyB = await seedStrategyVersion(db, orgB, { workflowState: "PAPER_APPROVAL_REVIEW" });
      await db.insert(committeeDecisions).values({
        id: generateId<string>(),
        strategyVersionId: strategyB.strategyVersionId,
        decision: "REJECT",
        reasonCodes: [],
        positiveCase: "p",
        rejectionCase: "r",
        actorId: orgB.userId,
      });

      expect(await listRecentDecisions(db, orgA.organisationId, 10)).toEqual([]);
    });
  });

  describe("listParseFailures", () => {
    async function seedFailedUpload(org: SeededOrganisation): Promise<string> {
      const { verificationId } = await seedVerification(org, "UPLOADED");
      const artefactId = generateId<string>();
      await db.insert(artefacts).values({
        id: artefactId,
        organisationId: org.organisationId,
        objectKey: `test/${artefactId}.csv`,
        contentType: "text/csv",
        sizeBytes: 10,
        checksumSha256: "deadbeef",
        kind: "tradingview_list_of_trades",
      });
      const uploadId = generateId<string>();
      await db.insert(reportUploads).values({
        id: uploadId,
        verificationId,
        kind: "LIST_OF_TRADES",
        rawArtefactId: artefactId,
        parseStatus: "FAILED",
        uploadedByUserId: org.userId,
      });
      return uploadId;
    }

    it("lists only FAILED parses, scoped to the caller's organisation", async () => {
      const org = await seedOrganisation(db, { slug: "ops-parse" });
      const failed = await seedFailedUpload(org);

      const failures = await listParseFailures(db, org.organisationId, 10);
      expect(failures.map((f) => f.id)).toEqual([failed]);
    });

    it("never returns another organisation's parse failures", async () => {
      const orgA = await seedOrganisation(db, { slug: "ops-parse-a" });
      const orgB = await seedOrganisation(db, { slug: "ops-parse-b" });
      await seedFailedUpload(orgB);

      expect(await listParseFailures(db, orgA.organisationId, 10)).toEqual([]);
    });
  });
});
