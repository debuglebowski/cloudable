CREATE TABLE "secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"pointer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "secret_bindings" ADD CONSTRAINT "secret_bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_bindings_scope_idx" ON "secret_bindings" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_bindings_scope_key_idx" ON "secret_bindings" USING btree ("scope_type","scope_id","key") WHERE "secret_bindings"."removed_at" is null;