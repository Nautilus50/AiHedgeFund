import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "./stripe-signature.js";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const NOW = new Date("2026-08-25T12:00:00.000Z");

function sign(body: string, at: Date, secret = SECRET): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyStripeSignature(BODY, sign(BODY, NOW), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts when one of several v1 signatures matches (secret rotation)", () => {
    const header = `${sign(BODY, NOW, "whsec_old")},v1=${createHmac("sha256", SECRET)
      .update(`${Math.floor(NOW.getTime() / 1000)}.${BODY}`)
      .digest("hex")}`;
    expect(verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it("rejects a body that changed after signing", () => {
    const header = sign(BODY, NOW);
    const tampered = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", extra: true });
    expect(verifyStripeSignature(tampered, header, SECRET, NOW)).toMatchObject({ reasonCode: "NO_MATCHING_SIGNATURE" });
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyStripeSignature(BODY, sign(BODY, NOW, "whsec_attacker"), SECRET, NOW)).toMatchObject({
      reasonCode: "NO_MATCHING_SIGNATURE",
    });
  });

  it("rejects a replay outside the tolerance window", () => {
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(verifyStripeSignature(BODY, sign(BODY, stale), SECRET, NOW)).toMatchObject({
      reasonCode: "TIMESTAMP_OUT_OF_TOLERANCE",
    });
  });

  it("accepts a delivery inside the tolerance window", () => {
    const recent = new Date(NOW.getTime() - 60 * 1000);
    expect(verifyStripeSignature(BODY, sign(BODY, recent), SECRET, NOW)).toEqual({ ok: true });
  });

  it("rejects a missing or malformed header rather than throwing", () => {
    expect(verifyStripeSignature(BODY, undefined, SECRET, NOW)).toMatchObject({ reasonCode: "MISSING_HEADER" });
    expect(verifyStripeSignature(BODY, "nonsense", SECRET, NOW)).toMatchObject({ reasonCode: "MALFORMED_HEADER" });
    expect(verifyStripeSignature(BODY, "t=abc,v1=def", SECRET, NOW)).toMatchObject({ reasonCode: "MALFORMED_HEADER" });
    expect(verifyStripeSignature(BODY, `t=${Math.floor(NOW.getTime() / 1000)}`, SECRET, NOW)).toMatchObject({
      reasonCode: "MALFORMED_HEADER",
    });
  });
});
