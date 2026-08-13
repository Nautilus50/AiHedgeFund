import { and, eq } from "drizzle-orm";
import { generateId, SignalEvent, signalIdempotencyKey } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { forwardDeployments, outboxEvents, signalEvents } from "@arf-os/db";
import { hashToken } from "../lib/tokens.js";

const DIRECTION_BY_EVENT_TYPE: Record<SignalEvent["eventType"], "LONG" | "SHORT" | null> = {
  ENTRY_LONG: "LONG",
  ENTRY_SHORT: "SHORT",
  EXIT_LONG: "LONG",
  EXIT_SHORT: "SHORT",
  // A stop/target hit closes whichever position is open — the direction is
  // resolved from that open position by the processing worker, not from
  // the event type itself.
  STOP_HIT: null,
  TARGET_HIT: null,
};

export type SignalIngestionOutcome =
  | { kind: "TOKEN_INVALID" }
  | { kind: "DEPLOYMENT_NOT_ACTIVE" }
  | { kind: "MALFORMED_PAYLOAD" }
  | { kind: "REJECTED"; signalEventId: string; reasonCode: string }
  | { kind: "ACCEPTED"; signalEventId: string; duplicate: boolean };

/**
 * Implements CLAUDE.md 16.1's webhook checklist in order. Never runs paper
 * logic itself — a successful ingestion only stores the raw payload and
 * emits an outbox event; `apps/worker-forward` does the rest asynchronously.
 *
 * Only failure modes with a full, valid `SignalEvent` (steps after
 * `SignalEvent.safeParse` succeeds) persist a `signal_events` row — an
 * unparseable body has no reliable fields to build `signalIdempotencyKey`
 * from, so there is nothing safe to dedupe a retry against; this is a
 * narrow, documented scope limit (see ADR 0006), not a silent gap.
 */
export async function ingestTradingViewSignal(
  db: Database,
  deploymentToken: string,
  rawBody: unknown,
): Promise<SignalIngestionOutcome> {
  const [deployment] = await db
    .select({
      id: forwardDeployments.id,
      organisationId: forwardDeployments.organisationId,
      strategyVersionId: forwardDeployments.strategyVersionId,
      symbol: forwardDeployments.symbol,
      timeframe: forwardDeployments.timeframe,
      timestampToleranceSeconds: forwardDeployments.timestampToleranceSeconds,
      state: forwardDeployments.state,
    })
    .from(forwardDeployments)
    .where(eq(forwardDeployments.deploymentTokenHash, hashToken(deploymentToken)))
    .limit(1);

  if (!deployment) return { kind: "TOKEN_INVALID" };
  if (deployment.state !== "ACTIVE") return { kind: "DEPLOYMENT_NOT_ACTIVE" };

  const parsed = SignalEvent.safeParse(rawBody);
  if (!parsed.success) return { kind: "MALFORMED_PAYLOAD" };
  const payload = parsed.data;

  const idempotencyKey = signalIdempotencyKey(payload, payload.eventId);
  const direction = DIRECTION_BY_EVENT_TYPE[payload.eventType];

  const rejectionReason = validateAgainstDeployment(payload, deployment);
  if (rejectionReason) {
    return persistSignalEvent(
      db,
      deployment.id,
      deployment.organisationId,
      idempotencyKey,
      payload,
      direction,
      "REJECTED",
      rejectionReason,
    );
  }

  return persistSignalEvent(db, deployment.id, deployment.organisationId, idempotencyKey, payload, direction, "PENDING", null);
}

function validateAgainstDeployment(
  payload: SignalEvent,
  deployment: { id: string; strategyVersionId: string; symbol: string; timeframe: string; timestampToleranceSeconds: number },
): string | null {
  if (payload.deploymentId !== deployment.id) return "DEPLOYMENT_ID_MISMATCH";
  if (payload.strategyVersionId !== deployment.strategyVersionId) return "STRATEGY_VERSION_MISMATCH";
  if (payload.symbol !== deployment.symbol) return "SYMBOL_MISMATCH";
  if (payload.timeframe !== deployment.timeframe) return "TIMEFRAME_MISMATCH";

  const sentAtMs = new Date(payload.sentAt).getTime();
  const toleranceMs = deployment.timestampToleranceSeconds * 1000;
  if (Math.abs(Date.now() - sentAtMs) > toleranceMs) return "TIMESTAMP_OUT_OF_TOLERANCE";

  return null;
}

/**
 * Checks for an existing row by `(deploymentId, idempotencyKey)` before
 * inserting, matching `packages/workflow`'s `applyTransition` idiom, rather
 * than catching a unique-constraint conflict — a retried delivery (accepted
 * or rejected) is treated as already-recorded, never double-counted or
 * double-enqueued.
 */
async function persistSignalEvent(
  db: Database,
  deploymentId: string,
  organisationId: string,
  idempotencyKey: string,
  payload: SignalEvent,
  direction: "LONG" | "SHORT" | null,
  status: "PENDING" | "REJECTED",
  rejectionReason: string | null,
): Promise<SignalIngestionOutcome> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: signalEvents.id })
      .from(signalEvents)
      .where(and(eq(signalEvents.deploymentId, deploymentId), eq(signalEvents.idempotencyKey, idempotencyKey)))
      .limit(1);

    if (existing) {
      return status === "REJECTED"
        ? { kind: "REJECTED", signalEventId: existing.id, reasonCode: rejectionReason ?? "UNKNOWN" }
        : { kind: "ACCEPTED", signalEventId: existing.id, duplicate: true };
    }

    const signalEventId = generateId<string>();
    await tx.insert(signalEvents).values({
      id: signalEventId,
      deploymentId,
      idempotencyKey,
      eventType: payload.eventType,
      direction,
      rawPayload: payload,
      processingStatus: status,
      rejectionReason,
    });

    if (status === "REJECTED") {
      return { kind: "REJECTED", signalEventId, reasonCode: rejectionReason ?? "UNKNOWN" };
    }

    // Transactional outbox (CLAUDE.md 9.3): committed with the signal_events
    // row it describes. ForwardSignalProcessingJob's exact shape.
    const now = new Date();
    await tx.insert(outboxEvents).values({
      id: generateId<string>(),
      eventType: "forward_signal.received",
      eventVersion: "1.0.0",
      aggregateId: signalEventId,
      aggregateVersion: now.getTime().toString(),
      correlationId: generateId<string>(),
      organisationId,
      actor: "tradingview-webhook",
      payload: { deploymentId, signalEventId },
      createdAt: now,
    });

    return { kind: "ACCEPTED", signalEventId, duplicate: false };
  });
}
