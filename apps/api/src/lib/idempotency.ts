import { eq } from "drizzle-orm";
import { fingerprint } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { idempotencyRecords } from "@arf-os/db";

export type IdempotencyOutcome =
  | { status: "FRESH" }
  | { status: "REPLAY"; storedResponse: unknown }
  | { status: "CONFLICT" };

/**
 * Pure decision given a (possibly absent) stored record and the fingerprint
 * of the current request body — no I/O, so the CONFLICT/REPLAY/FRESH logic
 * is unit-testable without a database (spec 14.11 — "Reject key reuse with
 * a different request body").
 */
export function evaluateIdempotency(
  existing: { requestHash: string; responseBody: unknown } | undefined,
  requestFingerprint: string,
): IdempotencyOutcome {
  if (!existing) {
    return { status: "FRESH" };
  }
  if (existing.requestHash !== requestFingerprint) {
    return { status: "CONFLICT" };
  }
  return { status: "REPLAY", storedResponse: existing.responseBody };
}

export async function checkIdempotency(
  db: Database,
  idempotencyKey: string,
  requestBody: unknown,
): Promise<IdempotencyOutcome> {
  const [existing] = await db
    .select({ requestHash: idempotencyRecords.requestHash, responseBody: idempotencyRecords.responseBody })
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.idempotencyKey, idempotencyKey))
    .limit(1);

  return evaluateIdempotency(existing, fingerprint(requestBody));
}

export async function recordIdempotency(
  db: Database,
  input: { idempotencyKey: string; organisationId: string; requestBody: unknown; responseBody: unknown },
): Promise<void> {
  await db.insert(idempotencyRecords).values({
    idempotencyKey: input.idempotencyKey,
    organisationId: input.organisationId,
    requestHash: fingerprint(input.requestBody),
    responseBody: input.responseBody,
  });
}
