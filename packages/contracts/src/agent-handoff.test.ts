import { describe, expect, it } from "vitest";
import { AgentHandoff } from "./agent-handoff.js";
import { generateId } from "./ids.js";

function buildHandoff(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0.0",
    handoffId: generateId(),
    campaignId: generateId(),
    strategyId: null,
    strategyVersionId: null,
    fromAgent: {
      role: "INDICATOR_RESEARCHER",
      agentId: "agent-instance-1",
      promptVersion: "sha256:abc123",
    },
    toRole: "STRATEGY_ARCHITECT",
    taskId: generateId(),
    status: "COMPLETE",
    summary: "Indicator research complete for RSI mean reversion.",
    assumptions: [],
    unknowns: [],
    riskFlags: [],
    artefactIds: [],
    evidenceIds: [],
    requestedAction: "Create a deterministic strategy definition",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AgentHandoff", () => {
  it("accepts a well-formed handoff envelope", () => {
    expect(AgentHandoff.safeParse(buildHandoff()).success).toBe(true);
  });

  it("rejects an unknown toRole (spec 8.1 — handoff rejected when requested action is outside receiving role)", () => {
    const result = AgentHandoff.safeParse(buildHandoff({ toRole: "NOT_A_ROLE" }));
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid handoffId", () => {
    const result = AgentHandoff.safeParse(buildHandoff({ handoffId: "not-a-uuid" }));
    expect(result.success).toBe(false);
  });
});
