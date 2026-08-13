ALTER TABLE "campaigns" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "strategies" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "backtest_runs" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;