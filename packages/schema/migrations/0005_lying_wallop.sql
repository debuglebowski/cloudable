CREATE TABLE "org_catalog_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ALTER COLUMN "region" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ALTER COLUMN "region" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "provider" text NOT NULL DEFAULT 'fake';--> statement-breakpoint
ALTER TABLE "machines" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "provider" text;--> statement-breakpoint
CREATE UNIQUE INDEX "org_catalog_selections_org_provider_kind_code_idx" ON "org_catalog_selections" USING btree ("org_id","provider","kind","code");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_catalog_entries_provider_kind_code_idx" ON "provider_catalog_entries" USING btree ("provider","kind","code");