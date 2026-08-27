CREATE TABLE "compliance_finding_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"detail_key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_finding_state_key_idx" ON "compliance_finding_state" USING btree ("check_id","org_id","machine_id","detail_key");