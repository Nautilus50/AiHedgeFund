CREATE TABLE "strategy_read_models" (
	"strategy_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latest_version_id" uuid NOT NULL,
	"latest_version_number" integer NOT NULL,
	"workflow_state" "workflow_state" NOT NULL,
	"latest_decision" "committee_decision_type",
	"latest_decision_at" timestamp with time zone,
	"latest_decision_actor_id" uuid,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_read_models" ADD CONSTRAINT "strategy_read_models_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_read_models" ADD CONSTRAINT "strategy_read_models_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_read_models" ADD CONSTRAINT "strategy_read_models_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_read_models" ADD CONSTRAINT "strategy_read_models_latest_version_id_strategy_versions_id_fk" FOREIGN KEY ("latest_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;