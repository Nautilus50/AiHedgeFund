CREATE TYPE "public"."billing_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."billing_provider" AS ENUM('STRIPE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."developer_submission_status" AS ENUM('SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('SUBSCRIPTION', 'COMPLIMENTARY', 'DEVELOPER_OWN_ALGO');--> statement-breakpoint
CREATE TYPE "public"."entitlement_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."market_category" AS ENUM('CRYPTO', 'INDEX_FUTURES', 'FX', 'COMMODITIES', 'EQUITIES');--> statement-breakpoint
CREATE TYPE "public"."release_status" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."stat_scope" AS ENUM('IN_SAMPLE', 'OUT_OF_SAMPLE', 'FORWARD_PAPER', 'CUSTOMER_VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."stat_source_kind" AS ENUM('BACKTEST_RUN', 'FORWARD_DEPLOYMENT', 'CUSTOMER_REPORT_AGGREGATE');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."verified_result_status" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "algo_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"risk_note" text DEFAULT '' NOT NULL,
	"market_category" "market_category" NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"status" "listing_status" DEFAULT 'DRAFT' NOT NULL,
	"developer_user_id" uuid,
	"revenue_share_bps" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "algo_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"release_number" integer NOT NULL,
	"status" "release_status" DEFAULT 'DRAFT' NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"setup_instructions" text DEFAULT '' NOT NULL,
	"pine_source_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "billing_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"failure_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_session_id" text NOT NULL,
	"quote" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_provider_session_id_unique" UNIQUE("provider_session_id")
);
--> statement-breakpoint
CREATE TABLE "customer_verified_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"broker" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"net_return_pct" text NOT NULL,
	"statement_object_key" text NOT NULL,
	"statement_checksum" text NOT NULL,
	"status" "verified_result_status" DEFAULT 'SUBMITTED' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_provider_customer_id_unique" UNIQUE("provider_customer_id")
);
--> statement-breakpoint
CREATE TABLE "developer_payout_accruals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"developer_user_id" uuid NOT NULL,
	"period_month" text NOT NULL,
	"currency" text NOT NULL,
	"net_revenue_minor" integer NOT NULL,
	"share_bps" integer NOT NULL,
	"accrued_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"developer_user_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"proposed_name" text NOT NULL,
	"proposed_tagline" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" "developer_submission_status" DEFAULT 'SUBMITTED' NOT NULL,
	"review_notes" text,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"listing_id" uuid,
	"revenue_share_bps" integer DEFAULT 3000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"source" "entitlement_source" NOT NULL,
	"subscription_id" uuid,
	"status" "entitlement_status" DEFAULT 'ACTIVE' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listing_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"monthly_amount_minor" integer NOT NULL,
	"provider_price_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_stat_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"scope" "stat_scope" NOT NULL,
	"source_kind" "stat_source_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"monthly_returns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"equity_curve" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculation_version" text NOT NULL,
	"costs_applied" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefronts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"support_email" text NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefronts_organisation_id_unique" UNIQUE("organisation_id"),
	CONSTRAINT "storefronts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"list_amount_minor" integer NOT NULL,
	"net_amount_minor" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"currency" text NOT NULL,
	"total_minor" integer NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "volume_discount_tiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storefront_id" uuid NOT NULL,
	"min_algos" integer NOT NULL,
	"discount_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "algo_listings" ADD CONSTRAINT "algo_listings_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_listings" ADD CONSTRAINT "algo_listings_developer_user_id_users_id_fk" FOREIGN KEY ("developer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_releases" ADD CONSTRAINT "algo_releases_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_releases" ADD CONSTRAINT "algo_releases_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_verified_results" ADD CONSTRAINT "customer_verified_results_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_verified_results" ADD CONSTRAINT "customer_verified_results_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_verified_results" ADD CONSTRAINT "customer_verified_results_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_payout_accruals" ADD CONSTRAINT "developer_payout_accruals_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_payout_accruals" ADD CONSTRAINT "developer_payout_accruals_developer_user_id_users_id_fk" FOREIGN KEY ("developer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_submissions" ADD CONSTRAINT "developer_submissions_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_submissions" ADD CONSTRAINT "developer_submissions_developer_user_id_users_id_fk" FOREIGN KEY ("developer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_submissions" ADD CONSTRAINT "developer_submissions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_submissions" ADD CONSTRAINT "developer_submissions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_submissions" ADD CONSTRAINT "developer_submissions_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_prices" ADD CONSTRAINT "listing_prices_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_stat_snapshots" ADD CONSTRAINT "published_stat_snapshots_release_id_algo_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."algo_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_listing_id_algo_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."algo_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_discount_tiers" ADD CONSTRAINT "volume_discount_tiers_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "algo_listings_storefront_id_slug_idx" ON "algo_listings" USING btree ("storefront_id","slug");--> statement-breakpoint
CREATE INDEX "algo_listings_storefront_id_status_created_at_id_idx" ON "algo_listings" USING btree ("storefront_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "algo_listings_developer_user_id_idx" ON "algo_listings" USING btree ("developer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "algo_releases_listing_id_release_number_idx" ON "algo_releases" USING btree ("listing_id","release_number");--> statement-breakpoint
CREATE UNIQUE INDEX "algo_releases_listing_id_strategy_version_id_idx" ON "algo_releases" USING btree ("listing_id","strategy_version_id");--> statement-breakpoint
CREATE INDEX "algo_releases_listing_id_status_idx" ON "algo_releases" USING btree ("listing_id","status");--> statement-breakpoint
CREATE INDEX "billing_events_status_received_at_idx" ON "billing_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "checkout_sessions_customer_id_idx" ON "checkout_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_verified_results_listing_customer_period_idx" ON "customer_verified_results" USING btree ("listing_id","customer_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "customer_verified_results_listing_id_status_idx" ON "customer_verified_results" USING btree ("listing_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_storefront_id_user_id_idx" ON "customers" USING btree ("storefront_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "developer_payout_accruals_listing_id_period_month_idx" ON "developer_payout_accruals" USING btree ("listing_id","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "developer_submissions_storefront_version_idx" ON "developer_submissions" USING btree ("storefront_id","strategy_version_id");--> statement-breakpoint
CREATE INDEX "developer_submissions_storefront_id_status_idx" ON "developer_submissions" USING btree ("storefront_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_customer_id_listing_id_idx" ON "entitlements" USING btree ("customer_id","listing_id");--> statement-breakpoint
CREATE INDEX "entitlements_subscription_id_idx" ON "entitlements" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "listing_prices_listing_id_active_idx" ON "listing_prices" USING btree ("listing_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "published_stat_snapshots_release_id_scope_source_id_idx" ON "published_stat_snapshots" USING btree ("release_id","scope","source_id");--> statement-breakpoint
CREATE INDEX "published_stat_snapshots_release_id_idx" ON "published_stat_snapshots" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_items_subscription_id_listing_id_idx" ON "subscription_items" USING btree ("subscription_id","listing_id");--> statement-breakpoint
CREATE INDEX "subscriptions_customer_id_idx" ON "subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volume_discount_tiers_storefront_id_min_algos_idx" ON "volume_discount_tiers" USING btree ("storefront_id","min_algos");