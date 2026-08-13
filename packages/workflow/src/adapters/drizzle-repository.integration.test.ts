import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  backtestRuns,
  closeDatabase,
  createTestDatabase,
  idempotencyRecords,
  isTestDatabaseAvailable,
  outboxEvents,
  parityReports,
  seedOrganisation,
  seedStrategyVersion,
  strategyVersions,
  tradingviewVerifications,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { fingerprint, generateId } from "@arf-os/contracts";
import { ReadModelRefreshJob } from "@arf-os/event-bus";
import { createWorkflowService, type WorkflowService } from "../service.js";
import { DrizzleWorkflowRepository } from "./drizzle-repository.js";

const available = await isTestDatabaseAvailable();

describe.skipIf(!available)("DrizzleWorkflowRepository (integration)", () => {
  let db: Database;
  let service: WorkflowService;

  beforeAll(() => {
    db = createTestDatabase();
    service = createWorkflowService(new DrizzleWorkflowRepository(db));
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("writes the state change, audit event, and outbox event in one transaction", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const outcome = await service.transition({
      idempotencyKey: "key-atomic",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW",
      actorId: org.userId,
      actorRoles: ["OPERATOR"],
      evidenceIds: ["parity-1"],
      reasonCodes: ["PARITY_PASS"],
      freeTextSummary: "Parity within tolerance.",
    });

    expect(outcome.ok).toBe(true);

    const [version] = await db
      .select({ workflowState: strategyVersions.workflowState })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, strategy.strategyVersionId));
    expect(version?.workflowState).toBe("PAPER_APPROVAL_REVIEW");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.aggregateId, strategy.strategyVersionId));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("workflow.transition.TRADINGVIEW_VERIFICATION_to_PAPER_APPROVAL_REVIEW");
    // The audit must carry both the prior and new state (CLAUDE.md 9.4).
    expect(audits[0]?.priorStateSummary).toEqual({ workflowState: "TRADINGVIEW_VERIFICATION" });
    expect(audits[0]?.newStateSummary).toEqual({ workflowState: "PAPER_APPROVAL_REVIEW" });
    expect(audits[0]?.organisationId).toBe(org.organisationId);

    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, strategy.strategyVersionId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe("strategy_version.transitioned");
    expect(outbox[0]?.status).toBe("PENDING");
    // The relay routes this event to read-model-refresh; its payload must
    // satisfy that job's schema, not just carry from/to informationally.
    expect(() => ReadModelRefreshJob.parse(outbox[0]?.payload)).not.toThrow();
    expect(outbox[0]?.payload).toMatchObject({
      organisationId: org.organisationId,
      aggregateType: "strategy_version",
      aggregateId: strategy.strategyVersionId,
    });
  });

  it("keeps concurrent transitions sharing an idempotency key to a single applied transition", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const input = {
      idempotencyKey: "key-race",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW" as const,
      actorId: org.userId,
      actorRoles: ["OPERATOR"] as const,
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "concurrent",
    };

    // Both fire before either has committed, so the pre-flight replay lookup
    // misses for both and they race on the idempotency_records primary key.
    // The loser's INSERT violates the PK and must roll its whole transaction
    // back — including the audit and outbox rows (CLAUDE.md 9.3).
    const results = await Promise.allSettled([service.transition(input), service.transition(input)]);

    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.ok);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Whatever happened at the driver level, the database must show exactly
    // one transition — never two audits or two outbox events for one key.
    expect(await db.select().from(auditEvents)).toHaveLength(1);
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
    expect(await db.select().from(idempotencyRecords)).toHaveLength(1);
  });

  it("replays an identical idempotency key without creating a second transition", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    const input = {
      idempotencyKey: "key-replay",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW" as const,
      actorId: org.userId,
      actorRoles: ["OPERATOR"] as const,
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "first",
    };

    const first = await service.transition(input);
    const second = await service.transition(input);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.alreadyApplied).toBe(true);
      expect(second.record.id).toBe(first.record.id);
    }

    // Exactly one audit and one outbox row despite two calls.
    expect(await db.select().from(auditEvents)).toHaveLength(1);
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("rejects reusing an idempotency key with a different request body", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    await service.transition({
      idempotencyKey: "key-conflict",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW",
      actorId: org.userId,
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "first",
    });

    const conflict = await service.transition({
      idempotencyKey: "key-conflict",
      strategyVersionId: strategy.strategyVersionId,
      to: "REJECTED",
      actorId: org.userId,
      actorRoles: ["COMMITTEE_MEMBER"],
      evidenceIds: ["e2"],
      reasonCodes: [],
      freeTextSummary: "different",
    });

    expect(conflict).toMatchObject({ ok: false, reasonCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("persists the request fingerprint so replay detection survives a restart", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org);

    await service.transition({
      idempotencyKey: "key-fingerprint",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW",
      actorId: org.userId,
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "first",
    });

    const [record] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, "key-fingerprint"));

    expect(record?.organisationId).toBe(org.organisationId);
    expect(record?.requestHash).toBe(
      fingerprint({
        strategyVersionId: strategy.strategyVersionId,
        to: "PAPER_APPROVAL_REVIEW",
        actorId: org.userId,
        actorRoles: ["OPERATOR"],
        evidenceIds: ["e1"],
        reasonCodes: [],
        freeTextSummary: "first",
        humanOverride: false,
        overrideReason: undefined,
      }),
    );
  });

  it("does not transition when the version is already past the expected 'from' state", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, { workflowState: "PINE_DEVELOPMENT" });

    // PINE_DEVELOPMENT -> PAPER_APPROVAL_REVIEW is not an allowed edge.
    const outcome = await service.transition({
      idempotencyKey: "key-illegal",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVAL_REVIEW",
      actorId: org.userId,
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "illegal",
    });

    expect(outcome).toMatchObject({ ok: false, reasonCode: "UNKNOWN_TRANSITION" });

    const [version] = await db
      .select({ workflowState: strategyVersions.workflowState })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, strategy.strategyVersionId));
    expect(version?.workflowState).toBe("PINE_DEVELOPMENT");
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("blocks a creator approving their own version, end to end through the database", async () => {
    const org = await seedOrganisation(db);
    // createdByAgentRunId is what DrizzleWorkflowRepository reads as the creator.
    const strategy = await seedStrategyVersion(db, org, {
      workflowState: "PAPER_APPROVAL_REVIEW",
      createdByAgentRunId: org.userId,
    });

    const outcome = await service.transition({
      idempotencyKey: "key-self-approve",
      strategyVersionId: strategy.strategyVersionId,
      to: "PAPER_APPROVED",
      actorId: org.userId,
      actorRoles: ["COMMITTEE_MEMBER"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "self approval attempt",
    });

    expect(outcome).toMatchObject({ ok: false, reasonCode: "CREATOR_CANNOT_APPROVE_OWN_VERSION" });

    const [version] = await db
      .select({ workflowState: strategyVersions.workflowState })
      .from(strategyVersions)
      .where(eq(strategyVersions.id, strategy.strategyVersionId));
    expect(version?.workflowState).toBe("PAPER_APPROVAL_REVIEW");
  });

  // CLAUDE_CODE_BUILD_PROMPT.md: "Do not permit PAPER_APPROVED when required
  // verification evidence is missing or parity is FAIL." Proves the real
  // DrizzleWorkflowRepository.getEvidenceStatus query — not just the pure
  // evaluator — actually blocks this against Postgres.
  describe("PAPER_APPROVED evidence gate (end to end)", () => {
    async function seedApprovableVersion() {
      const org = await seedOrganisation(db);
      // A different creator than the acting committee member, so this test
      // isolates the evidence gate from the separate creator-cannot-approve check.
      const strategy = await seedStrategyVersion(db, org, {
        workflowState: "PAPER_APPROVAL_REVIEW",
        createdByAgentRunId: generateId<string>(),
      });
      return { org, strategy };
    }

    async function seedVerification(strategyVersionId: string, requestedByUserId: string, status: "PASSED" | "FAILED" | "PENDING") {
      const verificationId = generateId<string>();
      await db.insert(tradingviewVerifications).values({
        id: verificationId, strategyVersionId, requiredSymbol: "BTCUSD", requiredTimeframe: "1h", requestedByUserId, status,
      });
      return verificationId;
    }

    async function seedBacktestRunWithParity(strategyVersionId: string, verificationId: string, parityStatus: "PASS" | "FAIL") {
      const backtestRunId = generateId<string>();
      await db.insert(backtestRuns).values({
        id: backtestRunId, strategyVersionId, runnerType: "TRADINGVIEW", runnerVersion: "n/a", verificationId,
        symbol: "BTCUSD", timeframe: "1h", segmentKind: "IN_SAMPLE",
        fromTs: new Date("2024-01-01T00:00:00Z"), toTs: new Date("2024-01-02T00:00:00Z"),
        costModel: { commissionType: "percent", commissionValue: 0.1, slippageTicks: 0 },
        initialCapital: "10000", sourceHash: "hash", status: "SUCCEEDED",
      });
      await db.insert(parityReports).values({
        id: generateId<string>(), backtestRunId, verificationId, status: parityStatus, comparison: {},
      });
    }

    it("blocks approval when no PASSED verification exists for this strategy version", async () => {
      const { org, strategy } = await seedApprovableVersion();

      const outcome = await service.transition({
        idempotencyKey: "key-no-verification",
        strategyVersionId: strategy.strategyVersionId,
        to: "PAPER_APPROVED",
        actorId: org.userId,
        actorRoles: ["COMMITTEE_MEMBER"],
        evidenceIds: ["e1"],
        reasonCodes: [],
        freeTextSummary: "attempted approval with no verification",
      });

      expect(outcome).toMatchObject({ ok: false, reasonCode: "VERIFICATION_REQUIRED" });

      const [version] = await db
        .select({ workflowState: strategyVersions.workflowState })
        .from(strategyVersions)
        .where(eq(strategyVersions.id, strategy.strategyVersionId));
      expect(version?.workflowState).toBe("PAPER_APPROVAL_REVIEW");
      expect(await db.select().from(auditEvents)).toHaveLength(0);
    });

    it("blocks approval when a parity report is FAIL, even with a PASSED verification", async () => {
      const { org, strategy } = await seedApprovableVersion();
      const verificationId = await seedVerification(strategy.strategyVersionId, org.userId, "PASSED");
      await seedBacktestRunWithParity(strategy.strategyVersionId, verificationId, "FAIL");

      const outcome = await service.transition({
        idempotencyKey: "key-parity-fail",
        strategyVersionId: strategy.strategyVersionId,
        to: "PAPER_APPROVED",
        actorId: org.userId,
        actorRoles: ["COMMITTEE_MEMBER"],
        evidenceIds: ["e1"],
        reasonCodes: [],
        freeTextSummary: "attempted approval with failed parity",
      });

      expect(outcome).toMatchObject({ ok: false, reasonCode: "PARITY_FAILED" });

      const [version] = await db
        .select({ workflowState: strategyVersions.workflowState })
        .from(strategyVersions)
        .where(eq(strategyVersions.id, strategy.strategyVersionId));
      expect(version?.workflowState).toBe("PAPER_APPROVAL_REVIEW");
    });

    it("allows approval when a verification passed and no parity report failed", async () => {
      const { org, strategy } = await seedApprovableVersion();
      const verificationId = await seedVerification(strategy.strategyVersionId, org.userId, "PASSED");
      await seedBacktestRunWithParity(strategy.strategyVersionId, verificationId, "PASS");

      const outcome = await service.transition({
        idempotencyKey: "key-clean-approval",
        strategyVersionId: strategy.strategyVersionId,
        to: "PAPER_APPROVED",
        actorId: org.userId,
        actorRoles: ["COMMITTEE_MEMBER"],
        evidenceIds: ["e1"],
        reasonCodes: [],
        freeTextSummary: "clean approval",
      });

      expect(outcome.ok).toBe(true);

      const [version] = await db
        .select({ workflowState: strategyVersions.workflowState })
        .from(strategyVersions)
        .where(eq(strategyVersions.id, strategy.strategyVersionId));
      expect(version?.workflowState).toBe("PAPER_APPROVED");
    });

    it("blocks approval when the only PASSED verification belongs to a different strategy version", async () => {
      const { org, strategy } = await seedApprovableVersion();
      const otherVersion = await seedStrategyVersion(db, org, { workflowState: "PAPER_APPROVAL_REVIEW" });
      await seedVerification(otherVersion.strategyVersionId, org.userId, "PASSED");

      const outcome = await service.transition({
        idempotencyKey: "key-wrong-version",
        strategyVersionId: strategy.strategyVersionId,
        to: "PAPER_APPROVED",
        actorId: org.userId,
        actorRoles: ["COMMITTEE_MEMBER"],
        evidenceIds: ["e1"],
        reasonCodes: [],
        freeTextSummary: "attempted approval using another version's verification",
      });

      expect(outcome).toMatchObject({ ok: false, reasonCode: "VERIFICATION_REQUIRED" });
    });
  });

  describe("composing into a caller's transaction", () => {
    /**
     * `apps/api/src/services/decisions.ts` needs a committee decision and its
     * workflow transition to commit or roll back together (CLAUDE.md 9.3) —
     * a crash between two separate transactions used to leave an
     * approved/rejected version with no decision record. It achieves that by
     * constructing `DrizzleWorkflowRepository` around its own already-open
     * `tx` instead of the top-level `db`: `applyTransition`'s internal
     * `this.db.transaction(...)` call then opens a savepoint within the
     * caller's transaction rather than an independent one. This proves that
     * mechanism directly — recordCommitteeDecision's own integration tests
     * (apps/api/src/services/decisions.integration.test.ts) only need to show
     * it uses this, not re-prove that it works.
     */
    it("rolls the transition back too when a later write in the same transaction fails", async () => {
      const org = await seedOrganisation(db);
      const strategy = await seedStrategyVersion(db, org, { workflowState: "TRADINGVIEW_VERIFICATION" });

      await expect(
        db.transaction(async (tx) => {
          const txService = createWorkflowService(new DrizzleWorkflowRepository(tx));
          const outcome = await txService.transition({
            idempotencyKey: "atomic-rollback-key",
            strategyVersionId: strategy.strategyVersionId,
            to: "PAPER_APPROVAL_REVIEW",
            actorId: org.userId,
            actorRoles: ["OPERATOR"],
            evidenceIds: ["e1"],
            reasonCodes: ["R1"],
            freeTextSummary: "about to fail",
          });
          // The transition itself succeeded — from applyTransition's own
          // point of view nothing is wrong yet.
          expect(outcome.ok).toBe(true);

          // Simulate the caller's next write (e.g. inserting a committee
          // decision row) failing after the transition already "succeeded".
          throw new Error("simulated failure after a successful transition");
        }),
      ).rejects.toThrow("simulated failure after a successful transition");

      const [version] = await db
        .select({ workflowState: strategyVersions.workflowState })
        .from(strategyVersions)
        .where(eq(strategyVersions.id, strategy.strategyVersionId));
      // Not PAPER_APPROVAL_REVIEW — the whole transaction rolled back,
      // taking the transition's savepoint with it.
      expect(version?.workflowState).toBe("TRADINGVIEW_VERIFICATION");

      const outboxRows = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, strategy.strategyVersionId));
      expect(outboxRows).toHaveLength(0);

      const idempotencyRows = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, "atomic-rollback-key"));
      expect(idempotencyRows).toHaveLength(0);
    });
  });
});
