import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** An SSH certificate issued by the Cloudable CA for a person, scoped to one or more machines. */
export const certificates = pgTable("certificates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  personId: uuid("person_id").notNull(),
  // A list of machine ids the certificate is scoped to, or the literal string "all".
  machineScope: jsonb("machine_scope").notNull(),
  fingerprint: text("fingerprint").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
});
