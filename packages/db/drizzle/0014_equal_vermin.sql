CREATE TYPE "public"."infrastructure_health" AS ENUM('HEALTHY', 'DEGRADED');--> statement-breakpoint
CREATE TYPE "public"."strategy_performance_health" AS ENUM('OK', 'DRAWDOWN_ALERT', 'NOT_CONFIGURED');--> statement-breakpoint
CREATE TABLE "health_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"tick_at" timestamp with time zone NOT NULL,
	"infrastructure_health" "infrastructure_health" NOT NULL,
	"infrastructure_reasons" jsonb NOT NULL,
	"rejection_rate" numeric(5, 4) NOT NULL,
	"strategy_performance_health" "strategy_performance_health" NOT NULL,
	"current_drawdown_pct" numeric(10, 6),
	"max_drawdown_pct_alert_threshold_at_snapshot" numeric(5, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_snapshots" ADD CONSTRAINT "health_snapshots_deployment_id_forward_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."forward_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_snapshots_deployment_id_tick_at_idx" ON "health_snapshots" USING btree ("deployment_id","tick_at");