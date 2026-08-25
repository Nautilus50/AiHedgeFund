CREATE TYPE "public"."algo_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."market_category" AS ENUM('CRYPTO', 'INDEX_FUTURES', 'FX', 'COMMODITIES', 'EQUITIES');--> statement-breakpoint
CREATE TYPE "public"."release_status" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."stat_scope" AS ENUM('IN_SAMPLE', 'OUT_OF_SAMPLE', 'FORWARD_PAPER');--> statement-breakpoint
CREATE TYPE "public"."stat_source_kind" AS ENUM('BACKTEST_RUN', 'FORWARD_DEPLOYMENT');--> statement-breakpoint
CREATE TABLE "algo_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"algo_id" uuid NOT NULL,
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
CREATE TABLE "algo_stat_snapshots" (
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
CREATE TABLE "algos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"risk_note" text DEFAULT '' NOT NULL,
	"market_category" "market_category" NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"status" "algo_status" DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "algo_releases" ADD CONSTRAINT "algo_releases_algo_id_algos_id_fk" FOREIGN KEY ("algo_id") REFERENCES "public"."algos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_releases" ADD CONSTRAINT "algo_releases_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_stat_snapshots" ADD CONSTRAINT "algo_stat_snapshots_release_id_algo_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."algo_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algos" ADD CONSTRAINT "algos_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "algo_releases_algo_id_release_number_idx" ON "algo_releases" USING btree ("algo_id","release_number");--> statement-breakpoint
CREATE UNIQUE INDEX "algo_releases_algo_id_strategy_version_id_idx" ON "algo_releases" USING btree ("algo_id","strategy_version_id");--> statement-breakpoint
CREATE INDEX "algo_releases_algo_id_status_idx" ON "algo_releases" USING btree ("algo_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "algo_stat_snapshots_release_id_scope_source_id_idx" ON "algo_stat_snapshots" USING btree ("release_id","scope","source_id");--> statement-breakpoint
CREATE INDEX "algo_stat_snapshots_release_id_idx" ON "algo_stat_snapshots" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "algos_organisation_id_slug_idx" ON "algos" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "algos_organisation_id_status_created_at_id_idx" ON "algos" USING btree ("organisation_id","status","created_at","id");