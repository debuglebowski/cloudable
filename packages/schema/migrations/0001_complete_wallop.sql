CREATE TABLE "upgrade_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"previous_image" text NOT NULL,
	"target_image" text NOT NULL,
	"outcome" text NOT NULL,
	"pre_upgrade_snapshot_id" uuid,
	"restored_snapshot_id" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_ms" integer NOT NULL,
	"detail" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upgrade_attempts" ADD CONSTRAINT "upgrade_attempts_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;