import type { z } from "zod";
import type { AgentRole } from "@arf-os/contracts";
import { IdeaCard } from "./idea-card.js";
import { IndicatorResearchOutput } from "./indicator-research.js";

export interface AgentRoleDefinition {
  /**
   * Erased to `z.ZodType<unknown>` at registration (not each role's precise
   * schema type) — a caller indexing by a `RegisteredAgentRole` union needs
   * one schema type that unifies across every registered role, not a union
   * of incompatible Zod object types `runStructuredAgent`'s generic can't
   * resolve to a single `TOutput`.
   */
  outputSchema: z.ZodType<unknown>;
  /** Deterministic dev-only output — never a real model call (no LLM provider adapter exists yet). */
  fixtureOutput: unknown;
}

/** A valid IdeaCard fixture, used by dev runs and by this package's tests. */
export const IDEA_SCOUT_FIXTURE = {
  schemaVersion: "1.0.0",
  title: "Overnight momentum carry in BTC perpetuals",
  hypothesis:
    "Perpetual funding paid during the Asian session creates a predictable drift into the London open.",
  sourceSummary: "Practitioner observation on funding-rate mean reversion, plus published microstructure work.",
  sourceLinks: [],
  marketMechanism:
    "Funding payments force leveraged longs to close into thin liquidity, creating short-lived downward pressure that reverts.",
  expectedDirection: "long",
  targetAssets: ["BYBIT:BTCUSDT.P"],
  targetTimeframes: ["60"],
  expectedRegime: "Range-bound to mildly trending, positive funding.",
  failureRegime: "Strong directional trends, or sustained negative funding where the mechanism inverts.",
  requiredInputs: ["ohlcv", "session boundaries"],
  pineFeasible: true,
  expectedTradeFrequency: "~1 trade per day",
  cheapestFalsificationTest:
    "Bucket returns by funding sign over 12 months; the edge must vanish when funding is negative.",
  noveltyScore: 0.4,
  evidenceStrength: "MODERATE",
  risks: ["Funding data is not directly available in Pine; session proxy may be a weak substitute."],
  recommendation: "RESEARCH",
} as const;

/** A valid IndicatorResearchOutput fixture, used by dev runs and tests. */
export const INDICATOR_RESEARCHER_FIXTURE = {
  schemaVersion: "1.0.0",
  indicatorName: "Perpetual funding rate (session-bucketed)",
  formula: "fundingRate(t) = (predictedFundingRate at 8h settlement) aggregated over the Asian session window.",
  interpretation:
    "Positive funding means longs pay shorts — a proxy for crowded long positioning that tends to mean-revert.",
  parameterRanges: [
    { name: "sessionStartHourUtc", min: 0, max: 8, default: 0 },
    { name: "sessionEndHourUtc", min: 0, max: 8, default: 8 },
    { name: "fundingThresholdBps", min: 1, max: 50, default: 10 },
  ],
  repaintingAnalysis:
    "The 8h settlement funding rate is fixed once the settlement occurs; the predicted rate before settlement can drift and must not be used as a signal input on an unclosed period.",
  mtfBehaviour:
    "Session boundary detection reads only fully closed hourly bars; no higher-timeframe value is referenced.",
  redundancyNotes: ["Open interest delta is a related but distinct crowding proxy — not interchangeable."],
  unitScenarios: [
    "Funding exactly at threshold: signal must not fire (strict inequality).",
    "Missing funding data for a bar: indicator must return NaN, not zero.",
  ],
  pineImplementationNotes:
    "Pine has no native funding-rate feed; requires an external data request via request.security on a funding-rate symbol, confirmed (lookahead_off) to avoid repainting.",
} as const;

/**
 * Single source of truth for which agent roles this runtime can actually
 * run. Both the worker's dispatch loop and the fixture provider's map are
 * built from this same object — adding a role means one edit here, not one
 * in each consumer (the failure mode of drifting apart is a runtime throw,
 * not a compile error, if kept as two separate lookups).
 */
// `satisfies`, not an explicit `Partial<Record<AgentRole,...>>` annotation —
// that would widen `keyof typeof AGENT_RUNTIME_REGISTRY` to all 11 AgentRole
// members instead of just the two actually registered, which is exactly the
// distinction `isRegisteredAgentRole` below exists to make useful at the
// type level, not just at runtime.
export const AGENT_RUNTIME_REGISTRY = {
  IDEA_SCOUT: { outputSchema: IdeaCard as z.ZodType<unknown>, fixtureOutput: IDEA_SCOUT_FIXTURE },
  INDICATOR_RESEARCHER: {
    outputSchema: IndicatorResearchOutput as z.ZodType<unknown>,
    fixtureOutput: INDICATOR_RESEARCHER_FIXTURE,
  },
} satisfies Partial<Record<AgentRole, AgentRoleDefinition>>;

export type RegisteredAgentRole = keyof typeof AGENT_RUNTIME_REGISTRY;

export function isRegisteredAgentRole(role: string): role is RegisteredAgentRole {
  return role in AGENT_RUNTIME_REGISTRY;
}
