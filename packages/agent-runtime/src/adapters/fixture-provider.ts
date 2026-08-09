import type { ModelProvider, StructuredGenerationRequest, StructuredGenerationResult } from "../provider.js";

/**
 * Deterministic development provider (CLAUDE_CODE_BUILD_PROMPT.md — "using
 * a provider adapter or a deterministic fixture provider in development").
 *
 * Lets the whole agent-run path — task storage, schema validation, handoff,
 * cost accounting, prompt versioning — be exercised end to end without a
 * model API key, and keeps its own tests free of network flake.
 */
export class FixtureModelProvider implements ModelProvider {
  readonly name = "fixture";

  constructor(private readonly fixtures: Map<string, unknown>) {}

  async generateStructured<TOutput>(
    request: StructuredGenerationRequest<TOutput>,
  ): Promise<StructuredGenerationResult<TOutput>> {
    const fixture = this.fixtures.get(request.role);
    if (fixture === undefined) {
      throw new Error(`No fixture registered for role ${request.role}.`);
    }

    return {
      output: fixture as TOutput,
      promptVersion: request.promptVersion,
      rawOutput: JSON.stringify(fixture),
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
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

export function createDevelopmentProvider(): FixtureModelProvider {
  return new FixtureModelProvider(new Map<string, unknown>([["IDEA_SCOUT", IDEA_SCOUT_FIXTURE]]));
}
