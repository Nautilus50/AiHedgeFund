CREATE TABLE "sse_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sse_tickets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- Added nullable first: existing PUBLISHED rows have no organisation_id yet.
-- Backfilled below via each event type's own aggregate chain, then locked
-- to NOT NULL — see packages/db/src/schema/system.ts's comment on
-- outboxEvents.organisationId and ADR 0007.
ALTER TABLE "outbox_events" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint

-- report_upload.uploaded / report_upload.parsed: aggregate_id = report_uploads.id
UPDATE "outbox_events" oe
SET "organisation_id" = s."organisation_id"
FROM "report_uploads" ru
JOIN "tradingview_verifications" tv ON tv."id" = ru."verification_id"
JOIN "strategy_versions" sv ON sv."id" = tv."strategy_version_id"
JOIN "strategies" s ON s."id" = sv."strategy_id"
WHERE oe."event_type" IN ('report_upload.uploaded', 'report_upload.parsed')
  AND oe."aggregate_id" = ru."id";
--> statement-breakpoint

-- backtest_run.local_execution_requested / trades.normalised / equity.reconstructed
-- / metrics.calculated: aggregate_id = backtest_runs.id
UPDATE "outbox_events" oe
SET "organisation_id" = s."organisation_id"
FROM "backtest_runs" br
JOIN "strategy_versions" sv ON sv."id" = br."strategy_version_id"
JOIN "strategies" s ON s."id" = sv."strategy_id"
WHERE oe."event_type" IN ('backtest_run.local_execution_requested', 'trades.normalised', 'equity.reconstructed', 'metrics.calculated')
  AND oe."aggregate_id" = br."id";
--> statement-breakpoint

-- forward_signal.received: aggregate_id = signal_events.id
UPDATE "outbox_events" oe
SET "organisation_id" = fd."organisation_id"
FROM "signal_events" se
JOIN "forward_deployments" fd ON fd."id" = se."deployment_id"
WHERE oe."event_type" = 'forward_signal.received'
  AND oe."aggregate_id" = se."id";
--> statement-breakpoint

-- strategy_version.transitioned / committee_decision.created: both already
-- carry organisationId directly in their payload — no join needed.
UPDATE "outbox_events"
SET "organisation_id" = (payload->>'organisationId')::uuid
WHERE "event_type" IN ('strategy_version.transitioned', 'committee_decision.created')
  AND "organisation_id" IS NULL
  AND payload->>'organisationId' IS NOT NULL;
--> statement-breakpoint

-- Any row still unresolved at this point references an aggregate (or an
-- organisation that has since itself been deleted, e.g. a demo/test row)
-- that no longer exists — it's already PUBLISHED, already consumed, and
-- nothing can act on it.
DELETE FROM "outbox_events" oe
WHERE oe."organisation_id" IS NULL
   OR NOT EXISTS (SELECT 1 FROM "organisations" o WHERE o."id" = oe."organisation_id");
--> statement-breakpoint

ALTER TABLE "outbox_events" ALTER COLUMN "organisation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sse_tickets" ADD CONSTRAINT "sse_tickets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sse_tickets" ADD CONSTRAINT "sse_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_organisation_id_id_idx" ON "outbox_events" USING btree ("organisation_id","id");
