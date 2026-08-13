CREATE INDEX "campaigns_organisation_id_created_at_id_idx" ON "campaigns" USING btree ("organisation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "strategies_organisation_id_created_at_id_idx" ON "strategies" USING btree ("organisation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "strategies_campaign_id_idx" ON "strategies" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "strategy_versions_strategy_id_version_number_idx" ON "strategy_versions" USING btree ("strategy_id","version_number");--> statement-breakpoint
CREATE INDEX "dataset_versions_organisation_id_created_at_id_idx" ON "dataset_versions" USING btree ("organisation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "backtest_runs_strategy_version_id_created_at_id_idx" ON "backtest_runs" USING btree ("strategy_version_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_aggregate_type_aggregate_id_created_at_idx" ON "audit_events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
CREATE INDEX "committee_decisions_strategy_version_id_idx" ON "committee_decisions" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "strategy_read_models_organisation_id_workflow_state_idx" ON "strategy_read_models" USING btree ("organisation_id","workflow_state");--> statement-breakpoint
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events" USING btree ("status","created_at");