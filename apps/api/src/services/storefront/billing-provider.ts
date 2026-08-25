import type { SubscriptionQuote } from "@arf-os/contracts";

/**
 * The storefront's whole dependency on a payment processor (ADR 0015). Keeping
 * it this narrow is what lets the entitlement and webhook logic be tested
 * without a network, and what makes swapping processors a contained change.
 */

export interface CreateCustomerInput {
  email: string;
  displayName: string | null;
  /** Correlates the processor's customer back to our row without trusting client input later. */
  metadata: Record<string, string>;
}

export interface CreateCheckoutInput {
  providerCustomerId: string;
  quote: SubscriptionQuote;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  /** Passed to the processor so a retried command reuses the same session. */
  idempotencyKey: string;
}

export interface CreatedCheckout {
  providerSessionId: string;
  redirectUrl: string;
}

export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string;
  status: "INCOMPLETE" | "ACTIVE" | "PAST_DUE" | "CANCELED";
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** A webhook delivery that has already passed signature verification. */
export interface VerifiedProviderEvent {
  providerEventId: string;
  type: string;
  payload: unknown;
}

export interface BillingProvider {
  readonly name: "STRIPE" | "MANUAL";
  createCustomer(input: CreateCustomerInput): Promise<{ providerCustomerId: string }>;
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null>;
  cancelAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot>;
  /**
   * Returns null when the signature does not verify. Callers must treat null as
   * "drop it" — never as "process it anyway" (ADR 0015 security implications).
   */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): VerifiedProviderEvent | null;
}
