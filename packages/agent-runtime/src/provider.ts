import type { z } from "zod";

export interface StructuredGenerationRequest<TOutput> {
  role: string;
  promptVersion: string;
  systemPrompt: string;
  userInput: string;
  outputSchema: z.ZodType<TOutput>;
}

export interface StructuredGenerationResult<TOutput> {
  output: TOutput;
  promptVersion: string;
  /** Raw provider text, kept for protected diagnostics storage only — never surfaced in normal UI records (CLAUDE.md 11.3). */
  rawOutput: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider port (CLAUDE.md 11.1). Adapters must contain no research
 * workflow logic — they translate a typed request into a provider call and
 * back, nothing more.
 */
export interface ModelProvider {
  readonly name: string;
  generateStructured<TOutput>(
    request: StructuredGenerationRequest<TOutput>,
  ): Promise<StructuredGenerationResult<TOutput>>;
}

export type AgentRunOutcome<TOutput> =
  | { ok: true; result: StructuredGenerationResult<TOutput> }
  | { ok: false; reasonCode: "SCHEMA_VALIDATION_FAILED"; issues: string[]; rawOutput: string };

/**
 * Runs a role prompt and validates the provider's output against its
 * contract, retrying once with the exact validation errors appended
 * (CLAUDE.md 11.3 steps 1-6). A second failure is reported, never coerced —
 * "Do not accept critical free-form model output and then infer fields".
 */
export async function runStructuredAgent<TOutput>(
  provider: ModelProvider,
  request: StructuredGenerationRequest<TOutput>,
): Promise<AgentRunOutcome<TOutput>> {
  const first = await attempt(provider, request);
  if (first.ok) return first;

  const retryRequest: StructuredGenerationRequest<TOutput> = {
    ...request,
    userInput: `${request.userInput}\n\nYour previous response failed schema validation with these errors:\n${first.issues.join("\n")}\nReturn corrected JSON that satisfies the schema.`,
  };

  return attempt(provider, retryRequest);
}

async function attempt<TOutput>(
  provider: ModelProvider,
  request: StructuredGenerationRequest<TOutput>,
): Promise<AgentRunOutcome<TOutput>> {
  const result = await provider.generateStructured(request);
  const parsed = request.outputSchema.safeParse(result.output);

  if (!parsed.success) {
    return {
      ok: false,
      reasonCode: "SCHEMA_VALIDATION_FAILED",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      rawOutput: result.rawOutput,
    };
  }

  return { ok: true, result: { ...result, output: parsed.data } };
}
