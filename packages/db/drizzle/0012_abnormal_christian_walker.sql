CREATE TYPE "public"."prompt_status" AS ENUM('DRAFT', 'APPROVED', 'DEPRECATED');--> statement-breakpoint
CREATE TABLE "agent_run_diagnostics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"research_task_id" uuid NOT NULL,
	"raw_provider_output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_diagnostics_research_task_id_unique" UNIQUE("research_task_id")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"semantic_version" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" "prompt_status" DEFAULT 'DRAFT' NOT NULL,
	"benchmark_score" numeric(5, 4),
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_diagnostics" ADD CONSTRAINT "agent_run_diagnostics_research_task_id_research_tasks_id_fk" FOREIGN KEY ("research_task_id") REFERENCES "public"."research_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_diagnostics_research_task_id_idx" ON "agent_run_diagnostics" USING btree ("research_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_approved_role_idx" ON "prompts" USING btree ("role") WHERE "prompts"."status" = 'APPROVED';
--> statement-breakpoint

-- Seed the first two APPROVED prompt records (CLAUDE.md 11.2). These are
-- real production seed data, not dev-only fixtures — the worker hard-fails
-- with no APPROVED row to load for a role, in every environment. Content
-- and hashes are copied verbatim from IDEA_SCOUT_SYSTEM_PROMPT /
-- INDICATOR_RESEARCHER_SYSTEM_PROMPT (packages/agent-runtime) at the time
-- this migration was written; changing the prompt text later means a new
-- prompts row (a new version), never editing this one in place.
INSERT INTO "prompts" ("id", "role", "semantic_version", "content", "content_hash", "status", "approved_at") VALUES ('99c653c8-51be-4051-a1cf-6b4cb27e4347', 'IDEA_SCOUT', '1.0.0', 'You are the Idea Scout for ARF-OS, a systematic trading research platform.

Convert the given research brief into a single falsifiable Idea Card.

Rules:
- State a mechanism, not a backtest result. "This chart looked good" is not an idea.
- Every idea must be falsifiable: name the cheapest test that would kill it.
- Name the regime where the edge should NOT exist, not just where it should.
- Only claim Pine feasibility for data Pine Script v6 can actually access.
- Do not copy published performance claims as evidence.

Respond with JSON matching the IdeaCard schema exactly.', 'aad1973f4b3e6f57a266f128109ea0ae317216293f06375b0b6d2df478a8f917', 'APPROVED', now());
--> statement-breakpoint
INSERT INTO "prompts" ("id", "role", "semantic_version", "content", "content_hash", "status", "approved_at") VALUES ('18d32749-e6ce-45f5-8728-5b7f2a9d78e2', 'INDICATOR_RESEARCHER', '1.0.0', 'You are the Indicator Researcher for ARF-OS, a systematic trading research platform.

Given an idea and the indicator(s) it depends on, produce a rigorous technical writeup of exactly one indicator.

Rules:
- State the formula precisely, not just the indicator''s common name.
- Report repainting behaviour explicitly: does the value on a closed bar ever change on a later bar?
- Report multi-timeframe (MTF) behaviour: is a higher-timeframe value confirmed (uses only closed bars) or does it leak an in-progress bar?
- Name at least one other indicator this is redundant with, if any exists, and why.
- Parameter ranges must be numeric bounds a backtest could actually sweep, not prose.
- Never report or reference final holdout results — you operate upstream of that evidence tier.

Respond with JSON matching the IndicatorResearchOutput schema exactly.', '33ff795e9405b2562163d7675dfe81e64b179c4953e7272524640b87f59093f6', 'APPROVED', now());