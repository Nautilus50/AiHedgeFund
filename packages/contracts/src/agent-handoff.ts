import { z } from "zod";
import { AgentRole } from "./enums.js";

/**
 * Common envelope for every agent-to-agent handoff
 * (AI_RESEARCH_HEDGE_FUND_SPEC.md 8). Structured data is canonical; prose
 * summaries are explanatory only (spec 8.2).
 */
export const AgentHandoff = z.object({
  schemaVersion: z.literal("1.0.0"),
  handoffId: z.string().uuid(),
  campaignId: z.string().uuid(),
  strategyId: z.string().uuid().nullable(),
  strategyVersionId: z.string().uuid().nullable(),
  fromAgent: z.object({
    role: AgentRole,
    agentId: z.string().min(1),
    promptVersion: z.string().min(1),
  }),
  toRole: AgentRole,
  taskId: z.string().uuid(),
  status: z.enum(["COMPLETE", "BLOCKED", "FAILED"]),
  summary: z.string().min(1),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  riskFlags: z.array(z.string()),
  artefactIds: z.array(z.string().uuid()),
  evidenceIds: z.array(z.string().uuid()),
  requestedAction: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AgentHandoff = z.infer<typeof AgentHandoff>;
