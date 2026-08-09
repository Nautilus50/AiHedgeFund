import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  closeDatabase,
  createTestDatabase,
  idempotencyRecords,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  seedStrategyVersion,
  strategyVersions,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { fingerprint } from "@arf-os/contracts";
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
});
