import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organisations, users } from "./identity.js";
import { strategyVersions } from "./strategy.js";

/**
 * Storefront domain (ADR 0015). The commercial layer in front of the research
 * registry. No table here stores Pine source: a release points at an immutable
 * strategy_version and the source is read through pine_revisions, so publishing
 * an algo can never fork the lineage (CLAUDE.md 3.1).
 */

export const listingStatusEnum = pgEnum("listing_status", ["DRAFT", "PUBLISHED", "RETIRED"]);
export const releaseStatusEnum = pgEnum("release_status", ["DRAFT", "PUBLISHED", "SUPERSEDED"]);
export const statScopeEnum = pgEnum("stat_scope", ["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER", "CUSTOMER_VERIFIED"]);
export const statSourceKindEnum = pgEnum("stat_source_kind", [
  "BACKTEST_RUN",
  "FORWARD_DEPLOYMENT",
  "CUSTOMER_REPORT_AGGREGATE",
]);
export const marketCategoryEnum = pgEnum("market_category", [
  "CRYPTO",
  "INDEX_FUTURES",
  "FX",
  "COMMODITIES",
  "EQUITIES",
]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["INCOMPLETE", "ACTIVE", "PAST_DUE", "CANCELED"]);
export const entitlementStatusEnum = pgEnum("entitlement_status", ["ACTIVE", "REVOKED"]);
export const entitlementSourceEnum = pgEnum("entitlement_source", [
  "SUBSCRIPTION",
  "COMPLIMENTARY",
  "DEVELOPER_OWN_ALGO",
]);
export const billingProviderEnum = pgEnum("billing_provider", ["STRIPE", "MANUAL"]);
export const billingEventStatusEnum = pgEnum("billing_event_status", ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"]);
export const verifiedResultStatusEnum = pgEnum("verified_result_status", ["SUBMITTED", "APPROVED", "REJECTED"]);
export const developerSubmissionStatusEnum = pgEnum("developer_submission_status", [
  "SUBMITTED",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
]);

/** Public face of exactly one organisation, addressed by slug. Public reads are always slug-scoped. */
export const storefronts = pgTable("storefronts", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" })
    .unique(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  supportEmail: text("support_email").notNull(),
  defaultCurrency: text("default_currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Storefront-wide volume discount ladder. `discountBps` is basis points: 1000 = 10%. */
export const volumeDiscountTiers = pgTable(
  "volume_discount_tiers",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    minAlgos: integer("min_algos").notNull(),
    discountBps: integer("discount_bps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("volume_discount_tiers_storefront_id_min_algos_idx").on(table.storefrontId, table.minAlgos)],
);

/** The commercial object a customer subscribes to. Carries no strategy logic of its own. */
export const algoListings = pgTable(
  "algo_listings",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull().default(""),
    description: text("description").notNull().default(""),
    riskNote: text("risk_note").notNull().default(""),
    marketCategory: marketCategoryEnum("market_category").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    status: listingStatusEnum("status").notNull().default("DRAFT"),
    /** Null for first-party algos; set for an approved third-party developer submission. */
    developerUserId: uuid("developer_user_id").references(() => users.id),
    /** Developer's share of net subscription revenue, in basis points. */
    revenueShareBps: integer("revenue_share_bps").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("algo_listings_storefront_id_slug_idx").on(table.storefrontId, table.slug),
    // The catalogue query: WHERE storefront_id = $1 AND status = 'PUBLISHED' ORDER BY created_at, id.
    index("algo_listings_storefront_id_status_created_at_id_idx").on(
      table.storefrontId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("algo_listings_developer_user_id_idx").on(table.developerUserId),
  ],
);

/**
 * One release per immutable strategy version. Revising an algo means adding a
 * release that points at a new strategy version — never editing a shipped one.
 */
export const algoReleases = pgTable(
  "algo_releases",
  {
    id: uuid("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id, { onDelete: "cascade" }),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    releaseNumber: integer("release_number").notNull(),
    status: releaseStatusEnum("status").notNull().default("DRAFT"),
    changelog: text("changelog").notNull().default(""),
    setupInstructions: text("setup_instructions").notNull().default(""),
    /** Copied at publish time for display and tamper-evidence; the source itself stays in pine_revisions. */
    pineSourceHash: text("pine_source_hash").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("algo_releases_listing_id_release_number_idx").on(table.listingId, table.releaseNumber),
    // A strategy version may be published once per listing — a redelivered
    // publish command cannot create a second identical release.
    uniqueIndex("algo_releases_listing_id_strategy_version_id_idx").on(table.listingId, table.strategyVersionId),
    index("algo_releases_listing_id_status_idx").on(table.listingId, table.status),
  ],
);

/** Monthly list price. At most one active price per listing (partial unique index, added in the migration). */
export const listingPrices = pgTable(
  "listing_prices",
  {
    id: uuid("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    /** Smallest currency unit (cents). Integer — an authoritative total never touches a float. */
    monthlyAmountMinor: integer("monthly_amount_minor").notNull(),
    providerPriceId: text("provider_price_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("listing_prices_listing_id_active_idx").on(table.listingId, table.active),
    // At most one active price per listing: a quote that could pick between
    // two "current" prices is a billing dispute waiting to happen.
    uniqueIndex("listing_prices_one_active_per_listing_idx")
      .on(table.listingId)
      .where(sql`${table.active}`),
  ],
);

/**
 * A published performance claim, always traceable to the run that produced it.
 * The catalogue may not display a number that has no row here (ADR 0015).
 */
export const publishedStatSnapshots = pgTable(
  "published_stat_snapshots",
  {
    id: uuid("id").primaryKey(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => algoReleases.id, { onDelete: "cascade" }),
    scope: statScopeEnum("scope").notNull(),
    sourceKind: statSourceKindEnum("source_kind").notNull(),
    /** backtest_runs.id, forward_deployments.id, or the listing id for a customer aggregate. */
    sourceId: uuid("source_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").notNull(),
    monthlyReturns: jsonb("monthly_returns").notNull().default([]),
    equityCurve: jsonb("equity_curve").notNull().default([]),
    calculationVersion: text("calculation_version").notNull(),
    costsApplied: boolean("costs_applied").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("published_stat_snapshots_release_id_scope_source_id_idx").on(
      table.releaseId,
      table.scope,
      table.sourceId,
    ),
    index("published_stat_snapshots_release_id_idx").on(table.releaseId),
  ],
);

/** A buyer. A user without an organisation membership — deliberately not an ARF-OS researcher. */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerCustomerId: text("provider_customer_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("customers_storefront_id_user_id_idx").on(table.storefrontId, table.userId)],
);

/** Provider-owned state. Only a verified webhook (or an admin manual grant) writes these rows. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    provider: billingProviderEnum("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull().unique(),
    status: subscriptionStatusEnum("status").notNull(),
    currency: text("currency").notNull(),
    totalMinor: integer("total_minor").notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("subscriptions_customer_id_idx").on(table.customerId)],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: uuid("id").primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id),
    listAmountMinor: integer("list_amount_minor").notNull(),
    netAmountMinor: integer("net_amount_minor").notNull(),
  },
  (table) => [
    uniqueIndex("subscription_items_subscription_id_listing_id_idx").on(table.subscriptionId, table.listingId),
  ],
);

/**
 * The single gate on source delivery. One row per (customer, listing) — a
 * customer who resubscribes to an algo they previously cancelled reuses the row
 * instead of accumulating duplicates.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id, { onDelete: "cascade" }),
    source: entitlementSourceEnum("source").notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    status: entitlementStatusEnum("status").notNull().default("ACTIVE"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Access stops at this instant even while the row is ACTIVE (cancel-at-period-end). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("entitlements_customer_id_listing_id_idx").on(table.customerId, table.listingId),
    index("entitlements_subscription_id_idx").on(table.subscriptionId),
  ],
);

/**
 * Webhook idempotency ledger (CLAUDE.md 3.6). The unique provider event id is
 * what makes a redelivered Stripe event a no-op rather than a second grant.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey(),
    provider: billingProviderEnum("provider").notNull(),
    providerEventId: text("provider_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: billingEventStatusEnum("status").notNull().default("RECEIVED"),
    failureReason: text("failure_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [index("billing_events_status_received_at_idx").on(table.status, table.receivedAt)],
);

/** The quote we showed, kept so the webhook can rebuild the subscription exactly as priced. */
export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    provider: billingProviderEnum("provider").notNull(),
    providerSessionId: text("provider_session_id").notNull().unique(),
    quote: jsonb("quote").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("checkout_sessions_customer_id_idx").on(table.customerId)],
);

/** Customer-submitted broker statements. Nothing counts toward published stats until APPROVED. */
export const customerVerifiedResults = pgTable(
  "customer_verified_results",
  {
    id: uuid("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    broker: text("broker").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** Whole percent, as a numeric string. `12.5` is 12.5%, not 1250%. */
    netReturnPct: text("net_return_pct").notNull(),
    statementObjectKey: text("statement_object_key").notNull(),
    statementChecksum: text("statement_checksum").notNull(),
    status: verifiedResultStatusEnum("status").notNull().default("SUBMITTED"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_verified_results_listing_customer_period_idx").on(
      table.listingId,
      table.customerId,
      table.periodStart,
      table.periodEnd,
    ),
    index("customer_verified_results_listing_id_status_idx").on(table.listingId, table.status),
  ],
);

/** A third-party developer proposing an existing strategy version for the catalogue. */
export const developerSubmissions = pgTable(
  "developer_submissions",
  {
    id: uuid("id").primaryKey(),
    storefrontId: uuid("storefront_id")
      .notNull()
      .references(() => storefronts.id, { onDelete: "cascade" }),
    developerUserId: uuid("developer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    proposedName: text("proposed_name").notNull(),
    proposedTagline: text("proposed_tagline").notNull().default(""),
    notes: text("notes").notNull().default(""),
    status: developerSubmissionStatusEnum("status").notNull().default("SUBMITTED"),
    reviewNotes: text("review_notes"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    listingId: uuid("listing_id").references(() => algoListings.id, { onDelete: "set null" }),
    revenueShareBps: integer("revenue_share_bps").notNull().default(3000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A developer submits a given strategy version to a storefront once.
    uniqueIndex("developer_submissions_storefront_version_idx").on(table.storefrontId, table.strategyVersionId),
    index("developer_submissions_storefront_id_status_idx").on(table.storefrontId, table.status),
  ],
);

/** Monthly accrual of a developer's revenue share. One row per (listing, month). */
export const developerPayoutAccruals = pgTable(
  "developer_payout_accruals",
  {
    id: uuid("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => algoListings.id, { onDelete: "cascade" }),
    developerUserId: uuid("developer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** UTC calendar month, `YYYY-MM`. */
    periodMonth: text("period_month").notNull(),
    currency: text("currency").notNull(),
    netRevenueMinor: integer("net_revenue_minor").notNull(),
    shareBps: integer("share_bps").notNull(),
    accruedMinor: integer("accrued_minor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("developer_payout_accruals_listing_id_period_month_idx").on(table.listingId, table.periodMonth),
  ],
);
