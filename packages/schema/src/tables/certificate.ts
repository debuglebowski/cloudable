import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** An SSH certificate issued by the Cloudable CA for a person. */
export const certificates = pgTable("certificates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  personId: uuid("person_id").notNull(),
  // The machines the caller asked `cloudable login` to scope this certificate
  // to, or the literal string "all". A record of the request, NOT a
  // restriction that holds: the certificate itself carries only the OS user
  // as its principal, so sshd never learns about this. See docs/access.md
  // for the principal scheme that makes it real.
  machineScope: jsonb("machine_scope").notNull(),
  fingerprint: text("fingerprint").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
});
