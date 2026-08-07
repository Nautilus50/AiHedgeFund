import { describe, expect, it } from "vitest";
import { evaluateTransition } from "./evaluate-transition.js";

const baseRequest = {
  from: "TRADINGVIEW_VERIFICATION" as const,
  to: "PAPER_APPROVAL_REVIEW" as const,
  actorId: "actor-1",
  actorRoles: ["OPERATOR"] as const,
  strategyVersionCreatedByActorId: "actor-2",
  evidenceIds: ["evidence-1"],
};

describe("evaluateTransition", () => {
  it("accepts a valid transition with the right role and evidence", () => {
    const result = evaluateTransition(baseRequest);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown transition", () => {
    const result = evaluateTransition({ ...baseRequest, from: "REJECTED", to: "PAPER_APPROVED" });
    expect(result).toMatchObject({ ok: false, reasonCode: "UNKNOWN_TRANSITION" });
  });

  it("rejects when the actor lacks the required role", () => {
    const result = evaluateTransition({ ...baseRequest, actorRoles: ["VIEWER"] });
    expect(result).toMatchObject({ ok: false, reasonCode: "ROLE_NOT_PERMITTED" });
  });

  it("rejects when evidence is required but missing", () => {
    const result = evaluateTransition({ ...baseRequest, evidenceIds: [] });
    expect(result).toMatchObject({ ok: false, reasonCode: "EVIDENCE_REQUIRED" });
  });

  it("rejects a creator approving their own version (CLAUDE.md 3.4)", () => {
    const result = evaluateTransition({
      from: "PAPER_APPROVAL_REVIEW",
      to: "PAPER_APPROVED",
      actorId: "same-actor",
      actorRoles: ["COMMITTEE_MEMBER"],
      strategyVersionCreatedByActorId: "same-actor",
      evidenceIds: ["evidence-1"],
    });
    expect(result).toMatchObject({ ok: false, reasonCode: "CREATOR_CANNOT_APPROVE_OWN_VERSION" });
  });

  it("allows a different committee member to approve", () => {
    const result = evaluateTransition({
      from: "PAPER_APPROVAL_REVIEW",
      to: "PAPER_APPROVED",
      actorId: "committee-member",
      actorRoles: ["COMMITTEE_MEMBER"],
      strategyVersionCreatedByActorId: "creator",
      evidenceIds: ["evidence-1"],
    });
    expect(result.ok).toBe(true);
  });
});
