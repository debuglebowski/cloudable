CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider" text,
	"region" text,
	"size_sku" text,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_org_name_idx" ON "profiles" USING btree ("org_id","name");--> statement-breakpoint
ALTER TYPE "public"."setting_source" RENAME VALUE 'template' TO 'profile';--> statement-breakpoint
UPDATE "setting_values" SET "scope_type" = 'profile' WHERE "scope_type" = 'template';--> statement-breakpoint
UPDATE "machine_packages" SET "scope_type" = 'profile' WHERE "scope_type" = 'template';--> statement-breakpoint
UPDATE "secret_bindings" SET "scope_type" = 'profile' WHERE "scope_type" = 'template';--> statement-breakpoint
ALTER TABLE "machines" RENAME COLUMN "template_id" TO "profile_id";--> statement-breakpoint
UPDATE "machines" SET "profile_id" = NULL WHERE "profile_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" RENAME COLUMN "pinned" TO "locked";--> statement-breakpoint
ALTER TABLE "machine_packages" RENAME COLUMN "pinned" TO "locked";
