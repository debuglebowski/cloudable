import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** A point-in-time snapshot of a machine, taken on archive, upgrade, or manual request. */
export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  trigger: text("trigger", { enum: ["archive", "upgrade", "manual"] }).notNull(),
  region: text("region").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  containsData: boolean("contains_data").notNull().default(true),
  containsConfig: boolean("contains_config").notNull().default(true),
  legalHold: boolean("legal_hold").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  retentionDays: integer("retention_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set when the snapshot is hard-deleted after expiry.
  expiredAt: timestamp("expired_at", { withTimezone: true }),
});
