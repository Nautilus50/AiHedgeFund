import { and, eq } from "drizzle-orm";
import { generateId } from "@arf-os/contracts";
import type { Database } from "@arf-os/db";
import { customers, users } from "@arf-os/db";
import type { BillingProvider } from "./billing-provider.js";

export interface CustomerRow {
  id: string;
  storefrontId: string;
  userId: string;
  providerCustomerId: string | null;
}

export async function findCustomer(db: Database, storefrontId: string, userId: string): Promise<CustomerRow | null> {
  const [row] = await db
    .select({
      id: customers.id,
      storefrontId: customers.storefrontId,
      userId: customers.userId,
      providerCustomerId: customers.providerCustomerId,
    })
    .from(customers)
    .where(and(eq(customers.storefrontId, storefrontId), eq(customers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Get-or-create the buyer record for a signed-in user, including their
 * processor-side customer.
 *
 * The insert is `onConflictDoNothing` on (storefront, user) followed by a
 * re-read, so two checkout requests racing from the same person converge on one
 * customer row instead of one of them failing (CLAUDE.md 3.6).
 */
export async function ensureCustomer(
  db: Database,
  provider: BillingProvider,
  storefrontId: string,
  userId: string,
): Promise<CustomerRow> {
  const existing = await findCustomer(db, storefrontId, userId);
  if (existing?.providerCustomerId) return existing;

  const [user] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error(`No user row for authenticated subject ${userId}.`);
  }

  const { providerCustomerId } = await provider.createCustomer({
    email: user.email,
    displayName: user.displayName,
    metadata: { storefront_id: storefrontId, user_id: userId },
  });

  if (existing) {
    await db.update(customers).set({ providerCustomerId }).where(eq(customers.id, existing.id));
    return { ...existing, providerCustomerId };
  }

  await db
    .insert(customers)
    .values({ id: generateId(), storefrontId, userId, providerCustomerId })
    .onConflictDoNothing({ target: [customers.storefrontId, customers.userId] });

  const created = await findCustomer(db, storefrontId, userId);
  if (!created) {
    throw new Error("Customer row disappeared immediately after insert.");
  }
  return created;
}
