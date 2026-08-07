import { z } from "zod";

/**
 * Domain event envelope (spec 14.8). Published via the transactional
 * outbox pattern so events are never lost or duplicated by a crashed
 * transaction (CLAUDE.md 9.3).
 */
export const DomainEvent = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().min(1),
  eventVersion: z.string().min(1),
  aggregateId: z.string().uuid(),
  aggregateVersion: z.number().int().min(0),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  actor: z.string().min(1),
  createdAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
  traceId: z.string().min(1).optional(),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

export const DomainEventType = z.enum([
  "campaign.created",
  "task.assigned",
  "agent_run.completed",
  "handoff.accepted",
  "strategy_version.created",
  "pine_compile.failed",
  "backtest.completed",
  "backtest.parity_failed",
  "validation.completed",
  "gate.passed",
  "gate.failed",
  "forward_signal.received",
  "forward_deployment.degraded",
  "committee_decision.created",
]);
export type DomainEventType = z.infer<typeof DomainEventType>;
