ALTER TABLE "machines" ADD COLUMN "volume_usage" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "declared_package_versions" jsonb;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "used_bytes" bigint;