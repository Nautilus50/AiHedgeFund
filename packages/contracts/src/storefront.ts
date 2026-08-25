import { z } from "zod";

/**
 * Storefront contracts (ADR 0015). Version 1.
 *
 * The commercial layer that sits in front of the research registry. Nothing in
 * here carries Pine source: a listing release points at an immutable
 * `strategy_version`, and the source is always read through that version.
 */
export const STOREFRONT_CONTRACT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const ListingStatus = z.enum(["DRAFT", "PUBLISHED", "RETIRED"]);
export type ListingStatus = z.infer<typeof ListingStatus>;

export const ReleaseStatus = z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

/**
 * Evidence scope of a published number. Never merged into a single series in
 * the UI (CLAUDE.md 18.1) — an in-sample curve and a forward paper curve are
 * different claims about the world.
 */
export const StatScope = z.enum(["IN_SAMPLE", "OUT_OF_SAMPLE", "FORWARD_PAPER", "CUSTOMER_VERIFIED"]);
export type StatScope = z.infer<typeof StatScope>;

export const StatSourceKind = z.enum(["BACKTEST_RUN", "FORWARD_DEPLOYMENT", "CUSTOMER_REPORT_AGGREGATE"]);
export type StatSourceKind = z.infer<typeof StatSourceKind>;

