CREATE TYPE "public"."benchmark_visibility" AS ENUM('VISIBLE', 'HIDDEN');--> statement-breakpoint
CREATE TYPE "public"."practice_run_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_TERMINAL');--> statement-breakpoint
CREATE TABLE "benchmark_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"objective" text NOT NULL,
	"visibility" "benchmark_visibility" DEFAULT 'VISIBLE' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"benchmark_task_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" "practice_run_status" DEFAULT 'QUEUED' NOT NULL,
	"output" jsonb,
	"schema_valid" boolean,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"human_review_score" numeric(3, 2),
	"human_reviewed_by_user_id" uuid,
	"human_reviewed_at" timestamp with time zone,
	"human_review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_runs" ADD CONSTRAINT "practice_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_runs" ADD CONSTRAINT "practice_runs_benchmark_task_id_benchmark_tasks_id_fk" FOREIGN KEY ("benchmark_task_id") REFERENCES "public"."benchmark_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_runs" ADD CONSTRAINT "practice_runs_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_runs" ADD CONSTRAINT "practice_runs_human_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("human_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_runs_benchmark_task_id_idx" ON "practice_runs" USING btree ("benchmark_task_id");