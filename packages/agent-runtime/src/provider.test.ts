import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDEA_SCOUT_FIXTURE, createDevelopmentProvider } from "./adapters/fixture-provider.js";
import { IdeaCard, IDEA_SCOUT_PROMPT_VERSION, IDEA_SCOUT_SYSTEM_PROMPT } from "./idea-card.js";
import { runStructuredAgent, type ModelProvider, type StructuredGenerationResult } from "./provider.js";

const ideaScoutRequest = {
  role: "IDEA_SCOUT",
  promptVersion: IDEA_SCOUT_PROMPT_VERSION,
  systemPrompt: IDEA_SCOUT_SYSTEM_PROMPT,
  userInput: "Find a testable edge in BTC perpetuals.",
  outputSchema: IdeaCard,
};

/** Returns a scripted sequence of outputs, one per call, and records how many times it was invoked. */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls = 0;
  readonly seenInputs: string[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async generateStructured<TOutput>(request: {
    userInput: string;
    promptVersion: string;
  }): Promise<StructuredGenerationResult<TOutput>> {
    const output = this.outputs[this.calls];
    this.calls += 1;
    this.seenInputs.push(request.userInput);
    return {
      output: output as TOutput,
      promptVersion: request.promptVersion,
      rawOutput: JSON.stringify(output),
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 200,
    };
  }
}

describe("IdeaCard", () => {
  it("accepts the development fixture", () => {
    expect(IdeaCard.safeParse(IDEA_SCOUT_FIXTURE).success).toBe(true);
  });

  it("rejects an idea with no falsification test (spec 7.2 acceptance criteria)", () => {
    const result = IdeaCard.safeParse({ ...IDEA_SCOUT_FIXTURE, cheapestFalsificationTest: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an idea with no named failure regime", () => {
    const result = IdeaCard.safeParse({ ...IDEA_SCOUT_FIXTURE, failureRegime: "" });
    expect(result.success).toBe(false);
  });
});

describe("runStructuredAgent", () => {
  it("returns validated output on a first-attempt success without retrying", async () => {
    const provider = new ScriptedProvider([IDEA_SCOUT_FIXTURE]);
    const outcome = await runStructuredAgent(provider, ideaScoutRequest);

    expect(outcome.ok).toBe(true);
    expect(provider.calls).toBe(1);
    if (outcome.ok) {
      expect(outcome.result.output.title).toBe(IDEA_SCOUT_FIXTURE.title);
      expect(outcome.result.costUsd).toBe(0.01);
    }
  });

  it("retries exactly once with the validation errors appended, then succeeds", async () => {
    const provider = new ScriptedProvider([{ schemaVersion: "1.0.0" }, IDEA_SCOUT_FIXTURE]);
    const outcome = await runStructuredAgent(provider, ideaScoutRequest);

    expect(outcome.ok).toBe(true);
    expect(provider.calls).toBe(2);
    // The retry must tell the model exactly what was wrong (CLAUDE.md 11.3 step 5).
    expect(provider.seenInputs[1]).toContain("failed schema validation");
    expect(provider.seenInputs[1]).toContain("hypothesis");
  });

  it("fails after a second invalid response instead of coercing the output", async () => {
    const provider = new ScriptedProvider([{ bad: true }, { stillBad: true }]);
    const outcome = await runStructuredAgent(provider, ideaScoutRequest);

    expect(outcome).toMatchObject({ ok: false, reasonCode: "SCHEMA_VALIDATION_FAILED" });
    expect(provider.calls).toBe(2);
    if (!outcome.ok) {
      expect(outcome.issues.length).toBeGreaterThan(0);
      expect(outcome.rawOutput).toBe(JSON.stringify({ stillBad: true }));
    }
  });

  it("validates against the caller's schema, not the provider's word", async () => {
    // Provider returns something structurally fine but wrong for this contract.
    const provider = new ScriptedProvider([{ notAnIdeaCard: true }, { notAnIdeaCard: true }]);
    const outcome = await runStructuredAgent(provider, {
      ...ideaScoutRequest,
      outputSchema: z.object({ notAnIdeaCard: z.boolean() }),
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("FixtureModelProvider", () => {
  it("serves the registered IDEA_SCOUT fixture", async () => {
    const outcome = await runStructuredAgent(createDevelopmentProvider(), ideaScoutRequest);
    expect(outcome.ok).toBe(true);
  });

  it("throws for an unregistered role rather than returning empty output", async () => {
    await expect(
      createDevelopmentProvider().generateStructured({ ...ideaScoutRequest, role: "STRATEGY_JUDGE" }),
    ).rejects.toThrow(/No fixture registered/);
  });
});
