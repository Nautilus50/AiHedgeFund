CREATE TYPE "public"."forward_deployment_state" AS ENUM('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."paper_order_role" AS ENUM('ENTRY', 'EXIT');--> statement-breakpoint
CREATE TYPE "public"."signal_processing_status" AS ENUM('PENDING', 'PROCESSED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "forward_deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"initial_capital" numeric(20, 8) NOT NULL,
	"fill_model" jsonb NOT NULL,
	"timestamp_tolerance_seconds" integer NOT NULL,
	"max_drawdown_pct_alert_threshold" numeric(5, 2),
	"deployment_token_hash" text NOT NULL,
	"state" "forward_deployment_state" DEFAULT 'PLANNED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "forward_deployments_deployment_token_hash_unique" UNIQUE("deployment_token_hash")
);
--> statement-breakpoint
CREATE TABLE "forward_drawdown_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"drawdown" numeric(20, 8) NOT NULL,
	"drawdown_pct" numeric(10, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forward_equity_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"bar_time" timestamp with time zone NOT NULL,
	"equity" numeric(20, 8) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paper_order_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"filled_price" numeric(20, 8) NOT NULL,
	"fees" numeric(20, 8) DEFAULT '0' NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "paper_fills_paper_order_id_unique" UNIQUE("paper_order_id")
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"signal_event_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"role" "paper_order_role" NOT NULL,
	"requested_price" numeric(20, 8) NOT NULL,
	"quantity" numeric(20, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_orders_signal_event_id_unique" UNIQUE("signal_event_id")
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"direction" text,
	"raw_payload" jsonb NOT NULL,
	"processing_status" "signal_processing_status" DEFAULT 'PENDING' NOT NULL,
	"rejection_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forward_deployments" ADD CONSTRAINT "forward_deployments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_deployments" ADD CONSTRAINT "forward_deployments_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_deployments" ADD CONSTRAINT "forward_deployments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_drawdown_points" ADD CONSTRAINT "forward_drawdown_points_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_equity_points" ADD CONSTRAINT "forward_equity_points_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_paper_order_id_paper_orders_id_fk" FOREIGN KEY ("paper_order_id") REFERENCES "public"."paper_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_signal_event_id_signal_events_id_fk" FOREIGN KEY ("signal_event_id") REFERENCES "public"."signal_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;