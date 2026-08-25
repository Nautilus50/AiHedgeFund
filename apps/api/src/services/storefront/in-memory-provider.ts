import { createHmac } from "node:crypto";
import type {
  BillingProvider,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreatedCheckout,
  ProviderSubscriptionSnapshot,
  VerifiedProviderEvent,
} from "./billing-provider.js";
import { verifyStripeSignature } from "./stripe-signature.js";

/**
 * Deterministic in-process billing provider for tests and local development.
 * It uses the same webhook signature scheme as Stripe, so a test that drives a
 * checkout through this provider exercises the real verification path rather
 * than a bypass.
 */
export class InMemoryBillingProvider implements BillingProvider {
  readonly name = "STRIPE" as const;

  readonly webhookSecret: string;
  readonly customers = new Map<string, CreateCustomerInput>();
  readonly checkouts = new Map<string, CreateCheckoutInput>();
  readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>();

  #sequence = 0;

  constructor(webhookSecret = "whsec_in_memory") {
    this.webhookSecret = webhookSecret;
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ providerCustomerId: string }> {
    const providerCustomerId = `cus_test_${++this.#sequence}`;
    this.customers.set(providerCustomerId, input);
    return { providerCustomerId };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    // Keyed by the caller's idempotency key so a retried command returns the
    // same session instead of opening a second one.
    const existing = [...this.checkouts.entries()].find(
      ([, candidate]) => candidate.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return { providerSessionId: existing[0], redirectUrl: `https://billing.test/checkout/${existing[0]}` };
    }
    const providerSessionId = `cs_test_${++this.#sequence}`;
    this.checkouts.set(providerSessionId, input);
    return { providerSessionId, redirectUrl: `https://billing.test/checkout/${providerSessionId}` };
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null> {
    return this.subscriptions.get(providerSubscriptionId) ?? null;
  }

  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot> {
    const existing = this.subscriptions.get(providerSubscriptionId);
    if (!existing) throw new Error(`Unknown subscription ${providerSubscriptionId}.`);
    const updated = { ...existing, cancelAtPeriodEnd: true };
    this.subscriptions.set(providerSubscriptionId, updated);
    return updated;
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): VerifiedProviderEvent | null {
    const verified = verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret);
    if (!verified.ok) return null;
    const parsed = JSON.parse(rawBody) as { id?: unknown; type?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.type !== "string") return null;
    return { providerEventId: parsed.id, type: parsed.type, payload: parsed };
  }

  /** Test helper: signs a body exactly the way the provider expects to receive it. */
  signatureFor(rawBody: string, at: Date = new Date()): string {
    const timestamp = Math.floor(at.getTime() / 1000);
    const signature = createHmac("sha256", this.webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
    return `t=${timestamp},v1=${signature}`;
  }

  /** Test helper: registers a provider-side subscription a webhook can then reference. */
  seedSubscription(snapshot: ProviderSubscriptionSnapshot): void {
    this.subscriptions.set(snapshot.providerSubscriptionId, snapshot);
  }
}
