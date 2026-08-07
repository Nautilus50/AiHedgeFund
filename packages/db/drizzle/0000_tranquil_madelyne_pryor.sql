CREATE TYPE "public"."organisation_role" AS ENUM('VIEWER', 'RESEARCHER', 'DEVELOPER', 'VALIDATOR', 'OPERATOR', 'COMMITTEE_MEMBER', 'ADMIN', 'SERVICE_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."research_task_status" AS ENUM('QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('CAMPAIGN_BACKLOG', 'IDEA_RESEARCH', 'HYPOTHESIS_DRAFT', 'PINE_DEVELOPMENT', 'TRADINGVIEW_VERIFICATION', 'PAPER_APPROVAL_REVIEW', 'PAPER_APPROVED', 'REJECTED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."report_upload_kind" AS ENUM('PERFORMANCE_SUMMARY', 'LIST_OF_TRADES');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'UPLOADED', 'PARSED', 'PASSED', 'FAILED', 'INVESTIGATION_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."backtest_run_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."backtest_runner_type" AS ENUM('LOCAL_RUNNER', 'TRADINGVIEW');--> statement-breakpoint
CREATE TYPE "public"."metric_scope" AS ENUM('RUN', 'SEGMENT', 'STRATEGY_VERSION', 'SYMBOL', 'PARAMETER_SET', 'FORWARD_DEPLOYMENT', 'PORTFOLIO');--> statement-breakpoint
CREATE TYPE "public"."parity_status" AS ENUM('PASS', 'WARN', 'FAIL', 'INSUFFICIENT_DATA');--> statement-breakpoint
CREATE TYPE "public"."trade_direction" AS ENUM('LONG', 'SHORT');--> statement-breakpoint
CREATE TYPE "public"."committee_decision_type" AS ENUM('REJECT', 'REWORK_WITH_NEW_VERSION', 'PAPER_APPROVED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organisation_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_auth_subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_auth_subject_unique" UNIQUE("external_auth_subject")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"allowed_markets" jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" "research_task_status" DEFAULT 'QUEUED' NOT NULL,
	"strategy_id" uuid,
	"strategy_version_id" uuid,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"retry_count" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pine_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"compile_status" text DEFAULT 'PENDING' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pine_revisions_strategy_version_id_unique" UNIQUE("strategy_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_definitions_strategy_version_id_unique" UNIQUE("strategy_version_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_lineage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"change_category" text NOT NULL,
	"changed_fields" jsonb NOT NULL,
	"motivating_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_id" uuid NOT NULL,
	"parent_version_id" uuid,
	"version_number" integer NOT NULL,
	"workflow_state" "workflow_state" DEFAULT 'CAMPAIGN_BACKLOG' NOT NULL,
	"definition_hash" text,
	"pine_source_hash" text,
	"manifest_hash" text,
	"created_by_agent_run_id" uuid,
	"change_reason" text,
	"contaminated_dataset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artefacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artefacts_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "report_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verification_id" uuid NOT NULL,
	"kind" "report_upload_kind" NOT NULL,
	"raw_artefact_id" uuid NOT NULL,
	"parse_status" text DEFAULT 'PENDING' NOT NULL,
	"parser_version" text,
	"parse_warnings" text[] DEFAULT '{}' NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tradingview_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"required_symbol" text NOT NULL,
	"required_timeframe" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"runner_type" "backtest_runner_type" NOT NULL,
	"runner_version" text NOT NULL,
	"verification_id" uuid,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"segment_kind" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"cost_model" jsonb NOT NULL,
	"initial_capital" numeric(20, 8) NOT NULL,
	"status" "backtest_run_status" DEFAULT 'QUEUED' NOT NULL,
	"source_hash" text NOT NULL,
	"environment_hash" text,
	"error_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawdown_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"drawdown" numeric(20, 8) NOT NULL,
	"drawdown_pct" numeric(10, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"equity" numeric(20, 8) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_name" text NOT NULL,
	"value" numeric(24, 8) NOT NULL,
	"unit" text NOT NULL,
	"calculation_version" text NOT NULL,
	"scope_type" "metric_scope" NOT NULL,
	"scope_id" uuid NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parity_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"verification_id" uuid NOT NULL,
	"status" "parity_status" NOT NULL,
	"comparison" jsonb NOT NULL,
	"first_divergence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backtest_run_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"direction" "trade_direction" NOT NULL,
	"entry_time" timestamp with time zone NOT NULL,
	"exit_time" timestamp with time zone,
	"entry_price" numeric(20, 8) NOT NULL,
	"exit_price" numeric(20, 8),
	"quantity" numeric(20, 8) NOT NULL,
	"gross_pnl" numeric(20, 8),
	"fees" numeric(20, 8) DEFAULT '0' NOT NULL,
	"net_pnl" numeric(20, 8),
	"entry_reason" text,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"prior_state_summary" jsonb,
	"new_state_summary" jsonb,
	"reason" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"decision" "committee_decision_type" NOT NULL,
	"reason_codes" text[] NOT NULL,
	"rejection_case" text NOT NULL,
	"positive_case" text NOT NULL,
	"conditions" text[] DEFAULT '{}' NOT NULL,
	"required_next_evidence" text[] DEFAULT '{}' NOT NULL,
	"review_date" timestamp with time zone,
	"actor_id" uuid NOT NULL,
	"human_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"actor" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pine_revisions" ADD CONSTRAINT "pine_revisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pine_revisions" ADD CONSTRAINT "pine_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_definitions" ADD CONSTRAINT "strategy_definitions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_lineage" ADD CONSTRAINT "strategy_lineage_parent_version_id_strategy_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_uploads" ADD CONSTRAINT "report_uploads_raw_artefact_id_artefacts_id_fk" FOREIGN KEY ("raw_artefact_id") REFERENCES "public"."artefacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tradingview_verifications" ADD CONSTRAINT "tradingview_verifications_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawdown_points" ADD CONSTRAINT "drawdown_points_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parity_reports" ADD CONSTRAINT "parity_reports_verification_id_tradingview_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."tradingview_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_decisions" ADD CONSTRAINT "committee_decisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;