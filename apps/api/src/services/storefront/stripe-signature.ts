import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureFailure =
  | "MISSING_HEADER"
  | "MALFORMED_HEADER"
  | "TIMESTAMP_OUT_OF_TOLERANCE"
  | "NO_MATCHING_SIGNATURE";

export type SignatureResult = { ok: true } | { ok: false; reasonCode: SignatureFailure };

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe `Stripe-Signature` header against the raw request body.
 *
 * Implemented directly rather than through the SDK so the rule that matters —
 * an unverified delivery changes nothing — is a pure function with its own
 * tests. Compares in constant time and enforces a timestamp tolerance, so a
 * captured-and-replayed body stops being accepted once it ages out.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  now: Date = new Date(),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): SignatureResult {
  if (!signatureHeader) {
    return { ok: false, reasonCode: "MISSING_HEADER" };
  }

  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }

  if (!timestamp || candidates.length === 0 || !/^\d+$/.test(timestamp)) {
    return { ok: false, reasonCode: "MALFORMED_HEADER" };
  }

  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (ageSeconds > toleranceSeconds) {
    return { ok: false, reasonCode: "TIMESTAMP_OUT_OF_TOLERANCE" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");

  for (const candidate of candidates) {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    if (candidateBuffer.length !== expectedBuffer.length) continue;
    if (timingSafeEqual(candidateBuffer, expectedBuffer)) {
      return { ok: true };
    }
  }

  return { ok: false, reasonCode: "NO_MATCHING_SIGNATURE" };
}
