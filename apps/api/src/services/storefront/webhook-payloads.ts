import { z } from "zod";

/**
 * Processor webhook payloads are untrusted input, so they are validated with
 * Zod before any state changes (CLAUDE.md 3.3). Only the fields the storefront
 * actually acts on are modelled; anything else in the payload is ignored rather
 * than inferred.
 */

export const CheckoutSessionCompleted = z.object({
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      /** Stripe sends the subscription id once the session converts. */
      subscription: z.string().min(1),
      currency: z.string().min(1).optional(),
      metadata: z
        .object({
          checkout_session_id: z.string().uuid().optional(),
          storefront_id: z.string().uuid().optional(),
          customer_id: z.string().uuid().optional(),
        })
        .default({}),
    }),
  }),
});
export type CheckoutSessionCompleted = z.infer<typeof CheckoutSessionCompleted>;

export const SubscriptionLifecycleEvent = z.object({
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      current_period_end: z.number().int().positive().nullable().optional(),
      cancel_at_period_end: z.boolean().optional(),
    }),
  }),
});
export type SubscriptionLifecycleEvent = z.infer<typeof SubscriptionLifecycleEvent>;
