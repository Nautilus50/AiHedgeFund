import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "./adapters/in-memory-repository.js";
import { createWorkflowService, type WorkflowService } from "./service.js";

describe("WorkflowService", () => {
  let repo: InMemoryWorkflowRepository;
  let service: WorkflowService;

  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    repo.seedStrategyVersion({
      id: "sv-1",
      workflowState: "TRADINGVIEW_VERIFICATION",
      createdByActorId: "developer-1",
    });
    service = createWorkflowService(repo);
  });

  it("applies a valid transition and records an audit entry", async () => {
    const outcome = await service.transition({
      idempotencyKey: "key-1",
      strategyVersionId: "sv-1",
      to: "PAPER_APPROVAL_REVIEW",
      actorId: "operator-1",
      actorRoles: ["OPERATOR"],
      evidenceIds: ["parity-report-1"],
      reasonCodes: ["PARITY_PASS"],
      freeTextSummary: "Parity report passed within tolerance.",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.alreadyApplied).toBe(false);
      expect(outcome.record.toState).toBe("PAPER_APPROVAL_REVIEW");
    }
    expect(repo.auditLog).toHaveLength(1);

    const version = await repo.getStrategyVersion("sv-1");
    expect(version?.workflowState).toBe("PAPER_APPROVAL_REVIEW");
  });

  it("returns STRATEGY_VERSION_NOT_FOUND for an unknown version", async () => {
    const outcome = await service.transition({
      idempotencyKey: "key-2",
      strategyVersionId: "does-not-exist",
      to: "PAPER_APPROVAL_REVIEW",
      actorId: "operator-1",
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "n/a",
    });

    expect(outcome).toMatchObject({ ok: false, reasonCode: "STRATEGY_VERSION_NOT_FOUND" });
  });

  it("rejects an invalid transition without mutating state (policy rejection, not a thrown error)", async () => {
    const outcome = await service.transition({
      idempotencyKey: "key-3",
      strategyVersionId: "sv-1",
      to: "PAPER_APPROVED",
      actorId: "operator-1",
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "n/a",
    });

    expect(outcome).toMatchObject({ ok: false, reasonCode: "UNKNOWN_TRANSITION" });
    const version = await repo.getStrategyVersion("sv-1");
    expect(version?.workflowState).toBe("TRADINGVIEW_VERIFICATION");
  });

  it("is idempotent: replaying the same key and command returns the original record", async () => {
    const input = {
      idempotencyKey: "key-4",
      strategyVersionId: "sv-1",
      to: "PAPER_APPROVAL_REVIEW" as const,
      actorId: "operator-1",
      actorRoles: ["OPERATOR"] as const,
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "n/a",
    };

    const first = await service.transition(input);
    const second = await service.transition(input);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.alreadyApplied).toBe(true);
      expect(second.record.id).toBe(first.record.id);
    }
    // Only one audit entry despite two calls with the same idempotency key.
    expect(repo.auditLog).toHaveLength(1);
  });

  it("rejects idempotency-key reuse with a different command body", async () => {
    await service.transition({
      idempotencyKey: "key-5",
      strategyVersionId: "sv-1",
      to: "PAPER_APPROVAL_REVIEW",
      actorId: "operator-1",
      actorRoles: ["OPERATOR"],
      evidenceIds: ["e1"],
      reasonCodes: [],
      freeTextSummary: "first summary",
    });

    // Move state so a second, different transition is even policy-valid.
    repo.seedStrategyVersion({
      id: "sv-1",
      workflowState: "PAPER_APPROVAL_REVIEW",
      createdByActorId: "developer-1",
    });

    const conflict = await service.transition({
      idempotencyKey: "key-5",
      strategyVersionId: "sv-1",
      to: "REJECTED",
      actorId: "committee-1",
      actorRoles: ["COMMITTEE_MEMBER"],
      evidenceIds: ["e2"],
      reasonCodes: [],
      freeTextSummary: "different summary",
    });

    expect(conflict).toMatchObject({ ok: false, reasonCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("reports terminal states correctly", () => {
    expect(service.isTerminal("PAPER_APPROVED")).toBe(true);
    expect(service.isTerminal("REJECTED")).toBe(true);
    expect(service.isTerminal("PINE_DEVELOPMENT")).toBe(false);
  });
});
