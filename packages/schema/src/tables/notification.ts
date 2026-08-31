import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * An in-app/console notification to a machine owner. Currently the only
 * producer is `domain/elevation/notify.ts`, fired on every elevation grant
 * against a machine with a live owner (spec §15: "owner notified") — an
 * explicit product decision to notify in-app/console only, never email or
 * Slack, so no new external provider or secret is introduced for this.
 *
 * Deliberately lightweight: no delivery channel/status, no notification
 * "kind" enum, just a plain message and a nullable `readAt`. `elevationId`
 * is not a foreign key — matching `elevations` itself, which likewise
 * declares its `personId`/`machineId` columns as bare `uuid` without
 * `.references()` — but it IS unique: exactly one notification per
 * elevation grant, ever. That constraint is what makes
 * `ElevationRepo.insertNotification` idempotent (see its doc comment) —
 * a retried or concurrently-raced grant-finalization can call it again
 * safely instead of producing a duplicate row.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  ownerPersonId: uuid("owner_person_id").notNull(),
  elevationId: uuid("elevation_id").notNull().unique(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
});
