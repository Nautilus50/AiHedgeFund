import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  resolveAuthContext,
  resolveCustomerContext,
  verifyClerkToken,
  type AuthContext,
  type CustomerContext,
} from "@arf-os/auth";
import type { Database } from "@arf-os/db";
import { memberships, organisations, users } from "@arf-os/db";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only when the request carried a valid, organisation-scoped Clerk session. Undefined for anonymous requests — route handlers that need auth call request.requireAuth(). */
    auth?: AuthContext;
    /** Returns the resolved AuthContext, or throws a 401-mapped error if the request is unauthenticated. */
    requireAuth(): AuthContext;
    /**
     * Set whenever the bearer token resolves to a known user, with or without
     * an organisation. Storefront buyers authenticate here (ADR 0015).
     */
    customer?: CustomerContext;
    /** Returns the resolved CustomerContext, or throws a 401-mapped error. */
    requireCustomer(): CustomerContext;
  }
}

export interface AuthPluginOptions {
  db: Database;
  clerkSecretKey: string;
}

/**
 * Resolves `request.auth` from the `Authorization: Bearer <token>` header on
 * every request. Does NOT reject unauthenticated requests itself — routes
 * that require auth call `request.requireAuth()` (added by this plugin),
 * which throws a typed 401 the Fastify error handler maps to a
 * problem-details response (CLAUDE.md 7.5, 17.1: route handlers stay thin;
 * auth/authorise/validate happens before the application service is called).
 */
export async function registerAuth(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  app.decorateRequest("auth", undefined);
  app.decorateRequest("customer", undefined);

  app.decorateRequest("requireAuth", function requireAuth(this: { auth?: AuthContext }): AuthContext {
    if (!this.auth) {
      const error = new Error("Authentication required.");
      error.name = "UnauthorizedError";
      throw error;
    }
    return this.auth;
  });

  app.decorateRequest("requireCustomer", function requireCustomer(this: { customer?: CustomerContext }): CustomerContext {
    if (!this.customer) {
      const error = new Error("Authentication required.");
      error.name = "UnauthorizedError";
      throw error;
    }
    return this.customer;
  });

  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return;
    }

    const token = header.slice("Bearer ".length);
    const claims = await verifyClerkToken(token, options.clerkSecretKey);
    if (!claims) {
      return;
    }

    const [userRow] = await options.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalAuthSubject, claims.subject))
      .limit(1);

    const organisationRow = claims.clerkOrganisationId
      ? (
          await options.db
            .select({ id: organisations.id })
            .from(organisations)
            .where(eq(organisations.clerkOrganisationId, claims.clerkOrganisationId))
            .limit(1)
        )[0]
      : undefined;

    const membershipRow =
      userRow && organisationRow
        ? (
            await options.db
              .select({ userId: memberships.userId, organisationId: memberships.organisationId, role: memberships.role })
              .from(memberships)
              .where(and(eq(memberships.userId, userRow.id), eq(memberships.organisationId, organisationRow.id)))
              .limit(1)
          )[0]
        : undefined;

    // Buyer identity is resolved first and independently: a personal session
    // has no org claim at all, and an org-scoped researcher session must not
    // gain storefront powers from its research role (or vice versa).
    const customerResult = resolveCustomerContext(claims, userRow);
    if (customerResult.ok) {
      request.customer = customerResult.context;
    }

    const result = resolveAuthContext(claims, userRow, organisationRow, membershipRow);
    if (result.ok) {
      request.auth = result.context;
    }
    // Rejections are not thrown here — an unauthenticated `request.auth` is
    // the expected shape for anonymous-allowed routes. Protected routes
    // call request.requireAuth() and get a 401 at that point instead.
  });
}
