import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A time-boxed grant of elevated access (file recovery or shell) on a machine, optionally gated by an approval. */
export const elevations = pgTable("elevations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  personId: uuid("person_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  level: text("level", { enum: ["file_recovery", "shell"] }).notNull(),
  reason: text("reason").notNull(),
  approvalId: uuid("approval_id"),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status", { enum: ["requested", "granted", "expired", "denied"] })
    .notNull()
    .default("requested"),
});
