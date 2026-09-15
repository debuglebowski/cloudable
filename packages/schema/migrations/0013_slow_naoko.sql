ALTER TABLE "snapshots" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "captured_disks" jsonb DEFAULT '[]'::jsonb NOT NULL;