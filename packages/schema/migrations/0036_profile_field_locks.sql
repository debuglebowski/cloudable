ALTER TABLE "profiles" ADD COLUMN "provider_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "region_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "size_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "image_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A creation field a profile already set was fixed for every machine on it. Keep that: each
-- one starts locked.
UPDATE "profiles" SET "provider_locked" = true WHERE "provider" IS NOT NULL;--> statement-breakpoint
UPDATE "profiles" SET "region_locked" = true WHERE "region" IS NOT NULL;--> statement-breakpoint
UPDATE "profiles" SET "size_locked" = true WHERE "size_sku" IS NOT NULL;--> statement-breakpoint
UPDATE "profiles" SET "image_locked" = true WHERE "image" IS NOT NULL;