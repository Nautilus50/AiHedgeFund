import type {
  BillingProvider,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreatedCheckout,
  ProviderSubscriptionSnapshot,
  VerifiedProviderEvent,
} from "./billing-provider.js";
import { verifyStripeSignature } from "./stripe-signature.js";

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Stripe adapter over the REST API. Deliberately thin: it translates our
 * domain input into Stripe calls and Stripe responses back into our types, and
 * holds no storefront logic of its own (CLAUDE.md 11.1's provider rule applied
 * to billing).
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = "STRIPE" as const;

  readonly #secretKey: string;
  readonly #webhookSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: StripeProviderOptions) {
    this.#secretKey = options.secretKey;
    this.#webhookSecret = options.webhookSecret;
    this.#baseUrl = options.apiBaseUrl ?? STRIPE_API_BASE;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ providerCustomerId: string }> {
    const form: Record<string, string> = { email: input.email };
    if (input.displayName) form.name = input.displayName;
    for (const [key, value] of Object.entries(input.metadata)) {
      form[`metadata[${key}]`] = value;
    }
    const created = await this.#post<{ id: string }>("/customers", form);
    return { providerCustomerId: created.id };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    const form: Record<string, string> = {
      mode: "subscription",
      customer: input.providerCustomerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    };

    // One line item per algo, priced at the quoted net amount. Prices are sent
    // inline rather than referenced so the customer is charged exactly the
    // total the quote showed, discount included — the two can never drift.
    input.quote.lines.forEach((line, index) => {
      form[`line_items[${index}][quantity]`] = "1";
      form[`line_items[${index}][price_data][currency]`] = input.quote.currency.toLowerCase();
      form[`line_items[${index}][price_data][unit_amount]`] = String(line.netAmountMinor);
      form[`line_items[${index}][price_data][recurring][interval]`] = "month";
      form[`line_items[${index}][price_data][product_data][name]`] = line.name;
      form[`line_items[${index}][price_data][product_data][metadata][listing_id]`] = line.listingId;
    });

    for (const [key, value] of Object.entries(input.metadata)) {
      form[`metadata[${key}]`] = value;
      form[`subscription_data[metadata][${key}]`] = value;
    }

    const session = await this.#post<{ id: string; url: string | null }>("/checkout/sessions", form, input.idempotencyKey);
    if (!session.url) {
      throw new Error("Stripe returned a checkout session without a redirect URL.");
    }
    return { providerSessionId: session.id, redirectUrl: session.url };
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null> {
    const response = await this.#request(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
      method: "GET",
    });
    if (response.status === 404) return null;
    const body = (await this.#parse(response)) as StripeSubscription;
    return toSnapshot(body);
  }

  async cancelAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot> {
    const body = await this.#post<StripeSubscription>(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
      cancel_at_period_end: "true",
    });
    return toSnapshot(body);
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): VerifiedProviderEvent | null {
    const verified = verifyStripeSignature(rawBody, signatureHeader, this.#webhookSecret);
    if (!verified.ok) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;
    const event = parsed as { id?: unknown; type?: unknown };
    if (typeof event.id !== "string" || typeof event.type !== "string") return null;

    return { providerEventId: event.id, type: event.type, payload: parsed };
  }

  async #post<T>(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await this.#request(path, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
    return (await this.#parse(response)) as T;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${this.#secretKey}`,
      },
    });
  }

  async #parse(response: Response): Promise<unknown> {
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      // Stripe error messages can echo request content; only the safe code and
      // status escape this adapter, never the key or the raw error body.
      const code =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error?: { code?: unknown } }).error?.code ?? "unknown")
          : "unknown";
      throw new Error(`Stripe request failed (status ${response.status}, code ${code}).`);
    }
    return body;
  }
}

interface StripeSubscription {
  id: string;
  status: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
}

/**
 * Stripe's status vocabulary is wider than ours. Unknown or in-between states
 * map to INCOMPLETE — the state that grants nothing — rather than being
 * silently coerced to ACTIVE (CLAUDE.md 8).
 */
export function toSnapshot(subscription: StripeSubscription): ProviderSubscriptionSnapshot {
  const status =
    subscription.status === "active" || subscription.status === "trialing"
      ? "ACTIVE"
      : subscription.status === "past_due" || subscription.status === "unpaid"
        ? "PAST_DUE"
        : subscription.status === "canceled" || subscription.status === "incomplete_expired"
          ? "CANCELED"
          : "INCOMPLETE";

  return {
    providerSubscriptionId: subscription.id,
    status,
    currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
  };
}
