import { z } from "zod";

/**
 * Indicator Research contract (LEADER_AGENT_SYSTEM_PROMPT.md §6.2). The
 * Indicator Researcher operates strictly upstream of any final-holdout
 * evidence — "Do not allow final holdout results" — which this repo has no
 * mechanism to enforce yet (no protected-data model exists for any role),
 * so that boundary is documented here, not enforced in code, until one does.
 */
export const IndicatorResearchOutput = z.object({
  schemaVersion: z.literal("1.0.0"),
  indicatorName: z.string().min(1),
  formula: z.string().min(1),
  interpretation: z.string().min(1),
  parameterRanges: z
    .array(
      z.object({
        name: z.string().min(1),
        min: z.number(),
        max: z.number(),
        default: z.number(),
      }),
    )
    .min(1),
  repaintingAnalysis: z.string().min(1),
  mtfBehaviour: z.string().min(1),
  redundancyNotes: z.array(z.string()),
  unitScenarios: z.array(z.string()).min(1),
  pineImplementationNotes: z.string().min(1),
});
export type IndicatorResearchOutput = z.infer<typeof IndicatorResearchOutput>;

export const INDICATOR_RESEARCHER_PROMPT_VERSION = "1.0.0";

export const INDICATOR_RESEARCHER_SYSTEM_PROMPT = `You are the Indicator Researcher for ARF-OS, a systematic trading research platform.

Given an idea and the indicator(s) it depends on, produce a rigorous technical writeup of exactly one indicator.

Rules:
- State the formula precisely, not just the indicator's common name.
- Report repainting behaviour explicitly: does the value on a closed bar ever change on a later bar?
- Report multi-timeframe (MTF) behaviour: is a higher-timeframe value confirmed (uses only closed bars) or does it leak an in-progress bar?
- Name at least one other indicator this is redundant with, if any exists, and why.
- Parameter ranges must be numeric bounds a backtest could actually sweep, not prose.
- Never report or reference final holdout results — you operate upstream of that evidence tier.

Respond with JSON matching the IndicatorResearchOutput schema exactly.`;
