import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@arf-os/contracts";
import {
  closeDatabase,
  committeeDecisions,
  createTestDatabase,
  isTestDatabaseAvailable,
  outboxEvents,
  seedOrganisation,
  seedStrategyVersion,
  strategyVersions,
  truncateAll,
  type Database,
} from "@arf-os/db";
import { QUEUE_NAMES, ReadModelRefreshJob, routeOutboxEvent } from "@arf-os/event-bus";
import { createWorkflowService, DrizzleWorkflowRepository, type WorkflowService } from "@arf-os/workflow";
import { recordCommitteeDecision } from "./decisions.js";

const available = await isTestDatabaseAvailable();

/**
 * `recordCommitteeDecision` had no direct test coverage before this — it
 * drives a workflow transition and then records the decision, and this
 * suite now also proves the second half emits a correctly shaped
 * read-model-refresh event, atomically with the decision row (CLAUDE.md 9.3).
 */
describe.skipIf(!available)("recordCommitteeDecision (integration)", () => {
  let db: Database;
  let workflow: WorkflowService;

  beforeAll(() => {
    db = createTestDatabase();
    workflow = createWorkflowService(new DrizzleWorkflowRepository(db));
  });

  afterAll(async () => {
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it("records the decision, transitions the version, and emits a read-model-refresh event the worker can consume", async () => {
    const org = await seedOrganisation(db);
    const strategy = await seedStrategyVersion(db, org, {
      workflowState: "PAPER_APPROVAL_REVIEW",
      createdByAgentRunId: generateId<string>(), // distinct from the committee actor below
    });
    const committeeUserId = generateId<string>();

    const result = await recordCommitteeDecision(
      db,
      workflow,
      { id: committeeUserId, roles: ["COMMITTEE_MEMBER"] },
      org.organisationId,
      generateId<string>(),
      {
        strategyVersionId: strategy.strategyVersionId,
        decision: "REJECT",
        reasonCodes: ["WEAK_EDGE"],
        rejectionCase: "Underperforms buy-and-hold out of sample.",
        positiveCase: "n/a",
        conditions: [],
        requiredNextEvidence: [],
        evidenceIds: [generateId<string>()],
        humanOverride: false,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [decisionRow] = await db.select().from(committeeDecisions).where(eq(committeeDecisions.id, result.decisionId));
    expect(decisionRow?.decision).toBe("REJECT");
    expect(decisionRow?.strategyVersionId).toBe(strategy.strategyVersionId);

    const [versionRow] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, strategy.strategyVersionId));
    expect(versionRow?.workflowState).toBe("REJECTED");

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "committee_decision.created"));
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.aggregateId).toBe(result.decisionId);

    const payload = ReadModelRefreshJob.parse(event.payload);
    expect(payload).toEqual({
      organisationId: org.organisationId,
      aggregateType: "strategy_version",
      aggregateId: strategy.strategyVersionId,
    });

    expect(routeOutboxEvent({ ...event, payload: event.payload as Record<string, unknown> })?.queue).toBe(
      QUEUE_NAMES.readModelRefresh,
    );
  });

  it("records nothing when the workflow rejects the transition — no decision row, no event", async () => {
    const org = await seedOrganisation(db);
    const creatorId = generateId<string>();
    const strategy = await seedStrategyVersion(db, org, {
      workflowState: "PAPER_APPROVAL_REVIEW",
      createdByAgentRunId: creatorId,
    });

    // The creator cannot decide on their own version (CLAUDE.md 3.4).
    const result = await recordCommitteeDecision(
      db,
      workflow,
      { id: creatorId, roles: ["COMMITTEE_MEMBER"] },
      org.organisationId,
      generateId<string>(),
      {
        strategyVersionId: strategy.strategyVersionId,
        decision: "REJECT",
        reasonCodes: ["WEAK_EDGE"],
        rejectionCase: "n/a",
        positiveCase: "n/a",
        conditions: [],
        requiredNextEvidence: [],
        evidenceIds: [generateId<string>()],
        humanOverride: false,
      },
    );

    expect(result.ok).toBe(false);

    const decisions = await db.select().from(committeeDecisions);
    expect(decisions).toHaveLength(0);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "committee_decision.created"));
    expect(events).toHaveLength(0);

    // The version must also be untouched — a rejected transition is not a
    // partial one (CLAUDE.md 3.6).
    const [versionRow] = await db.select().from(strategyVersions).where(eq(strategyVersions.id, strategy.strategyVersionId));
    expect(versionRow?.workflowState).toBe("PAPER_APPROVAL_REVIEW");
  });
});
