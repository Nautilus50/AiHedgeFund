import { describe, expect, it } from "vitest";
import { evaluateTransition } from "./evaluate-transition.js";

const baseRequest = {
  from: "TRADINGVIEW_VERIFICATION" as const,
  to: "PAPER_APPROVAL_REVIEW" as const,
  actorId: "actor-1",
  actorRoles: ["OPERATOR"] as const,
  strategyVersionCreatedByActorId: "actor-2",
  evidenceIds: ["evidence-1"],
  hasPassedVerification: false,
  hasFailedParity: false,
};

const approvalRequest = {
  from: "PAPER_APPROVAL_REVIEW" as const,
  to: "PAPER_APPROVED" as const,
  actorId: "committee-member",
  actorRoles: ["COMMITTEE_MEMBER"] as const,
  strategyVersionCreatedByActorId: "creator",
  evidenceIds: ["evidence-1"],
  hasPassedVerification: true,
  hasFailedParity: false,
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
    const result = evaluateTransition({ ...approvalRequest, actorId: "same-actor", strategyVersionCreatedByActorId: "same-actor" });
    expect(result).toMatchObject({ ok: false, reasonCode: "CREATOR_CANNOT_APPROVE_OWN_VERSION" });
  });

  it("allows a different committee member to approve when verification passed and parity did not fail", () => {
    const result = evaluateTransition(approvalRequest);
    expect(result.ok).toBe(true);
  });

  // CLAUDE_CODE_BUILD_PROMPT.md: "Do not permit PAPER_APPROVED when required
  // verification evidence is missing or parity is FAIL." These are the
  // regression tests for that rule (previously unenforced — see the
  // 2026-08-12 build-prompt audit).
  describe("PAPER_APPROVED evidence gate", () => {
    it("blocks approval when no PASSED verification exists, even with role/evidence/creator checks satisfied", () => {
      const result = evaluateTransition({ ...approvalRequest, hasPassedVerification: false });
      expect(result).toMatchObject({ ok: false, reasonCode: "VERIFICATION_REQUIRED" });
    });

    it("blocks approval when a parity report is FAIL, even with a passed verification", () => {
      const result = evaluateTransition({ ...approvalRequest, hasPassedVerification: true, hasFailedParity: true });
      expect(result).toMatchObject({ ok: false, reasonCode: "PARITY_FAILED" });
    });

    it("does not apply the verification/parity gate to transitions that don't require it", () => {
      // PAPER_APPROVAL_REVIEW -> REJECTED requires evidence but not a passed
      // verification — a validator must be able to reject an unverified
      // version without first fabricating a verification for it.
      const result = evaluateTransition({
        ...baseRequest,
        from: "PAPER_APPROVAL_REVIEW",
        to: "REJECTED",
        actorId: "committee-member",
        actorRoles: ["COMMITTEE_MEMBER"],
        hasPassedVerification: false,
        hasFailedParity: true,
      });
      expect(result.ok).toBe(true);
    });
  });
});
