ALTER TABLE "sessions" ADD COLUMN "session_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "termination_reason" text;