CREATE TABLE "machine_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"version_pin" text,
	"source" "setting_source" NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "machine_packages_scope_package_idx" ON "machine_packages" USING btree ("scope_type","scope_id","package_name");