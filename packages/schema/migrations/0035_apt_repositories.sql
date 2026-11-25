CREATE TABLE "apt_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"suite" text NOT NULL,
	"components" jsonb NOT NULL,
	"signing_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"add_approval_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"remove_approval_id" uuid,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "apt_sources" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "apt_repository_ids" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "undeclared_apt_sources" jsonb;--> statement-breakpoint
ALTER TABLE "apt_repositories" ADD CONSTRAINT "apt_repositories_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;