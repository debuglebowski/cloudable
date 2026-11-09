CREATE TABLE "idp_role_mode" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"config_fingerprint" text,
	"activated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "idp_roles_verified_at" timestamp with time zone;