import { AGENT_RUNTIME_REGISTRY } from "../registry.js";
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

/** Built from {@link AGENT_RUNTIME_REGISTRY} — every registered role gets a fixture automatically. */
export function createDevelopmentProvider(): FixtureModelProvider {
  const fixtures = new Map<string, unknown>(
    Object.entries(AGENT_RUNTIME_REGISTRY).map(([role, definition]) => [role, definition.fixtureOutput]),
  );
  return new FixtureModelProvider(fixtures);
}