export const SubscriptionStatus = z.enum(["INCOMPLETE", "ACTIVE", "PAST_DUE", "CANCELED"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const EntitlementStatus = z.enum(["ACTIVE", "REVOKED"]);
export type EntitlementStatus = z.infer<typeof EntitlementStatus>;

export const EntitlementSource = z.enum(["SUBSCRIPTION", "COMPLIMENTARY", "DEVELOPER_OWN_ALGO"]);
export type EntitlementSource = z.infer<typeof EntitlementSource>;

export const BillingProviderName = z.enum(["STRIPE", "MANUAL"]);
export type BillingProviderName = z.infer<typeof BillingProviderName>;

export const VerifiedResultStatus = z.enum(["SUBMITTED", "APPROVED", "REJECTED"]);
export type VerifiedResultStatus = z.infer<typeof VerifiedResultStatus>;

export const DeveloperSubmissionStatus = z.enum(["SUBMITTED", "IN_REVIEW", "APPROVED", "REJECTED", "WITHDRAWN"]);
export type DeveloperSubmissionStatus = z.infer<typeof DeveloperSubmissionStatus>;

/** ISO-4217, upper case. Stored alongside every minor-unit amount so a total is never ambiguous. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "Must be an ISO-4217 currency code.");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * A monetary amount in the currency's smallest unit (cents for USD/EUR).
 * Authoritative totals never use binary floating point (CLAUDE.md 7.4) — the
 * field name carries the unit so `1250` can never be read as "12.50 dollars".
 */
export const AmountMinor = z.number().int().nonnegative();

/** A rate in basis points: `250` means 2.50%, never 250%. */
export const BasisPoints = z.number().int().min(0).max(10_000);

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export const MarketCategory = z.enum(["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"]);
export type MarketCategory = z.infer<typeof MarketCategory>;

export const ListingSummary = z.object({
  contractVersion: z.literal(STOREFRONT_CONTRACT_VERSION),
  listingId: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  tagline: z.string().max(240),
  marketCategory: MarketCategory,
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  status: ListingStatus,
  publishedAt: z.string().datetime().nullable(),
  monthlyPrice: z.object({ currency: CurrencyCode, amountMinor: AmountMinor }).nullable(),
  /** Present only when a snapshot row exists. The UI shows nothing rather than a placeholder. */
  headline: z
    .object({
      scope: StatScope,
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      netProfitPct: z.number(),
      maxDrawdownPct: z.number(),
      profitFactor: z.number().nullable(),
      tradeCount: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ListingSummary = z.infer<typeof ListingSummary>;

/** Metric block for one published snapshot. Percentages are whole percent (`12.5` = 12.5%). */
export const PublishedMetrics = z.object({
  netProfitPct: z.number(),
  maxDrawdownPct: z.number(),
  profitFactor: z.number().nullable(),
  winRatePct: z.number().min(0).max(100).nullable(),
  tradeCount: z.number().int().nonnegative(),
  sharpe: z.number().nullable(),
  averageTradePct: z.number().nullable(),
});
export type PublishedMetrics = z.infer<typeof PublishedMetrics>;

export const MonthlyReturn = z.object({
  /** Calendar month in UTC, `YYYY-MM`. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  returnPct: z.number(),
});
export type MonthlyReturn = z.infer<typeof MonthlyReturn>;

export const StatSnapshot = z.object({
  snapshotId: z.string().uuid(),
  scope: StatScope,
  sourceKind: StatSourceKind,
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  metrics: PublishedMetrics,
  monthlyReturns: z.array(MonthlyReturn),
  equityCurve: z.array(z.object({ at: z.string().datetime(), equity: z.number() })),
  calculationVersion: z.string().min(1),
  /** Net of the modelled costs recorded on the source run — never a gross number presented as net. */
  costsApplied: z.boolean(),
});
export type StatSnapshot = z.infer<typeof StatSnapshot>;

export const ListingDetail = ListingSummary.extend({
  description: z.string(),
  riskNote: z.string(),
  developer: z.object({ displayName: z.string(), isFirstParty: z.boolean() }).nullable(),
  currentRelease: z
    .object({
      releaseId: z.string().uuid(),
      releaseNumber: z.number().int().positive(),
      publishedAt: z.string().datetime().nullable(),
      changelog: z.string(),
      pineSourceHash: z.string().min(1),
    })
    .nullable(),
  snapshots: z.array(StatSnapshot),
});
export type ListingDetail = z.infer<typeof ListingDetail>;

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

export const VolumeDiscountTier = z.object({
  /** Minimum number of algos in the subscription for this tier to apply. */
  minAlgos: z.number().int().min(1),
  discountBps: BasisPoints,
});
export type VolumeDiscountTier = z.infer<typeof VolumeDiscountTier>;

export const SubscriptionQuoteLine = z.object({
  listingId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  listAmountMinor: AmountMinor,
  discountAmountMinor: AmountMinor,
  netAmountMinor: AmountMinor,
});
export type SubscriptionQuoteLine = z.infer<typeof SubscriptionQuoteLine>;

export const SubscriptionQuote = z.object({
  contractVersion: z.literal(STOREFRONT_CONTRACT_VERSION),
  currency: CurrencyCode,
  lines: z.array(SubscriptionQuoteLine).min(1),
  appliedTier: VolumeDiscountTier.nullable(),
  listTotalMinor: AmountMinor,
  discountTotalMinor: AmountMinor,
  totalMinor: AmountMinor,
  interval: z.literal("MONTH"),
});
export type SubscriptionQuote = z.infer<typeof SubscriptionQuote>;

/* -------------------------------------------------------------------------- */
/* Commerce commands                                                           */
/* -------------------------------------------------------------------------- */

export const CreateCheckoutCommand = z.object({
  storefrontSlug: z.string().min(1),
  listingIds: z.array(z.string().uuid()).min(1).max(50),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});
export type CreateCheckoutCommand = z.infer<typeof CreateCheckoutCommand>;

export const CustomerEntitlement = z.object({
  listingId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: EntitlementStatus,
  source: EntitlementSource,
  grantedAt: z.string().datetime(),
  /** Set when the paid period is already scheduled to end; access stops at this instant. */
  expiresAt: z.string().datetime().nullable(),
});
export type CustomerEntitlement = z.infer<typeof CustomerEntitlement>;

/** What an entitled customer receives. Delivered only behind an entitlement check + audit event. */
export const AlgoDelivery = z.object({
  contractVersion: z.literal(STOREFRONT_CONTRACT_VERSION),
  listingId: z.string().uuid(),
  releaseId: z.string().uuid(),
  releaseNumber: z.number().int().positive(),
  name: z.string(),
  pineSource: z.string().min(1),
  pineSourceHash: z.string().min(1),
  changelog: z.string(),
  setupInstructions: z.string(),
});
export type AlgoDelivery = z.infer<typeof AlgoDelivery>;

/* -------------------------------------------------------------------------- */
/* Trust surfaces                                                              */
/* -------------------------------------------------------------------------- */

export const VerifiedResultSubmission = z.object({
  listingId: z.string().uuid(),
  broker: z.string().min(1).max(120),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  netReturnPct: z.number(),
  /** Object-store key of the uploaded broker statement. Screenshots are never canonical (CLAUDE.md 26). */
  statementObjectKey: z.string().min(1),
  statementChecksum: z.string().min(1),
});
export type VerifiedResultSubmission = z.infer<typeof VerifiedResultSubmission>;

export const DeveloperSubmissionCommand = z.object({
  storefrontSlug: z.string().min(1),
  strategyVersionId: z.string().uuid(),
  proposedName: z.string().min(1).max(120),
  proposedTagline: z.string().max(240),
  notes: z.string().max(4000).default(""),
});
export type DeveloperSubmissionCommand = z.infer<typeof DeveloperSubmissionCommand>;
