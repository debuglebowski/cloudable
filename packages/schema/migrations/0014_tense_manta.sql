CREATE TABLE "machine_package_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"op" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version_pin" text,
	"requested_by_person_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "installed_packages" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "baseline_packages" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "baseline_captured_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "machine_package_actions_machine_status_idx" ON "machine_package_actions" USING btree ("machine_id","status");