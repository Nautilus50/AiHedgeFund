import { describe, expect, it } from "vitest";
import { findRule, TERMINAL_STATES, TRANSITION_RULES } from "./policy.js";

describe("policy", () => {
  it("has no outgoing rule from a terminal state", () => {
    for (const state of TERMINAL_STATES) {
      const outgoing = TRANSITION_RULES.filter((rule) => rule.from === state);
      expect(outgoing).toHaveLength(0);
    }
  });

  it("finds the exact rule for a known transition", () => {
    const rule = findRule("PAPER_APPROVAL_REVIEW", "PAPER_APPROVED");
    expect(rule?.requiredRole).toBe("COMMITTEE_MEMBER");
    expect(rule?.forbidCreatorAsActor).toBe(true);
    expect(rule?.requiresPassedVerification).toBe(true);
  });

  it("requires a passed verification only for PAPER_APPROVAL_REVIEW -> PAPER_APPROVED, not any other transition", () => {
    const others = TRANSITION_RULES.filter((rule) => !(rule.from === "PAPER_APPROVAL_REVIEW" && rule.to === "PAPER_APPROVED"));
    for (const rule of others) {
      expect(rule.requiresPassedVerification).toBe(false);
    }
  });

  it("returns undefined for an unknown transition", () => {
    expect(findRule("CAMPAIGN_BACKLOG", "PAPER_APPROVED")).toBeUndefined();
  });

  it("never allows skipping TradingView verification into paper approval review", () => {
    expect(findRule("PINE_DEVELOPMENT", "PAPER_APPROVAL_REVIEW")).toBeUndefined();
  });
});
