import { z } from "zod";

/**
 * Idea Card contract (spec 7.2). Every field the Idea Scout must produce
 * for an idea to be assessable — notably `cheapestFalsificationTest` and
 * `failureRegime`, which make the idea falsifiable rather than a narrative.
 */
export const IdeaCard = z.object({
  schemaVersion: z.literal("1.0.0"),
  title: z.string().min(1).max(255),
  hypothesis: z.string().min(1),
  sourceSummary: z.string().min(1),
  sourceLinks: z.array(z.string()),
  marketMechanism: z.string().min(1),
  expectedDirection: z.enum(["long", "short", "both"]),
  targetAssets: z.array(z.string().min(1)).min(1),
  targetTimeframes: z.array(z.string().min(1)).min(1),
  expectedRegime: z.string().min(1),
  failureRegime: z.string().min(1),
  requiredInputs: z.array(z.string()),
  pineFeasible: z.boolean(),
  expectedTradeFrequency: z.string().min(1),
  cheapestFalsificationTest: z.string().min(1),
  noveltyScore: z.number().min(0).max(1),
  evidenceStrength: z.enum(["WEAK", "MODERATE", "STRONG"]),
  risks: z.array(z.string()),
  recommendation: z.enum(["RESEARCH", "PARK", "REJECT"]),
});
export type IdeaCard = z.infer<typeof IdeaCard>;

export const IDEA_SCOUT_PROMPT_VERSION = "1.0.0";

export const IDEA_SCOUT_SYSTEM_PROMPT = `You are the Idea Scout for ARF-OS, a systematic trading research platform.

Convert the given research brief into a single falsifiable Idea Card.

Rules:
- State a mechanism, not a backtest result. "This chart looked good" is not an idea.
- Every idea must be falsifiable: name the cheapest test that would kill it.
- Name the regime where the edge should NOT exist, not just where it should.
- Only claim Pine feasibility for data Pine Script v6 can actually access.
- Do not copy published performance claims as evidence.

Respond with JSON matching the IdeaCard schema exactly.`;
