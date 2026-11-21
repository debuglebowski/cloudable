ALTER TABLE "machine_package_actions" ALTER COLUMN "requested_by_person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "available_package_versions" jsonb;--> statement-breakpoint
ALTER TABLE "machine_packages" ADD COLUMN "setting" text DEFAULT 'allowed' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_package_actions" ADD COLUMN "trigger" text DEFAULT 'person' NOT NULL;