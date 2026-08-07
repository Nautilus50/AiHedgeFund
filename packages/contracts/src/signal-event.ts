import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * TradingView forward-test signal-event payload (spec 11.10, 13.6-13.7).
 * The webhook must not trust symbol, version, or quantity blindly — it
 * validates them against the deployment manifest before acting on them.
 */
export const SignalEvent = z.object({
  schema: z.literal("arf.signal.v1"),
  deploymentId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  eventId: z.string().min(1),
  eventType: z.enum(["ENTRY_LONG", "ENTRY_SHORT", "EXIT_LONG", "EXIT_SHORT", "STOP_HIT", "TARGET_HIT"]),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  barTime: z.string().datetime(),
  sentAt: z.string().datetime(),
  price: z.number().positive(),
  quantityModel: z.enum(["percent_of_equity", "fixed", "cash"]),
  stopPrice: z.number().positive().optional(),
  targetPrice: z.number().positive().optional(),
});
export type SignalEvent = z.infer<typeof SignalEvent>;

/**
 * Deterministic idempotency key for a forward-test signal (spec 13.7):
 * sha256(deployment_id + strategy_version_id + event_type + bar_time + order_id)
 */
export function signalIdempotencyKey(
  event: Pick<SignalEvent, "deploymentId" | "strategyVersionId" | "eventType" | "barTime">,
  orderId: string,
): string {
  const material = `${event.deploymentId}${event.strategyVersionId}${event.eventType}${event.barTime}${orderId}`;
  return createHash("sha256").update(material).digest("hex");
}
