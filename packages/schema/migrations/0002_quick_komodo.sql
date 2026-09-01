CREATE TABLE "restore_requests" (
	"approval_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"target_machine_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"confirm_secret_bindings" boolean DEFAULT false NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "restore_requests" ADD CONSTRAINT "restore_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;