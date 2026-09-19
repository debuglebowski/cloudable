ALTER TABLE "restore_requests" ALTER COLUMN "target_machine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD COLUMN "target_kind" text DEFAULT 'existing_machine' NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD COLUMN "owner_person_id" uuid;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD COLUMN "new_machine_name" text;--> statement-breakpoint
ALTER TABLE "restore_requests" ADD COLUMN "confirm_destroys_data" boolean DEFAULT false NOT NULL;