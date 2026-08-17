import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { verifyClerkWebhook } from "./clerk-client.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function signedRequest(secret: string, payload: object): Request {
  const body = JSON.stringify(payload);
  const msgId = "msg_test_1";
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(msgId, timestamp, body);

  return new Request("https://example.com/v1/webhooks/clerk", {
    method: "POST",
    headers: {
      "svix-id": msgId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

describe("verifyClerkWebhook", () => {
  const payload = { type: "organizationMembership.created", data: { id: "orgmem_test" } };

  it("verifies a correctly signed request and returns the parsed event", async () => {
    const event = await verifyClerkWebhook(signedRequest(SECRET, payload), SECRET);
    expect(event).toMatchObject(payload);
  });

  it("rejects a request signed with a different secret", async () => {
    const wrongSecret = "whsec_1111111111111111111111111111111111";
    const request = signedRequest(wrongSecret, payload);
    expect(await verifyClerkWebhook(request, SECRET)).toBeUndefined();
  });

  it("rejects a request whose body was tampered with after signing", async () => {
    const request = signedRequest(SECRET, payload);
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...payload, data: { id: "orgmem_attacker_controlled" } }),
    });
    expect(await verifyClerkWebhook(tampered, SECRET)).toBeUndefined();
  });

  it("rejects a request missing the svix headers", async () => {
    const request = new Request("https://example.com/v1/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(await verifyClerkWebhook(request, SECRET)).toBeUndefined();
  });
});
